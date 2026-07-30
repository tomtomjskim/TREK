import { expect, test } from '@playwright/test'

const MEMBER = {
  username: 'vacay-fused-member',
  email: 'vacay-fused-member@trek.local',
  password: 'VacayFused12345!',
  role: 'user',
}

test('fused company holidays are read-only across REST and responsive UI', async ({ page, playwright }) => {
  await page.request.put('/api/admin/addons/vacay', { data: { enabled: true } })

  const createUser = await page.request.post('/api/admin/users', { data: MEMBER })
  expect(createUser.status()).toBe(201)
  const { user: member } = (await createUser.json()) as { user: { id: number } }

  const planResponse = await page.request.get('/api/addons/vacay/plan')
  expect(planResponse.ok()).toBeTruthy()
  const { plan } = (await planResponse.json()) as { plan: { id: number } }
  const year = new Date().getFullYear()
  const holidayDate = `${year}-05-01`

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
  } finally {
    await memberContext.dispose()
  }

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

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const companySetting = page.getByRole('button', {
    name: 'Company Holidays: Read-only shared view',
  })
  await expect(companySetting).toBeDisabled()
  await expect(page.getByText('Read-only shared view', { exact: true })).toBeVisible()
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
      fullPage: true,
    })
  }
})
