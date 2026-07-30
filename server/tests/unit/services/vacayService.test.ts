import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// ── DB setup (real in-memory SQLite) ─────────────────────────────────────────

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
    canAccessTrip: () => null,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
// Mock websocket so notifyPlanUsers doesn't throw and rejected writes can assert
// that no update escaped the domain guard.
const { broadcastToUserMock } = vi.hoisted(() => ({ broadcastToUserMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcastToUser: broadcastToUserMock }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrationRunner';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';

import {
  getOwnPlan,
  getActivePlan,
  getPlanUsers,
  migrateHolidayCalendars,
  updatePlan,
  addHolidayCalendar,
  updateHolidayCalendar,
  deleteHolidayCalendar,
  setUserColor,
  acceptInvite,
  declineInvite,
  cancelInvite,
  getAvailableUsers,
  listYears,
  addYear,
  deleteActiveYear,
  getEntries,
  toggleEntry,
  toggleCompanyHoliday,
  getStats,
  applyHolidayCalendars,
} from '../../../src/services/vacayService';

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastToUserMock.mockClear();
  // Stub fetch with empty holiday list by default so updatePlan / applyHolidayCalendars
  // never makes real network calls.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  testDb.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Insert a vacay_plan_members row directly (no service factory for it). */
function insertMember(planId: number, userId: number, status: 'pending' | 'accepted'): void {
  testDb.prepare(
    "INSERT INTO vacay_plan_members (plan_id, user_id, status) VALUES (?, ?, ?)"
  ).run(planId, userId, status);
}

/** Fast helper: create a user and immediately materialise their own plan. */
function setupUserWithPlan() {
  const { user } = createUser(testDb);
  const plan = getOwnPlan(user.id);
  return { user, plan };
}

function snapshotYear(planId: number, year: number) {
  return {
    years: testDb.prepare(`
      SELECT id, plan_id, year
      FROM vacay_years
      WHERE plan_id = ? AND year = ?
      ORDER BY id
    `).all(planId, year),
    entries: testDb.prepare(`
      SELECT id, plan_id, user_id, date, note
      FROM vacay_entries
      WHERE plan_id = ? AND date LIKE ?
      ORDER BY id
    `).all(planId, `${year}-%`),
    companyHolidays: testDb.prepare(`
      SELECT id, plan_id, date, note
      FROM vacay_company_holidays
      WHERE plan_id = ? AND date LIKE ?
      ORDER BY id
    `).all(planId, `${year}-%`),
    userYears: testDb.prepare(`
      SELECT id, user_id, plan_id, year, vacation_days, carried_over
      FROM vacay_user_years
      WHERE plan_id = ? AND year = ?
      ORDER BY id
    `).all(planId, year),
  };
}

// ── getOwnPlan ────────────────────────────────────────────────────────────────

describe('getOwnPlan', () => {
  it('VACAY-SVC-001: creates a new plan on first call for a fresh user', () => {
    const { user } = createUser(testDb);
    const plan = getOwnPlan(user.id);

    expect(plan).toBeDefined();
    expect(plan.owner_id).toBe(user.id);
    expect(plan.id).toBeGreaterThan(0);
  });

  it('VACAY-SVC-002: returns the same plan on a second call (idempotent)', () => {
    const { user } = createUser(testDb);
    const first = getOwnPlan(user.id);
    const second = getOwnPlan(user.id);

    expect(second.id).toBe(first.id);
  });

  it('VACAY-SVC-003: seeds the current year row in vacay_years after plan creation', () => {
    const { user } = createUser(testDb);
    const plan = getOwnPlan(user.id);
    const yr = new Date().getFullYear();

    const row = testDb
      .prepare('SELECT * FROM vacay_years WHERE plan_id = ? AND year = ?')
      .get(plan.id, yr);

    expect(row).toBeDefined();
  });

  it('VACAY-SVC-004: seeds the current year user_year row with default 30 vacation_days', () => {
    const { user } = createUser(testDb);
    const plan = getOwnPlan(user.id);
    const yr = new Date().getFullYear();

    const row = testDb
      .prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?')
      .get(user.id, plan.id, yr) as { vacation_days: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.vacation_days).toBe(30);
  });
});

// ── getActivePlan ─────────────────────────────────────────────────────────────

describe('getActivePlan', () => {
  it('VACAY-SVC-005: returns own plan when user has no accepted membership in another plan', () => {
    const { user, plan } = setupUserWithPlan();
    const active = getActivePlan(user.id);

    expect(active.id).toBe(plan.id);
    expect(active.owner_id).toBe(user.id);
  });

  it('VACAY-SVC-006: returns the shared plan when user has an accepted membership in another plan', () => {
    const { user: owner, plan: ownerPlan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    // Make sure member also has their own plan materialised first
    getOwnPlan(member.id);

    insertMember(ownerPlan.id, member.id, 'accepted');

    const active = getActivePlan(member.id);
    expect(active.id).toBe(ownerPlan.id);
  });

  it('VACAY-SVC-007: pending membership does NOT override own plan as active', () => {
    const { user: owner, plan: ownerPlan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    getOwnPlan(member.id);

    insertMember(ownerPlan.id, member.id, 'pending');

    const active = getActivePlan(member.id);
    // Should still point to member's own plan
    expect(active.owner_id).toBe(member.id);
  });
});

// ── getPlanUsers ──────────────────────────────────────────────────────────────

describe('getPlanUsers', () => {
  it('VACAY-SVC-008: returns [owner] for a solo plan', () => {
    const { user, plan } = setupUserWithPlan();
    const users = getPlanUsers(plan.id);

    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(user.id);
  });

  it('VACAY-SVC-009: returns [owner, member] after an accepted membership is inserted', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    insertMember(plan.id, member.id, 'accepted');

    const users = getPlanUsers(plan.id);

    expect(users).toHaveLength(2);
    expect(users.map(u => u.id)).toContain(owner.id);
    expect(users.map(u => u.id)).toContain(member.id);
  });

  it('VACAY-SVC-010: pending membership members are NOT included in plan users', () => {
    const { plan } = setupUserWithPlan();
    const { user: pendingUser } = createUser(testDb);
    insertMember(plan.id, pendingUser.id, 'pending');

    const users = getPlanUsers(plan.id);
    expect(users.map(u => u.id)).not.toContain(pendingUser.id);
  });

  it('VACAY-SVC-011: returns empty array for a non-existent plan id', () => {
    const users = getPlanUsers(99999);
    expect(users).toEqual([]);
  });
});

// ── migrateHolidayCalendars ───────────────────────────────────────────────────

describe('migrateHolidayCalendars', () => {
  it('VACAY-SVC-012: does nothing when holidays_enabled is falsy', async () => {
    const { plan } = setupUserWithPlan();
    const planRow = { ...plan, holidays_enabled: 0, holidays_region: 'DE' };

    await migrateHolidayCalendars(plan.id, planRow);

    const rows = testDb
      .prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ?')
      .all(plan.id);
    expect(rows).toHaveLength(0);
  });

  it('VACAY-SVC-013: inserts a calendar row when holidays_enabled=1 and holidays_region is set', async () => {
    const { plan } = setupUserWithPlan();
    const planRow = { ...plan, holidays_enabled: 1, holidays_region: 'DE' };

    await migrateHolidayCalendars(plan.id, planRow);

    const rows = testDb
      .prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ?')
      .all(plan.id) as { region: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].region).toBe('DE');
  });

  it('VACAY-SVC-014: does nothing if a calendar row already exists (no duplicate)', async () => {
    const { plan } = setupUserWithPlan();
    const planRow = { ...plan, holidays_enabled: 1, holidays_region: 'FR' };

    await migrateHolidayCalendars(plan.id, planRow);
    // Call a second time — should NOT insert another row
    await migrateHolidayCalendars(plan.id, planRow);

    const rows = testDb
      .prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ?')
      .all(plan.id);
    expect(rows).toHaveLength(1);
  });
});

// ── updatePlan ────────────────────────────────────────────────────────────────

describe('updatePlan', () => {
  it('VACAY-SVC-015: updates block_weekends flag', async () => {
    const { plan } = setupUserWithPlan();

    await updatePlan(plan.id, { block_weekends: true }, undefined);

    const updated = testDb
      .prepare('SELECT block_weekends FROM vacay_plans WHERE id = ?')
      .get(plan.id) as { block_weekends: number };
    expect(updated.block_weekends).toBe(1);
  });

  it('VACAY-SVC-016: updates holidays_enabled flag', async () => {
    const { plan } = setupUserWithPlan();

    await updatePlan(plan.id, { holidays_enabled: true }, undefined);

    const updated = testDb
      .prepare('SELECT holidays_enabled FROM vacay_plans WHERE id = ?')
      .get(plan.id) as { holidays_enabled: number };
    expect(updated.holidays_enabled).toBe(1);
  });

  it('VACAY-SVC-017: returns the updated plan object with boolean-coerced flags', async () => {
    const { plan } = setupUserWithPlan();

    const result = await updatePlan(plan.id, { block_weekends: false }, undefined);

    expect(result.plan.block_weekends).toBe(false);
    expect(typeof result.plan.holidays_enabled).toBe('boolean');
  });

  it('VACAY-SVC-018: resets carried_over to 0 for all user_years when carry_over_enabled is set to false', async () => {
    const { user, plan } = setupUserWithPlan();
    const yr = new Date().getFullYear();

    // Manually set a non-zero carried_over value
    testDb
      .prepare('UPDATE vacay_user_years SET carried_over = 5 WHERE user_id = ? AND plan_id = ? AND year = ?')
      .run(user.id, plan.id, yr);

    await updatePlan(plan.id, { carry_over_enabled: false }, undefined);

    const row = testDb
      .prepare('SELECT carried_over FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?')
      .get(user.id, plan.id, yr) as { carried_over: number };
    expect(row.carried_over).toBe(0);
  });

  it('VACAY-SVC-018a: enabling company holidays preserves entries and excludes overlaps from carry', async () => {
    const { user, plan } = setupUserWithPlan();
    const year = new Date().getFullYear();
    const nextYear = year + 1;
    const date = `${year}-05-01`;

    testDb.prepare('UPDATE vacay_plans SET company_holidays_enabled = 0 WHERE id = ?').run(plan.id);
    testDb.prepare('UPDATE vacay_user_years SET vacation_days = 10 WHERE user_id = ? AND plan_id = ? AND year = ?')
      .run(user.id, plan.id, year);
    testDb.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, nextYear);
    testDb.prepare(`
      INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 30, 0)
    `).run(user.id, plan.id, nextYear);
    testDb.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)')
      .run(plan.id, user.id, date, 'personal note');
    testDb.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)')
      .run(plan.id, date, 'Labour Day');

    const before = testDb.prepare('SELECT * FROM vacay_entries WHERE plan_id = ? AND date = ?')
      .get(plan.id, date);

    await updatePlan(
      plan.id,
      { company_holidays_enabled: true, carry_over_enabled: true },
      undefined,
    );

    const after = testDb.prepare('SELECT * FROM vacay_entries WHERE plan_id = ? AND date = ?')
      .get(plan.id, date);
    const next = testDb.prepare(`
      SELECT carried_over FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(user.id, plan.id, nextYear) as { carried_over: number };
    expect(after).toEqual(before);
    expect(next.carried_over).toBe(10);
  });

  it('VACAY-SVC-018b: rejects the entire company-holiday settings update for a fused plan before side effects', async () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    const year = new Date().getFullYear();
    insertMember(plan.id, member.id, 'accepted');
    testDb.prepare(`
      UPDATE vacay_user_years
      SET carried_over = 7
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).run(owner.id, plan.id, year);

    const beforePlan = testDb.prepare(`
      SELECT block_weekends, company_holidays_enabled, carry_over_enabled
      FROM vacay_plans
      WHERE id = ?
    `).get(plan.id);

    await expect(updatePlan(
      plan.id,
      {
        block_weekends: true,
        company_holidays_enabled: false,
        carry_over_enabled: false,
      },
      undefined,
    )).rejects.toMatchObject({
      code: 'VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY',
    });

    expect(testDb.prepare(`
      SELECT block_weekends, company_holidays_enabled, carry_over_enabled
      FROM vacay_plans
      WHERE id = ?
    `).get(plan.id)).toEqual(beforePlan);
    expect(testDb.prepare(`
      SELECT carried_over
      FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(owner.id, plan.id, year)).toEqual({ carried_over: 7 });
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });
});

// ── addHolidayCalendar ────────────────────────────────────────────────────────

describe('addHolidayCalendar', () => {
  it('VACAY-SVC-019: inserts a new calendar row and returns the calendar object', () => {
    const { plan } = setupUserWithPlan();

    const cal = addHolidayCalendar(plan.id, 'GB', 'UK Holidays', '#ff0000', 0, undefined);

    expect(cal).toBeDefined();
    expect(cal.id).toBeGreaterThan(0);
    expect(cal.region).toBe('GB');
    expect(cal.label).toBe('UK Holidays');
    expect(cal.color).toBe('#ff0000');
  });

  it('VACAY-SVC-020: uses default color #fecaca when no color is provided', () => {
    const { plan } = setupUserWithPlan();

    const cal = addHolidayCalendar(plan.id, 'US', null, undefined, 0, undefined);

    expect(cal.color).toBe('#fecaca');
  });
});

// ── updateHolidayCalendar ─────────────────────────────────────────────────────

describe('updateHolidayCalendar', () => {
  it('VACAY-SVC-021: changes label and color on an existing calendar', () => {
    const { plan } = setupUserWithPlan();
    const cal = addHolidayCalendar(plan.id, 'DE', 'Germany', '#aabbcc', 0, undefined);

    const updated = updateHolidayCalendar(cal.id, plan.id, { label: 'Deutschland', color: '#112233' }, undefined);

    expect(updated).not.toBeNull();
    expect(updated!.label).toBe('Deutschland');
    expect(updated!.color).toBe('#112233');
  });

  it('VACAY-SVC-022: returns null when the calendar id does not exist in the plan', () => {
    const { plan } = setupUserWithPlan();

    const result = updateHolidayCalendar(99999, plan.id, { label: 'Nope' }, undefined);

    expect(result).toBeNull();
  });
});

// ── deleteHolidayCalendar ─────────────────────────────────────────────────────

describe('deleteHolidayCalendar', () => {
  it('VACAY-SVC-023: removes the calendar row and returns true on success', () => {
    const { plan } = setupUserWithPlan();
    const cal = addHolidayCalendar(plan.id, 'FR', null, undefined, 0, undefined);

    const result = deleteHolidayCalendar(cal.id, plan.id, undefined);

    expect(result).toBe(true);
    const row = testDb.prepare('SELECT id FROM vacay_holiday_calendars WHERE id = ?').get(cal.id);
    expect(row).toBeUndefined();
  });

  it('VACAY-SVC-024: returns false when the calendar does not exist', () => {
    const { plan } = setupUserWithPlan();

    const result = deleteHolidayCalendar(99999, plan.id, undefined);

    expect(result).toBe(false);
  });
});

// ── setUserColor ──────────────────────────────────────────────────────────────

describe('setUserColor', () => {
  it('VACAY-SVC-025: inserts a color for a user in a plan', () => {
    const { user, plan } = setupUserWithPlan();

    setUserColor(user.id, plan.id, '#123456', undefined);

    const row = testDb
      .prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?')
      .get(user.id, plan.id) as { color: string } | undefined;
    expect(row?.color).toBe('#123456');
  });

  it('VACAY-SVC-026: updates the color when called a second time (upsert)', () => {
    const { user, plan } = setupUserWithPlan();
    setUserColor(user.id, plan.id, '#aaaaaa', undefined);

    setUserColor(user.id, plan.id, '#bbbbbb', undefined);

    const row = testDb
      .prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?')
      .get(user.id, plan.id) as { color: string };
    expect(row.color).toBe('#bbbbbb');
  });
});

// ── listYears / addYear / deleteYear ──────────────────────────────────────────

describe('listYears', () => {
  it('VACAY-SVC-027: returns the seeded current year for a freshly created plan', () => {
    const { plan } = setupUserWithPlan();
    const yr = new Date().getFullYear();

    const years = listYears(plan.id);

    expect(years).toContain(yr);
  });
});

describe('addYear', () => {
  it('VACAY-SVC-028: inserts a new year and creates a user_year record', () => {
    const { user, plan } = setupUserWithPlan();
    const newYear = new Date().getFullYear() + 2;

    addYear(plan.id, newYear, undefined);

    const years = listYears(plan.id);
    expect(years).toContain(newYear);

    const userYear = testDb
      .prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?')
      .get(user.id, plan.id, newYear) as { vacation_days: number } | undefined;
    expect(userYear).toBeDefined();
    expect(userYear!.vacation_days).toBe(30);
  });

  it('VACAY-SVC-029: carries over remaining deducting days when company holidays overlap entries', () => {
    const { user, plan } = setupUserWithPlan();
    const currentYear = new Date().getFullYear();
    const nextYear = currentYear + 1;

    // Enable carry-over and seed some entries for the current year
    testDb.prepare('UPDATE vacay_plans SET carry_over_enabled = 1 WHERE id = ?').run(plan.id);
    // Ensure current year row exists with 10 vacation days
    testDb.prepare(`
      INSERT OR REPLACE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 10, 0)
    `).run(user.id, plan.id, currentYear);
    // Add 3 entries (used days) in the current year
    for (let day = 1; day <= 3; day++) {
      const dateStr = `${currentYear}-06-0${day}`;
      testDb.prepare('INSERT OR IGNORE INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(plan.id, user.id, dateStr, '');
    }
    testDb.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)')
      .run(plan.id, `${currentYear}-06-01`, 'Company shutdown');

    addYear(plan.id, nextYear, undefined);

    const userYear = testDb
      .prepare('SELECT carried_over FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?')
      .get(user.id, plan.id, nextYear) as { carried_over: number } | undefined;
    // The overlapping company holiday is non-deducting: 10 - 2 = 8.
    expect(userYear?.carried_over).toBe(8);
  });

  it('VACAY-SVC-029a: rejects non-safe-integer years consistently for add and delete', () => {
    const { user, plan } = setupUserWithPlan();
    const before = listYears(plan.id);
    broadcastToUserMock.mockClear();

    for (const invalidYear of [2026.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addYear(plan.id, invalidYear, undefined)).toThrowError(
        expect.objectContaining({ code: 'VACAY_INVALID_YEAR' }),
      );
      expect(() => deleteActiveYear(user.id, invalidYear, undefined)).toThrowError(
        expect.objectContaining({ code: 'VACAY_INVALID_YEAR' }),
      );
    }

    expect(listYears(plan.id)).toEqual(before);
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });
});

describe('deleteYear', () => {
  it('VACAY-SVC-030: atomically removes only the solo owner target year and broadcasts once', () => {
    const { user, plan } = setupUserWithPlan();
    const { user: otherUser, plan: otherPlan } = setupUserWithPlan();
    const targetYear = new Date().getFullYear() + 3;
    const adjacentYear = targetYear + 1;

    addYear(plan.id, targetYear, undefined);
    addYear(plan.id, adjacentYear, undefined);
    addYear(otherPlan.id, targetYear, undefined);
    testDb
      .prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)')
      .run(plan.id, user.id, `${targetYear}-07-15`, '');
    testDb
      .prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)')
      .run(otherPlan.id, otherUser.id, `${targetYear}-07-15`, 'other plan');
    broadcastToUserMock.mockClear();

    deleteActiveYear(user.id, targetYear, undefined);

    const yearRow = testDb
      .prepare('SELECT * FROM vacay_years WHERE plan_id = ? AND year = ?')
      .get(plan.id, targetYear);
    expect(yearRow).toBeUndefined();

    const entries = testDb
      .prepare("SELECT * FROM vacay_entries WHERE plan_id = ? AND date LIKE ?")
      .all(plan.id, `${targetYear}-%`);
    expect(entries).toHaveLength(0);
    expect(testDb.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?')
      .get(plan.id, adjacentYear)).toBeDefined();
    expect(testDb.prepare('SELECT note FROM vacay_entries WHERE plan_id = ? AND date = ?')
      .get(otherPlan.id, `${targetYear}-07-15`)).toEqual({ note: 'other plan' });
    expect(broadcastToUserMock).toHaveBeenCalledTimes(1);
  });

  it('VACAY-SVC-030a: carry recompute after year deletion excludes manual company holidays', () => {
    const { user, plan } = setupUserWithPlan();
    const currentYear = new Date().getFullYear();
    const previousYear = currentYear - 2;
    const removedYear = currentYear - 1;
    const date = `${previousYear}-06-01`;

    testDb.prepare('INSERT INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, previousYear);
    testDb.prepare('INSERT INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, removedYear);
    testDb.prepare(`
      INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 10, 0)
    `).run(user.id, plan.id, previousYear);
    testDb.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)')
      .run(user.id, plan.id, removedYear);
    testDb.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)')
      .run(plan.id, user.id, date, '');
    testDb.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)')
      .run(plan.id, date, 'Company shutdown');

    deleteActiveYear(user.id, removedYear, undefined);

    const current = testDb.prepare(`
      SELECT carried_over FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(user.id, plan.id, currentYear) as { carried_over: number };
    expect(current.carried_over).toBe(10);
  });

  it('VACAY-SVC-030b: rejects fused owner and member before changing any target-year row', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    const year = new Date().getFullYear() + 3;

    addYear(plan.id, year, undefined);
    insertMember(plan.id, member.id, 'accepted');
    testDb.prepare(`
      INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 17, 4)
    `).run(member.id, plan.id, year);
    testDb.prepare(`
      INSERT INTO vacay_entries (plan_id, user_id, date, note)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      plan.id, owner.id, `${year}-03-01`, 'owner',
      plan.id, member.id, `${year}-03-02`, 'member',
    );
    testDb.prepare(`
      INSERT INTO vacay_company_holidays (plan_id, date, note)
      VALUES (?, ?, ?)
    `).run(plan.id, `${year}-05-01`, 'shared legacy row');
    const before = snapshotYear(plan.id, year);
    broadcastToUserMock.mockClear();

    for (const actorId of [owner.id, member.id]) {
      expect(() => deleteActiveYear(actorId, year, undefined)).toThrowError(
        expect.objectContaining({
          code: 'VACAY_FUSED_YEAR_DELETE_READ_ONLY',
        }),
      );
      expect(snapshotYear(plan.id, year)).toEqual(before);
    }
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });

  it('VACAY-SVC-030c: requires review while the target plan has an outgoing pending invite', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: invitee } = createUser(testDb);
    const year = new Date().getFullYear() + 3;

    addYear(plan.id, year, undefined);
    insertMember(plan.id, invitee.id, 'pending');
    const before = snapshotYear(plan.id, year);
    broadcastToUserMock.mockClear();

    expect(() => deleteActiveYear(owner.id, year, undefined)).toThrowError(
      expect.objectContaining({
        code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED',
      }),
    );
    expect(snapshotYear(plan.id, year)).toEqual(before);
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });

  it('VACAY-SVC-030d: requires review for a dissolved-plan-style foreign target user-year', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: formerMember } = createUser(testDb);
    const year = new Date().getFullYear() + 3;

    addYear(plan.id, year, undefined);
    testDb.prepare(`
      INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 21, 2)
    `).run(formerMember.id, plan.id, year);
    const before = snapshotYear(plan.id, year);
    broadcastToUserMock.mockClear();

    expect(() => deleteActiveYear(owner.id, year, undefined)).toThrowError(
      expect.objectContaining({
        code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED',
      }),
    );
    expect(snapshotYear(plan.id, year)).toEqual(before);
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });

  it('VACAY-SVC-030e: distinguishes a true no-op from orphan dependent rows', () => {
    const { user, plan } = setupUserWithPlan();
    const absentYear = new Date().getFullYear() + 7;
    broadcastToUserMock.mockClear();

    expect(deleteActiveYear(user.id, absentYear, undefined)).toEqual(listYears(plan.id));
    expect(broadcastToUserMock).not.toHaveBeenCalled();

    testDb.prepare(`
      INSERT INTO vacay_entries (plan_id, user_id, date, note)
      VALUES (?, ?, ?, ?)
    `).run(plan.id, user.id, `${absentYear}-08-01`, 'orphan');
    const before = snapshotYear(plan.id, absentYear);

    expect(() => deleteActiveYear(user.id, absentYear, undefined)).toThrowError(
      expect.objectContaining({
        code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED',
      }),
    );
    expect(snapshotYear(plan.id, absentYear)).toEqual(before);
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });

  it('VACAY-SVC-030f: rolls every delete back and does not broadcast when a middle statement fails', () => {
    const { user, plan } = setupUserWithPlan();
    const year = new Date().getFullYear() + 3;

    addYear(plan.id, year, undefined);
    testDb.prepare(`
      INSERT INTO vacay_entries (plan_id, user_id, date, note)
      VALUES (?, ?, ?, ?)
    `).run(plan.id, user.id, `${year}-04-01`, 'entry');
    testDb.prepare(`
      INSERT INTO vacay_company_holidays (plan_id, date, note)
      VALUES (?, ?, ?)
    `).run(plan.id, `${year}-05-01`, 'holiday');
    testDb.exec(`
      CREATE TRIGGER fail_vacay_company_holiday_delete
      BEFORE DELETE ON vacay_company_holidays
      BEGIN
        SELECT RAISE(ABORT, 'forced year delete failure');
      END
    `);
    const before = snapshotYear(plan.id, year);
    broadcastToUserMock.mockClear();

    try {
      expect(() => deleteActiveYear(user.id, year, undefined))
        .toThrow('forced year delete failure');
      expect(snapshotYear(plan.id, year)).toEqual(before);
      expect(broadcastToUserMock).not.toHaveBeenCalled();
    } finally {
      testDb.exec('DROP TRIGGER IF EXISTS fail_vacay_company_holiday_delete');
    }
  });

  it('VACAY-SVC-030g: recomputes the full contiguous carry chain after deleting a middle year', () => {
    const { user, plan } = setupUserWithPlan();
    const previousYear = new Date().getFullYear() + 3;
    const removedYear = previousYear + 1;
    const firstSuccessor = removedYear + 1;
    const secondSuccessor = firstSuccessor + 1;

    for (const year of [previousYear, removedYear, firstSuccessor, secondSuccessor]) {
      addYear(plan.id, year, undefined);
    }
    testDb.prepare(`
      UPDATE vacay_user_years
      SET vacation_days = 10, carried_over = 0
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).run(user.id, plan.id, previousYear);
    testDb.prepare(`
      UPDATE vacay_user_years
      SET vacation_days = 20, carried_over = 99
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).run(user.id, plan.id, firstSuccessor);
    testDb.prepare(`
      UPDATE vacay_user_years
      SET carried_over = 99
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).run(user.id, plan.id, secondSuccessor);
    for (const day of [1, 2]) {
      testDb.prepare(`
        INSERT INTO vacay_entries (plan_id, user_id, date, note)
        VALUES (?, ?, ?, '')
      `).run(plan.id, user.id, `${previousYear}-04-0${day}`);
    }
    for (const day of [1, 2, 3, 4, 5]) {
      testDb.prepare(`
        INSERT INTO vacay_entries (plan_id, user_id, date, note)
        VALUES (?, ?, ?, '')
      `).run(plan.id, user.id, `${firstSuccessor}-06-0${day}`);
    }
    broadcastToUserMock.mockClear();

    deleteActiveYear(user.id, removedYear, undefined);

    const rows = testDb.prepare(`
      SELECT year, carried_over
      FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year IN (?, ?)
      ORDER BY year
    `).all(
      user.id,
      plan.id,
      firstSuccessor,
      secondSuccessor,
    ) as { year: number; carried_over: number }[];
    expect(rows).toEqual([
      { year: firstSuccessor, carried_over: 8 },
      { year: secondSuccessor, carried_over: 23 },
    ]);
    expect(broadcastToUserMock).toHaveBeenCalledTimes(1);
  });

  it('VACAY-SVC-030h: rolls deletion and earlier carry updates back when a later carry update fails', () => {
    const { user, plan } = setupUserWithPlan();
    const removedYear = new Date().getFullYear() + 3;
    const firstSuccessor = removedYear + 1;
    const secondSuccessor = firstSuccessor + 1;

    for (const year of [removedYear, firstSuccessor, secondSuccessor]) {
      addYear(plan.id, year, undefined);
    }
    testDb.prepare(`
      UPDATE vacay_user_years
      SET carried_over = 17
      WHERE user_id = ? AND plan_id = ? AND year IN (?, ?)
    `).run(user.id, plan.id, firstSuccessor, secondSuccessor);
    const before = {
      years: listYears(plan.id),
      userYears: testDb.prepare(`
        SELECT user_id, plan_id, year, vacation_days, carried_over
        FROM vacay_user_years
        WHERE plan_id = ?
        ORDER BY user_id, year
      `).all(plan.id),
    };
    testDb.exec(`
      CREATE TRIGGER fail_later_vacay_carry_update
      BEFORE UPDATE OF carried_over ON vacay_user_years
      WHEN NEW.plan_id = ${plan.id} AND NEW.year = ${secondSuccessor}
      BEGIN
        SELECT RAISE(ABORT, 'forced later carry failure');
      END
    `);
    broadcastToUserMock.mockClear();

    try {
      expect(() => deleteActiveYear(user.id, removedYear, undefined))
        .toThrow('forced later carry failure');
      expect({
        years: listYears(plan.id),
        userYears: testDb.prepare(`
          SELECT user_id, plan_id, year, vacation_days, carried_over
          FROM vacay_user_years
          WHERE plan_id = ?
          ORDER BY user_id, year
        `).all(plan.id),
      }).toEqual(before);
      expect(broadcastToUserMock).not.toHaveBeenCalled();
    } finally {
      testDb.exec('DROP TRIGGER IF EXISTS fail_later_vacay_carry_update');
    }
  });

  it('VACAY-SVC-030i: treats NULL and dangling accepted memberships as review-required legacy state', () => {
    const { user, plan } = setupUserWithPlan();
    const { plan: otherPlan } = setupUserWithPlan();
    const targetYear = new Date().getFullYear() + 3;
    addYear(plan.id, targetYear, undefined);
    const before = snapshotYear(plan.id, targetYear);

    testDb.prepare(`
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, NULL)
    `).run(otherPlan.id, user.id);
    expect(() => deleteActiveYear(user.id, targetYear, undefined)).toThrowError(
      expect.objectContaining({ code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED' }),
    );
    expect(snapshotYear(plan.id, targetYear)).toEqual(before);

    testDb.prepare('DELETE FROM vacay_plan_members WHERE user_id = ?').run(user.id);
    testDb.pragma('foreign_keys = OFF');
    try {
      testDb.prepare(`
        INSERT INTO vacay_plan_members (plan_id, user_id, status)
        VALUES (?, ?, 'accepted')
      `).run(999999, user.id);
    } finally {
      testDb.pragma('foreign_keys = ON');
    }
    expect(() => deleteActiveYear(user.id, targetYear, undefined)).toThrowError(
      expect.objectContaining({ code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED' }),
    );
    expect(snapshotYear(plan.id, targetYear)).toEqual(before);
  });
});

// ── getEntries / toggleEntry ──────────────────────────────────────────────────

describe('getEntries', () => {
  it('VACAY-SVC-031: returns empty entries and companyHolidays for a new plan+year', () => {
    const { plan } = setupUserWithPlan();
    const yr = new Date().getFullYear().toString();

    const result = getEntries(plan.id, yr);

    expect(result.entries).toEqual([]);
    expect(result.companyHolidays).toEqual([]);
  });
});

describe('toggleEntry', () => {
  it('VACAY-SVC-032: adds an entry on first call (action: added)', () => {
    const { user, plan } = setupUserWithPlan();

    const result = toggleEntry(user.id, plan.id, '2025-08-01', undefined);

    expect(result.action).toBe('added');
    const row = testDb
      .prepare('SELECT * FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?')
      .get(user.id, plan.id, '2025-08-01');
    expect(row).toBeDefined();
  });

  it('VACAY-SVC-033: removes the entry on second call (action: removed)', () => {
    const { user, plan } = setupUserWithPlan();

    toggleEntry(user.id, plan.id, '2025-08-02', undefined);
    const result = toggleEntry(user.id, plan.id, '2025-08-02', undefined);

    expect(result.action).toBe('removed');
    const row = testDb
      .prepare('SELECT * FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date = ?')
      .get(user.id, plan.id, '2025-08-02');
    expect(row).toBeUndefined();
  });
});

// ── toggleCompanyHoliday ──────────────────────────────────────────────────────

describe('toggleCompanyHoliday', () => {
  it('VACAY-SVC-034: adds a company holiday on first call (action: added)', () => {
    const { plan } = setupUserWithPlan();

    const result = toggleCompanyHoliday(plan.id, '2025-12-25', 'Christmas', undefined);

    expect(result.action).toBe('added');
    const row = testDb
      .prepare('SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date = ?')
      .get(plan.id, '2025-12-25');
    expect(row).toBeDefined();
  });

  it('VACAY-SVC-035: removes the company holiday on second call (action: removed)', () => {
    const { plan } = setupUserWithPlan();

    toggleCompanyHoliday(plan.id, '2025-12-26', 'Boxing Day', undefined);
    const result = toggleCompanyHoliday(plan.id, '2025-12-26', undefined, undefined);

    expect(result.action).toBe('removed');
    const row = testDb
      .prepare('SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date = ?')
      .get(plan.id, '2025-12-26');
    expect(row).toBeUndefined();
  });

  it('VACAY-SVC-036: solo-plan company holiday add and remove preserve same-date entries across plans', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: otherOwner, plan: otherPlan } = setupUserWithPlan();
    const date = '2025-05-01';

    toggleEntry(owner.id, plan.id, date, undefined);
    toggleEntry(otherOwner.id, otherPlan.id, date, undefined);
    testDb.prepare('UPDATE vacay_entries SET note = ? WHERE user_id = ? AND plan_id = ? AND date = ?')
      .run('owner note', owner.id, plan.id, date);
    testDb.prepare('UPDATE vacay_entries SET note = ? WHERE user_id = ? AND plan_id = ? AND date = ?')
      .run('other plan note', otherOwner.id, otherPlan.id, date);

    const snapshot = () => testDb.prepare(`
      SELECT id, plan_id, user_id, date, note
      FROM vacay_entries
      WHERE date = ?
      ORDER BY plan_id, user_id
    `).all(date);
    const before = snapshot();

    toggleCompanyHoliday(plan.id, date, 'Labour Day', undefined);
    expect(snapshot()).toEqual(before);

    toggleCompanyHoliday(plan.id, date, undefined, undefined);
    expect(snapshot()).toEqual(before);
  });

  it('VACAY-SVC-036b: rejects company-holiday toggles for a fused plan without changing rows or broadcasting', () => {
    const { plan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    const date = '2025-05-01';
    insertMember(plan.id, member.id, 'accepted');
    testDb.prepare(`
      INSERT INTO vacay_company_holidays (plan_id, date, note)
      VALUES (?, ?, ?)
    `).run(plan.id, date, 'Existing');
    const before = testDb.prepare(`
      SELECT id, plan_id, date, note
      FROM vacay_company_holidays
      WHERE plan_id = ?
      ORDER BY id
    `).all(plan.id);

    expect(() => toggleCompanyHoliday(plan.id, date, undefined, undefined)).toThrowError(
      expect.objectContaining({
        code: 'VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY',
      }),
    );

    expect(testDb.prepare(`
      SELECT id, plan_id, date, note
      FROM vacay_company_holidays
      WHERE plan_id = ?
      ORDER BY id
    `).all(plan.id)).toEqual(before);
    expect(broadcastToUserMock).not.toHaveBeenCalled();
  });

  it('VACAY-SVC-036c: pending invitations do not make company holidays read-only', () => {
    const { plan } = setupUserWithPlan();
    const { user: invitee } = createUser(testDb);
    insertMember(plan.id, invitee.id, 'pending');

    expect(toggleCompanyHoliday(plan.id, '2025-05-01', 'Labour Day', undefined))
      .toEqual({ action: 'added' });
  });

  it('VACAY-SVC-036a: manual company holiday state controls stats and carry without deleting the entry', async () => {
    const { user, plan } = setupUserWithPlan();
    const year = new Date().getFullYear();
    const nextYear = year + 1;
    const date = `${year}-05-01`;

    testDb.prepare('UPDATE vacay_user_years SET vacation_days = 10 WHERE user_id = ? AND plan_id = ? AND year = ?')
      .run(user.id, plan.id, year);
    testDb.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, nextYear);
    testDb.prepare(`
      INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, 30, 0)
    `).run(user.id, plan.id, nextYear);
    toggleEntry(user.id, plan.id, date, undefined);
    const before = testDb.prepare('SELECT * FROM vacay_entries WHERE plan_id = ? AND date = ?')
      .get(plan.id, date);

    expect(getStats(plan.id, year)[0]).toMatchObject({ used: 1, remaining: 9 });

    toggleCompanyHoliday(plan.id, date, 'Labour Day', undefined);
    expect(testDb.prepare('SELECT * FROM vacay_entries WHERE plan_id = ? AND date = ?').get(plan.id, date))
      .toEqual(before);
    expect(getStats(plan.id, year)[0]).toMatchObject({ used: 0, remaining: 10 });
    expect((testDb.prepare(`
      SELECT carried_over FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(user.id, plan.id, nextYear) as { carried_over: number }).carried_over).toBe(10);

    await updatePlan(plan.id, { company_holidays_enabled: false }, undefined);
    expect(getStats(plan.id, year)[0]).toMatchObject({ used: 1, remaining: 9 });

    await updatePlan(plan.id, { company_holidays_enabled: true }, undefined);
    expect(testDb.prepare('SELECT * FROM vacay_entries WHERE plan_id = ? AND date = ?').get(plan.id, date))
      .toEqual(before);
    expect(getStats(plan.id, year)[0]).toMatchObject({ used: 0, remaining: 10 });

    toggleCompanyHoliday(plan.id, date, undefined, undefined);
    expect(testDb.prepare('SELECT * FROM vacay_entries WHERE plan_id = ? AND date = ?').get(plan.id, date))
      .toEqual(before);
    expect(getStats(plan.id, year)[0]).toMatchObject({ used: 1, remaining: 9 });
    expect((testDb.prepare(`
      SELECT carried_over FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(user.id, plan.id, nextYear) as { carried_over: number }).carried_over).toBe(9);
  });
});

// ── acceptInvite / declineInvite / cancelInvite ───────────────────────────────

describe('acceptInvite', () => {
  it('VACAY-SVC-037: changes membership status to accepted', () => {
    const { user: owner, plan: ownerPlan } = setupUserWithPlan();
    const { user: invitee } = createUser(testDb);
    getOwnPlan(invitee.id); // ensure own plan exists for data migration path
    insertMember(ownerPlan.id, invitee.id, 'pending');

    const result = acceptInvite(invitee.id, ownerPlan.id, undefined);

    expect(result.error).toBeUndefined();
    const row = testDb
      .prepare('SELECT status FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?')
      .get(ownerPlan.id, invitee.id) as { status: string } | undefined;
    expect(row?.status).toBe('accepted');
  });

  it('VACAY-SVC-038: returns 404 error when there is no pending invite', () => {
    const { user } = createUser(testDb);

    const result = acceptInvite(user.id, 99999, undefined);

    expect(result.status).toBe(404);
    expect(result.error).toBeDefined();
  });

  it('VACAY-SVC-039: accepted member becomes visible via getActivePlan', () => {
    const { user: owner, plan: ownerPlan } = setupUserWithPlan();
    const { user: invitee } = createUser(testDb);
    getOwnPlan(invitee.id);
    insertMember(ownerPlan.id, invitee.id, 'pending');

    acceptInvite(invitee.id, ownerPlan.id, undefined);

    const active = getActivePlan(invitee.id);
    expect(active.id).toBe(ownerPlan.id);
  });
});

describe('declineInvite', () => {
  it('VACAY-SVC-040: removes the pending invite row', () => {
    const { user: owner, plan: ownerPlan } = setupUserWithPlan();
    const { user: invitee } = createUser(testDb);
    insertMember(ownerPlan.id, invitee.id, 'pending');

    declineInvite(invitee.id, ownerPlan.id, undefined);

    const row = testDb
      .prepare('SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?')
      .get(ownerPlan.id, invitee.id);
    expect(row).toBeUndefined();
  });
});

describe('cancelInvite', () => {
  it('VACAY-SVC-041: removes the pending invite when owner cancels it', () => {
    const { user: owner, plan: ownerPlan } = setupUserWithPlan();
    const { user: target } = createUser(testDb);
    insertMember(ownerPlan.id, target.id, 'pending');

    cancelInvite(ownerPlan.id, target.id);

    const row = testDb
      .prepare('SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?')
      .get(ownerPlan.id, target.id);
    expect(row).toBeUndefined();
  });
});

// ── getAvailableUsers ─────────────────────────────────────────────────────────

describe('getAvailableUsers', () => {
  it('VACAY-SVC-042: returns users not already in the plan and not fused elsewhere', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: unrelated } = createUser(testDb);
    getOwnPlan(unrelated.id);

    const available = getAvailableUsers(owner.id, plan.id) as { id: number }[];

    expect(available.map(u => u.id)).toContain(unrelated.id);
    // Owner themselves should NOT appear (excluded by u.id != ?)
    expect(available.map(u => u.id)).not.toContain(owner.id);
  });

  it('VACAY-SVC-043: excludes users who already have an accepted membership in any plan', () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: alreadyFused } = createUser(testDb);
    const { plan: otherPlan } = setupUserWithPlan();
    insertMember(otherPlan.id, alreadyFused.id, 'accepted');

    const available = getAvailableUsers(owner.id, plan.id) as { id: number }[];

    expect(available.map(u => u.id)).not.toContain(alreadyFused.id);
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────

describe('getStats', () => {
  it('VACAY-SVC-044: returns per-user stats with correct fields', () => {
    const { user, plan } = setupUserWithPlan();
    const yr = new Date().getFullYear();

    const stats = getStats(plan.id, yr);

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      user_id: user.id,
      year: yr,
      vacation_days: 30,
      used: 0,
      remaining: 30,
    });
  });

  it('VACAY-SVC-045: used reflects the actual number of entries for that user and year', () => {
    const { user, plan } = setupUserWithPlan();
    const yr = new Date().getFullYear();

    toggleEntry(user.id, plan.id, `${yr}-09-10`, undefined);
    toggleEntry(user.id, plan.id, `${yr}-09-11`, undefined);

    const stats = getStats(plan.id, yr);

    expect(stats[0].used).toBe(2);
    expect(stats[0].remaining).toBe(28);
  });

  it('VACAY-SVC-045a: reading a deleted source year cannot overwrite successor carry', () => {
    const { user, plan } = setupUserWithPlan();
    const previousYear = new Date().getFullYear();
    const deletedYear = previousYear + 1;
    const successorYear = deletedYear + 1;

    addYear(plan.id, deletedYear, undefined);
    addYear(plan.id, successorYear, undefined);
    testDb.prepare(`
      UPDATE vacay_user_years
      SET vacation_days = 7, carried_over = 0
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).run(user.id, plan.id, previousYear);
    for (const day of [1, 2]) {
      testDb.prepare(`
        INSERT INTO vacay_entries (plan_id, user_id, date, note)
        VALUES (?, ?, ?, '')
      `).run(plan.id, user.id, `${previousYear}-03-0${day}`);
    }

    deleteActiveYear(user.id, deletedYear, undefined);
    const afterDelete = testDb.prepare(`
      SELECT carried_over
      FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(user.id, plan.id, successorYear);
    expect(afterDelete).toEqual({ carried_over: 5 });

    getStats(plan.id, deletedYear);

    expect(testDb.prepare(`
      SELECT carried_over
      FROM vacay_user_years
      WHERE user_id = ? AND plan_id = ? AND year = ?
    `).get(user.id, plan.id, successorYear)).toEqual(afterDelete);
  });
});

