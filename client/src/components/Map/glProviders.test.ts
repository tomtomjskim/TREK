import { describe, expect, it } from 'vitest'
import {
  MAPBOX_DEFAULT_STYLE,
  OPENFREEMAP_DEFAULT_STYLE,
  isOpenFreeMapStyle,
  normalizeStyleForProvider,
  styleForActiveProvider,
  basemapLanguage,
  resolveMapLabelLanguage,
  applyMapLibreLabelLanguage,
} from './glProviders'

describe('glProviders', () => {
  it('keeps OpenFreeMap styles for MapLibre', () => {
    const style = 'https://tiles.openfreemap.org/styles/bright'

    expect(normalizeStyleForProvider('maplibre-gl', style)).toBe(style)
  })

  it('falls back to OpenFreeMap for MapLibre styles outside the CSP allowlist', () => {
    expect(normalizeStyleForProvider('maplibre-gl', 'https://demotiles.maplibre.org/style.json')).toBe(
      OPENFREEMAP_DEFAULT_STYLE,
    )
    expect(normalizeStyleForProvider('maplibre-gl', MAPBOX_DEFAULT_STYLE)).toBe(OPENFREEMAP_DEFAULT_STYLE)
  })

  it('leaves Mapbox styles unchanged for Mapbox GL', () => {
    expect(normalizeStyleForProvider('mapbox-gl', MAPBOX_DEFAULT_STYLE)).toBe(MAPBOX_DEFAULT_STYLE)
  })

  it('matches the OpenFreeMap CSP host', () => {
    expect(isOpenFreeMapStyle('https://tiles.openfreemap.org/styles/liberty')).toBe(true)
    expect(isOpenFreeMapStyle('https://demotiles.maplibre.org/style.json')).toBe(false)
  })

  it('rejects host/userinfo spoofing and http downgrade', () => {
    expect(isOpenFreeMapStyle('https://tiles.openfreemap.org.evil.com/styles/x')).toBe(false)
    expect(isOpenFreeMapStyle('https://evil.com/@tiles.openfreemap.org/styles/x')).toBe(false)
    expect(isOpenFreeMapStyle('http://tiles.openfreemap.org/styles/liberty')).toBe(false)
    expect(isOpenFreeMapStyle('  https://tiles.openfreemap.org/styles/liberty  ')).toBe(true)
  })

  it('falls back to provider defaults for empty/whitespace styles', () => {
    expect(normalizeStyleForProvider('maplibre-gl', '')).toBe(OPENFREEMAP_DEFAULT_STYLE)
    expect(normalizeStyleForProvider('maplibre-gl', '   ')).toBe(OPENFREEMAP_DEFAULT_STYLE)
    expect(normalizeStyleForProvider('mapbox-gl', '')).toBe(MAPBOX_DEFAULT_STYLE)
    expect(normalizeStyleForProvider('mapbox-gl', null)).toBe(MAPBOX_DEFAULT_STYLE)
  })

  it('styleForActiveProvider reads each provider\'s own style slot', () => {
    const mb = 'mapbox://styles/me/custom'
    const ofm = 'https://tiles.openfreemap.org/styles/bright'
    expect(styleForActiveProvider('mapbox-gl', mb, ofm)).toBe(mb)
    expect(styleForActiveProvider('maplibre-gl', mb, ofm)).toBe(ofm)
    // An empty MapLibre slot falls back to the OpenFreeMap default, leaving mapbox untouched.
    expect(styleForActiveProvider('maplibre-gl', mb, '')).toBe(OPENFREEMAP_DEFAULT_STYLE)
  })

  it('basemapLanguage maps TREK UI codes to basemap label codes (#1299)', () => {
    // Pass-through for plain ISO 639-1 codes.
    expect(basemapLanguage('en')).toBe('en')
    expect(basemapLanguage('de')).toBe('de')
    expect(basemapLanguage('fr')).toBe('fr')
    // TREK-specific overrides.
    expect(basemapLanguage('br')).toBe('pt')
    expect(basemapLanguage('gr')).toBe('el')
    expect(basemapLanguage('zh')).toBe('zh-Hans')
    expect(basemapLanguage('zhTw')).toBe('zh-Hant')
    expect(basemapLanguage('zh-TW')).toBe('zh-Hant')
    // Falls back to English when unset.
    expect(basemapLanguage(undefined)).toBe('en')
    expect(basemapLanguage('')).toBe('en')
  })

  it('resolves the saved label preference without depending on browser locale', () => {
    expect(resolveMapLabelLanguage('auto', 'ko')).toBe('ko')
    expect(resolveMapLabelLanguage(undefined, 'ko')).toBe('ko')
    expect(resolveMapLabelLanguage('ko', 'en')).toBe('ko')
    expect(resolveMapLabelLanguage('en', 'ko')).toBe('en')
    expect(resolveMapLabelLanguage('local', 'ko')).toBeNull()
  })

  it('localizes only MapLibre name layers and preserves provider fallbacks', () => {
    const originalName = ['case', ['has', 'name:latin'], ['get', 'name:latin'], ['get', 'name']]
    const fields: Record<string, unknown> = {
      places: originalName,
      shields: ['get', 'ref'],
      clusters: ['get', 'point_count_abbreviated'],
    }
    const map = {
      getStyle: () => ({
        layers: [
          { id: 'places', type: 'symbol' },
          { id: 'shields', type: 'symbol' },
          { id: 'clusters', type: 'symbol' },
          { id: 'roads', type: 'line' },
        ],
      }),
      getLayoutProperty: vi.fn((id: string) => fields[id]),
      setLayoutProperty: vi.fn((id: string, _property: string, value: unknown) => { fields[id] = value }),
    }

    expect(applyMapLibreLabelLanguage(map, 'ko')).toBe(1)
    expect(fields.places).toEqual([
      'coalesce',
      ['get', 'name:ko'],
      ['get', 'name_ko'],
      originalName,
    ])
    expect(fields.shields).toEqual(['get', 'ref'])
    expect(fields.clusters).toEqual(['get', 'point_count_abbreviated'])
    expect(map.setLayoutProperty).toHaveBeenCalledTimes(1)
  })

  it('switches languages from the original MapLibre expression and restores native labels', () => {
    const original = ['coalesce', ['get', 'name_en'], ['get', 'name']]
    let field: unknown = original
    const map = {
      getStyle: () => ({ layers: [{ id: 'settlement', type: 'symbol' }] }),
      getLayoutProperty: vi.fn(() => field),
      setLayoutProperty: vi.fn((_id: string, _property: string, value: unknown) => { field = value }),
    }

    applyMapLibreLabelLanguage(map, 'ko')
    applyMapLibreLabelLanguage(map, 'en')
    expect(field).toEqual(['coalesce', ['get', 'name:en'], ['get', 'name_en'], original])
    expect(JSON.stringify(field)).not.toContain('name:ko')

    applyMapLibreLabelLanguage(map, null)
    expect(field).toEqual(original)
  })

  it('supports token-style name fields while leaving unrelated text untouched', () => {
    const fields: Record<string, unknown> = { label: '{name}', ref: '{ref}' }
    const map = {
      getStyle: () => ({ layers: [
        { id: 'label', type: 'symbol' },
        { id: 'ref', type: 'symbol' },
      ] }),
      getLayoutProperty: vi.fn((id: string) => fields[id]),
      setLayoutProperty: vi.fn((id: string, _property: string, value: unknown) => { fields[id] = value }),
    }

    expect(applyMapLibreLabelLanguage(map, 'ko')).toBe(1)
    expect(fields.label).toEqual(['coalesce', ['get', 'name:ko'], ['get', 'name_ko'], '{name}'])
    expect(fields.ref).toBe('{ref}')
  })
})
