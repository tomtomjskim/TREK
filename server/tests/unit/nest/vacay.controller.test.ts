import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { VacayController } from '../../../src/nest/vacay/vacay.controller';
import { VacayInvalidDateError } from '../../../src/services/vacayService';
import type { VacayService } from '../../../src/nest/vacay/vacay.service';
import type { User } from '../../../src/types';

const user = { id: 1, username: 'u', email: 'u@example.test', role: 'user' } as User;

function makeController(svc: Partial<VacayService>) {
  return new VacayController(svc as VacayService);
}

async function thrown(fn: () => unknown): Promise<{ status: number; body: unknown }> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected the handler to throw');
}

// Default plan helpers shared by most handlers.
const planBase = { getActivePlanId: vi.fn().mockReturnValue(10), getActivePlan: vi.fn().mockReturnValue({ id: 10 }) };

describe('VacayController (parity with the legacy /api/addons/vacay route)', () => {
  it('GET /plan delegates getPlanData', () => {
    const getPlanData = vi.fn().mockReturnValue({ plan: { id: 10 } });
    expect(makeController({ getPlanData }).getPlan(user)).toEqual({ plan: { id: 10 } });
  });

  it('PUT /plan forwards the socket id', async () => {
    const updatePlan = vi.fn().mockResolvedValue({ ok: true });
    await makeController({ ...planBase, updatePlan }).updatePlan(user, { foo: 1 }, 'sock-1');
    expect(updatePlan).toHaveBeenCalledWith(10, { foo: 1 }, 'sock-1');
  });

  describe('holiday calendars', () => {
    it('400 when region missing', () => {
      return thrown(() => makeController({ ...planBase }).addHolidayCalendar(user, {})).then((r) =>
        expect(r).toEqual({ status: 400, body: { error: 'region required' } }));
    });

    it('creates a calendar', () => {
      const addHolidayCalendar = vi.fn().mockReturnValue({ id: 1, region: 'DE-BY' });
      const res = makeController({ ...planBase, addHolidayCalendar }).addHolidayCalendar(user, { region: 'DE-BY', label: 'Bayern' }, 'sock');
      expect(res).toEqual({ calendar: { id: 1, region: 'DE-BY' } });
      expect(addHolidayCalendar).toHaveBeenCalledWith(10, 'DE-BY', 'Bayern', undefined, undefined, 'sock');
    });

    it('404 on update of a missing calendar', () => {
      const updateHolidayCalendar = vi.fn().mockReturnValue(null);
      return thrown(() => makeController({ ...planBase, updateHolidayCalendar }).updateHolidayCalendar(user, '9', {})).then((r) =>
        expect(r).toEqual({ status: 404, body: { error: 'Calendar not found' } }));
    });

    it('404 on delete of a missing calendar', () => {
      const deleteHolidayCalendar = vi.fn().mockReturnValue(false);
      return thrown(() => makeController({ ...planBase, deleteHolidayCalendar }).deleteHolidayCalendar(user, '9')).then((r) =>
        expect(r).toEqual({ status: 404, body: { error: 'Calendar not found' } }));
    });
  });

  describe('color', () => {
    it('403 when the target user is not in the plan', () => {
      const getPlanUsers = vi.fn().mockReturnValue([{ id: 1 }]);
      return thrown(() => makeController({ ...planBase, getPlanUsers }).setColor(user, { color: '#fff', target_user_id: 99 })).then((r) =>
        expect(r).toEqual({ status: 403, body: { error: 'User not in plan' } }));
    });

    it('sets the colour for an in-plan user', () => {
      const getPlanUsers = vi.fn().mockReturnValue([{ id: 1 }]);
      const setUserColor = vi.fn();
      expect(makeController({ ...planBase, getPlanUsers, setUserColor }).setColor(user, { color: '#fff' }, 'sock')).toEqual({ success: true });
      expect(setUserColor).toHaveBeenCalledWith(1, 10, '#fff', 'sock');
    });
  });

  describe('invites', () => {
    it('400 when user_id missing', () => {
      return thrown(() => makeController({ ...planBase }).invite(user, undefined)).then((r) =>
        expect(r).toEqual({
          status: 400,
          body: {
            error: 'user_id required',
            code: 'VACAY_INVALID_ID',
          },
        }));
    });

    it('maps a sendInvite error to its status', () => {
      const sendInvite = vi.fn().mockReturnValue({
        error: 'Membership review required',
        status: 409,
        code: 'VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED',
      });
      return thrown(() => makeController({ ...planBase, sendInvite }).invite(user, 2)).then((r) =>
        expect(r).toEqual({
          status: 409,
          body: {
            error: 'Membership review required',
            code: 'VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED',
          },
        }));
    });

    it('sends an invite', () => {
      const sendInvite = vi.fn().mockReturnValue({});
      expect(makeController({ ...planBase, sendInvite }).invite(user, 2)).toEqual({ success: true });
      expect(sendInvite).toHaveBeenCalledWith(10, 1, 'u', 'u@example.test', 2);
    });

    it('normalizes canonical numeric-string identifiers for every invite route', () => {
      const sendInvite = vi.fn().mockReturnValue({});
      const acceptInvite = vi.fn().mockReturnValue({});
      const declineInvite = vi.fn();
      const cancelInvite = vi.fn().mockReturnValue({});
      const controller = makeController({
        ...planBase,
        sendInvite,
        acceptInvite,
        declineInvite,
        cancelInvite,
      });

      expect(controller.invite(user, '2')).toEqual({ success: true });
      expect(controller.acceptInvite(user, '5')).toEqual({ success: true });
      expect(controller.declineInvite(user, '6')).toEqual({ success: true });
      expect(controller.cancelInvite(user, '7')).toEqual({ success: true });
      expect(sendInvite).toHaveBeenCalledWith(10, 1, 'u', 'u@example.test', 2);
      expect(acceptInvite).toHaveBeenCalledWith(1, 5, undefined);
      expect(declineInvite).toHaveBeenCalledWith(1, 6, undefined);
      expect(cancelInvite).toHaveBeenCalledWith(1, 7);
    });

    it.each([['01'], ['1junk'], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])(
      'rejects a non-canonical invite user_id %j',
      async (invalidId) => {
        const result = await thrown(() =>
          makeController({ ...planBase, sendInvite: vi.fn().mockReturnValue({}) }).invite(user, invalidId),
        );

        expect(result).toEqual({
          status: 400,
          body: {
            error: 'user_id must be a canonical positive safe integer',
            code: 'VACAY_INVALID_ID',
          },
        });
      },
    );

    it.each([[undefined], ['01'], ['5junk'], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])(
      'rejects an invalid invite plan_id %j before the service call',
      async (invalidId) => {
        const acceptInvite = vi.fn().mockReturnValue({});
        const result = await thrown(() => makeController({ acceptInvite }).acceptInvite(user, invalidId));

        expect(result.status).toBe(400);
        expect(result.body).toMatchObject({ code: 'VACAY_INVALID_ID' });
        expect(acceptInvite).not.toHaveBeenCalled();
      },
    );

    it('maps an acceptInvite error', () => {
      const acceptInvite = vi.fn().mockReturnValue({ error: 'Invite not found', status: 404 });
      return thrown(() => makeController({ acceptInvite }).acceptInvite(user, 5)).then((r) =>
        expect(r).toEqual({ status: 404, body: { error: 'Invite not found' } }));
    });

    it('maps invite year review details without changing legacy errors', () => {
      const acceptInvite = vi.fn().mockReturnValue({
        error: 'Vacation plan years must be reconciled',
        status: 409,
        code: 'VACAY_INVITE_YEAR_REVIEW_REQUIRED',
        missing_years: [2031, 2032],
      });
      return thrown(() => makeController({ acceptInvite }).acceptInvite(user, 5)).then((r) =>
        expect(r).toEqual({
          status: 409,
          body: {
            error: 'Vacation plan years must be reconciled',
            code: 'VACAY_INVITE_YEAR_REVIEW_REQUIRED',
            missing_years: [2031, 2032],
          },
        }));
    });

    it('decline / cancel / dissolve return success', () => {
      const declineInvite = vi.fn(); const cancelInvite = vi.fn().mockReturnValue({}); const dissolvePlan = vi.fn();
      expect(makeController({ declineInvite }).declineInvite(user, 5)).toEqual({ success: true });
      expect(makeController({ ...planBase, cancelInvite }).cancelInvite(user, 2)).toEqual({ success: true });
      expect(makeController({ dissolvePlan }).dissolve(user)).toEqual({ success: true });
    });

    it('maps a non-owner invite cancellation to a stable 403', () => {
      const cancelInvite = vi.fn().mockReturnValue({
        error: 'Only the vacation plan owner can cancel invitations',
        status: 403,
        code: 'VACAY_INVITE_OWNER_REQUIRED',
      });

      return thrown(() => makeController({ cancelInvite }).cancelInvite(user, 2)).then((r) =>
        expect(r).toEqual({
          status: 403,
          body: {
            error: 'Only the vacation plan owner can cancel invitations',
            code: 'VACAY_INVITE_OWNER_REQUIRED',
          },
        }));
    });
  });

  describe('years', () => {
    it('rejects missing and non-safe-integer years on add with the stable invalid-year code', async () => {
      const controller = makeController({ ...planBase });

      for (const invalidYear of [undefined, 2026.5, Number.MAX_SAFE_INTEGER + 1]) {
        const result = await thrown(() => controller.addYear(user, invalidYear));
        expect(result).toEqual({
          status: 400,
          body: {
            error: 'Year must be a safe integer',
            code: 'VACAY_INVALID_YEAR',
          },
        });
      }
    });

    it('adds years and forwards the actor to the active-year delete command', () => {
      const addYear = vi.fn().mockReturnValue([2026]); const deleteActiveYear = vi.fn().mockReturnValue([]);
      expect(makeController({ ...planBase, addYear }).addYear(user, 2026, 'sock')).toEqual({ years: [2026] });
      expect(makeController({ ...planBase, deleteActiveYear }).deleteYear(user, '2026', 'sock')).toEqual({ years: [] });
      expect(deleteActiveYear).toHaveBeenCalledWith(user.id, 2026, 'sock');
    });

    it('rejects a non-canonical year instead of parseInt-truncating it', () => {
      return thrown(() => makeController({}).deleteYear(user, '2026junk')).then((r) =>
        expect(r).toEqual({
          status: 400,
          body: {
            error: 'Year must be a canonical safe integer',
            code: 'VACAY_INVALID_YEAR',
          },
        }));
    });
  });

  describe('entries', () => {
    it('400 when date missing on toggle', () => {
      return thrown(() => makeController({ ...planBase }).toggleEntry(user, {})).then((r) =>
        expect(r).toEqual({ status: 400, body: { error: 'date required' } }));
    });

    it('403 when toggling for a user not in the plan', () => {
      const getPlanUsers = vi.fn().mockReturnValue([{ id: 1 }]);
      return thrown(() => makeController({ ...planBase, getPlanUsers }).toggleEntry(user, { date: '2026-07-01', target_user_id: 99 })).then((r) =>
        expect(r).toEqual({ status: 403, body: { error: 'User not in plan' } }));
    });

    it('toggles for the caller', () => {
      const toggleEntry = vi.fn().mockReturnValue({ action: 'added' });
      expect(makeController({ ...planBase, toggleEntry }).toggleEntry(user, { date: '2026-07-01' }, 'sock')).toEqual({ action: 'added' });
      expect(toggleEntry).toHaveBeenCalledWith(1, 10, '2026-07-01', 'sock');
    });

    it.each(['toggleEntry', 'companyHoliday'] as const)(
      'maps an invalid date from %s to a stable 400',
      async (method) => {
        const serviceMethod = vi.fn(() => {
          throw new VacayInvalidDateError();
        });
        const controller = makeController({
          ...planBase,
          [method === 'toggleEntry' ? 'toggleEntry' : 'toggleCompanyHoliday']: serviceMethod,
        });

        const result = await thrown(() => method === 'toggleEntry'
          ? controller.toggleEntry(user, { date: '2026-02-30' })
          : controller.companyHoliday(user, { date: '2026-02-30' }));

        expect(result).toEqual({
          status: 400,
          body: {
            error: 'Date must be a valid YYYY-MM-DD calendar date',
            code: 'VACAY_INVALID_DATE',
          },
        });
      },
    );
  });

  describe('stats', () => {
    it('GET wraps stats', () => {
      const getStats = vi.fn().mockReturnValue({ used: 5 });
      expect(makeController({ ...planBase, getStats }).stats(user, '2026')).toEqual({ stats: { used: 5 } });
    });

    it('403 on updateStats for a user not in the plan', () => {
      const getPlanUsers = vi.fn().mockReturnValue([{ id: 1 }]);
      return thrown(() => makeController({ ...planBase, getPlanUsers }).updateStats(user, '2026', { vacation_days: 30, target_user_id: 99 })).then((r) =>
        expect(r).toEqual({ status: 403, body: { error: 'User not in plan' } }));
    });
  });

  describe('public holidays', () => {
    it('502 when the upstream country lookup fails', () => {
      const getCountries = vi.fn().mockResolvedValue({ error: 'upstream down' });
      return thrown(() => makeController({ getCountries }).holidayCountries()).then((r) =>
        expect(r).toEqual({ status: 502, body: { error: 'upstream down' } }));
    });

    it('returns the country data on success', async () => {
      const getCountries = vi.fn().mockResolvedValue({ data: [{ code: 'DE' }] });
      expect(await makeController({ getCountries }).holidayCountries()).toEqual([{ code: 'DE' }]);
    });

    it('502 when the holidays lookup fails', () => {
      const getHolidays = vi.fn().mockResolvedValue({ error: 'upstream down' });
      return thrown(() => makeController({ getHolidays }).holidays('2026', 'DE')).then((r) =>
        expect(r).toEqual({ status: 502, body: { error: 'upstream down' } }));
    });
  });
});
