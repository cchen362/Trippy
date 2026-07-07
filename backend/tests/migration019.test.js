import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { gcj02ToWgs84 } from '../src/services/coordinates.js';
import { up as fixGoogleCnCoordinates } from '../src/db/migrations/019_fix_google_cn_coordinates.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-migration019-test-'));
  initDb(join(tmpDir, 'test.db'));
  // Run the full migration chain first (019 is a no-op against the empty tables it
  // creates alongside — the fixture rows below are seeded afterward to simulate
  // pre-existing mislabeled data, then the migration's up() is invoked directly).
  await runMigrations();
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('019_fix_google_cn_coordinates', () => {
  it('converts google-sourced China rows in stops, discovery_places, place_resolution_cache, and hotel bookings', () => {
    const db = getDb();
    // GCJ-02 coordinates as stored by the pre-fix ingest code (mislabeled wgs84).
    const gcjLat = 29.5630;
    const gcjLng = 106.5507;
    const expected = gcj02ToWgs84(gcjLat, gcjLng);

    // -- stops: a mislabeled google CN stop --
    db.prepare(`
      INSERT INTO users (id, username, password_hash, display_name)
      VALUES ('user-1', 'tester', 'hash', 'Tester')
    `).run();
    db.prepare(`
      INSERT INTO trips (id, title, owner_id, start_date, end_date)
      VALUES ('trip-1', 'Test Trip', 'user-1', '2026-05-01', '2026-05-05')
    `).run();
    db.prepare(`INSERT INTO days (id, trip_id, date, city) VALUES ('day-1', 'trip-1', '2026-05-01', 'Chongqing')`).run();
    db.prepare(`
      INSERT INTO stops (id, day_id, title, lat, lng, coordinate_system, provider_id)
      VALUES ('stop-cn', 'day-1', 'Great Hall of the People', ?, ?, 'wgs84', 'google:ChIJ_cn_stop')
    `).run(gcjLat, gcjLng);

    // Untouched control: non-google stop, same coordinates.
    db.prepare(`
      INSERT INTO stops (id, day_id, title, lat, lng, coordinate_system, provider_id)
      VALUES ('stop-manual', 'day-1', 'Manual Add', ?, ?, 'wgs84', NULL)
    `).run(gcjLat, gcjLng);

    // Untouched control: google stop outside China (Kuala Lumpur), same-shaped row.
    db.prepare(`
      INSERT INTO stops (id, day_id, title, lat, lng, coordinate_system, provider_id)
      VALUES ('stop-my', 'day-1', 'KL Tower', 3.1528, 101.7038, 'wgs84', 'google:ChIJ_my_stop')
    `).run();

    // -- discovery_places: a mislabeled google CN row --
    db.prepare(`
      INSERT INTO discovery_destinations (id, city_key, country_code, display_name)
      VALUES (1, 'chongqing', 'CN', 'Chongqing')
    `).run();
    db.prepare(`
      INSERT INTO discovery_places (
        id, destination_id, category, name, normalized_name, description, provider_place_id,
        lat, lng, generated_at
      ) VALUES (
        1, 1, 'landmark', 'Great Hall of the People', 'great hall of the people', 'A landmark.',
        'google:ChIJ_cn_place', ?, ?, datetime('now')
      )
    `).run(gcjLat, gcjLng);

    // Untouched control: non-google discovery place.
    db.prepare(`
      INSERT INTO discovery_places (
        id, destination_id, category, name, normalized_name, description, provider_place_id,
        lat, lng, generated_at
      ) VALUES (
        2, 1, 'landmark', 'AI Estimated Place', 'ai estimated place', 'A landmark.',
        NULL, ?, ?, datetime('now')
      )
    `).run(gcjLat, gcjLng);

    // -- place_resolution_cache: a mislabeled google_places CN row --
    db.prepare(`
      INSERT INTO place_resolution_cache (
        query_key, query_text, city, country, provider, provider_id, name, address,
        lat, lng, coordinate_system, confidence, resolved_country
      ) VALUES (
        'cn-cache-key', 'Great Hall of the People', 'Chongqing', 'CN', 'google_places',
        'google:ChIJ_cn_cache', 'Great Hall of the People', 'Chongqing, China',
        ?, ?, 'wgs84', 0.9, 'CN'
      )
    `).run(gcjLat, gcjLng);

    // Untouched control: nominatim cache row, same coordinates.
    db.prepare(`
      INSERT INTO place_resolution_cache (
        query_key, query_text, city, country, provider, provider_id, name, address,
        lat, lng, coordinate_system, confidence, resolved_country
      ) VALUES (
        'cn-nominatim-key', 'Nominatim Place', 'Chongqing', 'CN', 'nominatim',
        'node:1', 'Nominatim Place', 'Chongqing, China',
        ?, ?, 'wgs84', 0.9, 'CN'
      )
    `).run(gcjLat, gcjLng);

    // -- bookings: a hotel booking with a google placeId and CN coordinates --
    db.prepare(`
      INSERT INTO bookings (id, trip_id, type, title, details_json)
      VALUES ('booking-cn', 'trip-1', 'hotel', 'Regent Chongqing', ?)
    `).run(JSON.stringify({ placeId: 'ChIJ_cn_hotel', lat: gcjLat, lng: gcjLng, displayName: 'Regent Chongqing' }));

    // Untouched control: hotel booking without a placeId.
    db.prepare(`
      INSERT INTO bookings (id, trip_id, type, title, details_json)
      VALUES ('booking-manual', 'trip-1', 'hotel', 'Manual Hotel', ?)
    `).run(JSON.stringify({ lat: gcjLat, lng: gcjLng }));

    fixGoogleCnCoordinates(db);

    const stopCn = db.prepare('SELECT lat, lng FROM stops WHERE id = ?').get('stop-cn');
    expect(stopCn.lat).toBeCloseTo(expected.lat, 9);
    expect(stopCn.lng).toBeCloseTo(expected.lng, 9);

    const stopManual = db.prepare('SELECT lat, lng FROM stops WHERE id = ?').get('stop-manual');
    expect(stopManual.lat).toBe(gcjLat);
    expect(stopManual.lng).toBe(gcjLng);

    const stopMy = db.prepare('SELECT lat, lng FROM stops WHERE id = ?').get('stop-my');
    expect(stopMy.lat).toBe(3.1528);
    expect(stopMy.lng).toBe(101.7038);

    const placeCn = db.prepare('SELECT lat, lng FROM discovery_places WHERE id = 1').get();
    expect(placeCn.lat).toBeCloseTo(expected.lat, 9);
    expect(placeCn.lng).toBeCloseTo(expected.lng, 9);

    const placeManual = db.prepare('SELECT lat, lng FROM discovery_places WHERE id = 2').get();
    expect(placeManual.lat).toBe(gcjLat);
    expect(placeManual.lng).toBe(gcjLng);

    const cacheCn = db.prepare(`SELECT lat, lng FROM place_resolution_cache WHERE query_key = 'cn-cache-key'`).get();
    expect(cacheCn.lat).toBeCloseTo(expected.lat, 9);
    expect(cacheCn.lng).toBeCloseTo(expected.lng, 9);

    const cacheNominatim = db.prepare(`SELECT lat, lng FROM place_resolution_cache WHERE query_key = 'cn-nominatim-key'`).get();
    expect(cacheNominatim.lat).toBe(gcjLat);
    expect(cacheNominatim.lng).toBe(gcjLng);

    const bookingCn = JSON.parse(db.prepare('SELECT details_json FROM bookings WHERE id = ?').get('booking-cn').details_json);
    expect(bookingCn.lat).toBeCloseTo(expected.lat, 9);
    expect(bookingCn.lng).toBeCloseTo(expected.lng, 9);
    expect(bookingCn.placeId).toBe('ChIJ_cn_hotel');

    const bookingManual = JSON.parse(db.prepare('SELECT details_json FROM bookings WHERE id = ?').get('booking-manual').details_json);
    expect(bookingManual.lat).toBe(gcjLat);
    expect(bookingManual.lng).toBe(gcjLng);
  });

  it('is a no-op when there are no matching rows', () => {
    const db = getDb();
    expect(() => fixGoogleCnCoordinates(db)).not.toThrow();
  });
});
