/**
 * Unit tests for backupService.
 * Covers BACKUP-031 to BACKUP-060.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any vi.mock() calls
// ---------------------------------------------------------------------------

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  createReadStream: vi.fn(),
  rmSync: vi.fn(),
  copyFileSync: vi.fn(),
  renameSync: vi.fn(),
  cpSync: vi.fn(),
  readFileSync: vi.fn((_path: string): string | Buffer => Buffer.from('fixture-bytes')),
  openSync: vi.fn(() => 42),
  readSync: vi.fn((_fd: number, buffer: Buffer, _offset: number, _length: number, position: number) => {
    if (position > 0) return 0;
    const bytes = Buffer.from('fixture-bytes');
    bytes.copy(buffer);
    return bytes.length;
  }),
  closeSync: vi.fn(),
  // Identity by default: when uploadsDir is a plain directory, realpathSync
  // returns it unchanged. Tests that exercise the symlink case override this.
  realpathSync: vi.fn((p: string) => p),
}));

const archiverInstanceMock = vi.hoisted(() => ({
  pipe: vi.fn(),
  file: vi.fn(),
  directory: vi.fn(),
  glob: vi.fn(),
  append: vi.fn(),
  finalize: vi.fn(),
  on: vi.fn(),
}));

const archiverMock = vi.hoisted(() => vi.fn());

const unzipperMock = vi.hoisted(() => ({
  Extract: vi.fn(),
  // Central-directory reader used for the pre-extract zip-bomb size check.
  // Default to an empty archive so existing restore tests proceed to Extract.
  Open: { file: vi.fn().mockResolvedValue({ files: [] }) },
}));

const pluginBackupMock = vi.hoisted(() => ({
  stageExtractedPluginTrees: vi.fn(() => false),
  applyStagedRestoreNow: vi.fn(async () => true),
  applyStagedRestoreNowStrict: vi.fn(async () => null),
  discardStagedPluginTrees: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  db: {
    exec: vi.fn(),
    prepare: vi.fn(),
  },
  closeDb: vi.fn(),
  reinitialize: vi.fn(),
  getPlaceWithTags: vi.fn(),
  canAccessTrip: vi.fn(),
  isOwner: vi.fn(),
}));

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'a'.repeat(64),
  updateJwtSecret: () => {},
}));
vi.mock('fs', () => ({ default: fsMock, ...fsMock }));
vi.mock('archiver', () => ({ default: archiverMock }));
vi.mock('unzipper', () => ({ default: unzipperMock }));
vi.mock('../../../src/nest/plugins/plugin-backup', () => pluginBackupMock);
import {
  formatSize,
  parseIntField,
  parseAutoBackupBody,
  isValidBackupFilename,
  checkRateLimit,
  createBackup,
  deleteBackup,
  restoreFromZip,
  restoreBackup,
  BACKUP_RATE_WINDOW,
  backupFileExists,
  listBackups,
  sendBackupToResponse,
  validateBackupManifest,
} from '../../../src/nest/backup/backup.impl';
import type { StorageService } from '../../../src/nest/storage/storage.service';

// ---------------------------------------------------------------------------
// Storage stub — backup.impl functions receive StorageService as a parameter
// (BackupService injects it and forwards). This file mocks fs wholesale, so a
// real LocalDriver would see the mocked fs: use plain stub objects instead.
// ---------------------------------------------------------------------------

function stubStorage(overrides: Record<string, unknown> = {}): StorageService {
  return {
    // async generator; tests override with listOf(...) entries
    list: vi.fn(async function* () {}),
    stat: vi.fn(async () => null),
    exists: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
    put: vi.fn(async () => {}),
    getStream: vi.fn(),
    sendToResponse: vi.fn(async () => {}),
    withLocalFile: vi.fn(async (_c: string, _k: string, fn: (p: string) => Promise<unknown>) => fn('/stub/local/path')),
    // Default: every object has a local path (the zero-copy default-install branch).
    getLocalPathOrNull: vi.fn(async () => '/stub/local/path'),
    spoolDirFor: vi.fn(() => '/stub/spool'),
    tempDir: vi.fn(() => '/stub/tmp'),
    health: vi.fn(() => ({ replicaFailures: [] })),
    reloadConfig: vi.fn(),
    ...overrides,
  } as unknown as StorageService;
}

const listOf = (entries: Array<{ key: string; size?: number; mtimeMs?: number }>) =>
  vi.fn(async function* () {
    for (const e of entries) yield { size: 0, mtimeMs: 0, ...e };
  });

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

describe('BACKUP-031 formatSize', () => {
  it('formats bytes < 1024 as B', () => {
    expect(formatSize(500)).toBe('500 B');
  });

  it('formats bytes in KB range', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(2048)).toBe('2.0 KB');
  });

  it('formats bytes in MB range', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('boundary: exactly 1024 bytes is 1.0 KB', () => {
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
  });
});

// ---------------------------------------------------------------------------
// parseIntField
// ---------------------------------------------------------------------------

describe('BACKUP-032 parseIntField', () => {
  it('returns numeric value as-is when finite', () => {
    expect(parseIntField(5, 99)).toBe(5);
  });

  it('floors float numbers', () => {
    expect(parseIntField(7.9, 0)).toBe(7);
  });

  it('parses numeric strings', () => {
    expect(parseIntField('12', 0)).toBe(12);
  });

  it('returns fallback for non-numeric string', () => {
    expect(parseIntField('abc', 3)).toBe(3);
  });

  it('returns fallback for null', () => {
    expect(parseIntField(null, 7)).toBe(7);
  });

  it('returns fallback for undefined', () => {
    expect(parseIntField(undefined, 7)).toBe(7);
  });

  it('returns fallback for Infinity', () => {
    expect(parseIntField(Infinity, 5)).toBe(5);
  });

  it('returns fallback for empty string', () => {
    expect(parseIntField('', 4)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// parseAutoBackupBody
// ---------------------------------------------------------------------------

describe('BACKUP-033 parseAutoBackupBody', () => {
  it('parses all valid fields', () => {
    const result = parseAutoBackupBody({
      enabled: true,
      interval: 'weekly',
      keep_days: 14,
      hour: 6,
      day_of_week: 5,
      day_of_month: 15,
    });
    expect(result).toEqual({
      enabled: true,
      interval: 'weekly',
      keep_days: 14,
      hour: 6,
      day_of_week: 5,
      day_of_month: 15,
    });
  });

  it('defaults to daily when interval is invalid', () => {
    const result = parseAutoBackupBody({ interval: 'not-valid' });
    expect(result.interval).toBe('daily');
  });

  it('clamps hour to 0-23', () => {
    expect(parseAutoBackupBody({ hour: 999 }).hour).toBe(23);
    expect(parseAutoBackupBody({ hour: -1 }).hour).toBe(0);
  });

  it('clamps day_of_week to 0-6', () => {
    expect(parseAutoBackupBody({ day_of_week: 10 }).day_of_week).toBe(6);
    expect(parseAutoBackupBody({ day_of_week: -1 }).day_of_week).toBe(0);
  });

  it('clamps day_of_month to 1-28', () => {
    expect(parseAutoBackupBody({ day_of_month: 99 }).day_of_month).toBe(28);
    expect(parseAutoBackupBody({ day_of_month: 0 }).day_of_month).toBe(1);
  });

  it('treats enabled = "true" string as true', () => {
    expect(parseAutoBackupBody({ enabled: 'true' }).enabled).toBe(true);
  });

  it('treats enabled = 1 as true', () => {
    expect(parseAutoBackupBody({ enabled: 1 }).enabled).toBe(true);
  });

  it('treats enabled = false as false', () => {
    expect(parseAutoBackupBody({ enabled: false }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidBackupFilename
// ---------------------------------------------------------------------------

describe('BACKUP-034 isValidBackupFilename', () => {
  it('accepts valid backup filename', () => {
    expect(isValidBackupFilename('backup-2026-04-06T12-00-00.zip')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(isValidBackupFilename('../../etc/passwd')).toBe(false);
  });

  it('rejects filename without .zip extension', () => {
    expect(isValidBackupFilename('backup-2026-04-06T12-00-00.tar.gz')).toBe(false);
  });

  it('rejects filename with spaces', () => {
    expect(isValidBackupFilename('backup 2026.zip')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidBackupFilename('')).toBe(false);
  });

  it('accepts filename with hyphens and underscores', () => {
    expect(isValidBackupFilename('backup-my_trek-2026.zip')).toBe(true);
  });

  it('accepts auto-backup filename', () => {
    expect(isValidBackupFilename('auto-backup-2026-04-21T00-00-00.zip')).toBe(true);
  });

  it('rejects auto-backup with empty body', () => {
    expect(isValidBackupFilename('auto-backup-.zip')).toBe(false);
  });

  it('rejects backup with empty body', () => {
    expect(isValidBackupFilename('backup-.zip')).toBe(false);
  });

  it('rejects arbitrary auto- prefix that is not auto-backup', () => {
    expect(isValidBackupFilename('auto-notbackup-2026.zip')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe('BACKUP-035 checkRateLimit', () => {
  // Each test uses a unique key to avoid state pollution between tests
  it('allows first request', () => {
    expect(checkRateLimit('test-key-1', 3, BACKUP_RATE_WINDOW)).toBe(true);
  });

  it('allows requests up to maxAttempts', () => {
    const key = 'test-key-2';
    expect(checkRateLimit(key, 2, BACKUP_RATE_WINDOW)).toBe(true);
    expect(checkRateLimit(key, 2, BACKUP_RATE_WINDOW)).toBe(true);
  });

  it('blocks request exceeding maxAttempts within window', () => {
    const key = 'test-key-3';
    checkRateLimit(key, 2, BACKUP_RATE_WINDOW);
    checkRateLimit(key, 2, BACKUP_RATE_WINDOW);
    expect(checkRateLimit(key, 2, BACKUP_RATE_WINDOW)).toBe(false);
  });

  it('resets counter after window expires', () => {
    vi.useFakeTimers();
    const key = 'test-key-4';
    const windowMs = 100;
    checkRateLimit(key, 1, windowMs);
    checkRateLimit(key, 1, windowMs); // this one is blocked
    vi.advanceTimersByTime(200);
    // After window expires, should be allowed again
    expect(checkRateLimit(key, 1, windowMs)).toBe(true);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

describe('BACKUP-036 createBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Wires the write-stream + archiver mocks so finalize() resolves the build. */
  function setupArchiveSuccess() {
    const writableEvents: Record<string, Function> = {};
    fsMock.createWriteStream.mockReturnValue({
      on: vi.fn((event: string, cb: Function) => { writableEvents[event] = cb; }),
    } as never);
    archiverInstanceMock.on.mockImplementation(() => {});
    archiverInstanceMock.pipe.mockReturnValue(undefined);
    archiverInstanceMock.finalize.mockImplementation(() => { writableEvents['close']?.(); });
    archiverMock.mockReturnValue(archiverInstanceMock);
    return writableEvents;
  }

  /** storage.stat stub for the post-put BackupInfo read. */
  const statOf = (size: number, mtimeMs = Date.parse('2026-04-06T12:00:00Z')) =>
    vi.fn(async (_c: string, key: string) => ({ key, size, mtimeMs }));

  /** storage.list stub keyed by category. */
  const listByCategory = (map: Record<string, Array<{ key: string; size?: number; mtimeMs?: number }>>) =>
    vi.fn((category: string) =>
      (async function* () {
        for (const e of map[category] ?? []) yield { size: 1, mtimeMs: 0, ...e };
      })(),
    );

  it('BACKUP-036a — happy path: builds in the backups spool, commits via put, returns BackupInfo', async () => {
    // No travel.db, no enc key, no plugin roots.
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(2048) });

    const result = await createBackup(storage);

    expect(result.filename).toMatch(/^backup-.*\.zip$/);
    expect(result.size).toBe(2048);
    expect(result.sizeText).toBe('2.0 KB');
    expect(result.created_at).toBe('2026-04-06T12:00:00.000Z');
    expect(archiverMock).toHaveBeenCalledWith('zip', { zlib: { level: 9 } });
    expect(archiverInstanceMock.pipe).toHaveBeenCalled();
    expect(archiverInstanceMock.finalize).toHaveBeenCalled();
    // The zip is built in the backups backend's spool, then committed via put.
    expect(fsMock.createWriteStream).toHaveBeenCalledWith(expect.stringContaining('/stub/spool/zip-build-backup-'));
    expect(storage.put).toHaveBeenCalledWith('backups', result.filename, {
      tmpPath: expect.stringContaining('/stub/spool/zip-build-backup-'),
    });
    expect(storage.stat).toHaveBeenCalledWith('backups', result.filename);
  });

  it('BACKUP-036j — archives category objects under the legacy uploads/ entry names via the local fast path', async () => {
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    const storage = stubStorage({
      stat: statOf(1024),
      list: listByCategory({
        files: [{ key: 'a.pdf' }],
        journey: [{ key: 'thumbs/x.jpg' }],
      }),
    });

    await createBackup(storage);

    expect(storage.getLocalPathOrNull).toHaveBeenCalledWith('files', 'a.pdf');
    expect(storage.getLocalPathOrNull).toHaveBeenCalledWith('journey', 'thumbs/x.jpg');
    expect(archiverInstanceMock.file).toHaveBeenCalledWith(expect.stringContaining('/staging-backup-'), { name: 'uploads/files/a.pdf' });
    expect(archiverInstanceMock.file).toHaveBeenCalledWith(expect.stringContaining('/staging-backup-'), { name: 'uploads/journey/thumbs/x.jpg' });
    // Local objects are copied into the private spool to close hash/archive TOCTOU.
    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it('BACKUP-036k — a remote-driver object (no local path) is streamed into per-backup staging and archived from there', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const writableEvents = setupArchiveSuccess();
    const { PassThrough } = await import('node:stream');
    const remoteStream = new PassThrough();
    remoteStream.end(Buffer.from('remote upload bytes'));
    fsMock.createWriteStream.mockImplementation((p: string) => {
      // The zip destination stream still needs the writableEvents wiring
      // setupArchiveSuccess set up (finalize() resolves the build via 'close');
      // staged files use a minimal fake that just resolves the pipeline.
      if (String(p).includes('zip-build-')) {
        return { on: vi.fn((event: string, cb: Function) => { writableEvents[event] = cb; }) };
      }
      // pipeline() (real, from node:stream/promises) needs a real Writable —
      // a PassThrough gives it one without touching the real filesystem.
      return new PassThrough();
    });
    const storage = stubStorage({
      stat: statOf(2048),
      list: listByCategory({ files: [{ key: 'remote.pdf' }] }),
      getLocalPathOrNull: vi.fn(async () => null),
      getStream: vi.fn(async (category: string, key: string) => {
        expect(category).toBe('files');
        expect(key).toBe('remote.pdf');
        return { stream: remoteStream, stat: { key, size: 20, mtimeMs: 0 } };
      }),
    });

    await createBackup(storage);

    expect(storage.getLocalPathOrNull).toHaveBeenCalledWith('files', 'remote.pdf');
    expect(storage.getStream).toHaveBeenCalledWith('files', 'remote.pdf');
    const fileCall = archiverInstanceMock.file.mock.calls.find(
      (c: unknown[]) => (c[1] as { name?: string })?.name === 'uploads/files/remote.pdf',
    );
    expect(fileCall).toBeDefined();
    const stagedPath = fileCall![0] as string;
    expect(stagedPath).toContain('/stub/spool/staging-backup-');
    expect(stagedPath).toContain('files/remote.pdf');
    // The staging dir is removed alongside zipSpool/dbSnap in the existing finally.
    expect(fsMock.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('/stub/spool/staging-backup-'),
      { recursive: true, force: true },
    );
  });

  it('BACKUP-036l — a vanished remote object (archiver "warning") fails the backup instead of silently dropping it', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const archiveEvents: Record<string, Function> = {};
    fsMock.createWriteStream.mockReturnValue({ on: vi.fn() } as never);
    archiverInstanceMock.on.mockImplementation((event: string, cb: Function) => { archiveEvents[event] = cb; });
    archiverInstanceMock.pipe.mockReturnValue(undefined);
    archiverInstanceMock.finalize.mockImplementation(() => {
      // archiver emits 'warning' (not 'error') for entries it couldn't stat/read
      // (e.g. ENOENT) — without archive.on('warning', reject) this resolves clean.
      archiveEvents['warning']?.(new Error('ENOENT: no such file, stat entry'));
    });
    archiverMock.mockReturnValue(archiverInstanceMock);
    const storage = stubStorage();

    await expect(createBackup(storage)).rejects.toThrow('ENOENT');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('BACKUP-036m — a mirror replica failure surfaced via health never fails the request', async () => {
    // Mirror semantics: put succeeds against the primary; replica failures are
    // recorded on health(), not thrown. createBackup must still return its info.
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    const storage = stubStorage({
      stat: statOf(1024),
      health: vi.fn(() => ({ replicaFailures: [{ backend: 'nas-backups', key: 'backup-x.zip', error: 'EIO' }] })),
    });

    const result = await createBackup(storage);

    expect(result.filename).toMatch(/^backup-.*\.zip$/);
    expect(storage.put).toHaveBeenCalledOnce();
  });

  it('BACKUP-036p — archives the plugin data + code trees when present, skipping dev-links', async () => {
    // Only the plugin roots exist (db/uploads absent → skipped).
    fsMock.existsSync.mockImplementation((p: string) => String(p).includes('plugins'));
    // Two plugin code dirs: 'notes' is real, 'devlink' resolves outside the root.
    // The plugin-data snapshot reads with { withFileTypes: true }; hand it Dirent-likes there.
    const dirent = (name: string, directory = true) => ({ name, isDirectory: () => directory, isFile: () => !directory });
    fsMock.readdirSync.mockImplementation((p: string, opts?: { withFileTypes?: boolean }) => {
      const value = String(p);
      const entries = value.includes('plugins-snap')
        ? value.endsWith('notes') ? [dirent('plugin.db', false)] : [dirent('notes')]
        : value.endsWith('/plugins') ? [dirent('notes'), dirent('devlink')]
        : value.endsWith('/plugins/notes') ? [dirent('index.js', false)] : [];
      return (opts?.withFileTypes ? entries : entries.map((entry) => entry.name)) as never;
    });
    fsMock.realpathSync.mockImplementation((p: string) => (String(p).endsWith('devlink') ? '/somewhere/else/devlink' : p));
    fsMock.statSync.mockReturnValue({ isDirectory: () => true } as never);
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(2048) });

    await createBackup(storage);

    // the consistent snapshot and real code files are manifest-bound; the dev-link is skipped.
    expect(archiverInstanceMock.file).toHaveBeenCalledWith(expect.stringContaining('plugins-snap'), { name: 'plugins-data/notes/plugin.db' });
    expect(archiverInstanceMock.file).toHaveBeenCalledWith(expect.stringContaining('/staging-backup-'), { name: 'plugins-code/notes/index.js' });
    expect(archiverInstanceMock.file).not.toHaveBeenCalledWith(expect.anything(), { name: expect.stringContaining('devlink') });
  });

  it('BACKUP-036q — self-contained backups archive the at-rest key, but the manifest never exposes its value', async () => {
    const previous = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('.encryption_key'));
      fsMock.readFileSync.mockReturnValue(Buffer.from('fixture-secret-value'));
      setupArchiveSuccess();
      const storage = stubStorage({ stat: statOf(2048) });

      await createBackup(storage);

      expect(archiverInstanceMock.file).toHaveBeenCalledWith(
        expect.stringContaining('.encryption_key'),
        { name: '.encryption_key' },
      );
      expect(archiverInstanceMock.append).toHaveBeenCalledWith(
        expect.not.stringContaining('fixture-secret-value'),
        { name: 'backup-manifest.json' },
      );
    } finally {
      if (previous === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previous;
    }
  });

  it('BACKUP-036b — WAL checkpoint error is swallowed (non-critical)', async () => {
    // db.exec throws on WAL checkpoint
    dbMock.db.exec.mockImplementationOnce(() => { throw new Error('WAL checkpoint failed'); });
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(512) });

    // Should not throw even though WAL checkpoint failed
    const result = await createBackup(storage);
    expect(result).toHaveProperty('filename');
    expect(result.size).toBe(512);
  });

  it('BACKUP-036c — archiver error cleans up the spool staging, skips put and re-throws', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const archiveEvents: Record<string, Function> = {};
    fsMock.createWriteStream.mockReturnValue({ on: vi.fn() } as never);
    archiverInstanceMock.on.mockImplementation((event: string, cb: Function) => { archiveEvents[event] = cb; });
    archiverInstanceMock.pipe.mockReturnValue(undefined);
    archiverInstanceMock.finalize.mockImplementation(() => {
      // Simulate archive error instead of success
      archiveEvents['error']?.(new Error('disk full'));
    });
    archiverMock.mockReturnValue(archiverInstanceMock);
    const storage = stubStorage();

    await expect(createBackup(storage)).rejects.toThrow('disk full');

    // Nothing is committed; the half-built spool file is removed in the finally.
    expect(storage.put).not.toHaveBeenCalled();
    expect(fsMock.rmSync).toHaveBeenCalledWith(expect.stringContaining('zip-build-backup-'), { force: true });
  });

  it('BACKUP-036d — includes travel.db when it exists, snapshotted into the spool', async () => {
    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('travel.db'));
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(1024) });

    await createBackup(storage);

    // the core DB is snapshotted (VACUUM INTO) and archived under the name travel.db
    expect(dbMock.db.exec).toHaveBeenCalledWith(expect.stringContaining('VACUUM INTO'));
    expect(archiverInstanceMock.file).toHaveBeenCalledWith(
      expect.stringContaining('/stub/spool/travel-snap-backup-'),
      { name: 'travel.db' }
    );
  });

  it('BACKUP-036e — excludes the re-derivable photo caches nested under photos/', async () => {
    // In mode A the google/trek caches live inside the photos/ prefix, so the
    // category walk must skip them. (In mode B photos-google is a separate
    // category that is simply never enumerated — no extra branch needed.)
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    const storage = stubStorage({
      stat: statOf(1024),
      list: listByCategory({
        photos: [{ key: 'flat.jpg' }, { key: 'google/g.jpg' }, { key: 'trek/t.bin' }],
      }),
    });

    await createBackup(storage);

    expect(archiverInstanceMock.file).toHaveBeenCalledWith(expect.stringContaining('/staging-backup-'), { name: 'uploads/photos/flat.jpg' });
    const names = archiverInstanceMock.file.mock.calls.map(c => c[1]?.name as string);
    expect(names.some(n => n?.includes('google/'))).toBe(false);
    expect(names.some(n => n?.includes('trek/'))).toBe(false);
    // Only the archived categories are ever listed — the excludes are structural.
    expect(storage.getLocalPathOrNull).toHaveBeenCalledTimes(1);
  });

  it('BACKUP-036h — only category prefixes are ever archived; backups/ and restore-* are structurally out (issue #1358)', async () => {
    // The uploads/** glob is gone: even when data and uploads map to the same
    // directory, enumeration only ever walks the six archived categories, so
    // prior backup zips and restore-* staging can never be swept into the zip.
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(1024) });

    await createBackup(storage);

    expect(archiverInstanceMock.glob).not.toHaveBeenCalled();
    const listed = (storage.list as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
    expect(listed.sort()).toEqual(['avatars', 'covers', 'files', 'journey', 'photos', 'places']);
    expect(listed).not.toContain('backups');
  });

  it('BACKUP-036f — bundles .encryption_key when the file is the active key source', async () => {
    const prevEnvKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('.encryption_key'));
      setupArchiveSuccess();
      const storage = stubStorage({ stat: statOf(1024) });

      await createBackup(storage);

      expect(archiverInstanceMock.file).toHaveBeenCalledWith(
        expect.stringContaining('.encryption_key'),
        { name: '.encryption_key' },
      );
    } finally {
      process.env.ENCRYPTION_KEY = prevEnvKey;
    }
  });

  it('BACKUP-036g — never bundles .encryption_key when an env key is set', async () => {
    // setup.ts sets process.env.ENCRYPTION_KEY, so the env is the source of truth.
    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('.encryption_key'));
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(1024) });

    await createBackup(storage);

    expect(archiverInstanceMock.file).not.toHaveBeenCalledWith(
      expect.stringContaining('.encryption_key'),
      expect.anything(),
    );
  });

  it('BACKUP-036i — the auto-backup prefix names both the zip and its scratch snapshots', async () => {
    // The scheduler passes 'auto-backup' so retention and the admin panel can
    // still tell scheduled archives apart by filename.
    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('travel.db'));
    setupArchiveSuccess();
    const storage = stubStorage({ stat: statOf(1024) });

    const result = await createBackup(storage, 'auto-backup');

    expect(result.filename).toMatch(/^auto-backup-.*\.zip$/);
    expect(archiverInstanceMock.file).toHaveBeenCalledWith(
      expect.stringContaining('travel-snap-auto-backup-'),
      { name: 'travel.db' },
    );
    expect(storage.put).toHaveBeenCalledWith('backups', result.filename, {
      tmpPath: expect.stringContaining('zip-build-auto-backup-'),
    });
  });

  it('BACKUP-036r — refuses to archive a live database when VACUUM INTO fails', async () => {
    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('travel.db'));
    dbMock.db.exec
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('database is busy'); });
    setupArchiveSuccess();

    await expect(createBackup(stubStorage({ stat: statOf(1024) }))).rejects.toThrow(/snapshot failed/i);
  });

  it('BACKUP-036s — rejects a backup that vanishes immediately after commit', async () => {
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();

    await expect(createBackup(stubStorage({ stat: vi.fn(async () => null) }))).rejects.toThrow(/vanished after commit/i);
  });

  it('BACKUP-036t — skips non-directory plugin code entries', async () => {
    const dirent = (name: string, kind: 'file' | 'dir' | 'other') => ({
      name,
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
    });
    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('/plugins'));
    fsMock.readdirSync.mockImplementation((p: string, opts?: { withFileTypes?: boolean }) => {
      const entries = String(p).endsWith('/plugins')
        ? [dirent('readme.txt', 'file'), dirent('socket', 'other')]
        : [];
      return (opts?.withFileTypes ? entries : entries.map((entry) => entry.name)) as never;
    });
    fsMock.realpathSync.mockImplementation((p: string) => p);
    fsMock.statSync.mockReturnValue({ isDirectory: () => false } as never);
    setupArchiveSuccess();

    await createBackup(stubStorage({ stat: statOf(1024) }));

    expect(archiverInstanceMock.file).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: expect.stringContaining('plugins-code') }));
    expect(fsMock.readdirSync.mock.calls.some(([p]) => /(?:readme\.txt|socket)$/.test(String(p)))).toBe(false);
  });

  it('BACKUP-036u — ignores special entries while walking plugin data files', async () => {
    const special = { name: 'socket', isDirectory: () => false, isFile: () => false };
    const directory = { name: 'notes', isDirectory: () => true, isFile: () => false };
    fsMock.existsSync.mockImplementation((p: string) => String(p).includes('plugins-data') || String(p).includes('plugins-snap'));
    fsMock.readdirSync.mockImplementation((p: string, opts?: { withFileTypes?: boolean }) => {
      const value = String(p);
      const entries = value.endsWith('plugins-data') ? [directory]
        : value.endsWith('plugins-data/notes') ? [special]
        : value.includes('plugins-snap-') && value.endsWith('/notes') ? [special]
        : value.includes('plugins-snap-') ? [directory]
        : [];
      return (opts?.withFileTypes ? entries : entries.map((entry) => entry.name)) as never;
    });
    setupArchiveSuccess();

    await createBackup(stubStorage({ stat: statOf(1024) }));

    expect(archiverInstanceMock.file).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: expect.stringContaining('plugins-data') }));
  });

  it('BACKUP-036v — concurrent creates receive distinct final archive names', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-06T12:00:00Z'));
    try {
      fsMock.existsSync.mockReturnValue(false);
      setupArchiveSuccess();
      const storage = stubStorage({ stat: statOf(1024) });

      const [first, second] = await Promise.all([createBackup(storage), createBackup(storage)]);

      expect(first.filename).not.toBe(second.filename);
      expect(storage.put).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('BACKUP-036w — serializes concurrent creates and isolates failed-operation cleanup', async () => {
    fsMock.existsSync.mockReturnValue(false);
    setupArchiveSuccess();
    let releaseFirstPut!: () => void;
    const firstPutBlocked = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
    let firstPutStarted!: () => void;
    const firstPutReady = new Promise<void>((resolve) => { firstPutStarted = resolve; });
    let putCount = 0;
    const storage = stubStorage({
      stat: statOf(1024),
      put: vi.fn(async () => {
        putCount++;
        if (putCount === 1) {
          firstPutStarted();
          await firstPutBlocked;
          throw new Error('first backup failed');
        }
      }),
    });

    const first = createBackup(storage);
    await firstPutReady;
    const second = createBackup(storage);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The second operation must wait while the first commit is still open.
    expect(storage.put).toHaveBeenCalledTimes(1);

    releaseFirstPut();
    await expect(first).rejects.toThrow('first backup failed');
    await expect(second).resolves.toMatchObject({ filename: expect.stringMatching(/^backup-.*\.zip$/) });
    const cleanupPaths = fsMock.rmSync.mock.calls.map(([target]) => String(target));
    expect(new Set(cleanupPaths).size).toBe(cleanupPaths.length);
  });
});

