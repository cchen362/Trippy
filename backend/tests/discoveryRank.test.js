import { describe, it, expect } from 'vitest';
import {
  TAG_TO_CATEGORY,
  score,
  rankPlaces,
  orderCategories,
  parseDurationHours,
} from '../src/services/discoveryRank.js';

function makeItem(overrides = {}) {
  return {
    category: 'culture',
    provenance: 'unverified',
    batch: 0,
    estimated_duration: null,
    rating: undefined,
    rating_count: undefined,
    ...overrides,
  };
}

describe('parseDurationHours', () => {
  it('parses a plain hours figure', () => {
    expect(parseDurationHours('2 hours')).toBe(2);
  });

  it('averages a range', () => {
    expect(parseDurationHours('1-2 hours')).toBe(1.5);
  });

  it('parses minutes as fractional hours', () => {
    expect(parseDurationHours('30 minutes')).toBe(0.5);
  });

  it('treats "half day" as ~4 hours', () => {
    expect(parseDurationHours('half day')).toBe(4);
  });

  it('treats "full day" as ~8 hours', () => {
    expect(parseDurationHours('full day')).toBe(8);
  });

  it('returns null for unparseable garbage', () => {
    expect(parseDurationHours('as long as you like')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(parseDurationHours('')).toBeNull();
    expect(parseDurationHours(null)).toBeNull();
    expect(parseDurationHours(undefined)).toBeNull();
  });
});

describe('score — verified boost', () => {
  const neutralPrefs = { interestTags: [], pace: 'moderate', travellers: undefined };

  it('adds 3.0 for a verified item vs an unverified one, all else equal', () => {
    const unverified = makeItem({ provenance: 'unverified', batch: 0 });
    const verified = makeItem({ provenance: 'verified', batch: 0 });

    expect(score(verified, neutralPrefs) - score(unverified, neutralPrefs)).toBeCloseTo(3.0);
  });

  it('treats pending the same as unverified (no verified boost)', () => {
    const pending = makeItem({ provenance: 'pending', batch: 0 });
    const unverified = makeItem({ provenance: 'unverified', batch: 0 });

    expect(score(pending, neutralPrefs)).toBeCloseTo(score(unverified, neutralPrefs));
  });
});

describe('score — batch penalty', () => {
  const neutralPrefs = { interestTags: [], pace: 'moderate', travellers: undefined };

  it('penalizes later batches by 0.75 per batch step', () => {
    const batch0 = makeItem({ batch: 0 });
    const batch1 = makeItem({ batch: 1 });

    expect(score(batch0, neutralPrefs) - score(batch1, neutralPrefs)).toBeCloseTo(0.75);
  });
});

describe('score — category-interest boost', () => {
  it('adds 1.5 when the item category is mapped from a declared interest tag', () => {
    const prefsWithFood = { interestTags: ['food & drink'], pace: 'moderate', travellers: undefined };
    const prefsWithout = { interestTags: [], pace: 'moderate', travellers: undefined };
    const foodItem = makeItem({ category: 'food' });

    expect(score(foodItem, prefsWithFood) - score(foodItem, prefsWithout)).toBeCloseTo(1.5);
  });

  it('matches case-insensitively', () => {
    const prefs = { interestTags: ['FOOD & DRINK'], pace: 'moderate', travellers: undefined };
    const foodItem = makeItem({ category: 'food' });
    const noPrefs = { interestTags: [], pace: 'moderate', travellers: undefined };

    expect(score(foodItem, prefs) - score(foodItem, noPrefs)).toBeCloseTo(1.5);
  });

  it('does not boost a category the tags do not map to', () => {
    const prefs = { interestTags: ['food & drink'], pace: 'moderate', travellers: undefined };
    const nightlifeItem = makeItem({ category: 'nightlife' });
    const noPrefs = { interestTags: [], pace: 'moderate', travellers: undefined };

    expect(score(nightlifeItem, prefs)).toBeCloseTo(score(nightlifeItem, noPrefs));
  });
});

describe('score — pace fit', () => {
  it('fast pace favors short items (<=2h)', () => {
    const fastPrefs = { interestTags: [], pace: 'fast', travellers: undefined };
    const moderatePrefs = { interestTags: [], pace: 'moderate', travellers: undefined };
    const shortItem = makeItem({ estimated_duration: '1 hour' });

    expect(score(shortItem, fastPrefs) - score(shortItem, moderatePrefs)).toBeCloseTo(0.5);
  });

  it('fast pace does not favor long items (>2h)', () => {
    const fastPrefs = { interestTags: [], pace: 'fast', travellers: undefined };
    const moderatePrefs = { interestTags: [], pace: 'moderate', travellers: undefined };
    const longItem = makeItem({ estimated_duration: '4 hours' });

    expect(score(longItem, fastPrefs)).toBeCloseTo(score(longItem, moderatePrefs));
  });

  it('relaxed pace favors long items (>=3h)', () => {
    const relaxedPrefs = { interestTags: [], pace: 'relaxed', travellers: undefined };
    const moderatePrefs = { interestTags: [], pace: 'moderate', travellers: undefined };
    const longItem = makeItem({ estimated_duration: '4 hours' });

    expect(score(longItem, relaxedPrefs) - score(longItem, moderatePrefs)).toBeCloseTo(0.5);
  });

  it('relaxed pace does not favor short items (<3h)', () => {
    const relaxedPrefs = { interestTags: [], pace: 'relaxed', travellers: undefined };
    const moderatePrefs = { interestTags: [], pace: 'moderate', travellers: undefined };
    const shortItem = makeItem({ estimated_duration: '1 hour' });

    expect(score(shortItem, relaxedPrefs)).toBeCloseTo(score(shortItem, moderatePrefs));
  });

  it('an unparseable duration is neutral regardless of pace', () => {
    const fastPrefs = { interestTags: [], pace: 'fast', travellers: undefined };
    const relaxedPrefs = { interestTags: [], pace: 'relaxed', travellers: undefined };
    const item = makeItem({ estimated_duration: 'depends on your mood' });

    expect(score(item, fastPrefs)).toBeCloseTo(score(item, relaxedPrefs));
  });

  it('moderate pace is always neutral', () => {
    const moderatePrefs = { interestTags: [], pace: 'moderate', travellers: undefined };
    const shortItem = makeItem({ estimated_duration: '1 hour' });
    const longItem = makeItem({ estimated_duration: '5 hours' });

    expect(score(shortItem, moderatePrefs)).toBeCloseTo(score(longItem, moderatePrefs));
  });
});

describe('score — quality term', () => {
  const neutralPrefs = { interestTags: [], pace: 'moderate', travellers: undefined };

  it('contributes nothing when rating is absent', () => {
    const noRating = makeItem({ rating: undefined, rating_count: undefined });
    const explicitlyNull = makeItem({ rating: null, rating_count: null });

    expect(score(noRating, neutralPrefs)).toBeCloseTo(score(explicitlyNull, neutralPrefs));
    expect(score(noRating, neutralPrefs)).toBeCloseTo(0);
  });

  it('boosts above-average ratings, weighted by review count', () => {
    const rated = makeItem({ rating: 4.5, rating_count: 100 });
    // (4.5 - 3.5) * log10(101) ≈ 1 * 2.004 ≈ 2.004
    expect(score(rated, neutralPrefs)).toBeCloseTo(1 * Math.log10(101), 3);
  });

  it('penalizes below-average ratings', () => {
    const rated = makeItem({ rating: 2.5, rating_count: 100 });
    expect(score(rated, neutralPrefs)).toBeCloseTo(-1 * Math.log10(101), 3);
  });

  it('a rating with zero review count still contributes (log10(1) = 0 baseline)', () => {
    const rated = makeItem({ rating: 4.5, rating_count: 0 });
    expect(score(rated, neutralPrefs)).toBeCloseTo(1 * Math.log10(1), 3);
    expect(score(rated, neutralPrefs)).toBeCloseTo(0, 5);
  });
});

describe('rankPlaces', () => {
  const neutralPrefs = { interestTags: [], pace: 'moderate', travellers: undefined };

  it('sorts descending by score', () => {
    const low = makeItem({ provenance: 'unverified', batch: 0 });
    const high = makeItem({ provenance: 'verified', batch: 0 });

    const ranked = rankPlaces([low, high], neutralPrefs);
    expect(ranked[0]).toBe(high);
    expect(ranked[1]).toBe(low);
  });

  it('is stable on ties — preserves original (generation) order', () => {
    const a = makeItem({ provenance: 'unverified', batch: 0 });
    const b = makeItem({ provenance: 'unverified', batch: 0 });
    const c = makeItem({ provenance: 'unverified', batch: 0 });

    const ranked = rankPlaces([a, b, c], neutralPrefs);
    expect(ranked).toEqual([a, b, c]);
  });

  it('returns a new array, does not mutate the input', () => {
    const a = makeItem({ batch: 1 });
    const b = makeItem({ batch: 0 });
    const input = [a, b];

    const ranked = rankPlaces(input, neutralPrefs);
    expect(input).toEqual([a, b]); // unchanged order
    expect(ranked).not.toBe(input);
    expect(ranked).toEqual([b, a]); // b (batch 0) scores higher than a (batch 1)
  });
});

describe('orderCategories', () => {
  it('puts essentials first when present', () => {
    const prefs = { interestTags: [], pace: 'moderate', travellers: undefined };
    const result = orderCategories(['food', 'essentials', 'culture'], prefs);
    expect(result[0]).toBe('essentials');
  });

  it('orders interest-mapped categories by declared tag order', () => {
    const prefs = { interestTags: ['nightlife', 'food & drink'], pace: 'moderate', travellers: undefined };
    const result = orderCategories(['culture', 'food', 'nightlife'], prefs);
    expect(result).toEqual(['nightlife', 'food', 'culture']);
  });

  it('appends remaining categories in their original relative order', () => {
    const prefs = { interestTags: ['food & drink'], pace: 'moderate', travellers: undefined };
    const result = orderCategories(['culture', 'wellness', 'food', 'architecture'], prefs);
    expect(result).toEqual(['food', 'culture', 'wellness', 'architecture']);
  });

  it('dedups when essentials and tag-mapped categories overlap with the remainder loop', () => {
    const prefs = { interestTags: ['food & drink', 'history'], pace: 'moderate', travellers: undefined };
    // 'history' and 'art' both map to 'culture' — must only appear once.
    const result = orderCategories(['essentials', 'culture', 'food', 'nightlife'], prefs);
    expect(result).toEqual(['essentials', 'food', 'culture', 'nightlife']);
  });

  it('moves nightlife to the very end for family travellers', () => {
    const prefs = { interestTags: ['nightlife'], pace: 'moderate', travellers: 'family' };
    const result = orderCategories(['essentials', 'nightlife', 'food', 'culture'], prefs);
    expect(result).toEqual(['essentials', 'food', 'culture', 'nightlife']);
  });

  it('does not move nightlife for non-family travellers', () => {
    const prefs = { interestTags: ['nightlife'], pace: 'moderate', travellers: 'solo' };
    const result = orderCategories(['essentials', 'nightlife', 'food', 'culture'], prefs);
    expect(result).toEqual(['essentials', 'nightlife', 'food', 'culture']);
  });

  it('is a no-op shape when nightlife is absent for family travellers', () => {
    const prefs = { interestTags: [], pace: 'moderate', travellers: 'family' };
    const result = orderCategories(['essentials', 'food', 'culture'], prefs);
    expect(result).toEqual(['essentials', 'food', 'culture']);
  });
});

describe('TAG_TO_CATEGORY', () => {
  it('matches the frontend mapping exactly (copied verbatim)', () => {
    expect(TAG_TO_CATEGORY).toEqual({
      'food & drink': 'food',
      'nature': 'nature',
      'culture': 'culture',
      'nightlife': 'nightlife',
      'architecture': 'architecture',
      'wellness': 'wellness',
      'history': 'culture',
      'art': 'culture',
      'markets': 'hidden_gems',
      'shopping': 'hidden_gems',
      'adventure': 'nature',
      'off the beaten path': 'hidden_gems',
    });
  });
});
