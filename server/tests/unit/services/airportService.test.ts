import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { bootstrapDb, dbMock } = vi.hoisted(() => {
  const BetterSqlite3 = require('better-sqlite3');
  const database = new BetterSqlite3(':memory:');
  database.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY,
      type TEXT,
      metadata TEXT,
      reservation_time TEXT,
      reservation_end_time TEXT,
      needs_review INTEGER DEFAULT 0
    );
    CREATE TABLE reservation_endpoints (
      id INTEGER PRIMARY KEY,
      reservation_id INTEGER,
      role TEXT,
      sequence INTEGER,
      name TEXT,
      code TEXT,
      lat REAL,
      lng REAL,
      timezone TEXT,
      local_time TEXT,
      local_date TEXT
    );
  `);
  return { bootstrapDb: database, dbMock: { db: database } };
});

vi.mock('../../../src/db/database', () => dbMock);

import { backfillFlightEndpoints } from '../../../src/services/airportService';

let targetDb: Database.Database;

beforeAll(() => {
  targetDb = new Database(':memory:');
  targetDb.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY,
      type TEXT,
      metadata TEXT,
      reservation_time TEXT,
      reservation_end_time TEXT,
      needs_review INTEGER DEFAULT 0
    );
    CREATE TABLE reservation_endpoints (
      id INTEGER PRIMARY KEY,
      reservation_id INTEGER,
      role TEXT,
      sequence INTEGER,
      name TEXT,
      code TEXT,
      lat REAL,
      lng REAL,
      timezone TEXT,
      local_time TEXT,
      local_date TEXT
    );
  `);
});

afterAll(() => {
  targetDb.close();
  bootstrapDb.close();
});

describe('backfillFlightEndpoints', () => {
  it('uses the supplied database connection instead of bootstrap-global state', () => {
    targetDb.prepare(
      "INSERT INTO reservations (id, type, metadata, needs_review) VALUES (1, 'flight', NULL, 0)",
    ).run();

    const runBackfill = backfillFlightEndpoints as unknown as (
      database: Database.Database,
    ) => void;
    runBackfill(targetDb);

    const row = targetDb.prepare('SELECT needs_review FROM reservations WHERE id = 1').get() as {
      needs_review: number;
    };
    expect(row.needs_review).toBe(1);
  });
});
