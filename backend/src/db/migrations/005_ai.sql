CREATE TABLE IF NOT EXISTS discovery_cache (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  interest_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trip_id, destination, interest_hash)
);

CREATE TABLE IF NOT EXISTS copilot_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
