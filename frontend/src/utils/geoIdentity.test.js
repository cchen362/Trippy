import { describe, expect, it } from 'vitest';
import { canonicalGeoKey } from './geoIdentity.js';

// SHARED FIXTURES (F8, Plan 8): keep in lockstep with backend/tests/geoIdentity.test.js
describe('canonicalGeoKey', () => {
  it('folds spelling/spacing/case variants of the same city to one key', () => {
    expect(canonicalGeoKey('ChengDu')).toBe('chengdu');
    expect(canonicalGeoKey('Cheng Du')).toBe('chengdu');
    expect(canonicalGeoKey('Cheng du')).toBe('chengdu');
    expect(canonicalGeoKey('chengdu')).toBe('chengdu');
  });

  it('strips combining diacritics after NFD normalization', () => {
    expect(canonicalGeoKey("Xi'an")).toBe('xian');
    expect(canonicalGeoKey('São Paulo')).toBe('saopaulo');
  });

  it('folds a composite label down to its letters and numbers', () => {
    expect(canonicalGeoKey('Kabupaten Badung, Bali')).toBe('kabupatenbadungbali');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalGeoKey('  Taipei  ')).toBe('taipei');
  });

  it('returns an empty string for null, undefined, or empty input', () => {
    expect(canonicalGeoKey(null)).toBe('');
    expect(canonicalGeoKey(undefined)).toBe('');
    expect(canonicalGeoKey('')).toBe('');
  });

  it('preserves CJK characters, which are already single-codepoint letters', () => {
    expect(canonicalGeoKey('東京')).toBe('東京');
  });
});
