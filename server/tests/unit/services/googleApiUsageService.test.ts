import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GoogleApiQuotaExceededError,
  GoogleApiUsageLedger,
  googleBillingPeriod,
  resolveGoogleApiHardCap,
} from '../../../src/services/googleApiUsageService';

function createUsageDb(): Database.Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE google_api_usage (
      period TEXT NOT NULL,
      sku TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (period, sku)
    );
  `);
  return database;
}

describe('googleBillingPeriod', () => {
  it('GQUOTA-001: follows the America/Los_Angeles month boundary', () => {
    expect(googleBillingPeriod(new Date('2026-08-01T06:59:59.999Z'))).toBe('2026-07');
    expect(googleBillingPeriod(new Date('2026-08-01T07:00:00.000Z'))).toBe('2026-08');
  });

  it('GQUOTA-002: also handles the winter PST boundary', () => {
    expect(googleBillingPeriod(new Date('2027-01-01T07:59:59.999Z'))).toBe('2026-12');
    expect(googleBillingPeriod(new Date('2027-01-01T08:00:00.000Z'))).toBe('2027-01');
  });
});

describe('resolveGoogleApiHardCap', () => {
  it('GQUOTA-003: defaults to 80 percent of documented paid-SKU free caps', () => {
    expect(resolveGoogleApiHardCap('autocomplete', {})).toBe(8_000);
    expect(resolveGoogleApiHardCap('text_search_pro', {})).toBe(4_000);
    expect(resolveGoogleApiHardCap('text_search_enterprise', {})).toBe(800);
    expect(resolveGoogleApiHardCap('place_details_enterprise', {})).toBe(800);
    expect(resolveGoogleApiHardCap('place_details_atmosphere', {})).toBe(800);
    expect(resolveGoogleApiHardCap('place_photos', {})).toBe(800);
  });

  it('GQUOTA-004: accepts a lower override, including zero', () => {
    expect(resolveGoogleApiHardCap('text_search_pro', { TREK_GOOGLE_CAP_TEXT_SEARCH_PRO: '123' })).toBe(123);
    expect(resolveGoogleApiHardCap('text_search_pro', { TREK_GOOGLE_CAP_TEXT_SEARCH_PRO: '0' })).toBe(0);
  });

  it('GQUOTA-005: never lets an override raise the built-in ceiling', () => {
    expect(resolveGoogleApiHardCap('place_photos', { TREK_GOOGLE_CAP_PLACE_PHOTOS: '999999' })).toBe(800);
    expect(resolveGoogleApiHardCap('place_photos', { TREK_GOOGLE_CAP_PLACE_PHOTOS: 'invalid' })).toBe(800);
  });
});

describe('GoogleApiUsageLedger', () => {
  let database: Database.Database;

  beforeEach(() => {
    database = createUsageDb();
  });

  afterEach(() => {
    database.close();
  });

  it('GQUOTA-006: atomically reserves before the exact cap and rejects the next call', () => {
    const ledger = new GoogleApiUsageLedger(database, { TREK_GOOGLE_CAP_TEXT_SEARCH_PRO: '2' });
    const now = new Date('2026-07-15T00:00:00Z');

    expect(ledger.reserve('text_search_pro', now)).toMatchObject({ used: 1, cap: 2, remaining: 1 });
    expect(ledger.reserve('text_search_pro', now)).toMatchObject({ used: 2, cap: 2, remaining: 0 });
    expect(() => ledger.reserve('text_search_pro', now)).toThrow(GoogleApiQuotaExceededError);

    const row = database.prepare(
      'SELECT attempts FROM google_api_usage WHERE period = ? AND sku = ?',
    ).get('2026-07', 'text_search_pro') as { attempts: number };
    expect(row.attempts).toBe(2);
  });

  it('GQUOTA-007: a zero cap blocks before writing or allowing network work', () => {
    const ledger = new GoogleApiUsageLedger(database, { TREK_GOOGLE_CAP_PLACE_PHOTOS: '0' });
    expect(() => ledger.reserve('place_photos', new Date('2026-07-15T00:00:00Z'))).toThrow(
      GoogleApiQuotaExceededError,
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM google_api_usage').get()).toEqual({ count: 0 });
  });

  it('GQUOTA-008: reservations remain counted when downstream work fails', () => {
    const ledger = new GoogleApiUsageLedger(database, { TREK_GOOGLE_CAP_AUTOCOMPLETE: '2' });
    ledger.reserve('autocomplete', new Date('2026-07-15T00:00:00Z'));

    expect(ledger.snapshot(new Date('2026-07-15T00:00:00Z')).find((row) => row.sku === 'autocomplete'))
      .toMatchObject({ used: 1, cap: 2, remaining: 1 });
  });

  it('GQUOTA-009: periods and SKUs are isolated in usage snapshots', () => {
    const ledger = new GoogleApiUsageLedger(database, { TREK_GOOGLE_CAP_TEXT_SEARCH_PRO: '3' });
    ledger.reserve('text_search_pro', new Date('2026-07-31T12:00:00-07:00'));
    ledger.reserve('text_search_pro', new Date('2026-08-01T12:00:00-07:00'));
    ledger.reserve('text_search_pro', new Date('2026-08-01T13:00:00-07:00'));

    expect(ledger.snapshot(new Date('2026-07-31T12:00:00-07:00')).find((row) => row.sku === 'text_search_pro'))
      .toMatchObject({ period: '2026-07', used: 1 });
    expect(ledger.snapshot(new Date('2026-08-01T12:00:00-07:00')).find((row) => row.sku === 'text_search_pro'))
      .toMatchObject({ period: '2026-08', used: 2 });
  });

  it('GQUOTA-010: cap errors expose a stable status, code, SKU, and usage', () => {
    const ledger = new GoogleApiUsageLedger(database, { TREK_GOOGLE_CAP_TEXT_SEARCH_ENTERPRISE: '1' });
    ledger.reserve('text_search_enterprise', new Date('2026-07-15T00:00:00Z'));

    try {
      ledger.reserve('text_search_enterprise', new Date('2026-07-15T00:00:00Z'));
      throw new Error('expected quota error');
    } catch (error) {
      expect(error).toMatchObject({
        status: 429,
        code: 'GOOGLE_API_MONTHLY_CAP_REACHED',
        sku: 'text_search_enterprise',
        usage: { used: 1, cap: 1, remaining: 0 },
      });
    }
  });
});
