import { getDb } from '../db/database.js';
import { getMapConfig } from './mapConfig.js';
import { toDisplayCoordinates } from './coordinates.js';
import { assertTripAccess } from './trips.js';

const TRANSIT_TYPES = new Set(['flight', 'train', 'bus', 'ferry']);

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeCity(value) {
  return String(value || '').trim();
}

function periodForTime(time) {
  if (!time) return '';
  const hour = Number(String(time).slice(0, 2));
  if (!Number.isFinite(hour)) return '';
  return hour < 12 ? 'AM' : 'PM';
}

function localSegmentLabel(city, stops) {
  const period = periodForTime(stops.find((stop) => stop.time)?.time);
  const fallback = period === 'PM' ? 'Afternoon' : 'Morning';
  return [normalizeCity(city) || fallback, period].filter(Boolean).join(' ');
}

function transitDestinationCity(stop, booking) {
  const details = parseJson(booking?.details_json, {});
  return normalizeCity(details.destinationCity)
    || normalizeCity(booking?.destination)
    || normalizeCity(stop.resolved_name)
    || normalizeCity(stop.title);
}

function isTransitStop(stop, booking) {
  return stop.type === 'transit' || TRANSIT_TYPES.has(booking?.type);
}

function buildSegmentsForDay(day, dayStops, bookingById) {
  const segments = [];
  let localStops = [];
  let currentCity = normalizeCity(day.city_override) || normalizeCity(day.city);
  let segmentIndex = 1;

  const flushLocal = () => {
    if (localStops.length === 0) return;
    const id = `day:${day.id}:segment:${segmentIndex}`;
    segments.push({
      id,
      dayId: day.id,
      label: localSegmentLabel(currentCity, localStops),
      type: 'local',
      city: currentCity || null,
      stopIds: localStops.map((stop) => stop.id),
    });
    segmentIndex += 1;
    localStops = [];
  };

  for (const stop of dayStops) {
    const booking = bookingById.get(stop.booking_id);
    if (!isTransitStop(stop, booking)) {
      localStops.push(stop);
      continue;
    }

    flushLocal();
    const id = `day:${day.id}:segment:${segmentIndex}`;
    segments.push({
      id,
      dayId: day.id,
      label: 'Transit',
      type: 'transit',
      city: null,
      stopIds: [stop.id],
    });
    segmentIndex += 1;
    currentCity = transitDestinationCity(stop, booking) || currentCity;
  }

  flushLocal();
  return segments;
}

function formatMapStop(row, mapConfig, routeNumber, routeSegmentId) {
  const display = toDisplayCoordinates(row, mapConfig);
  return {
    id: row.id,
    dayId: row.day_id,
    title: row.title,
    type: row.type,
    lat: row.lat,
    lng: row.lng,
    displayLat: display.displayLat,
    displayLng: display.displayLng,
    displayCoordinateSystem: display.displayCoordinateSystem,
    locationStatus: row.location_status,
    locationConfidence: row.location_confidence,
    routeNumber,
    routeSegmentId,
    canRenderMarker: display.canRenderMarker,
    isEstimated: display.isEstimated,
    bookingId: row.booking_id,
    sortOrder: row.sort_order,
    time: row.time,
    createdAt: row.created_at,
  };
}

export function getTripMapData(userId, tripId) {
  const trip = assertTripAccess(userId, tripId);
  const destinationCountries = parseJson(trip.destination_countries, []);
  const mapConfig = getMapConfig(destinationCountries);
  const db = getDb();

  const days = db.prepare(`
    SELECT id, date, city, city_override
    FROM days
    WHERE trip_id = ?
    ORDER BY date ASC
  `).all(tripId);

  const bookings = db.prepare(`
    SELECT *
    FROM bookings
    WHERE trip_id = ?
  `).all(tripId);
  const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));

  const stops = db.prepare(`
    SELECT s.*
    FROM stops s
    JOIN days d ON d.id = s.day_id
    WHERE d.trip_id = ?
    ORDER BY d.date ASC, s.sort_order ASC, s.created_at ASC
  `).all(tripId);

  const stopsByDay = new Map(days.map((day) => [day.id, []]));
  for (const stop of stops) {
    if (!stopsByDay.has(stop.day_id)) stopsByDay.set(stop.day_id, []);
    stopsByDay.get(stop.day_id).push(stop);
  }

  const segments = [];
  const segmentByStopId = new Map();
  for (const day of days) {
    const daySegments = buildSegmentsForDay(day, stopsByDay.get(day.id) || [], bookingById);
    for (const segment of daySegments) {
      segments.push(segment);
      for (const stopId of segment.stopIds) {
        segmentByStopId.set(stopId, segment.id);
      }
    }
  }

  const routeCountByDay = new Map();
  const mapStops = stops.map((stop) => {
    const routeNumber = (routeCountByDay.get(stop.day_id) || 0) + 1;
    routeCountByDay.set(stop.day_id, routeNumber);
    return formatMapStop(stop, mapConfig, routeNumber, segmentByStopId.get(stop.id) || null);
  });

  return {
    mapConfig,
    segments,
    stops: mapStops,
  };
}