describe('BACKUP-060 manifest policy', () => {
  beforeEach(() => vi.clearAllMocks());

  const digest = createHash('sha256').update('fixture-bytes').digest('hex');
  const databaseEntry = () => ({ path: 'travel.db', category: 'database', source: 'travel.db', size: 13, sha256: digest });
  const manifestResult = (entries: unknown[], archivePaths = entries.map((entry) => (entry as { path?: string })?.path ?? 'entry').concat('backup-manifest.json')) => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) => String(p).endsWith('backup-manifest.json')
      ? JSON.stringify({ version: 1, entries })
      : Buffer.from('fixture-bytes'));
    return validateBackupManifest('/restore', archivePaths);
  };

  it('BACKUP-060a — rejects a manifest upload key that storage would reject', () => {
    const manifest = JSON.stringify({
      version: 1,
      entries: [{
        path: 'uploads/files/.hidden', category: 'uploads', source: 'files/.hidden', size: 0,
        sha256: '0'.repeat(64),
      }],
    });
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) => String(p).endsWith('backup-manifest.json') ? manifest : Buffer.alloc(0));

    expect(validateBackupManifest('/restore', ['uploads/files/.hidden', 'backup-manifest.json']))
      .toBe('Invalid backup: checksum manifest is malformed.');
  });

  it('BACKUP-060b — accepts every non-database manifest category and validates their bytes', () => {
    const payloads = new Map([
      ['travel.db', Buffer.from('database-bytes')],
      ['uploads/files/document.pdf', Buffer.from('upload-bytes')],
      ['plugins-data/notes/plugin.db', Buffer.from('plugin-data-bytes')],
      ['plugins-code/notes/index.js', Buffer.from('plugin-code-bytes')],
      ['.encryption_key', Buffer.from('key-bytes')],
    ]);
    const entry = (entryPath: string, category: string, source: string) => {
      const bytes = payloads.get(entryPath)!;
      return {
        path: entryPath,
        category,
        source,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    };
    const entries = [
      entry('travel.db', 'database', 'travel.db'),
      entry('uploads/files/document.pdf', 'uploads', 'files/document.pdf'),
      entry('plugins-data/notes/plugin.db', 'plugins-data', 'notes/plugin.db'),
      entry('plugins-code/notes/index.js', 'plugins-code', 'notes/index.js'),
      entry('.encryption_key', 'encryption-key', '.encryption_key'),
    ];
    const pathsByFd = new Map<number, string>();
    let nextFd = 100;
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) => String(p).endsWith('backup-manifest.json')
      ? JSON.stringify({ version: 1, entries })
      : Buffer.from('unexpected-read'));
    fsMock.openSync.mockImplementation((p?: string) => {
      const fd = nextFd++;
      pathsByFd.set(fd, path.relative('/restore', String(p)).split(path.sep).join('/'));
      return fd;
    });
    fsMock.readSync.mockImplementation((fd: number, buffer: Buffer, _offset: number, _length: number, position: number) => {
      const bytes = payloads.get(pathsByFd.get(fd) ?? '') ?? Buffer.alloc(0);
      if (position >= bytes.length) return 0;
      bytes.copy(buffer, 0, position);
      return bytes.length - position;
    });
    const archivePaths = [...payloads.keys(), 'backup-manifest.json'];

    try {
      expect(validateBackupManifest('/restore', archivePaths)).toBeNull();

      for (const candidate of entries.filter(({ category }) => category !== 'database')) {
        const original = candidate.sha256;
        try {
          candidate.sha256 = '0'.repeat(64);
          expect(validateBackupManifest('/restore', archivePaths))
            .toBe(`Invalid backup: checksum verification failed for ${candidate.path}.`);
        } finally {
          candidate.sha256 = original;
        }
      }
    } finally {
      fsMock.readFileSync.mockImplementation((_path: string): string | Buffer => Buffer.from('fixture-bytes'));
      fsMock.openSync.mockImplementation(() => 42);
      fsMock.readSync.mockImplementation((_fd: number, buffer: Buffer, _offset: number, _length: number, position: number) => {
        if (position > 0) return 0;
        const bytes = Buffer.from('fixture-bytes');
        bytes.copy(buffer);
        return bytes.length;
      });
    }
  });

  it('BACKUP-060c — rejects malformed entry shapes before trusting archive paths', () => {
    const base = databaseEntry();
    const malformed = [
      null,
      { ...base, path: '' },
      { ...base, source: '../travel.db' },
      { ...base, size: 1.5 },
      { ...base, sha256: 'not-a-digest' },
      { ...base, category: 'unknown' },
    ];
    for (const entry of malformed) {
      expect(manifestResult([entry])).toBe('Invalid backup: checksum manifest is malformed.');
    }
  });

  it('BACKUP-060c1 — rejects an unreadable JSON manifest', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('{not-json');

    expect(validateBackupManifest('/restore', ['travel.db', 'backup-manifest.json']))
      .toBe('Invalid backup: checksum manifest is unreadable.');
  });

  it('BACKUP-060d — rejects duplicate, uncovered, mismatched, and missing manifest files', () => {
    const base = databaseEntry();
    expect(manifestResult([base, { ...base }])).toBe('Invalid backup: checksum manifest has duplicate paths.');
    const noDatabase = { path: 'plugins-code/notes/index.js', category: 'plugins-code', source: 'notes/index.js', size: 13, sha256: digest };
    expect(manifestResult([noDatabase])).toBe('Invalid backup: checksum manifest does not cover travel.db.');
    expect(manifestResult([base], ['travel.db', 'extra.bin', 'backup-manifest.json'])).toBe('Invalid backup: archive entries do not match the checksum manifest.');
    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('backup-manifest.json'));
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ version: 1, entries: [base] }));
    expect(validateBackupManifest('/restore', ['travel.db', 'backup-manifest.json'])).toMatch(/manifest entry is missing/);
  });
});

