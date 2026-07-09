import { getDb } from '../db/database.js';
import { cityFromIata, cityFromAirportString, canonicalCity } from '../utils/airports.js';
import { countryCodeFromName } from '../utils/countries.js';
import { resolveBookingDocuments } from './documents.js';
import { resolvePlace } from './placeResolver.js';
import { canonicalGeoKey, scopesMatch, knownCityLabel } from '../utils/geoIdentity.js';

function toIsoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function computeTripStatus(startDate, endDate, today = toIsoDate(new Date())) {
  if (today < startDate) return 'upcoming';
  if (today > endDate) return 'past';
  return 'active';
}

function mapTrip(row, today, destinations = [], destinationCountries = []) {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    destinations,
    destinationCountries,
    startDate: row.start_date,
    endDate: row.end_date,
    travellers: row.travellers,
    interestTags: parseJson(row.interest_tags, []),
    pace: row.pace,
    status: computeTripStatus(row.start_date, row.end_date, today),
    storedStatus: row.status,
    createdAt: row.created_at,
  };
}

function mapStop(row) {
  return {
    id: row.id,
    dayId: row.day_id,
    bookingId: row.booking_id,
    time: row.time,
    title: row.title,
    type: row.type,
    note: row.note,
    lat: row.lat,
    lng: row.lng,
    locationQuery: row.location_query,
    resolvedName: row.resolved_name,
    resolvedAddress: row.resolved_address,
    coordinateSystem: row.coordinate_system,
    coordinateSource: row.coordinate_source,
    locationStatus: row.location_status,
    locationConfidence: row.location_confidence,
    providerId: row.provider_id,
    unsplashPhotoUrl: row.unsplash_photo_url,
    estimatedCost: row.estimated_cost,
    bookingRequired: Boolean(row.booking_required),
    bestTime: row.best_time,
    duration: row.duration,
    sortOrder: row.sort_order,
    isFeatured: Boolean(row.is_featured),
    createdAt: row.created_at,
  };
}

function mapBooking(row) {
  const detailsJson = parseJson(row.details_json, {});
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    title: row.title,
    confirmationRef: row.confirmation_ref,
    bookingSource: row.booking_source,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    origin: row.origin,
    destination: row.destination,
    terminalOrStation: row.terminal_or_station,
    showInItinerary: Boolean(row.show_in_itinerary),
    originTz:      row.origin_tz      || null,
    destinationTz: row.destination_tz || null,
    detailsJson,
    createdAt: row.created_at,
    documents: resolveBookingDocuments(row.id, detailsJson),
  };
}

