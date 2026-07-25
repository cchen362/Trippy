import { describe, expect, it } from 'vitest';
import { googlePlaceIdForStop } from '../src/utils/googlePlaceIdentity.js';

// Pure unit tests over googlePlaceIdForStop(row) — a raw snake_case `stops` row, no DB
// access. One case per row of review §5's scenario table (2026-07-25 review, Plan 24 W2),
// plus edge cases pinning the deliberate implementation choices called out in the
// function's own comments (positive prefix allowlist, snake_case-only, no denylist).

// A fully "safe" base row satisfying all five clauses — each row test overrides only
// the field(s) that distinguish that scenario, so a failure points at the right clause.
function safeRow(overrides = {}) {
  return {
    provider_id: 'google:ChIJ_test_place_id',
    location_status: 'resolved',
    coordinate_source: 'places',
    coordinate_system: 'wgs84',
    lat: 29.5,
    lng: 106.5,
    country_code: 'CN',
    ...overrides,
  };
}

describe('googlePlaceIdForStop — review §5 scenario rows', () => {
  it('row 1 — Google picker (Add Place / Discovery "On the map") returns the bare id', () => {
    const row = safeRow({ provider_id: 'google:ChIJ_add_place_pick' });
    expect(googlePlaceIdForStop(row)).toBe('ChIJ_add_place_pick');
  });

  it('row 2 — Map "Check location" picked a Google result returns the bare id', () => {
    const row = safeRow({ provider_id: 'google:ChIJ_check_location_pick' });
    expect(googlePlaceIdForStop(row)).toBe('ChIJ_check_location_pick');
  });

  it('row 3 — Google resolver fallback (CN un-shifted to true WGS-84) returns the bare id', () => {
    const row = safeRow({ provider_id: 'google:ChIJ_resolver_fallback', country_code: 'CN' });
    expect(googlePlaceIdForStop(row)).toBe('ChIJ_resolver_fallback');
  });

  it('row 4 — hotel/booking sync with details.placeId returns the bare id even with country_code null', () => {
    // Per §5 row 4, bookingPlaceLocation() always stamps countryCode: null — proving
    // country is not one of the five clauses, only lat/lng/provider_id/status/source/system are.
    const row = safeRow({ provider_id: 'google:ChIJ_booking_sync', country_code: null });
    expect(googlePlaceIdForStop(row)).toBe('ChIJ_booking_sync');
  });

  it('row 5 — Discovery verified fast path with a google:* placeRef returns the bare id', () => {
    const row = safeRow({ provider_id: 'google:ChIJ_discovery_fast_path' });
    expect(googlePlaceIdForStop(row)).toBe('ChIJ_discovery_fast_path');
  });

  it('row 6 — Discovery fast path with an OSM way:* placeRef, coordinate_source hard-coded to places, returns null (F12)', () => {
    // The discovery trusted-capture path stamps coordinate_source: 'places' even when
    // placeRef is a non-Google identity. Clause 1's positive google: prefix allowlist is
    // exactly what stops this from being treated as a safe Google id.
    const row = safeRow({ provider_id: 'way:123', coordinate_source: 'places' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 7 — Nominatim/OSM resolution (way:<id> / manual_lookup / estimated) returns null', () => {
    const row = safeRow({
      provider_id: 'way:987654',
      location_status: 'estimated',
      coordinate_source: 'manual_lookup',
    });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 8 — curated seed (curated:<slug> / curated source) returns null', () => {
    const row = safeRow({
      provider_id: 'curated:raffles-city-chongqing',
      coordinate_source: 'curated',
    });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 9 — manual panned pin (provider_id NULL, user_pin, user_confirmed) returns null', () => {
    const row = safeRow({
      provider_id: null,
      location_status: 'user_confirmed',
      coordinate_source: 'user_pin',
    });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 10 — estimated stop stamped with a resolver Google id (RC-4 stale pairing) returns null', () => {
    // stops.js:220-233 — the resolver's id paired with the CALLER's coordinates, at
    // locationStatus 'estimated'. Identity and coordinates may describe different
    // places, so this is the genuinely dangerous case §4/§10 calls out by name.
    const row = safeRow({ provider_id: 'google:ChIJ_stale_resolver_id', location_status: 'estimated' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 11 — cache read below the 0.7 confidence threshold (google:* but estimated) returns null', () => {
    const row = safeRow({ provider_id: 'google:ChIJ_low_confidence_cache', location_status: 'estimated' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 12 — legacy row with coordinate_system unknown returns null', () => {
    const row = safeRow({ provider_id: 'google:ChIJ_legacy_row', coordinate_system: 'unknown' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('row 13 — unresolved stop with no coordinates returns null', () => {
    const row = safeRow({
      provider_id: null,
      location_status: 'unresolved',
      coordinate_source: null,
      coordinate_system: 'unknown',
      lat: null,
      lng: null,
    });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });
});

describe('googlePlaceIdForStop — edge cases pinning deliberate implementation choices', () => {
  it('provider_id "google:" with an empty suffix returns null (an id must actually exist after the prefix)', () => {
    const row = safeRow({ provider_id: 'google:' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('provider_id "googleplaces:abc" returns null — proves the gate is the literal "google:" prefix, not a "google" substring', () => {
    const row = safeRow({ provider_id: 'googleplaces:abc' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('non-string provider_id (number) returns null without throwing', () => {
    const row = safeRow({ provider_id: 42 });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('non-string provider_id (object) returns null without throwing', () => {
    const row = safeRow({ provider_id: { id: 'google:whoops' } });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('lat/lng NaN returns null', () => {
    const row = safeRow({ lat: NaN, lng: NaN });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('lat/lng Infinity returns null', () => {
    const row = safeRow({ lat: Infinity, lng: -Infinity });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('lat/lng as strings (not actual numbers) returns null — Number.isFinite rejects string types', () => {
    const row = safeRow({ lat: '29.5', lng: '106.5' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('null row returns null without throwing', () => {
    expect(googlePlaceIdForStop(null)).toBeNull();
  });

  it('undefined row returns null without throwing', () => {
    expect(googlePlaceIdForStop(undefined)).toBeNull();
  });

  it('a camelCase-shaped row (providerId/locationStatus/coordinateSource/coordinateSystem) returns null', () => {
    // The helper deliberately reads only snake_case fields — both real callers
    // (mapData.js formatMapStop, trips.js mapStop) pass raw DB rows. This test pins
    // that choice: a dual-shape fallback would silently mask a mis-shaped caller
    // instead of surfacing the bug loudly (undefined provider_id -> not a string -> null).
    const row = {
      providerId: 'google:ChIJ_camel_case',
      locationStatus: 'resolved',
      coordinateSource: 'places',
      coordinateSystem: 'wgs84',
      lat: 29.5,
      lng: 106.5,
    };
    expect(googlePlaceIdForStop(row)).toBeNull();
  });

  it('a CN stop stored gcj02 carrying a valid google: id returns null via clause 4 (§5 row 14 contribution)', () => {
    // Google Maps deep links always expect WGS-84; a google: id paired with a stored
    // gcj02 datum would misplace the pin relative to the id's real location.
    const row = safeRow({ coordinate_system: 'gcj02', country_code: 'CN' });
    expect(googlePlaceIdForStop(row)).toBeNull();
  });
});
