import { expect, test } from '@playwright/test';

test('admin can inspect TREK-local Google usage and control place enrichment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const panel = page.getByRole('region', { name: 'Google Places usage' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/TREK requests only/)).toBeVisible();
  await expect(panel.getByText(/not your Google Cloud billing total/)).toBeVisible();
  await expect(panel.getByRole('progressbar')).toHaveCount(8);

  const toggle = page.getByRole('button', { name: 'Place detail refresh & import enrichment' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  try {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const configResponse = await page.request.get('/api/auth/app-config');
    expect(configResponse.ok()).toBeTruthy();
    expect((await configResponse.json()).places_enrichment_enabled).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeLessThanOrEqual(390);

    if (process.env.TREK_CAPTURE_EVIDENCE) {
      await page.screenshot({ path: '/tmp/trek-google-usage-admin-mobile.png', fullPage: true });
    }
  } finally {
    await page.request.put('/api/admin/places-enrichment', { data: { enabled: true } });
  }
});
