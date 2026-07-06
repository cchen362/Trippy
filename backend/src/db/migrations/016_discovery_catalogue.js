// Wave 1 of Plan 7 (Q3 Discovery Grounded Catalogue). Introduces the
// persistent, per-destination discovery catalogue (discovery_destinations
// + discovery_places) that replaces the single-blob global_discovery_cache
// table as the discover route's source of truth. Runs as a JS migration
// (not pure SQL) because it needs to backfill every existing cache row into
// the new tables, which requires calling into discoveryCatalogue.js and
// utils/countries.js rather than being expressible as a bulk SQL statement.
//
// Executed inside the migration runner's db.transaction wrapper (see
// migrations.js) — table creation and backfill are one atomic unit.
//
// global_discovery_cache is intentionally NOT dropped here — it is retired
// as the route's source of truth in this wave, but the table itself (and
// its data) is only dropped in a future Wave 4 migration, so a failed or
// rolled-back deploy can still fall back to it if needed.

import { getOrCreateDestination, insertPlaces } from '../discoveryCatalogue.js';
import { countryCodeFromName } from '../../utils/countries.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS discovery_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_key TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  last_generated_at TEXT,
  generation_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (city_key, country_code)
);

CREATE TABLE IF NOT EXISTS discovery_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id INTEGER NOT NULL REFERENCES discovery_destinations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  local_name TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL,
  why_go TEXT,
  estimated_duration TEXT,
  opening_hours TEXT,
  provider_place_id TEXT,
  lat REAL, lng REAL,
  business_status TEXT,
  rating REAL, rating_count INTEGER,
  provenance TEXT NOT NULL DEFAULT 'unverified',
  status TEXT NOT NULL DEFAULT 'active',
  batch INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discovery_places_dest
  ON discovery_places(destination_id, status, category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_places_name
  ON discovery_places(destination_id, normalized_name);
`;

function backfillFromGlobalCache(db) {
  const rows = db.prepare('SELECT * FROM global_discovery_cache').all();

  for (const row of rows) {
    const displayName = row.destination;
    const cityKey = row.destination;
    const countryCode = countryCodeFromName(displayName) ?? '';

    const destination = getOrCreateDestination(db, {
      cityKey,
      countryCode,
      displayName,
    });

    let categories;
    try {
      categories = JSON.parse(row.result_json);
    } catch (e) {
      console.log(
        '[016_backfill] destination=%s: skipping malformed result_json (%s)',
        displayName, e.message,
      );
      continue;
    }

    const items = (categories || []).flatMap((cat) =>
      (cat.items || []).map((item) => ({
        category: cat.category,
        name: item.name,
        description: item.description,
        whyItFits: item.whyItFits,
        estimatedDuration: item.estimatedDuration,
        openingHours: item.openingHours,
        localName: item.localName ?? null,
        aliases: item.aliases ?? [],
        lat: null,
        lng: null,
        generatedAt: item.generatedAt ?? row.fetched_at,
      })),
    );

    const inserted = insertPlaces(db, destination.id, items, 0);

    // Preserve the old row's freshness so a destination that was cached
    // moments before this migration ran isn't immediately treated as stale
    // (which would trigger an unwanted extra Claude generation call on the
    // very next request — a behavior regression Wave 1 must avoid, and an
    // avoidable cost per CLAUDE.md's API cost discipline).
    db.prepare(
      'UPDATE discovery_destinations SET last_generated_at = ?, generation_count = 1 WHERE id = ?',
    ).run(row.fetched_at, destination.id);

    console.log('[016_backfill] destination=%s items=%d', displayName, inserted.length);
  }
}

export function up(db) {
  db.exec(SCHEMA_SQL);
  backfillFromGlobalCache(db);
}
