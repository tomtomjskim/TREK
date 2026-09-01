import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: forkMock }));

import { PluginSupervisor, type SupervisorHooks } from '../../../src/nest/plugins/supervisor/plugin-supervisor';
import { pluginRealCodeDir } from '../../../src/nest/plugins/paths';

function child(): EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter } {
  const c = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter };
  c.send = vi.fn();
  c.kill = vi.fn();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

describe('PluginSupervisor spawn provenance boundary', () => {
  beforeEach(() => forkMock.mockReset());

  it('rejects before fork when the runtime provenance guard refuses the resolved origin', async () => {
    const beforeSpawn = vi.fn(() => {
      throw new Error('PLUGIN_CODE_ORIGIN_INVALID');
    });
    const hooks: SupervisorHooks = { beforeSpawn };
    const dispose = vi.fn();
    const supervisor = new PluginSupervisor(() => ({ dispose }) as never, hooks, { activationTimeoutMs: 50 });

    await expect(supervisor.activate('external', new Set())).rejects.toThrow('PLUGIN_CODE_ORIGIN_INVALID');
    expect(beforeSpawn).toHaveBeenCalledTimes(1);
    expect(forkMock).not.toHaveBeenCalled();
    expect((supervisor as unknown as { running: Map<string, unknown> }).running.has('external')).toBe(false);
  });

  it('rechecks provenance on crash respawn and leaves no child after a changed origin is refused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-supervisor-respawn-root-'));
    fs.mkdirSync(path.join(root, 'respawn'), { recursive: true });
    process.env.TREK_PLUGINS_DIR = root;
    let calls = 0;
    const beforeSpawn = vi.fn(() => {
      calls += 1;
      if (calls === 2) throw new Error('PLUGIN_CODE_ORIGIN_INVALID');
      return { codeDir: pluginRealCodeDir('respawn'), permissionArgs: [] };
    });
    const hooks: SupervisorHooks = { beforeSpawn };
    forkMock.mockReturnValue(child());
    const supervisor = new PluginSupervisor(() => ({ dispose: vi.fn() }) as never, hooks, {
      backoffCapMs: 1,
      activationTimeoutMs: 100,
    });
    const activation = supervisor.activate('respawn', new Set());
    activation.catch(() => {});
    const entry = (supervisor as unknown as { running: Map<string, { status: string }> }).running.get('respawn')!;
    entry.status = 'active';
    (supervisor as unknown as { onExit: (entry: unknown, code: number, signal: string | null) => void }).onExit(entry, 1, null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(beforeSpawn).toHaveBeenCalledTimes(2);
      expect(forkMock).toHaveBeenCalledTimes(1);
      expect(entry.status).toBe('error');
    } finally {
      await supervisor.shutdownAll();
      delete process.env.TREK_PLUGINS_DIR;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rechecks the resolved path after preparation and refuses a symlink swap before fork', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-supervisor-root-'));
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-supervisor-first-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-supervisor-second-'));
    const id = 'swap';
    const entry = path.join(root, id);
    fs.mkdirSync(path.join(first, 'server'), { recursive: true });
    fs.mkdirSync(path.join(second, 'server'), { recursive: true });
    fs.symlinkSync(first, entry, 'dir');
    process.env.TREK_PLUGINS_DIR = root;
    const beforeSpawn = vi.fn(() => {
      const resolved = pluginRealCodeDir(id);
      fs.unlinkSync(entry);
      fs.symlinkSync(second, entry, 'dir');
      return { codeDir: resolved, permissionArgs: [] };
    });
    const supervisor = new PluginSupervisor(() => ({ dispose: vi.fn() }) as never, { beforeSpawn }, { activationTimeoutMs: 50 });

    try {
      await expect(supervisor.activate(id, new Set())).rejects.toThrow(/changed|origin|resolve/i);
      expect(forkMock).not.toHaveBeenCalled();
    } finally {
      await supervisor.shutdownAll();
      delete process.env.TREK_PLUGINS_DIR;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});
