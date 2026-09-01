import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalDriver } from '../../../../src/nest/storage/drivers/local.driver';
import { StorageInvalidKeyError } from '../../../../src/nest/storage/storage.types';
import { describeStorageDriver, type DriverHarness } from './storage-driver.contract';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trek-storage-'));
}

async function makeHarness(): Promise<DriverHarness> {
  const root = makeTmpDir();
  const tmpFiles = makeTmpDir();
  const driver = new LocalDriver({ id: 'test-local', root });
  driver.init({ cleanSpool: true });
  let counter = 0;
  return {
    driver,
    makeTempFile: async (contents) => {
      const p = path.join(tmpFiles, `src-${counter++}.tmp`);
      fs.writeFileSync(p, contents);
      return p;
    },
    cleanup: async () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpFiles, { recursive: true, force: true });
    },
  };
}

describeStorageDriver('LocalDriver', makeHarness);

describe('LocalDriver specifics', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = makeTmpDir();
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('realpaths a symlinked root and confines keys to the real directory', async () => {
    // Docker symlinks BOTH storage anchors (/app/server/uploads → /app/uploads,
    // /app/server/data → /app/data), so this is the deployed shape, not an edge.
    const realdir = tmp();
    const link = path.join(tmp(), 'uploads-link');
    fs.symlinkSync(realdir, link);

    const driver = new LocalDriver({ id: 'sym', root: link });
    driver.init();
    await driver.put('files/x.bin', Readable.from('sym'));

    const local = driver.getLocalPath('files/x.bin');
    expect(local.startsWith(fs.realpathSync(realdir) + path.sep)).toBe(true);
    expect(fs.readFileSync(local, 'utf8')).toBe('sym');
    expect(() => driver.getLocalPath('../escape')).toThrow(StorageInvalidKeyError);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked directory below the real root instead of writing outside it', async () => {
    const root = tmp();
    const outside = tmp();
    const driver = new LocalDriver({ id: 'nested-symlink', root });
    driver.init();
    fs.symlinkSync(outside, path.join(root, 'files'), 'dir');

    expect(() => driver.getLocalPath('files/escaped.bin')).toThrow(StorageInvalidKeyError);
    await expect(driver.put('files/escaped.bin', Readable.from('secret'))).rejects.toThrow(StorageInvalidKeyError);
    expect(fs.existsSync(path.join(outside, 'escaped.bin'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a dangling symlink below the real root', () => {
    const root = tmp();
    const missingTarget = path.join(tmp(), 'not-created');
    const driver = new LocalDriver({ id: 'dangling-symlink', root });
    driver.init();
    fs.symlinkSync(missingTarget, path.join(root, 'files'), 'dir');

    expect(() => driver.getLocalPath('files/escaped.bin')).toThrow(StorageInvalidKeyError);
  });

  it.skipIf(process.platform === 'win32')('rejects a final symlink for reads, metadata and deletion', async () => {
    const root = tmp();
    const outside = path.join(tmp(), 'outside.bin');
    fs.writeFileSync(outside, 'outside bytes');
    fs.mkdirSync(path.join(root, 'files'));
    fs.symlinkSync(outside, path.join(root, 'files', 'linked.bin'));
    const driver = new LocalDriver({ id: 'final-symlink', root });
    driver.init();

    expect(() => driver.getLocalPath('files/linked.bin')).toThrow(StorageInvalidKeyError);
    await expect(driver.stat('files/linked.bin')).rejects.toThrow(StorageInvalidKeyError);
    await expect(driver.getStream('files/linked.bin')).rejects.toThrow(StorageInvalidKeyError);
    await expect(driver.delete('files/linked.bin')).rejects.toThrow(StorageInvalidKeyError);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes');
  });

  it.skipIf(process.platform === 'win32')('rejects an init prefix that is already an escaping symlink', () => {
    const root = tmp();
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, 'files'), 'dir');
    const driver = new LocalDriver({ id: 'prefix-symlink', root });

    expect(() => driver.init({ ensurePrefixes: ['files'] })).toThrow(StorageInvalidKeyError);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked spool directory', () => {
    const root = tmp();
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, '.tmp'), 'dir');
    const driver = new LocalDriver({ id: 'spool-symlink', root });

    expect(() => driver.init()).toThrow(StorageInvalidKeyError);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked list prefix instead of enumerating outside metadata', async () => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret.bin'), 'outside');
    fs.symlinkSync(outside, path.join(root, 'files'), 'dir');
    const driver = new LocalDriver({ id: 'list-symlink', root });
    driver.init();

    const collect = async () => {
      const rows = [];
      for await (const row of driver.list('files/')) rows.push(row);
      return rows;
    };
    await expect(collect()).rejects.toThrow(StorageInvalidKeyError);
  });

  it.skipIf(process.platform === 'win32')('rejects a LocalTempFile symlink instead of installing it as an object', async () => {
    const root = tmp();
    const outside = path.join(tmp(), 'outside.bin');
    const sourceLink = path.join(tmp(), 'source-link.bin');
    fs.writeFileSync(outside, 'outside bytes');
    fs.symlinkSync(outside, sourceLink);
    const driver = new LocalDriver({ id: 'source-symlink', root });
    driver.init();

    await expect(driver.put('files/object.bin', { tmpPath: sourceLink })).rejects.toThrow(StorageInvalidKeyError);
    expect(fs.existsSync(path.join(root, 'files', 'object.bin'))).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes');
  });

  it.skipIf(process.platform === 'win32')('revalidates the spool capability when it is requested after init', () => {
    const root = tmp();
    const outside = tmp();
    const driver = new LocalDriver({ id: 'spool-recheck', root });
    driver.init();
    fs.rmSync(path.join(root, '.tmp'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.tmp'), 'dir');

    expect(() => driver.getSpoolDir()).toThrow(StorageInvalidKeyError);
  });

  it('cleans aged spool leftovers only at boot, never on reload-style init', () => {
    const driver = new LocalDriver({ id: 'spool', root: tmp() });
    driver.init();
    const stray = path.join(driver.getSpoolDir(), 'leftover.part');
    fs.writeFileSync(stray, 'in-flight upload');
    // Crash leftover: old enough to clear the reap age gate.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stray, old, old);

    driver.init(); // reload(): must NOT delete an in-flight upload's spool file
    expect(fs.existsSync(stray)).toBe(true);

    driver.init({ cleanSpool: true }); // boot: crash leftovers are reclaimed
    expect(fs.existsSync(stray)).toBe(false);
  });

  it('the boot spool sweep spares fresh entries (another process may be mid-upload)', () => {
    const driver = new LocalDriver({ id: 'spool-fresh', root: tmp() });
    driver.init();
    const inflight = path.join(driver.getSpoolDir(), 'inflight.part');
    fs.writeFileSync(inflight, 'spooling right now');

    driver.init({ cleanSpool: true });
    expect(fs.existsSync(inflight)).toBe(true);
  });

  it('creates its root, spool, and category prefix dirs at init', () => {
    const root = path.join(tmp(), 'nested', 'uploads');
    const driver = new LocalDriver({ id: 'pfx', root });
    driver.init({ ensurePrefixes: ['files', 'photos/trek'] });

    expect(fs.statSync(path.join(root, '.tmp')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, 'files')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, 'photos/trek')).isDirectory()).toBe(true);
  });

  it('falls back to copy+unlink when a temp-file rename crosses volumes (EXDEV)', async () => {
    const root = tmp();
    const driver = new LocalDriver({ id: 'exdev', root });
    driver.init();
    const src = path.join(tmp(), 'other-volume.bin');
    fs.writeFileSync(src, 'exdev payload');

    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }),
    );

    await driver.put('files/moved.bin', { tmpPath: src });
    expect(fs.readFileSync(path.join(root, 'files/moved.bin'), 'utf8')).toBe('exdev payload');
    expect(fs.existsSync(src)).toBe(false);
  });

  it('keeps the prior object intact when the EXDEV fallback copy fails', async () => {
    const root = tmp();
    const driver = new LocalDriver({ id: 'exdev-fail', root });
    driver.init();
    await driver.put('files/existing.bin', Readable.from('old payload'));
    const src = path.join(tmp(), 'other-volume.bin');
    fs.writeFileSync(src, 'new payload');

    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }),
    );
    vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (_from, to) => {
      fs.writeFileSync(String(to), 'partial');
      throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    });

    await expect(driver.put('files/existing.bin', { tmpPath: src })).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, 'files', 'existing.bin'), 'utf8')).toBe('old payload');
    expect(fs.existsSync(src)).toBe(true);
  });

  it('commits stream puts via a same-volume spool rename', async () => {
    const root = tmp();
    const driver = new LocalDriver({ id: 'samevol', root });
    driver.init();

    const renameSpy = vi.spyOn(fs.promises, 'rename');
    await driver.put('files/spooled.bin', Readable.from('data'));

    const [from, to] = renameSpy.mock.calls.at(-1)!;
    expect(String(from).startsWith(path.join(fs.realpathSync(root), '.tmp') + path.sep)).toBe(true);
    expect(String(to)).toBe(path.join(fs.realpathSync(root), 'files/spooled.bin'));
  });

  it('lists a missing prefix as empty', async () => {
    const driver = new LocalDriver({ id: 'empty', root: tmp() });
    driver.init();
    const seen: unknown[] = [];
    for await (const stat of driver.list('nope/')) seen.push(stat);
    expect(seen).toEqual([]);
  });
});
