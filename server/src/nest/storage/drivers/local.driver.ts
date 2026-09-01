import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { assertValidKey, assertValidPrefix } from '../storage-keys';
import {
  isLocalTempFile,
  StorageBackendError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  type ByteRange,
  type LocalTempFile,
  type ObjectStat,
  type StorageDriver,
} from '../storage.types';

const SPOOL_DIR_NAME = '.tmp';
/** Boot spool-reap age gate: entries younger than this survive the sweep. */
const SPOOL_REAP_AGE_MS = 60 * 60 * 1000;

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** ENOENT on the path or any parent segment being a file — both are a miss. */
function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The only real driver type in v1: plain files under a root directory.
 *
 * `put` is atomic — stream sources spool into the hidden `<root>/.tmp` and
 * commit with a single same-volume `rename()`; caller-owned temp files rename
 * directly with an EXDEV copy-fallback for the cross-volume edge case. The
 * root is realpath'd at `init()` because in Docker both storage anchors are
 * symlinks (Dockerfile: `/app/server/uploads → /app/uploads`,
 * `/app/server/data → /app/data`) and a naive `startsWith` containment check
 * misbehaves on symlinked roots — the trap backup.impl.ts:423 and
 * nest/plugins/paths.ts already work around with `realpathSync`.
 */
export class LocalDriver implements StorageDriver {
  readonly id: string;
  private readonly configuredRoot: string;
  private realRoot: string | null = null;

  constructor(opts: { id: string; root: string }) {
    this.id = opts.id;
    this.configuredRoot = opts.root;
  }