function eachDate(startDate, endDate) {
  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

// destinations accepts either the legacy string-array shape (["Chengdu"]), the Plan 6
// paired shape ([{ city, countryCode }]), or the Plan 9 chip shape ([{ city, countryCode,
// kind, placeId, bounds }]) — all normalize to { city, countryCode, kind, placeId, bounds }
// pairs. String items and object items missing kind/placeId/bounds get those fields as
// null so every caller can rely on the full shape being present.
function normalizeDestinationPairs(value) {
  if (!Array.isArray(value)) {
    const city = typeof value === 'string' ? value.trim() : '';
    return city ? [{ city, countryCode: null, kind: null, placeId: null, bounds: null }] : [];
  }

  return value
    .map((item) => {
      if (item && typeof item === 'object') {
        const city = String(item.city || '').trim();
        if (!city) return null;
        const rawCode = item.countryCode ? String(item.countryCode).trim() : '';
        const countryCode = rawCode ? (countryCodeFromName(rawCode) ?? rawCode.toUpperCase()) : null;
        const kind = item.kind ? String(item.kind) : null;
        const placeId = item.placeId ? String(item.placeId) : null;
        const bounds = item.bounds && typeof item.bounds === 'object' ? item.bounds : null;
        return { city, countryCode, kind, placeId, bounds };
      }
      const city = String(item || '').trim();
      return city ? { city, countryCode: null, kind: null, placeId: null, bounds: null } : null;
    })
    .filter(Boolean);
}

/**
 * Builds a trip's destination scopes — these are the "chips" a hotel's raw city evidence
 * is allowed to promote to (Task 2.1/2.2, Plan 8/9 Wave 2). Stored scopes (the trip's
 * persisted trip_scopes rows, position-ordered) come first, then any day-derived seed/
 * override label not already present is appended — so a chip with no matching day still
 * appears, and a day's raw seed still appears even on a trip with no stored scopes yet
 * (pre-Plan-9 trips, or the 023 backfill window). Deduped by canonicalGeoKey; a stored
 * scope's label/bounds win over a day-derived duplicate. Callers pass either mapped
 * camelCase days ({city, cityOverride}) or raw snake_case rows ({city, city_override}) —
 * both shapes are supported.
 * @param {Array<object>} days
 * @param {Array<{label: string, canonicalKey: string, boundsJson: string|null}>} storedScopes
 * @returns {Array<{label: string, canonicalKey: string, boundsJson: string|null}>}
 */
export function buildTripScopes(days, storedScopes = []) {
  const scopes = [];
  const seenKeys = new Set();

  for (const stored of storedScopes || []) {
    const key = stored.canonicalKey || canonicalGeoKey(stored.label);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    scopes.push({ label: stored.label, canonicalKey: key, boundsJson: stored.boundsJson ?? null });
  }

  const addLabel = (label) => {
    const trimmed = typeof label === 'string' ? label.trim() : '';
    if (!trimmed) return;
    const key = canonicalGeoKey(trimmed);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    scopes.push({ label: trimmed, canonicalKey: key, boundsJson: null });
  };

  for (const day of days || []) {
    addLabel(day.city);
    addLabel(day.cityOverride ?? day.city_override);
  }

  return scopes;
}

/**
 * Extracts a clean {city, countryCode, anchor} triple from a booking's structured
 * detailsJson. countryCode rides along from whichever extraction field matches that type
 * (destinationCountryCode for transit, countryCode for hotel/other) and is ALWAYS
 * contributed independently of whether the city resolves — per-field independence is
 * the point (Task 2.4/2.2).
 *
 * Hotel/other bookings run their raw city evidence through a promotion ladder (Task 2.2,
 * Plan 8 Wave 2, audit finding #1) instead of trusting it verbatim: structured fields
 * (locality/adminAreas.aal2/adminAreas.aal1, in that preference order) are tried first;
 * a legacy `d.city` string is the fallback only when none of those exist. The ordered
 * candidate list is evaluated in three passes — (1) does ANY candidate canonically match
 * one of the trip's destination scopes (a region-level admin area can still promote via
 * its trip chip, e.g. Bali's AAL1 matching a "Bali" chip even though the AAL2 evidence
 * doesn't); (2) does the locality candidate specifically look like a real city; (3) is
 * ANY candidate a known city name. If none of those fire, the city evidence is demoted to
 * null (never a raw, unrecognised fragment) and surfaces only via `anchor`; a console.warn
 * records the demotion for production measurement — never a throw.
 */
function extractGeoFromBooking(booking, tripScopes = []) {
  const d = booking.detailsJson || {};
  let city = null;
  let countryCode = null;
  let anchor = null;

  if (booking.type === 'hotel' || booking.type === 'other') {
    const structuredCandidates = [];
    if (d.locality) structuredCandidates.push({ value: d.locality, type: 'locality' });
    if (d.adminAreas?.aal2) structuredCandidates.push({ value: d.adminAreas.aal2, type: 'aal2' });
    if (d.adminAreas?.aal1) structuredCandidates.push({ value: d.adminAreas.aal1, type: 'aal1' });

    const candidates = structuredCandidates.length > 0
      ? structuredCandidates
      : (d.city ? [{ value: d.city, type: 'unknown' }] : []);

    if (candidates.length > 0) {
      // Rule 1: scope match, tried against every candidate in order.
      const scopeMatchCandidate = candidates.find(
        (c) => tripScopes.some((scope) => scopesMatch(c.value, scope.label)),
      );

      if (scopeMatchCandidate) {
        const matchedScope = tripScopes.find((scope) => scopesMatch(scopeMatchCandidate.value, scope.label));
        city = matchedScope.label;
      } else {
        // Rule 2: locality candidate only.
        const localityCandidate = candidates.find((c) => c.type === 'locality');
        if (localityCandidate) {
          city = localityCandidate.value;
        } else {
          // Rule 3: known-city, tried against every candidate in order.
          const knownCandidate = candidates.find((c) => knownCityLabel(c.value));
          if (knownCandidate) {
            city = canonicalCity(knownCandidate.value);
          } else {
            // Rule 4: demote — this is the production measurement instrument for plan risk #1.
            const demoted = candidates[0].value;
            console.warn('[geo] hotel city demoted to anchor', {
              tripId: booking.tripId,
              bookingId: booking.id,
              demoted,
              tripScopes: tripScopes.map((s) => s.label),
            });
            city = null;
          }
        }
      }
    }

    // The hotel always contributes its country, even when its city demotes.
    countryCode = d.countryCode || null;

    const anchorLabel = d.sublocality ?? d.locality ?? d.city;
    if (anchorLabel && canonicalGeoKey(anchorLabel) !== canonicalGeoKey(city)) {
      anchor = { label: anchorLabel, countryCode: countryCode ? String(countryCode).toUpperCase() : null };
    }
  } else if (booking.type === 'train' || booking.type === 'bus' || booking.type === 'ferry') {
    city = canonicalCity(d.destinationCity) || null;
    countryCode = d.destinationCountryCode || null;
  } else if (booking.type === 'flight') {
    if (d.destinationCity) {
      city = canonicalCity(d.destinationCity);
    } else {
      // Fall back: IATA from provider payload (AeroDataBox stores arrival.airport.iata)
      const iata = d.providerPayload?.arrival?.airport?.iata;
      city = iata ? cityFromIata(iata) : canonicalCity(cityFromAirportString(booking.destination));
    }
    countryCode = d.destinationCountryCode || null;
  }

  return {
    city,
    countryCode: countryCode ? String(countryCode).toUpperCase() : null,
    anchor,
  };
}

/**
 * Derives {city, countryCode, resolutionAnchor} for a single day given the full bookings
 * list and the trip's destination scopes (buildTripScopes — Task 2.1/2.4, Plan 8 Wave 2).
 *
 * Priority (unchanged from the original deriveDayCity):
 * 1. Manual city_override (+ city_override_country) on the day row
 * 2. Hotel booking active that night (check-in date ≤ day.date < check-out date)
 * 3. Last same-day transit arrival (flight/train/bus/ferry departing that day)
 * 4. Previous day's resolved pair
 * 5. Seeded day.city (+ day.city_country)
 *
 * City and country are picked independently, each as the first layer (in this order)
 * that has a non-null value — so they may come from different layers. E.g. an override
 * of "Melaka" with no country attached still wins the city; if the active hotel that
 * night reports countryCode "MY", the day resolves to { city: "Melaka", countryCode: "MY" }.
 *
 * `resolutionAnchor` is separate from the city/country ladder: it carries the active
 * hotel's raw evidence (locality/district/legacy city string) whenever that evidence is
 * more granular than — or was demoted in favour of — the resolved city, tagged
 * `{ label, countryCode, source: 'hotel' }`. It comes ONLY from the active-hotel layer,
 * regardless of which layer actually won the city, and is NEVER carried forward from
 * `previousResolvedGeo` — anchors are per-day evidence, not carried state.
 */
export function deriveDayGeo(day, bookings, previousResolvedGeo, tripScopes = []) {
  const overrideGeo = day.cityOverride
    ? { city: day.cityOverride, countryCode: day.cityOverrideCountry || null }
    : { city: null, countryCode: null };

  // Hotel active tonight: check-in ≤ day.date < check-out
  const activeHotel = bookings.find((b) => {
    if (b.type !== 'hotel') return false;
    const checkIn = b.startDatetime?.slice(0, 10);
    const checkOut = b.endDatetime?.slice(0, 10);
    return checkIn && checkOut && checkIn <= day.date && day.date < checkOut;
  });
  const hotelExtract = activeHotel
    ? extractGeoFromBooking(activeHotel, tripScopes)
    : { city: null, countryCode: null, anchor: null };
  const hotelGeo = { city: hotelExtract.city, countryCode: hotelExtract.countryCode };

  // Last same-day transit arrival
  const sameDayTransit = bookings
    .filter((b) => {
      const type = b.type;
      if (type !== 'flight' && type !== 'train' && type !== 'bus' && type !== 'ferry') return false;
      return b.startDatetime?.slice(0, 10) === day.date;
    })
    .sort((a, b) => (a.startDatetime || '').localeCompare(b.startDatetime || ''));
  let transitGeo = { city: null, countryCode: null };
  for (let i = sameDayTransit.length - 1; i >= 0; i--) {
    const geo = extractGeoFromBooking(sameDayTransit[i], tripScopes);
    if (geo.city) {
      transitGeo = geo;
      break;
    }
  }

  const previousGeo = previousResolvedGeo || { city: null, countryCode: null };
  const seedGeo = { city: day.city, countryCode: day.cityCountry || null };

  const layers = [overrideGeo, hotelGeo, transitGeo, previousGeo, seedGeo];
  return {
    city: layers.map((l) => l.city).find(Boolean) ?? null,
    countryCode: layers.map((l) => l.countryCode).find(Boolean) ?? null,
    resolutionAnchor: hotelExtract.anchor ? { ...hotelExtract.anchor, source: 'hotel' } : null,
  };
}

// Derives the legacy trips.destinations/destinationCountries response shape from a list of
// {city, cityCountry} pairs, unique by city, first-seen-in-day-order; a country is paired
// with its city's first occurrence and dropped (not nulled) if absent, matching the prior
// stored-column shape (Plan 6 Wave 4).
//
// Callers MUST pass each day's override-aware RESOLVED geo (resolvedCity/resolvedCountry —
// same precedence deriveDayGeo/listDaysForTrip already compute), not the raw seed
// days.city/days.city_country: a real production trip's multi-city identity can come
// entirely from an active hotel booking (layer 2), with every day's raw seed sharing one
// city — a seed-only derivation would silently collapse such a trip to one destination.
// This is a read-time fallback used only when no explicit edit is in flight
// (createTrip/updateTrip echo the caller's own input instead — see below).
export function deriveTripDestinationPairsFromDays(days) {
  const seen = new Set();
  const pairs = [];
  for (const day of days) {
    const city = day.city;
    if (!city || seen.has(city)) continue;
    seen.add(city);
    pairs.push({ city, countryCode: day.cityCountry || null });
  }
  return pairs;
}

export function deriveTripDestinationsFromDays(days) {
  const pairs = deriveTripDestinationPairsFromDays(days);
  return {
    destinations: pairs.map((p) => p.city),
    destinationCountries: pairs.map((p) => p.countryCode).filter(Boolean),
  };
}

/**
 * Loads a trip's persisted destination scopes (trip_scopes rows — Plan 9 Wave 2 §2.1),
 * position-ordered. This is the durable "what destinations does this trip have" list,
 * independent of what any day row currently resolves to.
 * @param {string} tripId
 * @returns {Array<{label, countryCode, kind, placeId, boundsJson, source, position, canonicalKey}>}
 */
export function listTripScopes(tripId) {
  const db = getDb();
  return db.prepare(`
    SELECT label, country_code, kind, place_id, bounds_json, source, position, canonical_key
    FROM trip_scopes
    WHERE trip_id = ?
    ORDER BY position ASC
  `).all(tripId).map((row) => ({
    label: row.label,
    countryCode: row.country_code,
    kind: row.kind,
    placeId: row.place_id,
    boundsJson: row.bounds_json,
    source: row.source,
    position: row.position,
    canonicalKey: row.canonical_key,
  }));
}

function insertTripScope(db, tripId, { label, countryCode, kind, placeId, bounds, source, position, canonicalKey }) {
  db.prepare(`
    INSERT INTO trip_scopes (trip_id, label, country_code, kind, place_id, bounds_json, source, canonical_key, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    label,
    countryCode || null,
    kind || null,
    placeId || null,
    bounds ? JSON.stringify(bounds) : null,
    source,
    canonicalKey,
    position,
  );
}

// Writes one trip_scopes row per submitted chip, in the caller's transaction — used only
// by createTrip, where every chip is brand new (no reconcile needed against prior rows).
// Chips with a blank or duplicate canonicalKey are skipped (first-seen wins).
function seedTripScopesFromChips(db, tripId, destinationPairs) {
  const seenKeys = new Set();
  let position = 0;
  for (const pair of destinationPairs) {
    const canonicalKey = canonicalGeoKey(pair.city);
    if (!canonicalKey || seenKeys.has(canonicalKey)) continue;
    seenKeys.add(canonicalKey);
    insertTripScope(db, tripId, {
      label: pair.city,
      countryCode: pair.countryCode,
      kind: pair.kind,
      placeId: pair.placeId,
      bounds: pair.bounds,
      source: pair.kind === 'freetext' ? 'freetext' : 'picker',
      position,
      canonicalKey,
    });
    position += 1;
  }
}

// Reconciles a trip's persisted scope rows against a freshly submitted chip list
// (updateTrip's destination chip editor — Plan 9 Wave 2 §2.2). Days are never touched:
// this only adds/updates/removes trip_scopes rows. A submitted chip that matches an
// existing row's canonicalKey UPDATEs that row's position/label, and only overwrites
// country/kind/placeId/bounds when the submitted chip actually carries them — so
// re-submitting a chip the client loaded from `scopes` (which never carries bounds/
// placeId) doesn't wipe out bounds a previous picker selection stored. A submitted chip
// with no matching row is INSERTed fresh. Any existing row whose canonicalKey isn't in
// the new submitted set is DELETEd.
function reconcileTripScopes(db, tripId, destinationPairs) {
  const existingScopes = listTripScopes(tripId);
  const existingByKey = new Map(existingScopes.map((scope) => [scope.canonicalKey, scope]));

  const newKeys = new Set();
  const dedupedPairs = [];
  for (const pair of destinationPairs) {
    const canonicalKey = canonicalGeoKey(pair.city);
    if (!canonicalKey || newKeys.has(canonicalKey)) continue;
    newKeys.add(canonicalKey);
    dedupedPairs.push({ ...pair, canonicalKey });
  }

  for (const scope of existingScopes) {
    if (!newKeys.has(scope.canonicalKey)) {
      db.prepare('DELETE FROM trip_scopes WHERE trip_id = ? AND canonical_key = ?').run(tripId, scope.canonicalKey);
    }
  }

  const updateStmt = db.prepare(`
    UPDATE trip_scopes
    SET position = ?, label = ?, country_code = ?, kind = ?, place_id = ?, bounds_json = ?
    WHERE trip_id = ? AND canonical_key = ?
  `);

  dedupedPairs.forEach((pair, position) => {
    const existing = existingByKey.get(pair.canonicalKey);
    if (existing) {
      const providesBounds = pair.placeId || pair.bounds;
      updateStmt.run(
        position,
        pair.city,
        providesBounds ? (pair.countryCode || null) : existing.countryCode,
        providesBounds ? (pair.kind || null) : existing.kind,
        providesBounds ? (pair.placeId || null) : existing.placeId,
        providesBounds ? (pair.bounds ? JSON.stringify(pair.bounds) : null) : existing.boundsJson,
        tripId,
        pair.canonicalKey,
      );
    } else {
      insertTripScope(db, tripId, {
        label: pair.city,
        countryCode: pair.countryCode,
        kind: pair.kind,
        placeId: pair.placeId,
        bounds: pair.bounds,
        source: pair.kind === 'freetext' ? 'freetext' : 'picker',
        position,
        canonicalKey: pair.canonicalKey,
      });
    }
  });
}

/**
 * Combines a trip's persisted scopes with its day-derived resolved pairs into the
 * legacy trips.destinations/destinationCountries response shape (Plan 9 Wave 2 §2.2).
 * Stored scopes come first, in position order — they are the durable, user-edited
 * destination list — followed by any day-resolved city not already covered (dedup by
 * canonicalGeoKey), so a city only ever reached via booking resolution (never an
 * explicit chip) still surfaces. destinationCountries preserves the legacy
 * pairs.map(p => p.countryCode).filter(Boolean) shape/quirk exactly — a scope's country
 * comes from its own country_code.
 * @param {Array<{label, countryCode, canonicalKey}>} storedScopes
 * @param {Array<{city, countryCode}>} dayDerivedPairs
 * @returns {{destinations: string[], destinationCountries: string[]}}
 */
export function mergeDestinationsWithScopes(storedScopes, dayDerivedPairs) {
  const seenKeys = new Set();
  const pairs = [];

  for (const scope of storedScopes || []) {
    const canonicalKey = scope.canonicalKey || canonicalGeoKey(scope.label);
    if (!canonicalKey || seenKeys.has(canonicalKey)) continue;
    seenKeys.add(canonicalKey);
    pairs.push({ city: scope.label, countryCode: scope.countryCode || null });
  }

  for (const pair of dayDerivedPairs || []) {
    const canonicalKey = canonicalGeoKey(pair.city);
    if (!canonicalKey || seenKeys.has(canonicalKey)) continue;
    seenKeys.add(canonicalKey);
    pairs.push({ city: pair.city, countryCode: pair.countryCode || null });
  }

  return {
    destinations: pairs.map((p) => p.city),
    destinationCountries: pairs.map((p) => p.countryCode).filter(Boolean),
  };
}

export function assertTripAccess(userId, tripId) {
  const db = getDb();
  const trip = db.prepare(`
    SELECT t.*
    FROM trips t
    LEFT JOIN trip_collaborators tc ON tc.trip_id = t.id
    WHERE t.id = ?
      AND (t.owner_id = ? OR tc.user_id = ?)
    LIMIT 1
  `).get(tripId, userId, userId);

  if (!trip) {
    throw Object.assign(new Error('Trip not found'), { status: 404 });
  }

  return trip;
}

export function assertDayAccess(userId, dayId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT d.*, t.owner_id
    FROM days d
    JOIN trips t ON t.id = d.trip_id
    LEFT JOIN trip_collaborators tc ON tc.trip_id = t.id
    WHERE d.id = ?
      AND (t.owner_id = ? OR tc.user_id = ?)
    LIMIT 1
  `).get(dayId, userId, userId);

  if (!row) {
    throw Object.assign(new Error('Day not found'), { status: 404 });
  }

  return row;
}

export function assertStopAccess(userId, stopId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT s.*, d.trip_id
    FROM stops s
    JOIN days d ON d.id = s.day_id
    JOIN trips t ON t.id = d.trip_id
    LEFT JOIN trip_collaborators tc ON tc.trip_id = t.id
    WHERE s.id = ?
      AND (t.owner_id = ? OR tc.user_id = ?)
    LIMIT 1
  `).get(stopId, userId, userId);

  if (!row) {
    throw Object.assign(new Error('Stop not found'), { status: 404 });
  }

  return row;
}

export function assertBookingAccess(userId, bookingId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT b.*
    FROM bookings b
    JOIN trips t ON t.id = b.trip_id
    LEFT JOIN trip_collaborators tc ON tc.trip_id = t.id
    WHERE b.id = ?
      AND (t.owner_id = ? OR tc.user_id = ?)
    LIMIT 1
  `).get(bookingId, userId, userId);

  if (!row) {
    throw Object.assign(new Error('Booking not found'), { status: 404 });
  }

  return row;
}

