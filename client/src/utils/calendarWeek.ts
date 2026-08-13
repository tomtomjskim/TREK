import type { CalendarWeekStart } from '../types';

export function normalizeCalendarWeekStart(value: unknown): CalendarWeekStart {
  return value === 0 ? 0 : 1;
}

export function getCalendarWeekdayIndices(value: unknown): number[] {
  const weekStart = normalizeCalendarWeekStart(value);
  return Array.from({ length: 7 }, (_, index) => (index + weekStart) % 7);
}

export function getCalendarMonthStartOffset(year: number, month: number, value: unknown): number {
  const weekStart = normalizeCalendarWeekStart(value);
  return (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
}
