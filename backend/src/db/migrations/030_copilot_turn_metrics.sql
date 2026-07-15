-- Plan 15 Wave 2: durable per-turn co-pilot telemetry.
-- One row per completed (or errored) co-pilot turn: token use, cache behavior, latency,
-- iteration/tool-call counts, stop reason, and proposal size. No message text, no user id,
-- no prompt content is ever stored here.
CREATE TABLE IF NOT EXISTS copilot_turn_metrics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  ttfd_ms INTEGER,
  total_ms INTEGER NOT NULL,
  iterations INTEGER NOT NULL,
  query_calls INTEGER NOT NULL,
  stop_reason TEXT,
  proposal_ops INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_copilot_turn_metrics_trip
  ON copilot_turn_metrics(trip_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copilot_turn_metrics_created_at
  ON copilot_turn_metrics(created_at);
