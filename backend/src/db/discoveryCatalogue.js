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

import { normalizeName, coerceSceneType } from '../services/claude.js';
import { score } from '../services/discoveryRank.js';

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

// Backs the D6 empty-country guard (Plan 9 Wave 5): every country-coded row
// (country_code != '') that already exists for a city_key. The route uses
// this to decide whether an EMPTY-countryCode Discovery request can safely
// adopt an existing country-coded catalogue row instead of minting a fresh
// ''-bucket twin — only when exactly one such row exists (zero or multiple
// is left alone; multiple is genuinely ambiguous and must not be guessed at).
export function listCountryCodedRows(db, cityKey) {
  return db.prepare(
    "SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code != ''",
  ).all(cityKey);
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
      provenance, status, batch, generated_at, photo_query, scene_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 'active', ?, ?, ?, ?)
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
    const photoQuery = typeof item.photoQuery === 'string' && item.photoQuery.trim()
      ? item.photoQuery.trim().split(/\s+/).slice(0, 8).join(' ')
      : null;
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
      photoQuery,
      coerceSceneType(item.sceneType),
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
     WHERE destination_id = ? AND status IN ('active', 'archived', 'suppressed')
     ORDER BY id DESC LIMIT ?`,
  ).all(destinationId, cap);

  return rows.map((row) => row.name);
}

// Neutral prefs used to rank archival candidates: no interest/pace/travellers
// weighting, since this is a shared, preference-free bounds check — it must
// never favor one trip's preferences over another's.
const NEUTRAL_PREFS = { interestTags: [], pace: 'moderate', travellers: undefined };

// Ranks rows worst-first (ascending score) using the Wave 3 scorer with
// NEUTRAL_PREFS. Ties preserve the input order (rows are queried in
// generation order, i.e. ORDER BY id ASC) — same "ties keep generation
// order" rule rankPlaces follows, just applied in the opposite direction.
function rankAscendingByScore(rows) {
  return rows
    .map((row) => ({ row, s: score(row, NEUTRAL_PREFS) }))
    .sort((a, b) => a.s - b.s)
    .map((entry) => entry.row);
}

// Bounds enforcement (Plan 7 Wave 2, decision 4): keeps each category's active
// row count at or under `cap` (default 45) by archiving surplus. Victims are
// chosen worst-first using the Wave 3 rankPlaces scorer (score()) with neutral
// prefs, applied within two tiers to preserve the invariant that a verified
// row is never archived while an unverified row in the same category is still
// active: the unverified/pending tier is ranked worst-first and consumed
// completely before the verified tier is touched at all. Within each tier,
// "worst" now reflects the real scoring formula (verified boost, batch
// penalty, category/pace fit, quality), not the old neutral SQL ordering.
export function enforceCategoryCap(db, destinationId, cap = 45) {
  const categories = db.prepare(
    `SELECT DISTINCT category FROM discovery_places WHERE destination_id = ? AND status = 'active'`,
  ).all(destinationId).map((row) => row.category);

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM discovery_places WHERE destination_id = ? AND category = ? AND status = 'active'`,
  );
  const rowsStmt = db.prepare(`
    SELECT * FROM discovery_places
    WHERE destination_id = ? AND category = ? AND status = 'active'
    ORDER BY id ASC
  `);
  const archiveStmt = db.prepare(`UPDATE discovery_places SET status = 'archived' WHERE id = ?`);

  for (const category of categories) {
    const activeCount = countStmt.get(destinationId, category).c;
    const surplus = activeCount - cap;
    if (surplus <= 0) continue;

    const rows = rowsStmt.all(destinationId, category);
    const unverifiedTier = rows.filter((row) => row.provenance !== 'verified');
    const verifiedTier = rows.filter((row) => row.provenance === 'verified');

    const rankedUnverified = rankAscendingByScore(unverifiedTier);
    const victims = rankedUnverified.slice(0, surplus);

    const remaining = surplus - victims.length;
    if (remaining > 0) {
      const rankedVerified = rankAscendingByScore(verifiedTier);
      victims.push(...rankedVerified.slice(0, remaining));
    }

    for (const victim of victims) {
      archiveStmt.run(victim.id);
      console.error(
        '[discoveryCatalogue] archived place=%s name=%s category=%s reason=category_cap provenance=%s',
        victim.id, victim.name, category, victim.provenance,
      );
    }
  }
}

// Per-UTC-day generation counter (Plan 7 Wave 2, decision 4: max 3 generations
// per destination per day). generation_count on discovery_destinations is a
// LIFETIME counter (backfilled destinations start at 1, not 0 — Wave 1 handoff),
// so it cannot answer "how many generations happened today." This table is the
// durable (restart-surviving) per-day counter instead.
export function getDailyGenerationCount(db, destinationId) {
  const row = db.prepare(
    `SELECT count FROM discovery_generation_daily WHERE destination_id = ? AND utc_date = strftime('%Y-%m-%d', 'now')`,
  ).get(destinationId);
  return row ? row.count : 0;
}

export function incrementDailyGenerationCount(db, destinationId) {
  db.prepare(`
    INSERT INTO discovery_generation_daily (destination_id, utc_date, count)
    VALUES (?, strftime('%Y-%m-%d', 'now'), 1)
    ON CONFLICT(destination_id, utc_date) DO UPDATE SET count = count + 1
  `).run(destinationId);
}
