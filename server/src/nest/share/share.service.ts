import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import type { TripAccess } from '../database/database.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PlacePhotoCacheService } from '../place-photos/place-photo-cache.service';
import { publicReservationSql, publicStaySql } from '../reservations/reservation-visibility';
import type { User } from '../../types';
import type {
  PublicSharedReservationMetadata,
  PublicSharedTripData,
} from './public-share.types';

type Trip = TripAccess;

const PLACE_PHOTO_PROXY_PREFIX = '/api/maps/place-photo/';

const RESERVATION_METADATA_FIELDS = [
  'airline', 'flight_number', 'departure_airport', 'arrival_airport', 'train_number', 'platform',
] as const;
const RESERVATION_LEG_FIELDS = [
  'from', 'to', 'airline', 'flight_number', 'train_number', 'platform',
  'dep_day_id', 'dep_time', 'arr_day_id', 'arr_time', 'day_positions',
] as const;

function publicMetadataScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function sanitizeDayPositions(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const positions: Record<string, number> = {};
  for (const [dayId, position] of Object.entries(value as Record<string, unknown>)) {
    if (typeof position === 'number' && Number.isFinite(position)) positions[dayId] = position;
  }
  return Object.keys(positions).length > 0 ? positions : undefined;
}

function readPublicCurrency(value: string | null | undefined): string | null {
  if (!value) return null;
  let parsed: unknown = value;
  try { parsed = JSON.parse(value); } catch { /* legacy plain-string setting */ }
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
}

/** Parse untrusted JSON and copy only the fields the public booking cards consume. */
function sanitizeReservationMetadata(raw: string | null): PublicSharedReservationMetadata {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const source = parsed as Record<string, unknown>;
  const metadata: PublicSharedReservationMetadata = {};
  for (const key of RESERVATION_METADATA_FIELDS) {
    const value = publicMetadataScalar(source[key]);
    if (value !== undefined) metadata[key] = value;
  }
  if (Array.isArray(source.legs)) {
    metadata.legs = source.legs
      .filter((leg): leg is Record<string, unknown> => !!leg && typeof leg === 'object' && !Array.isArray(leg))
      .map((leg) => {
        const publicLeg: NonNullable<PublicSharedReservationMetadata['legs']>[number] = {};
        for (const key of RESERVATION_LEG_FIELDS) {
          if (key === 'day_positions') {
            const positions = sanitizeDayPositions(leg[key]);
            if (positions) publicLeg.day_positions = positions;
            continue;
          }
          const value = publicMetadataScalar(leg[key]);
          if (value !== undefined) publicLeg[key] = value;
        }
        return publicLeg;
      });
  }
  return metadata;
}

/**
 * Place photo proxy URLs (`/api/maps/place-photo/<id>/bytes`) are served by the
 * JWT-guarded MapsController, so they 401 for an unauthenticated shared-trip
 * viewer. Rewrite them to the public, token-scoped equivalent
 * (`/api/shared/<token>/place-photo/<id>/bytes`) so thumbnails load in a shared
 * link. A simple prefix swap keeps the already-encoded placeId segment intact, so
 * the URL round-trips. Non-proxy URLs (data:, /uploads/, null) pass through.
 */
function rewritePlacePhotoUrl(url: string | null | undefined, token: string): string | null {
  if (typeof url === 'string' && url.startsWith(PLACE_PHOTO_PROXY_PREFIX)) {
    return `/api/shared/${token}/place-photo/${url.slice(PLACE_PHOTO_PROXY_PREFIX.length)}`;
  }
  return url ?? null;
}

export interface SharePermissions {
  share_map?: boolean;
  share_bookings?: boolean;
  share_packing?: boolean;
  share_budget?: boolean;
  share_collab?: boolean;
}

export interface ShareTokenInfo {
  token: string;
  created_at: string;
  share_map: boolean;
  share_bookings: boolean;
  share_packing: boolean;
  share_budget: boolean;
  share_collab: boolean;
}

/**
 * Public share links — the legacy shareService SQL folded in over the injected
 * DatabaseService. Trip access and the 'share_manage' permission gate
 * create/delete; the shared read is public.
 */
