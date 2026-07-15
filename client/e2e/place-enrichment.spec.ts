import { test, expect, type Page } from '@playwright/test'

async function createTripWithPlace(page: Page): Promise<{ tripId: number; place: Record<string, unknown> }> {
  const tripResponse = await page.request.post('/api/trips', {
    data: { title: `E2E Place Refresh ${Date.now()}` },
  })
  expect(tripResponse.ok()).toBeTruthy()
  const { trip } = await tripResponse.json()

  const placeResponse = await page.request.post(`/api/trips/${trip.id}/places`, {
    data: { name: 'Cafe Fuji', lat: 35.6812, lng: 139.7671 },
  })
  expect(placeResponse.ok()).toBeTruthy()
  const { place } = await placeResponse.json()
  return { tripId: trip.id, place }
}

async function exposeMapsFeature(page: Page): Promise<void> {
  await page.route('**/api/auth/app-config', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, has_maps_key: true } })
  })
}

test('preview and apply cost-guarded place details', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await exposeMapsFeature(page)
  const { tripId, place } = await createTripWithPlace(page)

  await page.route(`**/api/trips/${tripId}/places/enrichment/preview`, async (route) => {
    await route.fulfill({
      json: {
        entries: [{
          place_id: place.id,
          place_name: place.name,
          current_address: null,
          candidates: [{
            google_place_id: 'ChIJE2ECafeFuji',
            google_ftid: null,
            name: 'Cafe Fuji',
            address: 'Tokyo Station, Tokyo',
            lat: place.lat,
            lng: place.lng,
            types: ['cafe'],
            distance_meters: 8,
            confidence: 'safe',
          }],
        }],
        errors: [],
        requested: 1,
        processed: 1,
        skipped: 0,
        stopped: null,
        usage: [{
          period: '2026-07',
          timezone: 'America/Los_Angeles',
          sku: 'text_search_pro',
          used: 1,
          cap: 4000,
          remaining: 3999,
          official_free_cap: 5000,
          exhausted: false,
        }],
      },
    })
  })
  await page.route(`**/api/trips/${tripId}/places/enrichment/apply`, async (route) => {
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
    })
  })

  await page.goto(`/trips/${tripId}`)
  await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })

  // Fresh E2E users may receive the one-time project thank-you notice after the
  // planner mounts. Dismiss it so this test exercises the place workflow below.
  const dismissNotice = page.getByRole('button', { name: 'Dismiss' })
  await dismissNotice.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  if (await dismissNotice.isVisible().catch(() => false)) await dismissNotice.click()

  const action = page.getByRole('button', { name: 'Refresh details' })
  await expect(action).toBeVisible()
  await action.click()
  const dialog = page.getByRole('dialog', { name: 'Refresh place details' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/80%/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Scan 1 place' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Scan 1 place' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(action).toBeFocused()

  await action.click()
  await dialog.getByRole('button', { name: 'Scan 1 place' }).click()
  await expect(dialog.getByText('Tokyo Station, Tokyo')).toBeVisible()
  await expect(dialog.getByText('Text Search Pro: 1 / 4,000')).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Select Cafe Fuji' })).toBeChecked()

  if (process.env.TREK_CAPTURE_EVIDENCE) {
    await page.screenshot({ path: '/tmp/trek-place-enrichment-desktop.png', fullPage: true })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileDialogBox = await dialog.boundingBox()
  expect(mobileDialogBox).not.toBeNull()
  expect(mobileDialogBox!.x).toBeGreaterThanOrEqual(0)
  expect(mobileDialogBox!.width).toBeLessThanOrEqual(390)
  expect(mobileDialogBox!.height).toBeLessThanOrEqual(844)
  await expect(dialog.getByRole('button', { name: 'Apply 1 selected' })).toBeVisible()
  if (process.env.TREK_CAPTURE_EVIDENCE) {
    await page.screenshot({ path: '/tmp/trek-place-enrichment-mobile.png', fullPage: true })
  }

  await dialog.getByRole('button', { name: 'Apply 1 selected' }).click()
  await expect(dialog.getByText('Updated 1 place')).toBeVisible()
})
