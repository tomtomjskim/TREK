import {
  placeCreateRequestSchema,
  placeBulkDeleteRequestSchema,
  placeImportListRequestSchema,
  placeEnrichmentPreviewRequestSchema,
  placeEnrichmentApplyRequestSchema,
} from './place.schema';

import { describe, it, expect } from 'vitest';

describe('placeCreateRequestSchema', () => {
  it('requires a name and keeps the other place fields open', () => {
    expect(
      placeCreateRequestSchema.safeParse({
        name: 'Spot',
        lat: 1,
        lng: 2,
        anything: true,
      }).success,
    ).toBe(true);
    expect(placeCreateRequestSchema.safeParse({ lat: 1 }).success).toBe(false);
  });
});

describe('placeBulkDeleteRequestSchema', () => {
  it('requires a numeric ids array', () => {
    expect(placeBulkDeleteRequestSchema.safeParse({ ids: [1, 2] }).success).toBe(true);
    expect(placeBulkDeleteRequestSchema.safeParse({ ids: ['a'] }).success).toBe(false);
  });
});

describe('placeImportListRequestSchema', () => {
  it('requires a non-empty url', () => {
    expect(placeImportListRequestSchema.safeParse({ url: 'http://x' }).success).toBe(true);
    expect(placeImportListRequestSchema.safeParse({ url: '' }).success).toBe(false);
  });
});

describe('place enrichment request schemas', () => {
  it('accepts supported language tags and rejects query-string injection', () => {
    expect(placeEnrichmentPreviewRequestSchema.safeParse({ lang: 'pt-BR' }).success).toBe(true);
    expect(placeEnrichmentPreviewRequestSchema.safeParse({ lang: 'en&region=US' }).success).toBe(false);
  });

  it('limits batches and accepts only Google place-id characters', () => {
    expect(
      placeEnrichmentPreviewRequestSchema.safeParse({ place_ids: Array.from({ length: 101 }, (_, i) => i + 1) })
        .success,
    ).toBe(false);
    expect(
      placeEnrichmentApplyRequestSchema.safeParse({
        matches: [{ place_id: 1, google_place_id: 'ChIJ_valid-ID' }],
      }).success,
    ).toBe(true);
    expect(
      placeEnrichmentApplyRequestSchema.safeParse({
        matches: [{ place_id: 1, google_place_id: 'ChIJ?unsafe' }],
      }).success,
    ).toBe(false);
  });
});
