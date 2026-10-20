-- Plan 37 W1 (D-37-1, D-37-2): the conditions a booking's documents state, and the record of every
-- attempt to read them.
--
-- A fact belongs to a DOCUMENT, not to a booking: a document is one stored file, either an import
-- file (import_artifact_files; one file can back several bookings, D-38-3) or a booking attachment
-- (booking_attachments; exactly one booking). So both tables carry the same source pair with a CHECK
-- that exactly one side is set. Facts for an import file carry no booking_id: they attach to every
-- booking that owns the file at query time, resolved through importFileRowsOf. Facts for an
-- attachment carry its booking_id, so deleting the booking removes them directly as well.
--
-- document_fact_reads: one row per read attempt of one document under one read key
-- (content_hash + model + prompt_version). `error` is a short code (never document text), so this
-- table is telemetry in the style of 030: counts, timings and a stop reason, no content.
-- `skipped` rows record a read the daily cap stopped before any model call.
--
-- document_facts: the facts of a complete read. `quote` is never empty (D-37-2). `quote_verified`
-- is 1 only when Trippy found the quote in text it extracted itself; `verified_page` is where that
-- search found it, beside the model's own `page`.
--
-- Additive: new tables and indexes only. Never modify 001-037.

CREATE TABLE IF NOT EXISTS document_fact_reads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  booking_id TEXT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  artifact_file_id TEXT NULL REFERENCES import_artifact_files(id) ON DELETE CASCADE,
  attachment_id TEXT NULL REFERENCES booking_attachments(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete','refused','truncated','invalid','error','skipped')),
  fact_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_ms INTEGER,
  stop_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((artifact_file_id IS NOT NULL) + (attachment_id IS NOT NULL) = 1)
);

CREATE INDEX IF NOT EXISTS idx_document_fact_reads_key
  ON document_fact_reads(content_hash, model, prompt_version);
CREATE INDEX IF NOT EXISTS idx_document_fact_reads_trip
  ON document_fact_reads(trip_id, created_at);
-- One index per source column: a lookup names one side only (the other is NULL), so a composite led
-- by artifact_file_id could not serve an attachment lookup.
CREATE INDEX IF NOT EXISTS idx_document_fact_reads_artifact_file
  ON document_fact_reads(artifact_file_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_fact_reads_attachment
  ON document_fact_reads(attachment_id, created_at);

CREATE TABLE IF NOT EXISTS document_facts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  read_id TEXT NOT NULL REFERENCES document_fact_reads(id) ON DELETE CASCADE,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  booking_id TEXT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  artifact_file_id TEXT NULL REFERENCES import_artifact_files(id) ON DELETE CASCADE,
  attachment_id TEXT NULL REFERENCES booking_attachments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'deadline','window','requirement','instruction','allowance','contact','restriction','cost_condition'
  )),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  quote TEXT NOT NULL,
  page INTEGER NULL,
  verified_page INTEGER NULL,
  quote_verified INTEGER NOT NULL CHECK (quote_verified IN (0, 1)),
  value_at TEXT NULL,
  value_tz TEXT NULL,
  tz_source TEXT NOT NULL CHECK (tz_source IN ('document','booking','none')),
  applies_from TEXT NULL,
  applies_to TEXT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((artifact_file_id IS NOT NULL) + (attachment_id IS NOT NULL) = 1)
);

CREATE INDEX IF NOT EXISTS idx_document_facts_trip_due
  ON document_facts(trip_id, kind, value_at);
CREATE INDEX IF NOT EXISTS idx_document_facts_booking
  ON document_facts(booking_id);
CREATE INDEX IF NOT EXISTS idx_document_facts_read
  ON document_facts(read_id);
