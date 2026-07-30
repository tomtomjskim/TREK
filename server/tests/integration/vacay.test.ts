/**
 * Vacay integration tests.
 * Covers VACAY-001 to VACAY-025.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import type { INestApplication } from '@nestjs/common';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
  SESSION_DURATION: '24h',
  SESSION_DURATION_MS: 86400000,
  SESSION_DURATION_SECONDS: 86400,
  DEFAULT_LANGUAGE: 'en',
}));
vi.mock('../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));

// Prevent real HTTP calls (holiday API etc.)
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve([
    { date: '2025-01-01', name: 'New Year\'s Day', countryCode: 'DE' },
  ]),
}));

// Mock vacayService.getCountries to avoid real HTTP call to nager.at
vi.mock('../../src/services/vacayService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/vacayService')>('../../src/services/vacayService');
  return {
    ...actual,
    getCountries: vi.fn().mockResolvedValue({
      data: [{ countryCode: 'DE', name: 'Germany' }, { countryCode: 'FR', name: 'France' }],
    }),
  };
});

import { buildApp } from '../../src/bootstrap';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrationRunner';
import { resetTestDb, resetRateLimits } from '../helpers/test-db';
import { createUser } from '../helpers/factories';
import { authCookie } from '../helpers/auth';

let nestApp: INestApplication;
let app: Application;

beforeAll(async () => {
  createTables(testDb);
  runMigrations(testDb);
  nestApp = await buildApp();
  app = nestApp.getHttpAdapter().getInstance();
});

beforeEach(() => {
  resetTestDb(testDb);
  resetRateLimits(nestApp);
});

afterAll(async () => {
  await nestApp.close();
  testDb.close();
  vi.unstubAllGlobals();
});

describe('Vacay plan', () => {
  it('VACAY-001 — GET /api/addons/vacay/plan auto-creates plan on first access', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
    expect(res.body.plan.owner_id).toBe(user.id);
  });

  it('VACAY-001 — second GET returns same plan (no duplicate creation)', async () => {
    const { user } = createUser(testDb);

    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    const res = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
  });

  it('VACAY-002 — PUT /api/addons/vacay/plan updates plan settings', async () => {
    const { user } = createUser(testDb);

    // Ensure plan exists
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .put('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id))
      .send({ vacation_days: 30, carry_over_days: 5 });
    expect(res.status).toBe(200);
  });
});

describe('Vacay years', () => {
  it('VACAY-007 — POST /api/addons/vacay/years adds a year to the plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/years')
      .set('Cookie', authCookie(user.id))
      .send({ year: 2025 });
    expect(res.status).toBe(200);
    expect(res.body.years).toBeDefined();
  });

  it('VACAY-025 — GET /api/addons/vacay/years lists years in plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .get('/api/addons/vacay/years')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.years)).toBe(true);
    expect(res.body.years.length).toBeGreaterThanOrEqual(1);
  });

  it('VACAY-008 — DELETE /api/addons/vacay/years/:year removes year', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2026 });

    const res = await request(app)
      .delete('/api/addons/vacay/years/2026')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.years).toBeDefined();
  });

  it('VACAY-008a — fused owner and member receive a stable 409 without row loss', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const year = 2031;
    const planResponse = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(owner.id));
    const planId = planResponse.body.plan.id as number;
    await request(app)
      .post('/api/addons/vacay/years')
      .set('Cookie', authCookie(owner.id))
      .send({ year });
    testDb.prepare(`
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'accepted')
    `).run(planId, member.id);
    testDb.prepare(`
      INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 19, 3)
    `).run(member.id, planId, year);
    testDb.prepare(`
      INSERT INTO vacay_entries (plan_id, user_id, date, note)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      planId, owner.id, `${year}-04-01`, 'owner',
      planId, member.id, `${year}-04-02`, 'member',
    );
    testDb.prepare(`
      INSERT INTO vacay_company_holidays (plan_id, date, note)
      VALUES (?, ?, ?)
    `).run(planId, `${year}-05-01`, 'legacy shared holiday');
    const snapshot = () => ({
      years: testDb.prepare('SELECT * FROM vacay_years WHERE plan_id = ? AND year = ? ORDER BY id')
        .all(planId, year),
      entries: testDb.prepare("SELECT * FROM vacay_entries WHERE plan_id = ? AND date LIKE ? ORDER BY id")
        .all(planId, `${year}-%`),
      companyHolidays: testDb.prepare("SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ? ORDER BY id")
        .all(planId, `${year}-%`),
      userYears: testDb.prepare('SELECT * FROM vacay_user_years WHERE plan_id = ? AND year = ? ORDER BY id')
        .all(planId, year),
    });
    const before = snapshot();

    for (const actor of [owner, member]) {
      const res = await request(app)
        .delete(`/api/addons/vacay/years/${year}`)
        .set('Cookie', authCookie(actor.id));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'VACAY_FUSED_YEAR_DELETE_READ_ONLY',
      });
      expect(snapshot()).toEqual(before);
    }
  });

  it('VACAY-008aa — pending fusion returns the review-required code without deleting the year', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    const year = 2034;
    const planResponse = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(owner.id));
    const planId = planResponse.body.plan.id as number;
    await request(app)
      .post('/api/addons/vacay/years')
      .set('Cookie', authCookie(owner.id))
      .send({ year });
    testDb.prepare(`
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'pending')
    `).run(planId, invitee.id);

    const before = testDb.prepare(
      'SELECT * FROM vacay_years WHERE plan_id = ? AND year = ?'
    ).get(planId, year);
    const res = await request(app)
      .delete(`/api/addons/vacay/years/${year}`)
      .set('Cookie', authCookie(owner.id));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED',
    });
    expect(testDb.prepare(
      'SELECT * FROM vacay_years WHERE plan_id = ? AND year = ?'
    ).get(planId, year)).toEqual(before);
  });

  it('VACAY-008b — DELETE rejects a non-canonical year without truncating it', async () => {
    const { user } = createUser(testDb);
    const planResponse = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id));
    const planId = planResponse.body.plan.id as number;
    const year = 2032;
    await request(app)
      .post('/api/addons/vacay/years')
      .set('Cookie', authCookie(user.id))
      .send({ year });

    const res = await request(app)
      .delete(`/api/addons/vacay/years/${year}junk`)
      .set('Cookie', authCookie(user.id));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Year must be a canonical safe integer',
      code: 'VACAY_INVALID_YEAR',
    });
    expect(testDb.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?')
      .get(planId, year)).toBeDefined();
  });

  it('VACAY-008c — POST rejects years that DELETE cannot address canonically', async () => {
    const { user } = createUser(testDb);
    const planResponse = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id));
    const planId = planResponse.body.plan.id as number;
    const before = testDb.prepare(`
      SELECT year
      FROM vacay_years
      WHERE plan_id = ?
      ORDER BY year
    `).all(planId);

    for (const year of [2032.5, '2032', Number.MAX_SAFE_INTEGER + 1]) {
      const res = await request(app)
        .post('/api/addons/vacay/years')
        .set('Cookie', authCookie(user.id))
        .send({ year });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Year must be a safe integer',
        code: 'VACAY_INVALID_YEAR',
      });
    }
    expect(testDb.prepare(`
      SELECT year
      FROM vacay_years
      WHERE plan_id = ?
      ORDER BY year
    `).all(planId)).toEqual(before);
  });

  it('VACAY-011 — PUT /api/addons/vacay/stats/:year updates allowance', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .put('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(user.id))
      .send({ vacation_days: 28 });
    expect(res.status).toBe(200);
  });
});

describe('Vacay entries', () => {
  it('VACAY-003 — POST /api/addons/vacay/entries/toggle marks a day as vacation', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(user.id))
      .send({ date: '2025-06-16', year: 2025, type: 'vacation' });
    expect(res.status).toBe(200);
  });

  it('VACAY-004 — POST /api/addons/vacay/entries/toggle on weekend is allowed (no server-side weekend blocking)', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    // 2025-06-21 is a Saturday — server does not block weekends; client-side only
    const res = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(user.id))
      .send({ date: '2025-06-21', year: 2025, type: 'vacation' });
    expect(res.status).toBe(200);
  });

  it('VACAY-006 — GET /api/addons/vacay/entries/:year returns vacation entries', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .get('/api/addons/vacay/entries/2025')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it('VACAY-009 — GET /api/addons/vacay/stats/:year returns stats for year', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .get('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stats');
  });
});

describe('Vacay color', () => {
  it('VACAY-024 — PUT /api/addons/vacay/color sets user color in plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .put('/api/addons/vacay/color')
      .set('Cookie', authCookie(user.id))
      .send({ color: '#3b82f6' });
    expect(res.status).toBe(200);
  });
});

describe('Vacay invite flow', () => {
  it('VACAY-022 — cannot invite yourself', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(user.id))
      .send({ user_id: user.id });
    expect(res.status).toBe(400);
  });

  it('VACAY-022a — canonicalizes a numeric-string user_id before the self-invite check', async () => {
    const { user } = createUser(testDb);
    const planRes = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    const planId = planRes.body.plan.id as number;

    const res = await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(user.id))
      .send({ user_id: String(user.id) });

    expect(res.status).toBe(400);
    expect(
      testDb
        .prepare(
          `
      SELECT id
      FROM vacay_plan_members
      WHERE plan_id = ? AND user_id = ?
    `,
        )
        .get(planId, user.id),
    ).toBeUndefined();
  });

  it('VACAY-016 — send invite to another user', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));

    const res = await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('VACAY-023 — GET /api/addons/vacay/available-users returns users who can be invited', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .get('/api/addons/vacay/available-users')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
});

describe('Vacay holidays', () => {
  it('VACAY-014 — GET /api/addons/vacay/holidays/countries returns available countries', async () => {
    const { user } = createUser(testDb);

    const res = await request(app)
      .get('/api/addons/vacay/holidays/countries')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('VACAY-012 — POST /api/addons/vacay/plan/holiday-calendars adds a holiday calendar', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/plan/holiday-calendars')
      .set('Cookie', authCookie(user.id))
      .send({ region: 'DE', label: 'Germany Holidays' });
    expect(res.status).toBe(200);
  });
});

describe('Vacay dissolve plan', () => {
  it('VACAY-020 — POST /api/addons/vacay/dissolve removes user from plan', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .post('/api/addons/vacay/dissolve')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
  });
});

describe('Vacay holiday calendar CRUD', () => {
  it('VACAY-026 — PUT /plan/holiday-calendars/:id updates an existing calendar', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    // Create a calendar first
    const createRes = await request(app)
      .post('/api/addons/vacay/plan/holiday-calendars')
      .set('Cookie', authCookie(user.id))
      .send({ region: 'US', label: 'US Holidays' });
    expect(createRes.status).toBe(200);
    const calId = createRes.body.plan?.holiday_calendars?.at(-1)?.id
      ?? (testDb.prepare('SELECT id FROM vacay_holiday_calendars ORDER BY id DESC LIMIT 1').get() as any)?.id;

    const res = await request(app)
      .put(`/api/addons/vacay/plan/holiday-calendars/${calId}`)
      .set('Cookie', authCookie(user.id))
      .send({ label: 'Updated Label', color: '#ff0000' });
    expect(res.status).toBe(200);
  });

  it('VACAY-027 — DELETE /plan/holiday-calendars/:id removes the calendar', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const createRes = await request(app)
      .post('/api/addons/vacay/plan/holiday-calendars')
      .set('Cookie', authCookie(user.id))
      .send({ region: 'FR', label: 'French Holidays' });
    expect(createRes.status).toBe(200);
    const calId = (testDb.prepare('SELECT id FROM vacay_holiday_calendars ORDER BY id DESC LIMIT 1').get() as any)?.id;

    const res = await request(app)
      .delete(`/api/addons/vacay/plan/holiday-calendars/${calId}`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('VACAY-027b — DELETE /plan/holiday-calendars/:id non-existent returns 404', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));

    const res = await request(app)
      .delete('/api/addons/vacay/plan/holiday-calendars/99999')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(404);
  });
});

describe('Vacay invite full flow', () => {
  it('VACAY-028 — POST /invite/accept joins the invitee to the owner plan', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);

    // Owner creates plan
    const planRes = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));
    const planId = planRes.body.plan.id;

    // Owner invites invitee
    await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });

    // Invitee accepts
    const res = await request(app)
      .post('/api/addons/vacay/invite/accept')
      .set('Cookie', authCookie(invitee.id))
      .send({ plan_id: planId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('VACAY-028a — invite year reconciliation returns 409 and preserves the pending source data', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    const year = 2034;

    const ownerPlanRes = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(owner.id));
    const ownerPlanId = ownerPlanRes.body.plan.id as number;
    const inviteePlanRes = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(invitee.id));
    const inviteePlanId = inviteePlanRes.body.plan.id as number;
    await request(app)
      .post('/api/addons/vacay/years')
      .set('Cookie', authCookie(invitee.id))
      .send({ year });
    await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(invitee.id))
      .send({ date: `${year}-05-01` });
    await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });

    const res = await request(app)
      .post('/api/addons/vacay/invite/accept')
      .set('Cookie', authCookie(invitee.id))
      .send({ plan_id: ownerPlanId });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'VACAY_INVITE_YEAR_REVIEW_REQUIRED',
      missing_years: [year],
    });
    expect(testDb.prepare(`
      SELECT status
      FROM vacay_plan_members
      WHERE plan_id = ? AND user_id = ?
    `).get(ownerPlanId, invitee.id)).toEqual({ status: 'pending' });
    expect(testDb.prepare(`
      SELECT plan_id
      FROM vacay_entries
      WHERE user_id = ? AND date = ?
    `).get(invitee.id, `${year}-05-01`)).toEqual({ plan_id: inviteePlanId });
    expect(testDb.prepare(`
      SELECT id
      FROM vacay_years
      WHERE plan_id = ? AND year = ?
    `).get(ownerPlanId, year)).toBeUndefined();
  });

  it('VACAY-028b — membership topology review keeps an owner-orphaning invite pending', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    const { user: pendingMember } = createUser(testDb);
    const ownerPlanRes = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));
    const inviteePlanRes = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(invitee.id));
    const ownerPlanId = ownerPlanRes.body.plan.id as number;
    const inviteePlanId = inviteePlanRes.body.plan.id as number;
    testDb
      .prepare(
        `
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'pending')
    `,
      )
      .run(inviteePlanId, pendingMember.id);
    testDb
      .prepare(
        `
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'pending')
    `,
      )
      .run(ownerPlanId, invitee.id);

    const res = await request(app)
      .post('/api/addons/vacay/invite/accept')
      .set('Cookie', authCookie(invitee.id))
      .send({ plan_id: ownerPlanId });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED',
    });
    expect(
      testDb
        .prepare(
          `
      SELECT plan_id, user_id, status
      FROM vacay_plan_members
      WHERE plan_id IN (?, ?)
      ORDER BY plan_id, user_id
    `,
        )
        .all(ownerPlanId, inviteePlanId),
    ).toEqual([
      { plan_id: ownerPlanId, user_id: invitee.id, status: 'pending' },
      { plan_id: inviteePlanId, user_id: pendingMember.id, status: 'pending' },
    ]);
  });

  it('VACAY-029 — POST /invite/decline removes the pending invite', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);

    const planRes = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));
    const planId = planRes.body.plan.id;

    await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });

    const res = await request(app)
      .post('/api/addons/vacay/invite/decline')
      .set('Cookie', authCookie(invitee.id))
      .send({ plan_id: planId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('VACAY-030 — POST /invite/cancel removes the pending invite from owner side', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);

    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));

    await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });

    const res = await request(app)
      .post('/api/addons/vacay/invite/cancel')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Vacay company holidays', () => {
  it('VACAY-032 — POST /entries/company-holiday toggles a company holiday', async () => {
    const { user } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(user.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const res = await request(app)
      .post('/api/addons/vacay/entries/company-holiday')
      .set('Cookie', authCookie(user.id))
      .send({ date: '2025-12-25', note: 'Christmas' });
    expect(res.status).toBe(200);
  });

  it('VACAY-032a — company holiday overlay preserves the entry and only changes its balance effect', async () => {
    const { user } = createUser(testDb);
    const planRes = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(user.id));
    const planId = planRes.body.plan.id as number;
    const date = '2025-05-01';
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(user.id)).send({ year: 2025 });

    const entryRes = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(user.id))
      .send({ date });
    expect(entryRes.status).toBe(200);
    const before = testDb.prepare(`
      SELECT id, plan_id, user_id, date, note
      FROM vacay_entries
      WHERE plan_id = ? AND user_id = ? AND date = ?
    `).get(planId, user.id, date);

    const addHolidayRes = await request(app)
      .post('/api/addons/vacay/entries/company-holiday')
      .set('Cookie', authCookie(user.id))
      .send({ date, note: 'Labour Day' });
    expect(addHolidayRes.status).toBe(200);
    expect(addHolidayRes.body.action).toBe('added');
    expect(testDb.prepare(`
      SELECT id, plan_id, user_id, date, note
      FROM vacay_entries
      WHERE plan_id = ? AND user_id = ? AND date = ?
    `).get(planId, user.id, date)).toEqual(before);

    const holidayStats = await request(app)
      .get('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(user.id));
    expect(holidayStats.body.stats[0].used).toBe(0);

    const removeHolidayRes = await request(app)
      .post('/api/addons/vacay/entries/company-holiday')
      .set('Cookie', authCookie(user.id))
      .send({ date });
    expect(removeHolidayRes.status).toBe(200);
    expect(removeHolidayRes.body.action).toBe('removed');
    expect(testDb.prepare(`
      SELECT id, plan_id, user_id, date, note
      FROM vacay_entries
      WHERE plan_id = ? AND user_id = ? AND date = ?
    `).get(planId, user.id, date)).toEqual(before);

    const restoredStats = await request(app)
      .get('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(user.id));
    expect(restoredStats.body.stats[0].used).toBe(1);
  });

  it('VACAY-032b — fused plans reject company-holiday entry and setting changes with a stable conflict', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const planRes = await request(app)
      .get('/api/addons/vacay/plan')
      .set('Cookie', authCookie(owner.id));
    const planId = planRes.body.plan.id as number;
    testDb.prepare(`
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'accepted')
    `).run(planId, member.id);
    const before = testDb.prepare(`
      SELECT block_weekends, company_holidays_enabled
      FROM vacay_plans
      WHERE id = ?
    `).get(planId);

    const entryRes = await request(app)
      .post('/api/addons/vacay/entries/company-holiday')
      .set('Cookie', authCookie(owner.id))
      .send({ date: '2025-12-25', note: 'Christmas' });
    expect(entryRes.status).toBe(409);
    expect(entryRes.body).toEqual({
      error: 'Company holidays are read-only while Vacay plans are fused',
      code: 'VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY',
    });
    expect(testDb.prepare(`
      SELECT id
      FROM vacay_company_holidays
      WHERE plan_id = ? AND date = ?
    `).get(planId, '2025-12-25')).toBeUndefined();

    const settingRes = await request(app)
      .put('/api/addons/vacay/plan')
      .set('Cookie', authCookie(member.id))
      .send({
        block_weekends: true,
        company_holidays_enabled: false,
      });
    expect(settingRes.status).toBe(409);
    expect(settingRes.body.code).toBe('VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY');
    expect(testDb.prepare(`
      SELECT block_weekends, company_holidays_enabled
      FROM vacay_plans
      WHERE id = ?
    `).get(planId)).toEqual(before);

    const unrelatedSettingRes = await request(app)
      .put('/api/addons/vacay/plan')
      .set('Cookie', authCookie(member.id))
      .send({ block_weekends: true });
    expect(unrelatedSettingRes.status).toBe(200);
    expect(testDb.prepare(`
      SELECT block_weekends, company_holidays_enabled
      FROM vacay_plans
      WHERE id = ?
    `).get(planId)).toEqual({
      block_weekends: 1,
      company_holidays_enabled: (before as { company_holidays_enabled: number }).company_holidays_enabled,
    });
  });

  it('VACAY-033 — POST /entries/toggle with target_user_id not in plan returns 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: outsider } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(owner.id)).send({ year: 2025 });

    const res = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(owner.id))
      .send({ date: '2025-07-14', target_user_id: outsider.id });
    expect(res.status).toBe(403);
  });
});

describe('Vacay stats restrictions', () => {
  it('VACAY-034 — PUT /stats/:year for user not in plan returns 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: outsider } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(owner.id)).send({ year: 2025 });

    const res = await request(app)
      .put('/api/addons/vacay/stats/2025')
      .set('Cookie', authCookie(owner.id))
      .send({ vacation_days: 25, target_user_id: outsider.id });
    expect(res.status).toBe(403);
  });
});

describe('Vacay holidays error path', () => {
  it('VACAY-035 — GET /holidays/:year/:country returns 502 when external API fetch fails', async () => {
    const { user } = createUser(testDb);
    // Use an unusual country/year to avoid cache hits from other tests
    vi.mocked(global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const res = await request(app)
      .get('/api/addons/vacay/holidays/2099/ZZ')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(502);
  });
});

describe('Vacay color restriction', () => {
  it('VACAY-036 — PUT /color with target_user_id not in plan returns 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: outsider } = createUser(testDb);
    await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));

    const res = await request(app)
      .put('/api/addons/vacay/color')
      .set('Cookie', authCookie(owner.id))
      .send({ color: '#ff0000', target_user_id: outsider.id });
    expect(res.status).toBe(403);
  });
});

describe('Vacay holidays success path', () => {
  it('VACAY-037 — GET /holidays/:year/:country returns data when fetch succeeds', async () => {
    const { user } = createUser(testDb);
    // Use unique year/country to avoid cache from other tests
    vi.mocked(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ date: '2025-05-01', name: 'Labour Day', countryCode: 'AT' }]),
    });

    const res = await request(app)
      .get('/api/addons/vacay/holidays/2025/AT')
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
  });
});

describe('Vacay toggle entry for plan member', () => {
  it('VACAY-038 — POST /entries/toggle with target_user_id in plan toggles their entry', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);

    const planRes = await request(app).get('/api/addons/vacay/plan').set('Cookie', authCookie(owner.id));
    const planId = planRes.body.plan.id;
    await request(app).post('/api/addons/vacay/years').set('Cookie', authCookie(owner.id)).send({ year: 2025 });

    // Invite and accept so invitee is in the plan
    await request(app)
      .post('/api/addons/vacay/invite')
      .set('Cookie', authCookie(owner.id))
      .send({ user_id: invitee.id });
    await request(app)
      .post('/api/addons/vacay/invite/accept')
      .set('Cookie', authCookie(invitee.id))
      .send({ plan_id: planId });

    // Owner toggles an entry for the invitee (who is now in the plan)
    const res = await request(app)
      .post('/api/addons/vacay/entries/toggle')
      .set('Cookie', authCookie(owner.id))
      .send({ date: '2025-06-10', target_user_id: invitee.id });
    expect(res.status).toBe(200);
  });
});
