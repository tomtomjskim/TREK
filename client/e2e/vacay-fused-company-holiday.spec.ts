import { expect, test, type Page, type Playwright } from '@playwright/test';

interface FusedPlanFixture {
  memberId: number | null;
  extraYear: number;
  holidayDate: string;
}

async function ensureSoloPlan(page: Page) {
  const response = await page.request.get('/api/addons/vacay/plan');
  expect(response.ok()).toBeTruthy();
  const state = (await response.json()) as { isFused?: boolean };
  if (state.isFused) {
    expect((await page.request.post('/api/addons/vacay/dissolve')).ok()).toBeTruthy();
  }
}

async function cleanupFusedPlan(page: Page, fixture: FusedPlanFixture) {
  const planResponse = await page.request.get('/api/addons/vacay/plan').catch(() => null);
  if (planResponse?.ok()) {
    const state = (await planResponse.json()) as { isFused?: boolean };
    if (state.isFused) await page.request.post('/api/addons/vacay/dissolve').catch(() => null);
  }

  const entriesResponse = await page.request
    .get(`/api/addons/vacay/entries/${fixture.holidayDate.slice(0, 4)}`)
    .catch(() => null);
  if (entriesResponse?.ok()) {
    const entries = (await entriesResponse.json()) as { companyHolidays?: Array<{ date: string }> };
    if (entries.companyHolidays?.some((holiday) => holiday.date === fixture.holidayDate)) {
      await page.request
        .post('/api/addons/vacay/entries/company-holiday', {
          data: { date: fixture.holidayDate },
        })
        .catch(() => null);
    }
  }

  const yearsResponse = await page.request.get('/api/addons/vacay/years').catch(() => null);
  if (yearsResponse?.ok()) {
    const { years } = (await yearsResponse.json()) as { years?: number[] };
    if ((years?.length ?? 0) > 1 && years?.includes(fixture.extraYear)) {
      await page.request.delete(`/api/addons/vacay/years/${fixture.extraYear}`).catch(() => null);
    }
  }
  if (fixture.memberId !== null) {
    await page.request.delete(`/api/admin/users/${fixture.memberId}`).catch(() => null);
  }
}

