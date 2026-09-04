import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

const DB_FILE = path.resolve('e2e/.tmp/e2e.db');
const TOKEN = 'e2e-public-place-notes';
const NO_MAP_TOKEN = 'e2e-public-place-notes-no-map';
const EXPIRED_TOKEN = 'e2e-public-place-notes-expired';
const REVOKED_TOKEN = 'e2e-public-place-notes-revoked';
const SHARE_TOKENS = [TOKEN, NO_MAP_TOKEN, EXPIRED_TOKEN, REVOKED_TOKEN] as const;
const TRIP_TITLE_PREFIX = 'E2E Public Place Notes';
const CATEGORY_NAME = 'E2E Park';
const FOREIGN_CLEANUP_EMAIL = 'e2e-public-place-notes-foreign@trek.local';
const PLACE_NAME = 'Seoul Forest E2E';
const SECOND_PLACE_NAME = 'Museum E2E';
const PLACE_NOTE = [
  'SHARED_PLACE_NOTE_SENTINEL',
  'Second public line with [opening hours](https://example.com/e2e-place-note).',
  '<script>window.__trekSharedNoteXss = true</script>',
  `MOBILE_WRAP_SENTINEL_${'가'.repeat(90)}`,
].join('\n');

type Seed = {
  categoryId: number;
  tripId: number;
  boundaryTripId: number;
  dayId: number;
  placeId: number;
  secondPlaceId: number;
  tokenIds: number[];
  tokenValues: readonly string[];
};

