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
});
