CREATE TABLE IF NOT EXISTS global_discovery_cache (
  destination TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
