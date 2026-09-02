import { Injectable } from '@nestjs/common';
import type {
  PlaceEnrichmentApplyRequest,
  PlaceEnrichmentApplyResult,
  PlaceEnrichmentCandidate,
  PlaceEnrichmentPreviewRequest,
  PlaceEnrichmentPreviewResult,
} from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { MapsService } from '../maps/maps.service';
import { GoogleApiQuotaExceededError, GoogleApiUsageService } from '../google-api-usage/google-api-usage.service';
import { PlacesService } from './places.service';
import { haversineMetres } from '../maps/maps.helpers';
import { MATCH_RADIUS_METERS, SEARCH_BIAS_RADIUS_METERS, trimOrNull } from './places.helpers';

type BatchPlace = { id: number; name: string; lat: number | null; lng: number | null; address: string | null; google_place_id: string | null };

function isQuotaError(error: unknown): error is GoogleApiQuotaExceededError {
  return error instanceof GoogleApiQuotaExceededError || (typeof error === 'object' && error !== null && ((error as { code?: string }).code === 'GOOGLE_API_MONTHLY_CAP_REACHED' || (error as { status?: number }).status === 429));
}

function quotaStop(error: unknown) {
  const monthly = (error as { code?: string }).code === 'GOOGLE_API_MONTHLY_CAP_REACHED';
  return { code: monthly ? 'GOOGLE_API_MONTHLY_CAP_REACHED' : 'GOOGLE_PROVIDER_RATE_LIMITED', error: monthly ? 'Google Places monthly safety cap reached' : 'Google Places provider is rate limited', sku: (error as { sku?: string }).sku, usage: (error as { usage?: unknown }).usage };
}

function disabledStop() {
  return { code: 'PLACE_ENRICHMENT_DISABLED' as const, error: 'Place enrichment was disabled by an administrator' };
}

