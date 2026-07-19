import { FORK_MIGRATION_IDS, LEGACY_COLLISION_BRIDGE_ID, runMigrations } from '../../../src/db/migrationRunner';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

type PackingSchema = 'legacy' | 'scoped' | 'drifted';

interface FixtureOptions {
  version: number;
  googleUsage?: boolean;
  official172?: boolean;
  official173?: boolean;
  packing?: PackingSchema;
}

const openDbs: Database.Database[] = [];

function createFixture({
  version,
  googleUsage = false,
  official172 = false,
  official173 = false,
  packing = 'legacy',
}: FixtureOptions): Database.Database {
  const db = new Database(':memory:');
  openDbs.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (version) VALUES (${version});

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    INSERT INTO users (id, username) VALUES (1, 'creator'), (2, 'owner');

    CREATE TABLE plugins (id TEXT PRIMARY KEY);
  `);

  if (official172) {
    db.exec(`
      ALTER TABLE plugins ADD COLUMN update_block_code TEXT;
      ALTER TABLE plugins ADD COLUMN update_block_detail TEXT;
      ALTER TABLE plugins ADD COLUMN update_block_version TEXT;
    `);
  }
  if (official173) db.exec('ALTER TABLE plugins ADD COLUMN trek_range TEXT;');

  if (packing === 'legacy') {
    db.exec(`
      CREATE TABLE packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else if (packing === 'scoped') {
    db.exec(`
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
    `);
  } else {
    db.exec(`
      CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE packing_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        scope TEXT DEFAULT 'instance',
        owner_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  db.exec(`
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

  if (packing === 'scoped') {
    db.prepare(
      "INSERT INTO packing_templates (id, name, scope, owner_id, created_by, created_at) VALUES (10, 'Legacy template', 'instance', NULL, 1, '2026-07-01 00:00:00')",
    ).run();
  } else {
    db.prepare(
      "INSERT INTO packing_templates (id, name, created_by, created_at) VALUES (10, 'Legacy template', 1, '2026-07-01 00:00:00')",
    ).run();
  }
  db.exec(`
    INSERT INTO packing_template_categories (id, template_id, name, sort_order)
      VALUES (20, 10, 'Gear', 0);
    INSERT INTO packing_template_items (id, category_id, name, sort_order)
      VALUES (30, 20, 'Backpack', 0);
  `);

  if (googleUsage) {
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
  }

  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name);
}

function migrationIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM fork_schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

function expectIntegrated(db: Database.Database): void {
  expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 175 });
  expect(columnNames(db, 'plugins')).toEqual(
    expect.arrayContaining(['update_block_code', 'update_block_detail', 'update_block_version', 'trek_range']),
  );
  expect(columnNames(db, 'packing_templates')).toEqual(expect.arrayContaining(['scope', 'owner_id']));
  expect(columnNames(db, 'google_api_usage')).toEqual(
    expect.arrayContaining(['period', 'sku', 'attempts', 'updated_at']),
  );
  expect(db.prepare('SELECT template_id FROM packing_template_categories WHERE id = 20').get()).toEqual({
    template_id: 10,
  });
  expect(db.prepare('SELECT category_id FROM packing_template_items WHERE id = 30').get()).toEqual({
    category_id: 20,
  });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(migrationIds(db)).toEqual(expect.arrayContaining([...FORK_MIGRATION_IDS]));
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe('fork migration runner — official/fork namespace split', () => {
  it('migrates a stock official 171 database through official 175 and both fork migrations', () => {
    const db = createFixture({ version: 171 });

    runMigrations(db);

    expectIntegrated(db);
    expect(migrationIds(db)).not.toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it('recognises legacy fork 172, preserves usage, and replays official 172..175', () => {
    const db = createFixture({ version: 172, googleUsage: true });

    runMigrations(db);

    expectIntegrated(db);
    expect(db.prepare('SELECT attempts FROM google_api_usage').get()).toEqual({ attempts: 7 });
    expect(migrationIds(db)).toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it('recognises legacy fork 173, preserves the scoped graph, and replays official 172..175', () => {
    const db = createFixture({ version: 173, googleUsage: true, packing: 'scoped' });

    runMigrations(db);

    expectIntegrated(db);
    expect(db.prepare('SELECT scope, owner_id, created_by FROM packing_templates WHERE id = 10').get()).toEqual({
      scope: 'instance',
      owner_id: null,
      created_by: 1,
    });
    expect(migrationIds(db)).toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it.each([
    { version: 172, official172: true, official173: false },
    { version: 173, official172: true, official173: true },
  ])('continues a stock official partial schema at version $version', (options) => {
    const db = createFixture(options);

    runMigrations(db);

    expectIntegrated(db);
    expect(migrationIds(db)).not.toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it('resumes stock official migration 173 when its schema committed before marker 172 advanced', () => {
    const db = createFixture({ version: 172, official172: true, official173: true });

    runMigrations(db);

    expectIntegrated(db);
    expect(migrationIds(db)).not.toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it.each([
    { version: 172, official172: true, official173: false },
    { version: 173, official172: true, official173: true },
  ])('resumes an interrupted legacy bridge after official version $version was recorded', (options) => {
    const db = createFixture({ ...options, googleUsage: true, packing: 'scoped' });
    db.exec(`
      CREATE TABLE fork_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare('INSERT INTO fork_schema_migrations (id) VALUES (?)').run(LEGACY_COLLISION_BRIDGE_ID);

    runMigrations(db);

    expectIntegrated(db);
    expect(migrationIds(db)).toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it('resumes a bridge when official migration 173 committed before marker 172 advanced', () => {
    const db = createFixture({
      version: 172,
      googleUsage: true,
      official172: true,
      official173: true,
      packing: 'scoped',
    });
    db.exec(`
      CREATE TABLE fork_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare('INSERT INTO fork_schema_migrations (id) VALUES (?)').run(LEGACY_COLLISION_BRIDGE_ID);

    runMigrations(db);

    expectIntegrated(db);
    expect(migrationIds(db)).toContain(LEGACY_COLLISION_BRIDGE_ID);
  });

  it('is idempotent and preserves personal template ownership on a second run', () => {
    const db = createFixture({ version: 171 });
    runMigrations(db);
    db.prepare(
      "INSERT INTO packing_templates (name, scope, owner_id, created_by) VALUES ('Private', 'personal', 2, 2)",
    ).run();
    const before = migrationIds(db);

    runMigrations(db);

    expect(migrationIds(db)).toEqual(before);
    expect(db.prepare("SELECT scope, owner_id FROM packing_templates WHERE name = 'Private'").get()).toEqual({
      scope: 'personal',
      owner_id: 2,
    });
  });

  it('fails closed for an ambiguous local marker instead of skipping official migrations', () => {
    const db = createFixture({ version: 173, googleUsage: true });

    expect(() => runMigrations(db)).toThrow(/unknown or mixed schema state/i);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 173 });
    expect(columnNames(db, 'plugins')).not.toContain('update_block_code');
  });

  it('fails closed when local and official 172 signatures are mixed', () => {
    const db = createFixture({ version: 172, googleUsage: true, official172: true });

    expect(() => runMigrations(db)).toThrow(/unknown or mixed schema state/i);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 172 });
  });

  it('fails closed when the deployed packing scope signature has drifted', () => {
    const db = createFixture({ version: 173, googleUsage: true, packing: 'drifted' });

    expect(() => runMigrations(db)).toThrow(/packing_templates schema does not match/i);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 173 });
  });
});