export function listTripsForUser(userId, { today = toIsoDate(new Date()) } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT t.*
    FROM trips t
    LEFT JOIN trip_collaborators tc ON tc.trip_id = t.id
    WHERE t.owner_id = ? OR tc.user_id = ?
    ORDER BY t.start_date ASC, t.created_at ASC
  `).all(userId, userId);

  return rows.map((row) => {
    const bookings = listBookingsForTrip(row.id);
    const days = listDaysForTrip(row.id, userId, bookings);
    const dayDerivedPairs = deriveTripDestinationPairsFromDays(
      days.map((d) => ({ city: d.resolvedCity, cityCountry: d.resolvedCountry })),
    );
    const { destinations, destinationCountries } = mergeDestinationsWithScopes(
      listTripScopes(row.id), dayDerivedPairs,
    );
    return mapTrip(row, today, destinations, destinationCountries);
  });
}

export function createTrip(userId, input) {
  const db = getDb();
  const title = input.title?.trim();
  const startDate = input.startDate;
  const endDate = input.endDate;

  if (!title || !startDate || !endDate) {
    throw Object.assign(new Error('title, startDate, and endDate are required'), {
      status: 400,
    });
  }

  if (endDate < startDate) {
    throw Object.assign(new Error('endDate must be on or after startDate'), {
      status: 400,
    });
  }

  const destinationPairs = normalizeDestinationPairs(input.destinations);
  const destinations = destinationPairs.map((pair) => pair.city);
  const legacyCountries = normalizeArray(input.destinationCountries)
    .map((raw) => countryCodeFromName(raw) ?? raw);
  const pairCountries = destinationPairs.map((pair) => pair.countryCode).filter(Boolean);
  const destinationCountries = legacyCountries.length ? legacyCountries : pairCountries;
  // Scope rows carry each chip's own countryCode; the legacy destinationCountries array
  // (a separate, positional list some older callers still send) fills in only when a
  // given pair has no embedded country of its own.
  const scopeSeedPairs = destinationPairs.map((pair, index) => ({
    ...pair,
    countryCode: pair.countryCode || destinationCountries[index] || null,
  }));
  const interestTags = normalizeArray(input.interestTags);
  const defaultCity = destinations[0] || title;
  const defaultCityCountry = destinationPairs[0]?.countryCode || destinationCountries[0] || null;
  const tripDates = eachDate(startDate, endDate);

  const create = db.transaction(() => {
    const trip = db.prepare(`
      INSERT INTO trips (
        title, owner_id, start_date, end_date,
        travellers, interest_tags, pace, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming')
      RETURNING id
    `).get(
      title,
      userId,
      startDate,
      endDate,
      input.travellers || 'couple',
      JSON.stringify(interestTags),
      input.pace || 'moderate',
    );

    const insertDay = db.prepare(`
      INSERT INTO days (trip_id, date, city, phase, hotel, theme, color_code, city_country)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const date of tripDates) {
      insertDay.run(
        trip.id,
        date,
        defaultCity,
        null,
        null,
        null,
        null,
        defaultCityCountry,
      );
    }

    seedTripScopesFromChips(db, trip.id, scopeSeedPairs);

    return trip.id;
  });

  const tripId = create();
  return getTripDetail(tripId, userId);
}

