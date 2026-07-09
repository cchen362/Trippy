// Introduces trip_scopes — the durable, position-ordered list of destination "chips" a
// trip carries independent of its day rows (Plan 9 Wave 2, docs/superpowers/plans/).
// Previously a trip's destination list was derived transiently from days.city/
// days.city_override, and an explicit chip edit only survived by rewriting those seed
// columns (a lossy, day-coupled heuristic — see the removed positional-rename block in
// updateTrip). This table gives chip edits their own storage so editing chips never has
// to touch a day row, and so a chip that isn't currently backed by any day (e.g. a city
// only ever reached via a hotel booking) can still be listed and reconciled honestly.
//
// BACKFILL: every existing trip gets one scope row per distinct label found in its own
// days' RAW seed (day.city) and override (day.city_override) columns — never from
// resolved/hotel-derived values, since a hotel's raw evidence (e.g. a CJK address
// fragment) was never itself a trip destination the user chose. Distinct-by-canonical-key,
// first-seen-in-day-order (day.city checked before day.city_override for the same day,
// matching trips.js's existing buildTripScopes() ordering). Idempotent: a trip that
// already has any trip_scopes rows is left untouched (covers re-running this migration
// file's up() directly in tests, and guards against a future manual re-seed attempt).
//
// New migration file only; never modify 001-022 (CLAUDE.md).

import { canonicalGeoKey } from '../../utils/geoIdentity.js';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_scopes (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      country_code TEXT,
      kind TEXT,
      place_id TEXT,
      bounds_json TEXT,
      source TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(trip_id, canonical_key)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_trip_scopes_trip_id ON trip_scopes(trip_id)');

  const trips = db.prepare('SELECT id FROM trips').all();
  const hasScopes = db.prepare('SELECT 1 FROM trip_scopes WHERE trip_id = ? LIMIT 1');
  const dayRowsForTrip = db.prepare(`
    SELECT city, city_country, city_override, city_override_country
    FROM days
    WHERE trip_id = ?
    ORDER BY date ASC
  `);
  const insertScope = db.prepare(`
    INSERT INTO trip_scopes (trip_id, label, country_code, kind, place_id, bounds_json, source, canonical_key, position)
    VALUES (?, ?, ?, NULL, NULL, NULL, 'seed-backfill', ?, ?)
  `);

  let tripsBackfilled = 0;
  let scopesInserted = 0;

  for (const trip of trips) {
    if (hasScopes.get(trip.id)) continue; // already has scopes — re-run no-op for this trip

    const dayRows = dayRowsForTrip.all(trip.id);
    const seenKeys = new Set();
    let position = 0;

    for (const day of dayRows) {
      const candidates = [
        { label: day.city, countryCode: day.city_country },
        { label: day.city_override, countryCode: day.city_override_country },
      ];
      for (const candidate of candidates) {
        const trimmed = typeof candidate.label === 'string' ? candidate.label.trim() : '';
        if (!trimmed) continue;
        const key = canonicalGeoKey(trimmed);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        insertScope.run(trip.id, trimmed, candidate.countryCode || null, key, position);
        position += 1;
        scopesInserted += 1;
      }
    }

    if (position > 0) tripsBackfilled += 1;
  }

  if (scopesInserted > 0) {
    console.log(
      `[023_trip_scopes] backfilled ${scopesInserted} scope row(s) across ${tripsBackfilled} trip(s)`,
    );
  } else {
    console.log('[023_trip_scopes] no trips required backfill — no-op');
  }
}
