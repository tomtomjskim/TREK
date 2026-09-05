import { readEnv } from '../../app-config';
import { JWT_SECRET } from '../../config';
import { RestoreInProgressError } from '../backup/restore-quiescence';

import type Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SessionLineageClaims {
  id?: number;
  pv?: number;
  remember?: boolean;
  sid?: string;
  purpose?: string;
}

/** Exact identity version and lineage inherited by a short-lived capability. */
export interface SessionBinding {
  pv: number;
  sid: string;
}

type RevocationConnection = Pick<Database.Database, 'prepare'>;

export interface SessionRevocationDurabilityOptions {
  /** Test seam. Production stores pending records beside the active database. */
  readonly pendingDir?: string | null;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const SESSION_KEY_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../../data');
const PENDING_DIRECTORY_NAME = '.session-revocations-pending';
const emergencyRevocations = new Set<string>();
let revocationStoreHealthy = true;

function pendingDirectory(options: SessionRevocationDurabilityOptions): string | null {
  if (options.pendingDir !== undefined) return options.pendingDir;
  const env = readEnv();
  if (env.app.isTest && !env.db.trekDbFile) return null;
  const databaseDir = env.db.trekDbFile ? path.dirname(path.resolve(env.db.trekDbFile)) : DEFAULT_DATA_DIR;
  return path.join(databaseDir, PENDING_DIRECTORY_NAME);
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function pendingRecordPath(directory: string, sessionKey: string): string {
  return path.join(directory, `${sessionKey}.json`);
}

/** Commit a one-way revocation record before SQLite is touched. */
function persistPendingRevocation(directory: string, sessionKey: string, userId: number): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const recordPath = pendingRecordPath(directory, sessionKey);
  const tempPath = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ userId }), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, recordPath);
    syncDirectory(directory);
    return recordPath;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* preserve the original durability failure */
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* preserve the original durability failure */
    }
    throw error;
  }
}

function discardPendingRevocation(directory: string, recordPath: string): void {
  try {
    fs.rmSync(recordPath, { force: true });
    syncDirectory(directory);
  } catch (error) {
    // The SQLite tombstone is already committed. Keeping or resurrecting this
    // idempotent record only causes a safe replay on the next start.
    console.error('[auth] failed to clean a committed session revocation journal record', error);
  }
}

function replayPendingRevocations(db: RevocationConnection, directory: string | null): void {
  if (!directory || !fs.existsSync(directory)) return;
  let changed = false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('.tmp-')) {
      fs.rmSync(path.join(directory, entry.name), { force: true });
      changed = true;
      continue;
    }
    const match = entry.isFile() ? /^([a-f0-9]{64})\.json$/.exec(entry.name) : null;
    if (!match || !SESSION_KEY_PATTERN.test(match[1])) {
      throw new Error(`Invalid pending session revocation journal entry: ${entry.name}`);
    }
    const recordPath = path.join(directory, entry.name);
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { userId?: unknown };
    if (!Number.isSafeInteger(parsed.userId) || Number(parsed.userId) <= 0) {
      throw new Error(`Invalid pending session revocation journal payload: ${entry.name}`);
    }
    db.prepare(
      `INSERT INTO jsnetworkcorp_auth_session_revocations (session_key, user_id)
       VALUES (?, ?)
       ON CONFLICT(session_key) DO NOTHING`,
    ).run(match[1], Number(parsed.userId));
    fs.rmSync(recordPath, { force: true });
    changed = true;
  }
  if (changed) syncDirectory(directory);
}

/** A new browser login gets a new, independently revocable session lineage. */
export function createSessionId(): string {
  return randomUUID();
}

/**
 * Return the stable lineage carried by a session token. Tokens issued before
 * this fork hardening had no sid; hashing that exact signed credential gives
 * them a deterministic lineage without forcing every existing user to log in
 * again. The first sliding renewal upgrades it by carrying this value forward.
 */
export function sessionIdForToken(token: string, decodedClaims?: SessionLineageClaims | null): string {
  const decoded = decodedClaims ?? jwt.decode(token);
  const sid = decoded && typeof decoded === 'object' ? (decoded as SessionLineageClaims).sid : undefined;
  if (typeof sid === 'string' && SESSION_ID_PATTERN.test(sid)) return sid;
  return `legacy:${createHash('sha256').update(token).digest('hex')}`;
}

