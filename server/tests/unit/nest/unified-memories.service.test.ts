/**
 * Unit tests for UnifiedMemoriesService — MEM-UNIFIED-001 to MEM-UNIFIED-010.
 * Moved 1:1 with the fold; the free functions became methods.
 * Covers error paths: access denied, disabled provider, no providers enabled.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// ── DB setup ─────────────────────────────────────────────────────────────────

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`
        SELECT t.id FROM trips t
        LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
        WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
      `).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn() }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrationRunner';
import { resetTestDb, setAddonEnabled } from '../../helpers/test-db';
import { addAlbumLink, addTripPhoto, createUser, createTrip } from '../../helpers/factories';
import { ADDON_IDS } from '../../../src/addons';
import { AddonsService } from '../../../src/nest/addons/addons.service';
import { UnifiedMemoriesService } from '../../../src/nest/memories/unified-memories.service';
import { MemoriesAccessService } from '../../../src/nest/memories/memories-access.service';
import { TrekPhotosRepository } from '../../../src/nest/photos/trek-photos.repository';
import { DatabaseService } from '../../../src/nest/database/database.service';
import type { ImmichService } from '../../../src/nest/memories/immich.service';
import type { SynologyService } from '../../../src/nest/memories/synology.service';
import { notificationsStub } from '../../helpers/notifications';

// The album-sync paths are the providers' half and have their own suites; these
// cases never reach them, so stubs keep the graph small.
const dbs = new DatabaseService(testDb);
const svc = new UnifiedMemoriesService(
  dbs,
  new TrekPhotosRepository(dbs),
  {} as ImmichService,
  {} as SynologyService,
  new MemoriesAccessService(dbs),
  notificationsStub(),
  new AddonsService(dbs),
);

// Legacy free-function names bound to the service, so the moved cases read as before.
const listTripPhotos = svc.listTripPhotos.bind(svc);
const listTripAlbumLinks = svc.listTripAlbumLinks.bind(svc);
const addTripPhotos = svc.addTripPhotos.bind(svc);
const setTripPhotoSharing = svc.setTripPhotoSharing.bind(svc);
const removeTripPhoto = svc.removeTripPhoto.bind(svc);
const createTripAlbumLink = svc.createTripAlbumLink.bind(svc);
const removeAlbumLink = svc.removeAlbumLink.bind(svc);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  // Ensure default providers are enabled (resetTestDb seeds them but doesn't reset enabled flag)
  testDb.prepare('UPDATE photo_providers SET enabled = 1').run();
  // Providers only count as enabled under an enabled journey addon (migration 84 seeds it off).
  setAddonEnabled(testDb, ADDON_IDS.JOURNEY, true);
});

afterAll(() => {
  testDb.close();
});

// ── listTripPhotos ────────────────────────────────────────────────────────────

describe('listTripPhotos', () => {
  it('MEM-UNIFIED-001: returns 404 when user cannot access trip', () => {
    const result = listTripPhotos('9999', 1);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-002: returns 400 when no photo providers are enabled', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // Disable all providers
    testDb.prepare('UPDATE photo_providers SET enabled = 0').run();

    const result = listTripPhotos(String(trip.id), user.id);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/no photo providers enabled/i);
  });

  it('MEM-UNIFIED-013: treats enabled providers as disabled while the journey addon is off', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    setAddonEnabled(testDb, ADDON_IDS.JOURNEY, false);

    const result = listTripPhotos(String(trip.id), user.id);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/no photo providers enabled/i);
  });
});

// ── listTripAlbumLinks ────────────────────────────────────────────────────────

describe('listTripAlbumLinks', () => {
  it('MEM-UNIFIED-003: returns 404 when user cannot access trip', () => {
    const result = listTripAlbumLinks('9999', 1);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-004: returns 400 when no photo providers are enabled', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    testDb.prepare('UPDATE photo_providers SET enabled = 0').run();

    const result = listTripAlbumLinks(String(trip.id), user.id);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
  });
});

// ── addTripPhotos ─────────────────────────────────────────────────────────────

describe('addTripPhotos', () => {
  it('MEM-UNIFIED-005: returns 404 when user cannot access trip', async () => {
    const result = await addTripPhotos('9999', 1, false, [{ provider: 'immich', asset_ids: ['a1'] }], 'sid');
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-006: returns 400 when provider is found but disabled (covers line 25)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // Insert a disabled provider
    testDb.prepare(
      'INSERT OR IGNORE INTO photo_providers (id, name, description, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('disabled-prov', 'Disabled', 'Disabled provider', 'Image', 0, 99);

    const result = await addTripPhotos(
      String(trip.id),
      user.id,
      false,
      [{ provider: 'disabled-prov', asset_ids: ['asset-x'] }],
      'sid',
    );

    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/not enabled/i);
  });

  it('MEM-UNIFIED-007: returns 400 when provider is not found', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const result = await addTripPhotos(
      String(trip.id),
      user.id,
      false,
      [{ provider: 'nonexistent-provider', asset_ids: ['asset-x'] }],
      'sid',
    );

    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/not supported/i);
  });
});

// ── setTripPhotoSharing ───────────────────────────────────────────────────────

describe('setTripPhotoSharing', () => {
  it('MEM-UNIFIED-008: returns 404 when user cannot access trip', async () => {
    const result = await setTripPhotoSharing('9999', 1, 'immich', 'asset-1', true);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-014: Journey addon off refuses sharing without mutating the row', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const photo = addTripPhoto(testDb, trip.id, user.id, 'asset-addon-off-sharing', 'immich');
    const photoId = (testDb.prepare('SELECT id FROM trek_photos WHERE provider = ? AND asset_id = ?').get('immich', photo.asset_id) as { id: number }).id;
    setAddonEnabled(testDb, ADDON_IDS.JOURNEY, false);

    const result = await svc.setTripPhotoSharing(String(trip.id), user.id, photoId, true);

    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/journey addon is not enabled/i);
    expect((testDb.prepare('SELECT shared FROM trip_photos WHERE trip_id = ? AND photo_id = ?').get(trip.id, photoId) as { shared: number }).shared).toBe(0);
  });
});

// ── removeTripPhoto ───────────────────────────────────────────────────────────

describe('removeTripPhoto', () => {
  it('MEM-UNIFIED-009: returns 404 when user cannot access trip', () => {
    const result = removeTripPhoto('9999', 1, 'immich', 'asset-1');
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-015: Journey addon off refuses removal without deleting the row', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const photo = addTripPhoto(testDb, trip.id, user.id, 'asset-addon-off-remove', 'immich');
    const photoId = (testDb.prepare('SELECT id FROM trek_photos WHERE provider = ? AND asset_id = ?').get('immich', photo.asset_id) as { id: number }).id;
    setAddonEnabled(testDb, ADDON_IDS.JOURNEY, false);

    const result = svc.removeTripPhoto(String(trip.id), user.id, photoId);

    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/journey addon is not enabled/i);
    expect(testDb.prepare('SELECT 1 FROM trip_photos WHERE trip_id = ? AND photo_id = ?').get(trip.id, photoId)).toBeTruthy();
    expect(testDb.prepare('SELECT 1 FROM trek_photos WHERE id = ?').get(photoId)).toBeTruthy();
  });
});

// ── createTripAlbumLink ───────────────────────────────────────────────────────

describe('createTripAlbumLink', () => {
  it('MEM-UNIFIED-010: returns 404 when user cannot access trip', () => {
    const result = createTripAlbumLink('9999', 1, 'immich', 'album-1', 'My Album');
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-011: returns 400 when provider is disabled', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    testDb.prepare(
      'INSERT OR IGNORE INTO photo_providers (id, name, description, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('disabled-prov2', 'Disabled2', 'desc', 'Image', 0, 100);

    const result = createTripAlbumLink(String(trip.id), user.id, 'disabled-prov2', 'album-1', 'My Album');
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
  });
});

// ── removeAlbumLink ───────────────────────────────────────────────────────────

describe('removeAlbumLink', () => {
  it('MEM-UNIFIED-012: returns 404 when user cannot access trip', () => {
    const result = removeAlbumLink('9999', '1', 1);
    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(404);
  });

  it('MEM-UNIFIED-016: Journey addon off refuses album unlink without deleting link or photos', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const link = addAlbumLink(testDb, trip.id, user.id, 'immich', 'album-addon-off');
    const photo = addTripPhoto(testDb, trip.id, user.id, 'asset-addon-off-link', 'immich', { albumLinkId: link.id });
    const photoId = (testDb.prepare('SELECT id FROM trek_photos WHERE provider = ? AND asset_id = ?').get('immich', photo.asset_id) as { id: number }).id;
    setAddonEnabled(testDb, ADDON_IDS.JOURNEY, false);

    const result = svc.removeAlbumLink(String(trip.id), String(link.id), user.id);

    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/journey addon is not enabled/i);
    expect(testDb.prepare('SELECT 1 FROM trip_album_links WHERE id = ?').get(link.id)).toBeTruthy();
    expect(testDb.prepare('SELECT 1 FROM trip_photos WHERE trip_id = ? AND photo_id = ?').get(trip.id, photoId)).toBeTruthy();
  });
});

describe('album sync addon gate', () => {
  it('MEM-UNIFIED-017: Journey addon off refuses Immich sync before collecting provider assets', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const collect = vi.fn();
    (svc as any).immich = { collectAlbumSelection: collect };
    setAddonEnabled(testDb, ADDON_IDS.JOURNEY, false);

    const result = await svc.syncImmichAlbum(String(trip.id), 'missing-link', user.id, 'sid');

    expect(result.success).not.toBe(true);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/journey addon is not enabled/i);
    expect(collect).not.toHaveBeenCalled();
  });

  it('MEM-UNIFIED-018: Journey addon off refuses Synology sync before collecting provider assets', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const collect = vi.fn();
    (svc as any).synology = { collectSynologyAlbumSelection: collect };
    setAddonEnabled(testDb, ADDON_IDS.JOURNEY, false);

    const result = await svc.syncSynologyAlbum(user.id, String(trip.id), 'missing-link', 'sid');

    expect(result.success).toBe(false);
    expect((result as any).error.status).toBe(400);
    expect((result as any).error.message).toMatch(/journey addon is not enabled/i);
    expect(collect).not.toHaveBeenCalled();
  });
});
