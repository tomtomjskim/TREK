import { expect, test, type Page, type Request } from '@playwright/test';

const CARTO_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

async function dismissReleaseNotice(page: Page) {
  const closeButton = page.locator('.rn-close');
  const appeared = await closeButton.waitFor({ state: 'visible', timeout: 1_500 }).then(
    () => true,
    () => false,
  );
  if (appeared) await closeButton.click();
}

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
    await dismissReleaseNotice(page);
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
      await dismissReleaseNotice(page);
      await page.screenshot({ path: '/tmp/trek-map-label-language-ko.png', fullPage: true });
    }
  } finally {
    await page.request.post('/api/settings/bulk', {
      data: { settings: { map_provider: 'leaflet', map_label_language: 'auto' } },
    });
  }
});

test('the plan map falls back to OpenFreeMap without requesting CARTO', async ({ page }) => {
  test.setTimeout(90_000);
  const cartoRequests: string[] = [];
  const openFreeMapRequests: string[] = [];
  const pendingMapRequests = new Set<Request>();
  let lastMapActivity = Date.now();
  page.on('request', (request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname === 'basemaps.cartocdn.com' || hostname.endsWith('.basemaps.cartocdn.com')) {
      cartoRequests.push(hostname);
      pendingMapRequests.add(request);
      lastMapActivity = Date.now();
    }
    if (hostname === 'tiles.openfreemap.org' || hostname.endsWith('.tiles.openfreemap.org')) {
      openFreeMapRequests.push(hostname);
      pendingMapRequests.add(request);
      lastMapActivity = Date.now();
    }
  });
  const finishMapRequest = (request: Request) => {
    if (pendingMapRequests.delete(request)) lastMapActivity = Date.now();
  };
  page.on('requestfinished', finishMapRequest);
  page.on('requestfailed', finishMapRequest);

  const originalResponse = await page.request.get('/api/settings');
  expect(originalResponse.ok()).toBeTruthy();
  const { settings: originalSettings } = await originalResponse.json();
  let tripId: number | undefined;

  try {
    const settingsResponse = await page.request.post('/api/settings/bulk', {
      data: {
        settings: {
          map_provider: 'leaflet',
          map_tile_url: CARTO_LIGHT,
        },
      },
    });
    expect(settingsResponse.ok()).toBeTruthy();

    const persistedResponse = await page.request.get('/api/settings');
    expect(persistedResponse.ok()).toBeTruthy();
    const { settings: persistedSettings } = await persistedResponse.json();
    expect(persistedSettings.map_tile_url).toBe(CARTO_LIGHT);
    expect(Boolean(persistedSettings.carto_api_key)).toBe(false);

    const tripResponse = await page.request.post('/api/trips', {
      data: { title: `E2E Keyless CARTO Fallback ${Date.now()}` },
    });
    expect(tripResponse.ok()).toBeTruthy();
    const { trip } = await tripResponse.json();
    tripId = trip.id;
    const placeResponse = await page.request.post(`/api/trips/${tripId}/places`, {
      data: { name: 'Seoul Station', lat: 37.554722, lng: 126.970833 },
    });
    expect(placeResponse.ok()).toBeTruthy();

    await page.goto('/settings?tab=map');
    await dismissReleaseNotice(page);
    await expect(page.locator('input[placeholder^="https://tile.openstreetmap.org/"]'))
      .toHaveValue(CARTO_LIGHT);
    cartoRequests.length = 0;
    openFreeMapRequests.length = 0;
    pendingMapRequests.clear();
    lastMapActivity = Date.now();

    await page.goto(`/trips/${tripId}`);
    await dismissReleaseNotice(page);
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => openFreeMapRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(
      () => pendingMapRequests.size === 0 && Date.now() - lastMapActivity >= 1_000,
      { timeout: 30_000 },
    ).toBe(true);
    expect(cartoRequests).toEqual([]);

    if (process.env.TREK_CAPTURE_EVIDENCE) {
      await dismissReleaseNotice(page);
      await page.screenshot({
        path: '../docs/screenshots/carto-keyless-openfreemap-plan.png',
        fullPage: true,
      });
    }
  } finally {
    try {
      if (tripId !== undefined) {
        const deleteResponse = await page.request.delete(`/api/trips/${tripId}`);
        expect(deleteResponse.ok()).toBeTruthy();
      }
    } finally {
      const restoreResponse = await page.request.post('/api/settings/bulk', {
        data: {
          settings: {
            map_provider: originalSettings.map_provider,
            map_tile_url: originalSettings.map_tile_url,
          },
        },
      });
      expect(restoreResponse.ok()).toBeTruthy();
    }
  }
});
