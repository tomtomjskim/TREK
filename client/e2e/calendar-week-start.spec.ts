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
  test(`calendar week start persists and drives shared pickers at ${viewport.name}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto('/settings');
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
    const persistedSunday = page.getByRole('button', { name: 'Sunday', exact: true });
    await expect(persistedSunday).toHaveAttribute('aria-pressed', 'true');
    await persistedSunday.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/trek-calendar-week-start-settings-${viewport.name}.png` });

    await page.goto('/dashboard');
    await dismissSystemNotices(page);
    await page.locator('.add-trip-card').click();
    const modal = page.locator('.trek-modal-backdrop');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Start Date', exact: true }).click();
    const weekdays = page.getByTestId('custom-date-picker-weekdays');
    await expect(weekdays).toBeVisible();
    await expect(weekdays).toHaveText('SMTWTFS');
    const datePickerDialog = weekdays.locator('xpath=ancestor::*[@role="dialog"]');
    await datePickerDialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.screenshot({ path: `/tmp/trek-calendar-week-start-picker-${viewport.name}.png` });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
