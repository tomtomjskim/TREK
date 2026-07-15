export type GlMapProvider = 'mapbox-gl' | 'maplibre-gl'
export type MapLabelLanguage = 'auto' | 'local' | 'ko' | 'en'

export interface GlStylePreset {
  name: string
  url: string
  tags?: string[]
}

export const MAPBOX_DEFAULT_STYLE = 'mapbox://styles/mapbox/standard'
export const OPENFREEMAP_DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

export const MAPBOX_STYLE_PRESETS: GlStylePreset[] = [
  { name: 'Mapbox Standard', url: MAPBOX_DEFAULT_STYLE, tags: ['3D', 'Apple-like'] },
  { name: 'Standard Satellite', url: 'mapbox://styles/mapbox/standard-satellite', tags: ['3D', 'Satellite'] },
  { name: 'Streets', url: 'mapbox://styles/mapbox/streets-v12', tags: ['3D', 'Classic'] },
  { name: 'Outdoors', url: 'mapbox://styles/mapbox/outdoors-v12', tags: ['3D', 'Terrain'] },
  { name: 'Light', url: 'mapbox://styles/mapbox/light-v11', tags: ['3D', 'Minimal'] },
  { name: 'Dark', url: 'mapbox://styles/mapbox/dark-v11', tags: ['3D', 'Dark'] },
  { name: 'Satellite', url: 'mapbox://styles/mapbox/satellite-v9', tags: ['3D', 'Satellite'] },
  { name: 'Satellite Streets', url: 'mapbox://styles/mapbox/satellite-streets-v12', tags: ['3D', 'Satellite'] },
  { name: 'Navigation Day', url: 'mapbox://styles/mapbox/navigation-day-v1', tags: ['3D', 'Apple-like'] },
  { name: 'Navigation Night', url: 'mapbox://styles/mapbox/navigation-night-v1', tags: ['3D', 'Dark'] },
]

export const OPENFREEMAP_STYLE_PRESETS: GlStylePreset[] = [
  { name: 'OpenFreeMap Liberty', url: OPENFREEMAP_DEFAULT_STYLE, tags: ['OpenFreeMap', '2D'] },
  { name: 'OpenFreeMap Bright', url: 'https://tiles.openfreemap.org/styles/bright', tags: ['OpenFreeMap', 'Classic'] },
  { name: 'OpenFreeMap Positron', url: 'https://tiles.openfreemap.org/styles/positron', tags: ['OpenFreeMap', 'Minimal'] },
]

export function getStylePresets(provider: GlMapProvider): GlStylePreset[] {
  return provider === 'maplibre-gl' ? OPENFREEMAP_STYLE_PRESETS : MAPBOX_STYLE_PRESETS
}

export function defaultStyleForProvider(provider: GlMapProvider): string {
  return provider === 'maplibre-gl' ? OPENFREEMAP_DEFAULT_STYLE : MAPBOX_DEFAULT_STYLE
}

export function isOpenFreeMapStyle(style?: string | null): boolean {
  return (style || '').trim().startsWith('https://tiles.openfreemap.org/')
}

export function normalizeStyleForProvider(provider: GlMapProvider, style?: string | null): string {
  const trimmed = (style || '').trim()
  if (!trimmed) return defaultStyleForProvider(provider)
  if (provider === 'maplibre-gl') {
    return isOpenFreeMapStyle(trimmed) ? trimmed : OPENFREEMAP_DEFAULT_STYLE
  }
  return trimmed
}

/** The settings key that holds the style for a given GL provider. */
export function styleSettingKey(provider: GlMapProvider): 'mapbox_style' | 'maplibre_style' {
  return provider === 'maplibre-gl' ? 'maplibre_style' : 'mapbox_style'
}

/**
 * Each GL provider keeps its style in its own slot (mapbox_style / maplibre_style), so
 * switching providers never overwrites the other one's custom style. Picks and normalizes
 * the style for the active provider.
 */
export function styleForActiveProvider(
  provider: GlMapProvider,
  mapboxStyle?: string | null,
  maplibreStyle?: string | null,
): string {
  return normalizeStyleForProvider(provider, provider === 'maplibre-gl' ? maplibreStyle : mapboxStyle)
}

// A few TREK UI language codes differ from what the GL basemap expects for its labels.
const BASEMAP_LANG_OVERRIDES: Record<string, string> = {
  br: 'pt',          // TREK 'br' = Brazilian Portuguese
  gr: 'el',          // TREK 'gr' = Greek
  zh: 'zh-Hans',
  zhTw: 'zh-Hant',
  'zh-TW': 'zh-Hant',
}

/**
 * Maps a TREK UI language code to the label language the GL basemap expects. Used to pin
 * Mapbox Standard's basemap labels to the user's language so they don't fall back to the
 * browser/OS locale and stack multiple scripts per place (#1299).
 */
export function basemapLanguage(uiLang: string | undefined): string {
  const code = (uiLang || 'en').trim()
  return BASEMAP_LANG_OVERRIDES[code] ?? code
}

/** Resolves a saved label preference. `null` means to keep the provider's native labels. */
export function resolveMapLabelLanguage(
  preference: MapLabelLanguage | undefined,
  uiLang: string | undefined,
): string | null {
  if (preference === 'local') return null
  if (preference === 'ko' || preference === 'en') return preference
  return basemapLanguage(uiLang)
}

interface MapLibreLabelLayer {
  id: string
  type?: string
}

interface MapLibreLabelMap {
  getStyle: () => { layers?: MapLibreLabelLayer[] } | null | undefined
  getLayoutProperty: (layerId: string, property: 'text-field') => unknown
  setLayoutProperty: (layerId: string, property: 'text-field', value: unknown) => unknown
}

const originalLabelExpressions = new WeakMap<object, Map<string, unknown>>()

function containsNameReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === 'name'
      || /^name[:_][A-Za-z0-9-]+$/.test(value)
      || /\{name(?::[^}]+|_[^}]+)?\}/.test(value)
  }
  if (Array.isArray(value)) return value.some(containsNameReference)
  if (value && typeof value === 'object') return Object.values(value).some(containsNameReference)
  return false
}

/**
 * Applies a localized name fallback to MapLibre symbol layers while retaining each
 * provider expression so subsequent language changes never nest and native mode can
 * restore the style exactly. Returns the number of layers changed.
 */
export function applyMapLibreLabelLanguage(map: MapLibreLabelMap, language: string | null): number {
  const mapKey = map as object
  let originals = originalLabelExpressions.get(mapKey)
  if (!originals) {
    originals = new Map<string, unknown>()
    originalLabelExpressions.set(mapKey, originals)
  }

  let changed = 0
  const layers = map.getStyle()?.layers ?? []
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue
    try {
      const current = map.getLayoutProperty(layer.id, 'text-field')
      const original = originals.get(layer.id) ?? current
      if (!containsNameReference(original)) continue
      if (!originals.has(layer.id)) originals.set(layer.id, original)
      const next = language
        ? ['coalesce', ['get', `name:${language}`], ['get', `name_${language}`], original]
        : original
      map.setLayoutProperty(layer.id, 'text-field', next)
      changed += 1
    } catch {
      // Provider styles can contain unsupported expressions; leave that layer untouched.
    }
  }
  return changed
}