export function updateTrip(userId, tripId, input) {
  const db = getDb();
  const existingRow = assertTripAccess(userId, tripId);

  const title = input.title?.trim() || existingRow.title;
  const travellers = input.travellers || existingRow.travellers;
  const pace = input.pace || existingRow.pace;
  const interestTags = input.interestTags !== undefined
    ? normalizeArray(input.interestTags)
    : parseJson(existingRow.interest_tags, []);

  // Destination chip-list edit (Plan 9 Wave 2 §2.2): reconciles the trip's persisted
  // trip_scopes rows against the submitted chip list — days are NEVER rewritten by a
  // chip edit (the old positional rename/removal heuristic that rewrote days.city/
  // city_country on matching-seed days is removed; see git history for that block).
  // When `destinations` isn't part of this input, no reconcile runs and getTripDetail's
  // scope+day merge reflects whatever scopes already exist.
  if (input.destinations !== undefined) {
    const newPairs = normalizeDestinationPairs(input.destinations);
    const reconcile = db.transaction(() => {
      reconcileTripScopes(db, tripId, newPairs);
    });
    reconcile();
  }

  let newEndDate = existingRow.end_date;
  let newStartDate = existingRow.start_date;

  if (input.startDate && input.startDate !== existingRow.start_date) {
    if (input.startDate > existingRow.start_date) {
      // Block shortening from the front if any removed day has stops
      const blockedDay = db.prepare(`
        SELECT d.date FROM days d
        JOIN stops s ON s.day_id = d.id
        WHERE d.trip_id = ? AND d.date < ?
        ORDER BY d.date ASC LIMIT 1
      `).get(tripId, input.startDate);

      if (blockedDay) {
        throw Object.assign(
          new Error(`Cannot shorten trip — ${blockedDay.date} has stops. Remove them first.`),
          { status: 400 },
        );
      }
      db.prepare('DELETE FROM days WHERE trip_id = ? AND date < ?').run(tripId, input.startDate);
      newStartDate = input.startDate;
    } else {
      // Extension backward — seed new days from the day that is currently first,
      // not the trip's first destination (that day's city may have been overridden
      // or derived from a later booking and no longer matches destinations[0]).
      const firstDay = db.prepare('SELECT city, city_country FROM days WHERE trip_id = ? AND date = ?').get(tripId, existingRow.start_date);
      const seedCity = firstDay?.city || existingRow.title;
      const seedCountry = firstDay?.city_country || null;
      const beforeCurrent = new Date(`${existingRow.start_date}T00:00:00Z`);
      beforeCurrent.setUTCDate(beforeCurrent.getUTCDate() - 1);
      const newDates = eachDate(input.startDate, beforeCurrent.toISOString().slice(0, 10));
      const insertDay = db.prepare('INSERT INTO days (trip_id, date, city, city_country) VALUES (?, ?, ?, ?)');
      for (const date of newDates) {
        insertDay.run(tripId, date, seedCity, seedCountry);
      }
      newStartDate = input.startDate;
    }
  }

  if (input.endDate && input.endDate !== existingRow.end_date) {
    if (input.endDate < existingRow.end_date) {
      // Block shortening if any removed day has stops
      const blockedDay = db.prepare(`
        SELECT d.date FROM days d
        JOIN stops s ON s.day_id = d.id
        WHERE d.trip_id = ? AND d.date > ?
        ORDER BY d.date DESC LIMIT 1
      `).get(tripId, input.endDate);

      if (blockedDay) {
        throw Object.assign(
          new Error(`Cannot shorten trip — ${blockedDay.date} has stops. Remove them first.`),
          { status: 400 },
        );
      }
      db.prepare('DELETE FROM days WHERE trip_id = ? AND date > ?').run(tripId, input.endDate);
      newEndDate = input.endDate;
    } else {
      // Extension forward — seed from the day that is currently last (fixes the prior
      // defect of seeding from destinations[0], which is wrong once the trip's real
      // last-day city has diverged from its first destination, e.g. a multi-city trip).
      const lastDay = db.prepare('SELECT city, city_country FROM days WHERE trip_id = ? AND date = ?').get(tripId, existingRow.end_date);
      const seedCity = lastDay?.city || existingRow.title;
      const seedCountry = lastDay?.city_country || null;
      const afterCurrent = new Date(`${existingRow.end_date}T00:00:00Z`);
      afterCurrent.setUTCDate(afterCurrent.getUTCDate() + 1);
      const newDates = eachDate(afterCurrent.toISOString().slice(0, 10), input.endDate);
      const insertDay = db.prepare('INSERT INTO days (trip_id, date, city, city_country) VALUES (?, ?, ?, ?)');
      for (const date of newDates) {
        insertDay.run(tripId, date, seedCity, seedCountry);
      }
      newEndDate = input.endDate;
    }
  }

  db.prepare(`
    UPDATE trips SET title = ?, travellers = ?, interest_tags = ?, pace = ?, start_date = ?, end_date = ?
    WHERE id = ?
  `).run(
    title, travellers, JSON.stringify(interestTags), pace, newStartDate, newEndDate, tripId,
  );

  return getTripDetail(tripId, userId);
}

