import { db } from '../db/database';
import { broadcastToUser } from '../websocket';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VacayPlan {
  id: number;
  owner_id: number;
  block_weekends: number;
  holidays_enabled: number;
  holidays_region: string | null;
  company_holidays_enabled: number;
  carry_over_enabled: number;
}

export interface VacayUserYear {
  user_id: number;
  plan_id: number;
  year: number;
  vacation_days: number;
  carried_over: number;
}

export interface VacayUser {
  id: number;
  username: string;
  email: string;
}

export interface VacayPlanMember {
  id: number;
  plan_id: number;
  user_id: number;
  status: string;
  created_at?: string;
}

export interface VacayInviteActionResult {
  error?: string;
  status?: number;
  code?: string;
  missing_years?: number[];
}

export interface Holiday {
  date: string;
  localName?: string;
  name?: string;
  global?: boolean;
  counties?: string[] | null;
}

export interface VacayHolidayCalendar {
  id: number;
  plan_id: number;
  region: string;
  label: string | null;
  color: string;
  sort_order: number;
}

export const VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY =
  'VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY';

export class VacayFusedCompanyHolidaysReadOnlyError extends Error {
  readonly code = VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY;

  constructor() {
    super('Company holidays are read-only while Vacay plans are fused');
    this.name = 'VacayFusedCompanyHolidaysReadOnlyError';
  }
}

export const VACAY_INVALID_YEAR = 'VACAY_INVALID_YEAR';

export class VacayInvalidYearError extends Error {
  readonly code = VACAY_INVALID_YEAR;

  constructor() {
    super('Year must be a safe integer');
    this.name = 'VacayInvalidYearError';
  }
}

export const VACAY_INVALID_DATE = 'VACAY_INVALID_DATE';

export class VacayInvalidDateError extends Error {
  readonly code = VACAY_INVALID_DATE;

  constructor() {
    super('Date must be a valid YYYY-MM-DD calendar date');
    this.name = 'VacayInvalidDateError';
  }
}

export const VACAY_FUSED_YEAR_DELETE_READ_ONLY =
  'VACAY_FUSED_YEAR_DELETE_READ_ONLY';

export class VacayFusedYearDeleteReadOnlyError extends Error {
  readonly code = VACAY_FUSED_YEAR_DELETE_READ_ONLY;

  constructor() {
    super('Years cannot be removed while Vacay plans are fused');
    this.name = 'VacayFusedYearDeleteReadOnlyError';
  }
}

export const VACAY_YEAR_DELETE_REVIEW_REQUIRED =
  'VACAY_YEAR_DELETE_REVIEW_REQUIRED';

export class VacayYearDeleteReviewRequiredError extends Error {
  readonly code = VACAY_YEAR_DELETE_REVIEW_REQUIRED;

  constructor() {
    super('This vacation year requires review before it can be removed');
    this.name = 'VacayYearDeleteReviewRequiredError';
  }
}

export const VACAY_INVITE_YEAR_REVIEW_REQUIRED =
  'VACAY_INVITE_YEAR_REVIEW_REQUIRED';

export const VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED =
  'VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED';

export const VACAY_INVITE_OWNER_REQUIRED =
  'VACAY_INVITE_OWNER_REQUIRED';

// ---------------------------------------------------------------------------
// Holiday cache (shared in-process)
// ---------------------------------------------------------------------------

const holidayCache = new Map<string, { data: unknown; time: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Color palette for auto-assign
// ---------------------------------------------------------------------------

const COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444',
  '#3b82f6', '#22c55e', '#06b6d4', '#f43f5e', '#a855f7',
  '#10b981', '#0ea5e9', '#64748b', '#be185d', '#0d9488',
];

// ---------------------------------------------------------------------------
// Plan management
// ---------------------------------------------------------------------------

export function getOwnPlan(userId: number): VacayPlan {
  let plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId) as VacayPlan | undefined;
  if (!plan) {
    db.prepare('INSERT INTO vacay_plans (owner_id) VALUES (?)').run(userId);
    plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId) as VacayPlan;
    const yr = new Date().getFullYear();
    db.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, yr);
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, plan.id, yr);
    db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, plan.id, '#6366f1');
  }
  return plan;
}

export function getActivePlan(userId: number): VacayPlan {
  const membership = db.prepare(`
    SELECT plan_id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'
  `).get(userId) as { plan_id: number } | undefined;
  if (membership) {
    return db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(membership.plan_id) as VacayPlan;
  }
  return getOwnPlan(userId);
}

export function getActivePlanId(userId: number): number {
  return getActivePlan(userId).id;
}

export function getPlanUsers(planId: number): VacayUser[] {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  if (!plan) return [];
  const owner = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(plan.owner_id) as VacayUser;
  const members = db.prepare(`
    SELECT u.id, u.username, u.email FROM vacay_plan_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'accepted'
  `).all(planId) as VacayUser[];
  return [owner, ...members];
}

function assertCompanyHolidayMutationAllowed(planId: number): void {
  if (getPlanUsers(planId).length > 1) {
    throw new VacayFusedCompanyHolidaysReadOnlyError();
  }
}

// ---------------------------------------------------------------------------
// WebSocket notifications
// ---------------------------------------------------------------------------

