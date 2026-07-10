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
import * as unsplashService from '../src/services/unsplash.js';
import * as claudeService from '../src/services/claude.js';

let tmpDir;
let user;
let trip;
let dayId;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-location-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  vi.restoreAllMocks();
  // Wave 3 default: no Haiku descriptor unless a test explicitly opts in — keeps
  // every pre-Wave-3 test's query/city assertions unchanged (falls through to
  // resolvedName+city / title+city exactly as before the descriptor existed).
  vi.spyOn(claudeService, 'generatePhotoDescriptor').mockResolvedValue(null);

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
      locationStatus: 'estimated',
      coordinateSystem: 'wgs84',
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

  it('does not save unverified generated coordinates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const stop = await createStop(user.id, dayId, {
      title: 'AI Guess Place',
      lat: 29.5,
      lng: 106.5,
      coordinateSource: 'copilot',
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      lat: null,
      lng: null,
      coordinateSystem: 'unknown',
      coordinateSource: null,
      locationStatus: 'unresolved',
    });
  });

  it('verifies discovery coordinates with Nominatim before saving them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '29.557402',
        lon: '106.574814',
        display_name: 'Discovery Test Place, Chongqing, China',
        name: 'Discovery Test Place',
        osm_type: 'way',
        osm_id: '987654',
      }],
    });

    const stop = await createStop(user.id, dayId, {
      title: 'Discovery Test Place',
      type: 'experience',
      lat: 29.5389,
      lng: 106.5806,
      coordinateSystem: 'wgs84',
      coordinateSource: 'discovery',
      locationStatus: 'estimated',
      locationQuery: 'Discovery Test Place',
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      title: 'Discovery Test Place',
      lat: 29.557402,
      lng: 106.574814,
      coordinateSystem: 'wgs84',
      coordinateSource: 'manual_lookup',
      locationStatus: 'resolved',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not save unverified discovery coordinates when Nominatim misses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const stop = await createStop(user.id, dayId, {
      title: 'Tiny Hidden Cave',
      type: 'experience',
      lat: 4.5,
      lng: 101.1,
      coordinateSource: 'discovery',
      locationQuery: 'Tiny Hidden Cave',
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      lat: null,
      lng: null,
      coordinateSystem: 'unknown',
      coordinateSource: null,
      locationStatus: 'unresolved',
    });
  });

  it('falls back to vetted China aliases when Discover coordinates cannot be verified by Nominatim', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const stop = await createStop(user.id, dayId, {
      title: "People's Liberation Monument",
      type: 'experience',
      lat: 29.555,
      lng: 106.57,
      coordinateSource: 'discovery',
      locationCity: 'Chong Qing',
      locationCountry: 'CN',
      locationQuery: "People's Liberation Monument",
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      lat: 29.5601096,
      lng: 106.5733569,
      coordinateSystem: 'wgs84',
      coordinateSource: 'curated',
      locationStatus: 'estimated',
      providerId: 'curated:jiefangbei-chongqing',
    });
  });

  it('falls back to country-scoped vetted aliases when the Discover city hint is wrong', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const stop = await createStop(user.id, dayId, {
      title: 'Wulong Karst Landscape (Day Trip)',
      type: 'experience',
      lat: 29.4,
      lng: 107.8,
      coordinateSource: 'discovery',
      locationCity: 'Chengdu',
      locationCountry: 'CN',
      locationQuery: 'Wulong Karst Landscape (Day Trip)',
      unsplashPhotoUrl: null,
    });

    expect(stop).toMatchObject({
      lat: 29.4338639,
      lng: 107.8012806,
      coordinateSystem: 'wgs84',
      coordinateSource: 'curated',
      locationStatus: 'estimated',
      providerId: 'curated:wulong-karst-chongqing',
    });
  });

  it('repairs unresolved China Discover stops from vetted aliases after Nominatim misses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const stop = await createStop(user.id, dayId, {
      title: 'Three Gorges Museum',
      type: 'experience',
      unsplashPhotoUrl: null,
    });
    getDb().prepare(`
      UPDATE stops
      SET lat = NULL, lng = NULL, coordinate_system = 'unknown', coordinate_source = NULL,
          location_status = 'unresolved', location_query = 'Three Gorges Museum'
      WHERE id = ?
    `).run(stop.id);

    const result = await repairTripStopLocations(user.id, trip.trip.id);
    const repaired = getDb().prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);

    expect(result.repaired).toBe(1);
    expect(repaired).toMatchObject({
      lat: 29.5648943,
      lng: 106.5465582,
      coordinate_system: 'wgs84',
      coordinate_source: 'curated',
      location_status: 'estimated',
      provider_id: 'curated:three-gorges-museum-chongqing',
    });
  });

  it('uses discovery-provided city instead of the active day city for generated coordinates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '3.1219635',
        lon: '101.6875793',
        display_name: 'Thean Hou Temple, Kuala Lumpur, Malaysia',
        name: 'Thean Hou Temple',
        osm_type: 'way',
        osm_id: '234567',
      }],
    });

    const stop = await createStop(user.id, dayId, {
      title: 'Thean Hou Temple',
      type: 'experience',
      lat: 3.1489,
      lng: 101.605,
      coordinateSystem: 'wgs84',
      coordinateSource: 'discovery',
      locationStatus: 'estimated',
      locationQuery: 'Thean Hou Temple',
      locationCity: 'Kuala Lumpur',
      locationCountry: 'MY',
      unsplashPhotoUrl: null,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe('Thean Hou Temple, Kuala Lumpur');
    expect(url.searchParams.get('countrycodes')).toBe('my');
    expect(stop).toMatchObject({
      lat: 3.1219635,
      lng: 101.6875793,
      coordinateSource: 'manual_lookup',
      coordinateSystem: 'wgs84',
    });
  });

  it('does not re-resolve unrelated updates and preserves curated coordinates', async () => {
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
      locationStatus: 'estimated',
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
      locationStatus: 'estimated',
    });
  });
});