export function listBookingsForTrip(tripId) {
  return getDb().prepare(`
    SELECT *
    FROM bookings
    WHERE trip_id = ?
    ORDER BY COALESCE(start_datetime, end_datetime, created_at) ASC, created_at ASC
  `).all(tripId).map(mapBooking);
}

export function listDaysForTrip(tripId, userId, bookings = []) {
  assertTripAccess(userId, tripId);
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.*, COUNT(s.id) AS stop_count
    FROM days d
    LEFT JOIN stops s ON s.day_id = d.id
    WHERE d.trip_id = ?
    GROUP BY d.id
    ORDER BY d.date ASC
  `).all(tripId);

  const tripScopes = buildTripScopes(
    rows.map((row) => ({ city: row.city, cityOverride: row.city_override })),
    listTripScopes(tripId),
  );

  let previousResolvedGeo = null;
  return rows.map((row, index) => {
    const day = {
      id: row.id,
      tripId: row.trip_id,
      date: row.date,
      city: row.city,
      cityOverride: row.city_override ?? null,
      cityCountry: row.city_country ?? null,
      cityOverrideCountry: row.city_override_country ?? null,
      phase: row.phase,
      hotel: row.hotel,
      theme: row.theme,
      colorCode: row.color_code,
      stopCount: row.stop_count,
      dayIndex: index,
    };
    const geo = deriveDayGeo(day, bookings, previousResolvedGeo, tripScopes);
    previousResolvedGeo = geo;
    return {
      ...day,
      resolvedCity: geo.city,
      resolvedCountry: geo.countryCode,
      resolutionAnchor: geo.resolutionAnchor,
    };
  });
}

/**
 * Derives {city, countryCode} for a single day by id — loads the trip's bookings and
 * walks the day sequence up to (and including) the target date so layer 4 (previous-day
 * carry) is correct. Used by geocoding-bias callers that only have a dayId, not a full
 * pre-loaded day list (stops.js).
 */
export function getDayGeo(dayId) {
  const db = getDb();
  const targetDay = db.prepare('SELECT * FROM days WHERE id = ?').get(dayId);
  if (!targetDay) return { city: null, countryCode: null, resolutionAnchor: null };

  const bookings = listBookingsForTrip(targetDay.trip_id);
  // Scopes are built from ALL of the trip's days (not just the ones up to the target
  // date) — a hotel evidence match should still be able to promote via a scope defined
  // by a later day — but the fold itself only replays days up to and including the
  // target date, so layer 4 (previous-day carry) stays correct.
  const allRows = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY date ASC').all(targetDay.trip_id);
  const tripScopes = buildTripScopes(
    allRows.map((row) => ({ city: row.city, cityOverride: row.city_override })),
    listTripScopes(targetDay.trip_id),
  );
  const rows = allRows.filter((row) => row.date <= targetDay.date);

  let previousResolvedGeo = null;
  let geo = { city: null, countryCode: null, resolutionAnchor: null };
  for (const row of rows) {
    const day = {
      date: row.date,
      city: row.city,
      cityOverride: row.city_override ?? null,
      cityCountry: row.city_country ?? null,
      cityOverrideCountry: row.city_override_country ?? null,
    };
    geo = deriveDayGeo(day, bookings, previousResolvedGeo, tripScopes);
    previousResolvedGeo = geo;
  }
  return geo;
}

export function getTripDetail(tripId, userId, { today = toIsoDate(new Date()) } = {}) {
  const tripRow = assertTripAccess(userId, tripId);
  const db = getDb();

  // Load bookings first so deriveDayGeo can use them when building days
  const bookings = listBookingsForTrip(tripId);

  const days = listDaysForTrip(tripId, userId, bookings);

  const storedScopes = listTripScopes(tripId);
  const dayDerivedPairs = deriveTripDestinationPairsFromDays(
    days.map((d) => ({ city: d.resolvedCity, cityCountry: d.resolvedCountry })),
  );
  const { destinations, destinationCountries } = mergeDestinationsWithScopes(storedScopes, dayDerivedPairs);
  const trip = mapTrip(tripRow, today, destinations, destinationCountries);
  trip.scopes = storedScopes.map((scope) => ({
    label: scope.label,
    countryCode: scope.countryCode,
    kind: scope.kind,
    source: scope.source,
  }));

  const stops = db.prepare(`
    SELECT *
    FROM stops
    WHERE day_id IN (SELECT id FROM days WHERE trip_id = ?)
    ORDER BY sort_order ASC, created_at ASC
  `).all(tripId).map(mapStop);
  const stopsByDay = new Map(days.map((day) => [day.id, []]));

  for (const stop of stops) {
    if (!stopsByDay.has(stop.dayId)) stopsByDay.set(stop.dayId, []);
    stopsByDay.get(stop.dayId).push(stop);
  }

  return {
    trip,
    days: days.map((day) => ({
      ...day,
      stops: stopsByDay.get(day.id) || [],
    })),
    bookings,
  };
}

export function deleteTrip(userId, tripId) {
  const trip = assertTripAccess(userId, tripId);
  if (trip.owner_id !== userId) {
    throw Object.assign(new Error('Only the trip owner can delete this trip'), { status: 403 });
  }
  const db = getDb();
  db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
  return { deleted: true };
}

// Resolves the override's country from the typed text: first try a trailing-comma-segment
// country-name/code match ("Melaka, Malaysia" -> "MY"), else fall back to the same place
// resolver stops.js uses (cache-first, Nominatim/Google Places network lookup keyed on the
// city text). Returns null if neither yields a country — acceptable, per Wave 2 §2.3 the
// precedence chain already tolerates a null-country day.
async function resolveOverrideCountry(cityOverride) {
  if (!cityOverride) return null;
  const fromName = countryCodeFromName(cityOverride);
  if (fromName) return fromName;

  try {
    const resolution = await resolvePlace({ queryText: cityOverride, city: cityOverride });
    return resolution?.countryCode || null;
  } catch {
    return null;
  }
}

export async function updateDayCityOverride(userId, tripId, date, cityOverride) {
  assertTripAccess(userId, tripId);
  const db = getDb();
  const cityOverrideCountry = await resolveOverrideCountry(cityOverride);
  const result = db.prepare(`
    UPDATE days SET city_override = ?, city_override_country = ? WHERE trip_id = ? AND date = ?
    RETURNING id, date, city_override, city_override_country
  `).get(cityOverride ?? null, cityOverrideCountry, tripId, date);
  if (!result) throw Object.assign(new Error('Day not found'), { status: 404 });
  return {
    date: result.date,
    cityOverride: result.city_override,
    cityOverrideCountry: result.city_override_country,
  };
}