// ---------------------------------------------------------------------------
// deleteBackup
// ---------------------------------------------------------------------------

describe('BACKUP-037 deleteBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-037a — happy path: deletes through storage under the backups category', async () => {
    const storage = stubStorage();

    await deleteBackup(storage, 'backup-2026-04-06T12-00-00.zip');

    expect(storage.delete).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledWith('backups', 'backup-2026-04-06T12-00-00.zip');
  });

  it('BACKUP-037b — propagates a storage delete failure', async () => {
    // Note: storage.delete is idempotent on a MISSING object (route parity holds
    // because the controller pre-checks existence and 404s); this pins that a
    // real backend failure still surfaces.
    const storage = stubStorage({ delete: vi.fn(async () => { throw new Error('EIO: i/o error'); }) });

    await expect(deleteBackup(storage, 'backup-missing.zip')).rejects.toThrow('EIO');
  });
});

// ---------------------------------------------------------------------------
// restoreFromZip
// ---------------------------------------------------------------------------

describe('BACKUP-038 restoreFromZip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-038a — returns error when travel.db not found in zip', async () => {
    // Simulate successful extraction but missing travel.db
    const fakeReadStream = { pipe: vi.fn() };
    const fakeExtractStream = { promise: vi.fn().mockResolvedValue(undefined) };
    fsMock.createReadStream.mockReturnValue(fakeReadStream);
    fakeReadStream.pipe.mockReturnValue(fakeExtractStream);
    unzipperMock.Extract.mockReturnValue(fakeExtractStream);

    // extractedDb does not exist
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return false;
      return true; // extractDir exists for cleanup
    });
    fsMock.rmSync.mockReturnValue(undefined);

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/checksum manifest.*pinned previous image/i);
    expect(result.status).toBe(400);
  });

  it('BACKUP-038b — rejects a zip bomb whose declared decompressed size exceeds the cap', async () => {
    unzipperMock.Open.file.mockResolvedValueOnce({
      files: [{ uncompressedSize: 6 * 1024 * 1024 * 1024 }], // 6 GB > 5 GB cap
    });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/bomb.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/decompressed size/i);
    expect(unzipperMock.Extract).not.toHaveBeenCalled(); // bailed before extracting
  });
});

