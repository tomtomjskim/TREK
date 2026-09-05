import {
  confirmSessionRevocationStoreHealth,
  isSessionIdRevoked,
  isSessionRevoked,
  resetSessionRevocationStateForTests,
  revokeSessionToken,
  sessionIdForToken,
} from '../../../src/nest/auth/session-revocation';
import { RestoreInProgressError } from '../../../src/nest/backup/restore-quiescence';

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'session-revocation-test-secret',
}));

const SECRET = 'session-revocation-test-secret';

describe('session revocation lineage', () => {
  let db: Database.Database;
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetSessionRevocationStateForTests();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE jsnetworkcorp_auth_session_revocations (
        session_key TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterEach(() => {
    resetSessionRevocationStateForTests();
    db.close();
    for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('AUTH-SESSION-001: preserves a valid sid and deterministically derives one for legacy tokens', () => {
    const explicit = jwt.sign({ id: 1, sid: 'session-one' }, SECRET, { algorithm: 'HS256' });
    const legacy = jwt.sign({ id: 1 }, SECRET, { algorithm: 'HS256' });

    expect(sessionIdForToken(explicit)).toBe('session-one');
    expect(sessionIdForToken(legacy)).toMatch(/^legacy:[a-f0-9]{64}$/);
    expect(sessionIdForToken(legacy)).toBe(sessionIdForToken(legacy));
  });

  it('AUTH-SESSION-002: logout revokes an expired signed session but rejects tampered and purpose tokens', () => {
    const expired = jwt.sign({ id: 7, sid: 'expired-session', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, {
      algorithm: 'HS256',
    });
    const purpose = jwt.sign({ id: 7, sid: 'mfa-session', purpose: 'mfa_login' }, SECRET, { algorithm: 'HS256' });

    expect(revokeSessionToken(db, expired)).toEqual({ userId: 7, sessionId: 'expired-session' });
    expect(isSessionRevoked(db, expired)).toBe(true);
    expect(revokeSessionToken(db, purpose)).toBeNull();
    expect(revokeSessionToken(db, `${expired}tampered`)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM jsnetworkcorp_auth_session_revocations').get()).toEqual({
      count: 1,
    });
  });

  it('AUTH-SESSION-003: revocation is scoped to one session lineage, not every device for the user', () => {
    const first = jwt.sign({ id: 9, sid: 'first-device' }, SECRET, { algorithm: 'HS256' });
    const second = jwt.sign({ id: 9, sid: 'second-device' }, SECRET, { algorithm: 'HS256' });

    revokeSessionToken(db, first);

    expect(isSessionRevoked(db, first)).toBe(true);
    expect(isSessionRevoked(db, second)).toBe(false);
  });

  it('AUTH-SESSION-004: a failed tombstone write closes every derived check fail-closed in this process', () => {
    const token = jwt.sign({ id: 9, sid: 'write-failure' }, SECRET, { algorithm: 'HS256' });
    const failingDb = {
      prepare: (sql: string) => ({
        get: () => undefined,
        run: () => {
          if (sql.startsWith('INSERT')) throw new Error('disk is read-only');
        },
      }),
    } as unknown as Database.Database;

    expect(() => revokeSessionToken(failingDb, token)).toThrow('disk is read-only');
    expect(isSessionIdRevoked(db, 'write-failure')).toBe(true);
    expect(isSessionIdRevoked(db, 'unrelated-derived-session')).toBe(true);

    confirmSessionRevocationStoreHealth(db);
    expect(isSessionIdRevoked(db, 'unrelated-derived-session')).toBe(false);
    expect(isSessionIdRevoked(db, 'write-failure')).toBe(true);
  });

  it('AUTH-SESSION-005: an expected restore gate denial does not poison later session checks', () => {
    const gatedDb = {
      prepare: () => {
        throw new RestoreInProgressError();
      },
    } as unknown as Database.Database;

    expect(isSessionIdRevoked(gatedDb, 'during-restore')).toBe(true);
    expect(isSessionIdRevoked(db, 'after-restore')).toBe(false);
  });

  it('AUTH-SESSION-007: a generic read failure closes the latch until health is confirmed', () => {
    const brokenDb = {
      prepare: (sql: string) => ({
        get: () => {
          if (sql.startsWith('SELECT 1 FROM jsnetworkcorp_auth_session_revocations')) {
            throw new Error('database is busy');
          }
          return undefined;
        },
      }),
    } as unknown as Database.Database;

    expect(isSessionIdRevoked(brokenDb, 'stalled-session')).toBe(true);
    expect(isSessionIdRevoked(db, 'after-failure')).toBe(true);

    confirmSessionRevocationStoreHealth(db);
    expect(isSessionIdRevoked(db, 'after-failure')).toBe(false);
  });

  it('AUTH-SESSION-006: replays a failed SQLite tombstone durably after process restart', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-session-revocation-'));
    tempDirs.push(tempDir);
    const pendingDir = path.join(tempDir, 'pending');
    const token = jwt.sign({ id: 9, sid: 'restart-safe-session' }, SECRET, { algorithm: 'HS256' });
    const failingDb = {
      prepare: (sql: string) => ({
        get: () => undefined,
        run: () => {
          if (sql.startsWith('INSERT')) throw new Error('disk is read-only');
        },
      }),
    } as unknown as Database.Database;

    expect(() => revokeSessionToken(failingDb, token, { pendingDir })).toThrow('disk is read-only');
    expect(fs.readdirSync(pendingDir)).toHaveLength(1);

    // Simulate a fresh process: the in-memory emergency tombstone is gone, but
    // startup must replay the durable pending record before auth can reopen.
    resetSessionRevocationStateForTests();
    confirmSessionRevocationStoreHealth(db, { pendingDir });

    expect(fs.readdirSync(pendingDir)).toEqual([]);
    expect(isSessionIdRevoked(db, 'restart-safe-session')).toBe(true);
  });
});
