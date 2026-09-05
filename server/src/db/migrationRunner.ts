import {
  FORK_MIGRATION_IDS,
  FORK_MIGRATION_TABLE_SQL,
  googleApiUsageSchemaState,
  packingTemplateSchemaState,
  runForkMigrations,
} from './forkMigrations';
import { OFFICIAL_SCHEMA_VERSION, runMigrations as runOfficialMigrations } from './migrations';

import Database from 'better-sqlite3';

export { FORK_MIGRATION_IDS };
export const LEGACY_COLLISION_BRIDGE_ID = 'jsnetworkcorp.legacy-schema-version-collision.v1';

type LegacyCollisionVersion = 172 | 173;

function schemaVersion(db: Database.Database): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!table) return 0;
  const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
  if (rows.length > 1) throw new Error(`schema_version must contain at most one row; found ${rows.length}`);
  return rows[0]?.version ?? 0;
}

/**
 * Refuse to mutate a database produced by a newer or unknown migration lane.
 * This check intentionally does not create either marker table: startup and
 * restore callers can run it against a snapshot before any migration write.
 */
export function assertSchemaCompatibility(db: Database.Database): void {
  const schemaTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (schemaTable) {
    const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: unknown }>;
    if (rows.length > 1) throw new Error(`schema_version must contain at most one row; found ${rows.length}`);
    const version = rows[0]?.version;
    if (
      version !== undefined &&
      (!Number.isInteger(version) || Number(version) < 0 || Number(version) > OFFICIAL_SCHEMA_VERSION)
    ) {
      throw new Error(
        `Refusing migration from future or invalid official schema_version ${String(version)} (maximum supported ${OFFICIAL_SCHEMA_VERSION})`,
      );
    }
  }

  const forkTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fork_schema_migrations'")
    .get();
  if (!forkTable) return;

  const allowed = new Set<string>([LEGACY_COLLISION_BRIDGE_ID, ...FORK_MIGRATION_IDS]);
  const rows = db.prepare('SELECT id FROM fork_schema_migrations').all() as Array<{ id: unknown }>;
  const unknown = rows.map((row) => row.id).filter((id) => typeof id !== 'string' || !allowed.has(id));
  if (unknown.length > 0) {
    throw new Error(`Refusing migration with unknown fork_schema_migrations.id: ${unknown.map(String).join(', ')}`);
  }
}

function pluginColumns(db: Database.Database): Set<string> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugins'").get();
  if (!exists) return new Set();
  return new Set(
    (db.prepare("PRAGMA table_info('plugins')").all() as Array<{ name: string }>).map((column) => column.name),
  );
}

function hasBridgeRecord(db: Database.Database): boolean {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fork_schema_migrations'")
    .get();
  if (!table) return false;
  return !!db.prepare('SELECT 1 FROM fork_schema_migrations WHERE id = ?').get(LEGACY_COLLISION_BRIDGE_ID);
}

function officialPartialSignature(
  db: Database.Database,
  version: LegacyCollisionVersion,
): 'none' | 'exact' | 'ahead' | 'partial' {
  const columns = pluginColumns(db);
  const version172 = ['update_block_code', 'update_block_detail', 'update_block_version'];
  const version172Present = version172.filter((column) => columns.has(column)).length;
  const hasTrekRange = columns.has('trek_range');

  if (version172Present === 0 && !hasTrekRange) return 'none';
  if (version172Present !== version172.length) return 'partial';
  if (version === 172) return hasTrekRange ? 'ahead' : 'exact';
  if (hasTrekRange) return 'exact';
  return 'partial';
}

function failUnknown(version: LegacyCollisionVersion, detail: string): never {
  throw new Error(`Refusing migration from unknown or mixed schema state at official marker ${version}: ${detail}`);
}

export function prepareLegacyForkSchema(db: Database.Database): void {
  const version = schemaVersion(db);
  if (version !== 172 && version !== 173) return;

  const collisionVersion = version as LegacyCollisionVersion;
  const officialState = officialPartialSignature(db, collisionVersion);
  const googleState = googleApiUsageSchemaState(db);
  const packingState = packingTemplateSchemaState(db);
  const bridgeStarted = hasBridgeRecord(db);
  const officialRecoverable = officialState === 'exact' || officialState === 'ahead';

  if (bridgeStarted) {
    if (!officialRecoverable || googleState !== 'valid') {
      failUnknown(collisionVersion, 'legacy bridge history exists but the expected official/local signatures do not');
    }
    return;
  }

  const isStockOfficial = officialRecoverable && googleState === 'missing' && packingState === 'legacy';
  if (isStockOfficial) return;

  const isLegacyFork172 =
    collisionVersion === 172 && officialState === 'none' && googleState === 'valid' && packingState === 'legacy';
  const isLegacyFork173 =
    collisionVersion === 173 && officialState === 'none' && googleState === 'valid' && packingState === 'scoped';

  if (!isLegacyFork172 && !isLegacyFork173) {
    failUnknown(collisionVersion, `official=${officialState}, google=${googleState}, packing=${packingState}`);
  }

  db.transaction(() => {
    db.exec(FORK_MIGRATION_TABLE_SQL);
    db.prepare('INSERT OR IGNORE INTO fork_schema_migrations (id) VALUES (?)').run(LEGACY_COLLISION_BRIDGE_ID);
    db.prepare('UPDATE schema_version SET version = 171').run();
  })();
}

export function runMigrations(db: Database.Database): void {
  if (db.inTransaction) {
    throw new Error('Migration adapter must run outside an existing transaction');
  }
  // Must precede the legacy bridge and both official/fork runners: none of
  // those may mutate an incompatible snapshot while trying to inspect it.
  assertSchemaCompatibility(db);
  prepareLegacyForkSchema(db);
  runOfficialMigrations(db);
  runForkMigrations(db);
}