  /**
   * Ensure root + spool + category prefix dirs exist and resolve the real
   * root. Runs on every registry load (boot and reload()) so a newly
   * configured backend is usable immediately; `cleanSpool` is passed at boot
   * only — on a reload it could delete an in-flight upload's spool file.
   */
  init(opts: { ensurePrefixes?: string[]; cleanSpool?: boolean } = {}): void {
    fs.mkdirSync(this.configuredRoot, { recursive: true });
    this.realRoot = fs.realpathSync(this.configuredRoot);
    const spool = this.spoolDir();
    this.assertNoSymlinkComponents(spool, SPOOL_DIR_NAME);
    fs.mkdirSync(spool, { recursive: true });
    this.assertNoSymlinkComponents(spool, SPOOL_DIR_NAME);
    for (const prefix of opts.ensurePrefixes ?? []) {
      assertValidPrefix(prefix);
      const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      if (!normalized) continue;
      const prefixPath = this.resolvePath(normalized);
      fs.mkdirSync(prefixPath, { recursive: true });
      this.assertNoSymlinkComponents(prefixPath, prefix);
    }
    if (opts.cleanSpool) {
      for (const entry of fs.readdirSync(this.spoolDir())) {
        const entryPath = path.join(this.spoolDir(), entry);
        // Age gate: only reap entries older than the threshold. Crash leftovers
        // are always old by the next boot; a fresh entry belongs to another
        // process spooling into the same tree right now (the vitest integration
        // workers share uploads/, and a second worker booting mid-upload must
        // not delete the first one's in-flight spool file).
        try {
          if (Date.now() - fs.statSync(entryPath).mtimeMs < SPOOL_REAP_AGE_MS) continue;
        } catch {
          continue; // raced away already — nothing to reap
        }
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  }

  private root(): string {
    if (!this.realRoot) {
      throw new StorageBackendError(`LocalDriver '${this.id}' used before init()`);
    }
    return this.realRoot;
  }

  private spoolDir(): string {
    return path.join(this.root(), SPOOL_DIR_NAME);
  }

  getSpoolDir(): string {
    const spool = this.spoolDir();
    this.assertNoSymlinkComponents(spool, SPOOL_DIR_NAME);
    return spool;
  }

  /**
   * Central key validation plus defense-in-depth containment: even a key that
   * somehow passed validation must resolve inside the real root. The configured
   * root itself may be a symlink (the supported Docker layout), but no component
   * below that real root may be one: otherwise a valid lexical key could escape.
   */
  private resolvePath(key: string): string {
    assertValidKey(key);
    const root = this.root();
    const resolved = path.resolve(root, key);
    if (!resolved.startsWith(root + path.sep)) {
      throw new StorageInvalidKeyError(key);
    }
    this.assertNoSymlinkComponents(resolved, key);
    return resolved;
  }

  private assertNoSymlinkComponents(resolved: string, key: string): void {
    const root = this.root();
    const relative = path.relative(root, resolved);
    if (relative === '' || relative === '.') return;
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new StorageInvalidKeyError(key);
    }

    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new StorageInvalidKeyError(key);
        let actual: string;
        try {
          actual = fs.realpathSync(current);
        } catch (err) {
          // lstat already proved that this component exists. A missing realpath
          // therefore means a dangling link/reparse point, not a safe missing
          // child that may be created below the storage root.
          if (isMissing(err)) throw new StorageInvalidKeyError(key);
          throw err;
        }
        const sameLocation = path.relative(current, actual) === '' && path.relative(actual, current) === '';
        // realpath comparison also catches Windows junctions/reparse points,
        // whose lstat shape is not consistent across supported Node versions.
        if (!sameLocation) throw new StorageInvalidKeyError(key);
      } catch (err) {
        if (err instanceof StorageInvalidKeyError) throw err;
        if (isMissing(err)) return;
        throw new StorageBackendError(`failed to verify local storage path '${key}' on '${this.id}'`, err);
      }
    }
  }

  getLocalPath(key: string): string {
    return this.resolvePath(key);
  }

  async put(key: string, source: Readable | LocalTempFile): Promise<void> {
    const dest = this.resolvePath(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    this.assertNoSymlinkComponents(dest, key);

    if (isLocalTempFile(source)) {
      let sourceStat: fs.Stats;
      try {
        sourceStat = fs.lstatSync(source.tmpPath);
      } catch (err) {
        throw new StorageBackendError(`put source is unavailable for '${key}' on '${this.id}'`, err);
      }
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new StorageInvalidKeyError(key);
      try {
        this.assertNoSymlinkComponents(dest, key);
        await fs.promises.rename(source.tmpPath, dest);
        const committed = await fs.promises.lstat(dest);
        if (committed.isSymbolicLink() || !committed.isFile()) {
          await fs.promises.rm(dest, { recursive: true, force: true });
          throw new StorageInvalidKeyError(key);
        }
      } catch (err) {
        if (err instanceof StorageInvalidKeyError) throw err;
        if (errnoCode(err) !== 'EXDEV') {
          throw new StorageBackendError(`put failed for '${key}' on '${this.id}'`, err);
        }
        // A cross-volume copy cannot write directly over the live object: an
        // ENOSPC/I/O error would leave it truncated. Copy into this backend's
        // same-volume spool, then commit with one rename just like stream puts.
        const copySpool = path.join(this.getSpoolDir(), randomUUID());
        try {
          await fs.promises.copyFile(source.tmpPath, copySpool);
          this.assertNoSymlinkComponents(dest, key);
          await fs.promises.rename(copySpool, dest);
          await fs.promises.unlink(source.tmpPath);
        } catch (copyErr) {
          await fs.promises.rm(copySpool, { force: true });
          throw copyErr instanceof StorageInvalidKeyError
            ? copyErr
            : new StorageBackendError(`put failed for '${key}' on '${this.id}'`, copyErr);
        }
      }
      return;
    }

    const spool = path.join(this.getSpoolDir(), randomUUID());
    try {
      await pipeline(source, fs.createWriteStream(spool));
      this.assertNoSymlinkComponents(dest, key);
      await fs.promises.rename(spool, dest);
    } catch (err) {
      await fs.promises.rm(spool, { force: true });
      if (err instanceof StorageInvalidKeyError) throw err;
      throw err instanceof Error && !errnoCode(err)
        ? err // source-stream failure: surface the caller's own error untouched
        : new StorageBackendError(`put failed for '${key}' on '${this.id}'`, err);
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<{ stream: Readable; stat: ObjectStat }> {
    const resolved = this.resolvePath(key);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      if (isMissing(err)) throw new StorageNotFoundError(key);
      if (errnoCode(err) === 'ELOOP') throw new StorageInvalidKeyError(key);
      throw new StorageBackendError(`get failed for '${key}' on '${this.id}'`, err);
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        await handle.close();
        throw new StorageNotFoundError(key);
      }
      const stream = handle.createReadStream(
        range ? { start: range.start, end: range.end } : undefined,
      );
      return { stream, stat: { key, size: st.size, mtimeMs: st.mtimeMs } };
    } catch (err) {
      try { await handle.close(); } catch { /* best effort */ }
      throw err;
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const resolved = this.resolvePath(key);
    try {
      const st = await fs.promises.lstat(resolved);
      if (!st.isFile()) return null;
      return { key, size: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (isMissing(err)) return null;
      throw new StorageBackendError(`stat failed for '${key}' on '${this.id}'`, err);
    }
  }

  async delete(key: string): Promise<void> {
    const resolved = this.resolvePath(key);
    try {
      await fs.promises.unlink(resolved);
    } catch (err) {
      if (isMissing(err)) return; // idempotent
      throw new StorageBackendError(`delete failed for '${key}' on '${this.id}'`, err);
    }
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    assertValidPrefix(prefix);
    const root = this.root();
    const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const start = normalized ? this.resolvePath(normalized) : root;
    yield* this.walk(start, root);
  }

  private async *walk(dir: string, root: string): AsyncIterable<ObjectStat> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return; // unpopulated prefix — empty, not an error
      throw new StorageBackendError(`list failed under '${dir}' on '${this.id}'`, err);
    }
    for (const entry of entries) {
      // Skips the .tmp spool (and any dotfile) defensively — key validation
      // already makes dot segments unreachable, but list walks the real disk.
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(entryPath);
      } catch (err) {
        if (isMissing(err)) continue;
        throw new StorageBackendError(`list failed under '${dir}' on '${this.id}'`, err);
      }
      const key = path.relative(root, entryPath).split(path.sep).join('/');
      this.assertNoSymlinkComponents(entryPath, key);
      if (st.isDirectory()) {
        yield* this.walk(entryPath, root);
      } else if (st.isFile()) {
        yield {
          key,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      }
    }
  }
}
