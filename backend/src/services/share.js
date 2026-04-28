import { randomBytes } from 'crypto';
import { getDb } from '../db/database.js';
import { assertTripAccess } from './trips.js';

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapTrip(row) {
  return {
    id: row.id,
    title: row.title,
    destinations: parseJson(row.destinations, []),
    destinationCountries: parseJson(row.destination_countries, []),
    startDate: row.start_date,
    endDate: row.end_date,
    travellers: row.travellers,
    interestTags: parseJson(row.interest_tags, []),
    pace: row.pace,
  };
}

function mapDay(row, index) {
  return {
    id: row.id,
    tripId: row.trip_id,
    date: row.date,
    city: row.city,
    phase: row.phase,
    hotel: row.hotel,
    theme: row.theme,
    colorCode: row.color_code,
    dayIndex: index,
    stops: [],
  };
}

function mapStop(row) {
  const isBookingLinked = Boolean(row.booking_id);

  return {
    id: row.id,
    dayId: row.day_id,
    time: row.time,
    title: row.title,
    type: row.type,
    note: isBookingLinked ? null : row.note,
    lat: row.lat,
    lng: row.lng,
    unsplashPhotoUrl: row.unsplash_photo_url,
    estimatedCost: row.estimated_cost,
    bestTime: row.best_time,
    duration: row.duration,
    sortOrder: row.sort_order,
    isFeatured: Boolean(row.is_featured),
  };
}

function buildPublicTripDetail(tripId) {
  const db = getDb();
  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);

  if (!tripRow) {
    throw Object.assign(new Error('Trip not found'), { status: 404 });
  }

  const days = db.prepare(`
    SELECT *
    FROM days
    WHERE trip_id = ?
    ORDER BY date ASC
  `).all(tripId).map(mapDay);

  const stopsByDay = new Map(days.map((day) => [day.id, []]));
  const stops = db.prepare(`
    SELECT *
    FROM stops
    WHERE day_id IN (SELECT id FROM days WHERE trip_id = ?)
    ORDER BY sort_order ASC, created_at ASC
  `).all(tripId).map(mapStop);

  for (const stop of stops) {
    if (!stopsByDay.has(stop.dayId)) stopsByDay.set(stop.dayId, []);
    stopsByDay.get(stop.dayId).push(stop);
  }

  return {
    trip: mapTrip(tripRow),
    days: days.map((day) => ({
      ...day,
      stops: stopsByDay.get(day.id) || [],
    })),
  };
}

export function createShareLink(userId, tripId) {
  const db = getDb();
  assertTripAccess(userId, tripId);

  const existing = db.prepare(`
    SELECT token, created_at
    FROM share_links
    WHERE trip_id = ?
    ORDER BY created_at ASC
    LIMIT 1
  `).get(tripId);

  if (existing) {
    return { token: existing.token, createdAt: existing.created_at };
  }

  const token = randomBytes(24).toString('base64url');
  const row = db.prepare(`
    INSERT INTO share_links (trip_id, token)
    VALUES (?, ?)
    RETURNING token, created_at
  `).get(tripId, token);

  return { token: row.token, createdAt: row.created_at };
}

export function getSharedTrip(token) {
  const db = getDb();
  const normalizedToken = token?.trim();

  if (!normalizedToken) {
    throw Object.assign(new Error('Share link not found'), { status: 404 });
  }

  const link = db.prepare(`
    SELECT trip_id
    FROM share_links
    WHERE token = ?
  `).get(normalizedToken);

  if (!link) {
    throw Object.assign(new Error('Share link not found'), { status: 404 });
  }

  return buildPublicTripDetail(link.trip_id);
}