@Injectable()
export class ShareService {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly photoCache: PlacePhotoCacheService,
  ) {}

  verifyTripAccess(tripId: string, userId: number) {
    return this.dbs.canAccessTrip(tripId, userId);
  }

  canManage(trip: Trip, user: User): boolean {
    return this.permissions.checkPermission('share_manage', user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  /**
   * Creates a new share link or updates the permissions on an existing one.
   * Returns an object with the token string and whether it was newly created.
   *
   * Share links carry a 90-day TTL; updating an existing link renews it, so a
   * link the owner is actively managing never expires under them. Rows created
   * before the expires_at migration keep NULL until touched and remain valid
   * indefinitely; an explicit update moves them onto the TTL.
   */
  createOrUpdate(tripId: string, userId: number, permissions: SharePermissions): { token: string; created: boolean } {
    const {
      share_map = true,
      share_bookings = true,
      share_packing = false,
      share_budget = false,
      share_collab = false,
    } = permissions;

    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    return this.dbs.transaction(() => {
      const existing = this.dbs.get<{ token: string }>('SELECT token FROM share_tokens WHERE trip_id = ?', tripId);
      if (existing) {
        this.dbs.run(
          'UPDATE share_tokens SET share_map = ?, share_bookings = ?, share_packing = ?, share_budget = ?, share_collab = ?, expires_at = ? WHERE trip_id = ?',
          share_map ? 1 : 0, share_bookings ? 1 : 0, share_packing ? 1 : 0, share_budget ? 1 : 0, share_collab ? 1 : 0, expiresAt, tripId,
        );
        return { token: existing.token, created: false };
      }

      const token = crypto.randomBytes(24).toString('base64url');
      this.dbs.run(
        'INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tripId, token, userId, share_map ? 1 : 0, share_bookings ? 1 : 0, share_packing ? 1 : 0, share_budget ? 1 : 0, share_collab ? 1 : 0, expiresAt,
      );
      return { token, created: true };
    });
  }

  /**
   * Returns share token info for a trip, or null if no share link exists.
   */
  get(tripId: string): ShareTokenInfo | null {
    const row = this.dbs.get<any>('SELECT * FROM share_tokens WHERE trip_id = ?', tripId);
    if (!row) return null;
    return {
      token: row.token,
      created_at: row.created_at,
      share_map: !!row.share_map,
      share_bookings: !!row.share_bookings,
      share_packing: !!row.share_packing,
      share_budget: !!row.share_budget,
      share_collab: !!row.share_collab,
    };
  }

  /**
   * Deletes the share token for a trip.
   */
  remove(tripId: string): void {
    this.dbs.run('DELETE FROM share_tokens WHERE trip_id = ?', tripId);
  }

  /**
   * Loads the full public trip data for a share token, filtered by the token's
   * permission flags. Returns null if the token is invalid or the trip is gone.
   *
   * Every share flag is honoured server-side — the client gates these too, but
   * it must not rely on that (mirrors journeyShareService). A withheld section
   * is never even queried. share_map covers the whole itinerary: days, their
   * assignments/notes, and the place list with coordinates, addresses and notes.
   */
  getSharedTripData(token: string): PublicSharedTripData | null {
    const shareRow = this.dbs.get<{
      trip_id: number; share_map: number; share_bookings: number;
      share_packing: number; share_budget: number; share_collab: number;
    }>(
      "SELECT trip_id, share_map, share_bookings, share_packing, share_budget, share_collab FROM share_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
      token,
    );
    if (!shareRow) return null;

    const tripId = shareRow.trip_id;

    // Trip
    const tripRow = this.dbs.get<PublicSharedTripData['trip'] & { user_id: number }>(
      'SELECT user_id, title, description, start_date, end_date, cover_image, currency FROM trips WHERE id = ?',
      tripId,
    );
    if (!tripRow) return null;
    const trip: PublicSharedTripData['trip'] = {
      title: tripRow.title,
      description: tripRow.description,
      start_date: tripRow.start_date,
      end_date: tripRow.end_date,
      cover_image: tripRow.cover_image,
      currency: tripRow.currency,
    };

    const permissions = {
      share_map: !!shareRow.share_map,
      share_bookings: !!shareRow.share_bookings,
      share_packing: !!shareRow.share_packing,
      share_budget: !!shareRow.share_budget,
      share_collab: !!shareRow.share_collab,
    };

    // Itinerary — days with assignments/notes, and the place pool
    let days: PublicSharedTripData['days'] = [];
    let assignments: PublicSharedTripData['assignments'] = {};
    let dayNotes: PublicSharedTripData['dayNotes'] = {};
    let places: PublicSharedTripData['places'] = [];
    let categories: PublicSharedTripData['categories'] = [];
    if (permissions.share_map) {
      days = this.dbs.all<PublicSharedTripData['days'][number]>(
        'SELECT id, day_number, title, date FROM days WHERE trip_id = ? ORDER BY day_number ASC', tripId,
      );
      const dayIds = days.map(d => d.id);

      if (dayIds.length > 0) {
        const ph = dayIds.map(() => '?').join(',');
        const allAssignments = this.dbs.all<{
          id: number; day_id: number; order_index: number; place_id: number; place_name: string;
          place_description: string | null; lat: number | null; lng: number | null; address: string | null;
          category_id: number | null; place_time: string | null; end_time: string | null; place_notes: string | null;
          image_url: string | null; category_color: string | null; category_icon: string | null;
        }>(`
          SELECT da.id, da.day_id, da.order_index, p.id as place_id, p.name as place_name, p.description as place_description,
            p.lat, p.lng, p.address, p.category_id,
            COALESCE(da.assignment_time, p.place_time) as place_time,
            COALESCE(da.assignment_end_time, p.end_time) as end_time,
            p.notes as place_notes, p.image_url, c.color as category_color, c.icon as category_icon
          FROM day_assignments da
          JOIN places p ON da.place_id = p.id
          LEFT JOIN categories c ON p.category_id = c.id
          WHERE da.day_id IN (${ph}) AND p.trip_id = ?
          ORDER BY da.order_index ASC, da.created_at ASC
        `, ...dayIds, tripId);

        const byDay: PublicSharedTripData['assignments'] = {};
        for (const a of allAssignments) {
          if (!byDay[a.day_id]) byDay[a.day_id] = [];
          byDay[a.day_id].push({
            id: a.id, order_index: a.order_index,
            place: {
              id: a.place_id, name: a.place_name, description: a.place_description,
              lat: a.lat, lng: a.lng, address: a.address, category_id: a.category_id,
              place_time: a.place_time, end_time: a.end_time, notes: a.place_notes,
              image_url: rewritePlacePhotoUrl(a.image_url, token),
              category: a.category_id ? { color: a.category_color, icon: a.category_icon } : null,
            }
          });
        }
        assignments = byDay;

        const allNotes = this.dbs.all<{ id: number; day_id: number; sort_order: number; text: string; time: string | null }>(
          `SELECT id, day_id, sort_order, text, time FROM day_notes WHERE day_id IN (${ph}) ORDER BY sort_order ASC, created_at ASC`, ...dayIds,
        );
        const notesByDay: PublicSharedTripData['dayNotes'] = {};
        for (const n of allNotes) {
          if (!notesByDay[n.day_id]) notesByDay[n.day_id] = [];
          notesByDay[n.day_id].push({ id: n.id, sort_order: n.sort_order, text: n.text, time: n.time });
        }
        dayNotes = notesByDay;
      }

      places = this.dbs.all<PublicSharedTripData['places'][number]>(`
        SELECT p.id, p.name, p.lat, p.lng, c.color as category_color, c.icon as category_icon, p.notes
        FROM places p LEFT JOIN categories c ON p.category_id = c.id
        WHERE p.trip_id = ? ORDER BY p.created_at DESC
      `, tripId);
      // The compact map-place DTO intentionally omits category_id, so fetch the
      // root color lookup separately — but only while map sharing is enabled.
      categories = this.dbs.all<PublicSharedTripData['categories'][number]>(`
        SELECT DISTINCT c.id, c.color
        FROM categories c JOIN places p ON p.category_id = c.id
        WHERE p.trip_id = ? ORDER BY c.id ASC
      `, tripId);
    }

    // Bookings — reservations carry per-day positions so the client can render
    // the same order as the planner
    let reservations: PublicSharedTripData['reservations'] = [];
    let accommodations: PublicSharedTripData['accommodations'] = [];
    if (permissions.share_bookings) {
      const dayPositions = this.dbs.all<{ reservation_id: number; day_id: number; position: number }>(`
        SELECT rdp.reservation_id, rdp.day_id, rdp.position
        FROM reservation_day_positions rdp
        JOIN reservations r ON rdp.reservation_id = r.id
        WHERE r.trip_id = ?
      `, tripId);

      const posMap = new Map<number, Record<number, number>>();
      for (const dp of dayPositions) {
        if (!posMap.has(dp.reservation_id)) posMap.set(dp.reservation_id, {});
        posMap.get(dp.reservation_id)![dp.day_id] = dp.position;
      }
      // The alias is not cosmetic: the visibility predicate qualifies its column,
      // and this query had no alias to qualify against.
      reservations = this.dbs.all<{
        id: number; type: string | null; title: string; status: string | null; reservation_time: string | null;
        reservation_end_time: string | null; location: string | null; metadata: string | null; assignment_id: number | null;
        day_id: number | null; end_day_id: number | null; day_plan_position: number | null;
      }>(
        `SELECT r.id, r.type, r.title, r.status, r.reservation_time, r.reservation_end_time, r.location,
          r.metadata, r.assignment_id, r.day_id, r.end_day_id, r.day_plan_position FROM reservations r
         WHERE r.trip_id = ? AND ${publicReservationSql('r')}
         ORDER BY r.reservation_time ASC`, tripId)
        .map((r) => ({
          id: r.id, type: r.type, title: r.title, status: r.status, reservation_time: r.reservation_time,
          reservation_end_time: r.reservation_end_time, location: r.location, metadata: sanitizeReservationMetadata(r.metadata),
          assignment_id: r.assignment_id, day_id: r.day_id, end_day_id: r.end_day_id,
          day_positions: posMap.get(r.id) ?? null, day_plan_position: r.day_plan_position,
        }));

      accommodations = this.dbs.all<PublicSharedTripData['accommodations'][number]>(`
        SELECT a.id, a.start_day_id, a.end_day_id, p.name as place_name
        FROM day_accommodations a JOIN places p ON a.place_id = p.id AND p.trip_id = a.trip_id
        WHERE a.trip_id = ? AND ${publicStaySql('a')}
      `, tripId);
    }

    // Packing — a public viewer is neither owner nor recipient, so only Common items
    // may surface; never a co-member's private/personal packing items (#858).
    const packing: PublicSharedTripData['packing'] = permissions.share_packing
      ? this.dbs.all<PublicSharedTripData['packing'][number]>('SELECT id, category, name, checked FROM packing_items WHERE trip_id = ? AND is_private = 0 ORDER BY sort_order ASC', tripId)
      : [];

    // Budget
    const budget: PublicSharedTripData['budget'] = permissions.share_budget
      ? this.dbs.all<PublicSharedTripData['budget'][number]>('SELECT id, category, name, total_price, currency FROM budget_items WHERE trip_id = ? ORDER BY category ASC', tripId)
      : [];

    // Collab messages (only if owner chose to share)
    const collabMessages: PublicSharedTripData['collab'] = permissions.share_collab
      ? this.dbs.all<PublicSharedTripData['collab'][number]>('SELECT m.id, u.username, u.avatar, m.created_at, m.text FROM collab_messages m JOIN users u ON m.user_id = u.id WHERE m.trip_id = ? AND m.deleted = 0 ORDER BY m.created_at', tripId)
      : [];

    // The anonymous response needs only one owner preference. Do not call
    // SettingsService here: it merges/decrypts unrelated credentials (CARTO,
    // Mapbox, LLM, …) which must never be read for a public link.
    const tripCurrency = trip.currency?.trim() || 'EUR';
    let baseCurrency = tripCurrency;
    if (permissions.share_budget) {
      const userCurrency = readPublicCurrency(this.dbs.get<{ value: string | null }>(
        "SELECT value FROM settings WHERE user_id = ? AND key = 'default_currency'", tripRow.user_id,
      )?.value);
      const instanceCurrency = userCurrency ? null : readPublicCurrency(this.dbs.get<{ value: string | null }>(
        "SELECT value FROM app_settings WHERE key = 'default_user_setting_default_currency'",
      )?.value);
      baseCurrency = userCurrency ?? instanceCurrency ?? tripCurrency;
    }

    return {
      trip, baseCurrency, cartoApiKey: '', categories, permissions,
      days, assignments, dayNotes, places,
      reservations, accommodations,
      packing, budget,
      collab: collabMessages,
    };
  }

  /**
   * Resolves the storage name (category 'photos-google') for a cached place
   * photo requested through a public share link. Validates that the token is
   * valid + unexpired and that the place actually belongs to that token's trip
   * (matched via the stored proxy URL, which covers both Google `placeId` and
   * Wikimedia `coords:` pseudo-IDs without depending on google_place_id).
   * Returns null — never throws — so the caller answers a plain miss,
   * mirroring the authenticated bytes endpoint.
   */
  async getSharedPlacePhotoKey(token: string, placeId: string): Promise<string | null> {
    const shareRow = this.dbs.get<{ trip_id: string; share_map: number }>(
      "SELECT trip_id, share_map FROM share_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
      token,
    );
    if (!shareRow) return null;
    // Place photos belong to the map/itinerary section — withhold them when the
    // owner disabled the map, matching getSharedTripData which no longer returns
    // the places (and thus their ids) in that case.
    if (!shareRow.share_map) return null;

    const expectedUrl = `${PLACE_PHOTO_PROXY_PREFIX}${encodeURIComponent(placeId)}/bytes`;
    const place = this.dbs.get('SELECT 1 FROM places WHERE trip_id = ? AND image_url = ?', shareRow.trip_id, expectedUrl);
    if (!place) return null;

    return this.photoCache.serveKey(placeId);
  }
}
