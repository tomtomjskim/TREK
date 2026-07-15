import { db, getPlaceWithTags } from '../db/database';
import { broadcast } from '../websocket';
import {
  getMapsKey,
  searchPlaces,
  searchPlaceCandidates,
  getPlaceDetails,
  getPlacePhoto,
} from './mapsService';
import { getGoogleApiUsageSnapshot } from './googleApiUsageService';
import type {
  PlaceEnrichmentApplyResult,
  PlaceEnrichmentCandidate,
  PlaceEnrichmentPreviewResult,
  PlaceEnrichmentStop,
} from '@trek/shared';

/**
 * Background enrichment for list-imported places (#886).
 *
 * Google/Naver list imports only carry name + coordinates, so the imported
 * places open as bare pins (the Maps tab jumps to coordinates, no photo, no
 * open/closed). When the importer opts in and a Google Maps key is configured,
 * we re-resolve each place by name — biased to and validated against the
 * imported coordinates — to a real Google place, then fill in the empty fields
 * and persist the resolved `google_place_id` plus `google_ftid` (which power
 * on-demand opening hours and proper Maps links going forward).
 *
 * This runs detached from the import request (fire-and-forget) so a long list
 * never blocks the response, and pushes each enriched row over the websocket so
 * the sidebar fills in progressively. It only ever fills EMPTY columns, so it
 * can never clobber data the import already captured (e.g. a Naver address).
 */

/** A place the import produced — only the fields enrichment reads/writes. */
export interface EnrichablePlace {
  id: number;
  name: string;
  lat: number;
  lng: number;
  google_place_id?: string | null;
  google_ftid?: string | null;
  address?: string | null;
  website?: string | null;
  phone?: string | null;
  image_url?: string | null;
}

