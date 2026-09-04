/**
 * Dev-link (#plugins, developer experience): register a plugin from a LOCAL build
 * dir and hot-reload it against real data. Proves the link symlinks the source and
 * registers it INACTIVE as `local:link`, the gates (dev-only flag, absolute path,
 * built artifact, native binaries, don't-clobber-a-real-plugin, reload only a link),
 * and a full link -> activate -> reload loop through a real isolated child.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE plugins (
    id TEXT PRIMARY KEY, name TEXT, description TEXT, type TEXT, icon TEXT, version TEXT, api_version INTEGER,
    min_trek_version TEXT, trek_range TEXT, permissions TEXT DEFAULT '[]', capabilities TEXT DEFAULT '{}', dependencies TEXT DEFAULT '{}',
    operator_egress INTEGER DEFAULT 0, granted_permissions TEXT DEFAULT '', status TEXT, enabled INTEGER DEFAULT 0, config TEXT DEFAULT '{}',
    source_repo TEXT, source_commit TEXT, sha256 TEXT, author_pubkey TEXT, reviewed_at TEXT, last_error TEXT, updated_at TEXT,
    update_block_code TEXT, update_block_detail TEXT, update_block_version TEXT);
    CREATE TABLE plugin_error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, level TEXT, message TEXT, ts TEXT);
    CREATE TABLE plugin_settings_fields (plugin_id TEXT, field_key TEXT, label TEXT, input_type TEXT, placeholder TEXT, hint TEXT, required INTEGER, secret INTEGER, scope TEXT, options TEXT, oauth_config TEXT, default_value TEXT, sort_order INTEGER);
    CREATE TABLE settings (user_id INTEGER, key TEXT, value TEXT);
    CREATE TABLE plugin_entity_metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, entity_type TEXT, entity_id INTEGER, key TEXT, value TEXT, updated_at TEXT);
    CREATE TABLE addons (id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0);`);
  return { testDb: db };
});
vi.mock('../../../src/db/database', () => ({ db: testDb, canAccessTrip: () => undefined }));
import { db as dbConn } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));

import { PluginRuntimeService } from '../../../src/nest/plugins/plugin-runtime.service';
import { createPluginRuntime } from '../../helpers/plugin-host';

let codeRoot: string;
let dataRoot: string;
let srcRoot: string; // the "developer's" source lives OUTSIDE the plugins volume
let runtime: PluginRuntimeService;

const ROUTE = (v: string) =>
  `module.exports = { routes: [{ method: 'GET', path: '/v', auth: false, async handler() { return { status: 200, body: JSON.stringify({ v: ${v} }) }; } }] };`;

function writeSource(id: string, opts: { index?: string; native?: boolean; noBuild?: boolean; trek?: string } = {}): string {
  const dir = path.join(srcRoot, id);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  // dev-link requires a `trek` range like any other install front door; `opts.trek`
  // overrides it to exercise the gate.
  fs.writeFileSync(path.join(dir, 'trek-plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', type: 'integration', permissions: [], trek: opts.trek ?? '>=3.0.0' }));
  if (!opts.noBuild) fs.writeFileSync(path.join(dir, 'server', 'index.js'), opts.index ?? 'module.exports = {};');
  if (opts.native) fs.writeFileSync(path.join(dir, 'server', 'addon.node'), '\0');
  return dir;
}

beforeAll(() => {
  codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-link-code-'));
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-link-data-'));
  srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-link-src-'));
  process.env.TREK_PLUGINS_DIR = codeRoot;
  process.env.TREK_PLUGINS_DATA_DIR = dataRoot;
  process.env.TREK_PLUGINS_ENABLED = 'true';
  process.env.TREK_PLUGINS_DEV_LINK = '1';
  runtime = createPluginRuntime(new DatabaseService(dbConn));
});

afterAll(async () => {
  await runtime?.onModuleDestroy();
  for (const r of [codeRoot, dataRoot, srcRoot]) fs.rmSync(r, { recursive: true, force: true });
  delete process.env.TREK_PLUGINS_DIR;
  delete process.env.TREK_PLUGINS_DATA_DIR;
  delete process.env.TREK_PLUGINS_ENABLED;
  delete process.env.TREK_PLUGINS_DEV_LINK;
});

describe('PluginRuntimeService dev-link', () => {
  it('links a local dir: symlinks the source in and registers it inactive as local:link', async () => {
    const dir = writeSource('linkplug');
    const res = await runtime.link(dir);
    expect(res).toMatchObject({ id: 'linkplug', version: '1.0.0', replaced: false });

    const dest = path.join(codeRoot, 'linkplug');
    // a link (POSIX symlink or Windows junction) that resolves to the source build
    expect(fs.existsSync(path.join(dest, 'server', 'index.js'))).toBe(true);
    expect(fs.realpathSync(dest)).toBe(fs.realpathSync(dir));

    const row = testDb.prepare("SELECT source_repo, status, enabled FROM plugins WHERE id = 'linkplug'").get() as {
      source_repo: string; status: string; enabled: number;
    };
    expect(row).toMatchObject({ source_repo: 'local:link', status: 'inactive', enabled: 0 });
  });

  it('re-linking an existing link updates it in place (replaced=true)', async () => {
    const dir = writeSource('linkplug');
    const res = await runtime.link(dir);
    expect(res.replaced).toBe(true);
  });

  it('rejects a non-absolute path, a missing manifest, a missing build, and native binaries', async () => {
    await expect(runtime.link('relative/dir')).rejects.toThrow(/absolute/);
    await expect(runtime.link(path.join(srcRoot, 'ghost-dir'))).rejects.toThrow(/trek-plugin\.json/);
    await expect(runtime.link(writeSource('nobuild', { noBuild: true }))).rejects.toThrow(/server\/index\.js|build/);
    await expect(runtime.link(writeSource('nativeplug', { native: true }))).rejects.toThrow(/native/);
  });

  it('rejects a local dir whose TREK range this server does not satisfy', async () => {
    // Dev-link is the third install front door, and it hands TREK code to RUN against real
    // data — the fact that the author is standing right there is not a reason to skip the
    // check that the code supports the host it is about to be spawned on.
    process.env.APP_VERSION = '3.3.0';
    try {
      await expect(runtime.link(writeSource('oldplug', { trek: '>=2.0.0 <3.0.0' }))).rejects.toMatchObject({
        code: 'TREK_VERSION_INCOMPATIBLE',
      });
      await expect(runtime.link(writeSource('rangeless', { trek: '' }))).rejects.toThrow(/missing "trek"/);
    } finally {
      delete process.env.APP_VERSION;
    }
  });

  it('refuses to clobber a real (non-linked) installed plugin of the same id', async () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, version, status, source_repo) VALUES ('installed','X','integration','1.0.0','inactive','local:upload')").run();
    await expect(runtime.link(writeSource('installed'))).rejects.toThrow(/already installed/);
  });

  it('is disabled unless TREK_PLUGINS_DEV_LINK=1', async () => {
    delete process.env.TREK_PLUGINS_DEV_LINK;
    try {
      await expect(runtime.link(writeSource('gated'))).rejects.toThrow(/disabled/);
      await expect(runtime.reload('linkplug')).rejects.toThrow(/disabled/);
    } finally {
      process.env.TREK_PLUGINS_DEV_LINK = '1';
    }
  });

  it.skipIf(process.platform === 'win32')('rejects an external symlink without managed dev-link provenance before enabling it', async () => {
    const id = 'unmanaged-external';
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-unmanaged-'));
    const dest = path.join(codeRoot, id);
    fs.mkdirSync(path.join(externalDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'server', 'index.js'), 'module.exports = {};');
    fs.symlinkSync(externalDir, dest, 'dir');
    testDb.prepare(
      "INSERT INTO plugins (id, name, type, version, api_version, trek_range, permissions, granted_permissions, config, source_repo, status, enabled) VALUES (?, 'X', 'integration', '1.0.0', 1, '>=3.0.0', '[]', '', '{}', 'local:upload', 'inactive', 0)",
    ).run(id);

    try {
      await expect(runtime.activate(id)).rejects.toMatchObject({ code: 'PLUGIN_CODE_ORIGIN_INVALID' });
      expect(runtime.isActive(id)).toBe(false);
      expect(testDb.prepare('SELECT enabled, status FROM plugins WHERE id = ?').get(id)).toMatchObject({ enabled: 0, status: 'inactive' });
    } finally {
      testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id);
      fs.rmSync(dest, { force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a stale managed symlink when dev-link is off before enabling it', async () => {
    const id = 'stale-managed';
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-stale-'));
    const dest = path.join(codeRoot, id);
    fs.mkdirSync(path.join(externalDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'server', 'index.js'), 'module.exports = {};');
    fs.symlinkSync(externalDir, dest, 'dir');
    testDb.prepare(
      "INSERT INTO plugins (id, name, type, version, api_version, trek_range, permissions, granted_permissions, config, source_repo, status, enabled) VALUES (?, 'X', 'integration', '1.0.0', 1, '>=3.0.0', '[]', '', '{}', 'local:link', 'inactive', 0)",
    ).run(id);

    delete process.env.TREK_PLUGINS_DEV_LINK;
    try {
      await expect(runtime.activate(id)).rejects.toMatchObject({ code: 'PLUGIN_CODE_ORIGIN_INVALID' });
      expect(runtime.isActive(id)).toBe(false);
      expect(testDb.prepare('SELECT enabled, status FROM plugins WHERE id = ?').get(id)).toMatchObject({ enabled: 0, status: 'inactive' });
    } finally {
      process.env.TREK_PLUGINS_DEV_LINK = '1';
      testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id);
      fs.rmSync(dest, { force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('rolls back enabled, status, and grants when supervisor spawn fails', async () => {
    const id = 'spawn-fails';
    fs.mkdirSync(path.join(codeRoot, id), { recursive: true });
    testDb.prepare(
      "INSERT INTO plugins (id, name, type, version, api_version, trek_range, permissions, granted_permissions, config, source_repo, status, enabled) VALUES (?, 'X', 'integration', '1.0.0', 1, '>=3.0.0', '[]', '[\"old\"]', '{}', 'local:upload', 'active', 0)",
    ).run(id);
    const supervisor = (runtime as unknown as { supervisor: { activate: ReturnType<typeof vi.spyOn> } }).supervisor;
    const activation = vi.spyOn(supervisor, 'activate').mockRejectedValueOnce(new Error('spawn failed'));

    try {
      await expect(runtime.activate(id)).rejects.toThrow('spawn failed');
      expect(testDb.prepare('SELECT enabled, status, granted_permissions FROM plugins WHERE id = ?').get(id)).toMatchObject({
        enabled: 0,
        status: 'inactive',
        granted_permissions: '["old"]',
      });
    } finally {
      activation.mockRestore();
      testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id);
      fs.rmSync(path.join(codeRoot, id), { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('blocks an unmanaged external origin during crash respawn after a symlink swap', async () => {
    const id = 'respawn-origin';
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-respawn-external-'));
    const dest = path.join(codeRoot, id);
    fs.mkdirSync(path.join(dest, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'server', 'index.js'), "module.exports = { async onLoad() { setTimeout(() => process.exit(42), 500); } };");
    fs.mkdirSync(path.join(externalDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'server', 'index.js'), 'module.exports = {};');
    testDb.prepare(
      "INSERT INTO plugins (id, name, type, version, api_version, trek_range, permissions, granted_permissions, config, source_repo, status, enabled) VALUES (?, 'X', 'integration', '1.0.0', 1, '>=3.0.0', '[]', '', '{}', 'local:upload', 'inactive', 0)",
    ).run(id);

    try {
      await runtime.activate(id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.symlinkSync(externalDir, dest, 'dir');
      for (let i = 0; i < 40; i++) {
        const row = testDb.prepare('SELECT enabled, status FROM plugins WHERE id = ?').get(id) as { enabled: number; status: string };
        if (row.enabled === 0 && row.status === 'inactive') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(testDb.prepare('SELECT enabled, status FROM plugins WHERE id = ?').get(id)).toMatchObject({ enabled: 0, status: 'inactive' });
      expect(runtime.isActive(id)).toBe(false);
    } finally {
      await runtime.deactivate(id).catch(() => {});
      testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('rolls back dependencies newly enabled for a target whose spawn fails', async () => {
    const dependency = 'rollback-dep';
    const target = 'rollback-target';
    fs.mkdirSync(path.join(codeRoot, dependency), { recursive: true });
    fs.mkdirSync(path.join(codeRoot, target), { recursive: true });
    testDb.prepare(
      "INSERT INTO plugins (id, name, type, version, api_version, trek_range, permissions, granted_permissions, config, dependencies, source_repo, status, enabled) VALUES (?, 'D', 'integration', '1.0.0', 1, '>=3.0.0', '[]', '', '{}', '{}', 'local:upload', 'inactive', 0)",
    ).run(dependency);
    testDb.prepare(
      "INSERT INTO plugins (id, name, type, version, api_version, trek_range, permissions, granted_permissions, config, dependencies, source_repo, status, enabled) VALUES (?, 'T', 'integration', '1.0.0', 1, '>=3.0.0', '[]', '', '{}', ?, 'local:upload', 'inactive', 0)",
    ).run(target, JSON.stringify({ requiredAddons: [], pluginDependencies: [{ id: dependency, version: '>=1.0.0' }] }));
    const supervisor = (runtime as unknown as { supervisor: { activate: ReturnType<typeof vi.spyOn> } }).supervisor;
    const activation = vi.spyOn(supervisor, 'activate').mockImplementation(async (id: string) => {
      if (id === target) throw new Error('target spawn failed');
    });

    try {
      await expect(runtime.activate(target)).rejects.toThrow('target spawn failed');
      expect(testDb.prepare('SELECT enabled, status, granted_permissions FROM plugins WHERE id = ?').get(dependency)).toMatchObject({
        enabled: 0,
        status: 'inactive',
        granted_permissions: '',
      });
    } finally {
      activation.mockRestore();
      testDb.prepare('DELETE FROM plugins WHERE id IN (?, ?)').run(dependency, target);
      fs.rmSync(path.join(codeRoot, dependency), { recursive: true, force: true });
      fs.rmSync(path.join(codeRoot, target), { recursive: true, force: true });
    }
  });

  it('reload rejects an unknown or non-linked plugin', async () => {
    await expect(runtime.reload('ghost')).rejects.toThrow(/not found/);
    await expect(runtime.reload('installed')).rejects.toThrow(/not dev-linked/);
  });

  it('links, activates through a real isolated child, and reload() re-forks it (the hot-reload primitive)', async () => {
    const dir = writeSource('live', { index: ROUTE('1') });
    await runtime.link(dir);
    await runtime.activate('live');
    expect(runtime.isActive('live')).toBe(true);

    const before = (await runtime.invoke('live', 'invoke.route', { routeId: 0, req: {} })) as { body: string };
    expect(JSON.parse(before.body).v).toBe(1);

    await runtime.reload('live'); // deactivate -> activate, same grants, no re-consent
    expect(runtime.isActive('live')).toBe(true);

    const after = (await runtime.invoke('live', 'invoke.route', { routeId: 0, req: {} })) as { body: string };
    expect(JSON.parse(after.body).v).toBe(1);

    await runtime.deactivate('live').catch(() => {});
  });
});
