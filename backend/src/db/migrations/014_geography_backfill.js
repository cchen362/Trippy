// Wave 4 backfill + relabel migration (Plan 6, "Wave 4 — Backfill, relabel, and legacy
// retirement"). Runs as a JS migration (not pure SQL) because Step A needs conditional
// per-trip country resolution and Step B needs to replay the same sequential fold
// deriveDayGeo/listDaysForTrip already use elsewhere. Executed inside the migration
// runner's db.transaction wrapper — the whole backfill+relabel is one atomic unit,
// matching Gate D's "deploy step restores from backup on any failure" requirement.
//
// This migration must run BEFORE 015 drops trips.destinations/destination_countries —
// Step A still reads destination_countries here.

import { deriveDayGeo } from '../../services/trips.js';
import { countryCodeFromName } from '../../utils/countries.js';

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function backfillDaySeedCountries(db) {
  const trips = db.prepare('SELECT id, destination_countries FROM trips').all();

  const findCacheMatch = db.prepare(`
    SELECT country, resolved_country
    FROM place_resolution_cache
    WHERE city = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  for (const trip of trips) {
    const destinationCountries = parseJson(trip.destination_countries, []);
    const days = db.prepare(`
      SELECT id, city
      FROM days
      WHERE trip_id = ? AND city_country IS NULL
    `).all(trip.id);

    for (const day of days) {
      let resolvedCode = null;
      let reason = null;

      if (Array.isArray(destinationCountries) && destinationCountries.length === 1) {
        resolvedCode = destinationCountries[0];
        reason = 'stamped-single-country';
      } else {
        resolvedCode = countryCodeFromName(day.city);
        if (resolvedCode) {
          reason = 'stamped-resolved (countryCodeFromName)';
        } else {
          const cacheRow = findCacheMatch.get(day.city);
          if (cacheRow) {
            resolvedCode = cacheRow.resolved_country || cacheRow.country || null;
            if (resolvedCode) reason = 'stamped-resolved (place_resolution_cache)';
          }
        }
      }

      if (resolvedCode) {
        db.prepare('UPDATE days SET city_country = ? WHERE id = ?').run(resolvedCode, day.id);
        console.log(`[014_backfill] trip ${trip.id} day ${day.id}: stamped city_country=${resolvedCode} (${reason})`);
      } else {
        console.log(`[014_backfill] trip ${trip.id} day ${day.id}: left city_country NULL (no resolution found)`);
      }
    }
  }
}

function relabelGcj02Pins(db) {
  const trips = db.prepare('SELECT id FROM trips').all();

  const relabelStop = db.prepare(`UPDATE stops SET coordinate_system = 'wgs84' WHERE id = ?`);

  for (const trip of trips) {
    const dayRows = db.prepare(`
      SELECT id, date, city, city_override, city_country, city_override_country
      FROM days
      WHERE trip_id = ?
      ORDER BY date ASC
    `).all(trip.id);

    const bookingRows = db.prepare(`
      SELECT type, start_datetime, end_datetime, details_json
      FROM bookings
      WHERE trip_id = ?
    `).all(trip.id);

    const bookings = bookingRows.map((row) => ({
      type: row.type,
      startDatetime: row.start_datetime,
      endDatetime: row.end_datetime,
      detailsJson: parseJson(row.details_json, {}),
    }));

    const resolvedCountryByDayId = new Map();
    let previousResolvedGeo = null;

    for (const row of dayRows) {
      const day = {
        date: row.date,
        city: row.city,
        cityOverride: row.city_override ?? null,
        cityCountry: row.city_country ?? null,
        cityOverrideCountry: row.city_override_country ?? null,
      };
      const geo = deriveDayGeo(day, bookings, previousResolvedGeo);
      previousResolvedGeo = geo;
      resolvedCountryByDayId.set(row.id, geo.countryCode);
    }

    const gcjStops = db.prepare(`
      SELECT s.id, s.title, s.day_id
      FROM stops s
      JOIN days d ON d.id = s.day_id
      WHERE d.trip_id = ? AND s.coordinate_system = 'gcj02'
    `).all(trip.id);

    for (const stop of gcjStops) {
      const dayCountry = resolvedCountryByDayId.get(stop.day_id) ?? null;
      if (dayCountry !== 'CN') {
        relabelStop.run(stop.id);
        console.log(`[014_backfill] stop ${stop.id} ("${stop.title}"): relabeled gcj02 -> wgs84 (day country=${dayCountry ?? 'null'})`);
      }
    }
  }
}

export function up(db) {
  backfillDaySeedCountries(db);
  relabelGcj02Pins(db);
}
