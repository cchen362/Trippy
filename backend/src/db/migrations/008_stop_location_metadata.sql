ALTER TABLE stops ADD COLUMN location_query TEXT;
ALTER TABLE stops ADD COLUMN resolved_name TEXT;
ALTER TABLE stops ADD COLUMN resolved_address TEXT;
ALTER TABLE stops ADD COLUMN coordinate_system TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE stops ADD COLUMN coordinate_source TEXT;
ALTER TABLE stops ADD COLUMN location_status TEXT NOT NULL DEFAULT 'unresolved';
ALTER TABLE stops ADD COLUMN location_confidence REAL;
ALTER TABLE stops ADD COLUMN provider_id TEXT;

UPDATE stops
SET location_status = 'estimated'
WHERE lat IS NOT NULL
  AND lng IS NOT NULL
  AND location_status = 'unresolved';

CREATE TABLE IF NOT EXISTS place_resolution_cache (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  query_key TEXT NOT NULL UNIQUE,
  query_text TEXT NOT NULL,
  city TEXT,
  country TEXT,
  provider TEXT NOT NULL,
  provider_id TEXT,
  name TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  coordinate_system TEXT NOT NULL DEFAULT 'unknown',
  confidence REAL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
