// Persistent, deduplicated discovery catalogue — replaces the single-blob
// global_discovery_cache table (Plan 7, Wave 1) as the route's source of
// truth. Each destination (city_key + country_code) owns a set of places
// that accumulate across generations rather than being replaced wholesale.
//
// All functions here take `db` as an explicit first argument (never call
// getDb() internally) so they're usable both from the Express route and
// from JS migrations (e.g. 016_discovery_catalogue.js's backfill), which
// run against a db instance handed to them by the migration runner.
//
// Nothing trip-specific (trip id, user id, trip preferences) is ever
// written to either table — this catalogue is destination-scoped only.

import { normalizeName } from '../services/claude.js';

// Gets the destination row for (cityKey, countryCode), creating it if it
// doesn't exist yet. countryCode defaults to '' (unknown-country bucket) so
// a bare city key and a country-qualified one are distinct rows — e.g.
// ("chengdu", "") and ("chengdu", "CN") never collide.
export function getOrCreateDestination(db, { cityKey, countryCode, displayName }) {
  const normalizedCountryCode = countryCode ?? '';

  const existing = db.prepare(
    'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
  ).get(cityKey, normalizedCountryCode);

  if (existing) return existing;

  db.prepare(
    'INSERT INTO discovery_destinations (city_key, country_code, display_name) VALUES (?, ?, ?)',
  ).run(cityKey, normalizedCountryCode, displayName);

  return db.prepare(
    'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
  ).get(cityKey, normalizedCountryCode);
}

// Returns every active place for a destination, grouped/ordered by
// (category, id) — the same order the route streams categories in.
export function listActivePlaces(db, destinationId) {
  return db.prepare(
    `SELECT * FROM discovery_places WHERE destination_id = ? AND status = 'active' ORDER BY category, id`,
  ).all(destinationId);
}

// Inserts newly generated places for a destination, skipping any whose
// normalized name already exists for that destination (dedup is scoped
// per-destination — the same place name in a different destination is a
// distinct row, never deduped against). This is an additive-only operation:
// it never deletes or archives existing rows, matching the "show more"
// and stale-refresh semantics that must never shrink what's stored.
//
// items: [{ category, name, description, whyItFits, estimatedDuration,
//           openingHours, localName, aliases, lat, lng, generatedAt }]
// (this is exactly discoverDestination's per-category item shape, plus a
// `category` field stamped on each flattened item — callers are not
// expected to pre-transform field names).
//
// Returns the array of rows actually inserted (skipped duplicates are
// omitted), each the full reselected discovery_places row.
export function insertPlaces(db, destinationId, items, batch) {
  const findExisting = db.prepare(
    'SELECT id FROM discovery_places WHERE destination_id = ? AND normalized_name = ?',
  );
  const insert = db.prepare(`
    INSERT INTO discovery_places (
      destination_id, category, name, normalized_name, local_name, aliases_json,
      description, why_go, estimated_duration, opening_hours, lat, lng,
      provenance, status, batch, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 'active', ?, ?)
  `);
  const selectById = db.prepare('SELECT * FROM discovery_places WHERE id = ?');

  const inserted = [];

  for (const item of items || []) {
    if (!item?.name) continue;

    const normalizedName = normalizeName(item.name);
    const dupe = findExisting.get(destinationId, normalizedName);
    if (dupe) {
      console.log(
        '[discoveryCatalogue] skipped duplicate name=%s destination=%s',
        item.name, destinationId,
      );
      continue;
    }

    const generatedAt = item.generatedAt ?? new Date().toISOString();
    const result = insert.run(
      destinationId,
      item.category,
      item.name,
      normalizedName,
      item.localName ?? null,
      JSON.stringify(item.aliases ?? []),
      item.description,
      item.whyItFits ?? null,
      item.estimatedDuration ?? null,
      item.openingHours ?? null,
      null, // lat — never stored, model coords are never persisted per spec
      null, // lng — never stored
      batch,
      generatedAt,
    );

    inserted.push(selectById.get(result.lastInsertRowid));
  }

  return inserted;
}

// Returns the most recent place names for a destination, used to build the
// exclusion list passed to discoverDestination on a stale-refresh or "show
// more" generation. Includes both active and archived places (archived
// places should still not be re-suggested even though they're no longer
// displayed) — active-only display filtering happens in listActivePlaces.
// Capped at `cap` names (default 400) to keep the exclusion list — and the
// resulting prompt size — bounded for destinations with a long generation
// history.
export function listExclusionNames(db, destinationId, cap = 400) {
  const rows = db.prepare(
    `SELECT name FROM discovery_places
     WHERE destination_id = ? AND status IN ('active', 'archived')
     ORDER BY id DESC LIMIT ?`,
  ).all(destinationId, cap);

  return rows.map((row) => row.name);
}
