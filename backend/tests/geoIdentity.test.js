// SHARED FIXTURES (F8, Plan 8): keep in lockstep with frontend/src/utils/geoIdentity.test.js
import { describe, it, expect } from 'vitest';
import { canonicalGeoKey, scopesMatch, knownCityLabel } from '../src/utils/geoIdentity.js';

describe('canonicalGeoKey', () => {
  it('folds case and spacing variants of the same city to the same key', () => {
    expect(canonicalGeoKey('ChengDu')).toBe('chengdu');
    expect(canonicalGeoKey('Cheng Du')).toBe('chengdu');
    expect(canonicalGeoKey('Cheng du')).toBe('chengdu');
    expect(canonicalGeoKey('chengdu')).toBe('chengdu');
  });

  it('strips diacritics and apostrophes', () => {
    expect(canonicalGeoKey("Xi'an")).toBe('xian');
    expect(canonicalGeoKey('São Paulo')).toBe('saopaulo');
  });

  it('folds commas and other punctuation out of composite labels', () => {
    expect(canonicalGeoKey('Kabupaten Badung, Bali')).toBe('kabupatenbadungbali');
  });

  it('trims whitespace and handles empty/nullish input', () => {
    expect(canonicalGeoKey('  Taipei  ')).toBe('taipei');
    expect(canonicalGeoKey(null)).toBe('');
    expect(canonicalGeoKey(undefined)).toBe('');
    expect(canonicalGeoKey('')).toBe('');
  });

  it('preserves CJK characters (Unicode letters survive the fold)', () => {
    expect(canonicalGeoKey('東京')).toBe('東京');
  });
});

describe('scopesMatch', () => {
  it('matches a label against itself with a trailing admin suffix stripped', () => {
    expect(scopesMatch('Kaohsiung City', 'Kaohsiung')).toBe(true);
    expect(scopesMatch('Chongqing Municipality', 'Chongqing')).toBe(true);
  });

  it('matches identical labels directly', () => {
    expect(scopesMatch('Ho Chi Minh City', 'Ho Chi Minh City')).toBe(true);
  });

  it('does not treat one city as a substring/prefix match of another', () => {
    expect(scopesMatch('Bali', 'Balikpapan')).toBe(false);
  });
});

describe('knownCityLabel', () => {
  it('recognizes IATA hub cities, including the newly added Kaohsiung (KHH)', () => {
    expect(knownCityLabel('Kaohsiung')).toBe(true);
    expect(knownCityLabel('Bali')).toBe(true); // DPS
  });

  it('recognizes city aliases', () => {
    expect(knownCityLabel('Saigon')).toBe(true);
  });

  it('rejects labels that are not known cities', () => {
    expect(knownCityLabel('Kabupaten Badung')).toBe(false);
  });
});

describe('discovery cache key parity with the old inline algorithm', () => {
  // Reimplementation of the algorithm that discovery.js used before Plan 8
  // Wave 1 (Task 1.3) replaced it with canonicalGeoKey. This proves existing
  // catalogue cache keys for clean (punctuation-free) destinations are unchanged.
  function oldCacheKey(destination) {
    const claudeDestinationBase = destination.trim().toLowerCase();
    return claudeDestinationBase
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[\s'''\-\.]/g, '');
  }

  const cleanDestinations = [
    'Chengdu',
    'Cheng Du',
    "Xi'an",
    'São Paulo',
    'Bangkok',
    'Kuala Lumpur',
    'Ho Chi Minh City',
    'Kaohsiung',
    'Taipei',
    'Bali',
    'Chiang Mai',
    'New York',
  ];

  it.each(cleanDestinations)('matches the old algorithm for %s', (destination) => {
    expect(canonicalGeoKey(destination)).toBe(oldCacheKey(destination));
  });
});
