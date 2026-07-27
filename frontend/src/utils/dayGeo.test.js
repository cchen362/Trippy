import { describe, expect, it } from 'vitest';
import { dayDisplayLabel, discoveryCountryForDay } from './dayGeo.js';

describe('dayDisplayLabel', () => {
  it('prefers the resolved city over the raw seed city', () => {
    expect(dayDisplayLabel({ resolvedCity: 'Kaohsiung City', city: 'Kaohsiung' })).toBe('Kaohsiung City');
  });

  it('falls back to the raw seed city when resolvedCity is absent', () => {
    expect(dayDisplayLabel({ city: 'Kaohsiung' })).toBe('Kaohsiung');
  });

  it('returns an empty string when neither is present', () => {
    expect(dayDisplayLabel({})).toBe('');
    expect(dayDisplayLabel(null)).toBe('');
    expect(dayDisplayLabel(undefined)).toBe('');
  });

  // MapTab previously prepended `cityOverride` ahead of `resolvedCity`/`city`,
  // which was redundant — resolvedCity already reflects any override. A day
  // with a cityOverride set must still resolve through resolvedCity alone.
  it('does not need a separate cityOverride branch — resolvedCity already reflects it', () => {
    expect(dayDisplayLabel({ cityOverride: 'Custom Name', resolvedCity: 'Custom Name', city: 'Original' })).toBe('Custom Name');
  });

  // AddPlaceModal previously had a reversed fallback chain (`city || resolvedCity`)
  // in one of its two usages, which would prefer the stale seed city over the
  // resolved one. The correct order — resolvedCity first — must hold.
  it('prefers resolvedCity over city even when both are present (order matters)', () => {
    expect(dayDisplayLabel({ city: 'Old Name', resolvedCity: 'New Resolved Name' })).toBe('New Resolved Name');
  });
});

describe('discoveryCountryForDay (Plan 26 W4.2, F-26-10)', () => {
  it('returns null when the day has no resolvedCountry', () => {
    expect(discoveryCountryForDay({ resolvedCity: 'Okinawa' })).toBeNull();
    expect(discoveryCountryForDay({})).toBeNull();
    expect(discoveryCountryForDay(null)).toBeNull();
  });

  // Okinawa case: the country's evidence layer (previous-day carry) named
  // Shanghai, a different place than the day's own city — the country must
  // be dropped rather than feeding Discovery "Okinawa, China".
  it('drops the country when the evidence city is a different place than the day city', () => {
    expect(discoveryCountryForDay({
      resolvedCity: 'Okinawa',
      resolvedCountry: 'CN',
      resolvedCountryEvidenceCity: 'Shanghai',
    })).toBeNull();
  });

  // Melaka case (pinned by backend/tests/trips.test.js:220): the country
  // comes from a different LAYER (hotel) than the city (override), but the
  // hotel names the SAME city — the country is correct and must be kept.
  it('keeps the country when the evidence city matches the day city, even from a different layer', () => {
    expect(discoveryCountryForDay({
      resolvedCity: 'Melaka',
      resolvedCountry: 'MY',
      resolvedCountryEvidenceCity: 'Melaka',
    })).toBe('MY');
  });

  // Hotel city-demote case: the country's evidence layer named no city at
  // all — nothing contradicts the day's own city, so keep the country.
  it('keeps the country when the evidence city is null', () => {
    expect(discoveryCountryForDay({
      resolvedCity: 'Melaka',
      resolvedCountry: 'MY',
      resolvedCountryEvidenceCity: null,
    })).toBe('MY');
  });

  it('falls back to day.city when resolvedCity is absent', () => {
    expect(discoveryCountryForDay({
      city: 'Melaka',
      resolvedCountry: 'MY',
      resolvedCountryEvidenceCity: 'Melaka',
    })).toBe('MY');

    expect(discoveryCountryForDay({
      city: 'Melaka',
      resolvedCountry: 'MY',
      resolvedCountryEvidenceCity: 'Shanghai',
    })).toBeNull();
  });

  it('keeps the country when the day has no city at all to compare against', () => {
    expect(discoveryCountryForDay({
      resolvedCountry: 'MY',
      resolvedCountryEvidenceCity: 'Melaka',
    })).toBe('MY');
  });

  // Same normaliser as canonicalGeoKey — spelling/punctuation variants of the
  // same city must not be treated as a contradiction.
  it('is punctuation/case-insensitive via canonicalGeoKey', () => {
    expect(discoveryCountryForDay({
      resolvedCity: 'Cheng Du',
      resolvedCountry: 'CN',
      resolvedCountryEvidenceCity: 'chengdu',
    })).toBe('CN');
  });
});
