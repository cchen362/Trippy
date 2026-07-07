-- Plan 7 Wave 4 (§4.4): retires the single-blob global_discovery_cache table
-- (007_global_discovery_cache.sql). Its only reader was routes/discovery.js
-- (Wave 1 switched that route to the normalized discovery_destinations /
-- discovery_places catalogue), and 016_discovery_catalogue.js already
-- one-time-backfilled every row out of it into the new tables. No ongoing
-- reader remains.
--
-- Numbered 018, not 017 per the plan text, because 017 was already taken by
-- 017_discovery_generation_daily.sql (Wave 2) by the time this wave landed.
DROP TABLE global_discovery_cache;