function normalizedPlaceName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function placeNamesMatch(left: string, right: string): boolean {
  const a = normalizedPlaceName(left);
  const b = normalizedPlaceName(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}

@Injectable()
export class PlaceBatchEnrichmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly maps: MapsService,
    private readonly usage: GoogleApiUsageService,
    private readonly places: PlacesService,
  ) {}

  private disabled(): boolean {
    const row = this.db.get<{ value: string }>("SELECT value FROM app_settings WHERE key IN ('places_enrichment_enabled', 'places_enrich_enabled') ORDER BY CASE key WHEN 'places_enrichment_enabled' THEN 0 ELSE 1 END LIMIT 1");
    return row?.value === 'false';
  }

  private ensureEnabled(userId: number): void {
    if (this.disabled()) throw new Error('PLACE_ENRICHMENT_DISABLED');
    if (!this.maps.getMapsKey(userId)) throw new Error('PLACE_ENRICHMENT_NOT_CONFIGURED');
  }

  async preview(tripId: string, userId: number, request: PlaceEnrichmentPreviewRequest): Promise<PlaceEnrichmentPreviewResult> {
    this.ensureEnabled(userId);
    const ids = request.place_ids ? [...new Set(request.place_ids)] : null;
    if (ids && ids.length === 0) return { entries: [], errors: [], requested: 0, processed: 0, skipped: 0, stopped: null, usage: this.usage.snapshot() as PlaceEnrichmentPreviewResult['usage'] };
    const params: unknown[] = [tripId];
    const where = ids ? ` AND p.id IN (${ids.map(() => '?').join(',')})` : '';
    if (ids) params.push(...ids);
    const candidates = this.db.all<BatchPlace>(
      `SELECT p.id, p.name, p.lat, p.lng, p.address, p.google_place_id FROM places p WHERE p.trip_id = ?${where} AND (p.google_place_id IS NULL OR TRIM(p.google_place_id) = '') AND p.lat IS NOT NULL AND p.lng IS NOT NULL ORDER BY p.id LIMIT 100`,
      ...params,
    );
    const result: PlaceEnrichmentPreviewResult = { entries: [], errors: [], requested: ids ? ids.length : candidates.length, processed: 0, skipped: ids ? ids.length - candidates.length : 0, stopped: null, usage: [] };
    for (const place of candidates) {
      if (this.disabled()) {
        result.stopped = disabledStop();
        break;
      }
      try {
        const found = await this.maps.searchPlaceCandidates(userId, place.name, request.lang, { lat: place.lat!, lng: place.lng!, radius: SEARCH_BIAS_RADIUS_METERS });
        const mapped = found.places
          .filter((candidate) => trimOrNull(candidate.google_place_id) !== null && typeof candidate.lat === 'number' && typeof candidate.lng === 'number')
          .map((candidate): PlaceEnrichmentCandidate => {
            const distance = haversineMetres(place.lat!, place.lng!, candidate.lat as number, candidate.lng as number);
            const candidateName = String(candidate.name ?? '');
            return { google_place_id: trimOrNull(candidate.google_place_id)!, google_ftid: trimOrNull(candidate.google_ftid), name: candidateName, address: trimOrNull(candidate.address), lat: candidate.lat as number, lng: candidate.lng as number, types: Array.isArray(candidate.types) ? candidate.types.filter((type): type is string => typeof type === 'string') : [], distance_meters: distance, confidence: distance <= 100 && placeNamesMatch(place.name, candidateName) ? 'safe' : 'review' };
          })
          .filter((candidate) => candidate.distance_meters <= MATCH_RADIUS_METERS)
          .sort((a, b) => Number(b.confidence === 'safe') - Number(a.confidence === 'safe') || a.distance_meters - b.distance_meters)
          .map((candidate) => ({ ...candidate, distance_meters: Math.round(candidate.distance_meters) }));
        mapped.splice(3);
        result.entries.push({ place_id: place.id, place_name: place.name, current_address: trimOrNull(place.address), candidates: mapped });
        result.processed++;
      } catch (error) {
        if (isQuotaError(error)) {
          result.stopped = quotaStop(error);
          break;
        }
        result.errors.push({ place_id: place.id, place_name: place.name, code: 'PROVIDER_ERROR', error: 'Google Places request failed' });
        result.processed++;
      }
    }
    result.skipped += result.requested - result.processed - result.skipped;
    result.usage = this.usage.snapshot() as PlaceEnrichmentPreviewResult['usage'];
    return result;
  }

  async apply(tripId: string, userId: number, request: PlaceEnrichmentApplyRequest, socketId?: string): Promise<PlaceEnrichmentApplyResult> {
    this.ensureEnabled(userId);
    const unique = [...new Map(request.matches.map((match) => [match.place_id, match])).values()];
    const result: PlaceEnrichmentApplyResult = { updated: [], errors: [], requested: request.matches.length, processed: 0, skipped: request.matches.length - Math.min(unique.length, 100), stopped: null, usage: [] };
    const work = unique.slice(0, 100);
    for (const match of work) {
      const place = this.places.get(tripId, String(match.place_id)) as BatchPlace | null;
      if (!place) { result.errors.push({ place_id: match.place_id, code: 'PLACE_NOT_FOUND', error: 'Place not found' }); result.processed++; continue; }
      const selectedGoogleId = trimOrNull(match.google_place_id)!;
      const linkedGoogleId = trimOrNull(place.google_place_id);
      if (linkedGoogleId && linkedGoogleId !== selectedGoogleId) { result.skipped++; result.processed++; continue; }
      if (typeof place.lat !== 'number' || typeof place.lng !== 'number') { result.errors.push({ place_id: place.id, code: 'MISSING_COORDINATES', error: 'Place has no coordinates' }); result.processed++; continue; }
      if (this.disabled()) {
        result.stopped = disabledStop();
        break;
      }
      try {
        const details = await this.maps.getPlaceDetailsFresh(userId, selectedGoogleId, request.lang);
        const provider = details.place;
        if (!provider || typeof provider.lat !== 'number' || typeof provider.lng !== 'number' || haversineMetres(place.lat, place.lng, provider.lat, provider.lng) > MATCH_RADIUS_METERS) {
          result.errors.push({ place_id: place.id, code: 'MATCH_TOO_FAR', error: 'Selected Google place is too far away' });
          result.processed++;
          continue;
        }
        const write = this.db.run(
          `UPDATE places SET google_place_id = CASE WHEN TRIM(COALESCE(google_place_id, '')) = '' THEN ? ELSE google_place_id END, google_ftid = CASE WHEN TRIM(COALESCE(google_ftid, '')) = '' THEN ? ELSE google_ftid END, address = CASE WHEN TRIM(COALESCE(address, '')) = '' THEN ? ELSE address END, website = CASE WHEN TRIM(COALESCE(website, '')) = '' THEN ? ELSE website END, phone = CASE WHEN TRIM(COALESCE(phone, '')) = '' THEN ? ELSE phone END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ? AND (TRIM(COALESCE(google_place_id, '')) = '' OR TRIM(COALESCE(google_place_id, '')) = ?)`,
          selectedGoogleId, trimOrNull(provider.google_ftid), trimOrNull(provider.address), trimOrNull(provider.website), trimOrNull(provider.phone), place.id, tripId, selectedGoogleId,
        );
        if (write.changes === 0) { result.skipped++; result.processed++; continue; }
        const updated = this.places.get(tripId, String(place.id));
        if (updated) { result.updated.push(updated as never); this.places.onUpdated(place.id); this.places.broadcast(tripId, 'place:updated', { place: updated } as never, socketId); }
        result.processed++;
      } catch (error) {
        if (isQuotaError(error)) { result.stopped = quotaStop(error); break; }
        result.errors.push({ place_id: place.id, code: 'PROVIDER_ERROR', error: 'Google Places request failed' });
        result.processed++;
      }
    }
    result.skipped += work.length - result.processed;
    result.usage = this.usage.snapshot() as PlaceEnrichmentApplyResult['usage'];
    return result;
  }
}
