import { describe, expect, it } from 'vitest';
import { contextForRoute, formatContextChip } from './copilotContext.js';

describe('co-pilot screen context', () => {
  it('formats the persisted Discovery suggestion subject', () => {
    const chip = formatContextChip({
      tab: 'discovery',
      discoveryName: 'Hupao Spring',
      dayId: 'day-1',
      stopId: 'stop-1',
    }, [{ id: 'day-1', resolvedCity: 'Hangzhou', stops: [{ id: 'stop-1', title: 'West Lake' }] }]);
    expect(chip).toContain('Hupao Spring');
    expect(chip).not.toMatch(/Hangzhou|West Lake/);
  });

  it('ignores a Discovery subject outside the Discovery surface', () => {
    expect(formatContextChip({ tab: 'plan', discoveryName: 'Injected subject' }))
      .toBe('plan');
  });

  it('captures the route tab and active day for a FAB open', () => {
    expect(contextForRoute('/trips/trip-1/plan', 'day-3')).toEqual({
      tab: 'plan',
      dayId: 'day-3',
    });
  });

  it('does not invent context for a non-tab route', () => {
    expect(contextForRoute('/trips/trip-1', 'day-3')).toBeNull();
  });

  it('formats live id context and resolved history context identically', () => {
    const days = [{
      id: 'day-3',
      city: 'Old City',
      resolvedCity: 'Hangzhou',
      stops: [{ id: 'stop-1', title: 'West Lake' }],
    }];

    expect(formatContextChip(
      { tab: 'plan', dayId: 'day-3', stopId: 'stop-1' },
      days,
    )).toBe('plan · Day 1 · Hangzhou · West Lake');
    expect(formatContextChip({
      tab: 'plan',
      dayId: 'day-3',
      dayNumber: 1,
      dayCity: 'Hangzhou',
      stopId: 'stop-1',
      stopName: 'West Lake',
    })).toBe('plan · Day 1 · Hangzhou · West Lake');
  });
});
