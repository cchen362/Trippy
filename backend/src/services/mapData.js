import { getDb } from '../db/database.js';
import { getMapConfig } from './mapConfig.js';
import { toDisplayCoordinates } from './coordinates.js';
import { assertTripAccess } from './trips.js';

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

  const stops = db.prepare(`
    SELECT s.*
    FROM stops s
    JOIN days d ON d.id = s.day_id
    WHERE d.trip_id = ?
    ORDER BY d.date ASC, COALESCE(s.time, '99:99') ASC, s.sort_order ASC, s.created_at ASC
  `).all(tripId);

  const segmentByDay = new Map(days.map((day) => [
    day.id,
    {
      id: `day:${day.id}`,
      dayId: day.id,
      label: day.city_override || day.city,
      type: 'local',
      stopIds: [],
    },
  ]));

  const routeCountByDay = new Map();
  const mapStops = stops.map((stop) => {
    const routeNumber = (routeCountByDay.get(stop.day_id) || 0) + 1;
    routeCountByDay.set(stop.day_id, routeNumber);
    const segment = segmentByDay.get(stop.day_id);
    if (segment) segment.stopIds.push(stop.id);
    return formatMapStop(stop, mapConfig, routeNumber, segment?.id || null);
  });

  return {
    mapConfig,
    segments: Array.from(segmentByDay.values()).filter((segment) => segment.stopIds.length > 0),
    stops: mapStops,
  };
}
