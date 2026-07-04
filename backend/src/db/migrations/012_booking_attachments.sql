CREATE TABLE IF NOT EXISTS booking_attachments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  filename TEXT,
  size_bytes INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booking_attachments_booking ON booking_attachments(booking_id, created_at);
