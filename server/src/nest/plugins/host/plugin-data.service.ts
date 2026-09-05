import { pluginDataDir, pluginDbFile, pluginsDataRoot } from '../paths';

import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A plugin's own sqlite database (#plugins, db:own). The HOST owns the handle;
 * the plugin child never gets a path or a connection — it can only reach this
 * through RPC (db.exec / db.query / db.migrate). Because it is a SEPARATE FILE,
 * containment is a filesystem fact: the plugin physically cannot read trek.db,
 * and we don't have to police table-name prefixes in its SQL.
 *
 * A thin guard still rejects statements that would let a plugin escape its file
 * (ATTACH another db, VACUUM INTO elsewhere, PRAGMA fiddling) or DoS via
 * oversize SQL.
 */

const MAX_SQL_LENGTH = 100_000;
// RECURSIVE is the one construct that generates unbounded rows/CPU independent of
// the (capped) data size — a `WITH RECURSIVE …` can spin the synchronous host
// forever even with an empty database, which neither the size quota nor the
// result-row cap can stop (an aggregate over it never yields a first row). Refuse
// it outright; the row/size caps below bound everything else.
// load_extension is included as defense-in-depth: better-sqlite3 disables
// extension loading by default (so it's inert today), but banning it in the guard
// means a future connection-option slip can't turn it into an arbitrary-.so RCE.
const FORBIDDEN = /\b(ATTACH|DETACH|VACUUM|PRAGMA|RECURSIVE|LOAD_EXTENSION)\b/i;
// Transaction-control keywords, matched only at statement start (so CASE…END and
// identifiers are unaffected). Refused inside db.tx() so a plugin can't COMMIT the
// batch's earlier writes and then have the wrapper report failure — breaking atomicity.
const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i;
// Per-plugin on-disk quota. better-sqlite3 is synchronous and runs in the HOST
// process, so an unbounded plugin DB is both a disk-exhaustion DoS on the shared
// trek.db volume and (via a huge scan) an event-loop stall. max_page_count caps
// the file (writes past it fail SQLITE_FULL, contained to the plugin) and bounds
// the worst-case scan cost. Result sets are additionally row-capped below so a
// recursive CTE / cartesian product can't materialize an unbounded array.
const QUOTA_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 100_000;
// Cap statements per atomic batch so a single tx() can't monopolise the synchronous
// host — generous for real write batches, far below anything abusive.
const MAX_TX_OPS = 100;

// Every live per-plugin handle, so a backup can WAL-checkpoint them before archiving
// (the host keeps these open, so their .db files would otherwise be copied with recent
// commits still stranded in the -wal sidecar → a stale/torn snapshot in the backup).
const openDbs = new Set<PluginDataDb>();

/** Fold the WAL back into each open plugin.db so a subsequent file copy is a complete,
 * consistent snapshot — mirrors the wal_checkpoint the core backup runs on travel.db.
 * A failed checkpoint makes the snapshot unsafe, so the whole operation fails closed. */
