import { logInfo, logError } from '../audit/audit-log.logger';
import type { StorageService } from '../storage/storage.service';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Auto-backup settings and retention — the pure half of the auto-backup cron
 * (moved from src/scheduler.ts). Stays a plain module beside backup.impl.ts
 * for the same reason that does: file I/O against data/backup-settings.json,
 * no container state. AutoBackupJob owns the scheduling and passes its
 * injected StorageService into cleanupOldBackups — retention addresses the
 * backups category through the facade so expired archives leave mirror
 * replicas too.
 */

const dataDir = path.join(__dirname, '../../../data');
const settingsFile = path.join(dataDir, 'backup-settings.json');

export const VALID_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly'];
const VALID_DAYS_OF_WEEK = new Set([0, 1, 2, 3, 4, 5, 6]); // 0=Sunday
const VALID_HOURS = new Set(Array.from({ length: 24 }, (_, i) => i));

export interface BackupSettings {
  enabled: boolean;
  interval: string;
  keep_days: number;
  hour: number;
  day_of_week: number;
  day_of_month: number;
}

export function buildCronExpression(settings: BackupSettings): string {
  const hour = VALID_HOURS.has(settings.hour) ? settings.hour : 2;
  const dow = VALID_DAYS_OF_WEEK.has(settings.day_of_week) ? settings.day_of_week : 0;
  const dom = settings.day_of_month >= 1 && settings.day_of_month <= 28 ? settings.day_of_month : 1;

  switch (settings.interval) {
    case 'hourly':
      return '0 * * * *';
    case 'daily':
      return `0 ${hour} * * *`;
    case 'weekly':
      return `0 ${hour} * * ${dow}`;
    case 'monthly':
      return `0 ${hour} ${dom} * *`;
    default:
      return `0 ${hour} * * *`;
  }
}

function getDefaults(): BackupSettings {
  return { enabled: false, interval: 'daily', keep_days: 7, hour: 2, day_of_week: 0, day_of_month: 1 };
}

export function loadSettings(): BackupSettings {
  let settings = getDefaults();
  try {
    if (fs.existsSync(settingsFile)) {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      settings = { ...settings, ...saved };
    }
  } catch {
    /* corrupt settings file — fall back to the defaults */
  }
  return settings;
}

export function saveSettings(settings: BackupSettings): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function autoBackupTimestampMs(filename: string): number | null {
  // Accept both legacy auto-backup-<timestamp>.zip and the current
  // auto-backup-<timestamp>-<uuid>.zip. Capture only the timestamp so a UUID
  // cannot make a fresh archive look stale through the mtime fallback.
  const match =
    /^auto-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.zip$/.exec(
      filename,
    );
  if (!match) return null;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  // The timestamp is emitted in UTC. Without an explicit offset Date.parse()
  // interprets this ISO-like value in the process timezone, making retention
  // drift by the host's UTC offset.
  const ms = Date.parse(`${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export async function cleanupOldBackups(
  storage: StorageService,
  keepDays: number,
  now: number = Date.now(),
): Promise<void> {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let deleted = 0;
  let failed = 0;
  try {
    for await (const obj of storage.list('backups')) {
      if (obj.key.includes('/')) continue; // list() recurses; retention is top-level-only like the readdir it replaces
      if (!obj.key.startsWith('auto-backup-') || !obj.key.endsWith('.zip')) continue; // manual backup-*.zip is never auto-deleted
      scanned++;
      const ageMs = autoBackupTimestampMs(obj.key) ?? obj.mtimeMs;
      if (ageMs < cutoff) {
        try {
          await storage.delete('backups', obj.key); // fans out to mirror replicas too
          deleted++;
          logInfo(`Auto-Backup old backup deleted: ${obj.key}`);
        } catch (err: unknown) {
          // A mirror or provider failure must not prevent other stale objects
          // from being reclaimed on this run.
          failed++;
          logError(`Auto-Backup delete failed: ${obj.key}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (err: unknown) {
    logError(`Auto-Backup cleanup: ${err instanceof Error ? err.message : err}`);
  }
  logInfo(`Auto-Backup cleanup complete: scanned ${scanned}, deleted ${deleted}, failed ${failed}`);
}
