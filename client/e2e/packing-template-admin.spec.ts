import { expect, test } from '@playwright/test';

test('packing template admin CRUD remains usable at desktop and mobile widths', async ({ page }, testInfo) => {
  const templateName = `E2E Packing Template ${testInfo.workerIndex}-${Date.now()}`;

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Personalization', exact: true }).first().click();

  const heading = page.getByRole('heading', { name: 'Packing Templates' });
  const manager = heading.locator('xpath=ancestor::div[contains(@class, "overflow-hidden")][1]');
  await expect(heading).toBeVisible();

  try {
    await page.getByRole('button', { name: 'New Template', exact: true }).click();
    const templateInput = page.getByPlaceholder('Template name (e.g. Beach Holiday)');
    await templateInput.fill(templateName);
    await templateInput.press('Enter');

    await expect(page.getByText(templateName, { exact: true })).toBeVisible();
    await expect(page.getByText('0 categories · 0 items', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add category', exact: true }).click();
    const categoryInput = page.getByPlaceholder('Category name (e.g. Clothing)');
    await categoryInput.fill('Travel documents');
    await categoryInput.press('Enter');

    const categoryName = page.getByText('Travel documents', { exact: true });
    await expect(categoryName).toBeVisible();
    await expect(page.getByText('1 categories · 0 items', { exact: true })).toBeVisible();

    const categoryHeader = categoryName.locator('..');
    await categoryHeader.locator('button').first().click();
    const itemInput = page.getByPlaceholder('Item name');
    await itemInput.fill('Passport');
    await itemInput.press('Enter');

    await expect(page.getByText('Passport', { exact: true })).toBeVisible();
    await expect(page.getByText('1 categories · 1 items', { exact: true })).toBeVisible();

    if (process.env.TREK_CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: '/tmp/trek-packing-template-admin-desktop.png',
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await manager.scrollIntoViewIfNeeded();
    const managerBox = await manager.boundingBox();
    expect(managerBox).not.toBeNull();
    expect(managerBox!.x).toBeGreaterThanOrEqual(0);
    expect(managerBox!.x + managerBox!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const itemEditor = itemInput.locator('..');
    const itemEditorBox = await itemEditor.boundingBox();
    expect(itemEditorBox).not.toBeNull();
    const itemEditorButtons = itemEditor.locator('button');
    await expect(itemEditorButtons).toHaveCount(2);
    for (const button of await itemEditorButtons.all()) {
      const buttonBox = await button.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(buttonBox!.x).toBeGreaterThanOrEqual(itemEditorBox!.x);
      expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(
        itemEditorBox!.x + itemEditorBox!.width
      );
    }

    if (process.env.TREK_CAPTURE_EVIDENCE) {
      await page.screenshot({
        path: '/tmp/trek-packing-template-admin-mobile.png',
        fullPage: true,
      });
    }

    await itemEditorButtons.nth(1).click();
    await expect(itemInput).toBeHidden();
  } finally {
    const response = await page.request.get('/api/admin/packing-templates');
    if (response.ok()) {
      const body = await response.json() as { templates?: Array<{ id: number; name: string }> };
      const created = body.templates?.filter(template => template.name === templateName) || [];
      await Promise.all(
        created.map(template => page.request.delete(`/api/admin/packing-templates/${template.id}`))
      );
    }
  }
});