async function seedFusedPlan(page: Page, playwright: Playwright) {
  const stamp = Date.now();
  const year = new Date().getFullYear();
  const fixture: FusedPlanFixture = {
    memberId: null,
    extraYear: year + 1,
    holidayDate: `${year}-05-01`,
  };
  const memberInput = {
    username: `vacay-fused-member-${stamp}`,
    email: `vacay-fused-member-${stamp}@trek.local`,
    password: 'VacayFused12345!',
    role: 'user',
  };
  try {
    await page.request.put('/api/admin/addons/vacay', { data: { enabled: true } });
    await ensureSoloPlan(page);
    const createUser = await page.request.post('/api/admin/users', { data: memberInput });
    expect(createUser.status()).toBe(201);
    const { user: member } = (await createUser.json()) as { user: { id: number } };
    fixture.memberId = member.id;

    const planResponse = await page.request.get('/api/addons/vacay/plan');
    expect(planResponse.ok()).toBeTruthy();
    const { plan } = (await planResponse.json()) as { plan: { id: number } };

    expect(
      (await page.request.post('/api/addons/vacay/years', { data: { year: fixture.extraYear } })).ok()
    ).toBeTruthy();

    const existingEntries = await page.request.get(`/api/addons/vacay/entries/${year}`);
    expect(existingEntries.ok()).toBeTruthy();
    const existingCompanyHolidays = (await existingEntries.json()) as { companyHolidays?: Array<{ date: string }> };
    if (existingCompanyHolidays.companyHolidays?.some((holiday) => holiday.date === fixture.holidayDate)) {
      expect(
        (
          await page.request.post('/api/addons/vacay/entries/company-holiday', {
            data: { date: fixture.holidayDate },
          })
        ).ok()
      ).toBeTruthy();
    }

    const addHoliday = await page.request.post('/api/addons/vacay/entries/company-holiday', {
      data: { date: fixture.holidayDate, note: 'Existing company holiday' },
    });
    expect(addHoliday.ok()).toBeTruthy();
    expect((await addHoliday.json()).action).toBe('added');
    expect((await page.request.post('/api/addons/vacay/invite', { data: { user_id: member.id } })).ok()).toBeTruthy();

    const loginContext = await playwright.request.newContext({
      baseURL: 'http://localhost:5173',
      storageState: undefined,
    });
    let token: string;
    try {
      const login = await loginContext.post('/api/auth/login', {
        data: { email: memberInput.email, password: memberInput.password },
      });
      expect(login.ok()).toBeTruthy();
      ({ token } = (await login.json()) as { token: string });
    } finally {
      await loginContext.dispose();
    }

    const memberContext = await playwright.request.newContext({
      baseURL: 'http://localhost:5173',
      storageState: undefined,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    try {
      expect(
        (
          await memberContext.post('/api/addons/vacay/invite/accept', {
            data: { plan_id: plan.id },
          })
        ).ok()
      ).toBeTruthy();
      const memberBlockedYearDelete = await memberContext.delete(`/api/addons/vacay/years/${fixture.extraYear}`);
      expect(memberBlockedYearDelete.status()).toBe(409);
      expect((await memberBlockedYearDelete.json()).code).toBe('VACAY_FUSED_YEAR_DELETE_READ_ONLY');
    } finally {
      await memberContext.dispose();
    }

    const ownerBlockedYearDelete = await page.request.delete(`/api/addons/vacay/years/${fixture.extraYear}`);
    expect(ownerBlockedYearDelete.status()).toBe(409);
    expect((await ownerBlockedYearDelete.json()).code).toBe('VACAY_FUSED_YEAR_DELETE_READ_ONLY');

    const yearsAfterBlockedDeletes = await page.request.get('/api/addons/vacay/years');
    expect(yearsAfterBlockedDeletes.ok()).toBeTruthy();
    expect((await yearsAfterBlockedDeletes.json()).years).toContain(fixture.extraYear);

    const blockedCompanyHoliday = await page.request.post('/api/addons/vacay/entries/company-holiday', {
      data: { date: `${year}-05-02`, note: 'Must be rejected' },
    });
    expect(blockedCompanyHoliday.status()).toBe(409);
    expect((await blockedCompanyHoliday.json()).code).toBe('VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY');

    const entries = await page.request.get(`/api/addons/vacay/entries/${year}`);
    expect(entries.ok()).toBeTruthy();
    expect((await entries.json()).companyHolidays).toContainEqual(
      expect.objectContaining({ date: fixture.holidayDate, note: 'Existing company holiday' })
    );

    return fixture;
  } catch (error) {
    await cleanupFusedPlan(page, fixture);
    throw error;
  }
}

test('fused company holidays and year deletion stay read-only on desktop and mobile', async ({ page, playwright }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await seedFusedPlan(page, playwright);
  const { extraYear } = fixture;

  try {
    await page.goto('/vacay');
    await expect(page.getByRole('button', { name: 'Company Holiday', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: String(extraYear), exact: true }).click();
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Remove ${extraYear}.*Years cannot be removed while vacation plans are fused`),
      })
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(settingsDialog.getByRole('button', { name: 'Read-only shared view' })).toBeDisabled();
    await expect(settingsDialog.getByText('Read-only shared view', { exact: true })).toBeVisible();

    if (process.env.TREK_CAPTURE_EVIDENCE) {
      await page.screenshot({ path: '/tmp/trek-vacay-fused-desktop.png', fullPage: true });
    }

    const mobilePage = await page.context().newPage();
    try {
      await mobilePage.setViewportSize({ width: 390, height: 844 });
      await mobilePage.goto('/vacay');
      await mobilePage.getByRole('button', { name: 'Edit calendar' }).click();
      await expect(mobilePage.getByRole('button', { name: 'Company: Read-only shared view' })).toBeDisabled();
      await mobilePage.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(
        mobilePage.getByRole('switch', {
          name: 'Company Holidays: Read-only shared view',
        })
      ).toBeDisabled();

      const mobileYearRemoval = mobilePage.getByRole('button', {
        name: new RegExp(`Remove ${extraYear}.*Years cannot be removed while vacation plans are fused`),
      });
      await expect(mobileYearRemoval).toBeDisabled();
      await mobileYearRemoval.scrollIntoViewIfNeeded();
      const removalBox = await mobileYearRemoval.boundingBox();
      expect(removalBox).not.toBeNull();
      expect(removalBox!.x).toBeGreaterThanOrEqual(0);
      expect(removalBox!.x + removalBox!.width).toBeLessThanOrEqual(390);
      expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      if (process.env.TREK_CAPTURE_EVIDENCE) {
        await mobilePage.screenshot({ path: '/tmp/trek-vacay-fused-mobile.png', fullPage: false });
      }
    } finally {
      await mobilePage.close();
    }
  } finally {
    await cleanupFusedPlan(page, fixture);
  }
});
