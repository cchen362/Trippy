import { describe, expect, it } from 'vitest';
import { dueLines } from './dueLines.js';

const TODAY = '2026-10-21';
const fact = (id, at, label = `L-${id}`, kind = 'deadline') => ({ id, kind, at, label, value: 'v' });
const b1 = { id: 'b1', title: 'Flight A', startDatetime: '2026-11-01T08:00' };
const b2 = { id: 'b2', title: 'Flight B', startDatetime: '2026-11-05T08:00' };

describe('dueLines', () => {
  it('returns [] for empty or undefined input', () => {
    expect(dueLines(undefined, undefined, TODAY)).toEqual([]);
    expect(dueLines([], {}, TODAY)).toEqual([]);
    expect(dueLines([b1], undefined, TODAY)).toEqual([]);
    expect(dueLines([b1], { b1: undefined }, TODAY)).toEqual([]);
  });

  it('excludes past, undated and non-deadline facts, and includes today', () => {
    const lines = dueLines([b1], {
      b1: [
        fact('past', '2026-10-20T23:59'),
        fact('none', null),
        fact('blank', ''),
        fact('other', '2026-11-01', 'x', 'condition'),
        fact('today', '2026-10-21'),
      ],
    }, TODAY);
    expect(lines.map((l) => l.key)).toEqual(['today']);
  });

  it('orders by at then label', () => {
    const lines = dueLines([b1], {
      b1: [fact('c', '2026-12-01', 'Zed'), fact('a', '2026-11-01', 'Beta'), fact('b', '2026-11-01', 'Alpha')],
    }, TODAY);
    expect(lines.map((l) => l.key)).toEqual(['b', 'a', 'c']);
  });

  it('shows a fact shared across bookings once, titles in start order', () => {
    const lines = dueLines([b2, b1], { b2: [fact('s', '2026-11-01')], b1: [fact('s', '2026-11-01')] }, TODAY);
    expect(lines).toHaveLength(1);
    expect(lines[0].titles).toEqual(['Flight A', 'Flight B']);
  });

  it('collapses same-booking duplicates differing only in case or whitespace', () => {
    const lines = dueLines([b1], {
      b1: [fact('x', '2026-11-01', 'Check in'), fact('y', '2026-11-01', '  CHECK IN ')],
    }, TODAY);
    expect(lines).toHaveLength(1);
    expect(lines[0].label).toBe('Check in');
  });

  it('keeps same-booking facts with different labels apart', () => {
    const lines = dueLines([b1], {
      b1: [fact('x', '2026-11-01', 'Check in'), fact('y', '2026-11-01', 'Pay balance')],
    }, TODAY);
    expect(lines).toHaveLength(2);
  });

  it('keeps same label and at under unrelated bookings apart', () => {
    const lines = dueLines([b1, b2], {
      b1: [fact('x', '2026-11-01', 'Check in')],
      b2: [fact('y', '2026-11-01', 'Check in')],
    }, TODAY);
    expect(lines).toHaveLength(2);
  });
});
