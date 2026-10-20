import { describe, it, expect } from 'vitest';
import { formatAtAsWritten } from './factFormat.js';

describe('formatAtAsWritten', () => {
  it('reads the date and time from the digits, with no zone conversion', () => {
    expect(formatAtAsWritten('2026-11-12T18:00')).toEqual({ date: '12 Nov', time: '18:00' });
    expect(formatAtAsWritten('2026-03-01T00:30')).toEqual({ date: '1 Mar', time: '00:30' });
  });

  it('returns a date alone for a date-only value', () => {
    expect(formatAtAsWritten('2026-11-17')).toEqual({ date: '17 Nov', time: null });
  });

  it('returns null for an empty or malformed value', () => {
    expect(formatAtAsWritten('')).toBeNull();
    expect(formatAtAsWritten(null)).toBeNull();
    expect(formatAtAsWritten('2026-13-01')).toBeNull();
    expect(formatAtAsWritten('soon')).toBeNull();
  });
});
