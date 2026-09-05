import { readEnv } from '../../app-config';
import { db, closeDb, reinitialize, getDatabaseFilePath } from '../../db/database';
import { assertSchemaCompatibility } from '../../db/migrationRunner';
import { invalidateMcpSessions } from '../../mcp/sessionManager';
import {
  checkpointSessionAuthority,
  rotateSessionAuthority,
  type SessionAuthorityCheckpoint,
} from '../auth/session-authority';
import { confirmSessionRevocationStoreHealth } from '../auth/session-revocation';
import { invalidatePermissionsCache } from '../permissions/permissions-cache';
import { snapshotAllPluginDataDbs } from '../plugins/host/plugin-data.service';
import { pluginsCodeRoot, pluginsDataRoot } from '../plugins/paths';
import {
  stageExtractedPluginTrees,
  applyStagedRestoreNowStrict,
  discardStagedPluginTrees,
  getPluginRestoreRuntimeLifecycle,
  PLUGIN_TREE_ARCHIVE_MARKER,
  type PluginRestoreTransaction,
} from '../plugins/plugin-backup';
import { revokeAllSockets } from '../realtime/ws-state';
import { isValidKey } from '../storage/storage-keys';
import type { StorageService } from '../storage/storage.service';
import { VALID_INTERVALS } from './auto-backup.settings';
import { beginRestoreJournal, markRestoreJournal } from './restore-journal';
import { RestoreRecoveryRequiredError, runInRestoreQuiescence } from './restore-quiescence';
import { sanitizeRestoredAuthState } from './restored-auth-state';

import archiver from 'archiver';
import Database from 'better-sqlite3';
import type { Response } from 'express';
import fs from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'path';
import unzipper from 'unzipper';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const dataDir = path.join(__dirname, '../../../data');
const sessionRevocationsPendingDir = path.join(dataDir, '.session-revocations-pending');

// Compressed upload cap for restore archives. Defaults to 500 MB, raisable via
// BACKUP_UPLOAD_LIMIT_MB for instances whose backups (uploads/ included) grow
// past that. Malformed values abort boot (app-config fail-fast validation);
// frozen at import on purpose (legacy timing).
const backupEnv = readEnv().backup;
export const MAX_BACKUP_UPLOAD_SIZE = backupEnv.uploadLimitMb * 1024 * 1024; // compressed
// Upper bound on the TOTAL decompressed size of a restore archive (the upload
// limit only caps the compressed bytes). Default 5 GB, raisable via
// BACKUP_MAX_DECOMPRESSED_MB for an instance whose own backups (now including the
// plugin trees) legitimately grow past it — otherwise its own backups become
// unrestorable.
export const MAX_BACKUP_DECOMPRESSED_SIZE = backupEnv.maxDecompressedMb * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function parseIntField(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function parseAutoBackupBody(body: Record<string, unknown>): {
  enabled: boolean;
  interval: string;
  keep_days: number;
  hour: number;
  day_of_week: number;
  day_of_month: number;
} {
  const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
  const rawInterval = body.interval;
  const interval = typeof rawInterval === 'string' && VALID_INTERVALS.includes(rawInterval) ? rawInterval : 'daily';
  const keep_days = Math.max(0, parseIntField(body.keep_days, 7));
  const hour = Math.min(23, Math.max(0, parseIntField(body.hour, 2)));
  const day_of_week = Math.min(6, Math.max(0, parseIntField(body.day_of_week, 0)));
  const day_of_month = Math.min(28, Math.max(1, parseIntField(body.day_of_month, 1)));
  return { enabled, interval, keep_days, hour, day_of_week, day_of_month };
}

export function isValidBackupFilename(filename: string): boolean {
  return /^(?:auto-)?backup-[\w-]+\.zip$/.test(filename);
}

export function backupFileExists(storage: StorageService, filename: string): Promise<boolean> {
  return storage.exists('backups', filename);
}

/**
 * The codebase's only res.download becomes the storage equivalent: root-relative
 * sendFile via sendToResponse, with res.download's attachment header rebuilt by
 * hand (filenames are regex-gated ASCII — no encoding cases).
 */
export function sendBackupToResponse(storage: StorageService, filename: string, res: Response): Promise<void> {
  return storage.sendToResponse('backups', filename, res, {
    disposition: `attachment; filename="${filename}"`,
  });
}

// ---------------------------------------------------------------------------
// Rate limiter state (shared across requests)
// ---------------------------------------------------------------------------

export const BACKUP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour

const backupAttempts = new Map<string, { count: number; first: number }>();

/** Returns true if the request is allowed, false if rate-limited. */
export function checkRateLimit(key: string, maxAttempts: number, windowMs: number): boolean {
  const now = Date.now();
  const record = backupAttempts.get(key);
  if (record && record.count >= maxAttempts && now - record.first < windowMs) {
    return false;
  }
  if (!record || now - record.first >= windowMs) {
    backupAttempts.set(key, { count: 1, first: now });
  } else {
    record.count++;
  }
  return true;
}

// ---------------------------------------------------------------------------
// List backups
// ---------------------------------------------------------------------------

export interface BackupInfo {
  filename: string;
  size: number;
  sizeText: string;
  created_at: string;
}

export async function listBackups(storage: StorageService): Promise<BackupInfo[]> {
  const backups: BackupInfo[] = [];
  for await (const obj of storage.list('backups')) {
    // storage.list() recurses; the legacy readdir was single-level. Nested keys
    // (a restore-* staging tree when data and uploads map to the same dir) and
    // non-zip files must not surface.
    if (obj.key.includes('/') || !obj.key.endsWith('.zip')) continue;
    backups.push({
      filename: obj.key,
      size: obj.size,
      sizeText: formatSize(obj.size),
      created_at: new Date(obj.mtimeMs).toISOString(),
    });
  }
  return backups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// ---------------------------------------------------------------------------
// Create backup
// ---------------------------------------------------------------------------

// Backup creation and restore share the same process-local operation lane.
// Restore keeps its existing 409 admission contract below, while creates wait
// for an in-flight restore rather than touching the same database and storage
// trees concurrently.
let backupOperationTail: Promise<void> = Promise.resolve();

function runBackupOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = backupOperationTail;
  let release!: () => void;
  backupOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(release);
}

/** The categories a backup archives — everything else under uploads/ is a
 *  re-derivable cache (photos-google, photos-trek) or not uploads at all
 *  (backups). Restore's rehydration walks the same list. */
export const BACKUP_UPLOAD_CATEGORIES = ['files', 'journey', 'covers', 'avatars', 'places', 'photos'] as const;
const BACKUP_MANIFEST_FILENAME = 'backup-manifest.json';
const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

type BackupManifestCategory = 'database' | 'uploads' | 'plugins-data' | 'plugins-code' | 'encryption-key';
interface BackupManifestEntry {
  path: string;
  category: BackupManifestCategory;
  source: string;
  size: number;
  sha256: string;
}
interface BackupManifest {
  version: 1;
  entries: BackupManifestEntry[];
}

function isSafeRelativeArchivePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function listRegularFiles(root: string, prefix = ''): Array<{ absPath: string; relativePath: string }> {
  const files: Array<{ absPath: string; relativePath: string }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listRegularFiles(absPath, relativePath));
    else if (entry.isFile()) files.push({ absPath, relativePath });
  }
  return files;
}

