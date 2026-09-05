import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type RestoreJournalPhase =
  | 'preparing'
  | 'db-swapped'
  | 'storage-reconciled'
  | 'plugins-swapped'
  | 'commit-ready'
  | 'committed';

interface RestoreJournalMarker {
  version: 1;
  restoreId: string;
  phase: RestoreJournalPhase;
  updatedAt: string;
}

const MARKER = 'restore-state.json';
const PHASES = new Set<RestoreJournalPhase>([
  'preparing',
  'db-swapped',
  'storage-reconciled',
  'plugins-swapped',
  'commit-ready',
  'committed',
]);

function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readMarker(journalDir: string): RestoreJournalMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(journalDir, MARKER), 'utf8')) as Partial<RestoreJournalMarker>;
    if (
      parsed.version !== 1 ||
      typeof parsed.restoreId !== 'string' ||
      typeof parsed.phase !== 'string' ||
      !PHASES.has(parsed.phase as RestoreJournalPhase) ||
      typeof parsed.updatedAt !== 'string'
    )
      return null;
    return parsed as RestoreJournalMarker;
  } catch {
    return null;
  }
}

/** Atomically and durably publish the current recovery phase. */
export function markRestoreJournal(journalDir: string, phase: RestoreJournalPhase): void {
  const previous = readMarker(journalDir);
  const restoreId = previous?.restoreId ?? path.basename(journalDir).replace(/^restore-journal-/, '');
  const marker: RestoreJournalMarker = {
    version: 1,
    restoreId,
    phase,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(journalDir, `.${MARKER}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(marker));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, path.join(journalDir, MARKER));
    fsyncDirectory(journalDir);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

export function beginRestoreJournal(journalDir: string, restoreId: string): void {
  fs.mkdirSync(journalDir, { recursive: false, mode: 0o700 });
  const marker: RestoreJournalMarker = {
    version: 1,
    restoreId,
    phase: 'preparing',
    updatedAt: new Date().toISOString(),
  };
  const markerPath = path.join(journalDir, MARKER);
  const fd = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(marker));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(journalDir);
  fsyncDirectory(path.dirname(journalDir));
}

/**
 * Called once before the production DB opens. A non-committed journal means a
 * process died between restore phases; booting on a mixed state would destroy
 * the recovery evidence, so refuse startup and retain it for the operator.
 */
export function assertNoInterruptedRestore(dataDir: string): void {
  if (!fs.existsSync(dataDir)) return;
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('restore-journal-')) continue;
    const journalDir = path.join(dataDir, entry.name);
    if (!entry.isDirectory()) {
      throw new Error(`Unknown restore journal artifact prevents safe startup: ${journalDir}`);
    }
    const marker = readMarker(journalDir);
    const journalId = entry.name.slice('restore-journal-'.length);
    if (!marker || marker.restoreId !== journalId) {
      throw new Error(`Unknown restore journal prevents safe startup: ${journalDir}`);
    }
    if (marker.phase !== 'committed') {
      throw new Error(
        `Interrupted backup restore detected at phase ${marker.phase}; recovery journal retained at ${journalDir}`,
      );
    }
    fs.rmSync(path.join(dataDir, `restore-${journalId}`), { recursive: true, force: true });
    fs.rmSync(journalDir, { recursive: true, force: true });
  }
}
