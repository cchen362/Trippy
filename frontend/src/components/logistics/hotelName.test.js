import { describe, expect, it } from 'vitest';
import { stripComponentSuffix } from './hotelName.js';

describe('stripComponentSuffix', () => {
  it('strips an exact trailing component', () => {
    expect(stripComponentSuffix('Hotel Indigo Kaohsiung Sinsing District', ['Sinsing District', 'Kaohsiung City']))
      .toBe('Hotel Indigo Kaohsiung');
  });

  it('does not strip on a partial/mid-name match', () => {
    expect(stripComponentSuffix('W Bali - Seminyak', ['Bali'])).toBe('W Bali - Seminyak');
  });

  it('matches case-insensitively', () => {
    expect(stripComponentSuffix('Regent Canggu BADUNG REGENCY', ['Badung Regency']))
      .toBe('Regent Canggu');
  });

  it('only strips a whole-token trailing match, not any substring', () => {
    expect(stripComponentSuffix('Grand District Hotel', ['District'])).toBe('Grand District Hotel');
  });

  it('never returns an empty name', () => {
    expect(stripComponentSuffix('Seminyak', ['Seminyak'])).toBe('Seminyak');
  });

  it('returns the name unchanged when components is null or empty', () => {
    expect(stripComponentSuffix('Some Hotel', null)).toBe('Some Hotel');
    expect(stripComponentSuffix('Some Hotel', [])).toBe('Some Hotel');
  });
});
