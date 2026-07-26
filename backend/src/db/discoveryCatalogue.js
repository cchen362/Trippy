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

// Read-only counterpart to getOrCreateDestination — the co-pilot search tool must never
// mint a catalogue row just by being asked about a destination. Returns undefined when
// no row exists for (cityKey, countryCode).
export function findDestination(db, cityKey, countryCode) {
  return db.prepare(
    'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
  ).get(cityKey, countryCode ?? '');
}

// Catalogue freshness (Plan 7 Wave 1 / Plan 9 M6): a destination's stored places are
// only served as a cache hit while within this TTL of their last generation.
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// SQLite datetime('now') writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker,
// but JS `new Date(...)` on that string parses it as LOCAL time — only correct when
// the server process itself runs in UTC. Explicitly mark the string as UTC before
// parsing so the TTL check is correct regardless of the server's TZ. Mirrors the
// same fix already applied to place_resolution_cache (see cacheTimestampToEpochMs
// in services/placeResolver.js).
export function cacheTimestampToEpochMs(value) {
  if (!value) return null;
  const text = String(value);
  const iso = /[TZ]/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const epoch = Date.parse(iso);
  return Number.isFinite(epoch) ? epoch : null;
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
  // Freshly inserted rows are stamped 'pending', not 'unverified' (Plan 26 W1.2 /
  // F-26-1, F-26-3). Before this change both "never checked yet" and "checked and
  // failed" (discoveryVerify.js's terminal outcome for a non-confident hit) wrote
  // the same 'unverified' value, so enforceCategoryCap could not tell them apart
  // and could archive a row before the verification worker ever reached it — the
  // 78 production rows that are archived AND unverified are exactly that
  // collision, and verifyOne's early-return on non-active rows means they could
  // never recover (F-26-3). 'pending' already means "awaiting a check" elsewhere
  // in this codebase (discoveryVerify.js's markPending and enqueueForVerification
  // both key off it), so this also means a row orphaned by a restart mid-drain
  // self-heals the next time enqueueForVerification runs for its destination,
  // instead of being stranded at a terminal value forever.
  const insert = db.prepare(`
    INSERT INTO discovery_places (
      destination_id, category, name, normalized_name, local_name, aliases_json,
      description, why_go, estimated_duration, opening_hours, lat, lng,
      provenance, status, batch, generated_at, photo_query, scene_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', ?, ?, ?, ?)
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

// The daily-generation category cap (Plan 7 Wave 2, decision 4; Plan 26 W1.2
// exports the number so callers/routes/tests reference one constant instead
// of a repeated literal). Q-26-1 (whether 45 stays the right number) is left
// open until W1's fairness fix has been observed in production — do not
// change this value here.
export const CATEGORY_ACTIVE_CAP = 45;

// Read-only counterpart used by route/UI work that needs to know how full
// each category is (e.g. Plan 26 W1.5's "show more declines honestly at a
// full category"). Counts ALL provenances of ACTIVE rows for the destination,
// including 'pending' — a pending row still occupies a display slot even
// though enforceCategoryCap below will never archive it.
export function countActivePlacesByCategory(db, destinationId) {
  return db.prepare(
    `SELECT category, COUNT(*) AS count FROM discovery_places
     WHERE destination_id = ? AND status = 'active'
     GROUP BY category`,
  ).all(destinationId);
}

// Bounds enforcement (Plan 7 Wave 2, decision 4; revised Plan 26 W1.2 for
// F-26-1/F-26-2/F-26-3). Keeps each category's active row count at or under
// `cap` by archiving surplus, chosen worst-first using the Wave 3 rankPlaces
// scorer (score()) with neutral prefs, across three tiers:
//
//   1. checked-unverified (provenance === 'unverified') — a row that WAS
//      looked up and failed the confidence check. Archived worst-first,
//      consumed completely before tier 2 is touched at all.
//   2. verified — only archived once tier 1 is exhausted.
//   3. pending (provenance === 'pending', i.e. never yet checked) — NEVER
//      archived by this function, at any surplus.
//
// Invariants (pin these in tests):
//   PRESERVED (Plan 7 decision 4) — a verified row is never archived while a
//   checked-unverified row in the same category is still active.
//   ADDED — a freshly checked row may displace a weaker verified incumbent:
//   the entire checked-unverified tier is consumed before verified is
//   touched, so a newly VERIFIED row survives a cap sweep same as any other
//   verified row.
//   ADDED — a row that has never completed a check attempt is never
//   archived, so "archived and permanently unverifiable" (F-26-3) becomes
//   structurally impossible: verifyOne only ever runs against active rows,
//   and a pending row that's still active will get its turn.
//
// The cap still runs on every generation and still archives surplus among
// checked (non-pending) rows — this does not weaken the cap or change its
// value. If exempting pending rows leaves too few archivable victims to
// clear the surplus, archive what can legitimately be archived and leave the
// category temporarily above cap; log it so the condition is observable
// rather than silent. A pending row becomes archivable as soon as its check
// completes (Plan 26 W1.2).
export function enforceCategoryCap(db, destinationId, cap = CATEGORY_ACTIVE_CAP) {
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
    const unverifiedTier = rows.filter((row) => row.provenance === 'unverified');
    const verifiedTier = rows.filter((row) => row.provenance === 'verified');
    // provenance === 'pending' rows are excluded from both tiers entirely —
    // they are never archivable victims (see comment above).

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

    const stillSurplus = surplus - victims.length;
    if (stillSurplus > 0) {
      // Exempting never-checked (pending) rows means there weren't enough
      // legitimately archivable victims to clear the surplus this pass — the
      // category stays temporarily above cap until more rows finish a check.
      // Deliberate trade-off (Plan 26 W1.2): logged so it's observable, never
      // silent.
      console.error(
        '[discoveryCatalogue] category=%s destination=%s still %d over cap=%d after archiving checked rows — %d pending rows exempted',
        category, destinationId, stillSurplus, cap, rows.length - unverifiedTier.length - verifiedTier.length,
      );
    }
  }
}

// The daily generation cap (Plan 7 Wave 2, decision 4). Plan 12 Wave 2 moved it
// here from routes/discovery.js — mirroring CACHE_TTL_MS above — so the co-pilot's
// background generation kick (services/copilotGrounding.js) can check it without
// importing the route.
export const MAX_GENERATIONS_PER_DESTINATION_PER_DAY = 3;

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