export function notifyPlanUsers(planId: number, excludeSid: string | undefined, event = 'vacay:update'): void {
  try {
    const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId) as { owner_id: number } | undefined;
    if (!plan) return;
    const userIds = [plan.owner_id];
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(planId) as { user_id: number }[];
    members.forEach(m => userIds.push(m.user_id));
    userIds.forEach(id => broadcastToUser(id, { type: event }, excludeSid));
  } catch { /* websocket not available */ }
}

// ---------------------------------------------------------------------------
// Holiday calendar helpers
// ---------------------------------------------------------------------------

export async function applyHolidayCalendars(planId: number): Promise<void> {
  // Provider holidays are a read-only cache overlay; refreshing must never mutate personal or manual rows.
  const plan = db.prepare('SELECT holidays_enabled FROM vacay_plans WHERE id = ?').get(planId) as { holidays_enabled: number } | undefined;
  if (!plan?.holidays_enabled) return;
  const calendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  if (calendars.length === 0) return;
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[];
  for (const cal of calendars) {
    const country = cal.region.split('-')[0];
    for (const { year } of years) {
      try {
        const cacheKey = `${year}-${country}`;
        let holidays = holidayCache.get(cacheKey)?.data as Holiday[] | undefined;
        if (!holidays) {
          const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
          holidays = await resp.json() as Holiday[];
          holidayCache.set(cacheKey, { data: holidays, time: Date.now() });
        }
      } catch { /* API error, skip */ }
    }
  }
}

export async function migrateHolidayCalendars(planId: number, plan: VacayPlan): Promise<void> {
  const existing = db.prepare('SELECT id FROM vacay_holiday_calendars WHERE plan_id = ?').get(planId);
  if (existing) return;
  if (plan.holidays_enabled && plan.holidays_region) {
    db.prepare(
      'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, NULL, ?, 0)'
    ).run(planId, plan.holidays_region, '#fecaca');
  }
}

function countDeductingEntries(userId: number, planId: number, year: number): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count
    FROM vacay_entries e
    WHERE e.user_id = ?
      AND e.plan_id = ?
      AND e.date LIKE ?
      AND NOT EXISTS (
        SELECT 1
        FROM vacay_company_holidays h
        JOIN vacay_plans p ON p.id = h.plan_id
        WHERE h.plan_id = e.plan_id
          AND h.date = e.date
          AND p.company_holidays_enabled = 1
      )
  `).get(userId, planId, `${year}-%`) as { count: number }).count;
}

function recomputeCarryForward(planId: number, sourceYear?: number): void {
  const plan = db.prepare(
    'SELECT carry_over_enabled FROM vacay_plans WHERE id = ?'
  ).get(planId) as { carry_over_enabled: number } | undefined;
  if (!plan?.carry_over_enabled) return;

  const years = db.prepare(
    'SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year'
  ).all(planId) as { year: number }[];
  const sourceIndex = sourceYear === undefined
    ? 0
    : years.findIndex(row => row.year === sourceYear);
  if (sourceIndex < 0) return;

  const users = getPlanUsers(planId);
  for (let i = sourceIndex; i < years.length - 1; i++) {
    const year = years[i].year;
    const nextYear = years[i + 1].year;
    if (nextYear !== year + 1) {
      if (sourceYear !== undefined) break;
      continue;
    }
    for (const user of users) {
      const config = db.prepare(`
        SELECT *
        FROM vacay_user_years
        WHERE user_id = ? AND plan_id = ? AND year = ?
      `).get(user.id, planId, year) as VacayUserYear | undefined;
      const carry = Math.max(
        0,
        (config?.vacation_days ?? 30)
          + (config?.carried_over ?? 0)
          - countDeductingEntries(user.id, planId, year),
      );
      db.prepare(`
        INSERT INTO vacay_user_years
          (user_id, plan_id, year, vacation_days, carried_over)
        VALUES (?, ?, ?, 30, ?)
        ON CONFLICT(user_id, plan_id, year)
        DO UPDATE SET carried_over = excluded.carried_over
      `).run(user.id, planId, nextYear, carry);
    }
  }
}

function parseCalendarEntryYear(date: unknown): number | null {
  if (typeof date !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isSafeInteger(year) || month < 1 || month > 12 || day < 1) {
    return null;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1] ? year : null;
}

function assertCalendarDate(date: unknown): asserts date is string {
  if (parseCalendarEntryYear(date) === null) {
    throw new VacayInvalidDateError();
  }
}

// ---------------------------------------------------------------------------
// Plan settings
// ---------------------------------------------------------------------------

export interface UpdatePlanBody {
  block_weekends?: boolean;
  holidays_enabled?: boolean;
  holidays_region?: string;
  company_holidays_enabled?: boolean;
  carry_over_enabled?: boolean;
  weekend_days?: string;
  week_start?: number;
}

export async function updatePlan(planId: number, body: UpdatePlanBody, socketId: string | undefined) {
  if (body.company_holidays_enabled !== undefined) {
    assertCompanyHolidayMutationAllowed(planId);
  }

  const { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled, weekend_days, week_start } = body;

  const updates: string[] = [];
  const params: (string | number)[] = [];
  if (block_weekends !== undefined) { updates.push('block_weekends = ?'); params.push(block_weekends ? 1 : 0); }
  if (holidays_enabled !== undefined) { updates.push('holidays_enabled = ?'); params.push(holidays_enabled ? 1 : 0); }
  if (holidays_region !== undefined) { updates.push('holidays_region = ?'); params.push(holidays_region); }
  if (company_holidays_enabled !== undefined) { updates.push('company_holidays_enabled = ?'); params.push(company_holidays_enabled ? 1 : 0); }
  if (carry_over_enabled !== undefined) { updates.push('carry_over_enabled = ?'); params.push(carry_over_enabled ? 1 : 0); }
  if (weekend_days !== undefined) { updates.push('weekend_days = ?'); params.push(String(weekend_days)); }
  if (week_start !== undefined) { updates.push('week_start = ?'); params.push(week_start === 0 ? 0 : 1); }

  const updatedPlan = db.transaction(() => {
    if (updates.length > 0) {
      params.push(planId);
      db.prepare(`UPDATE vacay_plans SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const current = db.prepare(
      'SELECT * FROM vacay_plans WHERE id = ?'
    ).get(planId) as VacayPlan;
    if (carry_over_enabled === false) {
      db.prepare(
        'UPDATE vacay_user_years SET carried_over = 0 WHERE plan_id = ?'
      ).run(planId);
    } else if (
      current.carry_over_enabled
      && (carry_over_enabled === true || company_holidays_enabled !== undefined)
    ) {
      recomputeCarryForward(planId);
    }
    return current;
  }).immediate();

  await migrateHolidayCalendars(planId, updatedPlan);
  await applyHolidayCalendars(planId);

  notifyPlanUsers(planId, socketId, 'vacay:settings');

  const updated = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan;
  const updatedCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(planId) as VacayHolidayCalendar[];
  return {
    plan: {
      ...updated,
      block_weekends: !!updated.block_weekends,
      holidays_enabled: !!updated.holidays_enabled,
      company_holidays_enabled: !!updated.company_holidays_enabled,
      carry_over_enabled: !!updated.carry_over_enabled,
      holiday_calendars: updatedCalendars,
    },
  };
}