// ---------------------------------------------------------------------------
// restoreFromZip — the per-entry extraction loop
//
// This is the part of the restore that decides what an attacker-supplied archive is
// allowed to write, and it had no tests of its own: the zip-slip refusal, the running
// decompressed-byte cap (the declared size in the central directory is
// attacker-controlled, so the real guard counts bytes as they land) and the failure
// path that leaves the process without a reopened DB.
// ---------------------------------------------------------------------------

/** A minimal unzipper entry: emits `chunks` when its stream is piped. */
function zipEntry(entryPath: string, chunks: Buffer[] = [Buffer.alloc(8)], type = 'File') {
  return {
    path: entryPath,
    type,
    uncompressedSize: chunks.reduce((n, c) => n + c.length, 0),
    stream() {
      const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
      return {
        on(event: string, cb: (arg?: unknown) => void) {
          (handlers[event] ??= []).push(cb);
          return this;
        },
        destroy: vi.fn(),
        // The production code pipes AFTER registering handlers, so emitting here is
        // the moment every listener is in place.
        pipe(out: { emit(event: string): void }) {
          for (const chunk of chunks) for (const cb of handlers.data ?? []) cb(chunk);
          out.emit('finish');
        },
      };
    },
  };
}

/** A write stream that only has to carry 'finish' back to the awaiting promise. */
function fakeWriteStream() {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    on(event: string, cb: () => void) {
      (handlers[event] ??= []).push(cb);
      return this;
    },
    destroy: vi.fn(),
    emit(event: string) {
      for (const cb of handlers[event] ?? []) cb();
    },
  };
}

