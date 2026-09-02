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
    delete process.env.TREK_GOOGLE_CAP_TEXT_SEARCH_ENTERPRISE;
  });

  it('GOOG-01: uses the America/Los_Angeles billing boundary', () => {
    expect(googleBillingPeriod(new Date('2026-08-01T06:59:59.999Z'))).toBe('2026-07');
    expect(googleBillingPeriod(new Date('2026-08-01T07:00:00.000Z'))).toBe('2026-08');
  });

  it('GOOG-01: handles the winter PST boundary', () => {
    expect(googleBillingPeriod(new Date('2027-01-01T07:59:59.999Z'))).toBe('2026-12');
    expect(googleBillingPeriod(new Date('2027-01-01T08:00:00.000Z'))).toBe('2027-01');
  });

  it('GOOG-01: keeps every documented default cap at the 80 percent ceiling', () => {
    expect(resolveGoogleApiHardCap('autocomplete', {})).toBe(8000);
    expect(resolveGoogleApiHardCap('text_search_pro', {})).toBe(4000);
    expect(resolveGoogleApiHardCap('text_search_enterprise', {})).toBe(800);
    expect(resolveGoogleApiHardCap('place_details_enterprise', {})).toBe(800);
    expect(resolveGoogleApiHardCap('place_details_atmosphere', {})).toBe(800);
    expect(resolveGoogleApiHardCap('place_photos', {})).toBe(800);
  });

  it('GOOG-01: accepts lower and zero cap overrides', () => {
    expect(resolveGoogleApiHardCap('text_search_pro', { TREK_GOOGLE_CAP_TEXT_SEARCH_PRO: '123' })).toBe(123);
    expect(resolveGoogleApiHardCap('text_search_pro', { TREK_GOOGLE_CAP_TEXT_SEARCH_PRO: '0' })).toBe(0);
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

  it('GOOG-01: isolates periods and SKUs in snapshots', () => {
    process.env.TREK_GOOGLE_CAP_TEXT_SEARCH_PRO = '3';
    usage.reserve('text_search_pro', new Date('2026-07-31T12:00:00-07:00'));
    usage.reserve('text_search_pro', new Date('2026-08-01T12:00:00-07:00'));
    usage.reserve('text_search_pro', new Date('2026-08-01T13:00:00-07:00'));
    expect(usage.snapshot(new Date('2026-07-31T12:00:00-07:00')).find((row) => row.sku === 'text_search_pro')).toMatchObject({ period: '2026-07', used: 1 });
    expect(usage.snapshot(new Date('2026-08-01T12:00:00-07:00')).find((row) => row.sku === 'text_search_pro')).toMatchObject({ period: '2026-08', used: 2 });
  });

  it('GOOG-01: exposes the stable quota error envelope', () => {
    process.env.TREK_GOOGLE_CAP_TEXT_SEARCH_ENTERPRISE = '1';
    usage.reserve('text_search_enterprise', new Date('2026-07-15T00:00:00Z'));
    try { usage.reserve('text_search_enterprise', new Date('2026-07-15T00:00:00Z')); throw new Error('expected quota error'); } catch (error) {
      expect(error).toMatchObject({ status: 429, code: 'GOOGLE_API_MONTHLY_CAP_REACHED', sku: 'text_search_enterprise', usage: { used: 1, cap: 1, remaining: 0 } });
    }
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
