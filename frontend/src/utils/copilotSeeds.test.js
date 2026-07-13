import { describe, expect, it } from 'vitest';
import { deriveCopilotSeeds, FALLBACK_PROMPT } from './copilotSeeds.js';

const DAYS = [
  { id: 'day-1', date: '2026-06-10', resolvedCity: 'Shanghai', stops: [] },
  {
    id: 'day-2',
    date: '2026-06-11',
    city: 'Shanghai',
    resolvedCity: 'Hangzhou',
    stops: [
      { id: 'west-lake', type: 'experience', title: 'West Lake', time: '09:00' },
      { id: 'lingyin', type: 'experience', title: 'Lingyin Temple', time: null },
      { id: 'longjing', type: 'explore', title: 'Longjing Tea Fields', time: '15:00' },
    ],
  },
];

const BOOKINGS = [
  {
    id: 'train-1',
    type: 'train',
    title: 'G1651',
    origin: 'Shanghai Hongqiao',
    destination: 'Hangzhou East',
    startDatetime: '2026-06-11T08:00:00',
  },
];

describe('deriveCopilotSeeds', () => {
  it('returns deterministic prompts from a representative real trip shape', () => {
    const input = { days: DAYS, bookings: BOOKINGS, activeDayId: 'day-2' };
    expect(deriveCopilotSeeds(input)).toEqual(deriveCopilotSeeds(input));
    expect(deriveCopilotSeeds(input)).toEqual([
      'How does Day 2 in Hangzhou flow with 3 stops, including 1 untimed?',
      'Where should I plan a meal around the stops on Day 2 in Hangzhou?',
      'What do I need ready for the train from Shanghai Hongqiao to Hangzhou East on June 11?',
    ]);
  });

  it('uses the resolved active-day city and position-derived day number', () => {
    const [prompt] = deriveCopilotSeeds({ days: DAYS, activeDayId: 'day-2' });
    expect(prompt).toContain('Day 2 in Hangzhou');
    expect(prompt).not.toContain('Day 1');
    expect(prompt).not.toContain('Shanghai');
  });

  it('describes a fully untimed day and suppresses the appetite prompt when food is present', () => {
    const days = [{
      id: 'day-1',
      resolvedCity: 'Kyoto',
      stops: [
        { type: 'experience', time: null },
        { type: 'food', time: null },
      ],
    }];
    const prompts = deriveCopilotSeeds({ days, activeDayId: 'day-1' });
    expect(prompts).toEqual(['How should I order the 2 untimed stops on Day 1 in Kyoto?']);
  });

  it('chooses the next dated booking on or after the active day', () => {
    const bookings = [
      { type: 'hotel', title: 'Past Hotel', startDatetime: '2026-06-10T15:00:00' },
      { type: 'hotel', title: 'Aman Kyoto', startDatetime: '2026-06-12T15:00:00' },
      { type: 'flight', title: 'Later flight', startDatetime: '2026-06-13T10:00:00' },
    ];
    const prompts = deriveCopilotSeeds({ days: DAYS, bookings, activeDayId: 'day-2' });
    expect(prompts.at(-1)).toBe('What do I need ready for the hotel for Aman Kyoto on June 12?');
  });

  it('never returns more than three prompts', () => {
    expect(deriveCopilotSeeds({ days: DAYS, bookings: BOOKINGS, activeDayId: 'day-2' })).toHaveLength(3);
  });

  it('returns exactly the neutral fallback for an empty trip', () => {
    expect(deriveCopilotSeeds()).toEqual([FALLBACK_PROMPT]);
  });

  it('does not stringify invented values when optional facts are missing', () => {
    const prompts = deriveCopilotSeeds({
      days: [{ id: 'day-1', stops: [] }],
      bookings: [{ type: 'train', title: null, startDatetime: null }],
      activeDayId: 'day-1',
    });
    expect(prompts).toEqual(['How should I shape Day 1 with no stops planned yet?']);
    expect(prompts.join(' ')).not.toMatch(/undefined|null|invalid/i);
  });
});
