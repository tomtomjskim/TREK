import { sanitizeRestoredAuthState } from '../../../src/nest/backup/restored-auth-state';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('restored auth state sanitization', () => {
  it('invalidates every restored local and brokered credential atomically', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, password_version INTEGER);
      INSERT INTO users VALUES (1, 4), (2, NULL);
      CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY);
      INSERT INTO mcp_tokens VALUES (7);
      CREATE TABLE oauth_tokens (id INTEGER PRIMARY KEY, revoked_at TEXT);
      INSERT INTO oauth_tokens VALUES (8, NULL), (9, 'already-revoked');
      CREATE TABLE password_reset_tokens (id INTEGER PRIMARY KEY, consumed_at TEXT);
      INSERT INTO password_reset_tokens VALUES (10, NULL), (11, 'already-consumed');
      CREATE TABLE plugin_oauth_tokens (plugin_id TEXT PRIMARY KEY, access_token TEXT);
      INSERT INTO plugin_oauth_tokens VALUES ('calendar', 'encrypted-token');
      CREATE TABLE plugin_oauth_state (state TEXT PRIMARY KEY);
      INSERT INTO plugin_oauth_state VALUES ('pending-state');
      CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id INTEGER);
      INSERT INTO webauthn_credentials VALUES ('restored-passkey', 1);
      CREATE TABLE webauthn_challenges (challenge TEXT PRIMARY KEY, user_id INTEGER);
      INSERT INTO webauthn_challenges VALUES ('restored-challenge', 1);
    `);

    sanitizeRestoredAuthState(db);

    expect(db.prepare('SELECT id, password_version FROM users ORDER BY id').all()).toEqual([
      { id: 1, password_version: 5 },
      { id: 2, password_version: 1 },
    ]);
    expect(db.prepare('SELECT * FROM mcp_tokens').all()).toEqual([]);
    expect(db.prepare('SELECT id, revoked_at FROM oauth_tokens ORDER BY id').all()).toEqual([
      { id: 8, revoked_at: expect.any(String) },
      { id: 9, revoked_at: 'already-revoked' },
    ]);
    expect(db.prepare('SELECT * FROM password_reset_tokens').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM plugin_oauth_tokens').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM plugin_oauth_state').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM webauthn_credentials').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM webauthn_challenges').all()).toEqual([]);
  });

  it('supports older snapshots whose optional token tables do not exist', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, password_version INTEGER); INSERT INTO users VALUES (1, 0)');

    expect(() => sanitizeRestoredAuthState(db)).not.toThrow();
    expect(db.prepare('SELECT password_version FROM users').get()).toEqual({ password_version: 1 });
  });
});
