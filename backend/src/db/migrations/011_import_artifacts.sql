CREATE TABLE IF NOT EXISTS import_artifacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id TEXT REFERENCES trips(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','extracting','extracted','confirmed','failed')),
  model TEXT,
  extracted_json TEXT,
  error TEXT,
  created_booking_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  extracted_at TEXT,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS import_artifact_files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  artifact_id TEXT NOT NULL REFERENCES import_artifacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('text','image','pdf')),
  media_type TEXT NOT NULL,
  filename TEXT,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_artifacts_user ON import_artifacts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_import_artifacts_trip ON import_artifacts(trip_id);
CREATE INDEX IF NOT EXISTS idx_import_artifact_files_hash ON import_artifact_files(content_hash);