/** Store only a one-way identifier, never the bearer token or its raw sid. */
export function sessionKeyForId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function isSessionIdRevoked(db: RevocationConnection, sessionId: string): boolean {
  const sessionKey = sessionKeyForId(sessionId);
  if (!revocationStoreHealthy || emergencyRevocations.has(sessionKey)) return true;
  try {
    return !!db.prepare('SELECT 1 FROM jsnetworkcorp_auth_session_revocations WHERE session_key = ?').get(sessionKey);
  } catch (err) {
    // Restore intentionally closes the DB after request admission has stopped.
    // Treat that maintenance window as denied without poisoning the persistent
    // health latch used for genuine SQLite failures.
    if (err instanceof RestoreInProgressError) return true;
    // Once the durable gate cannot be read, accepting any session would make a
    // logout race fail open. Keep this process auth-closed until it restarts
    // against a healthy migrated database.
    revocationStoreHealthy = false;
    console.error('[auth] session revocation store unavailable; rejecting all sessions', err);
    return true;
  }
}

/** Re-open a genuinely failed latch only after the active DB proves readable. */
export function confirmSessionRevocationStoreHealth(
  db: RevocationConnection,
  options: SessionRevocationDurabilityOptions = {},
): void {
  replayPendingRevocations(db, pendingDirectory(options));
  db.prepare('SELECT 1 FROM jsnetworkcorp_auth_session_revocations LIMIT 1').get();
  revocationStoreHealthy = true;
}

export function isSessionRevoked(
  db: RevocationConnection,
  token: string,
  decodedClaims?: SessionLineageClaims | null,
): boolean {
  return isSessionIdRevoked(db, sessionIdForToken(token, decodedClaims));
}

/**
 * Verify a full browser-session credential and resolve the lineage that must
 * be torn down. Kept separate from persistence so live capabilities can be
 * closed even when SQLite refuses the tombstone write.
 */
export function sessionLineageForRevocation(token: string | undefined): { userId: number; sessionId: string } | null {
  if (!token) return null;

  let decoded: SessionLineageClaims;
  try {
    decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    }) as SessionLineageClaims;
  } catch {
    return null;
  }
  if (decoded.purpose || !Number.isInteger(decoded.id)) return null;

  return {
    userId: Number(decoded.id),
    sessionId: sessionIdForToken(token, decoded),
  };
}

/**
 * Revoke even an expired but correctly signed full-session token. Logout must
 * still be able to tombstone a lineage after expiry, while purpose-scoped MFA
 * tokens and forged input never create rows. Rows are intentionally retained:
 * sliding renewal has no absolute lifetime, so time-based pruning could let a
 * very late response revive a logged-out lineage.
 */
export function revokeSessionToken(
  db: RevocationConnection,
  token: string | undefined,
  options: SessionRevocationDurabilityOptions = {},
): { userId: number; sessionId: string } | null {
  const lineage = sessionLineageForRevocation(token);
  if (!lineage) return null;
  const { userId, sessionId } = lineage;
  const sessionKey = sessionKeyForId(sessionId);
  // Install the process-local tombstone before attempting I/O. If SQLite is
  // full/read-only/locked, this process still cannot accept a late cookie.
  emergencyRevocations.add(sessionKey);
  const directory = pendingDirectory(options);
  let pendingRecord: string | null = null;
  try {
    if (directory) pendingRecord = persistPendingRevocation(directory, sessionKey, userId);
    db.prepare(
      `INSERT INTO jsnetworkcorp_auth_session_revocations (session_key, user_id)
       VALUES (?, ?)
       ON CONFLICT(session_key) DO NOTHING`,
    ).run(sessionKey, userId);
  } catch (err) {
    revocationStoreHealthy = false;
    console.error('[auth] failed to durably persist session revocation; rejecting all sessions', err);
    throw err;
  }
  if (directory && pendingRecord) discardPendingRevocation(directory, pendingRecord);
  return { userId, sessionId };
}

/** Test isolation for the deliberately process-lifetime fail-closed latch. */
export function resetSessionRevocationStateForTests(): void {
  if (!readEnv().app.isTest) {
    throw new Error('Session revocation state may only be reset in tests');
  }
  emergencyRevocations.clear();
  revocationStoreHealthy = true;
}
