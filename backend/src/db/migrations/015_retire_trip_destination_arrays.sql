-- Retires the legacy trips.destinations/destination_countries JSON array columns
-- now that day-level city/city_country (backfilled by 014) is the source of truth
-- (Plan 6, Wave 4). SQLite >=3.35 supports DROP COLUMN natively.
ALTER TABLE trips DROP COLUMN destinations;
ALTER TABLE trips DROP COLUMN destination_countries;
