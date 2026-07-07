// Data-repair migration for a production incident: generating discovery for
// "Bali, Indonesia (ID)" hit three bugs in services/claude.js and
// routes/discovery.js simultaneously (silent NDJSON parse drops on a
// pretty-printed-array response, a max_tokens ceiling too small for 8
// categories, and the route committing last_generated_at/generation_count
// after any non-throwing generation regardless of yield). The result: the
// destination_id for (city_key='bali', country_code='ID') was committed as a
// fresh 7-day catalogue holding exactly 10 places, all in the single
// category 'wellness' (the last category in the prompt's ordering).
//
// Those three bugs are fixed going forward (see services/claude.js — raised
// max_tokens, robust line parsing, category-name validation, and a
// minimum-yield throw that prevents the route from committing a thin/skewed
// generation). This migration only repairs the one already-corrupted row so
// the next browse of Bali regenerates cleanly instead of serving — or
// silently keeping fresh — the garbage catalogue.
//
// Scoped strictly to (city_key='bali', country_code='ID'). Every other
// destination is untouched. Logged no-op on databases that don't have this
// row (e.g. local dev, test databases, or a prod DB already repaired).
//
// New migration file only; never modify 001-019 (CLAUDE.md).

const CITY_KEY = 'bali';
const COUNTRY_CODE = 'ID';

export function up(db) {
  const destination = db.prepare(
    'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
  ).get(CITY_KEY, COUNTRY_CODE);

  if (!destination) {
    console.log(
      '[020_reset_bali_catalogue] no destination row for city_key=%s country_code=%s — no-op',
      CITY_KEY, COUNTRY_CODE,
    );
    return;
  }

  const placesDeleted = db.prepare(
    'DELETE FROM discovery_places WHERE destination_id = ?',
  ).run(destination.id).changes;

  const dailyDeleted = db.prepare(
    'DELETE FROM discovery_generation_daily WHERE destination_id = ?',
  ).run(destination.id).changes;

  db.prepare(
    'UPDATE discovery_destinations SET last_generated_at = NULL, generation_count = 0 WHERE id = ?',
  ).run(destination.id);

  console.log(
    '[020_reset_bali_catalogue] reset destination_id=%d city_key=%s country_code=%s: ' +
    'deleted %d places, %d daily-generation rows; last_generated_at/generation_count reset',
    destination.id, CITY_KEY, COUNTRY_CODE, placesDeleted, dailyDeleted,
  );
}
