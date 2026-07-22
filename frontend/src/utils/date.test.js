import { describe, expect, it } from 'vitest';
import { naiveIsoToAbsolute, formatCountdown, localIso } from './date.js';

// Builds a local-date YYYY-MM-DD string `days` calendar days after `now`,
// using the same local-midnight arithmetic formatCountdown itself relies on.
function localDatePlusDays(now, days) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return localIso(d);
}

describe('naiveIsoToAbsolute', () => {
  it('evening wall-clock time with a positive UTC offset that wraps to the next UTC calendar day', () => {
    const result = naiveIsoToAbsolute('2026-06-08T18:30', 'Asia/Shanghai');
    expect(result.toISOString()).toBe('2026-06-08T10:30:00.000Z');
  });

  it('early-morning wall-clock time with a negative UTC offset that wraps to the previous UTC calendar day', () => {
    const result = naiveIsoToAbsolute('2026-06-08T01:00', 'America/New_York');
    expect(result.toISOString()).toBe('2026-06-08T05:00:00.000Z');
  });

  it('no-wrap control case — wall-clock time stays on the same UTC calendar day', () => {
    const result = naiveIsoToAbsolute('2026-06-08T09:00', 'Asia/Shanghai');
    expect(result.toISOString()).toBe('2026-06-08T01:00:00.000Z');
  });

  it('date-only input (no time part) defaults to midnight wall-clock time', () => {
    const result = naiveIsoToAbsolute('2026-06-08', 'Asia/Tokyo');
    expect(result.toISOString()).toBe('2026-06-07T15:00:00.000Z');
  });

  it('UTC timezone is a no-op conversion', () => {
    const result = naiveIsoToAbsolute('2026-06-08T12:00', 'UTC');
    expect(result.toISOString()).toBe('2026-06-08T12:00:00.000Z');
  });

  it('hotel check-in at 16:00 in a positive-offset timezone wraps correctly', () => {
    const result = naiveIsoToAbsolute('2026-06-08T16:00', 'Asia/Shanghai');
    expect(result.toISOString()).toBe('2026-06-08T08:00:00.000Z');
  });
});

describe('formatCountdown', () => {
  const now = new Date(2026, 6, 22); // 2026-07-22 local midnight, fixed clock

  it('day 1 (tomorrow) reads "Tomorrow"', () => {
    expect(formatCountdown(localDatePlusDays(now, 1), now)).toBe('Tomorrow');
  });

  it('day 2 reads "In 2 days"', () => {
    expect(formatCountdown(localDatePlusDays(now, 2), now)).toBe('In 2 days');
  });

  it('day 13 reads "In 13 days"', () => {
    expect(formatCountdown(localDatePlusDays(now, 13), now)).toBe('In 13 days');
  });

  it('day 14 crosses into weeks: "In 2 weeks"', () => {
    expect(formatCountdown(localDatePlusDays(now, 14), now)).toBe('In 2 weeks');
  });

  it('day 55 (last day still in weeks) reads "In 8 weeks"', () => {
    expect(formatCountdown(localDatePlusDays(now, 55), now)).toBe('In 8 weeks');
  });

  it('day 56 crosses into months: "In 2 months"', () => {
    expect(formatCountdown(localDatePlusDays(now, 56), now)).toBe('In 2 months');
  });

  it('a large future date reads in months (120 days -> "In 4 months")', () => {
    expect(formatCountdown(localDatePlusDays(now, 120), now)).toBe('In 4 months');
  });

  it('returns empty string for a non-positive day diff (defensive)', () => {
    expect(formatCountdown(localDatePlusDays(now, 0), now)).toBe('');
    expect(formatCountdown(localDatePlusDays(now, -3), now)).toBe('');
  });
});
