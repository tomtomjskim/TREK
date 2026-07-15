import type Database from 'better-sqlite3';
import { db } from '../db/database';

export const GOOGLE_API_SKUS = [
  'autocomplete',
  'text_search_ids_only',
  'text_search_pro',
  'text_search_enterprise',
  'place_details_ids_only',
  'place_details_enterprise',
  'place_details_atmosphere',
  'place_photos',
] as const;

export type GoogleApiSku = (typeof GOOGLE_API_SKUS)[number];
type GoogleApiEnvironment = Record<string, string | undefined>;

interface SkuPolicy {
  /** Google's documented monthly free-use cap. `null` means unlimited. */
  officialFreeCap: number | null;
  /** TREK's non-raiseable ceiling. Paid SKUs use 80% of the free-use cap. */
  defaultHardCap: number;
  env: string;
}

const SKU_POLICIES: Record<GoogleApiSku, SkuPolicy> = {
  autocomplete: {
    officialFreeCap: 10_000,
    defaultHardCap: 8_000,
    env: 'TREK_GOOGLE_CAP_AUTOCOMPLETE',
  },
  // Google documents this SKU as unlimited, but TREK still applies an
  // operational ceiling to contain bugs or abusive validation loops.
  text_search_ids_only: {
    officialFreeCap: null,
    defaultHardCap: 10_000,
    env: 'TREK_GOOGLE_CAP_TEXT_SEARCH_IDS_ONLY',
  },
  text_search_pro: {
    officialFreeCap: 5_000,
    defaultHardCap: 4_000,
    env: 'TREK_GOOGLE_CAP_TEXT_SEARCH_PRO',
  },
  text_search_enterprise: {
    officialFreeCap: 1_000,
    defaultHardCap: 800,
    env: 'TREK_GOOGLE_CAP_TEXT_SEARCH_ENTERPRISE',
  },
  place_details_ids_only: {
    officialFreeCap: null,
    defaultHardCap: 10_000,
    env: 'TREK_GOOGLE_CAP_PLACE_DETAILS_IDS_ONLY',
  },
  place_details_enterprise: {
    officialFreeCap: 1_000,
    defaultHardCap: 800,
    env: 'TREK_GOOGLE_CAP_PLACE_DETAILS_ENTERPRISE',
  },
  place_details_atmosphere: {
    officialFreeCap: 1_000,
    defaultHardCap: 800,
    env: 'TREK_GOOGLE_CAP_PLACE_DETAILS_ATMOSPHERE',
  },
  place_photos: {
    officialFreeCap: 1_000,
    defaultHardCap: 800,
    env: 'TREK_GOOGLE_CAP_PLACE_PHOTOS',
  },
};

export interface GoogleApiUsage {
  period: string;
  timezone: 'America/Los_Angeles';
  sku: GoogleApiSku;
  used: number;
  cap: number;
  remaining: number;
  official_free_cap: number | null;
  exhausted: boolean;
}

const billingMonthFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
});

/** Google Maps billing months reset at midnight in America/Los_Angeles. */
export function googleBillingPeriod(at: Date = new Date()): string {
  const parts = billingMonthFormatter.formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to determine Google billing month');
  return `${year}-${month}`;
}

/** Resolve a cap that operators may lower, but can never raise. */
export function resolveGoogleApiHardCap(
  sku: GoogleApiSku,
  env: GoogleApiEnvironment = process.env,
): number {
  const policy = SKU_POLICIES[sku];
  const raw = env[policy.env];
  if (raw === undefined || raw.trim() === '') return policy.defaultHardCap;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return policy.defaultHardCap;
  return Math.min(policy.defaultHardCap, Math.max(0, Math.floor(parsed)));
}

export class GoogleApiQuotaExceededError extends Error {
  readonly status = 429;
  readonly code = 'GOOGLE_API_MONTHLY_CAP_REACHED';

  constructor(
    readonly sku: GoogleApiSku,
    readonly usage: GoogleApiUsage,
  ) {
    super(`Google Places monthly safety cap reached for ${sku}`);
    this.name = 'GoogleApiQuotaExceededError';
  }
}

export class GoogleApiUsageLedger {
  constructor(
    private readonly database: Database.Database,
    private readonly env: GoogleApiEnvironment = process.env,
  ) {}

  reserve(sku: GoogleApiSku, at: Date = new Date()): GoogleApiUsage {
    const period = googleBillingPeriod(at);
    const cap = resolveGoogleApiHardCap(sku, this.env);
    const policy = SKU_POLICIES[sku];

    return this.database.transaction(() => {
      const current = this.database.prepare(
        'SELECT attempts FROM google_api_usage WHERE period = ? AND sku = ?',
      ).get(period, sku) as { attempts: number } | undefined;
      const used = current?.attempts ?? 0;
      const before = this.buildUsage(period, sku, used, cap, policy.officialFreeCap);
      if (used >= cap) throw new GoogleApiQuotaExceededError(sku, before);

      if (current) {
        this.database.prepare(
          'UPDATE google_api_usage SET attempts = attempts + 1, updated_at = ? WHERE period = ? AND sku = ?',
        ).run(at.getTime(), period, sku);
      } else {
        this.database.prepare(
          'INSERT INTO google_api_usage (period, sku, attempts, updated_at) VALUES (?, ?, 1, ?)',
        ).run(period, sku, at.getTime());
      }

      return this.buildUsage(period, sku, used + 1, cap, policy.officialFreeCap);
    })();
  }

  snapshot(at: Date = new Date()): GoogleApiUsage[] {
    const period = googleBillingPeriod(at);
    const rows = this.database.prepare(
      'SELECT sku, attempts FROM google_api_usage WHERE period = ?',
    ).all(period) as Array<{ sku: string; attempts: number }>;
    const usedBySku = new Map(rows.map((row) => [row.sku, row.attempts]));

    return GOOGLE_API_SKUS.map((sku) => {
      const policy = SKU_POLICIES[sku];
      return this.buildUsage(
        period,
        sku,
        usedBySku.get(sku) ?? 0,
        resolveGoogleApiHardCap(sku, this.env),
        policy.officialFreeCap,
      );
    });
  }

  private buildUsage(
    period: string,
    sku: GoogleApiSku,
    used: number,
    cap: number,
    officialFreeCap: number | null,
  ): GoogleApiUsage {
    return {
      period,
      timezone: 'America/Los_Angeles',
      sku,
      used,
      cap,
      remaining: Math.max(0, cap - used),
      official_free_cap: officialFreeCap,
      exhausted: used >= cap,
    };
  }
}

let defaultLedger: GoogleApiUsageLedger | null = null;

function getDefaultLedger(): GoogleApiUsageLedger {
  if (!defaultLedger) {
    defaultLedger = new GoogleApiUsageLedger(db);
  }
  return defaultLedger;
}

export function reserveGoogleApiCall(sku: GoogleApiSku, at?: Date): GoogleApiUsage {
  return getDefaultLedger().reserve(sku, at);
}

export function getGoogleApiUsageSnapshot(at?: Date): GoogleApiUsage[] {
  return getDefaultLedger().snapshot(at);
}
