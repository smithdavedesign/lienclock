import { describe, expect, it } from 'vitest';
import { addDays, addMonthsOnDay, daysBetween, isIsoDate, monthsBetween, todayIn } from '@/lib/dates';

describe('isIsoDate', () => {
  it.each(['2026-01-01', '2028-02-29', '2026-12-31'])('accepts %s', (s) => {
    expect(isIsoDate(s)).toBe(true);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '26-01-01', '2026-1-1', '', '2026-01-01T00:00', 'nope'])(
    'rejects %j',
    (s) => {
      expect(isIsoDate(s)).toBe(false);
    },
  );

  it('rejects non-strings', () => {
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(20260101)).toBe(false);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-03-01', 20, '2026-03-21'],
    ['2026-01-31', 1, '2026-02-01'],
    ['2026-12-20', 20, '2027-01-09'],
    ['2028-02-15', 20, '2028-03-06'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2026-03-07', 1, '2026-03-08'], // US DST starts 2026-03-08: no off-by-one
    ['2026-11-01', 1, '2026-11-02'], // US DST ends 2026-11-01
    ['2026-04-10', -20, '2026-03-21'],
    ['2026-01-10', 90, '2026-04-10'],
  ])('%s + %i days = %s', (from, n, expected) => {
    expect(addDays(from, n)).toBe(expected);
  });
});

describe('addMonthsOnDay', () => {
  it.each([
    ['2026-02-10', 4, 15, '2026-06-15'],
    ['2026-09-30', 4, 15, '2027-01-15'],
    ['2026-12-31', 3, 15, '2027-03-15'],
    ['2026-01-01', 3, 15, '2026-04-15'],
  ])('%s + %i months on day %i = %s', (from, months, day, expected) => {
    expect(addMonthsOnDay(from, months, day)).toBe(expected);
  });

  it('refuses a day that does not exist in every month', () => {
    expect(() => addMonthsOnDay('2026-01-01', 1, 31)).toThrow();
  });
});

describe('daysBetween', () => {
  it('counts calendar days from the first date to the second', () => {
    expect(daysBetween('2026-03-14', '2026-03-21')).toBe(7);
    expect(daysBetween('2026-03-21', '2026-03-14')).toBe(-7);
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(0);
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31); // across DST start
    expect(daysBetween('2027-12-31', '2028-12-31')).toBe(366);
  });
});

describe('monthsBetween', () => {
  it('lists each calendar month from start to end, inclusive', () => {
    expect(monthsBetween('2026-01-20', '2026-03-05')).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(monthsBetween('2026-11-30', '2027-01-01')).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(monthsBetween('2026-05-01', '2026-05-31')).toEqual(['2026-05']);
  });

  it('returns only the start month when the end is earlier', () => {
    expect(monthsBetween('2026-05-10', '2026-04-01')).toEqual(['2026-05']);
  });
});

describe('todayIn', () => {
  // 05:30 UTC on 2026-03-14 is 00:30 in Chicago (CDT) but still 22:30 the evening before in LA (PDT).
  const instant = new Date('2026-03-14T05:30:00Z');

  it('uses the calendar date in the given time zone, not the server zone', () => {
    expect(todayIn('America/Chicago', instant)).toBe('2026-03-14');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-03-13');
    expect(todayIn('America/Phoenix', instant)).toBe('2026-03-13');
    expect(todayIn('America/New_York', instant)).toBe('2026-03-14');
  });
});