export function checkpointAllPluginDataDbs(): void {
  const failures: unknown[] = [];
  for (const d of openDbs) {
    try {
      d.checkpoint();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new Error('Plugin data WAL checkpoint failed; refusing an incomplete backup.', { cause: failures[0] });
}

export class PluginDataDb {
  private db: Db;
  readonly pluginId: string;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
    fs.mkdirSync(pluginDataDir(pluginId), { recursive: true });
    this.db = new Database(pluginDbFile(pluginId));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    openDbs.add(this);
    // Cap the file size (per-connection; not persisted, so set on every open).
    const pageSize = Number(this.db.pragma('page_size', { simple: true })) || 4096;
    this.db.pragma(`max_page_count = ${Math.max(1, Math.floor(QUOTA_BYTES / pageSize))}`);
    // Track applied migrations so db.migrate is idempotent per (plugin, id).
    this.db.exec(`CREATE TABLE IF NOT EXISTS _plugin_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)`);
  }

  private guard(sql: string): void {
    if (typeof sql !== 'string') throw new Error('sql must be a string');
    if (sql.length > MAX_SQL_LENGTH) throw new Error('sql too long');
    if (FORBIDDEN.test(sql)) throw new Error('statement type not allowed for plugin databases');
  }

  /** Read query — returns rows up to MAX_ROWS. Single statement only. */
  query(sql: string, args: unknown[] = []): unknown[] {
    this.guard(sql);
    // iterate() pulls one row at a time, so a recursive CTE that would yield
    // unboundedly is halted at the cap instead of materializing via all().
    const rows: unknown[] = [];
    for (const row of this.db.prepare(sql).iterate(...(args as never[]))) {
      rows.push(row);
      if (rows.length > MAX_ROWS) throw new Error(`query returned more than ${MAX_ROWS} rows`);
    }
    return rows;
  }

  /** Write statement(s). exec() allows multiple statements (e.g. a small setup script). */
  exec(sql: string, args: unknown[] = []): { changes: number } {
    this.guard(sql);
    if (args.length > 0) {
      const info = this.db.prepare(sql).run(...(args as never[]));
      return { changes: info.changes };
    }
    this.db.exec(sql);
    return { changes: 0 };
  }

  /**
   * Atomic batch on the plugin's OWN db: every op runs in a single transaction, so
   * they all commit or all roll back — the primitive a plugin needs for a consistent
   * multi-write (e.g. move an item between two tables). Each op is ONE statement;
   * a read (SELECT/RETURNING) yields `{ rows }`, a write yields `{ changes }`, and
   * reads within the batch see the batch's own earlier writes (read-modify-write).
   */
  tx(ops: Array<{ sql: string; args?: unknown[] }>): { results: Array<{ changes?: number; rows?: unknown[] }> } {
    if (!Array.isArray(ops)) throw new Error('tx requires an array of { sql, args }');
    if (ops.length === 0) return { results: [] };
    if (ops.length > MAX_TX_OPS) throw new Error(`tx allows at most ${MAX_TX_OPS} statements`);
    for (const op of ops) {
      this.guard(op?.sql);
      // Reject transaction-control statements: a raw COMMIT/ROLLBACK inside the batch
      // would break atomicity — it commits the earlier writes even though the wrapper
      // then reports the tx as failed. Strip any LEADING comments/whitespace first so a
      // `/* */COMMIT` or `-- x\nCOMMIT` can't slip past the start-anchored check; these
      // keywords are only valid at statement start, so CASE ... END is unaffected.
      const head = String(op?.sql ?? '').replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
      if (TX_CONTROL.test(head)) throw new Error('transaction-control statements are not allowed inside tx()');
    }
    let batchRows = 0; // one row budget for the WHOLE batch, not per statement
    const run = this.db.transaction((batch: Array<{ sql: string; args?: unknown[] }>) => {
      const results: Array<{ changes?: number; rows?: unknown[] }> = [];
      for (const op of batch) {
        const stmt = this.db.prepare(op.sql);
        const args = (op.args ?? []) as never[];
        if (stmt.reader) {
          const rows: unknown[] = [];
          for (const row of stmt.iterate(...args)) {
            rows.push(row);
            if (++batchRows > MAX_ROWS) throw new Error(`tx returned more than ${MAX_ROWS} rows in total`);
          }
          results.push({ rows });
        } else {
          results.push({ changes: stmt.run(...args).changes });
        }
      }
      return results;
    });
    return { results: run(ops) };
  }

  /** Run a migration once, keyed by id. Re-running with the same id is a no-op. */
  migrate(id: string, sql: string): { applied: boolean } {
    this.guard(sql);
    const seen = this.db.prepare('SELECT 1 FROM _plugin_migrations WHERE id = ?').get(id);
    if (seen) return { applied: false };
    this.db.transaction(() => {
      this.db.exec(sql);
      this.db.prepare('INSERT INTO _plugin_migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
    })();
    return { applied: true };
  }

  /** Whether the underlying sqlite handle is still open (better-sqlite3 `.open`).
   * The host uses this to detect a handle closed by a terminal-failure dispose that
   * left the instance cached, so it can recreate it instead of throwing on reuse. */
  isOpen(): boolean {
    return this.db.open;
  }

  /** Fold the WAL back into the main db file (checkpoint TRUNCATE) so a file-level copy
   * is a complete snapshot. No-op on a closed handle. */
  checkpoint(): void {
    if (this.db.open) this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Write a fully-consistent copy of this DB to `destPath` via VACUUM INTO. Unlike a
   * file copy it folds in the WAL and reads a point-in-time snapshot, so the result is
   * correct even while the plugin is writing — no torn page, no separate -wal to keep in
   * sync. This is a host op on the host's own handle, not plugin SQL, so it bypasses the
   * FORBIDDEN guard by design. */
  snapshotInto(destPath: string): void {
    fs.rmSync(destPath, { force: true }); // VACUUM INTO fails if the target already exists
    this.db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
  }

  close(): void {
    try {
      openDbs.delete(this);
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Delete a plugin's data directory (uninstall "delete data"). */
export function removePluginData(pluginId: string): void {
  fs.rmSync(pluginDataDir(pluginId), { recursive: true, force: true });
}

/**
 * Copy every plugin's data dir into `destRoot` as a CONSISTENT snapshot, for a backup to
 * archive instead of the live tree. An open plugin.db is captured with VACUUM INTO (safe
 * under concurrent writes); a plugin with no live handle is copied as-is (no writer). The
 * -wal/-shm sidecars for an open handle are never copied — the snapshot folds them in,
 * and copying them out of step with the .db is exactly what produced torn/corrupt restores
 * when the archiver read the live files lazily while a plugin kept writing. Blobs and any other files a
 * plugin wrote to its dir are copied verbatim. Any VACUUM, checkpoint, copy,
 * source-read, or inventory verification failure aborts the complete snapshot.
 */
type PluginInventoryKind = 'directory' | 'file';
type PluginInventory = Map<string, PluginInventoryKind>;

/** Read all ordinary source entries recursively. Unsupported special entries are not
 * plugin data and remain excluded, matching the backup walker; unreadable directories
 * are errors because silently omitting one makes restore destructive. */
function readPluginInventory(root: string): PluginInventory {
  const inventory: PluginInventory = new Map();
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Plugin data source is unreadable: ${dir}`, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        inventory.set(relative, 'directory');
        walk(path.join(dir, entry.name), relative);
      } else {
        inventory.set(relative, 'file');
      }
    }
  };
  walk(root, '');
  return inventory;
}

function withoutFoldedSidecars(inventory: PluginInventory): PluginInventory {
  return new Map(
    [...inventory].filter(([relative]) => {
      const name = path.basename(relative);
      return !name.endsWith('-wal') && !name.endsWith('-shm');
    }),
  );
}

function assertPluginInventory(pluginId: string, expected: PluginInventory, staged: PluginInventory): void {
  if (expected.size !== staged.size || [...expected].some(([relative, kind]) => staged.get(relative) !== kind)) {
    const expectedEntries = [...expected]
      .map(([relative, kind]) => `${kind}:${relative}`)
      .sort()
      .join(', ');
    const stagedEntries = [...staged]
      .map(([relative, kind]) => `${kind}:${relative}`)
      .sort()
      .join(', ');
    throw new Error(
      `Plugin data snapshot inventory mismatch for ${pluginId} (source: [${expectedEntries}], staged: [${stagedEntries}])`,
    );
  }
}

function readPluginRootInventory(root: string): Map<string, PluginInventoryKind> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Plugin data root is unreadable: ${root}`, { cause: error });
  }
  const inventory = new Map<string, PluginInventoryKind>();
  for (const entry of entries) {
    if (entry.isDirectory()) inventory.set(entry.name, 'directory');
    else if (entry.isFile()) inventory.set(entry.name, 'file');
  }
  return inventory;
}

export function snapshotAllPluginDataDbs(destRoot: string): void {
  const root = pluginsDataRoot();
  if (!fs.existsSync(root)) return;
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  const openById = new Map<string, PluginDataDb>();
  for (const d of openDbs) if (d.isOpen()) openById.set(d.pluginId, d);
  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Plugin data root is unreadable: ${root}`, { cause: error });
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) {
      if (entry.isFile()) throw new Error(`Unexpected file in plugin data root: ${entry.name}`);
      continue;
    }
    const srcDir = path.join(root, entry.name);
    const destDir = path.join(destRoot, entry.name);
    fs.mkdirSync(destDir, { recursive: true });
    const open = openById.get(entry.name);
    const sourceBefore = readPluginInventory(srcDir);
    let foldedIn = false;
    if (open) {
      try {
        open.snapshotInto(path.join(destDir, 'plugin.db'));
        foldedIn = true;
      } catch (error) {
        throw new Error(`Plugin data database snapshot failed for ${entry.name}; refusing an incomplete backup.`, {
          cause: error,
        });
      }
    }
    for (const [relative, kind] of sourceBefore) {
      if (relative === 'plugin.db' && open) continue;
      const name = path.basename(relative);
      if ((name.endsWith('-wal') || name.endsWith('-shm')) && foldedIn) continue;
      const src = path.join(srcDir, relative);
      const dest = path.join(destDir, relative);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (kind === 'directory') fs.cpSync(src, dest, { recursive: true });
        else fs.copyFileSync(src, dest);
      } catch (error) {
        throw new Error(`Plugin data entry copy failed for ${entry.name}/${relative}; refusing an incomplete backup.`, {
          cause: error,
        });
      }
    }
    const sourceAfter = readPluginInventory(srcDir);
    const expected = foldedIn ? withoutFoldedSidecars(sourceAfter) : sourceAfter;
    const staged = readPluginInventory(destDir);
    assertPluginInventory(entry.name, expected, staged);
  }
  const rootBefore = new Map<string, PluginInventoryKind>();
  for (const entry of rootEntries) {
    if (entry.isDirectory()) rootBefore.set(entry.name, 'directory');
    else if (entry.isFile()) rootBefore.set(entry.name, 'file');
  }
  const rootAfter = readPluginRootInventory(root);
  if (rootBefore.size !== rootAfter.size || [...rootBefore].some(([name, kind]) => rootAfter.get(name) !== kind)) {
    throw new Error('Plugin data snapshot root inventory changed during backup; refusing an incomplete backup.');
  }
}
