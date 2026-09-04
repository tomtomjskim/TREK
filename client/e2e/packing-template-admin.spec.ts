import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
  test(`packing template admin CRUD remains usable at ${viewport.name} width`, async ({ page }, testInfo) => {
    const templateName = `E2E Packing Template ${viewport.name}-${testInfo.workerIndex}-${Date.now()}`;

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/admin');
    if (viewport.name === 'mobile') {
      await page.getByRole('button', { name: 'Administration', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Personalization', exact: true }).first().click();

    const title = page.getByText('Packing Templates', { exact: true }).first();
    const manager = page.getByTestId('packing-template-manager');
    await expect(title).toBeVisible();
    await expect(manager).toBeVisible();

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

      await manager.scrollIntoViewIfNeeded();
      const managerBox = await manager.boundingBox();
      expect(managerBox).not.toBeNull();
      expect(managerBox!.x).toBeGreaterThanOrEqual(0);
      expect(managerBox!.x + managerBox!.width).toBeLessThanOrEqual(viewport.width);
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
        expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(itemEditorBox!.x + itemEditorBox!.width);
      }

      if (process.env.TREK_CAPTURE_EVIDENCE) {
        await page.screenshot({
          path: `/tmp/trek-packing-template-admin-${viewport.name}.png`,
          fullPage: true,
        });
      }

      await itemEditorButtons.nth(1).click();
      await expect(itemInput).toBeHidden();
    } finally {
      const response = await page.request.get('/api/admin/packing-templates');
      if (response.ok()) {
        const body = (await response.json()) as { templates?: Array<{ id: number; name: string }> };
        const created = body.templates?.filter((template) => template.name === templateName) || [];
        await Promise.all(
          created.map((template) => page.request.delete(`/api/admin/packing-templates/${template.id}`))
        );
      }
    }
  });
}