/** Hash a file with fixed-size reads. Backup payloads can be multi-GB, so never
 * materialize one merely to calculate its manifest entry. */
export function hashFileBounded(absPath: string): { size: number; sha256: string } {
  const hash = createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  try {
    for (let position = 0; ; position += chunk.byteLength) {
      const read = fs.readSync(fd, chunk, 0, chunk.byteLength, position);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      size += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { size, sha256: hash.digest('hex') };
}

/** Copy every archive input into this backup's private spool before hashing or
 * handing it to archiver. This closes the enumerate/hash/archive TOCTOU window. */
function spoolSnapshot(source: string, spoolRoot: string, archivePath: string): string {
  const destination = path.join(spoolRoot, archivePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

function addManifestFile(
  archive: ReturnType<typeof archiver>,
  entries: BackupManifestEntry[],
  absPath: string,
  archivePath: string,
  category: BackupManifestCategory,
  source: string,
): void {
  const digest = hashFileBounded(absPath);
  entries.push({
    path: archivePath,
    category,
    source,
    size: digest.size,
    sha256: digest.sha256,
  });
  archive.file(absPath, { name: archivePath });
}

function addManifestBytes(
  archive: ReturnType<typeof archiver>,
  entries: BackupManifestEntry[],
  bytes: Buffer,
  archivePath: string,
  category: BackupManifestCategory,
  source: string,
): void {
  entries.push({
    path: archivePath,
    category,
    source,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  archive.append(bytes, { name: archivePath });
}

function isManifestEntry(entry: unknown): entry is BackupManifestEntry {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as Record<string, unknown>;
  if (!isSafeRelativeArchivePath(value.path) || !isSafeRelativeArchivePath(value.source)) return false;
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) return false;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  if (!['database', 'uploads', 'plugins-data', 'plugins-code', 'encryption-key'].includes(String(value.category)))
    return false;
  switch (value.category) {
    case 'database':
      return value.path === 'travel.db' && value.source === 'travel.db';
    case 'uploads': {
      const [category] = value.source.split('/');
      return (
        value.path === `uploads/${value.source}` &&
        isBackupCategory(category) &&
        isValidKey(value.source.slice(category.length + 1))
      );
    }
    case 'plugins-data':
    case 'plugins-code': {
      if (value.path !== `${value.category}/${value.source}`) return false;
      if (value.source !== PLUGIN_TREE_ARCHIVE_MARKER) return true;
      return value.size === 0 && value.sha256 === EMPTY_PAYLOAD_SHA256;
    }
    case 'encryption-key':
      return value.path === '.encryption_key' && value.source === '.encryption_key';
    default:
      return false;
  }
}

export function validateBackupManifest(extractDir: string, archivePaths: string[]): string | null {
  const manifestPath = path.join(extractDir, BACKUP_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return 'Invalid backup: checksum manifest not found.';
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    return 'Invalid backup: checksum manifest is unreadable.';
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.every(isManifestEntry)) {
    return 'Invalid backup: checksum manifest is malformed.';
  }
  const manifestPaths = new Set<string>();
  for (const entry of manifest.entries) {
    if (manifestPaths.has(entry.path)) return 'Invalid backup: checksum manifest has duplicate paths.';
    manifestPaths.add(entry.path);
  }
  if (!manifest.entries.some((entry) => entry.category === 'database' && entry.path === 'travel.db')) {
    return 'Invalid backup: checksum manifest does not cover travel.db.';
  }
  const archivedFiles = archivePaths.filter((entryPath) => entryPath !== BACKUP_MANIFEST_FILENAME);
  if (archivedFiles.length !== manifestPaths.size || archivedFiles.some((entryPath) => !manifestPaths.has(entryPath))) {
    return 'Invalid backup: archive entries do not match the checksum manifest.';
  }
  for (const entry of manifest.entries) {
    const absPath = path.join(extractDir, entry.path);
    if (!fs.existsSync(absPath)) return `Invalid backup: manifest entry is missing: ${entry.path}.`;
    const digest = hashFileBounded(absPath);
    if (digest.size !== entry.size || digest.sha256 !== entry.sha256) {
      return `Invalid backup: checksum verification failed for ${entry.path}.`;
    }
  }
  return null;
}

/**
 * Writes a full backup zip and returns its BackupInfo.
 *
 * `prefix` picks the filename scheme. AutoBackupJob passes 'auto-backup' because
 * everything downstream tells the two apart by name: cleanupOldBackups() prunes
 * only auto-backup-*.zip, and the admin panel badges them as automatic. Manual
 * backups keep the default.
 */
async function createBackupUnlocked(
  storage: StorageService,
  prefix: 'backup' | 'auto-backup' = 'backup',
): Promise<BackupInfo> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const operationId = randomUUID();
  const filename = `${prefix}-${timestamp}-${operationId}.zip`;
  // All staging lives in the backups backend's own spool: same volume as the
  // destination (the put commit stays an atomic rename) and crash leftovers are
  // reaped by LocalDriver's boot spool-cleanup. The scratch names carry the
  // prefix too: a scheduled run and a manual one that start in the same second
  // would otherwise share a snapshot path, and the first to finish would delete
  // the other's staging copy mid-archive.
  const spoolDir = storage.spoolDirFor('backups');
  const zipSpool = path.join(spoolDir, `zip-build-${prefix}-${timestamp}-${operationId}`);
  const pdataSnap = path.join(spoolDir, `plugins-snap-${prefix}-${timestamp}-${operationId}`);
  const dbSnap = path.join(spoolDir, `travel-snap-${prefix}-${timestamp}-${operationId}.db`);
  // Per-backup staging for uploads with no local path (a remote/S3 primary, or
  // a local path that vanished between listing and archiving — see
  // getLocalPathOrNull). Same spool as the rest of the build, same cleanup.
  const stagingDir = path.join(spoolDir, `staging-${prefix}-${timestamp}-${operationId}`);

  try {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {}

    // Enumerate the archived categories up front (the archiver reads entries
    // lazily during finalize(), so the promise executor below must stay
    // synchronous). Everything NOT in BACKUP_UPLOAD_CATEGORIES is excluded by
    // construction: the re-derivable caches (photos-google in both
    // TREK_PLACE_PHOTO_DIR modes, photos-trek) and backups itself are never
    // enumerated, which is what makes the same-dir-misconfig guard (#1358)
    // structural instead of pattern-based.
    const uploadEntries: { absPath: string; name: string }[] = [];
    for (const category of BACKUP_UPLOAD_CATEGORIES) {
      for await (const obj of storage.list(category)) {
        // In mode A the google/trek caches nest under the photos/ prefix — the
        // category walk would sweep them back in without this skip.
        if (category === 'photos' && (obj.key.startsWith('google/') || obj.key.startsWith('trek/'))) continue;
        // Local path available (exists on disk right now — the fail-safe half
        // of getLocalPathOrNull's contract) → push it directly: zero-copy, the
        // default-install path. Otherwise (a remote/S3 primary, or a local
        // path that vanished between the list() and here) stream the object
        // into this backup's own staging dir so archiver has a real file to
        // read lazily during finalize() — the temp file withLocalFile would
        // have produced is gone by the time archiver gets to it.
        const localPath = await storage.getLocalPathOrNull(category, obj.key);
        if (localPath !== null) {
          const name = `uploads/${category}/${obj.key}`;
          uploadEntries.push({ absPath: spoolSnapshot(localPath, stagingDir, name), name });
          continue;
        }
        const stagedPath = path.join(stagingDir, category, obj.key);
        fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
        const { stream } = await storage.getStream(category, obj.key);
        await pipeline(stream, fs.createWriteStream(stagedPath));
        uploadEntries.push({ absPath: stagedPath, name: `uploads/${category}/${obj.key}` });
      }
    }

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipSpool);
      const archive = archiver('zip', { zlib: { level: 9 } });

      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      output.on('close', succeed);
      // ENOSPC/EACCES belongs to the destination stream, not archiver. Without
      // this listener Node treats it as an unhandled EventEmitter error and may
      // terminate the process instead of failing and cleaning this backup.
      output.on('error', fail);
      archive.on('error', fail);
      // archiver emits 'warning' (not 'error') for entries it couldn't
      // stat/read — a stale staged path, a permission error — and by default
      // just skips them, silently dropping bytes from the backup. Fail the
      // backup instead: a dropped entry must never pass as a success.
      archive.on('warning', fail);

      archive.pipe(output);
      const manifestEntries: BackupManifestEntry[] = [];

      const dbPath = getDatabaseFilePath();
      if (fs.existsSync(dbPath)) {
        // Archive a point-in-time snapshot, not the live file. The archiver reads entries
        // lazily during finalize(), so a WAL auto-checkpoint writing pages back into
        // travel.db mid-stream would tear the archived copy — and the -wal that would make
        // it recoverable isn't in the zip. VACUUM INTO takes a consistent snapshot even
        // under concurrent writes — the same guarantee the plugin DBs get below.
        let dbToArchive: string;
        try {
          if (fs.existsSync(dbSnap)) fs.rmSync(dbSnap, { force: true });
          db.exec(`VACUUM INTO '${dbSnap.replaceAll("'", "''")}'`);
          dbToArchive = dbSnap;
        } catch (e) {
          // A live SQLite file is not a snapshot: archiving it after VACUUM INTO
          // failed could silently pair pages from different logical points.
          throw new Error('Backup database snapshot failed; refusing a torn backup.', { cause: e });
        }
        addManifestFile(archive, manifestEntries, dbToArchive, 'travel.db', 'database', 'travel.db');
      }

      for (const entry of uploadEntries) {
        const source = entry.name.slice('uploads/'.length);
        addManifestFile(archive, manifestEntries, entry.absPath, entry.name, 'uploads', source);
      }

      // A file-backed key is part of a self-contained backup. Its bytes stay
      // solely inside the sensitive archive; the manifest binds only metadata.
      const encKeyPath = path.join(dataDir, '.encryption_key');
      if (!readEnv().backup.encryptionKeyFromEnv && fs.existsSync(encKeyPath)) {
        const keySnapshot = spoolSnapshot(encKeyPath, stagingDir, '.encryption_key');
        addManifestFile(archive, manifestEntries, keySnapshot, '.encryption_key', 'encryption-key', '.encryption_key');
      }

      // Plugin data — each plugin's own SQLite file and any blobs. This is the ONLY
      // copy of the user data a plugin holds, so it belongs in the backup. Checkpoint
      // every open handle first (the host keeps them open in WAL mode) so the archived
      // .db files are complete snapshots and not missing recent commits stranded in a
      // -wal sidecar — the same treatment travel.db gets above.
      const pdata = pluginsDataRoot();
      if (fs.existsSync(pdata)) {
        // Archive a consistent point-in-time snapshot, not the live files: the archiver
        // reads lazily while streaming, so a plugin writing during the backup (an auto-
        // checkpoint landing mid-read) would otherwise put a torn .db + out-of-sync -wal
        // into the zip — the plugin's ONLY data copy, silently corrupt. This VACUUM-INTOs
        // each open db and drops the sidecars; the snap dir is removed in the finally.
        snapshotAllPluginDataDbs(pdataSnap);
        for (const entry of listRegularFiles(pdataSnap)) {
          if (entry.relativePath === PLUGIN_TREE_ARCHIVE_MARKER) continue;
          addManifestFile(
            archive,
            manifestEntries,
            entry.absPath,
            `plugins-data/${entry.relativePath}`,
            'plugins-data',
            entry.relativePath,
          );
        }
      }
      // Plugin code — so a restore is self-contained (the `plugins` rows reference it).
      // Dev-links (a plugin dir symlinked/junctioned to an author's source) are skipped
      // by realpath: we never bundle a linked source tree from outside the code root.
      const pcode = pluginsCodeRoot();
      if (fs.existsSync(pcode)) {
        const realRoot = fs.realpathSync(pcode);
        for (const entry of fs.readdirSync(pcode)) {
          const dir = path.join(pcode, entry);
          let real: string;
          try {
            real = fs.realpathSync(dir);
          } catch {
            continue;
          }
          if (!real.startsWith(realRoot + path.sep)) continue; // dev-link points outside → skip
          try {
            if (!fs.statSync(dir).isDirectory()) continue;
          } catch {
            continue;
          }
          for (const file of listRegularFiles(dir)) {
            const archivePath = `plugins-code/${entry}/${file.relativePath}`;
            const snapshot = spoolSnapshot(file.absPath, stagingDir, archivePath);
            addManifestFile(
              archive,
              manifestEntries,
              snapshot,
              archivePath,
              'plugins-code',
              `${entry}/${file.relativePath}`,
            );
          }
        }
      }

      // ZIP directory entries are not checksum-bound payloads and extraction
      // deliberately skips them. A zero-byte regular file safely materializes
      // both roots even when there are no plugins, so restore can distinguish
      // an authoritative empty tree from a legacy archive that omitted plugin
      // state entirely. stageExtractedPluginTrees consumes these markers.
      const marker = Buffer.alloc(0);
      for (const category of ['plugins-data', 'plugins-code'] as const) {
        addManifestBytes(
          archive,
          manifestEntries,
          marker,
          `${category}/${PLUGIN_TREE_ARCHIVE_MARKER}`,
          category,
          PLUGIN_TREE_ARCHIVE_MARKER,
        );
      }

      archive.append(JSON.stringify({ version: 1, entries: manifestEntries } satisfies BackupManifest), {
        name: BACKUP_MANIFEST_FILENAME,
      });

      archive.finalize();
    });

    // The commit — and, under a mirror backend, the replica fan-out point.
    await storage.put('backups', filename, { tmpPath: zipSpool });
    const stat = await storage.stat('backups', filename);
    if (!stat) throw new Error(`Backup vanished after commit: ${filename}`);
    return {
      filename,
      size: stat.size,
      sizeText: formatSize(stat.size),
      created_at: new Date(stat.mtimeMs).toISOString(),
    };
  } catch (err: unknown) {
    console.error('Backup error:', err);
    throw err;
  } finally {
    // put commits by rename, so on success the zip spool file is already gone;
    // on failure these clean the half-built staging. The destination needs no
    // unlink anymore — nothing lands there until put succeeds. (The await on
    // the build promise resolves on the output stream's 'close', so the
    // snapshots are no longer being read.)
    fs.rmSync(zipSpool, { force: true });
    fs.rmSync(pdataSnap, { recursive: true, force: true });
    fs.rmSync(dbSnap, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function createBackup(
  storage: StorageService,
  prefix: 'backup' | 'auto-backup' = 'backup',
): Promise<BackupInfo> {
  return runBackupOperation(() => createBackupUnlocked(storage, prefix));
}

// ---------------------------------------------------------------------------
// Restore from ZIP
// ---------------------------------------------------------------------------

export interface RestoreResult {
  success: boolean;
  error?: string;
  status?: number;
}

/** Restore a zip that already sits in the backups store, reading it through
 *  the storage facade (primary-local in v1; a remote backend downloads to
 *  tempDir via withLocalFile — the seam is in place, resumability is not). */
export function restoreBackup(storage: StorageService, filename: string): Promise<RestoreResult> {
  return storage.withLocalFile('backups', filename, (zipPath) => restoreFromZip(storage, zipPath));
}

const isBackupCategory = (dir: string): dir is (typeof BACKUP_UPLOAD_CATEGORIES)[number] =>
  (BACKUP_UPLOAD_CATEGORIES as readonly string[]).includes(dir);

/**
 * Per-entry storage.put replaces the old wipe-and-cpSync (and with it the
 * realpathSync symlinked-uploads workaround — the driver resolves its own
 * root at init). Entries that cannot map to a storage key — an unknown
 * top-level dir, or dot-segments from old `dot: true` archives — are skipped
 * with a warning (2026-08-17 decision): new archives never contain them, and
 * the category mapping stays structural in both directions.
 */
type UploadSnapshot = {
  category: (typeof BACKUP_UPLOAD_CATEGORIES)[number];
  key: string;
  spoolPath: string;
};

type CoreSnapshot = {
  journalDir: string;
  files: Array<{ livePath: string; snapshotPath: string; existed: boolean; kind: 'file' | 'directory' }>;
};

/** The restore needs a durable, file-backed undo record. Copies are streaming
 * filesystem copies (not Buffer reads), kept under data/ so a failed restore
 * can restore the exact old database + WAL/SHM/key presence semantics. */
function snapshotCoreFiles(journalDir: string): CoreSnapshot {
  const databasePath = getDatabaseFilePath();
  const paths = [
    { livePath: databasePath, snapshotName: 'travel.db' },
    { livePath: `${databasePath}-wal`, snapshotName: 'travel.db-wal' },
    { livePath: `${databasePath}-shm`, snapshotName: 'travel.db-shm' },
    { livePath: path.join(dataDir, '.encryption_key'), snapshotName: '.encryption_key' },
    { livePath: sessionRevocationsPendingDir, snapshotName: '.session-revocations-pending' },
    // Keep the durable JWT authority last. Rollback restores the live binding
    // only after every preceding core entry and this file have succeeded.
    { livePath: path.join(dataDir, '.jwt_secret'), snapshotName: '.jwt_secret' },
  ];
  const files = paths.map(({ livePath, snapshotName }) => {
    const snapshotPath = path.join(journalDir, 'core', snapshotName);
    const existed = fs.existsSync(livePath);
    if (existed) {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      const stat = fs.statSync(livePath) as { isDirectory?: () => boolean };
      const kind: CoreSnapshot['files'][number]['kind'] =
        typeof stat.isDirectory === 'function' && stat.isDirectory() ? 'directory' : 'file';
      if (kind === 'directory') fs.cpSync(livePath, snapshotPath, { recursive: true });
      else fs.copyFileSync(livePath, snapshotPath);
      return { livePath, snapshotPath, existed, kind };
    }
    return { livePath, snapshotPath, existed, kind: 'file' as const };
  });
  return { journalDir, files };
}

function restoreCoreFiles(snapshot: CoreSnapshot): void {
  for (const file of snapshot.files) {
    if (!file.existed) {
      fs.rmSync(file.livePath, { force: true, recursive: true });
      continue;
    }
    if (file.kind === 'directory') {
      fs.rmSync(file.livePath, { recursive: true, force: true });
      fs.cpSync(file.snapshotPath, file.livePath, { recursive: true });
    } else {
      fs.copyFileSync(file.snapshotPath, file.livePath);
    }
  }
}

function extractedUploadEntries(
  extractedUploads: string,
): Array<{ category: (typeof BACKUP_UPLOAD_CATEGORIES)[number]; key: string; absPath: string }> {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    });
  return walk(extractedUploads).map((absPath) => {
    const rel = path.relative(extractedUploads, absPath).split(path.sep).join('/');
    const slash = rel.indexOf('/');
    const top = slash === -1 ? '' : rel.slice(0, slash);
    const key = slash === -1 ? '' : rel.slice(slash + 1);
    // This should already be guaranteed by the exact manifest, but restore
    // remains fail-closed if a filesystem race or future extraction change
    // hands us something storage would reject.
    if (slash === -1 || !isBackupCategory(top) || !isValidKey(key)) {
      throw new Error(`Restore archive contains an invalid upload entry: ${rel}`);
    }
    return { category: top, key, absPath };
  });
}

async function snapshotUploadInventory(storage: StorageService, journalDir: string): Promise<UploadSnapshot[]> {
  const snapshots: UploadSnapshot[] = [];
  let totalBytes = 0;
  for (const category of BACKUP_UPLOAD_CATEGORIES) {
    for await (const obj of storage.list(category)) {
      if (!isValidKey(obj.key)) throw new Error(`Storage inventory contains an invalid key: ${category}/${obj.key}`);
      totalBytes += obj.size;
      if (totalBytes > MAX_BACKUP_DECOMPRESSED_SIZE) {
        throw new Error('Existing uploads exceed the bounded restore compensation journal limit.');
      }
      const spoolPath = path.join(journalDir, 'uploads', category, obj.key);
      fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
      await storage.withLocalFile(category, obj.key, async (localPath) => {
        fs.copyFileSync(localPath, spoolPath);
      });
      snapshots.push({ category, key: obj.key, spoolPath });
    }
  }
  return snapshots;
}

async function rehydrateUploads(
  storage: StorageService,
  entries: Array<{ category: (typeof BACKUP_UPLOAD_CATEGORIES)[number]; key: string; absPath: string }>,
): Promise<Set<string>> {
  const restored = new Set<string>();
  for (const entry of entries) {
    await storage.put(entry.category, entry.key, { tmpPath: entry.absPath });
    restored.add(`${entry.category}/${entry.key}`);
  }
  return restored;
}

/** Restore all pre-existing bytes and delete keys which the failed archive may
 * have created. Every desired key is included because a failing put can still
 * have committed bytes in a remote backend before it rejects. */
async function compensateUploads(
  storage: StorageService,
  snapshots: UploadSnapshot[],
  desired: Array<{ category: (typeof BACKUP_UPLOAD_CATEGORIES)[number]; key: string }>,
): Promise<void> {
  const previous = new Set(snapshots.map((item) => `${item.category}/${item.key}`));
  const errors: unknown[] = [];
  for (const item of snapshots) {
    try {
      await storage.put(item.category, item.key, { tmpPath: item.spoolPath });
    } catch (err) {
      errors.push(err);
    }
  }
  for (const item of desired) {
    if (previous.has(`${item.category}/${item.key}`)) continue;
    try {
      await storage.delete(item.category, item.key);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length)
    throw new Error('Restore upload compensation failed; the recovery journal was retained.', { cause: errors[0] });
}

let restoreInProgress = false;

export async function restoreFromZip(storage: StorageService, zipPath: string): Promise<RestoreResult> {
  if (restoreInProgress) {
    return { success: false, error: 'A backup restore is already in progress.', status: 409 };
  }
  restoreInProgress = true;
  try {
    return await runBackupOperation(() => restoreFromZipUnlocked(storage, zipPath));
  } finally {
    restoreInProgress = false;
  }
}

async function restoreFromZipUnlocked(storage: StorageService, zipPath: string): Promise<RestoreResult> {
  const restoreId = `${Date.now()}-${randomUUID()}`;
  const extractDir = path.join(dataDir, `restore-${restoreId}`);
  let resumePluginRuntime: (() => Promise<void>) | null = null;
  let pluginShutdownPromise: Promise<void> | null = null;
  let pluginShutdownSettled = true;
  try {
    // Fast reject on the central-directory's declared size, then extract entry-by-entry
    // enforcing the ACTUAL decompressed bytes. The declared uncompressedSize is
    // attacker-declarable — a zip bomb can under-report it and expand past the cap during
    // extraction — so the real guard counts bytes as they are written and aborts once the
    // running total crosses the cap. Each entry's resolved path is also confined to
    // extractDir (a `../` entry that escaped the root — zip-slip — is refused).
    const directory = await unzipper.Open.file(zipPath);
    const claimedSize = directory.files.reduce((sum, f) => sum + (f.uncompressedSize || 0), 0);
    if (claimedSize > MAX_BACKUP_DECOMPRESSED_SIZE) {
      return { success: false, error: 'Backup exceeds the maximum decompressed size.', status: 400 };
    }

    fs.mkdirSync(extractDir, { recursive: true });
    let decompressedBytes = 0;
    for (const entry of directory.files) {
      if (entry.type === 'Directory') continue;
      const dest = path.join(extractDir, entry.path);
      const rel = path.relative(extractDir, dest);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        return { success: false, error: 'Invalid backup: an entry path escapes the archive root.', status: 400 };
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        await new Promise<void>((resolve, reject) => {
          const source = entry.stream();
          const out = fs.createWriteStream(dest);
          source.on('data', (chunk: Buffer) => {
            decompressedBytes += chunk.length;
            if (decompressedBytes > MAX_BACKUP_DECOMPRESSED_SIZE) {
              source.destroy();
              out.destroy();
              reject(new Error('DECOMPRESSED_CAP_EXCEEDED'));
            }
          });
          source.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          source.pipe(out);
        });
      } catch (err) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        if (err instanceof Error && err.message === 'DECOMPRESSED_CAP_EXCEEDED') {
          return { success: false, error: 'Backup exceeds the maximum decompressed size.', status: 400 };
        }
        throw err;
      }
    }

    // Every archive produced by this version carries a complete, non-secret
    // inventory. Verify it before closing the live DB or moving any object so
    // a truncated, modified, or path-confused archive cannot become a partial
    // restore. The empty-directory allowance only supports the unit-test seam;
    // a real archive containing travel.db necessarily has central entries.
    const manifestError = validateBackupManifest(
      extractDir,
      directory.files.filter((entry) => entry.type !== 'Directory').map((entry) => entry.path),
    );
    if (manifestError) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      return {
        success: false,
        error: `${manifestError} Legacy archives must be restored with the pinned previous image, then re-backed up in the new format.`,
        status: 400,
      };
    }

    const extractedDb = path.join(extractDir, 'travel.db');
    if (!fs.existsSync(extractedDb)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      return { success: false, error: 'Invalid backup: travel.db not found', status: 400 };
    }

    let uploadedDb: InstanceType<typeof Database> | null = null;
    try {
      uploadedDb = new Database(extractedDb);

      const integrityResult = uploadedDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrityResult.integrity_check !== 'ok') {
        fs.rmSync(extractDir, { recursive: true, force: true });
        return {
          success: false,
          error: `Uploaded database failed integrity check: ${integrityResult.integrity_check}`,
          status: 400,
        };
      }

      const requiredTables = ['users', 'trips', 'trip_members', 'places', 'days'];
      const existingTables = uploadedDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[];
      const tableNames = new Set(existingTables.map((t) => t.name));
      for (const table of requiredTables) {
        if (!tableNames.has(table)) {
          fs.rmSync(extractDir, { recursive: true, force: true });
          return {
            success: false,
            error: `Uploaded database is missing required table: ${table}. This does not appear to be a TREK backup.`,
            status: 400,
          };
        }
      }
      // Reject a snapshot produced by a newer official or fork migration lane
      // before closeDb() can make it live, then strip every persistent session
      // credential from the private extracted copy.
      assertSchemaCompatibility(uploadedDb);
      sanitizeRestoredAuthState(uploadedDb);
    } catch (err) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      return { success: false, error: 'Uploaded file is not a valid SQLite database', status: 400 };
    } finally {
      uploadedDb?.close();
    }

    const onDrainStarted = async () => {
      // Long-lived MCP GET streams otherwise hold an admitted HTTP request
      // forever. Block reconnects first (the quiescence phase is already
      // draining), then close live transports so their admissions release.
      invalidateMcpSessions();
      revokeAllSockets();
      // Capture the resumer before awaiting shutdown: even if a child kill
      // fails, the outer finally can rebuild from the still-authoritative DB.
      // Since admission is already closed, no new child RPC can race this stop.
      const pluginRuntime = getPluginRestoreRuntimeLifecycle();
      if (pluginRuntime) {
        resumePluginRuntime = pluginRuntime.resume;
        pluginShutdownSettled = false;
        try {
          pluginShutdownPromise = Promise.resolve(pluginRuntime.shutdown());
          await pluginShutdownPromise;
        } finally {
          pluginShutdownSettled = true;
        }
      }
    };
    return await runInRestoreQuiescence(
      async () => {
        const journalDir = path.join(dataDir, `restore-journal-${restoreId}`);
        let coreSnapshot: CoreSnapshot | null = null;
        let uploadSnapshots: UploadSnapshot[] = [];
        let desiredUploads: Array<{ category: (typeof BACKUP_UPLOAD_CATEGORIES)[number]; key: string }> = [];
        let restoredStorageConfig = false;
        let pluginStagingAttempted = false;
        let pluginsStaged: boolean;
        let pluginRestoreTransaction: PluginRestoreTransaction | null = null;
        let sessionAuthorityCheckpoint: SessionAuthorityCheckpoint | null = null;
        let irreversibleCommitStarted = false;

        try {
          // Publish a durable marker before the first live byte can move. A crash
          // from here through final commit is detected before the next DB open.
          beginRestoreJournal(journalDir, restoreId);
          closeDb();
          // The old core state is copied only after SQLite has closed its handle,
          // so travel.db and its sidecars describe one recoverable point. Do this
          // before publishing a single restored byte.
          coreSnapshot = snapshotCoreFiles(journalDir);
          const dbDest = getDatabaseFilePath();
          // Swap the core DB atomically: copy the restored DB to a temp file on the SAME
          // filesystem, drop the old -wal/-shm sidecars (they belong to the DB being replaced
          // and would corrupt the new one if left), then rename into place. A rename is atomic,
          // so a crash mid-swap leaves either the old or the new travel.db intact — never the
          // deleted-and-not-yet-copied gap that a plain unlink-then-copy could leave.
          const dbTmp = dbDest + '.restore-tmp';
          fs.copyFileSync(extractedDb, dbTmp);
          for (const ext of ['-wal', '-shm']) {
            try {
              fs.unlinkSync(dbDest + ext);
            } catch (e) {}
          }
          fs.renameSync(dbTmp, dbDest);
          const extractedKey = path.join(extractDir, '.encryption_key');
          if (!readEnv().backup.encryptionKeyFromEnv && fs.existsSync(extractedKey)) {
            fs.copyFileSync(extractedKey, path.join(dataDir, '.encryption_key'));
          }

          reinitialize();
          confirmSessionRevocationStoreHealth(db);
          invalidatePermissionsCache();
          sessionAuthorityCheckpoint = checkpointSessionAuthority();
          const rotation = rotateSessionAuthority();
          if (rotation.error) throw new Error(rotation.error);
          markRestoreJournal(journalDir, 'db-swapped');

          // The registry reads storage.* app_settings through the DB handle that
          // was just closed and reopened above — reload it now, AFTER reinitialize()
          // and BEFORE any byte moves, so rehydrated uploads land where the RESTORED
          // config says rather than the stale pre-restore one (audit #4). Skipped
          // entirely when reopen failed: with no live DB handle the registry has
          // nothing to read, and the restore is already reported as "restart
          // required" below — rehydrating into a stale/guessed config would be worse.
          storage.reloadConfig();
          restoredStorageConfig = true;

          const extractedUploads = path.join(extractDir, 'uploads');
          const entries = fs.existsSync(extractedUploads) ? extractedUploadEntries(extractedUploads) : [];
          desiredUploads = entries.map(({ category, key }) => ({ category, key }));
          // The target backend is derived from the restored DB. Snapshot all of
          // its current bytes before any mutation, using bounded on-disk spools
          // so neither same-key overwrites nor later stale deletes are permanent
          // if a following operation fails. Reconcile even when the archive has
          // no uploads: an empty desired inventory must remove stale live objects.
          uploadSnapshots = await snapshotUploadInventory(storage, journalDir);
          const restored = await rehydrateUploads(storage, entries);
          for (const category of BACKUP_UPLOAD_CATEGORIES) {
            for await (const obj of storage.list(category)) {
              if (!restored.has(`${category}/${obj.key}`)) {
                await storage.delete(category, obj.key);
              }
            }
          }
          markRestoreJournal(journalDir, 'storage-reconciled');

          // Publish plugin staging only after the restored DB, storage configuration,
          // and uploads are live. A crash before this point therefore cannot make boot
          // reconcile new plugin trees against the old database.
          pluginStagingAttempted = true;
          try {
            pluginsStaged = stageExtractedPluginTrees(extractDir);
          } catch (stagingErr) {
            const message = stagingErr instanceof Error ? stagingErr.message : String(stagingErr);
            throw new Error(`Plugin restore staging failed: ${message}`, { cause: stagingErr });
          }

          // Plugin trees cannot be swapped while the runtime holds their DBs open.
          // The runtime applier shuts them down and returns a receipt; when no runtime
          // is active, the strict helper applies the pair directly under the same receipt.
          if (pluginsStaged) {
            pluginRestoreTransaction = await applyStagedRestoreNowStrict();
            if (!pluginRestoreTransaction) {
              throw new Error('Plugin restore could not be applied while the runtime was quiesced.');
            }
          }
          markRestoreJournal(journalDir, 'plugins-swapped');

          // This is the final rollback-safe commit point. A pre-commit staging cleanup
          // failure still leaves the plugin receipt active, so the catch below can put
          // the plugin pair back before restoring uploads and the core database.
          markRestoreJournal(journalDir, 'commit-ready');
          const resumeCommittedPlugins = pluginRestoreTransaction?.resume;
          pluginRestoreTransaction?.commitCleanup();
          pluginRestoreTransaction = null;
          irreversibleCommitStarted = true;
          markRestoreJournal(journalDir, 'committed');
          resumePluginRuntime = resumeCommittedPlugins ?? resumePluginRuntime;

          // Restore bytes are now mutually consistent. Cleanup is post-commit garbage
          // collection: failing it must retain the restored state rather than attempt a
          // rollback from a journal that may already be partly deleted.
          for (const artifact of [extractDir, journalDir]) {
            try {
              fs.rmSync(artifact, { recursive: true, force: true });
            } catch (cleanupErr) {
              console.error('Restore committed but cleanup artifact could not be removed:', artifact, cleanupErr);
            }
          }
          return { success: true };
        } catch (err) {
          if (irreversibleCommitStarted) {
            resumePluginRuntime = null;
            console.error(
              'Restore committed but its durable completion marker failed; recovery journal retained at:',
              journalDir,
            );
            throw new RestoreRecoveryRequiredError(
              'Restore committed but recovery metadata could not be finalized; the service remains in maintenance mode.',
              { cause: err },
            );
          }
          const rollbackErrors: unknown[] = [];
          const resumeRolledBackPlugins = pluginRestoreTransaction?.resume;
          // Restore the plugin data/code pair first while its receipt still owns both
          // pre-restore snapshots. The core database is restored only after no plugin
          // can remain live against the rejected database state.
          if (pluginRestoreTransaction) {
            try {
              pluginRestoreTransaction.rollback();
            } catch (rollbackErr) {
              rollbackErrors.push(rollbackErr);
            }
          }
          // Undo uploads while the restored storage registry is still active; only
          // then put the old DB back and reload its old storage configuration.
          if (restoredStorageConfig) {
            try {
              await compensateUploads(storage, uploadSnapshots, desiredUploads);
            } catch (rollbackErr) {
              rollbackErrors.push(rollbackErr);
            }
          }
          try {
            closeDb();
          } catch (rollbackErr) {
            rollbackErrors.push(rollbackErr);
          }
          if (coreSnapshot) {
            try {
              restoreCoreFiles(coreSnapshot);
              sessionAuthorityCheckpoint?.restore();
            } catch (rollbackErr) {
              rollbackErrors.push(rollbackErr);
            }
          }
          try {
            reinitialize();
            confirmSessionRevocationStoreHealth(db);
          } catch (rollbackErr) {
            rollbackErrors.push(rollbackErr);
          }
          try {
            invalidatePermissionsCache();
          } catch (rollbackErr) {
            rollbackErrors.push(rollbackErr);
          }
          try {
            storage.reloadConfig();
          } catch (rollbackErr) {
            rollbackErrors.push(rollbackErr);
          }
          if (pluginStagingAttempted && !pluginRestoreTransaction) {
            try {
              discardStagedPluginTrees();
            } catch (rollbackErr) {
              rollbackErrors.push(rollbackErr);
            }
          }
          if (rollbackErrors.length) {
            resumePluginRuntime = null;
            // Keep the journal for a human recovery. It contains only local backup
            // bytes; log its location for operators, but never any key or object
            // bytes in an admin-facing error.
            console.error('Restore rollback incomplete; recovery journal retained at:', journalDir);
            throw new RestoreRecoveryRequiredError(
              'Restore failed and automatic rollback was incomplete; the recoverable journal was retained.',
              { cause: err },
            );
          }
          resumePluginRuntime = resumeRolledBackPlugins ?? resumePluginRuntime;
          fs.rmSync(journalDir, { recursive: true, force: true });
          throw err;
        }
      },
      { onDrainStarted },
    );
  } catch (err: unknown) {
    console.error('Restore error:', err);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    // Belt-and-braces: the inner `finally` already drops the permissions
    // cache after a successful swap, but if the extraction/copy step
    // itself threw before the DB swap even started, the cache wasn't
    // stale anyway. Invalidating here too costs nothing and guarantees
    // we never serve cached permissions that don't match the DB state
    // we leave the process in after a failed restore.
    try {
      invalidatePermissionsCache();
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    if (resumePluginRuntime) {
      const resume = resumePluginRuntime;
      const runResume = async () => {
        try {
          await resume();
        } catch (resumeError) {
          // The byte transaction has already committed or fully rolled back. Keep
          // that result authoritative and let the next boot retry child activation.
          console.error('Plugin restore completed but runtime resume failed:', resumeError);
        }
      };
      if (pluginShutdownPromise && !pluginShutdownSettled) {
        // A drain timeout cannot cancel the async shutdown hook. Reopening the
        // request boundary is safe, but starting replacement children before the
        // old shutdown settles could duplicate jobs/egress, so chain the resume.
        void pluginShutdownPromise
          .catch((shutdownError) => {
            console.error('Plugin restore drain timed out while runtime shutdown was still settling:', shutdownError);
          })
          .then(runResume);
      } else {
        await runResume();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Delete backup
// ---------------------------------------------------------------------------

export function deleteBackup(storage: StorageService, filename: string): Promise<void> {
  return storage.delete('backups', filename);
}
