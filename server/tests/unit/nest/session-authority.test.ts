import { rotateSessionAuthority } from '../../../src/nest/auth/session-authority';
import * as sessionAuthorityModule from '../../../src/nest/auth/session-authority';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateJwtSecret = vi.hoisted(() => vi.fn());
const clearEphemeralTokens = vi.hoisted(() => vi.fn());
const invalidateMcpSessions = vi.hoisted(() => vi.fn());
const revokeAllSockets = vi.hoisted(() => vi.fn());

vi.mock('../../../src/config', () => ({ JWT_SECRET: 'existing-secret', updateJwtSecret }));
vi.mock('../../../src/nest/auth/ephemeral-tokens', () => ({ clearEphemeralTokens }));
vi.mock('../../../src/mcp', () => ({ invalidateMcpSessions }));
vi.mock('../../../src/nest/realtime/ws-state', () => ({ revokeAllSockets }));

describe('session authority rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a fresh 32-byte secret with mode 0600, then rotates all live authorities', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-session-authority-'));
    const fsync = vi.spyOn(fs, 'fsyncSync');
    try {
      expect(rotateSessionAuthority({ dataDir })).toEqual({});

      const secretFile = path.join(dataDir, '.jwt_secret');
      const secret = fs.readFileSync(secretFile, 'utf8');
      expect(Buffer.from(secret, 'hex')).toHaveLength(32);
      expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(fsync).toHaveBeenCalledTimes(2);
      expect(updateJwtSecret).toHaveBeenCalledWith(secret);
      expect(clearEphemeralTokens).toHaveBeenCalledOnce();
      expect(invalidateMcpSessions).toHaveBeenCalledOnce();
      expect(revokeAllSockets).toHaveBeenCalledOnce();
      expect(updateJwtSecret.mock.invocationCallOrder[0]).toBeLessThan(
        clearEphemeralTokens.mock.invocationCallOrder[0],
      );
      expect(clearEphemeralTokens.mock.invocationCallOrder[0]).toBeLessThan(
        invalidateMcpSessions.mock.invocationCallOrder[0],
      );
      expect(invalidateMcpSessions.mock.invocationCallOrder[0]).toBeLessThan(
        revokeAllSockets.mock.invocationCallOrder[0],
      );
    } finally {
      fsync.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('captures the live JWT authority so a failed restore can put it back', () => {
    const checkpointSessionAuthority = (
      sessionAuthorityModule as typeof sessionAuthorityModule & {
        checkpointSessionAuthority?: () => { restore(): void };
      }
    ).checkpointSessionAuthority;

    expect(checkpointSessionAuthority).toBeTypeOf('function');
    const checkpoint = checkpointSessionAuthority!();

    updateJwtSecret('rotated-secret');
    checkpoint.restore();

    expect(updateJwtSecret).toHaveBeenLastCalledWith('existing-secret');
  });

  it('does not touch live authority or invalidators when the durable write cannot start', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-session-authority-'));
    const dataDir = path.join(root, 'not-a-directory');
    fs.writeFileSync(dataDir, 'blocker');
    try {
      expect(rotateSessionAuthority({ dataDir })).toEqual({
        error: 'Failed to persist new JWT secret to disk',
        status: 500,
      });
      expect(updateJwtSecret).not.toHaveBeenCalled();
      expect(clearEphemeralTokens).not.toHaveBeenCalled();
      expect(invalidateMcpSessions).not.toHaveBeenCalled();
      expect(revokeAllSockets).not.toHaveBeenCalled();
      expect(fs.readdirSync(root).filter((name) => name.includes('.jwt_secret.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans a temporary secret when writing it fails before the atomic rename', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-session-authority-'));
    const originalWriteFileSync = fs.writeFileSync;
    const writeFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).includes('.jwt_secret.tmp')) throw new Error('disk full');
      return originalWriteFileSync.call(fs, file, data, options as never);
    });
    try {
      expect(rotateSessionAuthority({ dataDir })).toEqual({
        error: 'Failed to persist new JWT secret to disk',
        status: 500,
      });
      expect(fs.readdirSync(dataDir).filter((name) => name.includes('.jwt_secret.tmp'))).toEqual([]);
      expect(updateJwtSecret).not.toHaveBeenCalled();
      expect(clearEphemeralTokens).not.toHaveBeenCalled();
      expect(invalidateMcpSessions).not.toHaveBeenCalled();
      expect(revokeAllSockets).not.toHaveBeenCalled();
    } finally {
      writeFileSync.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('still closes the synced secret file when the final directory fsync fails', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-session-authority-'));
    const originalCloseSync = fs.closeSync;
    const originalFsyncSync = fs.fsyncSync;
    const closeSync = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => originalCloseSync.call(fs, fd as never));
    const fsyncSync = vi
      .spyOn(fs, 'fsyncSync')
      .mockImplementationOnce((fd) => originalFsyncSync.call(fs, fd as never))
      .mockImplementationOnce(() => {
        throw new Error('directory fsync failed');
      });
    try {
      expect(rotateSessionAuthority({ dataDir })).toEqual({
        error: 'Failed to persist new JWT secret to disk',
        status: 500,
      });
      expect(fsyncSync).toHaveBeenCalledTimes(2);
      expect(closeSync).toHaveBeenCalledTimes(2);
      expect(updateJwtSecret).not.toHaveBeenCalled();
      expect(clearEphemeralTokens).not.toHaveBeenCalled();
      expect(invalidateMcpSessions).not.toHaveBeenCalled();
      expect(revokeAllSockets).not.toHaveBeenCalled();
    } finally {
      closeSync.mockRestore();
      fsyncSync.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
