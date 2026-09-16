-- Plan 28 W1 (D-28-1): personal integration tokens for hosted MCP access.
--
-- Deliberately NOT OAuth — a user mints a long-lived bearer token from the
-- Account modal (frontend, Plan 28 W1 UI), sees the plaintext exactly once,
-- and pastes it into an MCP client (Claude Code, Codex CLI, MCP Inspector,
-- the owner's bot). Unlike auth_sessions (plaintext token stored directly —
-- that table is a short-lived, cookie-only, browser-session credential), an
-- integration token is long-lived and handled outside the browser, so it is
-- stored only as a sha256 hash (F-28-25); the plaintext is never persisted
-- and cannot be recovered after creation.
--
-- token_prefix is the first 12 characters of the plaintext ('trp_' + 8) and
-- is indexed so verifyToken can narrow to a handful of candidate rows before
-- doing a timing-safe hash comparison, without ever storing or indexing the
-- full plaintext or hash in a way that leaks it via a prefix scan.
CREATE TABLE integration_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NULL,
  last_used_at TEXT NULL,
  revoked_at TEXT NULL
);

CREATE INDEX idx_integration_tokens_user ON integration_tokens(user_id);
CREATE INDEX idx_integration_tokens_prefix ON integration_tokens(token_prefix);
