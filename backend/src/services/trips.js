import { getDb } from '../db/database.js';
import { cityFromIata, cityFromAirportString, canonicalCity } from '../utils/airports.js';

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
    detailsJson: parseJson(row.details_json, {}),
    createdAt: row.created_at,
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

/**
 * Extracts a clean city name from a booking's structured detailsJson.
 * Returns null if no city can be determined — never guesses from station names.
 */
function extractCityFromBooking(booking) {
  const d = booking.detailsJson || {};
  if (booking.type === 'hotel' || booking.type === 'other') {
    return canonicalCity(d.city) || null;
  }
  if (booking.type === 'train' || booking.type === 'bus') {
    return canonicalCity(d.destinationCity) || null;
  }
  if (booking.type === 'flight') {
    if (d.destinationCity) return canonicalCity(d.destinationCity);
    // Fall back: IATA from provider payload (AeroDataBox stores arrival.airport.iata)
    const iata = d.providerPayload?.arrival?.airport?.iata;
    if (iata) return cityFromIata(iata); // already canonical from IATA_CITY
    return canonicalCity(cityFromAirportString(booking.destination));
  }
  return null;
}

/**
 * Derives the city for a single day given the full bookings list.
 *
 * Priority:
 * 1. Manual city_override on the day row
 * 2. Hotel booking active that night (check-in date ≤ day.date < check-out date)
 * 3. Last same-day transit arrival (flight/train/bus departing that day)
 * 4. Previous day's resolved city
 * 5. Seeded day.city (trip default)
 */
function deriveDayCity(day, bookings, previousResolvedCity) {
  if (day.cityOverride) return day.cityOverride;

  // Hotel active tonight: check-in ≤ day.date < check-out
  const activeHotel = bookings.find((b) => {
    if (b.type !== 'hotel') return false;
    const checkIn = b.startDatetime?.slice(0, 10);
    const checkOut = b.endDatetime?.slice(0, 10);
    return checkIn && checkOut && checkIn <= day.date && day.date < checkOut;
  });
  if (activeHotel) {
    const city = extractCityFromBooking(activeHotel);
    if (city) return city;
  }

  // Last same-day transit arrival
  const sameDayTransit = bookings
    .filter((b) => {
      const type = b.type;
      if (type !== 'flight' && type !== 'train' && type !== 'bus') return false;
      return b.startDatetime?.slice(0, 10) === day.date;
    })
    .sort((a, b) => (a.startDatetime || '').localeCompare(b.startDatetime || ''));
  for (let i = sameDayTransit.length - 1; i >= 0; i--) {
    const city = extractCityFromBooking(sameDayTransit[i]);
    if (city) return city;
  }

  if (previousResolvedCity) return previousResolvedCity;
  return day.city;
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

  const destinations = normalizeArray(input.destinations);
  const destinationCountries = normalizeArray(input.destinationCountries);
  const interestTags = normalizeArray(input.interestTags);
  const defaultCity = destinations[0] || title;
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
      INSERT INTO days (trip_id, date, city, phase, hotel, theme, color_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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
      // Extension — auto-generate new days
      const defaultCity = parseJson(existingRow.destinations, [])[0] || existingRow.title;
      const afterCurrent = new Date(`${existingRow.end_date}T00:00:00Z`);
      afterCurrent.setUTCDate(afterCurrent.getUTCDate() + 1);
      const newDates = eachDate(afterCurrent.toISOString().slice(0, 10), input.endDate);
      const insertDay = db.prepare('INSERT INTO days (trip_id, date, city) VALUES (?, ?, ?)');
      for (const date of newDates) {
        insertDay.run(tripId, date, defaultCity);
      }
      newEndDate = input.endDate;
    }
  }

  db.prepare(`
    UPDATE trips SET title = ?, travellers = ?, interest_tags = ?, pace = ?, end_date = ?
    WHERE id = ?
  `).run(title, travellers, JSON.stringify(interestTags), pace, newEndDate, tripId);

  return getTripDetail(tripId, userId);
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

  let previousResolvedCity = null;
  return rows.map((row, index) => {
    const day = {
      id: row.id,
      tripId: row.trip_id,
      date: row.date,
      city: row.city,
      cityOverride: row.city_override ?? null,
      phase: row.phase,
      hotel: row.hotel,
      theme: row.theme,
      colorCode: row.color_code,
      stopCount: row.stop_count,
      dayIndex: index,
    };
    const resolvedCity = deriveDayCity(day, bookings, previousResolvedCity);
    previousResolvedCity = resolvedCity;
    return { ...day, resolvedCity };
  });
}

export function getTripDetail(tripId, userId, { today = toIsoDate(new Date()) } = {}) {
  const tripRow = assertTripAccess(userId, tripId);
  const trip = mapTrip(tripRow, today);
  const db = getDb();

  // Load bookings first so deriveDayCity can use them when building days
  const bookings = db.prepare(`
    SELECT *
    FROM bookings
    WHERE trip_id = ?
    ORDER BY COALESCE(start_datetime, end_datetime, created_at) ASC, created_at ASC
  `).all(tripId).map(mapBooking);

  const days = listDaysForTrip(tripId, userId, bookings);

  const stops = db.prepare(`
    SELECT *
    FROM stops
    WHERE day_id IN (SELECT id FROM days WHERE trip_id = ?)
    ORDER BY COALESCE(time, '99:99') ASC, sort_order ASC, created_at ASC
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
