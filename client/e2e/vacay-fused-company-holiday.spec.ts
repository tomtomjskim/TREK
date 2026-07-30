import { expect, test } from '@playwright/test'

const MEMBER = {
  username: 'vacay-fused-member',
  email: 'vacay-fused-member@trek.local',
  password: 'VacayFused12345!',
  role: 'user',
}

test('fused company holidays and whole-year deletion are read-only across REST and responsive UI', async ({ page, playwright }) => {
  await page.request.put('/api/admin/addons/vacay', { data: { enabled: true } })

  const createUser = await page.request.post('/api/admin/users', { data: MEMBER })
  expect(createUser.status()).toBe(201)
  const { user: member } = (await createUser.json()) as { user: { id: number } }

  const planResponse = await page.request.get('/api/addons/vacay/plan')
  expect(planResponse.ok()).toBeTruthy()
  const { plan } = (await planResponse.json()) as { plan: { id: number } }
  const year = new Date().getFullYear()
  const extraYear = year + 1
  const holidayDate = `${year}-05-01`

  const addYear = await page.request.post('/api/addons/vacay/years', {
    data: { year: extraYear },
  })
  expect(addYear.ok()).toBeTruthy()

  const seedHoliday = await page.request.post('/api/addons/vacay/entries/company-holiday', {
    data: { date: holidayDate, note: 'Existing company holiday' },
  })
  expect(seedHoliday.ok()).toBeTruthy()

  const invite = await page.request.post('/api/addons/vacay/invite', {
    data: { user_id: member.id },
  })
  expect(invite.ok()).toBeTruthy()

  const loginContext = await playwright.request.newContext({
    baseURL: 'http://localhost:5173',
    storageState: undefined,
  })
  const login = await loginContext.post('/api/auth/login', {
    data: { email: MEMBER.email, password: MEMBER.password },
  })
  expect(login.ok()).toBeTruthy()
  const { token } = (await login.json()) as { token: string }
  await loginContext.dispose()

  const memberContext = await playwright.request.newContext({
    baseURL: 'http://localhost:5173',
    storageState: undefined,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  try {
    const accept = await memberContext.post('/api/addons/vacay/invite/accept', {
      data: { plan_id: plan.id },
    })
    expect(accept.ok()).toBeTruthy()

    const memberBlockedYearDelete = await memberContext.delete(`/api/addons/vacay/years/${extraYear}`)
    expect(memberBlockedYearDelete.status()).toBe(409)
    expect((await memberBlockedYearDelete.json()).code).toBe('VACAY_FUSED_YEAR_DELETE_READ_ONLY')
  } finally {
    await memberContext.dispose()
  }

  const ownerBlockedYearDelete = await page.request.delete(`/api/addons/vacay/years/${extraYear}`)
  expect(ownerBlockedYearDelete.status()).toBe(409)
  expect((await ownerBlockedYearDelete.json()).code).toBe('VACAY_FUSED_YEAR_DELETE_READ_ONLY')

  const yearsAfterBlockedDeletes = await page.request.get('/api/addons/vacay/years')
  expect(yearsAfterBlockedDeletes.ok()).toBeTruthy()
  expect((await yearsAfterBlockedDeletes.json()).years).toContain(extraYear)

  const blocked = await page.request.post('/api/addons/vacay/entries/company-holiday', {
    data: { date: `${year}-05-02`, note: 'Must be rejected' },
  })
  expect(blocked.status()).toBe(409)
  expect((await blocked.json()).code).toBe('VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY')

  const entries = await page.request.get(`/api/addons/vacay/entries/${year}`)
  expect(entries.ok()).toBeTruthy()
  expect((await entries.json()).companyHolidays).toContainEqual(
    expect.objectContaining({ date: holidayDate, note: 'Existing company holiday' }),
  )

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/vacay')
  const companyMode = page.getByRole('button', { name: 'Company Holiday', exact: true })
  await expect(companyMode).toBeDisabled()
  const desktopYearRemoval = page.getByRole('button', {
    name: new RegExp(`Remove ${extraYear}.*Years cannot be removed while vacation plans are fused`),
  })
  await expect(desktopYearRemoval).toBeDisabled()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const companySetting = page.getByRole('button', {
    name: 'Company Holidays: Read-only shared view',
  })
  await expect(companySetting).toBeDisabled()
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(settingsDialog.getByText('Read-only shared view', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Carry Over' })).toBeEnabled()

  if (process.env.TREK_CAPTURE_EVIDENCE) {
    await page.screenshot({
      path: '/tmp/trek-vacay-fused-company-holidays-desktop.png',
      fullPage: true,
    })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await companySetting.scrollIntoViewIfNeeded()
  const settingBox = await companySetting.boundingBox()
  expect(settingBox).not.toBeNull()
  expect(settingBox!.x).toBeGreaterThanOrEqual(0)
  expect(settingBox!.x + settingBox!.width).toBeLessThanOrEqual(390)

  if (process.env.TREK_CAPTURE_EVIDENCE) {
    await page.screenshot({
      path: '/tmp/trek-vacay-fused-company-holidays-mobile.png',
      fullPage: false,
    })
  }

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  const mobileSidebarButton = page.getByRole('button', { name: 'Year Open', exact: true })
  await mobileSidebarButton.click()
  const mobileDrawer = page.getByRole('dialog', { name: 'Year Settings', exact: true })
  const mobileDrawerCloseButton = mobileDrawer.getByRole('button', { name: 'Close', exact: true })
  const waitForMobileDrawerAnimation = () => mobileDrawer.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)))
  })
  await expect(mobileDrawerCloseButton).toBeFocused()
  const mobileDrawerCloseBox = await mobileDrawerCloseButton.boundingBox()
  expect(mobileDrawerCloseBox).not.toBeNull()
  expect(mobileDrawerCloseBox!.width).toBeGreaterThanOrEqual(44)
  expect(mobileDrawerCloseBox!.height).toBeGreaterThanOrEqual(44)
  expect(await mobileDrawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy()

  await page.keyboard.press('Escape')
  await expect(mobileDrawer).toBeHidden()
  await expect(mobileSidebarButton).toBeFocused()

  await mobileSidebarButton.click()
  await expect(mobileDrawerCloseButton).toBeFocused()
  await mobileDrawerCloseButton.click()
  await expect(mobileDrawer).toBeHidden()
  await expect(mobileSidebarButton).toBeFocused()

  await mobileSidebarButton.click()
  await expect(mobileDrawerCloseButton).toBeFocused()
  const mobileDrawerOverlay = page.locator('div[aria-hidden="true"].absolute.inset-0')
  await mobileDrawerOverlay.click({ position: { x: 350, y: 400 } })
  await expect(mobileDrawer).toBeHidden()
  await expect(mobileSidebarButton).toBeFocused()

  await mobileSidebarButton.click()
  await expect(mobileDrawerCloseButton).toBeFocused()
  await waitForMobileDrawerAnimation()
  const mobileYearRemoval = page.getByRole('button', {
    name: new RegExp(`Remove ${extraYear}.*Years cannot be removed while vacation plans are fused`),
  })
  await expect(mobileYearRemoval).toBeDisabled()
  const mobileRemovalBox = await mobileYearRemoval.boundingBox()
  expect(mobileRemovalBox).not.toBeNull()
  expect(mobileRemovalBox!.x).toBeGreaterThanOrEqual(0)
  expect(mobileRemovalBox!.x + mobileRemovalBox!.width).toBeLessThanOrEqual(390)

  if (process.env.TREK_CAPTURE_EVIDENCE) {
    await page.screenshot({
      path: '/tmp/trek-vacay-fused-year-removal-mobile.png',
      fullPage: false,
    })
  }

  await page.setViewportSize({ width: 884, height: 1104 })
  const tabletRemovalBox = await mobileYearRemoval.boundingBox()
  expect(tabletRemovalBox).not.toBeNull()
  expect(tabletRemovalBox!.x).toBeGreaterThanOrEqual(0)
  expect(tabletRemovalBox!.x + tabletRemovalBox!.width).toBeLessThanOrEqual(884)

  if (process.env.TREK_CAPTURE_EVIDENCE) {
    await page.screenshot({
      path: '/tmp/trek-vacay-fused-year-removal-884.png',
      fullPage: false,
    })
  }
})
