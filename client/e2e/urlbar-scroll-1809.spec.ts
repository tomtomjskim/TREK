import { devices, expect, test } from '@playwright/test';
import { dismissSystemNotices } from './helpers';

// Phone regression guard for #1809: the dashboard must scroll the DOCUMENT.
//
// iOS Safari minimises its address bar only in reaction to the root scroller
// moving. V4 blocked that twice over: html was globally overflow:hidden and the
// mobile shell added a scroll container of its own, so the gesture never
// reached the viewport and the bar kept ~1/6th of the screen forever. The bar
// itself is not observable from page context, but the invariant it hangs off is:
// document.scrollingElement has to move.
//
// Needs WebKit (`npx playwright install webkit`). playwright.config.ts has no
// webkit project, the engine comes from this file-level device (defaultBrowserType
// 'webkit'), same as e2e/ipad-scroll-1432.spec.ts. WebKit is the point here, not
// a nicety: viewport propagation and the toolbar behaviour are Safari's.
//
test.use({ ...devices['iPhone 14'] });

function readScroll() {
  const el = document.scrollingElement as HTMLElement;
  return {
    top: el.scrollTop,
    scrollHeight: el.scrollHeight,
    viewport: window.innerHeight,
    htmlOverflow: getComputedStyle(document.documentElement).overflowY,
  };
}

test('#1809 iPhone: flow screens scroll the document and overlays pin it', async ({ page }) => {
  await page.goto('/dashboard');
  await dismissSystemNotices(page);

  // The context has to be the one from the report: phone width, coarse pointer.
  // If either is wrong, nothing below proves anything.
  const env = await page.evaluate(() => ({
    width: window.innerWidth,
    coarse: window.matchMedia('(pointer: coarse)').matches,
  }));
  expect(env.width, 'iPhone sits below the 768px phone breakpoint').toBeLessThan(768);
  expect(env.coarse, 'iPhone reports a coarse primary pointer').toBe(true);

  // Force deterministic overflow without accumulating server fixtures on every
  // retry. The dashboard shell remains the real scroll container under test.
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.dataset.e2eScrollSpacer = 'true';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = '200vh';
    spacer.style.pointerEvents = 'none';
    document.body.appendChild(spacer);
  });

  // 1. The root scroller is unlocked and the page is longer than the viewport.
  const before = await page.evaluate(readScroll);
  expect(before.htmlOverflow, 'html must not lock the viewport scroller').not.toBe('hidden');
  expect(before.scrollHeight, 'dashboard is longer than one viewport').toBeGreaterThan(before.viewport);
  expect(before.top).toBe(0);

  // 2. Scrolling moves the document, the signal Safari retracts its bar for.
  await page.evaluate(() => window.scrollBy(0, 400));
  const scrolled = await page.evaluate(readScroll);
  expect(scrolled.top, 'the document itself scrolled').toBeGreaterThan(0);

  // 3. The brand tile scrolls the page back up (it used to walk up to the shell
  //    container, which no longer exists).
  await page.getByRole('button', { name: 'TREK' }).click();
  await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);

  // 4. A lock acquired at the page origin must restore that exact origin even
  //    when WebKit accepts a programmatic root scroll behind the fixed body.
  const originVisualTop = await page.evaluate(() => document.body.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'New Trip' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).position)).toBe('fixed');
  await page.evaluate(() => {
    document.scrollingElement!.scrollTop = 300;
  });
  expect(await page.evaluate(() => document.body.getBoundingClientRect().top)).toBeCloseTo(originVisualTop, 0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);

  // 5. The shared body scroll lock: with the document as the scroller, an open
  //    sheet must freeze the page behind it and give the position back.
  await page.evaluate(() => window.scrollBy(0, 300));
  const locked = await page.evaluate(readScroll);
  expect(locked.top).toBeGreaterThan(0);
  const lockedVisualTop = await page.evaluate(() => document.body.getBoundingClientRect().top);

  await page.getByRole('button', { name: 'New Trip' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).position)).toBe('fixed');
  await page.evaluate(() => window.scrollBy(0, 300));
  expect(await page.evaluate(() => document.body.getBoundingClientRect().top)).toBeCloseTo(lockedVisualTop, 0);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(locked.top);
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
  await page.evaluate(() => window.scrollBy(0, 200));
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(locked.top);
});

test('#1809 iPhone: the plan map stays full-height and does not scroll the document', async ({ page }) => {
  let mapTripId: number | null = null;
  try {
    const tripResponse = await page.request.post('/api/trips', {
      data: { title: `URL bar map ${Date.now()}` },
    });
    expect(tripResponse.ok(), 'seed map trip').toBeTruthy();
    const { trip } = await tripResponse.json();
    mapTripId = trip.id;

    await page.goto(`/trips/${mapTripId}`);
    await dismissSystemNotices(page);
    await expect(
      page.locator('[role="dialog"][aria-labelledby^="notice-title-"][aria-describedby^="notice-body-"]')
    ).toHaveCount(0);
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 });
    const planner = await page.evaluate(() => {
      const map = document.querySelector('.leaflet-container') as HTMLElement;
      window.scrollBy(0, 400);
      return {
        top: document.scrollingElement!.scrollTop,
        mapHeight: map.getBoundingClientRect().height,
      };
    });
    expect(planner.top, 'the plan map does not move the document').toBe(0);
    expect(planner.mapHeight, 'the plan map keeps a real height').toBeGreaterThan(200);
  } finally {
    if (mapTripId !== null) {
      await page.request.delete(`/api/trips/${mapTripId}`).catch(() => {});
    }
  }
});
