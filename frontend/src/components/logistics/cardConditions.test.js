import { describe, expect, it } from 'vitest';
import { cardConditionLines, conditionsAriaSuffix } from './cardConditions.js';

const TODAY = new Date(2026, 9, 20, 12, 0);
const fact = (id, kind, at) => ({ id, kind, at, label: `L-${id}`, value: `V-${id}` });

describe('cardConditionLines', () => {
  it('returns [] for undefined, null, non-array and empty input', () => {
    expect(cardConditionLines(undefined, TODAY)).toEqual([]);
    expect(cardConditionLines(null, TODAY)).toEqual([]);
    expect(cardConditionLines('nope', TODAY)).toEqual([]);
    expect(cardConditionLines([], TODAY)).toEqual([]);
  });

  it('picks the earliest upcoming deadline', () => {
    const lines = cardConditionLines([
      fact('d3', 'deadline', '2026-12-01'),
      fact('d1', 'deadline', '2026-10-25T09:00'),
      fact('d2', 'deadline', '2026-11-02T10:00'),
    ], TODAY);
    expect(lines).toEqual([{ key: 'd1', label: 'L-d1', value: '25 Oct 09:00' }]);
  });

  it('ignores past deadlines and deadlines without a date', () => {
    const lines = cardConditionLines([
      fact('past', 'deadline', '2026-10-19T23:59'),
      fact('none', 'deadline', null),
      fact('blank', 'deadline', ''),
      fact('ok', 'deadline', '2026-11-30'),
    ], TODAY);
    expect(lines.map((l) => l.key)).toEqual(['ok']);
    expect(cardConditionLines([fact('past', 'deadline', '2026-10-19'), fact('none', 'deadline', '')], TODAY)).toEqual([]);
  });

  it('counts a deadline due today as upcoming, even if its time has passed', () => {
    const lines = cardConditionLines([fact('today', 'deadline', '2026-10-20T00:30')], TODAY);
    expect(lines.map((l) => l.key)).toEqual(['today']);
  });

  it('skips a timed deadline already passed in its known zone', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const lines = cardConditionLines([
      { ...fact('gone', 'deadline', '2026-10-20T09:00'), tz: 'UTC' },
      { ...fact('next', 'deadline', '2026-10-20T20:00'), tz: 'UTC' },
    ], now, 'Asia/Singapore');
    expect(lines.map((l) => l.key)).toEqual(['next']);
  });

  it('picks the first window by date, empty at last, regardless of today', () => {
    const lines = cardConditionLines([
      fact('w-none', 'window', null),
      fact('w-late', 'window', '2026-12-05T15:00'),
      fact('w-early', 'window', '2020-01-01T09:00'),
    ], TODAY);
    expect(lines.map((l) => l.key)).toEqual(['w-early']);
  });

  it('falls back to an at-less window and keeps input order among ties', () => {
    expect(cardConditionLines([fact('w1', 'window', ''), fact('w2', 'window', null)], TODAY).map((l) => l.key)).toEqual(['w1']);
    expect(cardConditionLines([
      fact('a', 'window', '2026-11-01'),
      fact('b', 'window', '2026-11-01'),
    ], TODAY).map((l) => l.key)).toEqual(['a']);
  });

  it('returns the deadline first, then the window', () => {
    const lines = cardConditionLines([
      fact('w', 'window', '2026-11-01T15:00'),
      fact('d', 'deadline', '2026-10-30'),
    ], TODAY);
    expect(lines.map((l) => l.key)).toEqual(['d', 'w']);
  });

  it('never returns other kinds', () => {
    const others = ['requirement', 'instruction', 'allowance', 'contact', 'restriction', 'cost_condition']
      .map((k, i) => fact(`o${i}`, k, '2026-11-01'));
    expect(cardConditionLines(others, TODAY)).toEqual([]);
  });

  it('defaults today to the local date', () => {
    expect(cardConditionLines([fact('far', 'deadline', '2099-01-01')]).map((l) => l.key)).toEqual(['far']);
    expect(cardConditionLines([fact('gone', 'deadline', '2000-01-01')])).toEqual([]);
  });

  it("gives a deadline's moment as written, and a window's English line", () => {
    const lines = cardConditionLines([fact('d', 'deadline', '2026-11-12'), fact('w', 'window', '2026-11-14T15:00')], TODAY);
    expect(lines.map((l) => l.value)).toEqual(['12 Nov', 'V-w']);
  });
});

describe('conditionsAriaSuffix', () => {
  it('ends each line with exactly one full stop', () => {
    expect(conditionsAriaSuffix([{ label: 'Train departure', value: 'Departs at 09:12.' }, { label: 'B', value: 'b' }]))
      .toBe(' Train departure: Departs at 09:12. B: b.');
  });
});
