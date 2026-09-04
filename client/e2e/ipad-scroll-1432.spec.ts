import { devices, expect, test } from '@playwright/test';

// Tablet regression guard for #1432 — the places list must scroll under a touch swipe.
//
// A tablet is a coarse-pointer device at a *desktop* viewport width, so the width-based
// "is this mobile" check that 3.2.1 shipped left `draggable` armed on iPad: the swipe
// became an HTML5 drag and raised the drop-to-import overlay instead of scrolling. Drag
// is now gated on `(pointer: coarse)` (useIsTouch), and only a real device context proves
// it — a jsdom unit test cannot express "coarse pointer at 834px".
//
// Needs WebKit (`npx playwright install webkit`, plus libmanette-0.2-0 and libwoff1 on
// Debian/Ubuntu). WebKit is the right engine here, not a nicety: every browser on iPadOS
// is WebKit underneath, which is why the reporter saw this in all three they tried.
test.use({ ...devices['iPad Pro 11'] });

test('#1432 iPad: places list is scrollable, not draggable', async ({ page }) => {
  let tripId: number | null = null;
  try {
    const tripResponse = await page.request.post('/api/trips', {
      data: { title: `iPad 1432 ${Date.now()}` },
    });
    expect(tripResponse.ok(), 'seed trip').toBeTruthy();
    const { trip } = await tripResponse.json();
    tripId = trip.id;

    await page.goto(`/trips/${tripId}`);
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 });

    // Seed enough places for the list to overflow and actually need scrolling.
    for (let i = 1; i <= 25; i++) {
      const res = await page.request.post(`/api/trips/${tripId}/places`, {
        data: { name: `Place ${i}`, lat: 48.85 + i * 0.01, lng: 2.35 + i * 0.01 },
      });
      expect(res.ok(), `seed place ${i}`).toBeTruthy();
    }
    await page.reload();
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Place 1').first()).toBeVisible({ timeout: 20_000 });

    // The context must really be the one from the bug report: coarse pointer, desktop
    // width. If either is wrong, everything below proves nothing.
    const env = await page.evaluate(() => ({
      coarse: window.matchMedia('(pointer: coarse)').matches,
      width: window.innerWidth,
    }));
    expect(env.coarse, 'iPad reports a coarse primary pointer').toBe(true);
    expect(env.width, 'iPad sits above the 768px "mobile" breakpoint').toBeGreaterThanOrEqual(768);

    // 1. Native drag must be off, while the separate touch bridge source marker
    // remains present for a deliberate long-press pickup (#1616).
    const row = page.locator('div[draggable]').filter({ hasText: 'Place 1' }).first();
    await expect(row).toHaveAttribute('draggable', 'false');
    await expect(row).toHaveAttribute('data-touch-draggable', '');

    // 2. The list must scroll, and no drop-to-import overlay may appear.
    const scroller = row.locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " trek-stagger ")]'
    );
    const before = await scroller.evaluate((el) => el.scrollTop);
    const box = (await scroller.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 40);
    await scroller.evaluate((el) => el.scrollBy(0, 200));
    const after = await scroller.evaluate((el) => el.scrollTop);
    expect(after, 'places list scrolled').toBeGreaterThan(before);
    await expect(page.getByText('Drop to import')).toHaveCount(0);

    // 3. Drag being off means the arrow buttons are the only reorder affordance left —
    //    they must be visible (they were opacity:0 above 767px).
    const arrowOpacity = await page.evaluate(() => {
      const el = document.querySelector('.reorder-buttons');
      return el ? getComputedStyle(el).opacity : 'absent';
    });
    expect(['1', 'absent']).toContain(arrowOpacity);

    // 4. The iPad must still get the desktop two-pane layout — isMobile stayed width-based.
    await expect(page.locator('.leaflet-container')).toBeVisible();
  } finally {
    if (tripId !== null) {
      await page.request.delete(`/api/trips/${tripId}`).catch(() => {});
    }
  }
});
