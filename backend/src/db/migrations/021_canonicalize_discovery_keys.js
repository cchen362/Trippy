// Data-cleanup migration for discovery_destinations, driven by the 2026-07-09
// owner-reviewed production inventory (Plan 8 Wave 6, docs/superpowers/plans/).
// That inventory found several rows that don't belong in a clean catalogue:
//   - twins where the same city_key exists with both an empty and a populated
//     country_code (chengdu, chongqing) — the empty-country row is stale, left
//     over from before geo identity carried a country stamp;
//   - a hotel-address fragment row (kabupatenbadung|ID) that leaked in as a
//     "destination" from a booking's extracted address rather than an actual
//     trip city;
//   - a kualalumpur|'' row that should be stamped kualalumpur|MY, since every
//     KL trip's day.city_country is 'MY' and future Discovery lookups will key
//     on kualalumpur|MY.
//
// Deletion (rather than merging generated places/rows forward) was chosen
// because the catalogue regenerates on demand from Google/Claude — nothing is
// lost by dropping a stale row, it just regenerates fresh on next browse — and
// the owner confirmed every trip in the current database is test data, so
// there is no real user-facing history to preserve by merging.
//
// Rules are applied in order, each idempotent and independently a no-op when
// its target rows are absent (fresh/test DBs). Every destination delete removes
// its discovery_places and discovery_generation_daily children explicitly first
// (foreign_keys=ON would cascade them anyway, but we log the counts, matching
// 020_reset_bali_catalogue.js's style).
//
// New migration file only; never modify 001-020 (CLAUDE.md).

import { canonicalGeoKey } from '../../utils/geoIdentity.js';

// Rule 2: explicit, owner-reviewed list of hotel-address/fragment rows to drop outright.
const REVIEWED_FRAGMENT_ROWS = [
  ['kabupatenbadung', 'ID'], // the Bali regency name, leaked in from a hotel address
];

// Rule 4: Kuala Lumpur's empty-country row should be stamped 'MY', not deleted —
// unless a kualalumpur|MY row already exists, in which case the '' row is a stale
// duplicate and gets deleted like the other empty-country twins.
const KL_CITY_KEY = 'kualalumpur';
const KL_COUNTRY_CODE = 'MY';

function deleteDestinationRow(db, destination, label) {
  const placesDeleted = db.prepare(
    'DELETE FROM discovery_places WHERE destination_id = ?',
  ).run(destination.id).changes;

  const dailyDeleted = db.prepare(
    'DELETE FROM discovery_generation_daily WHERE destination_id = ?',
  ).run(destination.id).changes;

  db.prepare('DELETE FROM discovery_destinations WHERE id = ?').run(destination.id);

  console.log(
    '[021_canonicalize_discovery_keys] %s: deleted destination_id=%d city_key=%s country_code=%s ' +
    '(%d places, %d daily-generation rows)',
    label, destination.id, destination.city_key, destination.country_code, placesDeleted, dailyDeleted,
  );
}

export function up(db) {
  let anyChange = false;

  // Rule 1: un-normalized keys (generic guard). None exist in production today; this
  // guards stragglers on other DBs where city_key drifted from canonicalGeoKey(display_name).
  const allDestinations = db.prepare('SELECT * FROM discovery_destinations').all();
  for (const destination of allDestinations) {
    if (destination.city_key !== canonicalGeoKey(destination.display_name)) {
      anyChange = true;
      deleteDestinationRow(db, destination, 'un-normalized city_key');
    }
  }

  // Rule 2: reviewed fragment rows.
  for (const [cityKey, countryCode] of REVIEWED_FRAGMENT_ROWS) {
    const destination = db.prepare(
      'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
    ).get(cityKey, countryCode);
    if (destination) {
      anyChange = true;
      deleteDestinationRow(db, destination, 'reviewed fragment row');
    }
  }

  // Rule 3: empty-country twins — delete every '' row for which a non-empty-country
  // row with the same city_key already exists (production: chengdu, chongqing).
  const emptyCountryRows = db.prepare(
    "SELECT * FROM discovery_destinations WHERE country_code = ''",
  ).all();
  for (const destination of emptyCountryRows) {
    const twin = db.prepare(
      "SELECT id FROM discovery_destinations WHERE city_key = ? AND country_code != ''",
    ).get(destination.city_key);
    if (twin) {
      anyChange = true;
      deleteDestinationRow(db, destination, 'empty-country twin');
    }
  }

  // Rule 4: Kuala Lumpur country stamp (reviewed). Evaluated after rule 3 removes
  // generic empty-country twins, so this handles the KL-specific case: stamp the ''
  // row to MY if no MY row exists yet, otherwise drop the '' row as a stale duplicate.
  // Rationale: the owner's KL trip days carry city_country 'MY', so trip-context
  // Discovery requests key kualalumpur|MY — stamping converts future cache misses
  // (which regenerate a whole new catalogue) into cache hits against existing places.
  const klEmpty = db.prepare(
    "SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ''",
  ).get(KL_CITY_KEY);
  if (klEmpty) {
    const klMy = db.prepare(
      'SELECT id FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
    ).get(KL_CITY_KEY, KL_COUNTRY_CODE);

    anyChange = true;
    if (klMy) {
      deleteDestinationRow(db, klEmpty, 'kualalumpur empty-country duplicate (MY row already exists)');
    } else {
      db.prepare(
        'UPDATE discovery_destinations SET country_code = ? WHERE id = ?',
      ).run(KL_COUNTRY_CODE, klEmpty.id);
      console.log(
        '[021_canonicalize_discovery_keys] kualalumpur country stamp: destination_id=%d city_key=%s ' +
        "country_code '' -> %s",
        klEmpty.id, KL_CITY_KEY, KL_COUNTRY_CODE,
      );
    }
  }

  if (!anyChange) {
    console.log('[021_canonicalize_discovery_keys] no matching rows in any rule — no-op');
  }
}