/** How close a search hit must be to the imported coordinates to be trusted. */
const MATCH_RADIUS_METERS = 250;
/** Bias the text search to roughly the imported area. */
const SEARCH_BIAS_RADIUS_METERS = 2000;
/** Concurrent enrichment lookups — small, to stay friendly to the Maps quota. */
const ENRICH_CONCURRENCY = 3;

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalizedPlaceName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function isNameMatch(left: string, right: string): boolean {
  const a = normalizedPlaceName(left);
  const b = normalizedPlaceName(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}

/** Rank up to three nearby Google candidates for a human-reviewed preview. */
export function rankEnrichmentCandidates(
  candidates: Record<string, unknown>[],
  target: { name: string; lat: number; lng: number },
  maxMeters: number = MATCH_RADIUS_METERS,
): PlaceEnrichmentCandidate[] {
  return (candidates || []).flatMap((candidate): PlaceEnrichmentCandidate[] => {
    const googlePlaceId = str(candidate.google_place_id);
    const lat = candidate.lat;
    const lng = candidate.lng;
    if (!googlePlaceId || typeof lat !== 'number' || typeof lng !== 'number') return [];
    const distance = haversineMeters(target, { lat, lng });
    if (distance > maxMeters) return [];
    const name = str(candidate.name) ?? '';
    return [{
      google_place_id: googlePlaceId,
      google_ftid: str(candidate.google_ftid),
      name,
      address: str(candidate.address),
      lat,
      lng,
      types: Array.isArray(candidate.types)
        ? candidate.types.filter((type): type is string => typeof type === 'string')
        : [],
      distance_meters: Math.round(distance),
      confidence: distance <= 100 && isNameMatch(target.name, name) ? 'safe' : 'review',
    }];
  }).sort((left, right) => {
    if (left.confidence !== right.confidence) return left.confidence === 'safe' ? -1 : 1;
    return left.distance_meters - right.distance_meters;
  }).slice(0, 3);
}

/**
 * Pick the search result that is the same place as the import: it must be a
 * Google result (have a google_place_id) with coordinates within
 * MATCH_RADIUS_METERS of the imported point. Returns the closest such hit, or
 * null when nothing is close enough — in which case the place is left as
 * imported rather than risking a wrong-place overwrite (common-name / romanized
 * lists). Exported for unit testing.
 */
export function pickEnrichmentMatch(
  candidates: Record<string, unknown>[],
  target: { lat: number; lng: number },
  maxMeters: number = MATCH_RADIUS_METERS,
): Record<string, unknown> | null {
  let best: { c: Record<string, unknown>; dist: number } | null = null;
  for (const c of candidates || []) {
    const gpid = c.google_place_id;
    const lat = c.lat;
    const lng = c.lng;
    if (typeof gpid !== 'string' || !gpid) continue;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const dist = haversineMeters(target, { lat, lng });
    if (dist > maxMeters) continue;
    if (!best || dist < best.dist) best = { c, dist };
  }
  return best?.c ?? null;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

interface BatchPlace extends EnrichablePlace {
  address?: string | null;
}

function quotaStop(error: unknown): PlaceEnrichmentStop | null {
  const detail = error as {
    status?: number;
    code?: string;
    message?: string;
    sku?: string;
    usage?: unknown;
  };
  if (detail.code === 'GOOGLE_API_MONTHLY_CAP_REACHED') {
    return {
      code: detail.code,
      error: detail.message || 'Google Places monthly safety cap reached',
      sku: detail.sku,
      usage: detail.usage,
    };
  }
  if (detail.status === 429) {
    return {
      code: 'GOOGLE_PROVIDER_RATE_LIMITED',
      error: 'Google Places temporarily rate limited this batch',
    };
  }
  return null;
}

function safeProviderError(_error: unknown): string {
  return 'Google Places request failed';
}

function loadPreviewPlaces(tripId: string, placeIds?: number[]): { places: BatchPlace[]; skipped: number } {
  const uniqueIds = placeIds ? [...new Set(placeIds)] : undefined;
  if (uniqueIds?.length === 0) return { places: [], skipped: 0 };
  const idFilter = uniqueIds ? ` AND id IN (${uniqueIds.map(() => '?').join(',')})` : '';
  const places = db.prepare(`
    SELECT id, name, lat, lng, address, google_place_id
    FROM places
    WHERE trip_id = ?
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND (google_place_id IS NULL OR TRIM(google_place_id) = '')
      ${idFilter}
    ORDER BY id ASC
    LIMIT 100
  `).all(tripId, ...(uniqueIds ?? [])) as BatchPlace[];
  return { places, skipped: uniqueIds ? Math.max(0, uniqueIds.length - places.length) : 0 };
}

export async function previewTripPlaceEnrichment(
  tripId: string,
  userId: number,
  options: { place_ids?: number[]; lang?: string },
): Promise<PlaceEnrichmentPreviewResult> {
  if (!getMapsKey(userId)) {
    throw Object.assign(new Error('Google Maps API key not configured'), { status: 400 });
  }
  const selected = loadPreviewPlaces(tripId, options.place_ids);
  const entries: PlaceEnrichmentPreviewResult['entries'] = [];
  const errors: PlaceEnrichmentPreviewResult['errors'] = [];
  let processed = 0;
  let stopped: PlaceEnrichmentStop | null = null;

  await mapWithConcurrency(selected.places, ENRICH_CONCURRENCY, async (place) => {
    if (stopped) return;
    try {
      const result = await searchPlaceCandidates(userId, place.name, options.lang, {
        lat: place.lat,
        lng: place.lng,
        radius: SEARCH_BIAS_RADIUS_METERS,
      });
      entries.push({
        place_id: place.id,
        place_name: place.name,
        current_address: str(place.address),
        candidates: rankEnrichmentCandidates(result.places, place),
      });
      processed++;
    } catch (error) {
      const stop = quotaStop(error);
      if (stop) {
        stopped ??= stop;
        return;
      }
      errors.push({
        place_id: place.id,
        place_name: place.name,
        code: 'PROVIDER_ERROR',
        error: safeProviderError(error),
      });
      processed++;
    }
  });

  entries.sort((a, b) => a.place_id - b.place_id);
  errors.sort((a, b) => a.place_id - b.place_id);
  return {
    entries,
    errors,
    requested: selected.places.length + selected.skipped,
    processed,
    skipped: selected.skipped,
    stopped,
    usage: getGoogleApiUsageSnapshot(),
  };
}

export async function applyTripPlaceEnrichment(
  tripId: string,
  userId: number,
  matches: Array<{ place_id: number; google_place_id: string }>,
  lang?: string,
): Promise<PlaceEnrichmentApplyResult> {
  if (!getMapsKey(userId)) {
    throw Object.assign(new Error('Google Maps API key not configured'), { status: 400 });
  }
  const selected = [...new Map(matches.map((match) => [match.place_id, match])).values()].slice(0, 100);
  const updated: NonNullable<ReturnType<typeof getPlaceWithTags>>[] = [];
  const errors: PlaceEnrichmentApplyResult['errors'] = [];
  let processed = 0;
  let skipped = Math.max(0, matches.length - selected.length);
  let stopped: PlaceEnrichmentStop | null = null;

  await mapWithConcurrency(selected, ENRICH_CONCURRENCY, async (match) => {
    if (stopped) return;
    const place = db.prepare(`
      SELECT id, name, lat, lng, google_place_id
      FROM places WHERE id = ? AND trip_id = ?
    `).get(match.place_id, tripId) as BatchPlace | undefined;
    if (!place) {
      errors.push({ place_id: match.place_id, code: 'PLACE_NOT_FOUND', error: 'Place not found' });
      processed++;
      return;
    }
    const existingGoogleId = str(place.google_place_id);
    if (existingGoogleId && existingGoogleId !== match.google_place_id) {
      skipped++;
      processed++;
      return;
    }
    if (typeof place.lat !== 'number' || typeof place.lng !== 'number') {
      errors.push({ place_id: place.id, code: 'MISSING_COORDINATES', error: 'Place has no coordinates' });
      processed++;
      return;
    }

    try {
      const detailResult = await getPlaceDetails(userId, match.google_place_id, lang, true);
      const detail = detailResult.place;
      const detailLat = detail.lat;
      const detailLng = detail.lng;
      if (typeof detailLat !== 'number' || typeof detailLng !== 'number'
        || haversineMeters(place, { lat: detailLat, lng: detailLng }) > MATCH_RADIUS_METERS) {
        errors.push({
          place_id: place.id,
          code: 'MATCH_TOO_FAR',
          error: 'Selected Google place is too far from the saved coordinates',
        });
        processed++;
        return;
      }

      db.prepare(`
        UPDATE places SET
          google_place_id = CASE WHEN google_place_id IS NULL OR TRIM(google_place_id) = '' THEN ? ELSE google_place_id END,
          google_ftid = CASE WHEN google_ftid IS NULL OR TRIM(google_ftid) = '' THEN ? ELSE google_ftid END,
          address = CASE WHEN address IS NULL OR TRIM(address) = '' THEN ? ELSE address END,
          website = CASE WHEN website IS NULL OR TRIM(website) = '' THEN ? ELSE website END,
          phone = CASE WHEN phone IS NULL OR TRIM(phone) = '' THEN ? ELSE phone END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND trip_id = ?
      `).run(
        match.google_place_id,
        str(detail.google_ftid),
        str(detail.address),
        str(detail.website),
        str(detail.phone),
        place.id,
        tripId,
      );
      const enriched = getPlaceWithTags(place.id);
      if (enriched) updated.push(enriched);
      processed++;
    } catch (error) {
      const stop = quotaStop(error);
      if (stop) {
        stopped ??= stop;
        return;
      }
      errors.push({ place_id: place.id, code: 'PROVIDER_ERROR', error: safeProviderError(error) });
      processed++;
    }
  });

  updated.sort((a, b) => a.id - b.id);
  errors.sort((a, b) => a.place_id - b.place_id);
  return {
    updated: updated as PlaceEnrichmentApplyResult['updated'],
    errors,
    requested: matches.length,
    processed,
    skipped,
    stopped,
    usage: getGoogleApiUsageSnapshot(),
  };
}

async function enrichOne(tripId: string, userId: number, place: EnrichablePlace, lang?: string): Promise<void> {
  // Already linked (shouldn't happen for list imports) — nothing to resolve.
  if (place.google_place_id) return;
  if (typeof place.lat !== 'number' || typeof place.lng !== 'number') return;

  const { places: results } = await searchPlaces(userId, place.name, lang, {
    lat: place.lat,
    lng: place.lng,
    radius: SEARCH_BIAS_RADIUS_METERS,
  });
  const match = pickEnrichmentMatch(results, { lat: place.lat, lng: place.lng });
  if (!match) return;

  const gpid = str(match.google_place_id);
  if (!gpid) return;
  const gftid = str(match.google_ftid);

  // COALESCE so enrichment only fills empty columns — never overwrites data the
  // import already captured (e.g. Naver's address) or anything the user edited.
  db.prepare(
    `UPDATE places
     SET google_place_id = COALESCE(google_place_id, ?),
         google_ftid    = COALESCE(google_ftid, ?),
         address        = COALESCE(address, ?),
         website        = COALESCE(website, ?),
         phone          = COALESCE(phone, ?),
         updated_at     = CURRENT_TIMESTAMP
     WHERE id = ? AND trip_id = ?`,
  ).run(gpid, gftid, str(match.address), str(match.website), str(match.phone), place.id, tripId);

  // Photo is best-effort: Google often has none, and getPlacePhoto throws 404 in
  // that case — a missing photo must never abort the rest of the enrichment.
  try {
    const photo = await getPlacePhoto(userId, gpid, place.lat, place.lng, place.name);
    if (photo?.photoUrl) {
      db.prepare(
        'UPDATE places SET image_url = COALESCE(image_url, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ?',
      ).run(photo.photoUrl, place.id, tripId);
    }
  } catch {
    /* no photo — leave image_url as-is */
  }

  // Push the enriched row to every connected client (no socket exclusion: the
  // importer's own client should also receive the late update).
  const updated = getPlaceWithTags(place.id);
  if (updated) broadcast(tripId, 'place:updated', { place: updated }, undefined);
}

/**
 * Enrich a batch of just-imported places in the background. Never throws —
 * any per-place failure is swallowed so one bad lookup can't take down the
 * detached task or the process. No-ops when no Google Maps key is configured.
 */
export async function enrichImportedPlaces(
  tripId: string,
  userId: number,
  places: EnrichablePlace[],
  lang?: string,
): Promise<void> {
  try {
    if (!places.length) return;
    if (!getMapsKey(userId)) return;
    await mapWithConcurrency(places, ENRICH_CONCURRENCY, async (place) => {
      try {
        await enrichOne(tripId, userId, place, lang);
      } catch (err) {
        console.error(`[Places] enrichment failed for place ${place.id}:`, err instanceof Error ? err.message : err);
      }
    });
  } catch (err) {
    console.error('[Places] import enrichment pass failed:', err instanceof Error ? err.message : err);
  }
}
