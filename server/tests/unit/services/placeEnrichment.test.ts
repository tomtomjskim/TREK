/**
 * Unit tests for the import-enrichment match selector (#886).
 * Covers PENRICH-001 to PENRICH-004 — the coordinate-validation guard that
 * prevents a name search from overwriting an imported place with the wrong POI.
 */
import { describe, it, expect, vi } from 'vitest';

// placeEnrichment pulls in the DB, websocket and maps service at import time;
// stub them so the pure match selector can be tested in isolation.
vi.mock('../../../src/db/database', () => ({ db: {}, getPlaceWithTags: () => null }));
vi.mock('../../../src/websocket', () => ({ broadcast: () => {} }));
vi.mock('../../../src/services/mapsService', () => ({
  getMapsKey: () => null,
  searchPlaces: async () => ({ places: [], source: 'none' }),
  getPlacePhoto: async () => ({ photoUrl: '', attribution: null }),
}));

import { pickEnrichmentMatch, rankEnrichmentCandidates } from '../../../src/services/placeEnrichment';

const target = { lat: 48.85, lng: 2.35 };

describe('pickEnrichmentMatch', () => {
  it('PENRICH-001: picks the closest Google candidate within the radius', () => {
    const candidates = [
      { google_place_id: 'far', lat: 48.8512, lng: 2.3512 }, // ~170 m
      { google_place_id: 'near', lat: 48.85, lng: 2.35 }, // exact
    ];
    const match = pickEnrichmentMatch(candidates, target);
    expect(match?.google_place_id).toBe('near');
  });

  it('PENRICH-002: returns null when every candidate is beyond the radius', () => {
    const candidates = [{ google_place_id: 'A', lat: 48.86, lng: 2.36 }]; // ~1.2 km
    expect(pickEnrichmentMatch(candidates, target)).toBeNull();
  });

  it('PENRICH-003: ignores candidates without a google_place_id (e.g. OSM results)', () => {
    const candidates = [
      { google_place_id: null, lat: 48.85, lng: 2.35 },
      { name: 'no id', lat: 48.85, lng: 2.35 },
    ];
    expect(pickEnrichmentMatch(candidates, target)).toBeNull();
  });

  it('PENRICH-004: ignores candidates with non-numeric coordinates', () => {
    const candidates = [{ google_place_id: 'A', lat: 'x', lng: 'y' }];
    expect(pickEnrichmentMatch(candidates as never, target)).toBeNull();
  });
});

describe('rankEnrichmentCandidates', () => {
  it('PENRICH-005: marks a close normalized-name match safe and recommends it first', () => {
    const ranked = rankEnrichmentCandidates([
      { google_place_id: 'review', name: 'Another Shop', address: 'A', lat: 48.8501, lng: 2.3501, types: ['store'] },
      { google_place_id: 'safe', name: 'Cafe Étoile', address: 'B', lat: 48.8502, lng: 2.3502, types: ['cafe'] },
    ], { name: 'Ｃａｆｅ Étoile', lat: 48.85, lng: 2.35 });

    expect(ranked[0]).toMatchObject({ google_place_id: 'safe', confidence: 'safe' });
    expect(ranked[0].distance_meters).toBeLessThan(100);
  });

  it('PENRICH-006: keeps a nearby name mismatch for review and drops hits beyond 250m', () => {
    const ranked = rankEnrichmentCandidates([
      { google_place_id: 'near', name: 'Different', lat: 48.8503, lng: 2.3503 },
      { google_place_id: 'far', name: 'Cafe', lat: 48.86, lng: 2.36 },
    ], { name: 'Cafe', lat: 48.85, lng: 2.35 });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ google_place_id: 'near', confidence: 'review' });
  });

  it('PENRICH-007: returns at most three valid Google candidates', () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      google_place_id: `g${index}`,
      name: 'Cafe',
      lat: 48.85 + index * 0.00001,
      lng: 2.35,
    }));
    expect(rankEnrichmentCandidates(candidates, { name: 'Cafe', lat: 48.85, lng: 2.35 })).toHaveLength(3);
  });
});
