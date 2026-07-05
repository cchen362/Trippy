import { getDb } from '../db/database.js';
import { cityFromIata, cityFromAirportString, canonicalCity } from '../utils/airports.js';
import { countryCodeFromName } from '../utils/countries.js';
import { resolveBookingDocuments } from './documents.js';

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

function mapTrip(row, today) {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    destinations: parseJson(row.destinations, []),
    destinationCountries: parseJson(row.destination_countries, []),
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

// destinations accepts either the legacy string-array shape (["Chengdu"]) or the new
// paired shape ([{ city, countryCode }]) — both normalize to { city, countryCode } pairs.
function normalizeDestinationPairs(value) {
  if (!Array.isArray(value)) {
    const city = typeof value === 'string' ? value.trim() : '';
    return city ? [{ city, countryCode: null }] : [];
  }

  return value
    .map((item) => {
      if (item && typeof item === 'object') {
        const city = String(item.city || '').trim();
        if (!city) return null;
        const rawCode = item.countryCode ? String(item.countryCode).trim() : '';
        const countryCode = rawCode ? (countryCodeFromName(rawCode) ?? rawCode.toUpperCase()) : null;
        return { city, countryCode };
      }
      const city = String(item || '').trim();
      return city ? { city, countryCode: null } : null;
    })
    .filter(Boolean);
}

/**
 * Extracts a clean {city, countryCode} pair from a booking's structured detailsJson.
 * City follows the existing per-type rules; countryCode rides along from whichever
 * extraction field matches that type (destinationCountryCode for transit, countryCode
 * for hotel/other). Either half may be null — never guessed.
 */
function extractGeoFromBooking(booking) {
  const d = booking.detailsJson || {};
  let city = null;
  let countryCode = null;

  if (booking.type === 'hotel' || booking.type === 'other') {
    city = canonicalCity(d.city) || null;
    countryCode = d.countryCode || null;
  } else if (booking.type === 'train' || booking.type === 'bus') {
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

  return { city, countryCode: countryCode ? String(countryCode).toUpperCase() : null };
}

/**
 * Derives {city, countryCode} for a single day given the full bookings list.
 *
 * Priority (unchanged from the original deriveDayCity):
 * 1. Manual city_override (+ city_override_country) on the day row
 * 2. Hotel booking active that night (check-in date ≤ day.date < check-out date)
 * 3. Last same-day transit arrival (flight/train/bus departing that day)
 * 4. Previous day's resolved pair
 * 5. Seeded day.city (+ day.city_country)
 *
 * City and country are picked independently, each as the first layer (in this order)
 * that has a non-null value — so they may come from different layers. E.g. an override
 * of "Melaka" with no country attached still wins the city; if the active hotel that
 * night reports countryCode "MY", the day resolves to { city: "Melaka", countryCode: "MY" }.
 */
export function deriveDayGeo(day, bookings, previousResolvedGeo) {
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
  const hotelGeo = activeHotel ? extractGeoFromBooking(activeHotel) : { city: null, countryCode: null };

  // Last same-day transit arrival
  const sameDayTransit = bookings
    .filter((b) => {
      const type = b.type;
      if (type !== 'flight' && type !== 'train' && type !== 'bus') return false;
      return b.startDatetime?.slice(0, 10) === day.date;
    })
    .sort((a, b) => (a.startDatetime || '').localeCompare(b.startDatetime || ''));
  let transitGeo = { city: null, countryCode: null };
  for (let i = sameDayTransit.length - 1; i >= 0; i--) {
    const geo = extractGeoFromBooking(sameDayTransit[i]);
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
    SELECT d.*, t.owner_id, t.destination_countries
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

  return rows.map((row) => mapTrip(row, today));
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
  const interestTags = normalizeArray(input.interestTags);
  const defaultCity = destinations[0] || title;
  const defaultCityCountry = destinationPairs[0]?.countryCode || destinationCountries[0] || null;
  const tripDates = eachDate(startDate, endDate);

  const create = db.transaction(() => {
    const trip = db.prepare(`
      INSERT INTO trips (
        title, owner_id, destinations, destination_countries, start_date, end_date,
        travellers, interest_tags, pace, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
      RETURNING id
    `).get(
      title,
      userId,
      JSON.stringify(destinations),
      JSON.stringify(destinationCountries),
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
      const seedCity = firstDay?.city || parseJson(existingRow.destinations, [])[0] || existingRow.title;
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
      const seedCity = lastDay?.city || parseJson(existingRow.destinations, [])[0] || existingRow.title;
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
  `).run(title, travellers, JSON.stringify(interestTags), pace, newStartDate, newEndDate, tripId);

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
    const geo = deriveDayGeo(day, bookings, previousResolvedGeo);
    previousResolvedGeo = geo;
    return { ...day, resolvedCity: geo.city, resolvedCountry: geo.countryCode };
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
  if (!targetDay) return { city: null, countryCode: null };

  const bookings = listBookingsForTrip(targetDay.trip_id);
  const rows = db.prepare('SELECT * FROM days WHERE trip_id = ? AND date <= ? ORDER BY date ASC')
    .all(targetDay.trip_id, targetDay.date);

  let previousResolvedGeo = null;
  let geo = { city: null, countryCode: null };
  for (const row of rows) {
    const day = {
      date: row.date,
      city: row.city,
      cityOverride: row.city_override ?? null,
      cityCountry: row.city_country ?? null,
      cityOverrideCountry: row.city_override_country ?? null,
    };
    geo = deriveDayGeo(day, bookings, previousResolvedGeo);
    previousResolvedGeo = geo;
  }
  return geo;
}

export function getTripDetail(tripId, userId, { today = toIsoDate(new Date()) } = {}) {
  const tripRow = assertTripAccess(userId, tripId);
  const trip = mapTrip(tripRow, today);
  const db = getDb();

  // Load bookings first so deriveDayGeo can use them when building days
  const bookings = listBookingsForTrip(tripId);

  const days = listDaysForTrip(tripId, userId, bookings);

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

export function updateDayCityOverride(userId, tripId, date, cityOverride) {
  assertTripAccess(userId, tripId);
  const db = getDb();
  const result = db.prepare(`
    UPDATE days SET city_override = ? WHERE trip_id = ? AND date = ?
    RETURNING id, date, city_override
  `).get(cityOverride ?? null, tripId, date);
  if (!result) throw Object.assign(new Error('Day not found'), { status: 404 });
  return { date: result.date, cityOverride: result.city_override };
}
