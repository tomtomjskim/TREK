import { readEnv } from '../app-config';
import { confirmSessionRevocationStoreHealth } from '../nest/auth/session-revocation';
import { assertNoInterruptedRestore } from '../nest/backup/restore-journal';
import { assertRestoreAccessAllowed } from '../nest/backup/restore-quiescence';
import { Place, Tag } from '../types';
import { applyDurabilityPragmas } from './durability';
import { assertSchemaCompatibility, runMigrations } from './migrationRunner';
import { createTables } from './schema';
import { runSeeds } from './seeds';

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// In test mode each vitest worker gets an isolated in-memory DB so that
// parallel forks can't race on the same file or share migration state.
const isTest = readEnv().app.isTest;

const defaultDataDir = path.join(__dirname, '../../data');
let dbPath: string;
if (isTest) {
  dbPath = ':memory:';
} else if (readEnv().db.trekDbFile) {
  // Explicit DB file (used by the Playwright E2E harness to run against an
  // isolated, throwaway database instead of the real data/travel.db). Purely
  // additive — when unset the default path below is used exactly as before.
  dbPath = readEnv().db.trekDbFile!;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} else {
  if (!fs.existsSync(defaultDataDir)) {
    fs.mkdirSync(defaultDataDir, { recursive: true });
  }
  dbPath = path.join(defaultDataDir, 'travel.db');
}

/** The single authoritative SQLite file used by backup/restore and diagnostics. */
function getDatabaseFilePath(): string {
  return dbPath;
}

let _db: Database.Database | null = null;

function initDb(): void {
  if (_db) {
    try {
      _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {}
    try {
      _db.close();
    } catch (e) {}
    _db = null;
  }

  _db = new Database(dbPath);
  // Ahead of the journal switch now: changing journal_mode needs an exclusive
  // lock, which a sibling process (reset-admin, the rotation script) may hold.
  _db.exec('PRAGMA busy_timeout = 5000');
  const durability = applyDurabilityPragmas(_db);
  _db.exec('PRAGMA foreign_keys = ON');
  // Reported so an operator can see whether their setting took — the test DB is
  // :memory: and has no journal file, so there is nothing to report there.
  if (dbPath !== ':memory:') {
    console.log(`[DB] journal_mode=${durability.journalMode}, synchronous=${durability.synchronous}`);
  }

  // createTables contains CREATE/ALTER-compatible writes. Refuse a database
  // produced by a newer official/fork lane before that first schema mutation.
  assertSchemaCompatibility(_db);
  createTables(_db);
  runMigrations(_db);

  runSeeds(_db);
  // A logout writes a one-way filesystem journal record before its SQLite
  // tombstone. Replay any record left by a crash/storage error before Nest can
  // accept authenticated traffic in this process.
  confirmSessionRevocationStoreHealth(_db);
}

// A previous process may have died between restore phases. Never open and
// migrate that potentially mixed DB silently; committed leftovers are only
// post-commit garbage and are reaped by this preflight.
if (!isTest) assertNoInterruptedRestore(defaultDataDir);
initDb();

const db = new Proxy({} as Database.Database, {
  get(_, prop: string | symbol) {
    assertRestoreAccessAllowed();
    if (!_db) throw new Error('Database connection is not available (restore in progress?)');
    const val = (_db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === 'function' ? val.bind(_db) : val;
  },
  set(_, prop: string | symbol, val: unknown) {
    (_db as unknown as Record<string | symbol, unknown>)[prop] = val;
    return true;
  },
});

if (readEnv().demo.enabled) {
  try {
    const { seedDemoData } = require('../demo/demo-seed');
    seedDemoData(_db);
  } catch (err: unknown) {
    console.error('[Demo] Seed error:', err instanceof Error ? err.message : err);
  }
}

function closeDb(): void {
  if (_db) {
    try {
      _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {}
    try {
      _db.close();
    } catch (e) {}
    _db = null;
    console.log('[DB] Database connection closed');
  }
}

function reinitialize(): void {
  console.log('[DB] Reinitializing database connection after restore...');
  if (_db) closeDb();
  initDb();
  console.log('[DB] Database reinitialized successfully');
}

interface PlaceWithCategory extends Place {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

interface PlaceWithTags extends Place {
  category: { id: number; name: string; color: string; icon: string } | null;
  tags: Tag[];
  ratings: { user_id: number; username: string; avatar: string | null; rating: number }[];
  rating_avg: number | null;
  rating_count: number;
}

function getPlaceWithTags(placeId: number | string): PlaceWithTags | null {
  const place = db
    .prepare(
      `
    SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `,
    )
    .get(placeId) as PlaceWithCategory | undefined;

  if (!place) return null;

  const tags = db
    .prepare(
      `
    SELECT t.* FROM tags t
    JOIN place_tags pt ON t.id = pt.tag_id
    WHERE pt.place_id = ?
  `,
    )
    .all(placeId) as Tag[];

  // Collaborative ratings (#1435): every voter with username/avatar for the
  // who-voted tooltip; the displayed value is the average.
  const ratings = db
    .prepare(
      `
    SELECT pr.user_id, u.username, u.avatar, pr.rating FROM place_ratings pr
    JOIN users u ON pr.user_id = u.id
    WHERE pr.place_id = ? ORDER BY pr.created_at
  `,
    )
    .all(placeId) as { user_id: number; username: string; avatar: string | null; rating: number }[];

  return {
    ...place,
    category: place.category_id
      ? {
          id: place.category_id,
          name: place.category_name!,
          color: place.category_color!,
          icon: place.category_icon!,
        }
      : null,
    tags,
    ratings,
    rating_avg: ratings.length > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length : null,
    rating_count: ratings.length,
  };
}

interface TripAccess {
  id: number;
  user_id: number;
  currency: string | null;
}

function canAccessTrip(tripId: number | string, userId: number): TripAccess | undefined {
  return db
    .prepare(
      `
    SELECT t.id, t.user_id, t.currency FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
  `,
    )
    .get(userId, tripId, userId) as TripAccess | undefined;
}

function isOwner(tripId: number | string, userId: number): boolean {
  return !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

export { db, closeDb, reinitialize, getDatabaseFilePath, getPlaceWithTags, canAccessTrip, isOwner };
export type { TripAccess, PlaceWithTags };
