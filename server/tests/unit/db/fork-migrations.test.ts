import {
  FORK_MIGRATION_TABLE_SQL,
  GOOGLE_API_USAGE_MIGRATION_ID,
  PACKING_TEMPLATE_SCOPE_MIGRATION_ID,
  runForkMigrations,
} from '../../../src/db/forkMigrations';
import {
  FORK_MIGRATION_IDS,
  LEGACY_COLLISION_BRIDGE_ID,
  prepareLegacyForkSchema,
  runMigrations,
} from '../../../src/db/migrationRunner';
import { runMigrations as runOfficialMigrations } from '../../../src/db/migrations';
import { createTables } from '../../../src/db/schema';

import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type PackingSchema = 'legacy' | 'scoped' | 'scope-only' | 'owner-only' | 'drifted';
type OfficialImageVersion = 171 | 172 | 173 | 175 | 200 | 'latest';

interface FixtureOptions {
  marker?: number;
  officialImageVersion?: OfficialImageVersion;
  googleUsage?: 'missing' | 'valid' | 'malformed';
  packing?: PackingSchema;
  forkHistory?: readonly string[];
}

const openDbs: Database.Database[] = [];
const officialImages = new Map<OfficialImageVersion, Buffer>();
let latestOfficialVersion = 0;

function schemaVersion(db: Database.Database): number {
  return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare('UPDATE schema_version SET version = ?').run(version);
}

