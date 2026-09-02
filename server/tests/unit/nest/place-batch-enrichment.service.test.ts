import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { PlaceBatchEnrichmentService } from '../../../src/nest/places/place-batch-enrichment.service';

type PlaceSeed = Partial<{
  trip_id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  category_id: number | null;
  notes: string | null;
  google_place_id: string | null;
  google_ftid: string | null;
  website: string | null;
  phone: string | null;
}>;

describe('PlaceBatchEnrichmentService', () => {
  let database: Database.Database;
  let db: DatabaseService;
  let maps: {
    getMapsKey: ReturnType<typeof vi.fn>;
    searchPlaceCandidates: ReturnType<typeof vi.fn>;
    getPlaceDetailsFresh: ReturnType<typeof vi.fn>;
  };
  let usage: { snapshot: ReturnType<typeof vi.fn> };
  let places: {
    get: ReturnType<typeof vi.fn>;
    onUpdated: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
  };
  let service: PlaceBatchEnrichmentService;

  const insertPlace = (values: PlaceSeed = {}): number => {
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
    return Number(database.prepare(`
      INSERT INTO places (
        trip_id, name, lat, lng, address, category_id, notes,
        google_place_id, google_ftid, website, phone
      ) VALUES (
        @trip_id, @name, @lat, @lng, @address, @category_id, @notes,
        @google_place_id, @google_ftid, @website, @phone
      )
    `).run(row).lastInsertRowid);
  };

  beforeEach(() => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
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
    db = new DatabaseService(database);
    maps = {
      getMapsKey: vi.fn(() => 'configured-key'),
      searchPlaceCandidates: vi.fn(),
      getPlaceDetailsFresh: vi.fn(),
    };
    usage = { snapshot: vi.fn(() => []) };
    places = {
      get: vi.fn((tripId: string, placeId: string) =>
        database.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(placeId, tripId)),
      onUpdated: vi.fn(),
      broadcast: vi.fn(),
    };
    service = new PlaceBatchEnrichmentService(db, maps as never, usage as never, places as never);
  });

  afterEach(() => database.close());

  it('PENRICH-BATCH-001: scans only unlinked trip places with coordinates before applying the 100-row limit', async () => {
    for (let index = 0; index < 100; index++) insertPlace({ google_place_id: `linked-${index}` });
    const eligibleId = insertPlace();
    insertPlace({ lat: null });
    insertPlace({ trip_id: 2 });
    maps.searchPlaceCandidates.mockResolvedValue({
      places: [{ google_place_id: 'candidate', name: 'Cafe Fuji', address: 'Shizuoka', lat: 35, lng: 138, types: ['cafe'] }],
      source: 'google',
    });

    const result = await service.preview('1', 9, {});

    expect(maps.searchPlaceCandidates).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requested: 1, processed: 1, skipped: 0 });
    expect(result.entries[0]).toMatchObject({ place_id: eligibleId, place_name: 'Cafe Fuji' });
    expect(result.entries[0].candidates[0]).toMatchObject({ google_place_id: 'candidate', confidence: 'safe' });
  });

  it('treats an explicit empty selection as empty and counts selected ineligible or absent IDs as skipped', async () => {
    const eligibleId = insertPlace();
    const linkedId = insertPlace({ google_place_id: 'linked' });
    maps.searchPlaceCandidates.mockResolvedValue({ places: [], source: 'google' });

    await expect(service.preview('1', 9, { place_ids: [] })).resolves.toMatchObject({ requested: 0, processed: 0, skipped: 0 });
    expect(maps.searchPlaceCandidates).not.toHaveBeenCalled();

    const selected = await service.preview('1', 9, { place_ids: [eligibleId, linkedId, 999] });
    expect(selected).toMatchObject({ requested: 3, processed: 1, skipped: 2 });
  });

  it('ranks safe Unicode/name-normalized candidates first, excludes exact distances over 250m, and returns at most three', async () => {
    insertPlace({ name: '카페-후지' });
    maps.searchPlaceCandidates.mockResolvedValue({
      source: 'google',
      places: [
        { google_place_id: 'review-near', name: '다른 장소', lat: 35.0001, lng: 138 },
        { google_place_id: 'safe', name: '카페 후지', lat: 35.0005, lng: 138 },
        { google_place_id: 'review-2', name: '다른 장소 2', lat: 35.0002, lng: 138 },
        { google_place_id: 'review-3', name: '다른 장소 3', lat: 35.0003, lng: 138 },
        { google_place_id: 'far', name: '카페 후지', lat: 35.01, lng: 138.01 },
      ],
    });

    const result = await service.preview('1', 9, {});

    expect(result.entries[0].candidates).toHaveLength(3);
    expect(result.entries[0].candidates[0]).toMatchObject({ google_place_id: 'safe', confidence: 'safe' });
    expect(result.entries[0].candidates.map((candidate) => candidate.google_place_id)).not.toContain('far');
  });

  it('PENRICH-BATCH-002: preserves completed preview rows when the monthly cap stops the batch', async () => {
    insertPlace({ name: 'First' });
    insertPlace({ name: 'Second', lat: 35.0001 });
    maps.searchPlaceCandidates
      .mockResolvedValueOnce({ places: [{ google_place_id: 'g1', name: 'First', lat: 35, lng: 138 }], source: 'google' })
      .mockRejectedValueOnce(Object.assign(new Error('cap reached'), {
        status: 429,
        code: 'GOOGLE_API_MONTHLY_CAP_REACHED',
        sku: 'text_search_pro',
        usage: { used: 4_000, cap: 4_000, remaining: 0 },
      }));

    const result = await service.preview('1', 9, {});

    expect(result.entries).toHaveLength(1);
    expect(result).toMatchObject({ requested: 2, processed: 1, skipped: 1 });
    expect(result.stopped).toMatchObject({ code: 'GOOGLE_API_MONTHLY_CAP_REACHED', sku: 'text_search_pro' });
  });

  it('stops preview after the admin disables enrichment during the first provider call', async () => {
    insertPlace({ name: 'First' });
    insertPlace({ name: 'Second', lat: 35.0001 });
    maps.searchPlaceCandidates.mockImplementationOnce(async () => {
      database.prepare("INSERT INTO app_settings (key, value) VALUES ('places_enrichment_enabled', 'false')").run();
      return { places: [{ google_place_id: 'g1', name: 'First', lat: 35, lng: 138 }], source: 'google' };
    });

    const result = await service.preview('1', 9, {});

    expect(maps.searchPlaceCandidates).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, skipped: 1, stopped: {
      code: 'PLACE_ENRICHMENT_DISABLED',
      error: 'Place enrichment was disabled by an administrator',
    } });
  });

  it('distinguishes a provider 429 from the durable monthly safety cap', async () => {
    insertPlace();
    maps.searchPlaceCandidates.mockRejectedValue(Object.assign(new Error('provider detail'), { status: 429 }));

    const result = await service.preview('1', 9, {});

    expect(result.stopped).toEqual(expect.objectContaining({ code: 'GOOGLE_PROVIDER_RATE_LIMITED' }));
    expect(result.stopped?.error).not.toContain('provider detail');
  });

  it('PENRICH-BATCH-006: does not expose provider error details to the client', async () => {
    insertPlace();
    maps.searchPlaceCandidates.mockRejectedValue(new Error('sensitive provider diagnostic'));

    const result = await service.preview('1', 9, {});

    expect(result.errors).toEqual([expect.objectContaining({ code: 'PROVIDER_ERROR', error: 'Google Places request failed' })]);
    expect(result.errors[0].error).not.toContain('sensitive');
  });

  it('PENRICH-BATCH-003: fills only empty provider/contact fields and preserves user data', async () => {
    const placeId = insertPlace({ address: 'User address', notes: 'Keep me', category_id: 7, website: '   ' });
    maps.getPlaceDetailsFresh.mockResolvedValue({
      place: {
        google_place_id: 'g1', google_ftid: 'ftid1', name: 'Cafe Fuji',
        address: 'Google address', website: 'https://cafe.test', phone: '+81 1', lat: 35, lng: 138,
      },
    });

    const result = await service.apply('1', 9, { matches: [{ place_id: placeId, google_place_id: 'g1' }], lang: 'ja' }, 'socket');
    const row = database.prepare('SELECT * FROM places WHERE id = ?').get(placeId) as Record<string, unknown>;

    expect(result.updated).toHaveLength(1);
    expect(maps.getPlaceDetailsFresh).toHaveBeenCalledWith(9, 'g1', 'ja');
    expect(row).toMatchObject({
      address: 'User address', notes: 'Keep me', category_id: 7,
      google_place_id: 'g1', google_ftid: 'ftid1', website: 'https://cafe.test', phone: '+81 1',
    });
    expect(places.onUpdated).toHaveBeenCalledWith(placeId);
    expect(places.broadcast).toHaveBeenCalledWith('1', 'place:updated', expect.anything(), 'socket');
  });

  it('stops apply after the admin disables enrichment during the first provider call', async () => {
    const firstId = insertPlace({ name: 'First' });
    const secondId = insertPlace({ name: 'Second', lat: 35.0001 });
    maps.getPlaceDetailsFresh.mockImplementationOnce(async () => {
      database.prepare("INSERT INTO app_settings (key, value) VALUES ('places_enrichment_enabled', 'false')").run();
      return { place: { google_place_id: 'g1', lat: 35, lng: 138, website: 'https://first.test' } };
    });

    const result = await service.apply('1', 9, {
      matches: [{ place_id: firstId, google_place_id: 'g1' }, { place_id: secondId, google_place_id: 'g2' }],
    });

    expect(maps.getPlaceDetailsFresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, skipped: 1, stopped: {
      code: 'PLACE_ENRICHMENT_DISABLED',
      error: 'Place enrichment was disabled by an administrator',
    } });
  });

  it('PENRICH-BATCH-004: rejects a selected Google place more than 250m away without mutation', async () => {
    const placeId = insertPlace();
    maps.getPlaceDetailsFresh.mockResolvedValue({ place: { google_place_id: 'far', lat: 35.01, lng: 138.01, website: 'https://far.test' } });

    const result = await service.apply('1', 9, { matches: [{ place_id: placeId, google_place_id: 'far' }] });
    const row = database.prepare('SELECT google_place_id, website FROM places WHERE id = ?').get(placeId);

    expect(result.updated).toHaveLength(0);
    expect(result.errors[0]).toMatchObject({ place_id: placeId, code: 'MATCH_TOO_FAR' });
    expect(row).toEqual({ google_place_id: null, website: null });
  });

  it('PENRICH-BATCH-005: skips a conflicting provider link but lets the same link fill empty fields', async () => {
    const conflictingId = insertPlace({ google_place_id: 'existing' });
    const sameId = insertPlace({ google_place_id: 'same' });
    maps.getPlaceDetailsFresh.mockResolvedValue({ place: { google_place_id: 'same', lat: 35, lng: 138, website: 'https://same.test' } });

    const result = await service.apply('1', 9, {
      matches: [
        { place_id: conflictingId, google_place_id: 'different' },
        { place_id: sameId, google_place_id: 'same' },
      ],
    });

    expect(result).toMatchObject({ requested: 2, processed: 2, skipped: 1 });
    expect(maps.getPlaceDetailsFresh).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT google_place_id, website FROM places WHERE id = ?').get(conflictingId))
      .toEqual({ google_place_id: 'existing', website: null });
    expect(database.prepare('SELECT google_place_id, website FROM places WHERE id = ?').get(sameId))
      .toEqual({ google_place_id: 'same', website: 'https://same.test' });
  });

  it('treats a whitespace-padded stored provider ID as the selected ID', async () => {
    const placeId = insertPlace({ google_place_id: '  same  ' });
    maps.getPlaceDetailsFresh.mockResolvedValue({
      place: { google_place_id: 'same', lat: 35, lng: 138, website: 'https://same.test' },
    });

    const result = await service.apply('1', 9, {
      matches: [{ place_id: placeId, google_place_id: 'same' }],
    });

    expect(result).toMatchObject({ requested: 1, processed: 1, skipped: 0 });
    expect(database.prepare('SELECT google_place_id, website FROM places WHERE id = ?').get(placeId))
      .toEqual({ google_place_id: '  same  ', website: 'https://same.test' });
  });

  it('counts missing rows and coordinates as processed errors without provider work', async () => {
    const missingCoordinatesId = insertPlace({ lat: null });

    const result = await service.apply('1', 9, {
      matches: [
        { place_id: 999, google_place_id: 'missing' },
        { place_id: missingCoordinatesId, google_place_id: 'coords' },
      ],
    });

    expect(result).toMatchObject({ requested: 2, processed: 2, skipped: 0 });
    expect(result.errors.map((error) => error.code)).toEqual(['PLACE_NOT_FOUND', 'MISSING_COORDINATES']);
    expect(maps.getPlaceDetailsFresh).not.toHaveBeenCalled();
  });

  it('fails closed when enrichment is disabled or the caller has no configured Maps key', async () => {
    database.prepare("INSERT INTO app_settings (key, value) VALUES ('places_enrichment_enabled', 'false')").run();
    await expect(service.preview('1', 9, {})).rejects.toThrow('PLACE_ENRICHMENT_DISABLED');
    expect(maps.searchPlaceCandidates).not.toHaveBeenCalled();

    database.prepare("UPDATE app_settings SET value = 'true' WHERE key = 'places_enrichment_enabled'").run();
    maps.getMapsKey.mockReturnValue(null);
    await expect(service.preview('1', 9, {})).rejects.toThrow('PLACE_ENRICHMENT_NOT_CONFIGURED');
    expect(maps.searchPlaceCandidates).not.toHaveBeenCalled();
  });

  it('does not apply stale provider details when another request links the place while Google is in flight', async () => {
    const placeId = insertPlace();
    maps.getPlaceDetailsFresh.mockImplementation(async () => {
      database.prepare('UPDATE places SET google_place_id = ? WHERE id = ?').run('concurrent-link', placeId);
      return {
        place: {
          google_place_id: 'selected-link',
          lat: 35,
          lng: 138,
          website: 'https://selected.test',
        },
      };
    });

    const result = await service.apply('1', 9, {
      matches: [{ place_id: placeId, google_place_id: 'selected-link' }],
    });

    expect(result).toMatchObject({ requested: 1, processed: 1, skipped: 1, updated: [] });
    expect(database.prepare('SELECT google_place_id, website FROM places WHERE id = ?').get(placeId))
      .toEqual({ google_place_id: 'concurrent-link', website: null });
    expect(places.onUpdated).not.toHaveBeenCalled();
    expect(places.broadcast).not.toHaveBeenCalled();
  });
});
