import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../src/nest/database/database.service';
import {
  GoogleApiQuotaExceededError,
  GoogleApiUsageService,
  googleBillingPeriod,
  resolveGoogleApiHardCap,
} from '../../../src/nest/google-api-usage/google-api-usage.service';

function makeDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE google_api_usage (period TEXT NOT NULL, sku TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), updated_at INTEGER NOT NULL, PRIMARY KEY (period, sku));');
  return db;
}

describe('GoogleApiUsageService', () => {
  let db: Database.Database;
  let usage: GoogleApiUsageService;

  beforeEach(() => { db = makeDb(); usage = new GoogleApiUsageService(new DatabaseService(db)); });
  afterEach(() => {
    db.close();
    delete process.env.TREK_GOOGLE_CAP_TEXT_SEARCH_PRO;
    delete process.env.TREK_GOOGLE_CAP_PLACE_PHOTOS;
    delete process.env.TREK_GOOGLE_CAP_AUTOCOMPLETE;
  });

  it('GOOG-01: uses the America/Los_Angeles billing boundary', () => {
    expect(googleBillingPeriod(new Date('2026-08-01T06:59:59.999Z'))).toBe('2026-07');
    expect(googleBillingPeriod(new Date('2026-08-01T07:00:00.000Z'))).toBe('2026-08');
  });

  it('GOOG-01: atomically reserves the last slot and rejects the next call', () => {
    process.env.TREK_GOOGLE_CAP_TEXT_SEARCH_PRO = '2';
    expect(usage.reserve('text_search_pro', new Date('2026-07-15T00:00:00Z'))).toMatchObject({ used: 1, remaining: 1 });
    expect(usage.reserve('text_search_pro', new Date('2026-07-15T00:00:00Z'))).toMatchObject({ used: 2, remaining: 0 });
    expect(() => usage.reserve('text_search_pro', new Date('2026-07-15T00:00:00Z'))).toThrow(GoogleApiQuotaExceededError);
    expect(db.prepare('SELECT attempts FROM google_api_usage').get()).toMatchObject({ attempts: 2 });
  });

  it('GOOG-01: a zero cap does not create a ledger row', () => {
    process.env.TREK_GOOGLE_CAP_PLACE_PHOTOS = '0';
    expect(() => usage.reserve('place_photos')).toThrow(GoogleApiQuotaExceededError);
    expect(db.prepare('SELECT COUNT(*) AS count FROM google_api_usage').get()).toEqual({ count: 0 });
  });

  it('GOOG-01: failed downstream calls remain accounted for', () => {
    process.env.TREK_GOOGLE_CAP_AUTOCOMPLETE = '2';
    usage.reserve('autocomplete', new Date('2026-07-15T00:00:00Z'));
    expect(usage.snapshot(new Date('2026-07-15T00:00:00Z')).find((row) => row.sku === 'autocomplete')).toMatchObject({ used: 1, cap: 2 });
  });

  it('GOOG-01: invalid config falls back and never raises the built-in cap', () => {
    expect(resolveGoogleApiHardCap('place_photos', { TREK_GOOGLE_CAP_PLACE_PHOTOS: 'invalid' })).toBe(800);
    expect(resolveGoogleApiHardCap('place_photos', { TREK_GOOGLE_CAP_PLACE_PHOTOS: '999999' })).toBe(800);
  });

  it('GOOG-01: concurrent callers have one last-slot winner', async () => {
    process.env.TREK_GOOGLE_CAP_TEXT_SEARCH_PRO = '1';
    const results = await Promise.allSettled([
      Promise.resolve().then(() => usage.reserve('text_search_pro')),
      Promise.resolve().then(() => usage.reserve('text_search_pro')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
