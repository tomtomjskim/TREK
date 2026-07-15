import { expect, test } from '@playwright/test';

test('MapLibre applies Korean label fallbacks to OpenFreeMap name layers', async ({ page }) => {
  const settingsResponse = await page.request.post('/api/settings/bulk', {
    data: {
      settings: {
        map_provider: 'maplibre-gl',
        maplibre_style: 'https://tiles.openfreemap.org/styles/liberty',
        map_label_language: 'ko',
      },
    },
  });
  expect(settingsResponse.ok()).toBeTruthy();

  const tripResponse = await page.request.post('/api/trips', {
    data: { title: `E2E Korean Map Labels ${Date.now()}` },
  });
  expect(tripResponse.ok()).toBeTruthy();
  const { trip } = await tripResponse.json();
  const placeResponse = await page.request.post(`/api/trips/${trip.id}/places`, {
    data: { name: 'Tokyo Station', lat: 35.681236, lng: 139.767125 },
  });
  expect(placeResponse.ok()).toBeTruthy();

  try {
    await page.goto(`/trips/${trip.id}`);
    await expect(page.locator('.maplibregl-map')).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const map = (window as Window & { __trek_map?: { loaded?: () => boolean } }).__trek_map;
        return map?.loaded?.() === true;
      },
      null,
      { timeout: 30_000 }
    );

    const localizedLayers = await page.evaluate(() => {
      const map = (
        window as Window & {
          __trek_map?: {
            getStyle: () => { layers?: Array<{ id: string; type?: string }> };
            getLayoutProperty: (id: string, property: string) => unknown;
          };
        }
      ).__trek_map;
      if (!map) return [];
      return (map.getStyle().layers ?? [])
        .filter((layer) => layer.type === 'symbol')
        .map((layer) => ({
          id: layer.id,
          expression: JSON.stringify(map.getLayoutProperty(layer.id, 'text-field')) ?? '',
        }))
        .filter((layer) => layer.expression.includes('name:ko'));
    });

    expect(localizedLayers.length).toBeGreaterThan(0);
    expect(localizedLayers.some((layer) => layer.id.includes('label'))).toBe(true);

    if (process.env.TREK_CAPTURE_EVIDENCE) {
      await page.screenshot({ path: '/tmp/trek-map-label-language-ko.png', fullPage: true });
    }
  } finally {
    await page.request.post('/api/settings/bulk', {
      data: { settings: { map_provider: 'leaflet', map_label_language: 'auto' } },
    });
  }
});
