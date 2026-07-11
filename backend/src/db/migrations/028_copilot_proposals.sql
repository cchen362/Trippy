-- Plan 11 Wave 2: persisted co-pilot proposals.
-- A proposal is the server-side audit record of a tool call the model made. It is
-- created the moment a valid propose_itinerary_changes tool block arrives (linked to the
-- assistant copilot_messages row that carried it), carries a trip-state fingerprint for
-- staleness detection, and is the single source of truth /apply acts on — the client can
-- never hand /apply raw operations anymore.
CREATE TABLE IF NOT EXISTS copilot_proposals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES copilot_messages(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  operations_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  trip_fingerprint TEXT NOT NULL,
  -- pending | applied | rejected | stale | invalid
  status TEXT NOT NULL DEFAULT 'pending',
  status_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_copilot_proposals_trip
  ON copilot_proposals(trip_id, created_at DESC);