// ── applyHolidayCalendars ─────────────────────────────────────────────────────

describe('applyHolidayCalendars', () => {
  it('VACAY-SVC-046: does nothing when holidays_enabled is 0 (fetch is never called)', async () => {
    const { plan } = setupUserWithPlan();
    // holidays_enabled defaults to 0

    await applyHolidayCalendars(plan.id);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('VACAY-SVC-047: provider refresh preserves entries and manual holidays across users and plans', async () => {
    const { user: owner, plan } = setupUserWithPlan();
    const { user: member } = createUser(testDb);
    const { user: otherOwner, plan: otherPlan } = setupUserWithPlan();
    const yr = new Date().getFullYear();
    const holidayDate = `${yr}-01-01`;
    insertMember(plan.id, member.id, 'accepted');

    testDb.prepare('UPDATE vacay_plans SET holidays_enabled = 1 WHERE id = ?').run(plan.id);
    addHolidayCalendar(plan.id, 'DE', null, undefined, 0, undefined);
    toggleEntry(owner.id, plan.id, holidayDate, undefined);
    toggleEntry(member.id, plan.id, holidayDate, undefined);
    toggleEntry(otherOwner.id, otherPlan.id, holidayDate, undefined);
    testDb.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)')
      .run(plan.id, holidayDate, 'Manual company holiday');
    testDb.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)')
      .run(otherPlan.id, holidayDate, 'Other plan holiday');

    const entrySnapshot = () => testDb.prepare(`
      SELECT id, plan_id, user_id, date, note
      FROM vacay_entries
      WHERE date = ?
      ORDER BY plan_id, user_id
    `).all(holidayDate);
    const companyHolidaySnapshot = () => testDb.prepare(`
      SELECT id, plan_id, date, note
      FROM vacay_company_holidays
      WHERE date = ?
      ORDER BY plan_id
    `).all(holidayDate);
    const entriesBefore = entrySnapshot();
    const companyHolidaysBefore = companyHolidaySnapshot();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ date: holidayDate, global: true }],
    }));

    await applyHolidayCalendars(plan.id);
    await applyHolidayCalendars(plan.id);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(entrySnapshot()).toEqual(entriesBefore);
    expect(companyHolidaySnapshot()).toEqual(companyHolidaysBefore);
  });
});
