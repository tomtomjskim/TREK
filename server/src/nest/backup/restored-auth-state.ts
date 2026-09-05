import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all() as Array<{ name: string }>).some(
    (item) => item.name === column,
  );
}

/**
 * A backup is data, not a time machine for credentials. Invalidate every
 * persistent session authority in the extracted database before it can replace
 * the live file. The caller separately rotates the process-wide JWT secret and
 * clears in-memory transports after the swap.
 */
export function sanitizeRestoredAuthState(db: Database.Database): void {
  db.transaction(() => {
    if (columnExists(db, 'users', 'password_version')) {
      db.prepare('UPDATE users SET password_version = COALESCE(password_version, 0) + 1').run();
    }
    if (tableExists(db, 'mcp_tokens')) {
      db.prepare('DELETE FROM mcp_tokens').run();
    }
    if (columnExists(db, 'oauth_tokens', 'revoked_at')) {
      db.prepare('UPDATE oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL').run();
    }
    for (const table of [
      'password_reset_tokens',
      'plugin_oauth_tokens',
      'plugin_oauth_state',
      'webauthn_credentials',
      'webauthn_challenges',
    ]) {
      if (tableExists(db, table)) db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
}
