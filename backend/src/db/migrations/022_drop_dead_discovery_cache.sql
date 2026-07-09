-- Plan 8 Wave 6: retires the dead discovery_cache table (005_ai.sql). It was
-- superseded by the normalized discovery_destinations / discovery_places
-- catalogue introduced in 016_discovery_catalogue.js, and a 2026-07-08 audit
-- (Plan 8 fact 7) found zero remaining readers or writers anywhere in the
-- codebase. Every DB that ran 005 has this table, so this is a bare DROP, not
-- DROP TABLE IF EXISTS, matching 018_retire_global_discovery_cache.sql.
DROP TABLE discovery_cache;