describe('discovery-sourced stop metrics (Plan 7 Wave 4)', () => {
  it('logs a keep-vs-browse metric when a stop is added with source: discovery', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const stop = await createStop(user.id, dayId, {
      title: 'Raffles City Chongqing',
      type: 'experience',
      unsplashPhotoUrl: null,
      source: 'discovery',
      provenance: 'verified',
    });

    expect(logSpy).toHaveBeenCalledWith(
      '[discovery] add trip=%s place=%s provenance=%s',
      trip.trip.id, 'Raffles City Chongqing', 'verified',
    );
  });

  it('does not log the discovery metric for a non-discovery add', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createStop(user.id, dayId, {
      title: 'Raffles City Chongqing',
      type: 'experience',
      unsplashPhotoUrl: null,
    });

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('map data endpoint service', () => {
  it('returns display coordinates and route numbers in timeline order', async () => {
    await createStop(user.id, dayId, { title: 'Jiefangbei', time: '11:00', type: 'experience', unsplashPhotoUrl: null });
    await createStop(user.id, dayId, { title: 'Raffles City Chongqing', time: '09:00', type: 'experience', unsplashPhotoUrl: null });

    const mapData = getTripMapData(user.id, trip.trip.id);

    expect(mapData.mapConfig.coordinateSystem).toBe('gcj02');
    expect(mapData.segments).toHaveLength(1);
    expect(mapData.stops.map((stop) => stop.title)).toEqual(['Jiefangbei', 'Raffles City Chongqing']);
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
      // Plan 8 Wave 2 (Task 2.5): the pre-transit local segment now labels with the day's
      // *resolved* city (geoByDayId), not the raw seed/override. For a day with no
      // override/active-hotel evidence, deriveDayGeo's layer 3 (same-day transit arrival)
      // folds the whole day to the transit's destination — so a same-day transit-only day
      // (no other evidence) now resolves and labels as the destination city throughout,
      // matching what the trip/day-level geo already reports for this day elsewhere
      // (resolvedCity/resolvedCountry, map config, chip carry-forward). This is a direct,
      // intentional consequence of using the shared resolved geography instead of a
      // second, independent raw-seed calculation that could disagree with it.
      { label: 'Chengdu AM', type: 'local', stopCount: 1 },
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
      ['Flexible Stop', 2],
      ['Late Stop', 3],
    ]);

    reorderStops(user.id, firstDay, [late.id, morning.id, flexible.id]);
    mapData = getTripMapData(user.id, multiDayTrip.trip.id);
    expect(mapData.stops.filter((stop) => stop.dayId === firstDay).map((stop) => [stop.title, stop.routeNumber])).toEqual([
      ['Late Stop', 1],
      ['Morning Stop', 2],
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

  it('labels local segments with the hotel-resolved city, not the raw seed (Plan 8 Wave 2 — Task 2.5)', async () => {
    const multiCityTrip = createTrip(user.id, {
      title: 'Chengdu Chongqing Hotel',
      destinations: [{ city: 'Chengdu', countryCode: 'CN' }, { city: 'Chongqing', countryCode: 'CN' }],
      startDate: '2026-06-09',
      endDate: '2026-06-09',
      travellers: 'couple',
      interestTags: ['food'],
      pace: 'moderate',
    });
    const tripId = multiCityTrip.trip.id;
    const day = multiCityTrip.days[0];
    // Seed says "Chengdu" (createTrip seeds every day from the first destination pair),
    // but a Chongqing hotel is active that night -- the day's real identity is Chongqing.
    getDb().prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Chongqing Hotel', '2026-06-09T15:00', '2026-06-10T11:00', ?)
    `).run(tripId, JSON.stringify({ city: 'Chongqing', countryCode: 'CN' }));

    await createStop(user.id, day.id, {
      title: 'Jiefangbei', time: '09:00', type: 'experience', unsplashPhotoUrl: null,
    });

    const mapData = getTripMapData(user.id, tripId);
    expect(mapData.segments[0].label).toBe('Chongqing AM');
    expect(mapData.segments[0].city).toBe('Chongqing');
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
  function mockNominatimResponse(results) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => results,
    });
  }

  it('upgrades unknown-coordinate stops using accurate Nominatim WGS-84 data', async () => {
    const db = getDb();
    const stop = await createStop(user.id, dayId, {
      title: 'Luohan Temple Chongqing',
      lat: 29.565,
      lng: 106.5728,
      unsplashPhotoUrl: null,
    });
    db.prepare('UPDATE stops SET coordinate_system = ?, location_status = ?, coordinate_source = ? WHERE id = ?')
      .run('unknown', 'estimated', null, stop.id);

    mockNominatimResponse([{
      lat: '29.5573',
      lon: '106.5741',
      display_name: 'Luohan Temple, Yuzhong District, Chongqing, China',
      name: 'Luohan Temple',
      osm_type: 'way',
      osm_id: '123456',
    }]);

    const result = await repairTripStopLocations(user.id, trip.trip.id);

    expect(result.repaired).toBe(1);
    expect(result.total).toBe(1);
    const repaired = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(repaired.coordinate_system).toBe('wgs84');
    expect(repaired.coordinate_source).toBe('manual_lookup');
    expect(['resolved', 'estimated']).toContain(repaired.location_status);
    expect(repaired.lat).toBeCloseTo(29.5573, 3);
    expect(repaired.lng).toBeCloseTo(106.5741, 3);
  });

  it('also re-repairs previously curated stops that are not user_confirmed', async () => {
    const db = getDb();
    const stop = await createStop(user.id, dayId, {
      title: 'Luohan Temple Chongqing',
      unsplashPhotoUrl: null,
    });
    // Simulate a stop that was previously resolved via curated but is not user-pinned
    db.prepare('UPDATE stops SET coordinate_system = ?, location_status = ?, coordinate_source = ? WHERE id = ?')
      .run('wgs84', 'estimated', 'curated', stop.id);

    mockNominatimResponse([{
      lat: '29.5573',
      lon: '106.5741',
      display_name: 'Luohan Temple, Chongqing, China',
      name: 'Luohan Temple',
      osm_type: 'way',
      osm_id: '123456',
    }]);

    const result = await repairTripStopLocations(user.id, trip.trip.id);

    expect(result.repaired).toBe(1);
    const repaired = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(repaired.coordinate_source).toBe('manual_lookup');
    expect(repaired.coordinate_system).toBe('wgs84');
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

  it('leaves stops unchanged when Nominatim returns no result', async () => {
    const db = getDb();
    const stop = await createStop(user.id, dayId, {
      title: 'Some Obscure Local Restaurant',
      lat: 29.56,
      lng: 106.57,
      unsplashPhotoUrl: null,
    });
    db.prepare('UPDATE stops SET coordinate_system = ?, location_status = ? WHERE id = ?')
      .run('unknown', 'estimated', stop.id);

    mockNominatimResponse([]);

    const result = await repairTripStopLocations(user.id, trip.trip.id);

    expect(result.repaired).toBe(0);
    expect(result.total).toBe(1);
    const unchanged = db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(unchanged.coordinate_system).toBe('unknown');
  });
});

describe('per-day geography (Plan 6 Wave 2)', () => {
  it('CN+KR trip: Seoul day gets wgs84/naver and Chengdu day keeps amap/gcj02 (review §9 fixture)', async () => {
    const mixedTrip = createTrip(user.id, {
      title: 'Chengdu then Seoul',
      destinations: [{ city: 'Chengdu', countryCode: 'CN' }],
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      travellers: 'couple',
      interestTags: [],
      pace: 'moderate',
    });
    const chengduDay = mixedTrip.days[0].id;
    const seoulDay = mixedTrip.days[1].id;
    // Override (layer 1) is the mechanism that actually moves a day's resolved country —
    // the previous-day layer (4) outranks the seed (5), so a bare seed change on day 2
    // wouldn't diverge from day 1's carried-forward pair.
    getDb().prepare('UPDATE days SET city_override = ?, city_override_country = ? WHERE id = ?')
      .run('Seoul', 'KR', seoulDay);

    await createStop(user.id, chengduDay, {
      title: 'Chengdu Stop', lat: 30.6, lng: 104.06,
      coordinateSystem: 'wgs84', coordinateSource: 'user_pin', locationStatus: 'user_confirmed', unsplashPhotoUrl: null,
    });
    await createStop(user.id, seoulDay, {
      title: 'Seoul Stop', lat: 37.57, lng: 126.98,
      coordinateSystem: 'wgs84', coordinateSource: 'user_pin', locationStatus: 'user_confirmed', unsplashPhotoUrl: null,
    });

    const mapData = getTripMapData(user.id, mixedTrip.trip.id);

    expect(mapData.mapConfigByDay[chengduDay].coordinateSystem).toBe('gcj02');
    expect(mapData.mapConfigByDay[chengduDay].deepLinkProvider).toBe('amap');
    expect(mapData.mapConfigByDay[seoulDay].coordinateSystem).toBe('wgs84');
    expect(mapData.mapConfigByDay[seoulDay].deepLinkProvider).toBe('naver');

    const seoulStop = mapData.stops.find((s) => s.title === 'Seoul Stop');
    const chengduStop = mapData.stops.find((s) => s.title === 'Chengdu Stop');
    // Seoul is inside the China bbox but its own day's config is wgs84 — no spurious shift.
    expect(seoulStop.displayLat).toBeCloseTo(37.57, 5);
    expect(seoulStop.displayLng).toBeCloseTo(126.98, 5);
    expect(seoulStop.deepLinkProvider).toBe('naver');
    expect(chengduStop.deepLinkProvider).toBe('amap');
  });

  it("a stop's own country_code outranks its day's for deep-link selection (Option C)", async () => {
    const stop = await createStop(user.id, dayId, {
      title: 'Border Town Stop',
      lat: 29.5, lng: 106.5,
      coordinateSystem: 'wgs84', coordinateSource: 'user_pin', locationStatus: 'user_confirmed', unsplashPhotoUrl: null,
    });
    getDb().prepare('UPDATE stops SET country_code = ? WHERE id = ?').run('KR', stop.id);

    const mapData = getTripMapData(user.id, trip.trip.id);
    const mapStop = mapData.stops.find((s) => s.id === stop.id);

    // Day country is CN (amap); the stop's own country_code (KR) wins the deep link.
    expect(mapStop.deepLinkProvider).toBe('naver');
  });

  it('geocoding bias follows the derived day country, not destination_countries[0]', async () => {
    const mixedTrip = createTrip(user.id, {
      title: 'MY then CN',
      destinations: [{ city: 'Kuala Lumpur', countryCode: 'MY' }],
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      travellers: 'couple',
      interestTags: [],
      pace: 'moderate',
    });
    const chinaDay = mixedTrip.days[1].id;
    getDb().prepare('UPDATE days SET city_override = ?, city_override_country = ? WHERE id = ?')
      .run('Chengdu', 'CN', chinaDay);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });

    await createStop(user.id, chinaDay, {
      title: 'Wuhou Shrine',
      locationQuery: 'Wuhou Shrine',
      unsplashPhotoUrl: null,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('countrycodes')).toBe('cn');
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

describe('resolutionAnchor consumption (Plan 8 Wave 5 — Task 5.1)', () => {
  it('biases geocoding with the active hotel resolutionAnchor label/country instead of the resolved city', async () => {
    const seoulTrip = createTrip(user.id, {
      title: 'Seoul Anchor Trip',
      destinations: [{ city: 'Seoul', countryCode: 'KR' }],
      startDate: '2026-08-01',
      endDate: '2026-08-01',
      travellers: 'couple',
      interestTags: [],
      pace: 'moderate',
    });
    const seoulDay = seoulTrip.days[0].id;

    // Hotel resolves the day's city to "Seoul" (via the locality candidate), but its
    // sublocality ("Gangnam-gu") is more specific evidence than the resolved city and
    // is demoted to resolutionAnchor rather than winning the city ladder.
    getDb().prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Gangnam Hotel', '2026-08-01T15:00', '2026-08-02T11:00', ?)
    `).run(seoulTrip.trip.id, JSON.stringify({
      locality: 'Seoul',
      sublocality: 'Gangnam-gu',
      countryCode: 'KR',
    }));

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });

    await createStop(user.id, seoulDay, {
      title: 'Some Local Cafe',
      locationQuery: 'Some Local Cafe',
      unsplashPhotoUrl: null,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe('Some Local Cafe, Gangnam-gu');
    expect(url.searchParams.get('countrycodes')).toBe('kr');
  });

  it('falls back to the resolved city for geocoding bias when the day has no resolutionAnchor', async () => {
    const seoulTrip = createTrip(user.id, {
      title: 'Seoul No Anchor Trip',
      destinations: [{ city: 'Seoul', countryCode: 'KR' }],
      startDate: '2026-08-01',
      endDate: '2026-08-01',
      travellers: 'couple',
      interestTags: [],
      pace: 'moderate',
    });
    const seoulDay = seoulTrip.days[0].id;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });

    await createStop(user.id, seoulDay, {
      title: 'Some Local Cafe',
      locationQuery: 'Some Local Cafe',
      unsplashPhotoUrl: null,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe('Some Local Cafe, Seoul');
    expect(url.searchParams.get('countrycodes')).toBe('kr');
  });

  it('uses the resolved (hotel-promoted) city for photo queries, not the raw seed day city', async () => {
    const multiCityTrip = createTrip(user.id, {
      title: 'Chengdu Chongqing Hotel Photo',
      destinations: [{ city: 'Chengdu', countryCode: 'CN' }, { city: 'Chongqing', countryCode: 'CN' }],
      startDate: '2026-06-09',
      endDate: '2026-06-09',
      travellers: 'couple',
      interestTags: ['food'],
      pace: 'moderate',
    });
    const day = multiCityTrip.days[0];
    // Seed says "Chengdu" (createTrip seeds every day from the first destination pair),
    // but a Chongqing hotel is active that night, so the day's resolved city is Chongqing.
    getDb().prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Chongqing Hotel', '2026-06-09T15:00', '2026-06-10T11:00', ?)
    `).run(multiCityTrip.trip.id, JSON.stringify({ city: 'Chongqing', countryCode: 'CN' }));

    const selectPhotoSpy = vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);

    await createStop(user.id, day.id, {
      title: 'Random New Spot',
      type: 'experience',
    });

    expect(selectPhotoSpy).toHaveBeenCalledOnce();
    const { query, city } = selectPhotoSpy.mock.calls[0][0];
    expect(query).toContain('Chongqing');
    expect(query).not.toContain('Chengdu');
    expect(city).toBe('Chongqing');
  });

  it('warns and returns null when Unsplash yields no result, without throwing', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = await createStop(user.id, dayId, {
      title: 'Some Untraveled Alley',
      type: 'experience',
    });

    expect(stop.unsplashPhotoUrl).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[photo] no unsplash result', expect.objectContaining({ query: expect.any(String) }));
  });

  it('warns and returns null when the Unsplash lookup throws, without propagating the error', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockRejectedValue(new Error('Unsplash lookup failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = await createStop(user.id, dayId, {
      title: 'Another Untraveled Alley',
      type: 'experience',
    });

    expect(stop.unsplashPhotoUrl).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[photo] unsplash lookup failed', expect.objectContaining({
      title: 'Another Untraveled Alley',
      error: 'Unsplash lookup failed',
    }));
  });
});

describe('stop photo attribution (Plan 10 Wave 1)', () => {
  const FULL_PHOTO = {
    id: 'photo-123',
    url: 'https://images.unsplash.com/photo-123',
    alt: 'A market street',
    photographer: 'Jane Doe',
    photographerUrl: 'https://unsplash.com/@janedoe?utm_source=trippy&utm_medium=referral',
    unsplashUrl: 'https://unsplash.com/photos/photo-123?utm_source=trippy&utm_medium=referral',
    downloadLocation: 'https://api.unsplash.com/photos/photo-123/download',
    tags: ['market'],
  };

  it('persists photo id, attribution, and query on the stop row and serializes them back (round-trip)', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(FULL_PHOTO);
    vi.spyOn(unsplashService, 'trackDownload').mockResolvedValue(undefined);

    const stop = await createStop(user.id, dayId, {
      title: 'Jiefangbei Night Market',
      type: 'food',
    });

    expect(stop.unsplashPhotoUrl).toBe(FULL_PHOTO.url);
    expect(stop.unsplashPhotoId).toBe(FULL_PHOTO.id);
    expect(stop.photoAttribution).toEqual({
      photographer: FULL_PHOTO.photographer,
      photographerUrl: FULL_PHOTO.photographerUrl,
      unsplashUrl: FULL_PHOTO.unsplashUrl,
    });
    expect(stop.photoQuery).toEqual(expect.any(String));

    const row = getDb().prepare('SELECT * FROM stops WHERE id = ?').get(stop.id);
    expect(row.unsplash_photo_id).toBe(FULL_PHOTO.id);
    expect(JSON.parse(row.photo_attribution_json)).toEqual(stop.photoAttribution);
  });

  it('fires the Unsplash download-tracking call once when a photo is selected', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(FULL_PHOTO);
    const trackSpy = vi.spyOn(unsplashService, 'trackDownload').mockResolvedValue(undefined);

    await createStop(user.id, dayId, { title: 'Ciqikou Ancient Town', type: 'experience' });

    expect(trackSpy).toHaveBeenCalledOnce();
    expect(trackSpy).toHaveBeenCalledWith(FULL_PHOTO);
  });

  it('does not re-fetch or re-track a photo when updating a stop without title/type/day changes', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(FULL_PHOTO);
    vi.spyOn(unsplashService, 'trackDownload').mockResolvedValue(undefined);
    const stop = await createStop(user.id, dayId, { title: 'Hongyadong', type: 'experience' });

    const selectSpy = vi.spyOn(unsplashService, 'selectPhoto');
    const trackSpy = vi.spyOn(unsplashService, 'trackDownload');
    selectSpy.mockClear();
    trackSpy.mockClear();

    const updated = await updateStop(user.id, stop.id, { note: 'Great at night' });

    expect(selectSpy).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
    expect(updated.unsplashPhotoId).toBe(FULL_PHOTO.id);
    expect(updated.photoAttribution).toEqual(stop.photoAttribution);
  });
});

describe('stop photo selection (Plan 10 Wave 2)', () => {
  function rawPhoto(id, { alt = '', tags = [] } = {}) {
    return {
      id,
      urls: { regular: `https://images.unsplash.com/${id}` },
      alt_description: alt,
      description: '',
      tags: tags.map((title) => ({ title })),
      user: { name: 'Test Photographer', links: { html: 'https://unsplash.com/@test' } },
      links: {
        html: `https://unsplash.com/photos/${id}`,
        download_location: `https://api.unsplash.com/photos/${id}/download`,
      },
    };
  }

  function mockSearchPool(pool) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ results: pool }),
    }));
  }

  it('trip-level dedup: two stops in the same trip never receive the same unsplashPhotoId', async () => {
    // sigTokens end up empty for query "Chongqing Chongqing" (title == city, both
    // stripped by significantTokens), so the gate is a no-op and pure result order
    // (minus exclusion) decides the winner — isolating the dedup behavior under test.
    mockSearchPool([rawPhoto('photo-1'), rawPhoto('photo-2'), rawPhoto('photo-3')]);

    const first = await createStop(user.id, dayId, { title: 'Chongqing', type: 'experience' });
    const second = await createStop(user.id, dayId, { title: 'Chongqing', type: 'experience' });

    expect(first.unsplashPhotoId).toBe('photo-1');
    expect(second.unsplashPhotoId).toBe('photo-2');
    expect(second.unsplashPhotoId).not.toBe(first.unsplashPhotoId);
  });

  it('relevance gate rejects a primary pool with no significant-token overlap and falls through to the fallback query', async () => {
    const primaryPool = [
      rawPhoto('primary-1', { alt: 'a mountain view' }),
      rawPhoto('primary-2', { alt: 'a cloudy sky' }),
    ];
    const fallbackPool = [rawPhoto('fallback-1', { alt: 'busy street scene' })];

    let callCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1;
      return { ok: true, json: async () => ({ results: callCount === 1 ? primaryPool : fallbackPool }) };
    });

    const photo = await unsplashService.selectPhoto({
      query: 'Night Bazaar Chongqing',
      sceneType: 'street_market',
      country: '',
      city: 'Chongqing',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(photo.id).toBe('fallback-1');
  });

  it('builds the fallback query as "{scene words} {country}" for a real sceneType', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await unsplashService.selectPhoto({
      query: 'Random Alley Vietnam',
      sceneType: 'street_neighborhood',
      country: 'Vietnam',
      city: 'Hanoi',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(fallbackUrl.searchParams.get('query')).toBe('street neighborhood Vietnam');
  });

  it('builds the fallback query as "{city} travel" for a generic/null sceneType', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await unsplashService.selectPhoto({
      query: 'Random Alley',
      sceneType: null,
      country: '',
      city: 'Hanoi',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(fallbackUrl.searchParams.get('query')).toBe('Hanoi travel');
  });

  it('does not re-roll the photo when a stop is only moved to another day (D6)', async () => {
    const multiDayTrip = createTrip(user.id, {
      title: 'Chongqing Two Day',
      destinations: ['Chongqing'],
      destinationCountries: ['CN'],
      startDate: '2026-06-09',
      endDate: '2026-06-10',
      travellers: 'couple',
      interestTags: ['food'],
      pace: 'moderate',
    });
    const firstDay = multiDayTrip.days[0].id;
    const secondDay = multiDayTrip.days[1].id;

    const movedPhoto = {
      id: 'photo-move',
      url: 'https://images.unsplash.com/photo-move',
      photographer: 'Mover',
      photographerUrl: 'https://unsplash.com/@mover',
      unsplashUrl: 'https://unsplash.com/photos/photo-move',
    };
    const selectPhotoSpy = vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(movedPhoto);
    vi.spyOn(unsplashService, 'trackDownload').mockResolvedValue(undefined);

    const stop = await createStop(user.id, firstDay, { title: 'Ciqikou Ancient Town', type: 'experience' });
    selectPhotoSpy.mockClear();

    const moved = await updateStop(user.id, stop.id, { dayId: secondDay });

    expect(selectPhotoSpy).not.toHaveBeenCalled();
    expect(moved.dayId).toBe(secondDay);
    expect(moved.unsplashPhotoId).toBe('photo-move');
    expect(moved.unsplashPhotoUrl).toBe(movedPhoto.url);
  });

  it('excludes transit stops from photo search entirely', async () => {
    const selectPhotoSpy = vi.spyOn(unsplashService, 'selectPhoto');
    const descriptorSpy = vi.spyOn(claudeService, 'generatePhotoDescriptor');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const stop = await createStop(user.id, dayId, {
      title: 'G123 Chongqing to Chengdu',
      type: 'transit',
    });

    expect(selectPhotoSpy).not.toHaveBeenCalled();
    expect(descriptorSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stop.unsplashPhotoUrl).toBeNull();
    expect(stop.unsplashPhotoId).toBeNull();
  });
});

