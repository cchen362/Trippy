-- Plan 7 Wave 2 (Q3 Discovery Grounded Catalogue): durable per-UTC-day generation
-- counter, keyed by (destination_id, utc_date). discovery_destinations.generation_count
-- is a lifetime counter (backfilled destinations start at 1, not 0 — see the 016
-- backfill), so it cannot answer "how many generations happened today," which the
-- "max 3 generations per destination per UTC day" bound (decision 4) needs. This
-- must survive process restart, so it lives in a table rather than in memory.
--
-- New migration file only; never modify 001-016 (CLAUDE.md).
CREATE TABLE IF NOT EXISTS discovery_generation_daily (
  destination_id INTEGER NOT NULL REFERENCES discovery_destinations(id) ON DELETE CASCADE,
  utc_date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (destination_id, utc_date)
);
