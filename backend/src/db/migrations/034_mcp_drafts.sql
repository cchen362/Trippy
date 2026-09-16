-- Plan 28 W2: draft proposals staged by the hosted MCP write path before a
-- human approves them (mirrors copilot_proposals' propose/apply split, but for
-- an external MCP client instead of the in-app co-pilot).
--
-- `kind` ships now (default 'booking') so W3's delete draft needs no second
-- migration — a delete draft reuses this same table and status lifecycle.
--
-- `booking_fingerprint` hashes the target trip's day dates plus every booking
-- on that trip (id, type, confirmation ref, times, origin, destination), so a
-- booking added or edited by hand between prepare and apply makes the draft
-- stale. It is deliberately separate from the co-pilot's
-- `computeTripFingerprint` (Plan 11 D3), which covers days and stops but not
-- bookings and is not widened for this (F-28-10).
CREATE TABLE mcp_drafts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES integration_tokens(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'booking' CHECK (kind IN ('booking', 'delete')),
  target_json TEXT NOT NULL,
  bookings_json TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  planned_effects_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  trip_id TEXT NULL REFERENCES trips(id) ON DELETE CASCADE,
  booking_fingerprint TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'expired', 'stale', 'invalid', 'rejected')),
  status_reason TEXT NULL,
  result_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  applied_at TEXT NULL,
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX idx_mcp_drafts_status_expiry ON mcp_drafts(status, expires_at);
