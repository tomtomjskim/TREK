import { expect, test } from '@playwright/test';
import { dismissSystemNotices } from './helpers';

test.afterEach(async ({ request }) => {
  const response = await request.put('/api/settings', {
    data: { key: 'calendar_week_start', value: 1 },
  });
  expect(response.ok()).toBeTruthy();
});

for (const viewport of [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1440', width: 1440, height: 900 },
]) {
  test.describe(viewport.name, () => {
    // Create the browser context at its target width. Changing it after visiting
    // a route can retain the wrong responsive route branch.
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('calendar week start persists and drives the create-trip picker', async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto('/settings');
      await dismissSystemNotices(page);
      const sunday = page.getByRole('button', { name: 'Sunday', exact: true });
      await expect(page.getByText('Week starts on', { exact: true })).toBeVisible();
      const saveResponse = page.waitForResponse(
        (response) => response.url().endsWith('/api/settings') && response.request().method() === 'PUT'
      );
      await sunday.click();
      expect((await saveResponse).ok()).toBeTruthy();
      await expect(sunday).toHaveAttribute('aria-pressed', 'true');
      await expect(sunday).toBeFocused();

      await page.reload();
      await dismissSystemNotices(page);
      await expect(page.getByRole('button', { name: 'Sunday', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.goto('/dashboard?create=1');
      const createTripDialog = page.getByRole('dialog', { name: 'Create New Trip', exact: true });
      await expect(createTripDialog).toBeVisible();
      await createTripDialog.getByRole('button', { name: 'Start Date', exact: true }).click();
      const weekdays = page.getByTestId('custom-date-picker-weekdays');
      await expect(weekdays).toBeVisible();
      await expect(weekdays).toHaveText('SMTWTFS');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  });
}
