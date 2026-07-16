import { expect, test, type Locator } from '@playwright/test';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

function overlaps(first: Box, second: Box): boolean {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

test('trip map controls avoid both panel toggles across unfolded tablet widths', async ({ page }) => {
  const tripResponse = await page.request.post('/api/trips', {
    data: { title: `E2E Responsive Map Controls ${Date.now()}` },
  });
  expect(tripResponse.ok()).toBeTruthy();
  const { trip } = await tripResponse.json();

  const viewports = [
    { width: 768, mode: 'stacked' },
    { width: 800, mode: 'compact' },
    { width: 884, mode: 'compact' },
    { width: 1024, mode: 'compact' },
    { width: 1280, mode: 'wide' },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await page.goto(`/trips/${trip.id}`);

    const controls = page.getByTestId('adaptive-map-controls');
    const leftToggle = page.getByRole('button', { name: 'Close Plan' });
    const rightToggle = page.getByRole('button', { name: 'Close Places' });

    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 });
    await expect(controls).toHaveAttribute('data-layout-mode', viewport.mode);
    await expect(leftToggle).toBeVisible();
    await expect(rightToggle).toBeVisible();

    const [controlsBox, leftBox, rightBox] = await Promise.all([
      controls.boundingBox(),
      leftToggle.boundingBox(),
      rightToggle.boundingBox(),
    ]);
    expect(controlsBox).not.toBeNull();
    expect(leftBox).not.toBeNull();
    expect(rightBox).not.toBeNull();
    expect(leftBox!.width).toBeGreaterThanOrEqual(44);
    expect(leftBox!.height).toBeGreaterThanOrEqual(44);
    expect(rightBox!.width).toBeGreaterThanOrEqual(44);
    expect(rightBox!.height).toBeGreaterThanOrEqual(44);
    expect(overlaps(controlsBox!, leftBox!)).toBe(false);
    expect(overlaps(controlsBox!, rightBox!)).toBe(false);

    if (viewport.width === 884) {
      const explore = page.getByRole('button', { name: 'Explore places on the map' });
      await expect(explore).toHaveAttribute('aria-expanded', 'false');
      await explore.click();

      const dialog = page.getByRole('dialog', { name: 'Explore places on the map' });
      await expect(dialog).toBeVisible();
      const restaurants = dialog.getByRole('button', { name: 'Restaurants' });
      await expect.poll(async () => (await restaurants.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

      if (process.env.TREK_CAPTURE_EVIDENCE) {
        await page.screenshot({ path: '/tmp/trek-trip-controls-fold-884.png', fullPage: true });
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(explore).toBeFocused();
    }

    if (viewport.width === 1280 && process.env.TREK_CAPTURE_EVIDENCE) {
      await page.screenshot({ path: '/tmp/trek-trip-controls-wide-1280.png', fullPage: true });
    }
  }
});
