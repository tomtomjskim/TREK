import { AirportsService } from '../../../src/nest/airports/airports.service';
import { resetRestoreQuiescenceForTests, runInRestoreQuiescence } from '../../../src/nest/backup/restore-quiescence';
import { DatabaseService } from '../../../src/nest/database/database.service';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => resetRestoreQuiescenceForTests());

describe('AirportsService', () => {
  it('AIRPORT-SVC-001: marks a flight with missing metadata for review', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE reservations (id INTEGER PRIMARY KEY, type TEXT, metadata TEXT, reservation_time TEXT, reservation_end_time TEXT, needs_review INTEGER DEFAULT 0); CREATE TABLE reservation_endpoints (id INTEGER PRIMARY KEY, reservation_id INTEGER, role TEXT, sequence INTEGER, name TEXT, code TEXT, lat REAL, lng REAL, timezone TEXT, local_time TEXT, local_date TEXT);',
    );
    db.prepare("INSERT INTO reservations (id, type, metadata) VALUES (1, 'flight', NULL)").run();
    new AirportsService(new DatabaseService(db)).backfillFlightEndpoints();
    expect(db.prepare('SELECT needs_review FROM reservations WHERE id = 1').get()).toEqual({ needs_review: 1 });
    db.close();
  });

  it('AIRPORT-SVC-004: backfills a valid flight with both endpoints and keeps review clear', () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE reservations (id INTEGER PRIMARY KEY, type TEXT, metadata TEXT, reservation_time TEXT, reservation_end_time TEXT, needs_review INTEGER DEFAULT 0); CREATE TABLE reservation_endpoints (id INTEGER PRIMARY KEY, reservation_id INTEGER, role TEXT, sequence INTEGER, name TEXT, code TEXT, lat REAL, lng REAL, timezone TEXT, local_time TEXT, local_date TEXT);',
    );
    db.prepare(
      "INSERT INTO reservations (id, type, metadata, reservation_time, reservation_end_time, needs_review) VALUES (?, 'flight', ?, ?, ?, 0)",
    ).run(
      1,
      JSON.stringify({ departure_airport: 'JFK-legacy', arrival_airport: 'LHR-legacy' }),
      '2026-09-05T08:15:00Z',
      '2026-09-05T20:30:00Z',
    );

    new AirportsService(new DatabaseService(db)).backfillFlightEndpoints();

    expect(db.prepare('SELECT needs_review FROM reservations WHERE id = 1').get()).toEqual({ needs_review: 0 });
    expect(
      db
        .prepare(
          'SELECT role, sequence, name, code, timezone, local_time, local_date FROM reservation_endpoints ORDER BY sequence',
        )
        .all(),
    ).toEqual([
      {
        role: 'from',
        sequence: 0,
        name: 'New York (JFK)',
        code: 'JFK',
        timezone: 'America/New_York',
        local_time: '08:15',
        local_date: '2026-09-05',
      },
      {
        role: 'to',
        sequence: 1,
        name: 'London (LHR)',
        code: 'LHR',
        timezone: 'Europe/London',
        local_time: '20:30',
        local_date: '2026-09-05',
      },
    ]);
    db.close();
  });

  it('AIRPORT-SVC-002: skips bootstrap backfill when restore owns the blocked window', async () => {
    let release!: () => void;
    const restore = runInRestoreQuiescence(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();

    const prepare = vi.fn();
    const service = new AirportsService({ prepare } as unknown as DatabaseService);
    service.onApplicationBootstrap();
    await Promise.resolve();

    expect(prepare).not.toHaveBeenCalled();
    release();
    await restore;
  });

  it('AIRPORT-SVC-003: runs the tracked backfill callback on bootstrap when restore is not blocking', async () => {
    const db = new Database(':memory:');
    const service = new AirportsService(new DatabaseService(db));
    const backfill = vi.spyOn(service, 'backfillFlightEndpoints').mockImplementation(() => undefined);

    service.onApplicationBootstrap();
    await Promise.resolve();

    expect(backfill).toHaveBeenCalledOnce();
    db.close();
  });

  it('AIRPORT-SVC-005: delegates search and IATA lookup to the airport dataset helpers', () => {
    const db = new Database(':memory:');
    const service = new AirportsService(new DatabaseService(db));

    expect(service.search('ber').map((airport) => airport.iata)).toContain('BER');
    expect(service.findByIata('jfk')?.city).toBe('New York');
    db.close();
  });
});
