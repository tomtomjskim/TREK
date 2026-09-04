import { expect, test, type Page } from '@playwright/test';
import { dismissSystemNotices } from './helpers';

// This test owns its enrichment responses. An already-active dev PWA service
// worker can otherwise handle NetworkOnly API traffic before page.route sees it
// (notably in WebKit), turning the mock into a browser-ordering accident.
test.use({ serviceWorkers: 'block' });

async function createTripWithPlace(page: Page): Promise<{ tripId: number; place: Record<string, unknown> }> {
  const tripResponse = await page.request.post('/api/trips', {
    data: { title: `E2E Place Refresh ${Date.now()}` },
  });
  expect(tripResponse.ok()).toBeTruthy();
  const { trip } = await tripResponse.json();

  const placeResponse = await page.request.post(`/api/trips/${trip.id}/places`, {
    data: { name: 'Cafe Fuji', lat: 35.6812, lng: 139.7671 },
  });
  expect(placeResponse.ok()).toBeTruthy();
  const { place } = await placeResponse.json();
  return { tripId: trip.id, place };
}

async function exposeMapsFeature(page: Page): Promise<void> {
  await page.route('**/api/auth/app-config', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        has_maps_key: true,
        places_enrich_enabled: true,
        places_enrichment_enabled: true,
      },
    });
  });
}

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
  test(`preview and apply cost-guarded place details on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await exposeMapsFeature(page);
    const { tripId, place } = await createTripWithPlace(page);
    let previewCalls = 0;
    let applyCalls = 0;
    try {
      await page.route(`**/api/trips/${tripId}/places/enrichment/preview`, async (route) => {
        previewCalls += 1;
        await route.fulfill({
          json: {
            entries: [
              {
                place_id: place.id,
                place_name: place.name,
                current_address: null,
                candidates: [
                  {
                    google_place_id: 'ChIJE2ECafeFuji',
                    google_ftid: null,
                    name: 'Cafe Fuji',
                    address: 'Tokyo Station, Tokyo',
                    lat: place.lat,
                    lng: place.lng,
                    types: ['cafe'],
                    distance_meters: 8,
                    confidence: 'safe',
                  },
                ],
              },
            ],
            errors: [],
            requested: 1,
            processed: 1,
            skipped: 0,
            stopped: null,
            usage: [
              {
                period: '2026-07',
                timezone: 'America/Los_Angeles',
                sku: 'text_search_pro',
                used: 1,
                cap: 4000,
                remaining: 3999,
                official_free_cap: 5000,
                exhausted: false,
              },
            ],
          },
        });
      });
      await page.route(`**/api/trips/${tripId}/places/enrichment/apply`, async (route) => {
        applyCalls += 1;
        await route.fulfill({
          json: {
            updated: [{ ...place, google_place_id: 'ChIJE2ECafeFuji', address: 'Tokyo Station, Tokyo' }],
            errors: [],
            requested: 1,
            processed: 1,
            skipped: 0,
            stopped: null,
            usage: [],
          },
        });
      });

      await page.goto(`/trips/${tripId}`);
      await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 });
      await dismissSystemNotices(page, 5_000);

      if (viewport.name === 'mobile') {
        await page.getByRole('button', { name: 'Places', exact: true }).click();
      }

      const action = page.getByRole('button', { name: 'Refresh details' });
      await expect(action).toBeVisible();
      await action.click();
      const dialog = page.getByRole('dialog', { name: 'Refresh place details' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/80%/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Scan 1 place' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Scan 1 place' })).toBeFocused();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(action).toBeFocused();

      await action.click();
      await dialog.getByRole('button', { name: 'Scan 1 place' }).click();
      await expect(dialog.getByText('Tokyo Station, Tokyo')).toBeVisible();
      expect(previewCalls).toBe(1);
      await expect(dialog.getByText('Text Search Pro: 1 / 4,000')).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: 'Select Cafe Fuji' })).toBeChecked();

      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.width).toBeLessThanOrEqual(viewport.width);
      expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width);
      expect(dialogBox!.height).toBeLessThanOrEqual(viewport.height);
      expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(dialog.getByRole('button', { name: 'Apply 1 selected' })).toBeVisible();

      if (process.env.TREK_CAPTURE_EVIDENCE) {
        await page.screenshot({ path: `/tmp/trek-place-enrichment-${viewport.name}.png`, fullPage: true });
      }

      await dialog.getByRole('button', { name: 'Apply 1 selected' }).click();
      await expect(dialog.getByText('Updated 1 place')).toBeVisible();
      expect(applyCalls).toBe(1);
    } finally {
      await page.request.delete(`/api/trips/${tripId}`).catch(() => {});
    }
  });
}
