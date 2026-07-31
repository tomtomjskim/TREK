/**
 * Unit tests for MCP vacay tools (vacay addon-gated):
 * get_vacay_plan, update_vacay_plan, set_vacay_color,
 * list_vacay_years, add_vacay_year, delete_vacay_year,
 * get_vacay_entries, toggle_vacay_entry, toggle_company_holiday,
 * get_vacay_stats, update_vacay_stats,
 * add_holiday_calendar, update_holiday_calendar, delete_holiday_calendar,
 * list_holiday_countries, list_holidays.
 * Resources: trek://vacay/plan, trek://vacay/entries/{year}.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

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
    getPlaceWithTags: () => null,
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast: broadcastMock }));

vi.mock('../../../src/services/adminService', () => ({
  isAddonEnabled: vi.fn().mockReturnValue(true),
  getCollabFeatures: vi.fn().mockReturnValue({ chat: true, notes: true, polls: true, whatsnext: true }),
}));

// Mock async service functions that make external calls
vi.mock('../../../src/services/vacayService', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getCountries: vi.fn().mockResolvedValue({ data: [{ code: 'US', name: 'United States' }] }),
    getHolidays: vi.fn().mockResolvedValue({ data: [{ date: '2025-01-01', name: 'New Year' }] }),
  };
});

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrationRunner';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, parseResourceResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  broadcastMock.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  }));
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  vi.unstubAllGlobals();
  testDb.close();
});

async function withHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false });
  try { await fn(h); } finally { await h.cleanup(); }
}

async function withResourceHarness(userId: number, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: true });
  try { await fn(h); } finally { await h.cleanup(); }
}

// ---------------------------------------------------------------------------
// get_vacay_plan
// ---------------------------------------------------------------------------

describe('Tool: get_vacay_plan', () => {
  it('returns plan data object', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.plan).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// update_vacay_plan
// ---------------------------------------------------------------------------

describe('Tool: update_vacay_plan', () => {
  it('calls updatePlan and returns the hydrated plan', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'update_vacay_plan',
        arguments: { block_weekends: true, holidays_enabled: false },
      });
      const data = parseToolResult(result) as any;
      // Now returns the fully-hydrated plan (matching get_vacay_plan), not { success }.
      expect(data.plan).toBeDefined();
      expect(data.plan.block_weekends).toBe(true);
      expect(data.plan.holidays_enabled).toBe(false);
      expect(Array.isArray(data.plan.holiday_calendars)).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_vacay_plan', arguments: { block_weekends: true } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns a tool error without partial settings updates for a fused plan', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
      const plan = testDb.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?')
        .get(owner.id) as { id: number };
      testDb.prepare(`
        INSERT INTO vacay_plan_members (plan_id, user_id, status)
        VALUES (?, ?, 'accepted')
      `).run(plan.id, member.id);
      const before = testDb.prepare(`
        SELECT block_weekends, company_holidays_enabled
        FROM vacay_plans
        WHERE id = ?
      `).get(plan.id);

      const result = await h.client.callTool({
        name: 'update_vacay_plan',
        arguments: {
          block_weekends: true,
          company_holidays_enabled: false,
        },
      });

      expect(result.isError).toBe(true);
      expect(testDb.prepare(`
        SELECT block_weekends, company_holidays_enabled
        FROM vacay_plans
        WHERE id = ?
      `).get(plan.id)).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// set_vacay_color
// ---------------------------------------------------------------------------

describe('Tool: set_vacay_color', () => {
  it('updates color and returns success', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'set_vacay_color', arguments: { color: '#ff0000' } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
      expect(data.color).toBe('#ff0000'); // echoes the persisted color
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'set_vacay_color', arguments: { color: '#ff0000' } });
      expect(result.isError).toBe(true);
    });
  });

});

// ---------------------------------------------------------------------------
// accept_vacay_invite
// ---------------------------------------------------------------------------

describe('Tool: accept_vacay_invite', () => {
  it('returns stable invite year review details without accepting the member', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    const year = 2035;

    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
    });
    await withHarness(invitee.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
      await h.client.callTool({ name: 'add_vacay_year', arguments: { year } });
    });
    const ownerPlan = testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?')
      .get(owner.id) as { id: number };
    testDb.prepare(`
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'pending')
    `).run(ownerPlan.id, invitee.id);

    await withHarness(invitee.id, async (h) => {
      const result = await h.client.callTool({
        name: 'accept_vacay_invite',
        arguments: { planId: ownerPlan.id },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_INVITE_YEAR_REVIEW_REQUIRED',
        missing_years: [year],
      });
    });
    expect(testDb.prepare(`
      SELECT status
      FROM vacay_plan_members
      WHERE plan_id = ? AND user_id = ?
    `).get(ownerPlan.id, invitee.id)).toEqual({ status: 'pending' });
  });
});

// ---------------------------------------------------------------------------
// list_vacay_years
// ---------------------------------------------------------------------------

describe('Tool: list_vacay_years', () => {
  it('returns years array', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_vacay_years', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.years)).toBe(true);
    });
  });
});

describe('Tool: accept_vacay_invite membership topology', () => {
  it('returns stable membership review details without orphaning the invitee plan', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    const { user: pendingMember } = createUser(testDb);

    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
    });
    await withHarness(invitee.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
    });
    const ownerPlan = testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(owner.id) as { id: number };
    const inviteePlan = testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(invitee.id) as {
      id: number;
    };
    testDb
      .prepare(
        `
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'pending')
    `,
      )
      .run(inviteePlan.id, pendingMember.id);
    testDb
      .prepare(
        `
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'pending')
    `,
      )
      .run(ownerPlan.id, invitee.id);

    await withHarness(invitee.id, async (h) => {
      const result = await h.client.callTool({
        name: 'accept_vacay_invite',
        arguments: { planId: ownerPlan.id },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED',
      });
    });
    expect(
      testDb
        .prepare(
          `
      SELECT status
      FROM vacay_plan_members
      WHERE plan_id = ? AND user_id = ?
    `,
        )
        .get(ownerPlan.id, invitee.id),
    ).toEqual({ status: 'pending' });
  });
});

describe('Tool: send_vacay_invite', () => {
  it('returns a structured membership review error when a member targets the plan owner', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);

    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
    });
    const ownerPlan = testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(owner.id) as { id: number };
    testDb
      .prepare(
        `
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'accepted')
    `,
      )
      .run(ownerPlan.id, member.id);

    await withHarness(member.id, async (h) => {
      const result = await h.client.callTool({
        name: 'send_vacay_invite',
        arguments: { targetUserId: owner.id },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED',
      });
    });
    expect(
      testDb
        .prepare(
          `
      SELECT id
      FROM vacay_plan_members
      WHERE plan_id = ? AND user_id = ?
    `,
        )
        .get(ownerPlan.id, owner.id),
    ).toBeUndefined();
  });
});

describe('Tool: cancel_vacay_invite', () => {
  it('rejects an accepted member cancelling the owner pending invite', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const { user: target } = createUser(testDb);

    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
    });
    const ownerPlan = testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?')
      .get(owner.id) as { id: number };
    testDb.prepare(`
      INSERT INTO vacay_plan_members (plan_id, user_id, status)
      VALUES (?, ?, 'accepted'), (?, ?, 'pending')
    `).run(ownerPlan.id, member.id, ownerPlan.id, target.id);

    await withHarness(member.id, async (h) => {
      const result = await h.client.callTool({
        name: 'cancel_vacay_invite',
        arguments: { targetUserId: target.id },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_INVITE_OWNER_REQUIRED',
      });
    });
    expect(testDb.prepare(`
      SELECT status FROM vacay_plan_members
      WHERE plan_id = ? AND user_id = ?
    `).get(ownerPlan.id, target.id)).toEqual({ status: 'pending' });
  });
});

// ---------------------------------------------------------------------------
// add_vacay_year
// ---------------------------------------------------------------------------

describe('Tool: add_vacay_year', () => {
  it('adds year to list', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'add_vacay_year', arguments: { year: 2025 } });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.years)).toBe(true);
      expect(data.years).toContain(2025);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'add_vacay_year', arguments: { year: 2025 } });
      expect(result.isError).toBe(true);
    });
  });

});

// ---------------------------------------------------------------------------
// delete_vacay_year
// ---------------------------------------------------------------------------

describe('Tool: delete_vacay_year', () => {
  it('removes year from list', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      // Add year first
      await h.client.callTool({ name: 'add_vacay_year', arguments: { year: 2025 } });
      const result = await h.client.callTool({ name: 'delete_vacay_year', arguments: { year: 2025 } });
      const data = parseToolResult(result) as any;
      expect(Array.isArray(data.years)).toBe(true);
      expect(data.years).not.toContain(2025);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_vacay_year', arguments: { year: 2025 } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns the stable fused code for owner and member without deleting rows', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const year = 2033;
    let planId = 0;

    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
      planId = (testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?')
        .get(owner.id) as { id: number }).id;
      await h.client.callTool({ name: 'add_vacay_year', arguments: { year } });
      testDb.prepare(`
        INSERT INTO vacay_plan_members (plan_id, user_id, status)
        VALUES (?, ?, 'accepted')
      `).run(planId, member.id);
      testDb.prepare(`
        INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over)
        VALUES (?, ?, ?, 18, 2)
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
    });

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

    for (const actorId of [owner.id, member.id]) {
      await withHarness(actorId, async (h) => {
        const result = await h.client.callTool({
          name: 'delete_vacay_year',
          arguments: { year },
        });
        expect(result.isError).toBe(true);
        expect(parseToolResult(result)).toMatchObject({
          code: 'VACAY_FUSED_YEAR_DELETE_READ_ONLY',
        });
      });
      expect(snapshot()).toEqual(before);
    }
  });

  it('returns the stable review-required code for a pending fusion without deleting rows', async () => {
    const { user: owner } = createUser(testDb);
    const { user: invitee } = createUser(testDb);
    const year = 2034;

    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
      const planId = (testDb.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?')
        .get(owner.id) as { id: number }).id;
      await h.client.callTool({ name: 'add_vacay_year', arguments: { year } });
      testDb.prepare(`
        INSERT INTO vacay_plan_members (plan_id, user_id, status)
        VALUES (?, ?, 'pending')
      `).run(planId, invitee.id);
      const before = testDb.prepare(
        'SELECT * FROM vacay_years WHERE plan_id = ? AND year = ?'
      ).get(planId, year);

      const result = await h.client.callTool({
        name: 'delete_vacay_year',
        arguments: { year },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_YEAR_DELETE_REVIEW_REQUIRED',
      });
      expect(testDb.prepare(
        'SELECT * FROM vacay_years WHERE plan_id = ? AND year = ?'
      ).get(planId, year)).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// get_vacay_entries
// ---------------------------------------------------------------------------

describe('Tool: get_vacay_entries', () => {
  it('returns entries array (empty initially)', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_vacay_entries', arguments: { year: 2025 } });
      const data = parseToolResult(result) as any;
      expect(data.entries).toBeDefined();
      expect(Array.isArray(data.entries.entries)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// toggle_vacay_entry
// ---------------------------------------------------------------------------

describe('Tool: toggle_vacay_entry', () => {
  it('toggles entry and returns action', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_vacay_entry', arguments: { date: '2025-06-15' } });
      const data = parseToolResult(result) as any;
      expect(data.action).toBeDefined();
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_vacay_entry', arguments: { date: '2025-06-15' } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns a stable tool error for an invalid calendar date', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_vacay_entry',
        arguments: { date: '2026-02-30' },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_INVALID_DATE',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// toggle_company_holiday
// ---------------------------------------------------------------------------

describe('Tool: toggle_company_holiday', () => {
  it('toggles company holiday and returns action', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_company_holiday',
        arguments: { date: '2025-12-25', note: 'Christmas' },
      });
      const data = parseToolResult(result) as any;
      expect(data.action).toBeDefined();
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'toggle_company_holiday', arguments: { date: '2025-12-25' } });
      expect(result.isError).toBe(true);
    });
  });

  it('returns a stable tool error for an invalid calendar date', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'toggle_company_holiday',
        arguments: { date: '2026-02-30' },
      });

      expect(result.isError).toBe(true);
      expect(parseToolResult(result)).toMatchObject({
        code: 'VACAY_INVALID_DATE',
      });
    });
  });

  it('returns a tool error and preserves rows for a fused plan', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    await withHarness(owner.id, async (h) => {
      await h.client.callTool({ name: 'get_vacay_plan', arguments: {} });
      const plan = testDb.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?')
        .get(owner.id) as { id: number };
      testDb.prepare(`
        INSERT INTO vacay_plan_members (plan_id, user_id, status)
        VALUES (?, ?, 'accepted')
      `).run(plan.id, member.id);

      const result = await h.client.callTool({
        name: 'toggle_company_holiday',
        arguments: { date: '2025-12-25', note: 'Christmas' },
      });

      expect(result.isError).toBe(true);
      expect(testDb.prepare(`
        SELECT id
        FROM vacay_company_holidays
        WHERE plan_id = ? AND date = ?
      `).get(plan.id, '2025-12-25')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// get_vacay_stats
// ---------------------------------------------------------------------------

describe('Tool: get_vacay_stats', () => {
  it('returns stats object', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'get_vacay_stats', arguments: { year: 2025 } });
      const data = parseToolResult(result) as any;
      expect(data.stats).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// update_vacay_stats
// ---------------------------------------------------------------------------

describe('Tool: update_vacay_stats', () => {
  it('updates vacation days allowance and returns success', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_vacay_stats', arguments: { year: 2025, vacationDays: 25 } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_vacay_stats', arguments: { year: 2025, vacationDays: 20 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// add_holiday_calendar
// ---------------------------------------------------------------------------

describe('Tool: add_holiday_calendar', () => {
  it('inserts calendar row and returns calendar', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({
        name: 'add_holiday_calendar',
        arguments: { region: 'US', label: 'US Holidays', color: '#ff0000' },
      });
      const data = parseToolResult(result) as any;
      expect(data.calendar).toBeDefined();
      expect(data.calendar.region).toBe('US');
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'add_holiday_calendar', arguments: { region: 'US' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update_holiday_calendar
// ---------------------------------------------------------------------------

describe('Tool: update_holiday_calendar', () => {
  it('updates label and color', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      // First add a calendar
      const addResult = await h.client.callTool({
        name: 'add_holiday_calendar',
        arguments: { region: 'DE', label: 'Germany' },
      });
      const added = parseToolResult(addResult) as any;
      const calId = added.calendar.id;

      const result = await h.client.callTool({
        name: 'update_holiday_calendar',
        arguments: { calendarId: calId, label: 'German Holidays', color: '#00ff00' },
      });
      const data = parseToolResult(result) as any;
      expect(data.calendar).toBeDefined();
      expect(data.calendar.label).toBe('German Holidays');
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'update_holiday_calendar', arguments: { calendarId: 1, label: 'X' } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// delete_holiday_calendar
// ---------------------------------------------------------------------------

describe('Tool: delete_holiday_calendar', () => {
  it('removes calendar and returns success', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const addResult = await h.client.callTool({
        name: 'add_holiday_calendar',
        arguments: { region: 'FR' },
      });
      const added = parseToolResult(addResult) as any;
      const calId = added.calendar.id;

      const result = await h.client.callTool({ name: 'delete_holiday_calendar', arguments: { calendarId: calId } });
      const data = parseToolResult(result) as any;
      expect(data.success).toBe(true);
    });
  });

  it('blocks demo user', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'delete_holiday_calendar', arguments: { calendarId: 1 } });
      expect(result.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// list_holiday_countries
// ---------------------------------------------------------------------------

describe('Tool: list_holiday_countries', () => {
  it('returns countries from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_holiday_countries', arguments: {} });
      const data = parseToolResult(result) as any;
      expect(data.countries).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// list_holidays
// ---------------------------------------------------------------------------

describe('Tool: list_holidays', () => {
  it('returns holidays from mocked service', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, async (h) => {
      const result = await h.client.callTool({ name: 'list_holidays', arguments: { country: 'US', year: 2025 } });
      const data = parseToolResult(result) as any;
      expect(data.holidays).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe('Resource: trek://vacay/plan', () => {
  it('returns plan data', async () => {
    const { user } = createUser(testDb);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://vacay/plan' });
      const data = parseResourceResult(result) as any;
      expect(data).toBeDefined();
    });
  });
});

describe('Resource: trek://vacay/entries/{year}', () => {
  it('returns entries for a year', async () => {
    const { user } = createUser(testDb);
    await withResourceHarness(user.id, async (h) => {
      const result = await h.client.readResource({ uri: 'trek://vacay/entries/2025' });
      const data = parseResourceResult(result) as any;
      expect(data).toBeDefined();
      expect(Array.isArray(data.entries)).toBe(true);
    });
  });
});