function track(db: Database.Database): Database.Database {
  openDbs.push(db);
  return db;
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function createOfficialBase(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (19);
  `);
  return db;
}

function advanceOfficialSchemaTo(db: Database.Database, target: number): void {
  const stopBefore = target + 1;
  const exitSignal = new Error(`intercepted process.exit while generating official schema ${target}`);
  const boundarySignal = new Error(`official schema image boundary ${target}`);
  const originalPrepare = db.prepare.bind(db);
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = originalPrepare(sql);
    if (sql.replace(/\s+/g, ' ').trim() === 'UPDATE schema_version SET version = ?') {
      const originalRun = statement.run.bind(statement);
      statement.run = (...params: unknown[]) => {
        if (params[0] === stopBefore) throw boundarySignal;
        return originalRun(...params);
      };
    }
    return statement;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exitSignal;
  });

  try {
    expect(() => runOfficialMigrations(db)).toThrow(exitSignal);
  } finally {
    exitSpy.mockRestore();
    prepareSpy.mockRestore();
  }

  expect(schemaVersion(db)).toBe(target);
}

function buildOfficialImages(): void {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    let db = createOfficialBase();
    advanceOfficialSchemaTo(db, 171);
    officialImages.set(171, db.serialize());
    db.close();

    for (const target of [172, 173, 175] as const) {
      const previous = target === 172 ? 171 : target === 173 ? 172 : 173;
      db = new Database(officialImages.get(previous)!);
      db.exec('PRAGMA foreign_keys = ON');
      advanceOfficialSchemaTo(db, target);
      officialImages.set(target, db.serialize());
      db.close();
    }

    db = new Database(officialImages.get(175)!);
    db.exec('PRAGMA foreign_keys = ON');
    advanceOfficialSchemaTo(db, 200);
    officialImages.set(200, db.serialize());
    db.close();

    db = new Database(officialImages.get(200)!);
    db.exec('PRAGMA foreign_keys = ON');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`unexpected process.exit(${String(code)}) while generating latest official schema`);
    });
    try {
      runOfficialMigrations(db);
    } finally {
      exitSpy.mockRestore();
    }
    latestOfficialVersion = schemaVersion(db);
    officialImages.set('latest', db.serialize());
    db.close();
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

function cloneOfficialImage(version: OfficialImageVersion): Database.Database {
  const db = track(new Database(officialImages.get(version)!));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function packingTableSql(packing: PackingSchema): string {
  if (packing === 'legacy') {
    return `
      CREATE TABLE packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
  }

  if (packing === 'scope-only') {
    return `
      CREATE TABLE packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'instance',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
  }

  if (packing === 'owner-only') {
    return `
      CREATE TABLE packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
  }

  if (packing === 'drifted') {
    return `
      CREATE TABLE packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        scope TEXT DEFAULT 'instance',
        owner_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
  }

  return `
    CREATE TABLE packing_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'instance'
        CHECK (scope IN ('instance', 'personal')),
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT packing_templates_scope_owner_check CHECK (
        (scope = 'instance' AND owner_id IS NULL) OR
        (scope = 'personal' AND owner_id IS NOT NULL)
      )
    );
    CREATE INDEX idx_packing_templates_scope_owner_created
      ON packing_templates(scope, owner_id, created_at);
  `;
}

function rebuildPackingSchema(db: Database.Database, packing: PackingSchema): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      DROP TABLE IF EXISTS packing_template_items;
      DROP TABLE IF EXISTS packing_template_categories;
      DROP TABLE IF EXISTS packing_templates;
      ${packingTableSql(packing)}
      CREATE TABLE packing_template_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL REFERENCES packing_templates(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE packing_template_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES packing_template_categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
    `);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function seedFixtureRows(db: Database.Database, packing: PackingSchema): void {
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash)
     VALUES (1, 'creator', 'creator@example.test', 'test-only'),
            (2, 'owner', 'owner@example.test', 'test-only')`,
  ).run();

  if (packing === 'scoped') {
    db.prepare(
      `INSERT INTO packing_templates (id, name, scope, owner_id, created_by, created_at)
       VALUES (10, 'Legacy template', 'instance', NULL, 1, '2026-07-01 00:00:00')`,
    ).run();
  } else if (packing === 'scope-only' || packing === 'drifted') {
    db.prepare(
      `INSERT INTO packing_templates (id, name, scope, created_by, created_at)
       VALUES (10, 'Legacy template', 'instance', 1, '2026-07-01 00:00:00')`,
    ).run();
  } else if (packing === 'owner-only') {
    db.prepare(
      `INSERT INTO packing_templates (id, name, owner_id, created_by, created_at)
       VALUES (10, 'Legacy template', NULL, 1, '2026-07-01 00:00:00')`,
    ).run();
  } else {
    db.prepare(
      `INSERT INTO packing_templates (id, name, created_by, created_at)
       VALUES (10, 'Legacy template', 1, '2026-07-01 00:00:00')`,
    ).run();
  }

  db.exec(`
    INSERT INTO packing_template_categories (id, template_id, name, sort_order)
      VALUES (20, 10, 'Gear', 0);
    INSERT INTO packing_template_items (id, category_id, name, sort_order)
      VALUES (30, 20, 'Backpack', 0);
  `);
}

function createGoogleUsage(db: Database.Database, state: 'valid' | 'malformed'): void {
  if (state === 'valid') {
    db.exec(`
      CREATE TABLE google_api_usage (
        period TEXT NOT NULL,
        sku TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (period, sku)
      );
      INSERT INTO google_api_usage (period, sku, attempts, updated_at)
        VALUES ('2026-07', 'text_search_pro', 7, 1720000000000);
    `);
    return;
  }

  db.exec(`
    CREATE TABLE google_api_usage (
      period TEXT PRIMARY KEY,
      attempts TEXT
    );
  `);
}

function createFixture({
  marker,
  officialImageVersion = 171,
  googleUsage = 'missing',
  packing = 'legacy',
  forkHistory = [],
}: FixtureOptions = {}): Database.Database {
  const db = cloneOfficialImage(officialImageVersion);
  if (marker !== undefined) setSchemaVersion(db, marker);
  rebuildPackingSchema(db, packing);
  seedFixtureRows(db, packing);

  if (googleUsage !== 'missing') createGoogleUsage(db, googleUsage);
  if (forkHistory.length > 0) {
    db.exec(FORK_MIGRATION_TABLE_SQL);
    const insert = db.prepare('INSERT INTO fork_schema_migrations (id) VALUES (?)');
    for (const id of forkHistory) insert.run(id);
  }

  return db;
}

function createFreshFixture(): Database.Database {
  const db = track(new Database(':memory:'));
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name);
}

function migrationIds(db: Database.Database): string[] {
  if (!tableExists(db, 'fork_schema_migrations')) return [];
  return (db.prepare('SELECT id FROM fork_schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

function expectIntegrated(db: Database.Database, bridgeExpected: boolean, expectedForeignKeys = 1): void {
  expect(schemaVersion(db)).toBe(latestOfficialVersion);
  expect(latestOfficialVersion).toBe(205);
  expect(columnNames(db, 'plugins')).toEqual(
    expect.arrayContaining(['update_block_code', 'update_block_detail', 'update_block_version', 'trek_range']),
  );
  expect(columnNames(db, 'journeys')).toContain('show_trip_tracks');
  expect(columnNames(db, 'plugin_settings_fields')).toContain('default_value');
  expect(columnNames(db, 'plugin_actions')).toContain('scope');
  expect(columnNames(db, 'journey_entries')).toContain('stats_excluded');
  expect(columnNames(db, 'packing_templates')).toEqual(expect.arrayContaining(['scope', 'owner_id']));
  expect(columnNames(db, 'google_api_usage')).toEqual(
    expect.arrayContaining(['period', 'sku', 'attempts', 'updated_at']),
  );

  if (db.prepare('SELECT 1 FROM packing_templates WHERE id = 10').get()) {
    expect(db.prepare('SELECT template_id FROM packing_template_categories WHERE id = 20').get()).toEqual({
      template_id: 10,
    });
    expect(db.prepare('SELECT category_id FROM packing_template_items WHERE id = 30').get()).toEqual({
      category_id: 20,
    });
  }

  expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(expectedForeignKeys);

  const expectedIds = [...FORK_MIGRATION_IDS, ...(bridgeExpected ? [LEGACY_COLLISION_BRIDGE_ID] : [])].sort();
  expect(migrationIds(db)).toEqual(expectedIds);
  expect(db.prepare('SELECT id, COUNT(*) AS count FROM fork_schema_migrations GROUP BY id ORDER BY id').all()).toEqual(
    expectedIds.map((id) => ({ id, count: 1 })),
  );
}

function runTwiceAndExpectStable(db: Database.Database, bridgeExpected = false, expectedForeignKeys = 1): void {
  runMigrations(db);
  expectIntegrated(db, bridgeExpected, expectedForeignKeys);
  const afterFirstRun = db.serialize();

  runMigrations(db);
  expectIntegrated(db, bridgeExpected, expectedForeignKeys);
  expect(db.serialize().equals(afterFirstRun)).toBe(true);
}

function expectFailureWithoutMutation(db: Database.Database, expected: RegExp): void {
  const before = db.serialize();
  expect(() => runMigrations(db)).toThrow(expected);
  expect(db.serialize().equals(before)).toBe(true);
}

beforeAll(() => {
  buildOfficialImages();
});

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe('fork migration runner — generated official schema matrix', () => {
  it('DB-FRESH migrates createTables output to the latest official and fork schemas twice', () => {
    runTwiceAndExpectStable(createFreshFixture());
  });

  it.each([171, 172, 173, 175, 200] as const)(
    'DB-STOCK-%i migrates the source-derived official image and remains stable on replay',
    (version) => {
      runTwiceAndExpectStable(createFixture({ officialImageVersion: version }));
    },
  );

  it('DB-STOCK-200 applies official migrations 201-205 with preserved defaults before fork migrations', () => {
    const db = createFixture({ officialImageVersion: 200 });
    expect(schemaVersion(db)).toBe(200);

    const addonUpdate = db.prepare("UPDATE addons SET type = 'trip' WHERE id = 'naver_list_import'").run();
    expect(addonUpdate.changes).toBe(1);
    db.prepare(
      "INSERT INTO journeys (id, user_id, title, created_at, updated_at) VALUES (4242, 1, 'Migration fixture', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO journey_entries (id, journey_id, author_id, type, entry_date, created_at, updated_at) VALUES (4243, 4242, 1, 'entry', '2026-09-04', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO plugin_settings_fields (plugin_id, field_key, input_type) VALUES ('fixture', 'endpoint', 'text')",
    ).run();
    db.prepare(
      "INSERT INTO plugin_actions (plugin_id, action_key, label) VALUES ('fixture', 'sync', 'Sync')",
    ).run();

    runTwiceAndExpectStable(db);

    expect(schemaVersion(db)).toBe(205);
    expect(db.prepare("SELECT type FROM addons WHERE id = 'naver_list_import'").get()).toEqual({
      type: 'integration',
    });
    expect(db.prepare('SELECT show_trip_tracks FROM journeys WHERE id = 4242').get()).toEqual({
      show_trip_tracks: 0,
    });
    expect(db.prepare("SELECT default_value FROM plugin_settings_fields WHERE plugin_id = 'fixture'").get()).toEqual({
      default_value: null,
    });
    expect(db.prepare("SELECT scope FROM plugin_actions WHERE plugin_id = 'fixture'").get()).toEqual({ scope: 'user' });
    expect(db.prepare('SELECT stats_excluded FROM journey_entries WHERE id = 4243').get()).toEqual({
      stats_excluded: 0,
    });
  });

  it('DB-LEGACY-172 rewinds the collision marker, preserves usage, and replays official migrations', () => {
    const db = createFixture({ marker: 172, googleUsage: 'valid' });

    runTwiceAndExpectStable(db, true);

    expect(db.prepare('SELECT attempts FROM google_api_usage').get()).toEqual({ attempts: 7 });
  });

  it('DB-LEGACY-173 rewinds the collision marker and preserves the scoped template graph', () => {
    const db = createFixture({ marker: 173, googleUsage: 'valid', packing: 'scoped' });

    runTwiceAndExpectStable(db, true);

    expect(db.prepare('SELECT scope, owner_id, created_by FROM packing_templates WHERE id = 10').get()).toEqual({
      scope: 'instance',
      owner_id: null,
      created_by: 1,
    });
    expect(db.prepare('SELECT attempts FROM google_api_usage').get()).toEqual({ attempts: 7 });
  });

  it('DB-CURRENT-FORK advances marker 175 with exact fork IDs and preserves personal ownership', () => {
    const db = createFixture({
      officialImageVersion: 175,
      googleUsage: 'valid',
      packing: 'scoped',
      forkHistory: FORK_MIGRATION_IDS,
    });
    db.prepare(
      "INSERT INTO packing_templates (name, scope, owner_id, created_by) VALUES ('Private', 'personal', 2, 2)",
    ).run();

    runTwiceAndExpectStable(db);

    expect(db.prepare("SELECT scope, owner_id FROM packing_templates WHERE name = 'Private'").get()).toEqual({
      scope: 'personal',
      owner_id: 2,
    });
  });

  it('DB-OFFICIAL-CRASH resumes when official migration 173 committed before marker 172 advanced', () => {
    const db = createFixture({ officialImageVersion: 173, marker: 172 });

    runTwiceAndExpectStable(db);
  });

  it('DB-BRIDGE-CRASH rolls back bridge history and marker together, then resumes', () => {
    const db = createFixture({ marker: 172, googleUsage: 'valid' });
    const before = db.serialize();
    db.exec(`
      CREATE TEMP TRIGGER interrupt_legacy_bridge
      BEFORE UPDATE OF version ON schema_version
      WHEN NEW.version = 171
      BEGIN
        SELECT RAISE(ABORT, 'bridge interruption');
      END;
    `);

    expect(() => prepareLegacyForkSchema(db)).toThrow(/bridge interruption/i);
    expect(schemaVersion(db)).toBe(172);
    expect(migrationIds(db)).toEqual([]);
    expect(db.serialize().equals(before)).toBe(true);

    db.exec('DROP TRIGGER temp.interrupt_legacy_bridge');
    runTwiceAndExpectStable(db, true);
  });

  it('DB-FORK-CRASH rolls back a fork schema body when recording its stable ID fails, then resumes', () => {
    const db = createFixture({ officialImageVersion: 'latest' });
    db.exec(FORK_MIGRATION_TABLE_SQL);
    const before = db.serialize();
    db.exec(`
      CREATE TEMP TRIGGER interrupt_fork_id_write
      BEFORE INSERT ON fork_schema_migrations
      WHEN NEW.id = '${GOOGLE_API_USAGE_MIGRATION_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'fork id interruption');
      END;
    `);

    expect(() => runForkMigrations(db)).toThrow(/fork id interruption/i);
    expect(tableExists(db, 'google_api_usage')).toBe(false);
    expect(migrationIds(db)).toEqual([]);
    expect(db.serialize().equals(before)).toBe(true);

    db.exec('DROP TRIGGER temp.interrupt_fork_id_write');
    runTwiceAndExpectStable(db);
  });

  it.each([
    { label: 'enabled', pragma: 'ON', expected: 1 },
    { label: 'disabled', pragma: 'OFF', expected: 0 },
  ])(
    'DB-FORK-CRASH rolls back the packing rebuild with foreign keys $label, preserves the pragma, then resumes',
    ({ pragma, expected }) => {
      const db = createFixture({
        officialImageVersion: 'latest',
        googleUsage: 'valid',
        forkHistory: [GOOGLE_API_USAGE_MIGRATION_ID],
      });
      db.exec(`PRAGMA foreign_keys = ${pragma}`);
      const before = db.serialize();
      db.exec(`
      CREATE TEMP TRIGGER interrupt_packing_fork_id_write
      BEFORE INSERT ON fork_schema_migrations
      WHEN NEW.id = '${PACKING_TEMPLATE_SCOPE_MIGRATION_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'packing fork id interruption');
      END;
    `);

      expect(() => runForkMigrations(db)).toThrow(/packing fork id interruption/i);
      expect(columnNames(db, 'packing_templates')).not.toContain('scope');
      expect(migrationIds(db)).toEqual([GOOGLE_API_USAGE_MIGRATION_ID]);
      expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(expected);
      expect(db.serialize().equals(before)).toBe(true);

      db.exec('DROP TRIGGER temp.interrupt_packing_fork_id_write');
      runTwiceAndExpectStable(db, false, expected);
    },
  );

  it('DB-NESTED rejects adapter and direct fork execution inside an existing transaction without mutation', () => {
    const db = createFixture({ officialImageVersion: 'latest' });
    const before = db.serialize();

    expect(() => db.transaction(() => runMigrations(db))()).toThrow(/outside an existing transaction/i);
    expect(db.serialize().equals(before)).toBe(true);
    expect(() => db.transaction(() => runForkMigrations(db))()).toThrow(/outside an existing transaction/i);
    expect(db.serialize().equals(before)).toBe(true);
  });
});

describe('fork migration runner — unknown states fail closed', () => {
  it('rejects mixed local and stock-official signatures', () => {
    expectFailureWithoutMutation(
      createFixture({ officialImageVersion: 172, marker: 172, googleUsage: 'valid' }),
      /unknown or mixed schema state/i,
    );
  });

  it.each(['scope-only', 'owner-only', 'drifted'] as const)('rejects a %s packing schema', (packing) => {
    expectFailureWithoutMutation(
      createFixture({ marker: 173, googleUsage: 'valid', packing }),
      /packing_templates schema does not match/i,
    );
  });

  it('rejects a malformed google usage schema', () => {
    expectFailureWithoutMutation(
      createFixture({ marker: 172, googleUsage: 'malformed' }),
      /google_api_usage schema does not match/i,
    );
  });

  it('rejects a partial official collision signature', () => {
    const db = createFixture({ officialImageVersion: 172, marker: 172 });
    db.exec('ALTER TABLE plugins DROP COLUMN update_block_detail');

    expectFailureWithoutMutation(db, /unknown or mixed schema state/i);
  });

  it('rejects multiple official marker rows', () => {
    const db = createFixture();
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(171);

    expectFailureWithoutMutation(db, /at most one row/i);
  });
});
