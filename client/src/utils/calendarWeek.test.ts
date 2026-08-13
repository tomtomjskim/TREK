import { describe, expect, it } from 'vitest';
import { getCalendarMonthStartOffset, getCalendarWeekdayIndices, normalizeCalendarWeekStart } from './calendarWeek';

describe('calendar week helpers', () => {
  it('defaults unset and invalid values to Monday-first', () => {
    expect(normalizeCalendarWeekStart(undefined)).toBe(1);
    expect(normalizeCalendarWeekStart(null)).toBe(1);
    expect(normalizeCalendarWeekStart(2)).toBe(1);
    expect(normalizeCalendarWeekStart('0')).toBe(1);
    expect(getCalendarWeekdayIndices(undefined)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('keeps explicit Monday-first ordering and month offset', () => {
    expect(normalizeCalendarWeekStart(1)).toBe(1);
    expect(getCalendarWeekdayIndices(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(getCalendarMonthStartOffset(2026, 2, 1)).toBe(6);
  });

  it('uses Sunday-first ordering and puts Sunday 2026-03-01 in the first column', () => {
    expect(normalizeCalendarWeekStart(0)).toBe(0);
    expect(getCalendarWeekdayIndices(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(getCalendarMonthStartOffset(2026, 2, 0)).toBe(0);
  });
});
