import { JWT_SECRET, updateJwtSecret } from '../../config';
import { invalidateMcpSessions } from '../../mcp';
import { revokeAllSockets } from '../realtime/ws-state';
import { clearEphemeralTokens } from './ephemeral-tokens';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../../data');

export interface SessionAuthorityRotationOptions {
  /** Test/restore seam. Production callers use the server data directory. */
  readonly dataDir?: string;
}

export interface SessionAuthorityRotationResult {
  readonly error?: string;
  readonly status?: number;
}

export interface SessionAuthorityCheckpoint {
  restore(): void;
}

/** Capture the current live binding without exposing the secret to restore callers. */
export function checkpointSessionAuthority(): SessionAuthorityCheckpoint {
  const secret = JWT_SECRET;
  return {
    restore: () => updateJwtSecret(secret),
  };
}

/**
 * Rotate the process-wide session authority only after its durable file is safely
 * committed. The temp is created beside `.jwt_secret`, so rename is atomic and
 * cannot cross filesystems. No live binding or session invalidator runs on any
 * durable-write failure.
 */
export function rotateSessionAuthority(options: SessionAuthorityRotationOptions = {}): SessionAuthorityRotationResult {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const secretFile = path.join(dataDir, '.jwt_secret');
  const newSecret = crypto.randomBytes(32).toString('hex');
  const tempFile = path.join(dataDir, `.jwt_secret.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let tempCreated = false;
  let syncFd: number | null = null;
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    // writeFileSync can leave a partial file before surfacing an I/O error; mark
    // the exclusive temp as owned before attempting the write so finally cleans it.
    tempCreated = true;
    fs.writeFileSync(tempFile, newSecret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(tempFile, 0o600);
    syncFd = fs.openSync(tempFile, 'r');
    fs.fsyncSync(syncFd);
    fs.closeSync(syncFd);
    syncFd = null;
    fs.renameSync(tempFile, secretFile);
    tempCreated = false;
    // Persist the directory entry as well as the file contents. Without this,
    // a power loss after a successful response could resurrect the old secret.
    syncFd = fs.openSync(dataDir, 'r');
    fs.fsyncSync(syncFd);
    fs.closeSync(syncFd);
    syncFd = null;
  } catch {
    if (syncFd !== null) {
      try {
        fs.closeSync(syncFd);
      } catch {
        /* preserve the fail-closed result */
      }
    }
    if (tempCreated) {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        /* preserve the fail-closed result */
      }
    }
    return { error: 'Failed to persist new JWT secret to disk', status: 500 };
  }

  updateJwtSecret(newSecret);
  clearEphemeralTokens();
  invalidateMcpSessions();
  revokeAllSockets();
  return {};
}
