import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createBooking, updateBooking } from '../src/services/bookings.js';
import { createStop, reorderStops, repairTripStopLocations, updateStop } from '../src/services/stops.js';
import { createTrip } from '../src/services/trips.js';
import { getTripMapData } from '../src/services/mapData.js';

let tmpDir;
let user;
let trip;
let dayId;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-location-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
  vi.restoreAllMocks();

  user = authService.setup('owner', 'password123', 'Trip Owner').user;
  trip = createTrip(user.id, {
    title: 'Chongqing',
    destinations: ['Chongqing'],
    destinationCountries: ['CN'],
    startDate: '2026-06-09',
    endDate: '2026-06-09',
    travellers: 'couple',
    interestTags: ['food'],
    pace: 'moderate',
  });
  dayId = trip.days[0].id;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('resolver-aware stops', () => {
  it('resolves a curated manual place by title without external lookup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const stop = await createStop(user.id, dayId, {
      title: 'Raffles City Chongqing',
      type: 'experience',
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      title: 'Raffles City Chongqing',
      locationStatus: 'user_confirmed',
      coordinateSystem: 'gcj02',
      coordinateSource: 'curated',
      providerId: 'curated:raffles-city-chongqing',
    });
    expect(stop.lat).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('nominatim'))).toBe(false);
  });

  it('preserves explicit trusted coordinate metadata', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Pinned Cafe',
      lat: 29.5,
      lng: 106.5,
      coordinateSystem: 'wgs84',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
      locationConfidence: 1,
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      lat: 29.5,
      lng: 106.5,
      coordinateSystem: 'wgs84',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
    });
  });

  it('marks untrusted supplied coordinates as estimated, not resolved', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'AI Guess Place',
      lat: 29.5,
      lng: 106.5,
      coordinateSource: 'copilot',
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      lat: 29.5,
      lng: 106.5,
      coordinateSystem: 'unknown',
      coordinateSource: 'copilot',
      locationStatus: 'estimated',
    });
  });

  it('does not re-resolve unrelated updates and preserves user-confirmed coordinates', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Raffles City Chongqing',
      type: 'experience',
      unsplashPhotoUrl: null,
    });

    const updated = await updateStop(user.id, stop.id, { note: 'Keep the river view.' });

    expect(updated).toMatchObject({
      note: 'Keep the river view.',
      lat: stop.lat,
      lng: stop.lng,
      locationStatus: 'user_confirmed',
      providerId: 'curated:raffles-city-chongqing',
    });
  });

  it('re-resolves when location query changes', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Raffles City Chongqing',
      type: 'experience',
      unsplashPhotoUrl: null,
    });

    const updated = await updateStop(user.id, stop.id, {
      locationQuery: 'Hongya Cave Chongqing',
      reResolveLocation: true,
    });

    expect(updated).toMatchObject({
      resolvedName: 'Hongya Cave',
      providerId: 'curated:hongya-cave-chongqing',
      locationStatus: 'user_confirmed',
    });
  });
});