describe('BACKUP-061 restoreFromZip extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.createWriteStream.mockImplementation(() => fakeWriteStream());
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ size: 10 });
  });

  it('BACKUP-061a — refuses an entry whose path escapes the archive root (zip-slip)', async () => {
    unzipperMock.Open.file.mockResolvedValueOnce({ files: [zipEntry('../../etc/passwd')] });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/slip.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/escapes the archive root/i);
    // Nothing of that archive is left behind, and no byte of it was written.
    expect(fsMock.rmSync).toHaveBeenCalledWith(expect.stringContaining('restore-'), { recursive: true, force: true });
    expect(fsMock.createWriteStream).not.toHaveBeenCalled();
  });

  it('BACKUP-061a1 — rejects an archive with payload entries but no checksum manifest before closing the live DB', async () => {
    unzipperMock.Open.file.mockResolvedValueOnce({ files: [zipEntry('travel.db')] });
    fsMock.existsSync.mockImplementation((p: string) => !String(p).endsWith('backup-manifest.json'));

    const result = await restoreFromZip(stubStorage(), '/data/tmp/no-manifest.zip');

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/checksum manifest not found.*pinned previous image/i), status: 400 });
    expect(dbMock.closeDb).not.toHaveBeenCalled();
  });

  it('BACKUP-061a4 — rejects a manifest whose travel.db disappears after verification', async () => {
    setupSuccessfulExtraction();
    let databaseChecks = 0;
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return databaseChecks++ === 0;
      return true;
    });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/disappearing-db.zip');

    expect(result).toEqual({ success: false, error: 'Invalid backup: travel.db not found', status: 400 });
    expect(dbMock.closeDb).not.toHaveBeenCalled();
  });

  it('BACKUP-061a2 — rejects a checksum mismatch without touching the live DB', () => {
    const manifest = JSON.stringify({
      version: 1,
      entries: [{
        path: 'travel.db',
        category: 'database',
        source: 'travel.db',
        size: 13,
        sha256: 'c16a40a4584e5bccc84b45172fcdfa922f59ff1edebf3adba7b8266ea04eb39a',
      }],
    });
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) =>
      String(p).endsWith('backup-manifest.json') ? Buffer.from(manifest) : Buffer.from('tampered-bytes'),
    );
    fsMock.readSync.mockImplementation((_fd: number, buffer: Buffer, _offset: number, _length: number, position: number) => {
      if (position > 0) return 0;
      const bytes = Buffer.from('tampered-bytes');
      bytes.copy(buffer);
      return bytes.length;
    });

    expect(validateBackupManifest('/restore', ['travel.db', 'backup-manifest.json']))
      .toMatch(/checksum verification failed/i);
    expect(dbMock.closeDb).not.toHaveBeenCalled();
  });

  it('BACKUP-061a3 — rejects a manifest path traversal entry before file verification', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(Buffer.from(JSON.stringify({
      version: 1,
      entries: [{
        path: '../travel.db',
        category: 'database',
        source: 'travel.db',
        size: 0,
        sha256: '0'.repeat(64),
      }],
    })));

    expect(validateBackupManifest('/restore', ['../travel.db', 'backup-manifest.json']))
      .toBe('Invalid backup: checksum manifest is malformed.');
  });

  // The `path.isAbsolute(rel)` half of the guard is only reachable where drive letters
  // exist: on POSIX, path.join always keeps an entry under extractDir, so a leading
  // slash is normalised away and only the `..` check above can fire. Asserting it
  // unconditionally passed locally on Windows and failed on the Linux CI runner, which
  // is the wrong way round for a security test to be discovered.
  it.runIf(process.platform === 'win32')('BACKUP-061b — a drive-letter entry path is refused the same way', async () => {
    unzipperMock.Open.file.mockResolvedValueOnce({ files: [zipEntry('C:/Windows/system32/evil.dll')] });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/abs.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(fsMock.createWriteStream).not.toHaveBeenCalled();
  });

  it('BACKUP-061c — directory entries are skipped rather than written', async () => {
    unzipperMock.Open.file.mockResolvedValueOnce({
      files: [zipEntry('uploads/', [], 'Directory'), zipEntry('travel.db')],
    });

    // What happens after extraction is BACKUP-042..045's business; this case only
    // cares that the directory entry never reached the writer.
    await restoreFromZip(stubStorage(), '/data/tmp/dirs.zip').catch(() => undefined);

    expect(fsMock.createWriteStream).toHaveBeenCalledTimes(1);
  });

  it('BACKUP-061d — stops mid-stream once the ACTUAL decompressed bytes cross the cap', async () => {
    // The declared size is a lie: the central directory claims 8 bytes while the
    // stream delivers well past the 5 GB cap. Only the running total catches this.
    const lying = zipEntry('travel.db', [Buffer.alloc(3 * 1024 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024 * 1024)]);
    lying.uncompressedSize = 8;
    unzipperMock.Open.file.mockResolvedValueOnce({ files: [lying] });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/liar.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/decompressed size/i);
    expect(fsMock.rmSync).toHaveBeenCalledWith(expect.stringContaining('restore-'), { recursive: true, force: true });
  });

  it('BACKUP-061e — a stream error is not swallowed as a size refusal', async () => {
    const entry = zipEntry('travel.db');
    entry.stream = () => {
      const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
      return {
        on(event: string, cb: (arg?: unknown) => void) {
          (handlers[event] ??= []).push(cb);
          return this;
        },
        destroy: vi.fn(),
        pipe() {
          for (const cb of handlers.error ?? []) cb(new Error('corrupt deflate stream'));
        },
      };
    };
    unzipperMock.Open.file.mockResolvedValueOnce({ files: [entry] });

    // A corrupt stream is NOT dressed up as a 400 "too large": it leaves the function
    // as a throw, which is what makes the controller answer 500 rather than telling the
    // admin their perfectly-sized backup is over the cap.
    await expect(restoreFromZip(stubStorage(), '/data/tmp/corrupt.zip')).rejects.toThrow('corrupt deflate stream');
    expect(fsMock.rmSync).toHaveBeenCalledWith(expect.stringContaining('restore-'), { recursive: true, force: true });
  });

  it('BACKUP-061f — a reopen failure after the swap reports "restart required", not success', async () => {
    // This test uses a complete manifest-bound archive; empty central directories
    // never bypass validation.
    setupSuccessfulExtraction();
    const restored = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ integrity_check: 'ok' }) })
        .mockReturnValueOnce({
          all: vi.fn().mockReturnValue([{ name: 'users' }, { name: 'trips' }, { name: 'trip_members' }, { name: 'places' }, { name: 'days' }]),
        }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () {
      return restored;
    });
    fsMock.existsSync.mockImplementation((path: string) => !String(path).includes('uploads'));
    dbMock.reinitialize.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const storage = stubStorage();

    await expect(restoreFromZip(storage, '/data/tmp/ok.zip')).rejects.toThrow('database is locked');
    // A failed reopened restored DB is rolled back to the old core snapshot and
    // opened again; it is never reported as a partly-successful restore.
    expect(dbMock.reinitialize).toHaveBeenCalledTimes(2);
    expect(storage.reloadConfig).toHaveBeenCalledTimes(1);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('BACKUP-061g — preserves the recovery journal when rollback itself fails', async () => {
    setupSuccessfulExtraction();
    const fakeDbInstance = {
      prepare: vi.fn()
        .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ integrity_check: 'ok' }) })
        .mockReturnValueOnce({ all: vi.fn().mockReturnValue([{ name: 'users' }, { name: 'trips' }, { name: 'trip_members' }, { name: 'places' }, { name: 'days' }]) }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () { return fakeDbInstance; });
    fsMock.existsSync.mockImplementation((p: string) => !String(p).includes('uploads'));
    fsMock.rmSync.mockReturnValue(undefined);
    dbMock.closeDb
      .mockReset()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('close failed during rollback'); });
    dbMock.reinitialize
      .mockReset()
      .mockImplementationOnce(() => { throw new Error('restored database failed to reopen'); })
      .mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(restoreFromZip(stubStorage(), '/data/tmp/rollback-journal.zip'))
        .rejects.toThrow(/automatic rollback was incomplete/i);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('Restore rollback incomplete'), expect.stringContaining('restore-journal-'));
      expect(fsMock.rmSync.mock.calls.some(([target]) => String(target).includes('restore-journal-'))).toBe(false);
    } finally {
      error.mockRestore();
      dbMock.closeDb.mockImplementation(() => undefined);
      dbMock.reinitialize.mockImplementation(() => undefined);
    }
  });

  it('BACKUP-061h — wraps a non-Error plugin staging failure', async () => {
    setupSuccessfulExtraction();
    const fakeDbInstance = {
      prepare: vi.fn()
        .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ integrity_check: 'ok' }) })
        .mockReturnValueOnce({ all: vi.fn().mockReturnValue([{ name: 'users' }, { name: 'trips' }, { name: 'trip_members' }, { name: 'places' }, { name: 'days' }]) }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () { return fakeDbInstance; });
    fsMock.existsSync.mockImplementation((p: string) => !String(p).includes('uploads'));
    fsMock.rmSync.mockReturnValue(undefined);
    pluginBackupMock.stageExtractedPluginTrees.mockImplementationOnce(() => { throw 'plugin staging unavailable'; });

    await expect(restoreFromZip(stubStorage(), '/data/tmp/staging-error.zip'))
      .rejects.toThrow('Plugin restore staging failed: plugin staging unavailable');
    pluginBackupMock.stageExtractedPluginTrees.mockImplementation(() => false);
  });

  it('BACKUP-061h1 — wraps an Error plugin staging failure without losing its message', async () => {
    setupSuccessfulExtraction();
    const fakeDbInstance = {
      prepare: vi.fn()
        .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ integrity_check: 'ok' }) })
        .mockReturnValueOnce({ all: vi.fn().mockReturnValue([{ name: 'users' }, { name: 'trips' }, { name: 'trip_members' }, { name: 'places' }, { name: 'days' }]) }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () { return fakeDbInstance; });
    fsMock.existsSync.mockImplementation((p: string) => !String(p).includes('uploads'));
    fsMock.rmSync.mockReturnValue(undefined);
    pluginBackupMock.stageExtractedPluginTrees.mockImplementationOnce(() => { throw new Error('plugin stage failed'); });

    await expect(restoreFromZip(stubStorage(), '/data/tmp/staging-error-object.zip'))
      .rejects.toThrow('Plugin restore staging failed: plugin stage failed');
    pluginBackupMock.stageExtractedPluginTrees.mockImplementation(() => false);
  });

  it('BACKUP-061i — cleans up extraction when opening the archive fails', async () => {
    unzipperMock.Open.file.mockRejectedValueOnce(new Error('archive unreadable'));
    fsMock.existsSync.mockReturnValue(true);
    fsMock.rmSync.mockReturnValue(undefined);

    await expect(restoreFromZip(stubStorage(), '/data/tmp/unreadable.zip')).rejects.toThrow('archive unreadable');
    expect(fsMock.rmSync).toHaveBeenCalledWith(expect.stringContaining('restore-'), { recursive: true, force: true });
  });

  it('BACKUP-061j — tolerates a missing extraction directory during outer cleanup', async () => {
    unzipperMock.Open.file.mockRejectedValueOnce(new Error('archive unreadable'));
    fsMock.existsSync.mockReturnValue(false);

    await expect(restoreFromZip(stubStorage(), '/data/tmp/unreadable-no-dir.zip')).rejects.toThrow('archive unreadable');
    expect(fsMock.rmSync).not.toHaveBeenCalledWith(expect.stringContaining('restore-'), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// better-sqlite3 mock — hoisted by Vitest regardless of file position
// ---------------------------------------------------------------------------

const DatabaseMock = vi.hoisted(() => vi.fn());

vi.mock('better-sqlite3', () => ({ default: DatabaseMock }));

// BACKUP-039 (backupFilePath) retired: every consumer addresses backups as
// (category, name) through StorageService now — no absolute path leaves the impl.

// ---------------------------------------------------------------------------
// backupFileExists
// ---------------------------------------------------------------------------

describe('BACKUP-040 backupFileExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-040a — returns true when storage.exists resolves true', async () => {
    const storage = stubStorage({ exists: vi.fn(async () => true) });
    await expect(backupFileExists(storage, 'backup-2026-01-01T00-00-00.zip')).resolves.toBe(true);
    expect(storage.exists).toHaveBeenCalledWith('backups', 'backup-2026-01-01T00-00-00.zip');
  });

  it('BACKUP-040b — returns false when storage.exists resolves false', async () => {
    const storage = stubStorage({ exists: vi.fn(async () => false) });
    await expect(backupFileExists(storage, 'backup-missing.zip')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendBackupToResponse
// ---------------------------------------------------------------------------

describe('BACKUP-062 sendBackupToResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-062a — serves through storage with the res.download attachment header', async () => {
    const storage = stubStorage();
    const res = { setHeader: vi.fn() } as unknown as import('express').Response;

    await sendBackupToResponse(storage, 'backup-2026-01-01T00-00-00.zip', res);

    expect(storage.sendToResponse).toHaveBeenCalledOnce();
    expect(storage.sendToResponse).toHaveBeenCalledWith(
      'backups',
      'backup-2026-01-01T00-00-00.zip',
      res,
      { disposition: 'attachment; filename="backup-2026-01-01T00-00-00.zip"' },
    );
  });

  it('BACKUP-062b — propagates a storage failure (the controller owns the miss contract)', async () => {
    const storage = stubStorage({ sendToResponse: vi.fn(async () => { throw new Error('missing'); }) });
    const res = {} as import('express').Response;

    await expect(sendBackupToResponse(storage, 'backup-x.zip', res)).rejects.toThrow('missing');
  });
});

// ---------------------------------------------------------------------------
// listBackups
// ---------------------------------------------------------------------------

describe('BACKUP-041 listBackups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-041a — returns empty array when the category has no objects', async () => {
    const storage = stubStorage();
    await expect(listBackups(storage)).resolves.toEqual([]);
    expect(storage.list).toHaveBeenCalledWith('backups');
  });

  it('BACKUP-041b — returns BackupInfo for each .zip object', async () => {
    const storage = stubStorage({
      list: listOf([{ key: 'backup-2026-01-01T00-00-00.zip', size: 1024, mtimeMs: Date.parse('2026-01-01T00:00:00Z') }]),
    });

    const result = await listBackups(storage);

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('backup-2026-01-01T00-00-00.zip');
    expect(result[0].size).toBe(1024);
    expect(result[0].sizeText).toBe('1.0 KB');
    expect(result[0].created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('BACKUP-041c — sorts results newest-first by mtime', async () => {
    const storage = stubStorage({
      list: listOf([
        { key: 'backup-2026-01-01T00-00-00.zip', size: 512, mtimeMs: Date.parse('2026-01-01T00:00:00Z') },
        { key: 'backup-2026-06-01T00-00-00.zip', size: 2048, mtimeMs: Date.parse('2026-06-01T00:00:00Z') },
      ]),
    });

    const result = await listBackups(storage);

    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('backup-2026-06-01T00-00-00.zip');
    expect(result[1].filename).toBe('backup-2026-01-01T00-00-00.zip');
  });

  it('BACKUP-041d — filters out non-.zip objects', async () => {
    const storage = stubStorage({
      list: listOf([
        { key: 'backup-2026-01-01T00-00-00.zip', size: 1024, mtimeMs: Date.parse('2026-01-01T00:00:00Z') },
        { key: 'README.txt' },
        { key: 'backup-partial.tar.gz' },
      ]),
    });

    const result = await listBackups(storage);

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('backup-2026-01-01T00-00-00.zip');
  });

  it('BACKUP-041e — skips nested keys (storage.list recurses; the legacy readdir was single-level)', async () => {
    // A restore-* staging tree only sits under the backups root when an install
    // maps data and uploads to the same directory — it must not surface.
    const storage = stubStorage({
      list: listOf([
        { key: 'restore-123/uploads/x.zip' },
        { key: 'backup-2026-01-01T00-00-00.zip', size: 1024, mtimeMs: Date.parse('2026-01-01T00:00:00Z') },
      ]),
    });

    const result = await listBackups(storage);

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('backup-2026-01-01T00-00-00.zip');
  });
});

// ---------------------------------------------------------------------------
// restoreFromZip — extended paths (BACKUP-042 through BACKUP-046)
// ---------------------------------------------------------------------------

/** Shared helper: configures the stream mocks so extraction succeeds. */
function setupSuccessfulExtraction() {
  const payloadHash = 'c16a40a4584e5bccc84b45172fcdfa922f59ff1edebf3adba7b8266ea04eb39a';
  const manifest = JSON.stringify({
    version: 1,
    entries: [{ path: 'travel.db', category: 'database', source: 'travel.db', size: 13, sha256: payloadHash }],
  });
  fsMock.readFileSync.mockImplementation((p: string) =>
    String(p).endsWith('backup-manifest.json') ? manifest : Buffer.from('fixture-bytes'),
  );
  fsMock.readSync.mockImplementation((_fd: number, buffer: Buffer, _offset: number, _length: number, position: number) => {
    if (position > 0) return 0;
    const bytes = Buffer.from('fixture-bytes');
    bytes.copy(buffer);
    return bytes.length;
  });
  const makeEntry = (entryPath: string) => ({
    type: 'File', path: entryPath, uncompressedSize: 13,
    stream: () => ({
      on: vi.fn(),
      pipe: (out: { __finish?: () => void }) => { out.__finish?.(); return out; },
    }),
  });
  unzipperMock.Open.file.mockResolvedValue({ files: [makeEntry('travel.db'), makeEntry('backup-manifest.json')] });
  fsMock.createWriteStream.mockImplementation(() => {
    const out: { __finish?: () => void; on: ReturnType<typeof vi.fn> } = {
      on: vi.fn((event: string, callback: () => void) => { if (event === 'finish') out.__finish = callback; }),
    };
    return out as never;
  });
}

describe('BACKUP-064 restore admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-064a — rejects a concurrent restore before it can touch the shared extraction or staging paths', async () => {
    let releaseFirst!: (directory: { files: never[] }) => void;
    const firstDirectory = new Promise<{ files: never[] }>((resolve) => { releaseFirst = resolve; });
    let openCalls = 0;
    unzipperMock.Open.file.mockImplementation(() => {
      openCalls += 1;
      return openCalls === 1 ? firstDirectory : Promise.resolve({ files: [] });
    });
    fsMock.existsSync.mockReturnValue(false);
    fsMock.rmSync.mockReturnValue(undefined);

    const first = restoreFromZip(stubStorage(), '/data/tmp/first.zip');
    await Promise.resolve();
    try {
      await expect(restoreFromZip(stubStorage(), '/data/tmp/second.zip')).resolves.toEqual({
        success: false,
        error: 'A backup restore is already in progress.',
        status: 409,
      });
      expect(unzipperMock.Open.file).toHaveBeenCalledOnce();
    } finally {
      releaseFirst({ files: [] });
      await first;
      unzipperMock.Open.file.mockReset();
    }
  });
});

describe('BACKUP-042 restoreFromZip — integrity check fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-042a — returns status 400 with integrity check error message', async () => {
    setupSuccessfulExtraction();

    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('travel.db') || String(p).endsWith('backup-manifest.json'));
    fsMock.rmSync.mockReturnValue(undefined);

    const fakeDbInstance = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ integrity_check: 'corruption' }),
        all: vi.fn(),
      }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () {
      return fakeDbInstance;
    });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/integrity check/i);
    expect(fsMock.rmSync).toHaveBeenCalled();
  });
});