// ---------------------------------------------------------------------------
// Holiday calendars CRUD
// ---------------------------------------------------------------------------

export function addHolidayCalendar(planId: number, region: string, label: string | null, color: string | undefined, sortOrder: number | undefined, socketId: string | undefined) {
  const result = db.prepare(
    'INSERT INTO vacay_holiday_calendars (plan_id, region, label, color, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(planId, region, label || null, color || '#fecaca', sortOrder ?? 0);
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(result.lastInsertRowid) as VacayHolidayCalendar;
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return cal;
}

export function updateHolidayCalendar(
  calId: number,
  planId: number,
  body: { region?: string; label?: string | null; color?: string; sort_order?: number },
  socketId: string | undefined,
): VacayHolidayCalendar | null {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId) as VacayHolidayCalendar | undefined;
  if (!cal) return null;
  const { region, label, color, sort_order } = body;
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (region !== undefined) { updates.push('region = ?'); params.push(region); }
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (color !== undefined) { updates.push('color = ?'); params.push(color); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
  if (updates.length > 0) {
    params.push(calId);
    db.prepare(`UPDATE vacay_holiday_calendars SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ?').get(calId) as VacayHolidayCalendar;
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return updated;
}

export function deleteHolidayCalendar(calId: number, planId: number, socketId: string | undefined): boolean {
  const cal = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE id = ? AND plan_id = ?').get(calId, planId);
  if (!cal) return false;
  db.prepare('DELETE FROM vacay_holiday_calendars WHERE id = ?').run(calId);
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return true;
}

// ---------------------------------------------------------------------------
// User colors
// ---------------------------------------------------------------------------

export function setUserColor(userId: number, planId: number, color: string | undefined, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, color || '#6366f1');
  notifyPlanUsers(planId, socketId, 'vacay:update');
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

type InviteDestinationPlan = Pick<VacayPlan, 'id' | 'owner_id'>;

function getInviteDestinationPlan(planId: number): InviteDestinationPlan | undefined {
  return db.prepare('SELECT id, owner_id FROM vacay_plans WHERE id = ?').get(planId) as
    | InviteDestinationPlan
    | undefined;
}

function destinationMembershipRequiresReview(plan: InviteDestinationPlan): boolean {
  const ambiguousMember = db.prepare(`
    SELECT 1
    FROM vacay_plan_members
    WHERE plan_id = ?
      AND (status IS NULL OR status NOT IN ('pending', 'accepted'))
    LIMIT 1
  `).get(plan.id);
  if (ambiguousMember) return true;

  return !!db.prepare(`
    SELECT 1
    FROM vacay_plan_members m
    LEFT JOIN vacay_plans p ON p.id = m.plan_id
    WHERE m.user_id = ?
      AND (
        p.id IS NULL
        OR m.status IS NULL
        OR m.status != 'pending'
        OR m.plan_id = ?
      )
    LIMIT 1
  `).get(plan.owner_id, plan.id);
}

function inviteeMembershipRequiresReview(
  userId: number,
  destinationPlan: InviteDestinationPlan,
  currentInviteId?: number,
): boolean {
  if (destinationPlan.owner_id === userId) return true;

  const ownPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(userId) as { id: number } | undefined;
  if (ownPlan) {
    const ownedPlanMember = db.prepare(`
      SELECT 1
      FROM vacay_plan_members
      WHERE plan_id = ?
      LIMIT 1
    `).get(ownPlan.id);
    if (ownedPlanMember) return true;
  }

  const inviteId = currentInviteId ?? null;
  return !!db.prepare(`
    SELECT 1
    FROM vacay_plan_members m
    LEFT JOIN vacay_plans p ON p.id = m.plan_id
    WHERE m.user_id = ?
      AND (? IS NULL OR m.id != ?)
      AND (
        p.id IS NULL
        OR m.status IS NULL
        OR m.status != 'pending'
      )
    LIMIT 1
  `).get(userId, inviteId, inviteId);
}

function inviteMembershipRequiresReview(userId: number, planId: number, currentInviteId?: number): boolean {
  const destinationPlan = getInviteDestinationPlan(planId);
  return (
    !destinationPlan
    || destinationMembershipRequiresReview(destinationPlan)
    || inviteeMembershipRequiresReview(userId, destinationPlan, currentInviteId)
  );
}

function membershipReviewResult(message: string): VacayInviteActionResult {
  return {
    error: message,
    status: 409,
    code: VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED,
  };
}

export function sendInvite(planId: number, inviterId: number, inviterUsername: string, inviterEmail: string, targetUserId: number): VacayInviteActionResult {
  if (targetUserId === inviterId) return { error: 'Cannot invite yourself', status: 400 };

  if (!getInviteDestinationPlan(planId)) {
    return { error: 'Vacation plan not found', status: 404 };
  }

  const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId);
  if (!targetUser) return { error: 'User not found', status: 404 };

  const existing = db.prepare('SELECT id, status FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').get(planId, targetUserId) as { id: number; status: string } | undefined;
  if (existing) {
    if (existing.status === 'accepted') return { error: 'Already fused', status: 400 };
    if (existing.status === 'pending') return { error: 'Invite already pending', status: 400 };
  }

  const targetFusion = db.prepare("SELECT id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'").get(targetUserId);
  if (targetFusion) {
    return membershipReviewResult('Vacation plan memberships require review before this invitation can be sent');
  }

  if (inviteMembershipRequiresReview(targetUserId, planId)) {
    return membershipReviewResult('Vacation plan memberships require review before this invitation can be sent');
  }

  db.prepare('INSERT INTO vacay_plan_members (plan_id, user_id, status) VALUES (?, ?, ?)').run(planId, targetUserId, 'pending');

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(targetUserId, {
      type: 'vacay:invite',
      from: { id: inviterId, username: inviterUsername },
      planId,
    });
  } catch { /* websocket not available */ }

  // Notify invited user
  import('../services/notificationService').then(({ send }) => {
    send({ event: 'vacay_invite', actorId: inviterId, scope: 'user', targetId: targetUserId, params: { actor: inviterEmail, planId: String(planId) } }).catch(() => {});
  });

  return {};
}

export function acceptInvite(userId: number, planId: number, socketId: string | undefined): VacayInviteActionResult {
  const outcome = db.transaction((): { accepted: boolean; result: VacayInviteActionResult } => {
    const invite = db.prepare("SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").get(planId, userId) as VacayPlanMember | undefined;
    if (!invite) {
      return { accepted: false, result: { error: 'No pending invite', status: 404 } };
    }

    if (inviteMembershipRequiresReview(userId, planId, invite.id)) {
      return {
        accepted: false,
        result: membershipReviewResult(
          'Vacation plan memberships require review before this invitation can be accepted',
        ),
      };
    }

    // Migrate data from user's own plan only when every referenced year already
    // exists in the destination plan. Accepting an invite must not silently
    // change the destination owner's year policy.
    const ownPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(userId) as { id: number } | undefined;
    let ownYears: VacayUserYear[] = [];
    if (ownPlan && ownPlan.id !== planId) {
      ownYears = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ?').all(userId, ownPlan.id) as VacayUserYear[];
      const requiredYears = new Set(ownYears.map(year => year.year));
      const ownEntryDates = db.prepare(
        'SELECT date FROM vacay_entries WHERE plan_id = ? AND user_id = ?',
      ).all(ownPlan.id, userId) as { date: string }[];
      for (const entry of ownEntryDates) {
        const entryYear = parseCalendarEntryYear(entry.date);
        if (entryYear === null) {
          return {
            accepted: false,
            result: {
              error: 'Vacation entry dates require review before this invitation can be accepted',
              status: 409,
              code: VACAY_INVITE_YEAR_REVIEW_REQUIRED,
            },
          };
        }
        requiredYears.add(entryYear);
      }

      const targetYearSet = new Set(
        (db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[])
          .map(year => year.year),
      );
      const missingYears = [...requiredYears]
        .filter(year => !targetYearSet.has(year))
        .sort((a, b) => a - b);
      if (missingYears.length > 0) {
        const label = missingYears.length === 1 ? 'year' : 'years';
        return {
          accepted: false,
          result: {
            error: `Ask the owner to add vacation ${label} ${missingYears.join(', ')}, then try again.`,
            status: 409,
            code: VACAY_INVITE_YEAR_REVIEW_REQUIRED,
            missing_years: missingYears,
          },
        };
      }
    }

    db.prepare("UPDATE vacay_plan_members SET status = 'accepted' WHERE id = ?").run(invite.id);

    if (ownPlan && ownPlan.id !== planId) {
      db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(planId, ownPlan.id, userId);
      for (const y of ownYears) {
        db.prepare(`
          INSERT INTO vacay_user_years
            (user_id, plan_id, year, vacation_days, carried_over)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, plan_id, year)
          DO UPDATE SET
            vacation_days = excluded.vacation_days,
            carried_over = excluded.carried_over
        `).run(userId, planId, y.year, y.vacation_days, y.carried_over);
      }
      const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, ownPlan.id) as { color: string } | undefined;
      if (colorRow) {
        db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, planId, colorRow.color);
      }
    }

    // Auto-assign unique color
    const existingColors = (db.prepare('SELECT color FROM vacay_user_colors WHERE plan_id = ? AND user_id != ?').all(planId, userId) as { color: string }[]).map(r => r.color);
    const myColor = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(userId, planId) as { color: string } | undefined;
    const effectiveColor = myColor?.color || '#6366f1';
    if (existingColors.includes(effectiveColor)) {
      const available = COLORS.find(c => !existingColors.includes(c));
      if (available) {
        db.prepare(`INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
          ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color`).run(userId, planId, available);
      }
    } else if (!myColor) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(userId, planId, effectiveColor);
    }

    // Ensure user has rows for all plan years
    const targetYears = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId) as { year: number }[];
    const sourceYearSet = new Set(ownYears.map(year => year.year));
    for (const y of targetYears) {
      if (ownPlan && ownPlan.id !== planId && !sourceYearSet.has(y.year)) {
        db.prepare(`
          INSERT INTO vacay_user_years
            (user_id, plan_id, year, vacation_days, carried_over)
          VALUES (?, ?, ?, 30, 0)
          ON CONFLICT(user_id, plan_id, year)
          DO UPDATE SET
            vacation_days = excluded.vacation_days,
            carried_over = excluded.carried_over
        `).run(userId, planId, y.year);
      } else {
        db.prepare(`
          INSERT OR IGNORE INTO vacay_user_years
            (user_id, plan_id, year, vacation_days, carried_over)
          VALUES (?, ?, ?, 30, 0)
        `).run(userId, planId, y.year);
      }
    }

    return { accepted: true, result: {} };
  }).immediate();

  if (outcome.accepted) {
    notifyPlanUsers(planId, socketId, 'vacay:accepted');
  }
  return outcome.result;
}

export function declineInvite(userId: number, planId: number, socketId: string | undefined): boolean {
  const result = db.prepare(
    "DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'"
  ).run(planId, userId);
  if (result.changes !== 1) return false;

  notifyPlanUsers(planId, socketId, 'vacay:declined');
  try {
    broadcastToUser(userId, { type: 'vacay:declined' }, socketId);
  } catch {
    /* websocket not available */
  }
  return true;
}

export function cancelInvite(actorUserId: number, targetUserId: number): VacayInviteActionResult {
  const outcome = db.transaction((): {
    changed: boolean;
    result: VacayInviteActionResult;
  } => {
    const acceptedMemberships = db.prepare(`
      SELECT m.plan_id, p.id AS existing_plan_id, p.owner_id
      FROM vacay_plan_members m
      LEFT JOIN vacay_plans p ON p.id = m.plan_id
      WHERE m.user_id = ? AND m.status = 'accepted'
      ORDER BY m.id
    `).all(actorUserId) as {
      plan_id: number;
      existing_plan_id: number | null;
      owner_id: number | null;
    }[];
    if (
      acceptedMemberships.length > 1
      || acceptedMemberships.some(membership =>
        membership.existing_plan_id === null
        || membership.owner_id === actorUserId
      )
    ) {
      return {
        changed: false,
        result: membershipReviewResult(
          'Vacation plan memberships require review before invitations can be cancelled',
        ),
      };
    }
    if (acceptedMemberships.length === 1) {
      return {
        changed: false,
        result: {
          error: 'Only the vacation plan owner can cancel invitations',
          status: 403,
          code: VACAY_INVITE_OWNER_REQUIRED,
        },
      };
    }

    const plan = getOwnPlan(actorUserId);
    const result = db.prepare(
      "DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'"
    ).run(plan.id, targetUserId);
    return {
      changed: result.changes === 1,
      result: {},
    };
  }).immediate();

  if (outcome.changed) {
    try {
      broadcastToUser(targetUserId, { type: 'vacay:cancelled' });
    } catch { /* */ }
  }
  return outcome.result;
}

// ---------------------------------------------------------------------------
// Plan dissolution
// ---------------------------------------------------------------------------

function returnUserDataToOwnPlan(
  userId: number,
  sharedPlanId: number,
  companyHolidays: { date: string; note: string }[],
): void {
  const ownPlan = getOwnPlan(userId);
  if (ownPlan.id === sharedPlanId) return;

  db.prepare(
    'UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?',
  ).run(ownPlan.id, sharedPlanId, userId);
  for (const holiday of companyHolidays) {
    db.prepare(`
      INSERT OR IGNORE INTO vacay_company_holidays (plan_id, date, note)
      VALUES (?, ?, ?)
    `).run(ownPlan.id, holiday.date, holiday.note);
  }

  const userYears = db.prepare(`
    SELECT year, vacation_days, carried_over
    FROM vacay_user_years
    WHERE user_id = ? AND plan_id = ?
  `).all(userId, sharedPlanId) as Pick<
    VacayUserYear,
    'year' | 'vacation_days' | 'carried_over'
  >[];
  for (const userYear of userYears) {
    db.prepare(`
      INSERT OR IGNORE INTO vacay_years (plan_id, year)
      VALUES (?, ?)
    `).run(ownPlan.id, userYear.year);
    db.prepare(`
      INSERT INTO vacay_user_years
        (user_id, plan_id, year, vacation_days, carried_over)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, plan_id, year)
      DO UPDATE SET
        vacation_days = excluded.vacation_days,
        carried_over = excluded.carried_over
    `).run(
      userId,
      ownPlan.id,
      userYear.year,
      userYear.vacation_days,
      userYear.carried_over,
    );
  }
  db.prepare(`
    DELETE FROM vacay_user_years
    WHERE user_id = ? AND plan_id = ?
  `).run(userId, sharedPlanId);
}

export function dissolvePlan(userId: number, socketId: string | undefined): void {
  const allUserIds = db.transaction(() => {
    const plan = getActivePlan(userId);
    const isOwnerFlag = plan.owner_id === userId;
    const planUserIds = getPlanUsers(plan.id).map(user => user.id);
    const companyHolidays = db.prepare(`
      SELECT date, note
      FROM vacay_company_holidays
      WHERE plan_id = ?
    `).all(plan.id) as { date: string; note: string }[];

    if (isOwnerFlag) {
      const members = db.prepare(`
        SELECT user_id
        FROM vacay_plan_members
        WHERE plan_id = ? AND status = 'accepted'
      `).all(plan.id) as { user_id: number }[];
      for (const member of members) {
        returnUserDataToOwnPlan(member.user_id, plan.id, companyHolidays);
      }
      db.prepare('DELETE FROM vacay_plan_members WHERE plan_id = ?').run(plan.id);
    } else {
      returnUserDataToOwnPlan(userId, plan.id, companyHolidays);
      db.prepare(`
        DELETE FROM vacay_plan_members
        WHERE plan_id = ? AND user_id = ?
      `).run(plan.id, userId);
    }

    return planUserIds;
  }).immediate();

  try {
    allUserIds.filter(id => id !== userId).forEach(id => broadcastToUser(id, { type: 'vacay:dissolved' }));
  } catch { /* */ }
}

// ---------------------------------------------------------------------------
// Available users
// ---------------------------------------------------------------------------

export function getAvailableUsers(userId: number, planId: number) {
  const destinationPlan = getInviteDestinationPlan(planId);
  if (!destinationPlan || destinationMembershipRequiresReview(destinationPlan)) {
    return [];
  }

  const candidates = db.prepare(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE u.id != ?
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE plan_id = ?)
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE status = 'accepted')
    AND u.id NOT IN (SELECT owner_id FROM vacay_plans WHERE id IN (
      SELECT plan_id FROM vacay_plan_members WHERE status = 'accepted'
    ))
    ORDER BY u.username
  `).all(userId, planId) as VacayUser[];

  return candidates.filter(candidate => !inviteeMembershipRequiresReview(candidate.id, destinationPlan));
}

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

