import { describe, it, expect } from 'vitest';
import { countryCodeFromName } from '../src/utils/countries.js';

describe('countryCodeFromName', () => {
  it('resolves an exact English country name', () => {
    expect(countryCodeFromName('China')).toBe('CN');
    expect(countryCodeFromName('Japan')).toBe('JP');
  });

  it('resolves Google Places-style "Region, Country" text by its last segment', () => {
    expect(countryCodeFromName('Sichuan, China')).toBe('CN');
    expect(countryCodeFromName('Tokyo, Japan')).toBe('JP');
  });

  it('resolves common aliases', () => {
    expect(countryCodeFromName('USA')).toBe('US');
    expect(countryCodeFromName('South Korea')).toBe('KR');
    expect(countryCodeFromName('Hong Kong')).toBe('HK');
    expect(countryCodeFromName('Macau')).toBe('MO');
    expect(countryCodeFromName('Taiwan')).toBe('TW');
  });

  it('passes through a valid 2-letter code, case-insensitively', () => {
    expect(countryCodeFromName('CN')).toBe('CN');
    expect(countryCodeFromName('cn')).toBe('CN');
    expect(countryCodeFromName('Us')).toBe('US');
  });

  it('returns null for unresolvable input', () => {
    expect(countryCodeFromName('Narnia')).toBeNull();
    expect(countryCodeFromName('XX')).toBeNull();
  });

  it('returns null for empty or falsy input', () => {
    expect(countryCodeFromName('')).toBeNull();
    expect(countryCodeFromName('   ')).toBeNull();
    expect(countryCodeFromName(null)).toBeNull();
    expect(countryCodeFromName(undefined)).toBeNull();
  });
});