describe('BACKUP-043 restoreFromZip — missing required table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-043a — returns status 400 with missing required table error', async () => {
    setupSuccessfulExtraction();

    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('travel.db') || String(p).endsWith('backup-manifest.json'));
    fsMock.rmSync.mockReturnValue(undefined);

    const fakeDbInstance = {
      prepare: vi.fn()
        .mockReturnValueOnce({
          get: vi.fn().mockReturnValue({ integrity_check: 'ok' }),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockReturnValue([{ name: 'users' }, { name: 'trips' }]),
        }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () {
      return fakeDbInstance;
    });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/missing required table/i);
    expect(fsMock.rmSync).toHaveBeenCalled();
  });
});

describe('BACKUP-044 restoreFromZip — Database constructor throws (invalid SQLite)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-044a — returns status 400 with "not a valid SQLite database" error', async () => {
    setupSuccessfulExtraction();

    fsMock.existsSync.mockImplementation((p: string) => String(p).endsWith('travel.db') || String(p).endsWith('backup-manifest.json'));
    fsMock.rmSync.mockReturnValue(undefined);

    DatabaseMock.mockImplementation(function () {
      throw new Error('file is not a database');
    });

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/not a valid SQLite database/i);
    expect(fsMock.rmSync).toHaveBeenCalled();
  });
});

