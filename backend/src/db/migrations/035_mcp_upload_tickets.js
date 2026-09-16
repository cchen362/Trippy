// Plan 28 W3.3: upload tickets that let an MCP client hand Trippy a booking
// attachment out-of-band — the ticket itself (32 random bytes, hex) is the
// credential on the raw PUT to /mcp/uploads/:ticket, so that endpoint carries
// no bearer token and no Origin check (see routes/mcp.js). A ticket is scoped
// to one booking, one expected sha256, and one media type, and expires after
// TICKET_TTL_MS (services/mcp/uploads.js) so a leaked/replayed URL goes stale.
//
// booking_attachments also gains content_hash + source here so every
// attachment — manual (UI) or mcp (this ticket flow) — carries a content
// identity that makes "the same bytes twice" collapse to one row instead of
// piling up duplicates against the MAX_ATTACHMENTS=4 cap.
//
// BACKFILL: every existing booking_attachments row has content_hash === NULL
// (the column didn't exist before this migration). backfillContentHashes(db)
// computes the sha256 hex of each row's BLOB and writes it in, leaving
// `source` at its DEFAULT 'manual' — every pre-Plan-28 attachment really was
// manually uploaded through the UI. The backfill is scoped to
// `WHERE content_hash IS NULL` so it is safe to call again (e.g. from a test
// that re-invokes it directly) without re-hashing rows it already filled in.
//
// New migration file only; never modify 001-034.

import { createHash } from 'crypto';

export function backfillContentHashes(db) {
  const rows = db.prepare('SELECT id, content FROM booking_attachments WHERE content_hash IS NULL').all();
  if (rows.length === 0) return 0;

  const update = db.prepare('UPDATE booking_attachments SET content_hash = ? WHERE id = ?');
  for (const row of rows) {
    const hash = createHash('sha256').update(row.content).digest('hex');
    update.run(hash, row.id);
  }
  return rows.length;
}

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_upload_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_id TEXT NOT NULL REFERENCES integration_tokens(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      expected_sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      max_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT NULL,
      attachment_id TEXT NULL REFERENCES booking_attachments(id) ON DELETE SET NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_upload_tickets_booking ON mcp_upload_tickets(booking_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_upload_tickets_status_expiry ON mcp_upload_tickets(status, expires_at)');

  const attachmentColumns = db.prepare('PRAGMA table_info(booking_attachments)').all().map((c) => c.name);
  if (!attachmentColumns.includes('content_hash')) {
    db.exec('ALTER TABLE booking_attachments ADD COLUMN content_hash TEXT');
  }
  if (!attachmentColumns.includes('source')) {
    db.exec("ALTER TABLE booking_attachments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }

  backfillContentHashes(db);

  db.exec('CREATE INDEX IF NOT EXISTS idx_booking_attachments_hash ON booking_attachments(booking_id, content_hash)');
}