export function listYears(planId: number): number[] {
  const rows = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId) as { year: number }[];
  return rows.map(y => y.year);
}

function assertSafeYear(year: number): void {
  if (!Number.isSafeInteger(year)) {
    throw new VacayInvalidYearError();
  }
}

export function addYear(planId: number, year: number, socketId: string | undefined): number[] {
  assertSafeYear(year);
  try {
    db.prepare('INSERT INTO vacay_years (plan_id, year) VALUES (?, ?)').run(planId, year);
    const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
    const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
    const users = getPlanUsers(planId);
    for (const u of users) {
      let carriedOver = 0;
      if (carryOverEnabled) {
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year - 1) as VacayUserYear | undefined;
        if (prevConfig) {
          const used = countDeductingEntries(u.id, planId, year - 1);
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carriedOver = Math.max(0, total - used);
        }
      }
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)').run(u.id, planId, year, carriedOver);
    }
  } catch { /* year already exists */ }
  notifyPlanUsers(planId, socketId, 'vacay:settings');
  return listYears(planId);
}

export function deleteActiveYear(userId: number, year: number, socketId: string | undefined): number[] {
  assertSafeYear(year);
  const result = db.transaction((): { planId: number | null; years: number[]; changed: boolean } => {
    const acceptedMemberships = db.prepare(`
      SELECT plan_id
      FROM vacay_plan_members
      WHERE user_id = ? AND status = 'accepted'
    `).all(userId) as { plan_id: number }[];
    const acceptedPlans = db.prepare(`
      SELECT p.*
      FROM vacay_plan_members m
      JOIN vacay_plans p ON p.id = m.plan_id
      WHERE m.user_id = ? AND m.status = 'accepted'
      ORDER BY m.id
    `).all(userId) as VacayPlan[];
    const unknownMembership = db.prepare(`
      SELECT id
      FROM vacay_plan_members
      WHERE user_id = ?
        AND (status IS NULL OR status NOT IN ('pending', 'accepted'))
      LIMIT 1
    `).get(userId);
    const danglingMembership = db.prepare(`
      SELECT m.id
      FROM vacay_plan_members m
      LEFT JOIN vacay_plans p ON p.id = m.plan_id
      WHERE m.user_id = ? AND p.id IS NULL
      LIMIT 1
    `).get(userId);
    if (
      acceptedMemberships.length > 1
      || acceptedPlans.length !== acceptedMemberships.length
      || unknownMembership
      || danglingMembership
    ) {
      throw new VacayYearDeleteReviewRequiredError();
    }

    const plan = acceptedPlans[0]
      ?? db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId) as VacayPlan | undefined;
    if (!plan) {
      return { planId: null, years: [], changed: false };
    }

    const memberships = db.prepare(`
      SELECT user_id, status
      FROM vacay_plan_members
      WHERE plan_id = ?
    `).all(plan.id) as { user_id: number; status: string }[];
    const acceptedMembers = memberships.filter(member => member.status === 'accepted');
    if (plan.owner_id !== userId || acceptedMembers.length > 0) {
      throw new VacayFusedYearDeleteReadOnlyError();
    }
    if (memberships.some(member => member.status !== 'pending')) {
      throw new VacayYearDeleteReviewRequiredError();
    }

    const yearRow = db.prepare(
      'SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?'
    ).get(plan.id, year);
    const dependentRow = db.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM vacay_entries
        WHERE plan_id = ? AND date LIKE ?
      )
      OR EXISTS (
        SELECT 1 FROM vacay_company_holidays
        WHERE plan_id = ? AND date LIKE ?
      )
      OR EXISTS (
        SELECT 1 FROM vacay_user_years
        WHERE plan_id = ? AND year = ?
      )
    `).get(
      plan.id, `${year}-%`,
      plan.id, `${year}-%`,
      plan.id, year,
    );
    if (!yearRow) {
      if (dependentRow) {
        throw new VacayYearDeleteReviewRequiredError();
      }
      return { planId: plan.id, years: listYears(plan.id), changed: false };
    }

    const hasOutgoingInvite = memberships.some(member => member.status === 'pending');
    const foreignTargetRow = db.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM vacay_entries
        WHERE plan_id = ? AND date LIKE ? AND user_id != ?
      )
      OR EXISTS (
        SELECT 1 FROM vacay_user_years
        WHERE plan_id = ? AND year = ? AND user_id != ?
      )
    `).get(
      plan.id, `${year}-%`, userId,
      plan.id, year, userId,
    );
    if (hasOutgoingInvite || foreignTargetRow) {
      throw new VacayYearDeleteReviewRequiredError();
    }

    db.prepare('DELETE FROM vacay_years WHERE plan_id = ? AND year = ?').run(plan.id, year);
    db.prepare("DELETE FROM vacay_entries WHERE plan_id = ? AND date LIKE ?").run(plan.id, `${year}-%`);
    db.prepare("DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").run(plan.id, `${year}-%`);
    db.prepare('DELETE FROM vacay_user_years WHERE plan_id = ? AND year = ?').run(plan.id, year);

    // Carry is a chain: changing the first successor changes every contiguous
    // successor after it. Recompute the chain in-order inside this transaction.
    const carryOverEnabled = !!plan.carry_over_enabled;
    const users = getPlanUsers(plan.id);
    let carryYear = year;
    while (carryYear < Number.MAX_SAFE_INTEGER) {
      carryYear += 1;
      const carryYearExists = db.prepare(
        'SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?'
      ).get(plan.id, carryYear);
      if (!carryYearExists) break;

      const prevYear = db.prepare(`
        SELECT year
        FROM vacay_years
        WHERE plan_id = ? AND year < ?
        ORDER BY year DESC
        LIMIT 1
      `).get(plan.id, carryYear) as { year: number } | undefined;

      for (const user of users) {
        let carry = 0;
        if (carryOverEnabled && prevYear) {
          const prevConfig = db.prepare(`
            SELECT *
            FROM vacay_user_years
            WHERE user_id = ? AND plan_id = ? AND year = ?
          `).get(user.id, plan.id, prevYear.year) as VacayUserYear | undefined;
          if (prevConfig) {
            const used = countDeductingEntries(user.id, plan.id, prevYear.year);
            const total = prevConfig.vacation_days + prevConfig.carried_over;
            carry = Math.max(0, total - used);
          }
        }
        db.prepare(`
          UPDATE vacay_user_years
          SET carried_over = ?
          WHERE user_id = ? AND plan_id = ? AND year = ?
        `).run(carry, user.id, plan.id, carryYear);
      }
    }

    return { planId: plan.id, years: listYears(plan.id), changed: true };
  }).immediate();

  if (result.changed && result.planId !== null) {
    notifyPlanUsers(result.planId, socketId, 'vacay:settings');
  }
  return result.years;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export function getEntries(planId: number, year: string) {
  const entries = db.prepare(`
    SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
    FROM vacay_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = e.plan_id
    WHERE e.plan_id = ? AND e.date LIKE ?
  `).all(planId, `${year}-%`);
  const companyHolidays = db.prepare("SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").all(planId, `${year}-%`);
  return { entries, companyHolidays };
}