describe('map data endpoint service', () => {
  it('returns display coordinates and route numbers in timeline order', async () => {
    await createStop(user.id, dayId, { title: 'Jiefangbei', time: '11:00', type: 'experience', unsplashPhotoUrl: null });
    await createStop(user.id, dayId, { title: 'Raffles City Chongqing', time: '09:00', type: 'experience', unsplashPhotoUrl: null });

    const mapData = getTripMapData(user.id, trip.trip.id);

    expect(mapData.mapConfig.coordinateSystem).toBe('gcj02');
    expect(mapData.segments).toHaveLength(1);
    expect(mapData.stops.map((stop) => stop.title)).toEqual(['Raffles City Chongqing', 'Jiefangbei']);
    expect(mapData.stops.map((stop) => stop.routeNumber)).toEqual([1, 2]);
    expect(mapData.stops[0]).toMatchObject({
      canRenderMarker: true,
      displayCoordinateSystem: 'gcj02',
      routeSegmentId: mapData.segments[0].id,
    });
  });

  it('splits a mixed-city day into local transit and post-transit segments', async () => {
    const db = getDb();
    const booking = db.prepare(`
      INSERT INTO bookings (
        trip_id, type, title, start_datetime, end_datetime, origin, destination, details_json
      )
      VALUES (?, 'train', 'G123 Chongqing to Chengdu', '2026-06-09T12:00', '2026-06-09T14:00', 'Chongqing', 'Chengdu', ?)
      RETURNING *
    `).get(trip.trip.id, JSON.stringify({ originCity: 'Chongqing', destinationCity: 'Chengdu' }));

    await createStop(user.id, dayId, {
      title: 'Jiefangbei',
      time: '09:00',
      type: 'experience',
      unsplashPhotoUrl: null,
    });
    await createStop(user.id, dayId, {
      title: 'G123 Chongqing to Chengdu',
      time: '12:00',
      type: 'transit',
      bookingId: booking.id,
      lat: 29.556,
      lng: 106.55,
      coordinateSystem: 'gcj02',
      coordinateSource: 'booking',
      locationStatus: 'resolved',
      unsplashPhotoUrl: null,
    });
    await createStop(user.id, dayId, {
      title: 'Chengdu Teahouse',
      time: '15:00',
      type: 'food',
      lat: 30.657,
      lng: 104.066,
      coordinateSystem: 'gcj02',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
      unsplashPhotoUrl: null,
    });

    const mapData = getTripMapData(user.id, trip.trip.id);

    expect(mapData.segments.map((segment) => ({
      label: segment.label,
      type: segment.type,
      stopCount: segment.stopIds.length,
    }))).toEqual([
      { label: 'Chongqing AM', type: 'local', stopCount: 1 },
      { label: 'Transit', type: 'transit', stopCount: 1 },
      { label: 'Chengdu PM', type: 'local', stopCount: 1 },
    ]);
    expect(mapData.stops.map((stop) => stop.routeSegmentId)).toEqual(mapData.segments.map((segment) => segment.id));
  });

  it('keeps route numbers in timeline order after reorder and moving stops between days', async () => {
    const multiDayTrip = createTrip(user.id, {
      title: 'Chongqing Chengdu',
      destinations: ['Chongqing', 'Chengdu'],
      destinationCountries: ['CN'],
      startDate: '2026-06-09',
      endDate: '2026-06-10',
      travellers: 'couple',
      interestTags: ['food'],
      pace: 'moderate',
    });
    const firstDay = multiDayTrip.days[0].id;
    const secondDay = multiDayTrip.days[1].id;
    const morning = await createStop(user.id, firstDay, { title: 'Morning Stop', time: '09:00', lat: 29.55, lng: 106.55, coordinateSystem: 'gcj02', coordinateSource: 'user_pin', locationStatus: 'user_confirmed', unsplashPhotoUrl: null });
    const flexible = await createStop(user.id, firstDay, { title: 'Flexible Stop', lat: 29.56, lng: 106.56, coordinateSystem: 'gcj02', coordinateSource: 'user_pin', locationStatus: 'user_confirmed', unsplashPhotoUrl: null });
    const late = await createStop(user.id, firstDay, { title: 'Late Stop', time: '19:00', lat: 29.57, lng: 106.57, coordinateSystem: 'gcj02', coordinateSource: 'user_pin', locationStatus: 'user_confirmed', unsplashPhotoUrl: null });

    let mapData = getTripMapData(user.id, multiDayTrip.trip.id);
    expect(mapData.stops.filter((stop) => stop.dayId === firstDay).map((stop) => [stop.title, stop.routeNumber])).toEqual([
      ['Morning Stop', 1],
      ['Late Stop', 2],
      ['Flexible Stop', 3],
    ]);

    reorderStops(user.id, firstDay, [late.id, morning.id, flexible.id]);
    mapData = getTripMapData(user.id, multiDayTrip.trip.id);
    expect(mapData.stops.filter((stop) => stop.dayId === firstDay).map((stop) => [stop.title, stop.routeNumber])).toEqual([
      ['Morning Stop', 1],
      ['Late Stop', 2],
      ['Flexible Stop', 3],
    ]);

    await updateStop(user.id, morning.id, { dayId: secondDay });
    mapData = getTripMapData(user.id, multiDayTrip.trip.id);
    expect(mapData.stops.filter((stop) => stop.dayId === firstDay).map((stop) => [stop.title, stop.routeNumber])).toEqual([
      ['Late Stop', 1],
      ['Flexible Stop', 2],
    ]);
    expect(mapData.stops.filter((stop) => stop.dayId === secondDay).map((stop) => [stop.title, stop.routeNumber])).toEqual([
      ['Morning Stop', 1],
    ]);
  });

  it('does not render unknown non-estimated coordinates', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Pinned Unknown',
      lat: 29.5,
      lng: 106.5,
      coordinateSystem: 'wgs84',
      locationStatus: 'resolved',
      unsplashPhotoUrl: null,
    });
    getDb().prepare(`
      UPDATE stops
      SET coordinate_system = 'unknown', location_status = 'resolved'
      WHERE id = ?
    `).run(stop.id);

    const mapStop = getTripMapData(user.id, trip.trip.id).stops[0];

    expect(mapStop.canRenderMarker).toBe(false);
    expect(mapStop.displayLat).toBeNull();
  });

  it('keeps unresolved stops numbered and visible in the route sequence', async () => {
    await createStop(user.id, dayId, { title: 'Jiefangbei', time: '09:00', type: 'experience', unsplashPhotoUrl: null });
    await createStop(user.id, dayId, { title: 'Unresolved Place', time: '10:00', type: 'experience', unsplashPhotoUrl: null });

    const mapData = getTripMapData(user.id, trip.trip.id);
    const unresolved = mapData.stops.find((stop) => stop.title === 'Unresolved Place');

    expect(mapData.stops.map((stop) => stop.routeNumber)).toEqual([1, 2]);
    expect(unresolved).toMatchObject({
      canRenderMarker: false,
      locationStatus: 'unresolved',
      routeNumber: 2,
    });
  });

  it('preserves center-pin updates as user-confirmed map coordinates', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Unresolved Place',
      type: 'experience',
      unsplashPhotoUrl: null,
    });

    const updated = await updateStop(user.id, stop.id, {
      lat: 29.6,
      lng: 106.6,
      coordinateSystem: 'gcj02',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
      locationConfidence: 1,
    });

    expect(updated).toMatchObject({
      lat: 29.6,
      lng: 106.6,
      coordinateSystem: 'gcj02',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
      locationConfidence: 1,
    });
  });
});

