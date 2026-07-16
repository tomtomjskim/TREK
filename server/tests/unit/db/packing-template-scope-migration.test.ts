import { runMigrations } from '../../../src/db/migrations';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const openDbs: Database.Database[] = [];

function createLegacyPackingTemplateDb(): Database.Database {
  const db = new Database(':memory:');
  openDbs.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (172);

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    INSERT INTO users (id, username) VALUES (1, 'creator'), (2, 'owner');

    CREATE TABLE packing_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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

    INSERT INTO packing_templates (id, name, created_by, created_at)
      VALUES (10, 'Legacy template', 1, '2026-07-01 00:00:00');
    INSERT INTO packing_template_categories (id, template_id, name, sort_order)
      VALUES (20, 10, 'Gear', 0);
    INSERT INTO packing_template_items (id, category_id, name, sort_order)
      VALUES (30, 20, 'Backpack', 0);
  `);
  return db;
}

function createDriftedScopedPackingTemplateDb(): Database.Database {
  const db = new Database(':memory:');
  openDbs.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (173);

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO users (id, username) VALUES (1, 'creator');
    INSERT INTO trips (id) VALUES (1);

    CREATE TABLE packing_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scope TEXT DEFAULT 'instance',
      owner_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO packing_templates (id, name, scope, owner_id, created_by)
      VALUES (10, 'Drifted template', NULL, NULL, 1);
  `);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe('Migration 173 — packing template ownership scopes', () => {
  it('backfills legacy rows as instance templates and preserves the child graph', () => {
    const db = createLegacyPackingTemplateDb();

    runMigrations(db);

    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 173 });
    expect(db.prepare('SELECT * FROM packing_templates WHERE id = 10').get()).toMatchObject({
      id: 10,
      name: 'Legacy template',
      scope: 'instance',
      owner_id: null,
      created_by: 1,
      created_at: '2026-07-01 00:00:00',
    });
    expect(db.prepare('SELECT template_id FROM packing_template_categories WHERE id = 20').get()).toEqual({
      template_id: 10,
    });
    expect(db.prepare('SELECT category_id FROM packing_template_items WHERE id = 30').get()).toEqual({
      category_id: 20,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_packing_templates_scope_owner_created'",
      )
      .get();
    expect(index).toEqual({ name: 'idx_packing_templates_scope_owner_created' });
  });

  it('enforces scope ownership and separates attribution from lifecycle ownership', () => {
    const db = createLegacyPackingTemplateDb();
    runMigrations(db);

    expect(() =>
      db
        .prepare(
          "INSERT INTO packing_templates (name, scope, owner_id, created_by) VALUES ('Bad personal', 'personal', NULL, 2)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO packing_templates (name, scope, owner_id, created_by) VALUES ('Bad instance', 'instance', 2, 2)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    const personalId = Number(
      db
        .prepare(
          "INSERT INTO packing_templates (name, scope, owner_id, created_by) VALUES ('Personal', 'personal', 2, 2)",
        )
        .run().lastInsertRowid,
    );
    const personalCategoryId = Number(
      db
        .prepare('INSERT INTO packing_template_categories (template_id, name) VALUES (?, ?)')
        .run(personalId, 'Private gear').lastInsertRowid,
    );
    db.prepare('INSERT INTO packing_template_items (category_id, name) VALUES (?, ?)').run(
      personalCategoryId,
      'Private item',
    );

    db.prepare('DELETE FROM users WHERE id = 1').run();
    expect(db.prepare('SELECT created_by FROM packing_templates WHERE id = 10').get()).toEqual({ created_by: null });
    expect(db.prepare('SELECT id FROM packing_template_categories WHERE template_id = 10').get()).toEqual({ id: 20 });

    db.prepare('DELETE FROM users WHERE id = 2').run();
    expect(db.prepare('SELECT id FROM packing_templates WHERE id = ?').get(personalId)).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM packing_template_categories WHERE id = ?').get(personalCategoryId),
    ).toBeUndefined();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    runMigrations(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM packing_templates').get()).toEqual({ count: 1 });
  });

  it('preserves scoped rows when a completed migration is retried with a stale version marker', () => {
    const db = createLegacyPackingTemplateDb();
    runMigrations(db);

    db.prepare(
      "INSERT INTO packing_templates (id, name, scope, owner_id, created_by) VALUES (11, 'Private retry', 'personal', 2, 2)",
    ).run();
    db.prepare('UPDATE schema_version SET version = 172').run();

    runMigrations(db);

    expect(db.prepare('SELECT scope, owner_id FROM packing_templates WHERE id = 11').get()).toEqual({
      scope: 'personal',
      owner_id: 2,
    });
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 173 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('fails closed when the version marker is ahead of the legacy schema', () => {
    const db = createLegacyPackingTemplateDb();
    db.prepare('UPDATE schema_version SET version = 173').run();

    expect(() => runMigrations(db)).toThrow(/packing_templates schema does not match migration 173/);
  });

  it('fails closed for nullable scope, missing checks, or mismatched ownership foreign keys', () => {
    const db = createDriftedScopedPackingTemplateDb();

    expect(() => runMigrations(db)).toThrow(/packing_templates schema does not match migration 173/);
  });

  it('fails closed when the scoped template child graph contains an orphan', () => {
    const db = createLegacyPackingTemplateDb();
    runMigrations(db);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      "INSERT INTO packing_template_categories (id, template_id, name, sort_order) VALUES (21, 999, 'Orphan', 0)",
    ).run();
    db.exec('PRAGMA foreign_keys = ON');

    expect(() => runMigrations(db)).toThrow(/packing template graph contains .* foreign key violation/);
  });
});