export function toggleEntry(userId: number, planId: number, date: string, socketId: string | undefined): { action: string } {
  assertCalendarDate(date);

  const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND date = ? AND plan_id = ?').get(userId, date, planId) as { id: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, socketId);
    return { action: 'removed' };
  } else {
    db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(planId, userId, date, '');
    notifyPlanUsers(planId, socketId);
    return { action: 'added' };
  }
}

export function toggleCompanyHoliday(planId: number, date: string, note: string | undefined, socketId: string | undefined): { action: string } {
  const result = db.transaction((): { action: string } => {
    assertCompanyHolidayMutationAllowed(planId);
    assertCalendarDate(date);

    const existing = db.prepare(
      'SELECT id FROM vacay_company_holidays WHERE plan_id = ? AND date = ?'
    ).get(planId, date) as { id: number } | undefined;
    const action = existing ? 'removed' : 'added';
    if (existing) {
      db.prepare('DELETE FROM vacay_company_holidays WHERE id = ?').run(existing.id);
    } else {
      db.prepare(
        'INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)'
      ).run(planId, date, note || '');
    }

    recomputeCarryForward(planId, parseCalendarEntryYear(date)!);
    return { action };
  }).immediate();

  notifyPlanUsers(planId, socketId);
  return result;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStats(planId: number, year: number) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId) as VacayPlan | undefined;
  const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
  const users = getPlanUsers(planId);
  const yearExists = db.prepare(
    'SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?'
  ).get(planId, year);

  return users.map(u => {
    const used = countDeductingEntries(u.id, planId, year);
    const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year) as VacayUserYear | undefined;
    const vacationDays = config ? config.vacation_days : 30;
    const carriedOver = carryOverEnabled ? (config ? config.carried_over : 0) : 0;
    const total = vacationDays + carriedOver;
    const remaining = total - used;
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, planId) as { color: string } | undefined;

    const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
    if (yearExists && nextYearExists && carryOverEnabled) {
      const carry = Math.max(0, remaining);
      db.prepare(`
        INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
        ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
      `).run(u.id, planId, year + 1, carry, carry);
    }

    return {
      user_id: u.id, person_name: u.username, person_color: colorRow?.color || '#6366f1',
      year, vacation_days: vacationDays, carried_over: carriedOver,
      total_available: total, used, remaining,
    };
  });
}

