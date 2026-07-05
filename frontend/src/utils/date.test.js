import { describe, expect, it } from 'vitest';
import { naiveIsoToAbsolute } from './date.js';

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