describe('BACKUP-045 restoreFromZip — full success path (no uploads)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupAllTablesPresent() {
    const fakeDbInstance = {
      prepare: vi.fn()
        .mockReturnValueOnce({
          get: vi.fn().mockReturnValue({ integrity_check: 'ok' }),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockReturnValue([
            { name: 'users' },
            { name: 'trips' },
            { name: 'trip_members' },
            { name: 'places' },
            { name: 'days' },
          ]),
        }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () {
      return fakeDbInstance;
    });
    return fakeDbInstance;
  }

  it('BACKUP-045a — returns { success: true } on full success', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    dbMock.reinitialize.mockReset();

    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result).toEqual({ success: true });
  });

  it('BACKUP-045b — closeDb is called before file copy operations', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();

    const callOrder: string[] = [];
    dbMock.closeDb.mockImplementation(() => { callOrder.push('closeDb'); });
    fsMock.copyFileSync.mockImplementation(() => { callOrder.push('copyFileSync'); });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);

    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });

    await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(callOrder.indexOf('closeDb')).toBeLessThan(callOrder.indexOf('copyFileSync'));
  });

  it('BACKUP-045c — reinitialize is called even when copyFileSync throws', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();

    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.copyFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    fsMock.rmSync.mockReturnValue(undefined);

    await expect(restoreFromZip(stubStorage(), '/data/tmp/upload.zip')).rejects.toThrow('disk full');

    expect(dbMock.reinitialize).toHaveBeenCalled();
    expect(pluginBackupMock.stageExtractedPluginTrees).not.toHaveBeenCalled();
    expect(pluginBackupMock.discardStagedPluginTrees).not.toHaveBeenCalled();
  });

  it('BACKUP-045d — never restores .encryption_key even if a legacy extraction carries one', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();

    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).endsWith('.encryption_key')) return true; // extracted key present
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result).toEqual({ success: true });
    // The old key is journaled for rollback, but a key from an archive outside
    // the manifest is never copied into the live key path.
    expect(fsMock.copyFileSync.mock.calls.some(([from, to]) =>
      String(from).includes('restore-') && String(from).endsWith('.encryption_key') && String(to).endsWith('/data/.encryption_key'),
    )).toBe(false);
  });

  it('BACKUP-045e — skips key restore when the archive has no .encryption_key', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();

    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).endsWith('.encryption_key')) return false; // no key in archive
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);

    const result = await restoreFromZip(stubStorage(), '/data/tmp/upload.zip');

    expect(result).toEqual({ success: true });
    expect(fsMock.copyFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.encryption_key'),
      expect.stringContaining('.encryption_key'),
    );
  });

  it('BACKUP-045e1 — restores a manifest-bound encryption key when no env key is configured', async () => {
    const previous = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const digest = createHash('sha256').update('fixture-bytes').digest('hex');
      const manifest = JSON.stringify({ version: 1, entries: [
        { path: 'travel.db', category: 'database', source: 'travel.db', size: 13, sha256: digest },
        { path: '.encryption_key', category: 'encryption-key', source: '.encryption_key', size: 13, sha256: digest },
      ] });
      const makeEntry = (entryPath: string) => ({
        type: 'File', path: entryPath, uncompressedSize: 13,
        stream: () => ({ on: vi.fn(), pipe: (out: { __finish?: () => void }) => { out.__finish?.(); return out; } }),
      });
      unzipperMock.Open.file.mockResolvedValueOnce({ files: [makeEntry('travel.db'), makeEntry('.encryption_key'), makeEntry('backup-manifest.json')] });
      fsMock.readFileSync.mockImplementation((p: string) => String(p).endsWith('backup-manifest.json') ? manifest : Buffer.from('fixture-bytes'));
      fsMock.readSync.mockImplementation((_fd: number, buffer: Buffer, _offset: number, _length: number, position: number) => {
        if (position > 0) return 0;
        const bytes = Buffer.from('fixture-bytes');
        bytes.copy(buffer);
        return bytes.length;
      });
      fsMock.createWriteStream.mockImplementation(() => {
        const out: { __finish?: () => void; on: ReturnType<typeof vi.fn> } = {
          on: vi.fn((event: string, callback: () => void) => { if (event === 'finish') out.__finish = callback; }),
        };
        return out as never;
      });
      setupAllTablesPresent();
      fsMock.existsSync.mockImplementation((p: string) => !String(p).includes('uploads'));
      fsMock.copyFileSync.mockReturnValue(undefined);
      fsMock.rmSync.mockReturnValue(undefined);

      await expect(restoreFromZip(stubStorage(), '/data/tmp/key.zip')).resolves.toEqual({ success: true });
      expect(fsMock.copyFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/restore-.*\/\.encryption_key$/),
        expect.stringMatching(/\/data\/\.encryption_key$/),
      );
    } finally {
      process.env.ENCRYPTION_KEY = previous;
    }
  });

  it('BACKUP-045f — reloadConfig runs after reinitialize and before uploads rehydration (audit #4)', async () => {
    // The registry reads storage.* app_settings through the DB handle — which
    // is closed and reopened around this restore. reloadConfig() must run
    // AFTER that reopen (else it reads a torn/unavailable connection) and
    // BEFORE any rehydrated byte is put, so rehydration lands per the
    // RESTORED config rather than the stale pre-restore one.
    setupSuccessfulExtraction();
    setupAllTablesPresent();

    const callOrder: string[] = [];
    dbMock.reinitialize.mockImplementation(() => { callOrder.push('reinitialize'); });

    const dirent = (name: string, dir = false) => ({ name, isDirectory: () => dir, isFile: () => !dir });
    fsMock.existsSync.mockImplementation((p: string) => !String(p).endsWith('.encryption_key'));
    fsMock.readdirSync.mockImplementation((p: string, opts?: { withFileTypes?: boolean }) => {
      const s = String(p);
      const entries = s.endsWith('uploads') ? [dirent('files', true)] : s.endsWith('files') ? [dirent('a.pdf')] : [];
      return (opts?.withFileTypes ? entries : entries.map(e => e.name)) as never;
    });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);

    const storage = stubStorage({
      reloadConfig: vi.fn(() => { callOrder.push('reloadConfig'); }),
      put: vi.fn(async () => { callOrder.push('put:rehydrate'); }),
    });

    const result = await restoreFromZip(storage, '/data/tmp/upload.zip');

    expect(result).toEqual({ success: true });
    expect(callOrder).toEqual(['reinitialize', 'reloadConfig', 'put:rehydrate']);
  });

  it('BACKUP-045g — an unavailable immediate plugin apply is not reported as a successful restore', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    pluginBackupMock.stageExtractedPluginTrees.mockReturnValueOnce(true);
    pluginBackupMock.applyStagedRestoreNowStrict.mockResolvedValueOnce(null);
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });

    await expect(restoreFromZip(stubStorage(), '/data/tmp/upload.zip')).rejects.toThrow('Plugin restore could not be applied');
    expect(pluginBackupMock.discardStagedPluginTrees).toHaveBeenCalled();
  });

  it('BACKUP-045g1 — commits the plugin pair receipt only after every restore phase succeeds', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    const order: string[] = [];
    pluginBackupMock.stageExtractedPluginTrees.mockImplementationOnce(() => {
      order.push('plugin staging');
      return true;
    });
    const transaction = {
      labels: ['plugins-data', 'plugins-code'],
      rollback: vi.fn(),
      commitCleanup: vi.fn(() => { order.push('plugin commit'); }),
    };
    pluginBackupMock.applyStagedRestoreNowStrict.mockResolvedValueOnce(transaction);
    dbMock.reinitialize.mockImplementation(() => { order.push('reinitialize'); });
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.rmSync.mockReturnValue(undefined);
    const storage = stubStorage({ reloadConfig: vi.fn(() => { order.push('reloadConfig'); }) });

    await expect(restoreFromZip(storage, '/data/tmp/upload.zip')).resolves.toEqual({ success: true });

    expect(transaction.commitCleanup).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(order.indexOf('plugin staging')).toBeGreaterThan(order.indexOf('reinitialize'));
    expect(order.indexOf('plugin staging')).toBeGreaterThan(order.indexOf('reloadConfig'));
    expect(order.indexOf('plugin commit')).toBeGreaterThan(order.indexOf('plugin staging'));
  });

  it('BACKUP-045g1b — a closeDb failure cannot publish plugin staging for the next boot', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    dbMock.closeDb.mockImplementationOnce(() => { throw new Error('close failed'); });
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.rmSync.mockReturnValue(undefined);

    await expect(restoreFromZip(stubStorage(), '/data/tmp/upload.zip')).rejects.toThrow('close failed');

    expect(pluginBackupMock.stageExtractedPluginTrees).not.toHaveBeenCalled();
    expect(pluginBackupMock.applyStagedRestoreNowStrict).not.toHaveBeenCalled();
  });

  it('BACKUP-045g2 — rolls the plugin pair back first when its pre-commit staging cleanup fails', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    pluginBackupMock.stageExtractedPluginTrees.mockReturnValueOnce(true);
    const order: string[] = [];
    const transaction = {
      labels: ['plugins-data', 'plugins-code'],
      rollback: vi.fn(() => { order.push('plugin rollback'); }),
      commitCleanup: vi.fn(() => { throw new Error('plugin staging cleanup failed'); }),
    };
    pluginBackupMock.applyStagedRestoreNowStrict.mockResolvedValueOnce(transaction);
    dbMock.closeDb.mockImplementation(() => { order.push('closeDb'); });
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.rmSync.mockReturnValue(undefined);

    await expect(restoreFromZip(stubStorage(), '/data/tmp/upload.zip')).rejects.toThrow('plugin staging cleanup failed');

    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(order.indexOf('plugin rollback')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('plugin rollback')).toBeLessThan(order.lastIndexOf('closeDb'));
    expect(pluginBackupMock.discardStagedPluginTrees).not.toHaveBeenCalled();
  });

  it('BACKUP-045g3 — post-commit journal cleanup failure retains the restored state', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    pluginBackupMock.stageExtractedPluginTrees.mockReturnValueOnce(true);
    const transaction = {
      labels: ['plugins-data', 'plugins-code'],
      rollback: vi.fn(),
      commitCleanup: vi.fn(),
    };
    pluginBackupMock.applyStagedRestoreNowStrict.mockResolvedValueOnce(transaction);
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('travel.db')) return true;
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.rmSync.mockImplementation((target: string) => {
      if (/restore-journal-\d+-[0-9a-f-]+$/.test(String(target))) throw new Error('journal cleanup failed');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(restoreFromZip(stubStorage(), '/data/tmp/upload.zip')).resolves.toEqual({ success: true });

    expect(transaction.commitCleanup).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(dbMock.reinitialize).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Restore committed'),
      expect.stringContaining('restore-journal-'),
      expect.any(Error),
    );
    error.mockRestore();
  });

  it('BACKUP-045h — a restored storage-config reload failure restores the old DB and reloads its config', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).includes('uploads')) return false;
      return true;
    });
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);

    const storage = stubStorage({
      reloadConfig: vi.fn()
        .mockImplementationOnce(() => { throw new Error('restored storage config is invalid'); })
        .mockImplementationOnce(() => {}),
    });

    await expect(restoreFromZip(storage, '/data/tmp/upload.zip')).rejects.toThrow('restored storage config is invalid');
    expect(dbMock.reinitialize).toHaveBeenCalledTimes(2);
    expect(storage.reloadConfig).toHaveBeenCalledTimes(2);
    expect(fsMock.copyFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/restore-journal-\d+-[0-9a-f-]+\/core\/travel\.db$/),
      expect.stringMatching(/\/data\/travel\.db$/),
    );
  });
});

