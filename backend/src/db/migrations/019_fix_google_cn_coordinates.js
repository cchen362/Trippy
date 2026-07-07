// Data repair for the GCJ-02/WGS-84 mislabeling bug fixed alongside this migration
// in placeResolver.js (searchGooglePlaces) and lookups.js (lookupHotelDetails).
//
// Root cause: Google Places returns GCJ-02 ("Mars") coordinates for mainland-China
// results, but our ingest code hard-coded coordinateSystem: 'wgs84' on every Google
// result regardless of country. Rows already labeled wgs84 that are actually GCJ-02
// then get shifted a SECOND time by coordinates.js's toDisplayCoordinates() whenever
// the map targets gcj02 (CN trips → AMap tiles), producing a pin several hundred
// meters off (confirmed on stops.id 440a55bdc3dfd617a34fba16be6b6c5f).
//
// Repair criterion: Google-sourced rows whose stored coordinates fall inside the
// China bounding box (isInChina). This is a bbox heuristic, not a true country
// check — it would incorrectly re-convert genuine WGS-84 Google results for Hong
// Kong/Macau/Taiwan (which sit inside that same box). That's an acceptable
// simplification for this repair pass only because no HK/MO/TW rows exist in
// current data (verified against production before writing this migration); the
// live ingest fix in placeResolver.js/lookups.js uses the precise country-component
// check and does not have this limitation.
//
// Runs as a JS migration (not pure SQL) because it needs isInChina/gcj02ToWgs84 from
// services/coordinates.js — following the established pattern of importing app code
// into a migration (016_discovery_catalogue.js imports discoveryCatalogue.js).

import { gcj02ToWgs84, isInChina } from '../../services/coordinates.js';

function repairDiscoveryPlaces(db) {
  const rows = db.prepare(`
    SELECT id, lat, lng FROM discovery_places
    WHERE provider_place_id LIKE 'google:%'
      AND lat IS NOT NULL AND lng IS NOT NULL
  `).all();

  const update = db.prepare('UPDATE discovery_places SET lat = ?, lng = ? WHERE id = ?');
  let converted = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    if (!isInChina(row.lat, row.lng)) continue;
    const { lat, lng } = gcj02ToWgs84(row.lat, row.lng);
    update.run(lat, lng, row.id);
    converted += 1;
  }

  console.log(`[019_fix_google_cn_coordinates] discovery_places: converted ${converted} of ${rows.length} google-sourced rows`);
}

function repairStops(db) {
  const rows = db.prepare(`
    SELECT id, lat, lng FROM stops
    WHERE provider_id LIKE 'google:%'
      AND coordinate_system = 'wgs84'
      AND lat IS NOT NULL AND lng IS NOT NULL
  `).all();

  const update = db.prepare('UPDATE stops SET lat = ?, lng = ? WHERE id = ?');
  let converted = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    if (!isInChina(row.lat, row.lng)) continue;
    const { lat, lng } = gcj02ToWgs84(row.lat, row.lng);
    update.run(lat, lng, row.id);
    converted += 1;
  }

  console.log(`[019_fix_google_cn_coordinates] stops: converted ${converted} of ${rows.length} google-sourced wgs84 rows`);
}

function repairPlaceResolutionCache(db) {
  const rows = db.prepare(`
    SELECT id, lat, lng FROM place_resolution_cache
    WHERE provider = 'google_places'
      AND coordinate_system = 'wgs84'
      AND lat IS NOT NULL AND lng IS NOT NULL
  `).all();

  const update = db.prepare('UPDATE place_resolution_cache SET lat = ?, lng = ? WHERE id = ?');
  let converted = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    if (!isInChina(row.lat, row.lng)) continue;
    const { lat, lng } = gcj02ToWgs84(row.lat, row.lng);
    update.run(lat, lng, row.id);
    converted += 1;
  }

  console.log(`[019_fix_google_cn_coordinates] place_resolution_cache: converted ${converted} of ${rows.length} google_places wgs84 rows`);
}

function repairHotelBookings(db) {
  const rows = db.prepare(`SELECT id, details_json FROM bookings WHERE type = 'hotel'`).all();

  let converted = 0;
  let inspected = 0;

  for (const row of rows) {
    let details;
    try {
      details = JSON.parse(row.details_json || '{}');
    } catch {
      continue;
    }
    if (!details || typeof details !== 'object' || !details.placeId) continue;

    inspected += 1;
    const { lat, lng } = details;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!isInChina(lat, lng)) continue;

    const fixed = gcj02ToWgs84(lat, lng);
    const nextDetails = { ...details, lat: fixed.lat, lng: fixed.lng };
    db.prepare('UPDATE bookings SET details_json = ? WHERE id = ?')
      .run(JSON.stringify(nextDetails), row.id);
    converted += 1;
  }

  console.log(`[019_fix_google_cn_coordinates] bookings (hotel): converted ${converted} of ${inspected} google placeId rows with coordinates`);
}

export function up(db) {
  repairDiscoveryPlaces(db);
  repairStops(db);
  repairPlaceResolutionCache(db);
  repairHotelBookings(db);
}
