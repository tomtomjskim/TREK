/**
 * Unit tests for JourneyShareService — focused public-share and asset-access regressions.
 * Uses a real in-memory SQLite DB so SQL logic is exercised faithfully.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// -- DB setup -----------------------------------------------------------------

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
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrationRunner';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createJourney, createJourneyEntry, addJourneyContributor } from '../../helpers/factories';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import { TrekPhotosRepository } from '../../../src/nest/photos/trek-photos.repository';
import { JourneyDomainService } from '../../../src/nest/journey/journey-domain.service';
import { JourneyShareService } from '../../../src/nest/journey/journey-share.service';
import { db as dbConn } from '../../../src/db/database';

const dbs = new DatabaseService(dbConn);
const svc = new JourneyShareService(
  dbs,
  new JourneyDomainService(dbs, new RealtimeService(), new TrekPhotosRepository(dbs)),
);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  testDb.close();
});

// -- Helpers ------------------------------------------------------------------

/** Insert a trek_photos + journey_photos (gallery) + journey_entry_photos row and return the trek_photos id (used as photoId in public URLs). */
function insertJourneyPhoto(
  entryId: number,
  opts: { filePath?: string; assetId?: string; ownerId?: number } = {}
): number {
  const provider = opts.assetId ? 'immich' : 'local';
  const filePath = !opts.assetId ? (opts.filePath ?? '/photos/test.jpg') : null;
  const trekResult = testDb.prepare(`
    INSERT INTO trek_photos (provider, asset_id, file_path, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(provider, opts.assetId ?? null, filePath, opts.ownerId ?? null, Date.now());
  const trekId = trekResult.lastInsertRowid as number;

  // Look up journey_id from entry so gallery row is keyed to the journey (not entry).
  const entryRow = testDb.prepare('SELECT journey_id FROM journey_entries WHERE id = ?').get(entryId) as { journey_id: number };
  const journeyId = entryRow.journey_id;
  const now = Date.now();

  testDb.prepare(`
    INSERT OR IGNORE INTO journey_photos (journey_id, photo_id, caption, sort_order, created_at)
    VALUES (?, ?, NULL, 0, ?)
  `).run(journeyId, trekId, now);

  const galleryRow = testDb.prepare('SELECT id FROM journey_photos WHERE journey_id = ? AND photo_id = ?').get(journeyId, trekId) as { id: number };

  testDb.prepare(`
    INSERT OR IGNORE INTO journey_entry_photos (entry_id, journey_photo_id, sort_order, created_at)
    VALUES (?, ?, 0, ?)
  `).run(entryId, galleryRow.id, now);

  // Return trek_photos.id — this is p.photo_id in the public API response
  // and the value the client sends to /api/public/journey/:token/photos/:photoId/:kind
  return trekId;
}

// -- Tests --------------------------------------------------------------------

describe('createOrUpdateJourneyShareLink', () => {
  it('JOURNEY-SHARE-001: creates a new share link with default permissions', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    const result = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    expect(result.created).toBe(true);
    expect(result.token).toBeTruthy();
    expect(result.token.length).toBeGreaterThan(10);
  });

  it('JOURNEY-SHARE-002: creates a share link with custom permissions', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: false,
    });

    const link = svc.getJourneyShareLink(journey.id);
    expect(link).not.toBeNull();
    expect(link!.share_timeline).toBe(true);
    expect(link!.share_gallery).toBe(false);
    expect(link!.share_map).toBe(false);
  });

  it('JOURNEY-SHARE-003: updates permissions on existing link without regenerating token', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    const first = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: true,
      share_map: true,
    });
    const second = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: false,
    });

    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);

    const link = svc.getJourneyShareLink(journey.id);
    expect(link!.share_gallery).toBe(false);
    expect(link!.share_map).toBe(false);
  });

  it('JOURNEY-SHARE-029: reading the link separates "no link" from "not yours"', () => {
    const { user: owner } = createUser(testDb);
    const { user: helper } = createUser(testDb);
    const journey = createJourney(testDb, owner.id);
    addJourneyContributor(testDb, journey.id, helper.id, 'editor');

    // Nothing published yet: an owner is allowed to look and finds nothing.
    expect(svc.readJourneyShareLink(journey.id, owner.id)).toEqual({ allowed: true, link: null });

    svc.createOrUpdateJourneyShareLink(journey.id, owner.id, {});
    const asOwner = svc.readJourneyShareLink(journey.id, owner.id);
    expect(asOwner.allowed).toBe(true);
    expect(asOwner.allowed && asOwner.link?.token).toBeTruthy();

    // An editor is refused outright. Answering { link: null } here would tell a
    // published journey's editor it is unpublished and offer to publish it.
    expect(svc.readJourneyShareLink(journey.id, helper.id)).toEqual({ allowed: false });
  });

  it('JOURNEY-SHARE-027: an update leaves out flags it was not given', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: false,
      newest_first: true,
    });
    // A caller that only flips the timeline must not silently re-publish the
    // gallery and map at the unchanged token.
    svc.createOrUpdateJourneyShareLink(journey.id, user.id, { share_timeline: false });

    const link = svc.getJourneyShareLink(journey.id);
    expect(link!.share_timeline).toBe(false);
    expect(link!.share_gallery).toBe(false);
    expect(link!.share_map).toBe(false);
    expect(link!.newest_first).toBe(true);
  });

  it('JOURNEY-SHARE-028: newest_first survives a flag-only update and is settable', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});
    expect(svc.getJourneyShareLink(journey.id)!.newest_first).toBe(false);

    svc.createOrUpdateJourneyShareLink(journey.id, user.id, { newest_first: true });
    expect(svc.getJourneyShareLink(journey.id)!.newest_first).toBe(true);

    svc.createOrUpdateJourneyShareLink(journey.id, user.id, { share_gallery: false });
    expect(svc.getJourneyShareLink(journey.id)!.newest_first).toBe(true);
  });

  it('JOURNEY-SHARE-004: different journeys get different tokens', () => {
    const { user } = createUser(testDb);
    const j1 = createJourney(testDb, user.id);
    const j2 = createJourney(testDb, user.id);

    const r1 = svc.createOrUpdateJourneyShareLink(j1.id, user.id, {});
    const r2 = svc.createOrUpdateJourneyShareLink(j2.id, user.id, {});

    expect(r1.token).not.toBe(r2.token);
  });
});

describe('getJourneyShareLink', () => {
  it('JOURNEY-SHARE-005: returns null when no share link exists', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    const result = svc.getJourneyShareLink(journey.id);

    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-006: returns share link info when it exists', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: false,
      share_map: true,
    });

    const result = svc.getJourneyShareLink(journey.id);

    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.share_timeline).toBe(true);
    expect(result!.share_gallery).toBe(false);
    expect(result!.share_map).toBe(true);
    expect(result!.created_at).toBeTruthy();
  });
});

describe('deleteJourneyShareLink', () => {
  it('JOURNEY-SHARE-007: owner can remove an existing share link', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const ok = svc.deleteJourneyShareLink(journey.id, user.id);

    expect(ok).toBe(true);
    expect(svc.getJourneyShareLink(journey.id)).toBeNull();
  });

  it('JOURNEY-SHARE-008: does not throw when deleting non-existent link', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);

    expect(() => svc.deleteJourneyShareLink(journey.id, user.id)).not.toThrow();
  });
});

describe('validateShareTokenForPhoto', () => {
  it('JOURNEY-SHARE-009: returns journeyId and ownerId for valid token + photo', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    const photoId = insertJourneyPhoto(entry.id, { ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.validateShareTokenForPhoto(token, photoId);

    expect(result).not.toBeNull();
    expect(result!.journeyId).toBe(journey.id);
    expect(result!.ownerId).toBe(user.id);
  });

  it('JOURNEY-SHARE-010: returns null for invalid token', () => {
    const result = svc.validateShareTokenForPhoto('nonexistent-token', 1);
    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-011: returns null when photo does not belong to shared journey', () => {
    const { user } = createUser(testDb);
    const journey1 = createJourney(testDb, user.id);
    const journey2 = createJourney(testDb, user.id);
    const entry2 = createJourneyEntry(testDb, journey2.id, user.id);
    const photoId = insertJourneyPhoto(entry2.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey1.id, user.id, {});

    const result = svc.validateShareTokenForPhoto(token, photoId);

    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-012: falls back to journey owner_id when photo has no owner_id', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    const photoId = insertJourneyPhoto(entry.id, { ownerId: undefined });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.validateShareTokenForPhoto(token, photoId);

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
  });

  // Regression — GHSA-9hc8 sibling: the byte proxy must honour share_gallery.
  it('JOURNEY-SHARE-017: returns null when the owner disabled the gallery (share_gallery=false)', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    const photoId = insertJourneyPhoto(entry.id, { ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, { share_timeline: true, share_gallery: false, share_map: true });

    expect(svc.validateShareTokenForPhoto(token, photoId)).toBeNull();
  });

  it('JOURNEY-SHARE-016: resolves correctly when trek_photos.id differs from journey_photos.id (Immich bulk-sync scenario)', () => {
    // Simulate a user who has many trek_photos from Immich syncs before adding a journey photo.
    // trek_photos.id will be higher than journey_photos.id — the previous bug matched on jp.id
    // instead of jp.photo_id, causing a 404 for Immich photos in public shares.
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });

    // Pre-populate trek_photos to push the autoincrement higher
    for (let i = 0; i < 5; i++) {
      testDb.prepare(`INSERT INTO trek_photos (provider, asset_id, owner_id, created_at) VALUES ('immich', ?, ?, ?)`).run(`bulk-asset-${i}`, user.id, Date.now());
    }

    // This trek_photos row gets a high id (e.g. 6) while journey_photos id will be 1
    const trekPhotoId = insertJourneyPhoto(entry.id, { assetId: 'journey-asset-xyz', ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    // photoId = trek_photos.id (6), not journey_photos.id (1)
    const result = svc.validateShareTokenForPhoto(token, trekPhotoId);

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
    expect(result!.journeyId).toBe(journey.id);
  });
});

describe('validateShareTokenForAsset', () => {
  it('JOURNEY-SHARE-013: returns ownerId when asset belongs to shared journey', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    insertJourneyPhoto(entry.id, { assetId: 'immich-asset-123', ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.validateShareTokenForAsset(token, 'immich', 'immich-asset-123');

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
  });

  it('JOURNEY-SHARE-014: returns null for invalid token', () => {
    const result = svc.validateShareTokenForAsset('bad-token', 'immich', 'some-asset');
    expect(result).toBeNull();
  });

  // Regression — GHSA-9hc8 sibling: the asset proxy must honour share_gallery.
  it('JOURNEY-SHARE-018: returns null when the owner disabled the gallery (share_gallery=false)', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    insertJourneyPhoto(entry.id, { assetId: 'immich-asset-999', ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, { share_timeline: true, share_gallery: false, share_map: true });

    expect(svc.validateShareTokenForAsset(token, 'immich', 'immich-asset-999')).toBeNull();
  });

  it('JOURNEY-SHARE-029: falls back to the journey owner when the photo has no owner_id', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    insertJourneyPhoto(entry.id, { assetId: 'immich-asset-orphan' });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    // Without the fallback the controller filled the gap from the :ownerId path
    // segment, i.e. an anonymous caller picked whose provider credentials to try.
    const result = svc.validateShareTokenForAsset(token, 'immich', 'immich-asset-orphan');

    expect(result).not.toBeNull();
    expect(result!.ownerId).toBe(user.id);
  });

  it('JOURNEY-SHARE-015: denies (returns null) when the asset is not part of the shared journey', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    // A valid share token must NOT resolve arbitrary asset IDs to the owner —
    // otherwise it could proxy any asset out of the owner's Immich/Synology
    // library (IDOR). Only assets actually in the journey may resolve.
    const result = svc.validateShareTokenForAsset(token, 'immich', 'nonexistent-asset');

    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-033: denies a provider mismatch for an asset in the shared journey', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, { visibility: 'shared' });
    insertJourneyPhoto(entry.id, { assetId: 'provider-bound-asset', ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    expect(svc.validateShareTokenForAsset(token, 'synologyphotos', 'provider-bound-asset')).toBeNull();
    expect(svc.validateShareTokenForAsset(token, 'immich', 'provider-bound-asset')).not.toBeNull();
  });
});

describe('getPublicJourney', () => {
  it('JOURNEY-SHARE-016: returns null for invalid token', () => {
    const result = svc.getPublicJourney('invalid-token');
    expect(result).toBeNull();
  });

  it('JOURNEY-SHARE-017: returns journey data with entries, stats, and permissions', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id, {
      title: 'Japan 2026',
      subtitle: 'Cherry blossom season',
    });
    const entry1 = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      title: 'Arrived in Tokyo',
      entry_date: '2026-03-20',
      location_name: 'Tokyo',
      visibility: 'shared',
    });
    createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      title: 'Kyoto Day Trip',
      entry_date: '2026-03-22',
      location_name: 'Kyoto',
      visibility: 'public',
    });
    insertJourneyPhoto(entry1.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true,
      share_gallery: true,
      share_map: false,
    });

    const result = svc.getPublicJourney(token);

    expect(result).not.toBeNull();
    expect(result!.journey.title).toBe('Japan 2026');
    expect(result!.journey.subtitle).toBe('Cherry blossom season');
    expect(result!.entries).toHaveLength(2);
    expect(result!.stats.entries).toBe(2);
    expect(result!.stats.photos).toBe(1);
    expect(result!.stats.places).toBe(0);
    expect(result!.permissions.share_timeline).toBe(true);
    expect(result!.permissions.share_gallery).toBe(true);
    expect(result!.permissions.share_map).toBe(false);
  });

  it('JOURNEY-SHARE-018: excludes skeleton entries from public view', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      title: 'Visible Entry',
      entry_date: '2026-01-10',
      visibility: 'shared',
    });
    createJourneyEntry(testDb, journey.id, user.id, {
      type: 'skeleton',
      title: 'Skeleton Entry',
      entry_date: '2026-01-11',
    });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.getPublicJourney(token);

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].title).toBe('Visible Entry');
  });

  it('JOURNEY-SHARE-019: enriches entries with parsed tags and photos', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry',
      entry_date: '2026-04-01',
      visibility: 'shared',
    });
    // Set tags on the entry directly
    testDb.prepare('UPDATE journey_entries SET tags = ? WHERE id = ?')
      .run(JSON.stringify(['food', 'culture']), entry.id);
    insertJourneyPhoto(entry.id, { filePath: '/photos/a.jpg' });
    insertJourneyPhoto(entry.id, { filePath: '/photos/b.jpg' });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.getPublicJourney(token);

    expect(result).not.toBeNull();
    const enriched = result!.entries[0];
    expect(enriched.tags).toEqual(['food', 'culture']);
    expect(enriched.photos).toHaveLength(2);
  });

  it('JOURNEY-SHARE-020: returns empty entries array for journey with no entries', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id, { title: 'Empty Journey' });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.getPublicJourney(token);

    expect(result).not.toBeNull();
    expect(result!.entries).toEqual([]);
    expect(result!.stats.entries).toBe(0);
    expect(result!.stats.photos).toBe(0);
    expect(result!.stats.places).toBe(0);
  });

  it('JOURNEY-SHARE-021: withholds timeline, gallery and GPS when all flags are off', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id, { title: 'Secret' });
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry', title: 'Day 1', story: 'private notes', entry_date: '2026-05-01', location_name: 'Paris', visibility: 'shared',
    });
    testDb.prepare('UPDATE journey_entries SET location_lat = ?, location_lng = ? WHERE id = ?').run(48.8566, 2.3522, entry.id);
    insertJourneyPhoto(entry.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: false, share_gallery: false, share_map: false,
    });

    const result = svc.getPublicJourney(token)!;
    expect(result.entries).toEqual([]); // no timeline / story / GPS leaked
    expect(result.gallery).toEqual([]); // no gallery leaked
    expect(result.stats.entries).toBe(0); // hidden timeline is not counted
  });

  it('JOURNEY-SHARE-031: excludes private entries from public entries and visible stats', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    createJourneyEntry(testDb, journey.id, user.id, {
      title: 'Private diary', story: 'do not publish', entry_date: '2026-05-01',
      location_name: 'Private Place', visibility: 'private',
    });
    createJourneyEntry(testDb, journey.id, user.id, {
      title: 'Shared diary', story: 'publish', entry_date: '2026-05-02',
      location_name: 'Shared Place', visibility: 'shared',
    });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true, share_gallery: false, share_map: true,
    });

    const result = svc.getPublicJourney(token)!;
    expect(result.entries.map((entry: any) => entry.title)).toEqual(['Shared diary']);
    expect(result.stats.entries).toBe(1);
    expect(result.stats.places).toBe(1);
  });

  it('JOURNEY-SHARE-022: shares the timeline but strips GPS when the map flag is off', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry', title: 'Day 1', story: 'notes', entry_date: '2026-05-01', location_name: 'Paris', visibility: 'shared',
    });
    testDb.prepare('UPDATE journey_entries SET location_lat = ?, location_lng = ? WHERE id = ?').run(48.8566, 2.3522, entry.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true, share_gallery: true, share_map: false,
    });

    const result = svc.getPublicJourney(token)!;
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0] as Record<string, unknown>;
    expect(e.story).toBe('notes'); // narrative present
    expect(e.location_lat).toBeNull(); // GPS withheld
    expect(e.location_lng).toBeNull();
  });

  it('JOURNEY-SHARE-023: map-only share exposes coordinates but not the story', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry', title: 'Day 1', story: 'private notes', entry_date: '2026-05-01', location_name: 'Paris', visibility: 'shared',
    });
    testDb.prepare('UPDATE journey_entries SET location_lat = ?, location_lng = ? WHERE id = ?').run(48.8566, 2.3522, entry.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: false, share_gallery: false, share_map: true,
    });

    const result = svc.getPublicJourney(token)!;
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0] as Record<string, unknown>;
    expect(Object.keys(e).sort()).toEqual([
      'entry_date', 'id', 'location_lat', 'location_lng', 'location_name', 'title', 'type',
    ].sort());
    expect(e.location_lat).toBe(48.8566); // coords for the map
    expect(e.story).toBeUndefined(); // narrative withheld
  });

  // #1614 — a photo now carries the coordinates it was taken at. That is a place
  // the owner never typed, so it has to follow the same switch the entry
  // coordinates follow rather than riding in on the gallery flag.
  it('JOURNEY-SHARE-025: withholds photo capture coordinates when the map flag is off', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry', title: 'Day 1', story: 'notes', entry_date: '2026-05-01', visibility: 'shared',
    });
    const trekId = insertJourneyPhoto(entry.id, { ownerId: user.id });
    testDb.prepare('UPDATE trek_photos SET lat = ?, lng = ?, taken_at = ? WHERE id = ?')
      .run(48.8584, 2.2945, '2026-05-01T10:00:00Z', trekId);

    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true, share_gallery: true, share_map: false,
    });

    const result = svc.getPublicJourney(token)!;
    const gallery = result.gallery as Record<string, unknown>[];
    expect(gallery).toHaveLength(1);
    expect(gallery[0].lat).toBeNull();
    expect(gallery[0].lng).toBeNull();
    // The capture time is not a location and stays — it is what a blog view sorts by.
    expect(gallery[0].taken_at).toBe('2026-05-01T10:00:00Z');

    const inline = (result.entries[0] as Record<string, unknown>).photos as Record<string, unknown>[];
    expect(inline[0].lat).toBeNull();
    expect(inline[0].lng).toBeNull();
  });

  it('JOURNEY-SHARE-026: hands out photo coordinates once the map is shared', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry', title: 'Day 1', entry_date: '2026-05-01', visibility: 'shared',
    });
    const trekId = insertJourneyPhoto(entry.id, { ownerId: user.id });
    testDb.prepare('UPDATE trek_photos SET lat = ?, lng = ? WHERE id = ?')
      .run(48.8584, 2.2945, trekId);

    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true, share_gallery: true, share_map: true,
    });

    const gallery = svc.getPublicJourney(token)!.gallery as Record<string, unknown>[];
    expect(gallery[0].lat).toBe(48.8584);
    expect(gallery[0].lng).toBe(2.2945);
  });

  it('JOURNEY-SHARE-024: strips inline entry photos (and their asset metadata) when the gallery is off', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      type: 'entry', title: 'Day 1', story: 'notes', entry_date: '2026-05-01', visibility: 'shared',
    });
    insertJourneyPhoto(entry.id, { ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: true, share_gallery: false, share_map: true,
    });

    const result = svc.getPublicJourney(token)!;
    expect(result.gallery).toEqual([]); // gallery array withheld
    expect(result.entries).toHaveLength(1);
    expect((result.entries[0] as Record<string, unknown>).photos).toEqual([]); // inline photos withheld too
  });

  it('JOURNEY-SHARE-030: never returns a CARTO credential in the public payload (#2054)', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, { share_map: true });

    expect(svc.getPublicJourney(token)!.cartoApiKey).toBe('');
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('default_user_setting_carto_api_key', 'instance-key')").run();
    expect(svc.getPublicJourney(token)!.cartoApiKey).toBe('');
    testDb.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'carto_api_key', ' owner-key ')").run(user.id);
    expect(svc.getPublicJourney(token)!.cartoApiKey).toBe('');
  });

  it('JOURNEY-SHARE-032: projects only fields required by the public client', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const entry = createJourneyEntry(testDb, journey.id, user.id, {
      title: 'Public stop', entry_date: '2026-06-01', visibility: 'public',
    });
    insertJourneyPhoto(entry.id, { assetId: 'private-provider-asset', ownerId: user.id });
    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {});

    const result = svc.getPublicJourney(token)! as any;
    expect(Object.keys(result).sort()).toEqual([
      'cartoApiKey', 'entries', 'gallery', 'journey', 'permissions', 'stats',
    ].sort());
    expect(Object.keys(result.journey).sort()).toEqual([
      'cover_image', 'status', 'subtitle', 'title',
    ].sort());
    expect(Object.keys(result.permissions).sort()).toEqual([
      'newest_first', 'share_gallery', 'share_map', 'share_timeline',
    ].sort());
    expect(Object.keys(result.stats).sort()).toEqual(['entries', 'photos', 'places']);
    expect(Object.keys(result.entries[0]).sort()).toEqual([
      'entry_date', 'entry_time', 'id', 'location_lat', 'location_lng', 'location_name',
      'mood', 'photos', 'pros_cons', 'story', 'tags', 'title', 'type', 'weather',
    ].sort());
    expect(Object.keys(result.entries[0].photos[0]).sort()).toEqual([
      'caption', 'duration_ms', 'entry_id', 'id', 'lat', 'lng', 'media_type', 'photo_id', 'taken_at',
    ].sort());
    expect(Object.keys(result.gallery[0]).sort()).toEqual([
      'caption', 'duration_ms', 'id', 'lat', 'lng', 'media_type', 'photo_id', 'taken_at',
    ].sort());
  });

  it('JOURNEY-SHARE-034: hides private-entry-only photos but keeps explicit gallery photos', () => {
    const { user } = createUser(testDb);
    const journey = createJourney(testDb, user.id);
    const privateEntry = createJourneyEntry(testDb, journey.id, user.id, {
      title: 'Private moment', entry_date: '2026-06-01', visibility: 'private',
    });
    const sharedEntry = createJourneyEntry(testDb, journey.id, user.id, {
      title: 'Shared moment', entry_date: '2026-06-02', visibility: 'shared',
    });
    const galleryEntry = createJourneyEntry(testDb, journey.id, user.id, {
      title: 'Gallery staging', entry_date: '2026-06-03', visibility: 'private',
    });
    const privatePhotoId = insertJourneyPhoto(privateEntry.id, { assetId: 'private-only', ownerId: user.id });
    const sharedPhotoId = insertJourneyPhoto(sharedEntry.id, { assetId: 'shared-entry', ownerId: user.id });
    const galleryPhotoId = insertJourneyPhoto(galleryEntry.id, { assetId: 'gallery-only', ownerId: user.id });
    const foreignJourney = createJourney(testDb, user.id);
    const foreignSharedEntry = createJourneyEntry(testDb, foreignJourney.id, user.id, {
      title: 'Foreign shared entry', entry_date: '2026-06-04', visibility: 'shared',
    });
    const privateGalleryRow = testDb.prepare(
      'SELECT id FROM journey_photos WHERE journey_id = ? AND photo_id = ?',
    ).get(journey.id, privatePhotoId) as { id: number };
    // The normal service rejects this cross-journey link, but imported/corrupt
    // junction data must not turn a private photo into a public one.
    testDb.prepare(`
      INSERT INTO journey_entry_photos (entry_id, journey_photo_id, sort_order, created_at)
      VALUES (?, ?, 0, ?)
    `).run(foreignSharedEntry.id, privateGalleryRow.id, Date.now());
    testDb.prepare(`
      DELETE FROM journey_entry_photos
      WHERE journey_photo_id = (SELECT id FROM journey_photos WHERE journey_id = ? AND photo_id = ?)
    `).run(journey.id, galleryPhotoId);

    // journey_photos.shared is legacy provenance, not a per-photo public switch:
    // direct/provider uploads are intentionally 0 and share_gallery gates them.
    const flags = testDb.prepare('SELECT shared FROM journey_photos WHERE journey_id = ? ORDER BY photo_id')
      .all(journey.id) as Array<{ shared: number }>;
    expect(flags.map(row => row.shared)).toEqual([0, 0, 0]);

    const { token } = svc.createOrUpdateJourneyShareLink(journey.id, user.id, {
      share_timeline: false, share_gallery: true, share_map: true,
    });
    const result = svc.getPublicJourney(token)!;
    const galleryIds = (result.gallery as Array<{ photo_id: number }>).map(photo => photo.photo_id);

    expect(galleryIds).toEqual([sharedPhotoId, galleryPhotoId]);
    expect(result.stats.photos).toBe(2);
    expect(svc.validateShareTokenForPhoto(token, privatePhotoId)).toBeNull();
    expect(svc.validateShareTokenForAsset(token, 'immich', 'private-only')).toBeNull();
    expect(svc.validateShareTokenForPhoto(token, sharedPhotoId)).not.toBeNull();
    expect(svc.validateShareTokenForAsset(token, 'immich', 'shared-entry')).not.toBeNull();
    expect(svc.validateShareTokenForPhoto(token, galleryPhotoId)).not.toBeNull();
    expect(svc.validateShareTokenForAsset(token, 'immich', 'gallery-only')).not.toBeNull();
  });
});
