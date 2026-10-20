import { describe, expect, it } from 'vitest';
import {
  deadlineCountdownDate, deadlineSortKey, isDeadlineAhead, yourTimeNote,
} from './deadlineTime.js';

const SG = 'Asia/Singapore';
const LON = 'Europe/London';
const fact = (at, tz = null, label = 'L') => ({ id: at, kind: 'deadline', at, tz, label });
const london = fact('2026-11-12T18:00', LON);

describe('deadlineTime', () => {
  it('notes the device time and date when the zones differ', () => {
    expect(yourTimeNote(london, SG)).toBe('13 Nov 02:00 your time');
    expect(deadlineCountdownDate(london, SG)).toBe('2026-11-13');
  });

  it('gives only the time when the device date matches', () => {
    expect(yourTimeNote(fact('2026-11-12T08:00', LON), SG)).toBe('16:00 your time');
  });

  it('gives no note when the zones agree, the zone is unknown, or the date-only', () => {
    expect(yourTimeNote(london, LON)).toBe('');
    expect(yourTimeNote(fact('2026-11-12T18:00'), SG)).toBe('');
    expect(yourTimeNote(fact('2026-11-12', LON), SG)).toBe('');
    expect(deadlineCountdownDate(fact('2026-11-12T18:00'), SG)).toBe('2026-11-12');
  });

  it('drops a timed deadline whose instant has passed in a known zone, keeps it with no zone', () => {
    const now = new Date('2026-11-12T19:00:00Z');
    expect(isDeadlineAhead(fact('2026-11-12T18:00', LON), now, SG)).toBe(false);
    expect(isDeadlineAhead(fact('2026-11-12T18:00', LON), new Date('2026-11-12T17:59:00Z'), SG)).toBe(true);
    expect(isDeadlineAhead(fact('2026-11-12T18:00'), new Date('2026-11-12T08:00:00Z'), LON)).toBe(true);
  });

  it('keeps a date-only deadline until the end of that day in its zone', () => {
    const f = fact('2026-11-12', SG);
    expect(isDeadlineAhead(f, new Date('2026-11-12T15:59:00Z'), LON)).toBe(true);
    expect(isDeadlineAhead(f, new Date('2026-11-12T16:00:00Z'), LON)).toBe(false);
  });

  it('keeps an unknown-zone deadline all of its device day, drops it the day after', () => {
    const f = fact('2026-11-12T01:00');
    expect(isDeadlineAhead(f, new Date('2026-11-12T20:00:00Z'), LON)).toBe(true);
    expect(isDeadlineAhead(f, new Date('2026-11-13T00:30:00Z'), LON)).toBe(false);
  });

  it('orders across zones by instant', () => {
    const sg = fact('2026-11-12T20:00', SG);
    expect(deadlineSortKey(sg, LON)).toBeLessThan(deadlineSortKey(london, LON));
  });
});