function cleanupPublicShare(seed?: Seed): void {
  const db = new Database(DB_FILE);
  db.pragma('foreign_keys = ON');
  try {
    const owner = db.prepare("SELECT id FROM users WHERE email = 'e2e@trek.local'").get() as { id: number } | undefined;
    if (!owner) return;

    const tokenValues = seed?.tokenValues ?? SHARE_TOKENS;
    const tokenPlaceholders = tokenValues.map(() => '?').join(',');
    const tokenTripIds = db
      .prepare(`SELECT trip_id FROM share_tokens WHERE token IN (${tokenPlaceholders})`)
      .all(...tokenValues) as Array<{ trip_id: number }>;
    const tripIds = new Set<number>(tokenTripIds.map(({ trip_id }) => trip_id));
    if (seed) {
      tripIds.add(seed.tripId);
      tripIds.add(seed.boundaryTripId);
    }
    if (!seed) {
      const titleTrips = db
        .prepare('SELECT id FROM trips WHERE user_id = ? AND title LIKE ?')
        .all(owner.id, `${TRIP_TITLE_PREFIX}%`) as Array<{ id: number }>;
      titleTrips.forEach(({ id }) => tripIds.add(id));
    }

    const categoryIds = new Set<number>();
    if (tripIds.size > 0) {
      const tripPlaceholders = [...tripIds].map(() => '?').join(',');
      const tripCategories = db
        .prepare(
          `SELECT DISTINCT category_id FROM places
           WHERE trip_id IN (${tripPlaceholders}) AND category_id IS NOT NULL`
        )
        .all(...tripIds) as Array<{ category_id: number }>;
      tripCategories.forEach(({ category_id }) => categoryIds.add(category_id));
    }
    if (seed) categoryIds.add(seed.categoryId);
    if (!seed) {
      const namedCategories = db
        .prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?')
        .all(owner.id, CATEGORY_NAME) as Array<{ id: number }>;
      namedCategories.forEach(({ id }) => categoryIds.add(id));
    }

    const cleanup = db.transaction(() => {
      if (seed?.tokenIds.length) {
        const tokenIdPlaceholders = seed.tokenIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM share_tokens WHERE id IN (${tokenIdPlaceholders})`).run(...seed.tokenIds);
      }
      db.prepare(`DELETE FROM share_tokens WHERE token IN (${tokenPlaceholders})`).run(...tokenValues);
      if (tripIds.size > 0) {
        const tripPlaceholders = [...tripIds].map(() => '?').join(',');
        db.prepare(`DELETE FROM trips WHERE id IN (${tripPlaceholders})`).run(...tripIds);
      }
      if (categoryIds.size > 0) {
        const categoryPlaceholders = [...categoryIds].map(() => '?').join(',');
        db.prepare(
          `DELETE FROM categories
             WHERE id IN (${categoryPlaceholders}) AND user_id = ? AND name = ?`
        ).run(...categoryIds, owner.id, CATEGORY_NAME);
      }
    });
    cleanup();
  } finally {
    db.close();
  }
}

function cleanupForeignCleanupFixture(): void {
  const db = new Database(DB_FILE);
  db.pragma('foreign_keys = ON');
  try {
    const cleanup = db.transaction(() => {
      db.prepare('DELETE FROM trips WHERE user_id IN (SELECT id FROM users WHERE email = ?)').run(
        FOREIGN_CLEANUP_EMAIL
      );
      db.prepare('DELETE FROM users WHERE email = ?').run(FOREIGN_CLEANUP_EMAIL);
    });
    cleanup();
  } finally {
    db.close();
  }
}

function withForeignCleanupBoundaryFixture(
  assertion: (boundary: { foreignUserId: number; foreignTripId: number }) => void
): void {
  cleanupForeignCleanupFixture();
  let boundary: { foreignUserId: number; foreignTripId: number } | undefined;
  try {
    const setupDb = new Database(DB_FILE);
    setupDb.pragma('foreign_keys = ON');
    try {
      const foreignUserId = Number(
        setupDb
          .prepare(
            "INSERT INTO users (username, email, password_hash, role) VALUES ('e2e_public_notes_foreign', ?, 'synthetic', 'user')"
          )
          .run(FOREIGN_CLEANUP_EMAIL).lastInsertRowid
      );
      const foreignTripId = Number(
        setupDb
          .prepare('INSERT INTO trips (user_id, title, description, currency) VALUES (?, ?, ?, ?)')
          .run(foreignUserId, `${TRIP_TITLE_PREFIX} Foreign Owner`, 'cleanup boundary sentinel', 'USD').lastInsertRowid
      );
      boundary = { foreignUserId, foreignTripId };
    } finally {
      setupDb.close();
    }
    if (!boundary) throw new Error('Failed to create the cleanup boundary fixture');
    assertion(boundary);
  } finally {
    cleanupForeignCleanupFixture();
  }
}

function assertCleanupKeepsAnotherOwnersMatchingTrip(): void {
  withForeignCleanupBoundaryFixture(({ foreignUserId, foreignTripId }) => {
    cleanupPublicShare();

    const verifyDb = new Database(DB_FILE);
    verifyDb.pragma('foreign_keys = ON');
    try {
      const survived = !!verifyDb
        .prepare('SELECT 1 FROM trips WHERE id = ? AND user_id = ?')
        .get(foreignTripId, foreignUserId);
      expect(survived).toBe(true);
    } finally {
      verifyDb.close();
    }
  });
}

function assertForeignCleanupRunsAfterFailure(): void {
  const expectedFailure = new Error('synthetic cleanup boundary failure');
  let caught: unknown;
  try {
    withForeignCleanupBoundaryFixture(() => {
      cleanupPublicShare();
      throw expectedFailure;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(expectedFailure);

  const verifyDb = new Database(DB_FILE, { readonly: true });
  try {
    const leftover = verifyDb.prepare('SELECT id FROM users WHERE email = ?').get(FOREIGN_CLEANUP_EMAIL);
    expect(leftover).toBeUndefined();
  } finally {
    verifyDb.close();
  }
}

function seedPublicShare(): Seed {
  cleanupPublicShare();

  const db = new Database(DB_FILE);
  db.pragma('foreign_keys = ON');
  try {
    const owner = db.prepare("SELECT id FROM users WHERE email = 'e2e@trek.local'").get() as { id: number } | undefined;
    if (!owner) throw new Error('The Playwright E2E admin was not seeded');

    const categoryId = Number(
      db
        .prepare("INSERT INTO categories (name, color, icon, user_id) VALUES (?, '#2563eb', 'park', ?)")
        .run(CATEGORY_NAME, owner.id).lastInsertRowid
    );
    const tripId = Number(
      db
        .prepare(
          `
      INSERT INTO trips (user_id, title, description, start_date, end_date, currency)
      VALUES (?, 'E2E Public Place Notes', 'Cookie-free public map and plan', '2026-09-01', '2026-09-02', 'KRW')
    `
        )
        .run(owner.id).lastInsertRowid
    );
    const dayId = Number(
      db
        .prepare(
          `
      INSERT INTO days (trip_id, day_number, date, title)
      VALUES (?, 1, '2026-09-01', 'Shared places day')
    `
        )
        .run(tripId).lastInsertRowid
    );
    const placeId = Number(
      db
        .prepare(
          `
      INSERT INTO places (
        trip_id, name, description, lat, lng, address, category_id,
        place_time, end_time, notes
      ) VALUES (?, ?, 'Public place description', 37.5444, 127.0374,
        '273 Ttukseom-ro, Seoul', ?, '09:00', '10:30', ?)
    `
        )
        .run(tripId, PLACE_NAME, categoryId, PLACE_NOTE).lastInsertRowid
    );
    const secondPlaceId = Number(
      db
        .prepare(
          `
      INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, notes)
      VALUES (?, ?, 'Second public place', 37.5707, 126.9769,
        'Second public address', ?, 'SECOND_SHARED_NOTE_SENTINEL')
    `
        )
        .run(tripId, SECOND_PLACE_NAME, categoryId).lastInsertRowid
    );
    db.prepare('INSERT INTO day_assignments (day_id, place_id, order_index, notes) VALUES (?, ?, 0, ?)').run(
      dayId,
      placeId,
      'INTERNAL_ASSIGNMENT_NOTE_MUST_NOT_LEAK'
    );
    db.prepare('INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, 1)').run(
      dayId,
      secondPlaceId
    );
    const tokenIds: number[] = [];
    const insertShareToken = db.prepare(
      `
      INSERT INTO share_tokens (
        trip_id, token, created_by, share_map, share_bookings,
        share_packing, share_budget, share_collab, expires_at
      ) VALUES (?, ?, ?, 1, 0, 0, 0, 0, '2099-01-01T00:00:00.000Z')
    `
    );
    tokenIds.push(Number(insertShareToken.run(tripId, TOKEN, owner.id).lastInsertRowid));

    const boundaryTripId = Number(
      db
        .prepare(
          `
      INSERT INTO trips (user_id, title, description, currency)
      VALUES (?, 'E2E Public Place Notes Boundaries', 'Feature flag boundaries', 'EUR')
    `
        )
        .run(owner.id).lastInsertRowid
    );
    db.prepare(
      `
      INSERT INTO places (trip_id, name, lat, lng, notes)
      VALUES (?, 'NO_MAP_PLACE_MUST_NOT_LEAK', 35.0, 128.0, 'NO_MAP_NOTE_MUST_NOT_LEAK')
    `
    ).run(boundaryTripId);
    const addBoundaryToken = db.prepare(`
      INSERT INTO share_tokens (
        trip_id, token, created_by, share_map, share_bookings,
        share_packing, share_budget, share_collab, expires_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
    `);
    tokenIds.push(
      Number(
        addBoundaryToken.run(boundaryTripId, NO_MAP_TOKEN, owner.id, 0, '2099-01-01T00:00:00.000Z').lastInsertRowid
      )
    );
    tokenIds.push(
      Number(
        addBoundaryToken.run(boundaryTripId, EXPIRED_TOKEN, owner.id, 1, '2020-01-01T00:00:00.000Z').lastInsertRowid
      )
    );
    tokenIds.push(
      Number(
        addBoundaryToken.run(boundaryTripId, REVOKED_TOKEN, owner.id, 1, '2099-01-01T00:00:00.000Z').lastInsertRowid
      )
    );

    return {
      categoryId,
      tripId,
      boundaryTripId,
      dayId,
      placeId,
      secondPlaceId,
      tokenIds,
      tokenValues: SHARE_TOKENS,
    };
  } finally {
    db.close();
  }
}

function revokeToken(token: string): void {
  const db = new Database(DB_FILE);
  try {
    db.prepare('DELETE FROM share_tokens WHERE token = ?').run(token);
  } finally {
    db.close();
  }
}

function observeBrowserProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || /(?:Warning:|React has detected)/.test(message.text())) {
      problems.push(`console:${message.type()}:${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror:${error.message}`));
  return problems;
}

async function expectCookieFree(page: Page): Promise<void> {
  expect(await page.context().cookies()).toEqual([]);
}

test.describe.serial('public shared place notes', () => {
  let seed: Seed;

  test.beforeAll(() => {
    assertCleanupKeepsAnotherOwnersMatchingTrip();
    assertForeignCleanupRunsAfterFailure();
    seed = seedPublicShare();
  });

  test.afterAll(() => {
    try {
      cleanupPublicShare(seed);
    } finally {
      cleanupForeignCleanupFixture();
    }
  });

  test('1440 all-days uses the anonymous API projection in a real Leaflet popup', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = observeBrowserProblems(page);
    const responsePromise = page.waitForResponse(
      (response) => response.request().method() === 'GET' && response.url().endsWith(`/api/shared/${TOKEN}`)
    );

    await page.goto(`/shared/${TOKEN}`);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const payload = await response.json();
    const topLevel = payload.places.find((place: { id: number }) => place.id === seed.placeId);
    const nested = payload.assignments[String(seed.dayId)].find(
      (assignment: { place: { id: number } }) => assignment.place.id === seed.placeId
    );
    expect(topLevel.notes).toBe(PLACE_NOTE);
    expect(nested.place.notes).toBe(PLACE_NOTE);
    expect(JSON.stringify(payload)).not.toContain('INTERNAL_ASSIGNMENT_NOTE_MUST_NOT_LEAK');
    expect(payload.cartoApiKey).toBe('');

    const marker = page.locator(`.leaflet-marker-icon[title="${PLACE_NAME}"]`);
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute('tabindex', '0');
    await marker.click();
    const popup = page.getByTestId(`shared-place-popup-${seed.placeId}`);
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('SHARED_PLACE_NOTE_SENTINEL');
    await expect(popup.getByRole('link', { name: 'opening hours' })).toHaveAttribute(
      'href',
      'https://example.com/e2e-place-note'
    );
    expect(
      await page.evaluate(() => (window as typeof window & { __trekSharedNoteXss?: boolean }).__trekSharedNoteXss)
    ).toBeUndefined();
    await expectCookieFree(page);
    // Move off the marker so its hover tooltip cannot cover the click-opened
    // Popup in the visual evidence.
    await page.mouse.move(0, 0);
    await expect(popup).toBeVisible();
    // Full-page capture temporarily resizes the viewport, which makes Leaflet
    // close/reposition the popup before the bitmap is taken. The complete
    // all-days evidence fits in the viewport, so preserve the asserted popup.
    await page.screenshot({ path: '../docs/screenshots/share-place-notes-1440-all-days.png' });
    expect(problems).toEqual([]);
  });

  test('1440 selected-day keeps address and note separate and supports keyboard focus return', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = observeBrowserProblems(page);
    await page.goto(`/shared/${TOKEN}`);

    const dayButton = page.getByRole('button', { name: 'Day 1' }).first();
    await dayButton.click();
    await expect(dayButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('273 Ttukseom-ro, Seoul')).toBeVisible();
    await expect(page.getByTestId(`shared-plan-place-note-${seed.placeId}`)).toContainText(
      'SHARED_PLACE_NOTE_SENTINEL'
    );

    const marker = page.locator(`.leaflet-marker-icon[title="${PLACE_NAME}"]`);
    await marker.focus();
    await page.keyboard.press('Space');
    const popup = page.getByTestId(`shared-place-popup-${seed.placeId}`);
    await expect(popup).toBeVisible();
    const close = page.locator('.leaflet-popup-close-button');
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(popup).toBeHidden();
    await expect(marker).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(popup).toBeVisible();
    await close.focus();
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(marker).toBeFocused();

    const newPagePromise = context.waitForEvent('page');
    await page.keyboard.press('Enter');
    await expect(popup).toBeVisible();
    await popup.getByRole('link', { name: 'opening hours' }).click();
    const linkedPage = await newPagePromise;
    await linkedPage.waitForLoadState('domcontentloaded');
    expect(linkedPage.url()).toBe('https://example.com/e2e-place-note');
    await linkedPage.close();

    const secondMarker = page.locator(`.leaflet-marker-icon[title="${SECOND_PLACE_NAME}"]`);
    await secondMarker.click();
    const secondPopup = page.getByTestId(`shared-place-popup-${seed.secondPlaceId}`);
    await expect(secondPopup).toBeVisible();
    await expect(popup).toBeHidden();
    await page
      .locator('.leaflet-popup')
      .filter({ has: secondPopup })
      .getByRole('button', { name: 'Close popup' })
      .click();
    await expect(secondPopup).toBeHidden();
    await expect(marker).not.toBeFocused();
    await expect(secondMarker).not.toBeFocused();
    await expectCookieFree(page);
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: '../docs/screenshots/share-place-notes-1440-selected-day.png', fullPage: true });
    expect(problems).toEqual([]);
  });

  test('390 tap popup and expanded plan wrap without horizontal overflow', async ({ browser }) => {
    // The public project is desktop Chrome by default. Use an isolated, still
    // cookie-free touch context here so tap() exercises actual touch events.
    const context = await browser.newContext({
      baseURL: 'http://localhost:5173',
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    try {
      const problems = observeBrowserProblems(page);
      await page.goto(`/shared/${TOKEN}`);
      await page.getByRole('button', { name: 'Day 1' }).first().click();

      const marker = page.locator(`.leaflet-marker-icon[title="${PLACE_NAME}"]`);
      await marker.tap();
      const popup = page.getByTestId(`shared-place-popup-${seed.placeId}`);
      await expect(popup).toBeVisible();
      const popupNote = page.getByTestId(`shared-place-note-${seed.placeId}`);
      expect(await popupNote.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.locator('.leaflet-popup-close-button').tap();
      await expect(popup).toBeHidden();
      await expect(marker).not.toBeFocused();

      const planNote = page.getByTestId(`shared-plan-place-note-${seed.placeId}`);
      await expect(planNote).toBeVisible();
      expect(await planNote.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const pageOverflow = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        return {
          viewportWidth,
          scrollWidth: document.documentElement.scrollWidth,
          elements: [...document.querySelectorAll<HTMLElement>('body *')]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName,
                className: element.className?.toString().slice(0, 160),
                testId: element.dataset.testid,
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                width: Math.round(rect.width),
              };
            })
            .filter(({ right }) => right > viewportWidth + 1)
            .slice(0, 20),
        };
      });
      expect(pageOverflow.scrollWidth <= pageOverflow.viewportWidth + 1, JSON.stringify(pageOverflow, null, 2)).toBe(
        true
      );
      await expectCookieFree(page);
      await page.screenshot({ path: '../docs/screenshots/share-place-notes-390-selected-day.png', fullPage: true });
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('no-map, invalid, expired and revoked links fail closed without cookies', async ({ page, request }) => {
    const problems = observeBrowserProblems(page);
    const notFoundResponses: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 404) notFoundResponses.push(response.url());
    });
    const noMap = await request.get(`/api/shared/${NO_MAP_TOKEN}`);
    expect(noMap.status()).toBe(200);
    const noMapPayload = await noMap.json();
    expect(noMapPayload.permissions.share_map).toBe(false);
    expect(noMapPayload.places).toEqual([]);
    expect(JSON.stringify(noMapPayload)).not.toContain('NO_MAP_PLACE_MUST_NOT_LEAK');
    expect(JSON.stringify(noMapPayload)).not.toContain('NO_MAP_NOTE_MUST_NOT_LEAK');

    await page.goto(`/shared/${NO_MAP_TOKEN}`);
    await expect(page.getByRole('button', { name: 'Plan' })).toHaveCount(0);
    await expect(page.locator('.leaflet-container')).toHaveCount(0);
    expect(problems).toEqual([]);
    expect(notFoundResponses).toEqual([]);

    for (const token of ['not-a-valid-share-token', EXPIRED_TOKEN]) {
      const response = await request.get(`/api/shared/${token}`);
      expect(response.status()).toBe(404);
      await page.goto(`/shared/${token}`);
      await expect(page.getByText(/expired|no longer available/i)).toBeVisible();
    }

    expect((await request.get(`/api/shared/${REVOKED_TOKEN}`)).status()).toBe(200);
    revokeToken(REVOKED_TOKEN);
    expect((await request.get(`/api/shared/${REVOKED_TOKEN}`)).status()).toBe(404);
    await page.goto(`/shared/${REVOKED_TOKEN}`);
    await expect(page.getByText(/expired|no longer available/i)).toBeVisible();
    await expectCookieFree(page);

    const expectedNegativeTokens = ['not-a-valid-share-token', EXPIRED_TOKEN, REVOKED_TOKEN];
    expect(notFoundResponses.length).toBeGreaterThan(0);
    expect(
      notFoundResponses.every((url) => expectedNegativeTokens.some((token) => url.includes(`/api/shared/${token}`)))
    ).toBe(true);
    expect(
      problems.filter(
        (problem) =>
          problem !== 'console:error:Failed to load resource: the server responded with a status of 404 (Not Found)'
      )
    ).toEqual([]);
  });
});