export function updateStats(userId: number, planId: number, year: number, vacationDays: number, socketId: string | undefined): void {
  db.prepare(`
    INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id, plan_id, year) DO UPDATE SET vacation_days = excluded.vacation_days
  `).run(userId, planId, year, vacationDays);
  notifyPlanUsers(planId, socketId);
}

// ---------------------------------------------------------------------------
// GET /plan composite
// ---------------------------------------------------------------------------

export function getPlanData(userId: number) {
  const plan = getActivePlan(userId);
  const activePlanId = plan.id;

  const users = getPlanUsers(activePlanId).map(u => {
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, activePlanId) as { color: string } | undefined;
    return { ...u, color: colorRow?.color || '#6366f1' };
  });

  const pendingInvites = db.prepare(`
    SELECT m.id, m.user_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'pending'
  `).all(activePlanId);

  const incomingInvites = db.prepare(`
    SELECT m.id, m.plan_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m
    JOIN vacay_plans p ON m.plan_id = p.id
    JOIN users u ON p.owner_id = u.id
    WHERE m.user_id = ? AND m.status = 'pending'
  `).all(userId);

  const holidayCalendars = db.prepare('SELECT * FROM vacay_holiday_calendars WHERE plan_id = ? ORDER BY sort_order, id').all(activePlanId) as VacayHolidayCalendar[];

  return {
    plan: {
      ...plan,
      block_weekends: !!plan.block_weekends,
      holidays_enabled: !!plan.holidays_enabled,
      company_holidays_enabled: !!plan.company_holidays_enabled,
      carry_over_enabled: !!plan.carry_over_enabled,
      holiday_calendars: holidayCalendars,
    },
    users,
    pendingInvites,
    incomingInvites,
    isOwner: plan.owner_id === userId,
    isFused: users.length > 1,
  };
}

// ---------------------------------------------------------------------------
// Holidays (nager.at proxy with cache)
// ---------------------------------------------------------------------------

export async function getCountries(): Promise<{ data?: unknown; error?: string }> {
  const cacheKey = 'countries';
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { data: cached.data };
  try {
    const resp = await fetch('https://date.nager.at/api/v3/AvailableCountries');
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    return { data };
  } catch {
    return { error: 'Failed to fetch countries' };
  }
}

export async function getHolidays(year: string, country: string): Promise<{ data?: unknown; error?: string }> {
  const cacheKey = `${year}-${country}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return { data: cached.data };
  try {
    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    return { data };
  } catch {
    return { error: 'Failed to fetch holidays' };
  }
}
