/**
 * Small pure helpers of the plugin module (#plugins): permission recognition and
 * the code/data path resolution (both the env-override and default branches).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isKnownPermission, METHOD_PERMISSION, KNOWN_METHODS, HOOK_PERMISSION } from '../../../src/nest/plugins/protocol/envelope';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginsCodeRoot, pluginsDataRoot, pluginCodeDir, pluginDataDir, pluginDbFile, resolveChildEntry, serverCodeRoot, pluginPermissionArgs, pluginRealCodeDir, pluginCodeDirIsExternal, ensurePluginModuleType } from '../../../src/nest/plugins/paths';

afterEach(() => {
  delete process.env.TREK_PLUGINS_DIR;
  delete process.env.TREK_PLUGINS_DATA_DIR;
});

describe('envelope helpers', () => {
  it('recognises known permissions, http:outbound:<host>, and rejects unknown', () => {
    expect(isKnownPermission('db:own')).toBe(true);
    expect(isKnownPermission('http:outbound')).toBe(true);
    expect(isKnownPermission('http:outbound:api.example.com')).toBe(true);
    expect(isKnownPermission('fs:read')).toBe(false);
    expect(isKnownPermission('')).toBe(false);
  });

  // The compile side of this is `as const satisfies Record<KnownMethod, KnownPermission>`
  // on METHOD_PERMISSION. These are the runtime mirror, and they also cover what the type
  // system cannot: isKnownPermission's http:outbound: prefix branch.
  it('every known method maps to a permission the host actually knows', () => {
    for (const m of KNOWN_METHODS) {
      const perm = METHOD_PERMISSION[m];
      expect(isKnownPermission(perm), `${m} -> ${perm}`).toBe(true);
    }
  });

  it('every hook permission is a known permission', () => {
    for (const [hook, perm] of Object.entries(HOOK_PERMISSION)) {
      expect(isKnownPermission(perm), `${hook} -> ${perm}`).toBe(true);
    }
  });
});

describe('paths', () => {
  it('uses the env override when set', () => {
    process.env.TREK_PLUGINS_DIR = '/custom/code';
    process.env.TREK_PLUGINS_DATA_DIR = '/custom/data';
    expect(pluginsCodeRoot()).toBe('/custom/code');
    expect(pluginsDataRoot()).toBe('/custom/data');
    expect(pluginCodeDir('x')).toBe(path.join('/custom/code', 'x'));
    expect(path.basename(pluginDbFile('x'))).toBe('plugin.db');
  });

  it('falls back to the data-dir default when unset', () => {
    expect(pluginsCodeRoot()).toContain('plugins');
    expect(pluginsDataRoot()).toContain('plugins-data');
  });

  it('resolves a child entry with fork args', () => {
    const r = resolveChildEntry();
    expect(r.entry).toMatch(/plugin-host-entry\.(js|ts)$/);
    expect(Array.isArray(r.execArgv)).toBe(true);
    expect(typeof r.jsMode).toBe('boolean');
  });

  it('builds scoped OS-permission flags for a plugin child (default on)', () => {
    delete process.env.TREK_PLUGIN_PERMISSIONS;
    const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-perm-code-'));
    try {
      process.env.TREK_PLUGINS_DIR = codeRoot;
      fs.mkdirSync(path.join(codeRoot, 'flight-tracker'), { recursive: true });
      const args = pluginPermissionArgs('flight-tracker');
      expect(args).toContain('--permission');
      // read is scoped to the compiled server dir + this plugin's own code dir…
      expect(args.some((a) => a === `--allow-fs-read=${serverCodeRoot()}`)).toBe(true);
      expect(args.some((a) => a === `--allow-fs-read=${path.join(codeRoot, 'flight-tracker')}`)).toBe(true);
      // …and never grants fs-write / child_process / the data root.
      expect(args.some((a) => a.startsWith('--allow-fs-write'))).toBe(false);
      expect(args.some((a) => a.startsWith('--allow-child-process'))).toBe(false);
      expect(serverCodeRoot()).not.toContain(`${require('node:path').sep}data`);
    } finally {
      fs.rmSync(codeRoot, { recursive: true, force: true });
    }
  });

  it('lets an operator opt out of the permission model', () => {
    process.env.TREK_PLUGIN_PERMISSIONS = 'off';
    const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-perm-off-code-'));
    try {
      process.env.TREK_PLUGINS_DIR = codeRoot;
      fs.mkdirSync(path.join(codeRoot, 'flight-tracker'), { recursive: true });
      expect(pluginPermissionArgs('flight-tracker')).toEqual([]);
    } finally {
      fs.rmSync(codeRoot, { recursive: true, force: true });
      delete process.env.TREK_PLUGIN_PERMISSIONS;
    }
  });

  it('rejects a plugin code path that cannot be resolved', () => {
    expect(() => pluginRealCodeDir('does-not-exist')).toThrow(/cannot resolve|realpath/i);
  });

  it.skipIf(process.platform === 'win32')('refuses permission grants for an external symlink when dev-link is off', () => {
    const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-code-'));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-external-'));
    try {
      process.env.TREK_PLUGINS_DIR = codeRoot;
      delete process.env.TREK_PLUGINS_DEV_LINK;
      fs.symlinkSync(externalRoot, path.join(codeRoot, 'external'), 'dir');

      expect(() => pluginPermissionArgs('external')).toThrow(/outside|dev-link|external/i);
    } finally {
      fs.rmSync(codeRoot, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('uses the real configured root when the plugin root itself is a symlink', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-real-root-'));
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-alias-root-'));
    const aliasRoot = path.join(aliasParent, 'plugins');
    try {
      fs.symlinkSync(realRoot, aliasRoot, 'dir');
      fs.mkdirSync(path.join(realRoot, 'inside'), { recursive: true });
      process.env.TREK_PLUGINS_DIR = aliasRoot;
      delete process.env.TREK_PLUGINS_DEV_LINK;
      expect(pluginCodeDirIsExternal('inside')).toBe(false);
      expect(pluginPermissionArgs('inside')).toContain(`--allow-fs-read=${path.join(realRoot, 'inside')}`);
    } finally {
      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('rejects permission args when the configured plugin root realpath fails', () => {
    const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-path-root-fail-'));
    const pluginDir = path.join(codeRoot, 'inside');
    fs.mkdirSync(pluginDir, { recursive: true });
    process.env.TREK_PLUGINS_DIR = codeRoot;
    const originalRealpathSync = fs.realpathSync;
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(codeRoot)) throw new Error('root realpath denied');
      return originalRealpathSync(target);
    });
    try {
      expect(() => pluginPermissionArgs('inside')).toThrow(/root realpath|origin|resolve/i);
    } finally {
      realpath.mockRestore();
      fs.rmSync(codeRoot, { recursive: true, force: true });
    }
  });

  it('ensurePluginModuleType writes a commonjs package.json only when absent', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-mod-'));
    try {
      ensurePluginModuleType(dir);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
      // an author-provided package.json is left untouched
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      ensurePluginModuleType(dir);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'module' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The id these helpers get comes off a route parameter — POST
 * /api/admin/plugins/:id/uninstall walks it into pluginCodeDir and hands the result
 * to a recursive remove. Express decodes %2F only AFTER routing, so a traversal
 * still matches the route and arrives here decoded.
 */
describe('plugin id containment', () => {
  const traversals = [
    '../../uploads',
    '../..',
    '..',
    '.',
    'a/b',
    'a\b',
    'C:\Windows',
    '.hidden',
    '',
  ];

  it('refuses any id that could point outside its parent', () => {
    for (const id of traversals) {
      expect(() => pluginCodeDir(id), id).toThrow(/invalid plugin id/);
      expect(() => pluginDataDir(id), id).toThrow(/invalid plugin id/);
    }
  });

  it('still accepts the ids plugins actually use', () => {
    for (const id of ['x', 'a1', '001', 'flight-tracker', 'Bad-Id', 'trip.todos', 'koffi_and_friends']) {
      expect(path.basename(pluginCodeDir(id))).toBe(id);
      expect(path.basename(pluginDataDir(id))).toBe(id);
    }
  });

  it('keeps every accepted id inside the plugin roots', () => {
    for (const id of ['x', 'flight-tracker', 'a.b', 'a-b_c']) {
      expect(pluginCodeDir(id).startsWith(pluginsCodeRoot() + path.sep)).toBe(true);
      expect(pluginDataDir(id).startsWith(pluginsDataRoot() + path.sep)).toBe(true);
    }
  });
});
