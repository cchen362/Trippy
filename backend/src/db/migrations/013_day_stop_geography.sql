ALTER TABLE days ADD COLUMN city_country TEXT;            -- ISO alpha-2 for the seeded city
ALTER TABLE days ADD COLUMN city_override_country TEXT;   -- ISO alpha-2 for the override, nullable
ALTER TABLE stops ADD COLUMN country_code TEXT;           -- resolver-reported place country

-- place_resolution_cache.country already holds the request's bias country; resolved_country
-- is the country the provider actually reported for the matched place (may differ, e.g. a
-- cross-border search), kept separate to avoid overloading one column with two meanings.
ALTER TABLE place_resolution_cache ADD COLUMN resolved_country TEXT;
