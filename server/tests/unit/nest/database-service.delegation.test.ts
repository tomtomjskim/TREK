/**
 * Locks in the delegation direction: DatabaseService's trip-access helpers
 * must call the db/database exports (which e2e suites stub in their vi.mock
 * factories), never reimplement the SQL against the injected connection.
 */
import { afterAll, describe, it, expect, vi } from 'vitest';

const metadataDatabase = vi.hoisted(() => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Database');
  Object.defineProperty(globalThis, 'Database', {
    configurable: true,
    writable: true,
    value: { Database: class Database {} },
  });
  return { previous };
});

const { canAccessTrip, isOwner, getPlaceWithTags } = vi.hoisted(() => ({
  canAccessTrip: vi.fn(() => ({ id: -1, user_id: -2, currency: 'XXX' })),
  isOwner: vi.fn(() => true),
  getPlaceWithTags: vi.fn(() => null),
}));

vi.mock('../../../src/db/database', () => ({
  db: {},
  closeDb: () => {},
  reinitialize: () => {},
  canAccessTrip,
  isOwner,
  getPlaceWithTags,
}));

import { DatabaseService } from '../../../src/nest/database/database.service';

afterAll(() => {
  if (metadataDatabase.previous === undefined) delete (globalThis as { Database?: unknown }).Database;
  else Object.defineProperty(globalThis, 'Database', metadataDatabase.previous);
});

describe('DatabaseService (helper delegation)', () => {
  it('constructs when runtime Database metadata is available', async () => {
    const { db } = await import('../../../src/db/database') as { db: object };
    const svc = new DatabaseService(db as never);

    expect(svc.connection).toBe(db);
  });

  it('routes trip-access helpers through the db/database exports', async () => {
    const { db } = await import('../../../src/db/database');
    const svc = new DatabaseService(db);

    expect(svc.canAccessTrip(7, 8)).toEqual({ id: -1, user_id: -2, currency: 'XXX' });
    expect(canAccessTrip).toHaveBeenCalledWith(7, 8);

    expect(svc.isOwner(7, 8)).toBe(true);
    expect(isOwner).toHaveBeenCalledWith(7, 8);

    expect(svc.getPlaceWithTags(9)).toBeNull();
    expect(getPlaceWithTags).toHaveBeenCalledWith(9);
  });
});
