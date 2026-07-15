import { tagSchema } from '../tag/tag.schema';

import { z } from 'zod';

/**
 * Place API contract — single source of truth for the /api/trips/:tripId/places
 * endpoints (place pool CRUD, GPX/map/list imports, image search, bulk delete).
 *
 * Trip-scoped; mutations use the 'place_edit' permission. The legacy route
 * (server/src/routes/places.ts) wraps placeService and fires the journey
 * place-created/updated/deleted hooks. Place rows are wide and provider-derived,
 * so create/update payloads stay mostly open with `name` pinned; string fields
 * are capped (name 200, description 2000, address 500, notes 2000) by the legacy
 * validateStringLengths, reproduced in the controller.
 */

const open = z.record(z.string(), z.unknown());

/**
 * Embedded category as returned on a place — a trimmed projection of the
 * categories row (id/name/color/icon), built inline by placeService and
 * getPlaceWithTags. `null` when the place has no category_id.
 */
export const placeCategorySchema = z
  .object({
    id: z.number(),
    name: z.string().nullable(),
    color: z.string().nullable(),
    icon: z.string().nullable(),
  })
  .nullable();
export type PlaceCategory = z.infer<typeof placeCategorySchema>;

/**
 * Full place entity as returned by the place list / get / create / update
 * endpoints (server/src/services/placeService.ts -> getPlaceWithTags). All
 * columns of the `places` table (see server/data DB) plus the joined `category`
 * projection and `tags` array. Numbers (lat/lng/price) are SQLite REAL, ids are
 * INTEGER; provider-derived columns are nullable.
 */
export const placeSchema = z.object({
  id: z.number(),
  trip_id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  address: z.string().nullable().optional(),
  category_id: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  reservation_status: z.string().nullable().optional(),
  reservation_notes: z.string().nullable().optional(),
  reservation_datetime: z.string().nullable().optional(),
  place_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  duration_minutes: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  google_place_id: z.string().nullable().optional(),
  google_ftid: z.string().nullable().optional(),
  osm_id: z.string().nullable().optional(),
  route_geometry: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  transport_mode: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  category: placeCategorySchema.optional(),
  tags: z.array(tagSchema.partial()).optional(),
});
export type Place = z.infer<typeof placeSchema>;

/**
 * Trimmed place projection embedded inside a day-assignment response
 * (server/src/services/queryHelpers.ts -> formatAssignmentWithPlace). This is a
 * SUBSET of the full place: no trip_id / osm_id / route_geometry / created_at /
 * reservation_* — only the fields the planner needs to render the itinerary card.
 */
export const assignmentPlaceSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  address: z.string().nullable().optional(),
  category_id: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  place_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  duration_minutes: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  transport_mode: z.string().nullable().optional(),
  google_place_id: z.string().nullable().optional(),
  google_ftid: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  category: placeCategorySchema.optional(),
  tags: z.array(tagSchema.partial()).optional(),
});
export type AssignmentPlace = z.infer<typeof assignmentPlaceSchema>;

export const placeCreateRequestSchema = open.and(z.object({ name: z.string().min(1) }));
export type PlaceCreateRequest = z.infer<typeof placeCreateRequestSchema>;

export const placeUpdateRequestSchema = open;
export type PlaceUpdateRequest = z.infer<typeof placeUpdateRequestSchema>;

export const placeBulkDeleteRequestSchema = z.object({
  ids: z.array(z.number()),
});
export type PlaceBulkDeleteRequest = z.infer<typeof placeBulkDeleteRequestSchema>;

export const placeBulkUpdateRequestSchema = z.object({
  ids: z.array(z.number()).min(1),
  // null clears the category ("No category"); a number sets it. Optional so the
  // field can be omitted, but the endpoint requires it to be present to act.
  category_id: z.number().nullable().optional(),
});
export type PlaceBulkUpdateRequest = z.infer<typeof placeBulkUpdateRequestSchema>;

export const placeImportListRequestSchema = z.object({
  url: z.string().min(1),
  // Opt-in: enrich imported places via the Places API (#886). Requires a Google
  // Maps key; runs as a background pass after the import returns.
  enrich: z.boolean().optional(),
});
export type PlaceImportListRequest = z.infer<typeof placeImportListRequestSchema>;

const placeEnrichmentLanguageSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Invalid language tag');

export const placeEnrichmentPreviewRequestSchema = z.object({
  place_ids: z.array(z.number().int().positive()).max(100).optional(),
  lang: placeEnrichmentLanguageSchema.optional(),
});
export type PlaceEnrichmentPreviewRequest = z.infer<typeof placeEnrichmentPreviewRequestSchema>;

const googlePlaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid Google place ID');

export const placeEnrichmentApplyRequestSchema = z.object({
  matches: z
    .array(
      z.object({
        place_id: z.number().int().positive(),
        google_place_id: googlePlaceIdSchema,
      }),
    )
    .min(1)
    .max(100),
  lang: placeEnrichmentLanguageSchema.optional(),
});
export type PlaceEnrichmentApplyRequest = z.infer<typeof placeEnrichmentApplyRequestSchema>;

export interface PlaceEnrichmentCandidate {
  google_place_id: string;
  google_ftid: string | null;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  types: string[];
  distance_meters: number;
  confidence: 'safe' | 'review';
}

export interface PlaceEnrichmentUsage {
  period: string;
  timezone: string;
  sku: string;
  used: number;
  cap: number;
  remaining: number;
  official_free_cap: number | null;
  exhausted: boolean;
}

export interface PlaceEnrichmentStop {
  code: string;
  error: string;
  sku?: string;
  usage?: unknown;
}

export interface PlaceEnrichmentPreviewResult {
  entries: Array<{
    place_id: number;
    place_name: string;
    current_address: string | null;
    candidates: PlaceEnrichmentCandidate[];
  }>;
  errors: Array<{ place_id: number; place_name: string; code: string; error: string }>;
  requested: number;
  processed: number;
  skipped: number;
  stopped: PlaceEnrichmentStop | null;
  usage: PlaceEnrichmentUsage[];
}

export interface PlaceEnrichmentApplyResult {
  updated: Place[];
  errors: Array<{ place_id: number; code: string; error: string }>;
  requested: number;
  processed: number;
  skipped: number;
  stopped: PlaceEnrichmentStop | null;
  usage: PlaceEnrichmentUsage[];
}

/** Query filters for the place list. */
export const placeListQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
});
export type PlaceListQuery = z.infer<typeof placeListQuerySchema>;
