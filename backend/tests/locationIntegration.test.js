import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createBooking, updateBooking } from '../src/services/bookings.js';
import { createStop, updateStop } from '../src/services/stops.js';
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
