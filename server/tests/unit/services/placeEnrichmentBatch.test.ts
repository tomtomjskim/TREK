import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testDb, searchCandidates, getDetails, usageSnapshot } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      lat REAL,
      lng REAL,
      address TEXT,
      category_id INTEGER,
      notes TEXT,
      google_place_id TEXT,
      google_ftid TEXT,
      website TEXT,
      phone TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return {
    testDb: database,
    searchCandidates: vi.fn(),
    getDetails: vi.fn(),
    usageSnapshot: vi.fn(() => [{ sku: 'text_search_pro', used: 0, cap: 4000, remaining: 4000 }]),
  };
});

vi.mock('../../../src/db/database', () => ({
  db: testDb,
  getPlaceWithTags: (id: number) => testDb.prepare('SELECT * FROM places WHERE id = ?').get(id),
}));
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn() }));
vi.mock('../../../src/services/mapsService', () => ({
  getMapsKey: () => 'configured-key',
  searchPlaceCandidates: searchCandidates,
  getPlaceDetails: getDetails,
  searchPlaces: vi.fn(async () => ({ places: [] })),
  getPlacePhoto: vi.fn(),
}));
vi.mock('../../../src/services/googleApiUsageService', () => ({
  getGoogleApiUsageSnapshot: usageSnapshot,
  GoogleApiQuotaExceededError: class GoogleApiQuotaExceededError extends Error {},
}));

import {
  applyTripPlaceEnrichment,
  previewTripPlaceEnrichment,
} from '../../../src/services/placeEnrichment';

function insertPlace(values: Partial<{
  trip_id: number; name: string; lat: number | null; lng: number | null; address: string | null;
  category_id: number | null; notes: string | null; google_place_id: string | null;
  google_ftid: string | null; website: string | null; phone: string | null;
}> = {}): number {
  const row = {
    trip_id: 1,
    name: 'Cafe Fuji',
    lat: 35,
    lng: 138,
    address: null,
    category_id: null,
    notes: null,
    google_place_id: null,
    google_ftid: null,
    website: null,
    phone: null,
    ...values,
  };
  return Number(testDb.prepare(`
    INSERT INTO places (trip_id, name, lat, lng, address, category_id, notes,
      google_place_id, google_ftid, website, phone)
    VALUES (@trip_id, @name, @lat, @lng, @address, @category_id, @notes,
      @google_place_id, @google_ftid, @website, @phone)
  `).run(row).lastInsertRowid);
}

beforeEach(() => {
  testDb.exec('DELETE FROM places');
  searchCandidates.mockReset();
  getDetails.mockReset();
  usageSnapshot.mockClear();
});

describe('previewTripPlaceEnrichment', () => {
  it('PENRICH-BATCH-001: scans only unlinked trip places with coordinates', async () => {
    const eligibleId = insertPlace();
    insertPlace({ google_place_id: 'already-linked' });
    insertPlace({ lat: null });
    insertPlace({ trip_id: 2 });
    searchCandidates.mockResolvedValue({
      places: [{ google_place_id: 'candidate', name: 'Cafe Fuji', address: 'Shizuoka', lat: 35, lng: 138, types: ['cafe'] }],
      source: 'google',
    });

    const result = await previewTripPlaceEnrichment('1', 9, {});

    expect(searchCandidates).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ place_id: eligibleId, place_name: 'Cafe Fuji' });
    expect(result.entries[0].candidates[0]).toMatchObject({ google_place_id: 'candidate', confidence: 'safe' });
    expect(result.processed).toBe(1);
  });

  it('PENRICH-BATCH-002: preserves completed preview rows when the monthly cap stops the batch', async () => {
    insertPlace({ name: 'First' });
    insertPlace({ name: 'Second', lat: 35.0001 });
    searchCandidates
      .mockResolvedValueOnce({ places: [{ google_place_id: 'g1', name: 'First', lat: 35, lng: 138 }], source: 'google' })
      .mockRejectedValueOnce(Object.assign(new Error('cap reached'), {
        status: 429,
        code: 'GOOGLE_API_MONTHLY_CAP_REACHED',
        sku: 'text_search_pro',
        usage: { used: 4000, cap: 4000, remaining: 0 },
      }));

    const result = await previewTripPlaceEnrichment('1', 9, {});

    expect(result.entries).toHaveLength(1);
    expect(result.processed).toBe(1);
    expect(result.stopped).toMatchObject({ code: 'GOOGLE_API_MONTHLY_CAP_REACHED', sku: 'text_search_pro' });
  });

  it('PENRICH-BATCH-006: does not expose provider error details to the client', async () => {
    insertPlace();
    searchCandidates.mockRejectedValue(new Error('sensitive provider diagnostic'));

    const result = await previewTripPlaceEnrichment('1', 9, {});

    expect(result.errors).toEqual([expect.objectContaining({
      code: 'PROVIDER_ERROR',
      error: 'Google Places request failed',
    })]);
    expect(result.errors[0].error).not.toContain('sensitive');
  });
});

describe('applyTripPlaceEnrichment', () => {
  it('PENRICH-BATCH-003: fills only empty provider/contact fields and preserves user data', async () => {
    const placeId = insertPlace({ address: 'User address', notes: 'Keep me', category_id: 7 });
    getDetails.mockResolvedValue({
      place: {
        google_place_id: 'g1', google_ftid: 'ftid1', name: 'Cafe Fuji',
        address: 'Google address', website: 'https://cafe.test', phone: '+81 1', lat: 35, lng: 138,
      },
    });

    const result = await applyTripPlaceEnrichment('1', 9, [{ place_id: placeId, google_place_id: 'g1' }], 'ja');
    const row = testDb.prepare('SELECT * FROM places WHERE id = ?').get(placeId) as Record<string, unknown>;

    expect(result.updated).toHaveLength(1);
    expect(getDetails).toHaveBeenCalledWith(9, 'g1', 'ja', true);
    expect(row).toMatchObject({
      address: 'User address', notes: 'Keep me', category_id: 7,
      google_place_id: 'g1', google_ftid: 'ftid1', website: 'https://cafe.test', phone: '+81 1',
    });
  });

  it('PENRICH-BATCH-004: rejects a selected Google place more than 250m away without mutation', async () => {
    const placeId = insertPlace();
    getDetails.mockResolvedValue({
      place: { google_place_id: 'far', name: 'Far', lat: 35.01, lng: 138.01, website: 'https://far.test' },
    });

    const result = await applyTripPlaceEnrichment('1', 9, [{ place_id: placeId, google_place_id: 'far' }]);
    const row = testDb.prepare('SELECT google_place_id, website FROM places WHERE id = ?').get(placeId);

    expect(result.updated).toHaveLength(0);
    expect(result.errors[0]).toMatchObject({ place_id: placeId, code: 'MATCH_TOO_FAR' });
    expect(row).toEqual({ google_place_id: null, website: null });
  });

  it('PENRICH-BATCH-005: skips an already-linked place instead of overwriting its provider link', async () => {
    const placeId = insertPlace({ google_place_id: 'existing' });
    const result = await applyTripPlaceEnrichment('1', 9, [{ place_id: placeId, google_place_id: 'different' }]);

    expect(result.skipped).toBe(1);
    expect(getDetails).not.toHaveBeenCalled();
    expect(testDb.prepare('SELECT google_place_id FROM places WHERE id = ?').get(placeId))
      .toEqual({ google_place_id: 'existing' });
  });
});
