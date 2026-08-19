import { describe, expect, it } from 'vitest';
import { CalendarMonth } from '../../src/shared/domain/calendar-month.js';

describe('CalendarMonth', () => {
  it('identifies the period by UTC month, not by local time', () => {
    // 23:30 on the 31st in UTC+2 is still August in UTC.
    expect(CalendarMonth.from(new Date('2026-08-31T23:30:00Z')).key).toBe('2026-08');
  });

  it('resets at midnight UTC on the first of the following month', () => {
    expect(CalendarMonth.from(new Date('2026-08-19T10:00:00Z')).endsAt().toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('rolls the year over at the end of December', () => {
    expect(CalendarMonth.fromKey('2026-12').endsAt().toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('rejects a malformed key rather than silently accepting it', () => {
    expect(() => CalendarMonth.fromKey('2026-8')).toThrow();
  });
});
