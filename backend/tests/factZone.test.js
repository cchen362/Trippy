import { describe, expect, it } from 'vitest';
import { bookingZone, countryZone, isKnownZone } from '../src/services/factZone.js';

// D-37-10 (Plan 37): the zone derivation is pure, so it is tested without a database.
const row = (over = {}) => ({ type: 'hotel', origin_tz: null, destination_tz: null, details_json: '{}', ...over });
const AT = '2026-11-15T15:00';

describe('bookingZone: the booking zone columns', () => {
  it('a flight reads the origin zone first, then the destination', () => {
    expect(bookingZone(row({ type: 'flight', origin_tz: 'Asia/Seoul', destination_tz: 'Asia/Tokyo' }), { at: AT })).toBe('Asia/Seoul');
    expect(bookingZone(row({ type: 'flight', destination_tz: 'Asia/Tokyo' }), { at: AT })).toBe('Asia/Tokyo');
  });
  it('a train reads the origin zone first', () => {
    expect(bookingZone(row({ type: 'train', origin_tz: 'Europe/Paris', destination_tz: 'Europe/London' }), { at: AT })).toBe('Europe/Paris');
  });
  it('a hotel and an other booking read the destination zone first, then the origin', () => {
    for (const type of ['hotel', 'other']) {
      expect(bookingZone(row({ type, origin_tz: 'Asia/Seoul', destination_tz: 'Asia/Tokyo' }), { at: AT })).toBe('Asia/Tokyo');
      expect(bookingZone(row({ type, origin_tz: 'Asia/Seoul' }), { at: AT })).toBe('Asia/Seoul');
    }
  });
  it('details.tz comes after the columns', () => {
    expect(bookingZone(row({ details_json: '{"tz":"Asia/Taipei"}' }), { at: AT })).toBe('Asia/Taipei');
    expect(bookingZone(row({ destination_tz: 'Asia/Tokyo', details_json: '{"tz":"Asia/Taipei"}' }), { at: AT })).toBe('Asia/Tokyo');
  });
});

describe('bookingZone: coordinates, then country', () => {
  it('coordinates resolve through geo-tz and beat a country', () => {
    expect(bookingZone(row({ details_json: '{"lat":51.5,"lng":-0.12,"countryCode":"JP"}' }), { at: AT })).toBe('Europe/London');
  });
  it('a lat without a lng is not coordinates', () => {
    expect(bookingZone(row({ details_json: '{"lat":51.5}' }), { at: AT })).toBeNull();
  });
  it('details.countryCode wins over the day country', () => {
    expect(bookingZone(row({ details_json: '{"countryCode":"JP"}' }), { at: AT, dayCountry: 'MY' })).toBe('Asia/Tokyo');
  });
  it('the day country is used when the booking names none', () => {
    expect(bookingZone(row(), { at: AT, dayCountry: 'MY' })).toBe('Asia/Kuala_Lumpur');
  });
  it('a booking with no evidence has no zone', () => {
    expect(bookingZone(row(), { at: AT })).toBeNull();
    expect(bookingZone(row({ details_json: null }), { at: AT, dayCountry: null })).toBeNull();
  });
});

describe('countryZone', () => {
  it('a country with one wall-clock time resolves', () => {
    expect(countryZone('JP', AT)).toBe('Asia/Tokyo');
    expect(countryZone('jp', '2026-11-15')).toBe('Asia/Tokyo');
  });
  it('a country whose zones share one offset resolves to the first zone', () => {
    expect(countryZone('MY', AT)).toBe('Asia/Kuala_Lumpur');
  });
  it('a country with two offsets is ambiguous and resolves to nothing', () => {
    for (const cc of ['CN', 'US', 'AU']) expect(countryZone(cc, AT)).toBeNull();
  });
  it('rejects a malformed or unknown code', () => {
    expect(countryZone('', AT)).toBeNull();
    expect(countryZone(null, AT)).toBeNull();
    expect(countryZone('JPN', AT)).toBeNull();
  });
});

describe('unknown zone names', () => {
  it('isKnownZone accepts platform zones only', () => {
    expect(isKnownZone('Asia/Tokyo')).toBe(true);
    expect(isKnownZone('UTC')).toBe(true);
    for (const bad of ['Asia/Nowhere', '', null, undefined, 42]) expect(isKnownZone(bad)).toBe(false);
  });
  it('an invalid booking column falls through to the next evidence', () => {
    const details = '{"lat":51.5,"lng":-0.12}';
    expect(bookingZone(row({ type: 'flight', origin_tz: 'Asia/Nowhere', details_json: details }), { at: AT })).toBe('Europe/London');
    expect(bookingZone(row({ destination_tz: 'Asia/Nowhere', details_json: '{"tz":"Asia/Taipei"}' }), { at: AT })).toBe('Asia/Taipei');
    expect(bookingZone(row({ details_json: '{"tz":"Asia/Nowhere"}' }), { at: AT })).toBeNull();
  });
});
