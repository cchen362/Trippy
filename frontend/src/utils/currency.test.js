import { describe, expect, it } from 'vitest';
import { currencyForCountry, minorUnitsFor, formatMinor } from './currency.js';

describe('currencyForCountry', () => {
  it('maps known country codes to ISO 4217 currencies', () => {
    expect(currencyForCountry('JP')).toBe('JPY');
    expect(currencyForCountry('sg')).toBe('SGD');
    expect(currencyForCountry('CN')).toBe('CNY');
    expect(currencyForCountry('FR')).toBe('EUR');
  });

  it('returns null for unmapped or missing codes', () => {
    expect(currencyForCountry('ZZ')).toBeNull();
    expect(currencyForCountry(null)).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });
});

describe('minorUnitsFor', () => {
  it('is 0 for zero-decimal currencies', () => {
    expect(minorUnitsFor('JPY')).toBe(0);
    expect(minorUnitsFor('KRW')).toBe(0);
    expect(minorUnitsFor('VND')).toBe(0);
  });

  it('defaults to 2 for everything else, including IDR', () => {
    expect(minorUnitsFor('SGD')).toBe(2);
    expect(minorUnitsFor('USD')).toBe(2);
    expect(minorUnitsFor('IDR')).toBe(2);
  });
});

describe('formatMinor', () => {
  it('formats zero-decimal currencies without a decimal point', () => {
    expect(formatMinor(124000, 'JPY')).toBe('¥124,000');
  });

  it('formats 2-decimal currencies with the currency symbol', () => {
    expect(formatMinor(8000, 'SGD')).toBe('S$80.00');
  });

  it('returns an em dash for null amounts', () => {
    expect(formatMinor(null, 'SGD')).toBe('—');
  });
});
