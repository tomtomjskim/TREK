import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { AirportsService } from '../../../src/nest/airports/airports.service';

describe('AirportsService', () => {
  it('AIRPORT-SVC-001: marks a flight with missing metadata for review', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE reservations (id INTEGER PRIMARY KEY, type TEXT, metadata TEXT, reservation_time TEXT, reservation_end_time TEXT, needs_review INTEGER DEFAULT 0); CREATE TABLE reservation_endpoints (id INTEGER PRIMARY KEY, reservation_id INTEGER, role TEXT, sequence INTEGER, name TEXT, code TEXT, lat REAL, lng REAL, timezone TEXT, local_time TEXT, local_date TEXT);');
    db.prepare("INSERT INTO reservations (id, type, metadata) VALUES (1, 'flight', NULL)").run();
    new AirportsService(new DatabaseService(db)).backfillFlightEndpoints();
    expect(db.prepare('SELECT needs_review FROM reservations WHERE id = 1').get()).toEqual({ needs_review: 1 });
    db.close();
  });
});
