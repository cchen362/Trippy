import { describe, expect, it } from 'vitest';
import { normalizeName } from './placeNames.js';

describe('normalizeName', () => {
  // F-26-9: the old `[^\w\s]` (no /u flag) regex made \w ASCII-only, so every
  // one of these folded to the empty string and collapsed into one shared key.
  it('folds distinct CJK place names to distinct, non-empty keys', () => {
    const beijingRoastDuck = normalizeName('北京烤鸭');
    const forbiddenCity = normalizeName('故宫博物院');
    const kashgarOldTown = normalizeName('喀什老城');

    expect(beijingRoastDuck).not.toBe('');
    expect(forbiddenCity).not.toBe('');
    expect(kashgarOldTown).not.toBe('');
    expect(new Set([beijingRoastDuck, forbiddenCity, kashgarOldTown]).size).toBe(3);
  });

  it('keeps the existing English geographic-suffix strip and whitespace collapse unchanged', () => {
    expect(normalizeName('Dujiangyan & Scenic Area')).toBe(normalizeName('Dujiangyan Scenic Area'));
    expect(normalizeName('  Old Town Square  ')).toBe('square');
    expect(normalizeName("Xi'an City Centre")).toBe('xi an');
  });

  it('is case-insensitive and strips punctuation for ASCII names as before', () => {
    expect(normalizeName('The Great Wall!')).toBe('the great wall');
    expect(normalizeName('THE GREAT WALL')).toBe(normalizeName('the great wall'));
  });

  it('returns an empty string for null/undefined without throwing', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});
