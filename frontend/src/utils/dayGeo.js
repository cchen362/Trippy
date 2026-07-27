import { canonicalGeoKey } from './geoIdentity.js';

// Shared display-label helper for a day's geography. `resolvedCity` is the
// derived, always-scope-grade city name (already reflects any override); the
// raw seed `city` is only a fallback for days that haven't been resolved yet.
export function dayDisplayLabel(day) {
  return day?.resolvedCity ?? day?.city ?? '';
}

// Discovery-only trust rule (Plan 26 W4.2, F-26-10). A day's city and country
// resolve independently through five evidence layers (override > hotel >
// transit > previous day > seed) — a day can perfectly legitimately get its
// city from one layer and its country from another. Trip chips and backend
// geocoding bias are fine with that cross-layer pairing. Discovery is not:
// asking Claude for places in "冲绳, China" (Okinawa's country inherited from
// *yesterday's* Shanghai carry, because the override that named Okinawa
// carried no country of its own) produces a catalogue verified against the
// wrong country entirely.
//
// The fix is deliberately a CITY comparison, not a LAYER comparison — which
// layer supplied the country is not what makes it wrong; contradicting the
// day's own city is. Proof this has to be city-based: the pinned Melaka case
// (backend/tests/trips.test.js:220) types "Melaka" as a day override with no
// country, and a same-night hotel booking supplies {Melaka, MY}. The country
// there comes from a DIFFERENT layer than the city too (hotel vs. override) —
// exactly the same cross-layer shape as Okinawa — yet it's correct and must
// be kept, because the hotel's city (Melaka) matches the day's city (Melaka).
// A layer-based rule would have to special-case Melaka; a city-based rule
// gets it right for free by checking the only thing that actually matters.
export function discoveryCountryForDay(day) {
  const country = day?.resolvedCountry;
  if (!country) return null;

  const evidenceCity = day?.resolvedCountryEvidenceCity;
  const dayCity = day?.resolvedCity ?? day?.city;
  // No named evidence city (e.g. a hotel-derived country demoted the day's
  // city to null) or no day city to compare against — nothing contradicts
  // the country, so keep it.
  if (!evidenceCity || !dayCity) return country;

  return canonicalGeoKey(evidenceCity) === canonicalGeoKey(dayCity) ? country : null;
}