describe('repair-stop-locations', () => {
  it('upgrades unknown-coordinate stops matching curated overrides to gcj02', async () => {
    const db = getDb();
    const stop = await createStop(user.id, dayId, {
      title: 'Luohan Temple Chongqing',
      lat: 29.565,
      lng: 106.5728,
      unsplashPhotoUrl: null,
    });
    db.prepare('UPDATE stops SET coordinate_system = ?, location_status = ?, coordinate_source = ? WHERE id = ?')
      .run('unknown', 'estimated', null, stop.id);

    const result = await repairTripStopLocations(user.id, trip.trip.id);

    expect(result.repaired).toBe(1);
    expect(result.total).toBe(1);
    const repaired = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(repaired.coordinate_system).toBe('gcj02');
    expect(repaired.location_status).toBe('user_confirmed');
    expect(repaired.lat).toBeCloseTo(29.5597, 3);
    expect(repaired.lng).toBeCloseTo(106.574, 2);
  });

  it('skips user_confirmed stops', async () => {
    const db = getDb();
    const stop = await createStop(user.id, dayId, {
      title: 'Luohan Temple Chongqing',
      lat: 29.5,
      lng: 106.5,
      coordinateSystem: 'gcj02',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
      locationConfidence: 1,
      unsplashPhotoUrl: null,
    });

    const result = await repairTripStopLocations(user.id, trip.trip.id);

    expect(result.repaired).toBe(0);
    expect(result.total).toBe(0);
    const unchanged = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(unchanged.lat).toBe(29.5);
    expect(unchanged.coordinate_system).toBe('gcj02');
  });

  it('leaves stops with no curated match unchanged', async () => {
    const db = getDb();
    const stop = await createStop(user.id, dayId, {
      title: 'Some Obscure Local Restaurant',
      lat: 29.56,
      lng: 106.57,
      unsplashPhotoUrl: null,
    });
    db.prepare('UPDATE stops SET coordinate_system = ?, location_status = ? WHERE id = ?')
      .run('unknown', 'estimated', stop.id);

    const result = await repairTripStopLocations(user.id, trip.trip.id);

    expect(result.repaired).toBe(0);
    expect(result.total).toBe(1);
    const unchanged = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(unchanged.coordinate_system).toBe('unknown');
  });
});

describe('booking-linked itinerary stops', () => {
  it('defaults booking itinerary visibility by type', async () => {
    const hotel = await createBooking(user.id, trip.trip.id, {
      type: 'hotel',
      title: 'Regent Chongqing',
      startDatetime: '2026-06-09T15:00',
      destination: 'Regent Chongqing',
    });
    const otherWithoutPlace = await createBooking(user.id, trip.trip.id, {
      type: 'other',
      title: 'Travel insurance',
    });

    expect(hotel.showInItinerary).toBe(true);
    expect(otherWithoutPlace.showInItinerary).toBe(false);
  });

  it('does not create a stop for disabled booking visibility', async () => {
    await createBooking(user.id, trip.trip.id, {
      type: 'hotel',
      title: 'Regent Chongqing',
      startDatetime: '2026-06-09T15:00',
      destination: 'Regent Chongqing',
      showInItinerary: false,
    });

    const count = getDb().prepare('SELECT COUNT(*) AS count FROM stops').get();
    expect(count.count).toBe(0);
  });

  it('turning booking visibility off removes a booking-created stop', async () => {
    const booking = await createBooking(user.id, trip.trip.id, {
      type: 'hotel',
      title: 'Regent Chongqing',
      startDatetime: '2026-06-09T15:00',
      destination: 'Regent Chongqing',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM stops').get().count).toBe(1);

    await updateBooking(user.id, booking.id, { showInItinerary: false });

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM stops').get().count).toBe(0);
  });

  it('links an other booking to a matching same-day stop instead of duplicating it', async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Raffles City Chongqing',
      type: 'experience',
      unsplashPhotoUrl: null,
    });

    const booking = await createBooking(user.id, trip.trip.id, {
      type: 'other',
      title: 'Raffles City Chongqing',
      startDatetime: '2026-06-09T10:00',
      destination: 'Raffles City Chongqing',
    });

    const rows = getDb().prepare('SELECT id, booking_id, booking_required FROM stops').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: stop.id,
      booking_id: booking.id,
      booking_required: 0,
    });
  });
});