describe('photo descriptors (Plan 10 Wave 3)', () => {
  it('a discovery add with a catalogue-authored descriptor stores it with no extra Haiku call', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);
    const descriptorSpy = vi.spyOn(claudeService, 'generatePhotoDescriptor');

    const stop = await createStop(user.id, dayId, {
      title: 'Ciqikou Ancient Town',
      type: 'experience',
      photoQuery: 'ancient riverside stone alley Ciqikou',
      sceneType: 'street_neighborhood',
      source: 'discovery',
      provenance: 'unverified',
    });

    expect(descriptorSpy).not.toHaveBeenCalled();
    expect(stop.photoQuery).toBe('ancient riverside stone alley Ciqikou');
    expect(stop.sceneType).toBe('street_neighborhood');
  });

  it('a manual add with no descriptor stores a Haiku-authored one', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);
    const descriptorSpy = vi.spyOn(claudeService, 'generatePhotoDescriptor')
      .mockResolvedValue({ photoQuery: 'steaming hotpot table Chengdu', sceneType: 'food_drink' });

    const stop = await createStop(user.id, dayId, {
      title: 'Hotpot Spot',
      type: 'food',
    });

    expect(descriptorSpy).toHaveBeenCalledOnce();
    expect(descriptorSpy.mock.calls[0][0]).toMatchObject({ title: 'Hotpot Spot', type: 'food' });
    expect(stop.photoQuery).toBe('steaming hotpot table Chengdu');
    expect(stop.sceneType).toBe('food_drink');
  });

  it('does not call the Haiku descriptor when the caller already supplied a photoQuery', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);
    const descriptorSpy = vi.spyOn(claudeService, 'generatePhotoDescriptor');

    await createStop(user.id, dayId, {
      title: 'Hotpot Spot',
      type: 'food',
      photoQuery: 'already have a query',
    });

    expect(descriptorSpy).not.toHaveBeenCalled();
  });

  it('a Haiku outage still creates the stop, falling through to a resolvedName/title+city query', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);
    vi.spyOn(claudeService, 'generatePhotoDescriptor').mockRejectedValue(new Error('Haiku outage'));

    const stop = await createStop(user.id, dayId, {
      title: 'Some Random New Cafe',
      type: 'food',
    });

    expect(stop).toBeTruthy();
    expect(stop.unsplashPhotoUrl).toBeNull();
    expect(stop.photoQuery).toBe('Some Random New Cafe Chongqing');
    expect(stop.sceneType).toBeNull();
  });

  it('a manual descriptor is never generated for a photo-ineligible (transit) stop', async () => {
    const descriptorSpy = vi.spyOn(claudeService, 'generatePhotoDescriptor');

    await createStop(user.id, dayId, {
      title: 'G123 Chongqing to Chengdu',
      type: 'transit',
    });

    expect(descriptorSpy).not.toHaveBeenCalled();
  });

  it('copilot-created stops inherit the descriptor pipeline the same as manual createStop calls', async () => {
    vi.spyOn(unsplashService, 'selectPhoto').mockResolvedValue(null);
    const descriptorSpy = vi.spyOn(claudeService, 'generatePhotoDescriptor')
      .mockResolvedValue({ photoQuery: 'street food stall night market', sceneType: 'food_drink' });

    // Mirrors routes/copilot.js's apply handler: a copilot add_stop operation
    // supplies no photoQuery/sceneType of its own and goes through createStop
    // exactly like a manual add (Plan 10 Wave 3 §3.4 regression coverage).
    const stop = await createStop(user.id, dayId, {
      title: 'Night Market Skewers',
      type: 'food',
      note: 'Copilot suggested this',
    });

    expect(descriptorSpy).toHaveBeenCalledOnce();
    expect(stop.photoQuery).toBe('street food stall night market');
    expect(stop.sceneType).toBe('food_drink');
  });
});
