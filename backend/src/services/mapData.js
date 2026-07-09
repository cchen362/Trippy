import { getDb } from '../db/database.js';
import { getMapConfig, getMapConfigForCountry } from './mapConfig.js';
import { toDisplayCoordinates } from './coordinates.js';
import {
  assertTripAccess, deriveDayGeo, deriveTripDestinationsFromDays, buildTripScopes, listTripScopes,
} from './trips.js';

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

function buildSegmentsForDay(day, dayStops, bookingById, resolvedCity) {
  const segments = [];
  let localStops = [];
  let currentCity = normalizeCity(resolvedCity);
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

function formatMapStop(row, mapConfig, routeNumber, routeSegmentId, deepLinkProvider) {
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
    deepLinkProvider,
    canRenderMarker: display.canRenderMarker,
    isEstimated: display.isEstimated,
    bookingId: row.booking_id,
    sortOrder: row.sort_order,
    time: row.time,
    createdAt: row.created_at,
  };
}

// Bookings shaped just enough for deriveDayGeo (id, tripId, type, start/end datetimes,
// parsed detailsJson, destination) — this file otherwise works with raw snake_case rows
// for segment-building, so it deliberately doesn't reuse trips.js's full mapBooking().
// id/tripId are included so the hotel-city demotion warn (trips.js extractGeoFromBooking)
// has a real booking/trip id to log rather than undefined.
function toGeoBooking(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    detailsJson: parseJson(row.details_json, {}),
    destination: row.destination,
  };
}

function computeDayGeographies(days, bookingRows, storedScopes = []) {
  const geoBookings = bookingRows.map(toGeoBooking);
  const tripScopes = buildTripScopes(
    days.map((d) => ({ city: d.city, cityOverride: d.city_override })),
    storedScopes,
  );
  const geoByDayId = new Map();
  let previousResolvedGeo = null;
  for (const day of days) {
    const dayForDerivation = {
      date: day.date,
      city: day.city,
      cityOverride: day.city_override ?? null,
      cityOverrideCountry: day.city_override_country ?? null,
      cityCountry: day.city_country ?? null,
    };
    const geo = deriveDayGeo(dayForDerivation, geoBookings, previousResolvedGeo, tripScopes);
    previousResolvedGeo = geo;
    geoByDayId.set(day.id, geo);
  }
  return geoByDayId;
}

// Computes both the trip-level fallback mapConfig (unchanged shape/behavior) and a
// per-day mapConfig keyed by day id, derived from each day's resolved country. Shared
// by GET /map-config and GET /map-data so both surfaces agree on per-day provider choice.
export function getMapConfigsForTrip(trip) {
  const db = getDb();

  const days = db.prepare(`
    SELECT id, date, city, city_override, city_country, city_override_country
    FROM days
    WHERE trip_id = ?
    ORDER BY date ASC
  `).all(trip.id);

  const bookingRows = db.prepare('SELECT * FROM bookings WHERE trip_id = ?').all(trip.id);
  const storedScopes = listTripScopes(trip.id);
  const geoByDayId = computeDayGeographies(days, bookingRows, storedScopes);

  // Use each day's resolved (override/booking-aware) geo, not the raw seed columns — a
  // real trip's multi-country identity can come entirely from an active hotel booking
  // (deriveDayGeo layer 2), with every day's raw seed sharing one country.
  const { destinationCountries } = deriveTripDestinationsFromDays(
    days.map((d) => ({ city: geoByDayId.get(d.id)?.city, cityCountry: geoByDayId.get(d.id)?.countryCode })),
  );
  const mapConfig = getMapConfig(destinationCountries);

  const mapConfigByDay = {};
  for (const day of days) {
    mapConfigByDay[day.id] = getMapConfigForCountry(geoByDayId.get(day.id)?.countryCode);
  }

  return { mapConfig, mapConfigByDay, geoByDayId, days, bookingRows };
}

export function getTripMapData(userId, tripId) {
  const trip = assertTripAccess(userId, tripId);
  const { mapConfig, mapConfigByDay, geoByDayId, days, bookingRows } = getMapConfigsForTrip(trip);
  const db = getDb();
  const bookingById = new Map(bookingRows.map((booking) => [booking.id, booking]));

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
    const daySegments = buildSegmentsForDay(
      day, stopsByDay.get(day.id) || [], bookingById, geoByDayId.get(day.id)?.city,
    );
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
    const dayMapConfig = mapConfigByDay[stop.day_id] || mapConfig;
    // Option C over A: a stop's own resolved country outranks its day's for deep links.
    const linkCountry = stop.country_code || geoByDayId.get(stop.day_id)?.countryCode || null;
    const deepLinkProvider = getMapConfigForCountry(linkCountry).deepLinkProvider;
    return formatMapStop(stop, dayMapConfig, routeNumber, segmentByStopId.get(stop.id) || null, deepLinkProvider);
  });

  return {
    mapConfig,
    mapConfigByDay,
    segments,
    stops: mapStops,
  };
}