describe('BACKUP-046 restoreFromZip — uploads rehydration through storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupAllTablesPresent() {
    const fakeDbInstance = {
      prepare: vi.fn()
        .mockReturnValueOnce({
          get: vi.fn().mockReturnValue({ integrity_check: 'ok' }),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockReturnValue([
            { name: 'users' },
            { name: 'trips' },
            { name: 'trip_members' },
            { name: 'places' },
            { name: 'days' },
          ]),
        }),
      close: vi.fn(),
    };
    DatabaseMock.mockImplementation(function () {
      return fakeDbInstance;
    });
    return fakeDbInstance;
  }

  const dirent = (name: string, dir = false) => ({ name, isDirectory: () => dir, isFile: () => !dir });

  /** Common fs wiring: travel.db + extracted uploads exist; the extracted tree
   *  is described per-path via `tree` (walked with { withFileTypes: true }). */
  function setupExtractedUploads(tree: Record<string, ReturnType<typeof dirent>[]>) {
    fsMock.existsSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.encryption_key')) return false;
      return true;
    });
    fsMock.readdirSync.mockImplementation((p: string, opts?: { withFileTypes?: boolean }) => {
      const s = String(p);
      const key = Object.keys(tree).find(k => s.endsWith(k));
      const entries = key ? tree[key] : [];
      return (opts?.withFileTypes ? entries : entries.map(e => e.name)) as never;
    });
    fsMock.unlinkSync.mockReturnValue(undefined);
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);
  }

  function setupEmptyUploadArchive() {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    fsMock.existsSync.mockImplementation((p: string) => !String(p).includes('/uploads') && !String(p).endsWith('.encryption_key'));
    fsMock.copyFileSync.mockReturnValue(undefined);
    fsMock.rmSync.mockReturnValue(undefined);
  }

  function storageWithExistingUpload(overrides: Record<string, unknown> = {}) {
    return stubStorage({
      list: vi.fn((category: string) =>
        (async function* () {
          if (category === 'files') yield { key: 'old.bin', size: 4, mtimeMs: 0 };
        })(),
      ),
      ...overrides,
    });
  }

  it('BACKUP-046h — reconciles every upload category when the archive has no upload entries', async () => {
    setupEmptyUploadArchive();
    const storage = storageWithExistingUpload();

    await expect(restoreFromZip(storage, '/data/tmp/empty-uploads.zip')).resolves.toEqual({ success: true });

    expect(storage.delete).toHaveBeenCalledWith('files', 'old.bin');
  });

  it('BACKUP-046i — compensates an empty-upload reconcile when a later restore phase fails', async () => {
    setupEmptyUploadArchive();
    pluginBackupMock.stageExtractedPluginTrees.mockImplementationOnce(() => {
      throw new Error('plugin stage failed after upload reconcile');
    });
    const storage = storageWithExistingUpload({
      put: vi.fn(async () => {}),
    });

    await expect(restoreFromZip(storage, '/data/tmp/empty-uploads-failure.zip'))
      .rejects.toThrow('plugin stage failed after upload reconcile');

    expect(storage.delete).toHaveBeenCalledWith('files', 'old.bin');
    expect(storage.put).toHaveBeenCalledWith(
      'files',
      'old.bin',
      { tmpPath: expect.stringMatching(/restore-journal-\d+-[0-9a-f-]+\/uploads\/files\/old\.bin$/) },
    );
  });

  it('BACKUP-046a — writes all archive entries before removing stale existing objects', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true), dirent('journey', true)],
      '/uploads/files': [dirent('a.pdf')],
      '/uploads/journey': [dirent('thumbs', true)],
      '/uploads/journey/thumbs': [dirent('t.jpg')],
    });

    // Pre-existing objects: one bare per category plus a nested journey thumb —
    // the legacy wipe unlinked one level deep only, so nested keys must survive.
    // One delete rejects to pin the swallowed-per-file-error behavior.
    const storage = stubStorage({
      list: vi.fn((category: string) =>
        (async function* () {
          yield { key: 'old.bin', size: 1, mtimeMs: 0 };
          if (category === 'journey') yield { key: 'thumbs/old.jpg', size: 1, mtimeMs: 0 };
        })(),
      ),
      delete: vi.fn(async () => {}),
    });

    const result = await restoreFromZip(storage, '/data/tmp/upload.zip');

    expect(result).toEqual({ success: true });
    // stale keys are deleted only after both uploaded archive files are put.
    const deleted = (storage.delete as ReturnType<typeof vi.fn>).mock.calls;
    expect(deleted).toHaveLength(7);
    expect(deleted.map(([c]) => c).sort()).toEqual(['avatars', 'covers', 'files', 'journey', 'journey', 'photos', 'places']);
    // rehydration: every extracted file becomes a category put, nested keys intact
    expect(storage.put).toHaveBeenCalledWith('files', 'a.pdf', { tmpPath: expect.stringContaining('/uploads/files/a.pdf') });
    expect(storage.put).toHaveBeenCalledWith('journey', 'thumbs/t.jpg', { tmpPath: expect.stringContaining('/uploads/journey/thumbs/t.jpg') });
    // No uploads bulk copy remains (plugin-tree staging still uses cpSync — out of scope).
    const cpTargets = fsMock.cpSync.mock.calls.map(c => String(c[1]));
    expect(cpTargets.some(t => t.includes('uploads'))).toBe(false);
  });

  it('BACKUP-046b — fails closed when post-manifest extraction contains an invalid upload entry', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true), dirent('mystery', true), dirent('stray.txt')],
      '/uploads/files': [dirent('a.pdf')],
      '/uploads/mystery': [dirent('b.bin')],
    });
    await expect(restoreFromZip(stubStorage(), '/data/tmp/upload.zip'))
      .rejects.toThrow('invalid upload entry: mystery/b.bin');
  });

  it('BACKUP-046b1 — rejects a bare extracted upload file with no storage category', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({ '/uploads': [dirent('stray.txt')] });

    await expect(restoreFromZip(stubStorage(), '/data/tmp/bare-upload.zip'))
      .rejects.toThrow('invalid upload entry: stray.txt');
  });

  it('BACKUP-046b2 — rejects an existing inventory with an unsafe key', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({ '/uploads': [dirent('files', true)], '/uploads/files': [dirent('new.bin')] });
    const storage = stubStorage({
      list: listOf([{ key: '../unsafe', size: 1 }]),
    });

    await expect(restoreFromZip(storage, '/data/tmp/unsafe-inventory.zip'))
      .rejects.toThrow('Storage inventory contains an invalid key');
  });

  it('BACKUP-046b3 — rejects an existing inventory that exceeds the compensation journal cap', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({ '/uploads': [dirent('files', true)], '/uploads/files': [dirent('new.bin')] });
    const storage = stubStorage({
      list: listOf([{ key: 'large.bin', size: 6 * 1024 * 1024 * 1024 }]),
    });

    await expect(restoreFromZip(storage, '/data/tmp/large-inventory.zip'))
      .rejects.toThrow('bounded restore compensation journal limit');
  });

  it('BACKUP-046c — a genuine put failure still fails the restore', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true)],
      '/uploads/files': [dirent('a.pdf')],
    });
    const storage = stubStorage({
      put: vi.fn(async () => { throw new Error('ENOSPC: no space left'); }),
    });

    await expect(restoreFromZip(storage, '/data/tmp/upload.zip')).rejects.toThrow('ENOSPC');
    // the DB reopen still ran (finally) — the process is never left closed
    expect(dbMock.reinitialize).toHaveBeenCalled();
  });

  it('BACKUP-046d — a later upload put failure does not delete any pre-existing object', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true)],
      '/uploads/files': [dirent('first.bin'), dirent('second.bin')],
    });
    const storage = stubStorage({
      list: vi.fn((_category: string) =>
        (async function* () {
          yield { key: 'old.bin', size: 1, mtimeMs: 0 };
        })(),
      ),
      put: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('second object write failed')),
    });

    await expect(restoreFromZip(storage, '/data/tmp/upload.zip')).rejects.toThrow('second object write failed');
    // Compensation may delete archive keys that did not exist before the
    // restore, but it must never delete the unrelated old inventory key.
    expect(storage.delete).not.toHaveBeenCalledWith('files', 'old.bin');
  });

  it('BACKUP-046e — a partially committed replacement is compensated with the pre-restore object', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true)],
      '/uploads/files': [dirent('same.bin'), dirent('later.bin')],
    });

    const writes: Array<[string, string, unknown]> = [];
    const storage = stubStorage({
      list: vi.fn((_category: string) =>
        (async function* () {
          yield { key: 'same.bin', size: 3, mtimeMs: 0 };
        })(),
      ),
      put: vi.fn(async (category: string, key: string, source: unknown) => {
        writes.push([category, key, source]);
        if (key === 'later.bin') throw new Error('later put failed after prior overwrite');
      }),
    });

    await expect(restoreFromZip(storage, '/data/tmp/upload.zip')).rejects.toThrow('later put failed after prior overwrite');

    // The first put might have overwritten the live key before the second put
    // failed. A restore is not allowed to leave that partial archive state live.
    expect(writes).toContainEqual([
      'files',
      'same.bin',
      { tmpPath: expect.stringMatching(/restore-journal-\d+-[0-9a-f-]+\/uploads\/files\/same\.bin$/) },
    ]);
  });

  it('BACKUP-046f — a stale-object delete failure restores the stale byte from the journal', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true)],
      '/uploads/files': [dirent('new.bin')],
    });
    const writes: Array<[string, string, unknown]> = [];
    const storage = stubStorage({
      list: vi.fn((category: string) =>
        (async function* () {
          if (category === 'files') yield { key: 'stale.bin', size: 4, mtimeMs: 0 };
        })(),
      ),
      put: vi.fn(async (category: string, key: string, source: unknown) => { writes.push([category, key, source]); }),
      delete: vi.fn(async (category: string, key: string) => {
        if (category === 'files' && key === 'stale.bin') throw new Error('stale delete failed');
      }),
    });

    await expect(restoreFromZip(storage, '/data/tmp/upload.zip')).rejects.toThrow('stale delete failed');
    expect(writes).toContainEqual([
      'files',
      'stale.bin',
      { tmpPath: expect.stringMatching(/restore-journal-\d+-[0-9a-f-]+\/uploads\/files\/stale\.bin$/) },
    ]);
  });

  it('BACKUP-046g — retains the journal when upload compensation also fails', async () => {
    setupSuccessfulExtraction();
    setupAllTablesPresent();
    setupExtractedUploads({
      '/uploads': [dirent('files', true)],
      '/uploads/files': [dirent('same.bin'), dirent('later.bin')],
    });
    let puts = 0;
    const storage = stubStorage({
      list: vi.fn((_category: string) =>
        (async function* () {
          if (_category === 'files') yield { key: 'same.bin', size: 1, mtimeMs: 0 };
        })(),
      ),
      put: vi.fn(async () => {
        puts += 1;
        if (puts >= 2) throw new Error('upload write failed');
      }),
      delete: vi.fn(async () => { throw new Error('stale cleanup failed'); }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(restoreFromZip(storage, '/data/tmp/compensation-failure.zip'))
        .rejects.toThrow(/automatic rollback was incomplete/i);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Restore rollback incomplete'), expect.stringContaining('restore-journal-'));
      expect(fsMock.rmSync.mock.calls.some(([target]) => String(target).includes('restore-journal-'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// restoreBackup (stored-zip restore via withLocalFile)
// ---------------------------------------------------------------------------

describe('BACKUP-063 restoreBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BACKUP-063a — reads the stored zip through withLocalFile("backups") and returns the restore result', async () => {
    const storage = stubStorage({
      withLocalFile: vi.fn(async () => ({ success: true })),
    });

    await expect(restoreBackup(storage, 'backup-2026-01-01T00-00-00.zip')).resolves.toEqual({ success: true });
    expect(storage.withLocalFile).toHaveBeenCalledWith('backups', 'backup-2026-01-01T00-00-00.zip', expect.any(Function));
  });

  it('BACKUP-063b — the local path handed back by storage feeds the restore core', async () => {
    // Missing manifests fail closed, including legacy archives.
    fsMock.existsSync.mockReturnValue(false);
    unzipperMock.Open.file.mockResolvedValue({ files: [] });
    const storage = stubStorage();

    const result = await restoreBackup(storage, 'backup-2026-01-01T00-00-00.zip');

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/checksum manifest not found.*pinned previous image/i), status: 400 });
  });
});

// BACKUP-047 (updateAutoSettings) moved to tests/unit/auto-backup.test.ts with
// the function — it lives on AutoBackupJob now.
