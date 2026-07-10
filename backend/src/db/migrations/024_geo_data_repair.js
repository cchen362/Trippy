// Data-repair migration driven by the 2026-07-10 owner-reviewed production
// inventory (Plan 9 Wave 5, docs/superpowers/plans/). That inventory found:
//   - a 杭州市|CN catalogue row (83 places) — the CJK city_key survives
//     canonicalGeoKey folding (CJK scripts pass through \p{L}), but a clean
//     hangzhou|CN row is the correct catalogue entry going forward, so 杭州市|CN
//     is dropped as a reviewed duplicate;
//   - a recreated kualalumpur|'' twin (021 already handled the first
//     occurrence; the D6 empty-country guard, Wave 5.1, stops future
//     recreation, but the twin that already landed on 2026-07-09 still needs
//     cleanup here) alongside the existing kualalumpur|MY row;
//   - KL trip days whose city_country is NULL, which is what caused the twin
//     in the first place — every Discovery request from those days composed
//     an empty countryCode. Stamping city_country closes the hole at the
//     source, not just the symptom.
//
// Deletion (rather than merging generated places/rows forward) was chosen for
// the same reason as 021: the catalogue regenerates on demand from
// Google/Claude for pennies, nothing is lost by dropping a stale row, and the
// owner confirmed every trip in the current database is test data.
//
// Day-country stamping only fires when the answer is unambiguous — exactly
// one distinct non-empty country is found across the discovery_destinations
// and trip_scopes evidence for that city. Zero or multiple candidates leave
// the day NULL rather than guessing (same "do not guess" discipline as the
// D6 empty-country guard and 021 rule 3).
//
// Every destination delete removes its discovery_places and
// discovery_generation_daily children explicitly first (foreign_keys=ON
// would cascade them anyway, but we log the counts, matching
// 021_canonicalize_discovery_keys.js's style).
//
// New migration file only; never modify 001-023 (CLAUDE.md).

import { canonicalGeoKey } from '../../utils/geoIdentity.js';

// Reviewed list of (city_key, country_code) rows to drop outright — the
// 2026-07-10 inventory's CJK duplicate. Exact match only.
const REVIEWED_CJK_ROWS = [
  [canonicalGeoKey('杭州市'), 'CN'],
];

function deleteDestinationRow(db, destination, label) {
  const placesDeleted = db.prepare(
    'DELETE FROM discovery_places WHERE destination_id = ?',
  ).run(destination.id).changes;

  const dailyDeleted = db.prepare(
    'DELETE FROM discovery_generation_daily WHERE destination_id = ?',
  ).run(destination.id).changes;

  db.prepare('DELETE FROM discovery_destinations WHERE id = ?').run(destination.id);

  console.log(
    '[024_geo_data_repair] %s: deleted destination_id=%d city_key=%s country_code=%s ' +
    '(%d places, %d daily-generation rows)',
    label, destination.id, destination.city_key, destination.country_code, placesDeleted, dailyDeleted,
  );
}

// READ-ONLY. Computes what up(db) would do, without writing anything —
// backs both the migration itself and the pre-deploy inventory script
// (scripts/geoRepairInventory.js).
export function computeRepairPlan(db) {
  // --- day stamps ---
  // Every days row with city_country NULL and a non-empty city, where exactly
  // one distinct non-empty country is found across:
  //   (a) discovery_destinations rows for that city_key with country_code != ''
  //   (b) trip_scopes rows for that canonical_key with a non-empty country_code
  const nullCountryDays = db.prepare(
    "SELECT id, trip_id, date, city FROM days WHERE city_country IS NULL AND TRIM(COALESCE(city, '')) != ''",
  ).all();

  const destinationCountriesForKey = db.prepare(
    "SELECT DISTINCT country_code FROM discovery_destinations WHERE city_key = ? AND country_code != ''",
  );
  const scopeCountriesForKey = db.prepare(
    "SELECT DISTINCT country_code FROM trip_scopes WHERE canonical_key = ? AND country_code IS NOT NULL AND country_code != ''",
  );

  const dayStamps = [];
  for (const day of nullCountryDays) {
    const key = canonicalGeoKey(day.city);
    if (!key) continue;

    const candidates = new Set([
      ...destinationCountriesForKey.all(key).map((r) => r.country_code),
      ...scopeCountriesForKey.all(key).map((r) => r.country_code),
    ]);

    if (candidates.size === 1) {
      dayStamps.push({
        dayId: day.id,
        tripId: day.trip_id,
        date: day.date,
        city: day.city,
        country: [...candidates][0],
      });
    }
  }

  // --- empty-country twin deletes (021 rule-3 semantics) ---
  const emptyCountryRows = db.prepare(
    "SELECT * FROM discovery_destinations WHERE country_code = ''",
  ).all();

  const emptyCountryTwinDeletes = [];
  const claimedIds = new Set();
  for (const destination of emptyCountryRows) {
    const twin = db.prepare(
      "SELECT id FROM discovery_destinations WHERE city_key = ? AND country_code != ''",
    ).get(destination.city_key);
    if (twin) {
      emptyCountryTwinDeletes.push(destination);
      claimedIds.add(destination.id);
    }
  }

  // --- reviewed CJK deletes (exact city_key + country_code match), deduped
  // against rows already captured by the twin rule above ---
  const reviewedCjkDeletes = [];
  for (const [cityKey, countryCode] of REVIEWED_CJK_ROWS) {
    const destination = db.prepare(
      'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
    ).get(cityKey, countryCode);
    if (destination && !claimedIds.has(destination.id)) {
      reviewedCjkDeletes.push(destination);
      claimedIds.add(destination.id);
    }
  }

  return { dayStamps, emptyCountryTwinDeletes, reviewedCjkDeletes };
}

export function up(db) {
  const plan = computeRepairPlan(db);
  let anyChange = false;

  for (const stamp of plan.dayStamps) {
    anyChange = true;
    db.prepare('UPDATE days SET city_country = ? WHERE id = ?').run(stamp.country, stamp.dayId);
    console.log(
      '[024_geo_data_repair] day stamp: trip=%s day=%s date=%s city=%s -> country=%s',
      stamp.tripId, stamp.dayId, stamp.date, stamp.city, stamp.country,
    );
  }

  for (const destination of plan.emptyCountryTwinDeletes) {
    anyChange = true;
    deleteDestinationRow(db, destination, 'empty-country twin');
  }

  for (const destination of plan.reviewedCjkDeletes) {
    anyChange = true;
    deleteDestinationRow(db, destination, 'reviewed CJK duplicate');
  }

  if (!anyChange) {
    console.log('[024_geo_data_repair] no matching rows in any rule — no-op');
  }
}
