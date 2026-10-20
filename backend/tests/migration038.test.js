import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';

// Plan 37 W1: exercises 038_document_facts.sql on a fresh disposable DB.

let tmpDir;
let userId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-038-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  userId = authService.setup('m038-owner', 'password123', 'M038 Owner').user.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

async function makeTrip(title = 'Migration 038 trip') {
  const trip = createTrip(userId, {
    title,
    destinations: ['Kyoto'],
    destinationCountries: ['JP'],
    startDate: '2099-01-01',
    endDate: '2099-01-05',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
  const booking = await createBooking(userId, trip.trip.id, { type: 'hotel', title: 'Test hotel', confirmationRef: 'H38' });
  return { tripId: trip.trip.id, bookingId: booking.id };
}

function makeAttachment(bookingId) {
  return getDb().prepare(`
    INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
    VALUES (?, 'application/pdf', 'a.pdf', 1, ?, 'h-att', 'manual') RETURNING id
  `).get(bookingId, Buffer.from('x')).id;
}

function makeImportFile() {
  const db = getDb();
  const { id: artifactId } = db.prepare("INSERT INTO import_artifacts (user_id, status) VALUES (?, 'extracted') RETURNING id").get(userId);
  const { id } = db.prepare(`
    INSERT INTO import_artifact_files (artifact_id, position, kind, media_type, filename, size_bytes, content_hash, content)
    VALUES (?, 0, 'pdf', 'application/pdf', 'f.pdf', 1, 'h-file', ?) RETURNING id
  `).get(artifactId, Buffer.from('x'));
  return { artifactId, fileId: id };
}

function insertRead(tripId, { bookingId = null, artifactFileId = null, attachmentId = null, status = 'complete' } = {}) {
  return getDb().prepare(`
    INSERT INTO document_fact_reads (trip_id, booking_id, artifact_file_id, attachment_id, content_hash, model, prompt_version, status)
    VALUES (?, ?, ?, ?, 'h', 'claude-haiku-5-5', '37.1', ?) RETURNING id
  `).get(tripId, bookingId, artifactFileId, attachmentId, status).id;
}

function insertFact(readId, tripId, { bookingId = null, artifactFileId = null, attachmentId = null, ...over } = {}) {
  const row = {
    kind: 'deadline', tz_source: 'none', confidence: 'high', quote_verified: 0, ...over,
  };
  return getDb().prepare(`
    INSERT INTO document_facts
      (read_id, trip_id, booking_id, artifact_file_id, attachment_id, kind, label, value, quote,
       quote_verified, tz_source, confidence, position)
    VALUES (?, ?, ?, ?, ?, ?, 'Free cancellation until', '14 November', 'Cancel by 14 Nov', ?, ?, ?, 0) RETURNING id
  `).get(readId, tripId, bookingId, artifactFileId, attachmentId, row.kind, row.quote_verified, row.tz_source, row.confidence).id;
}

const count = (table, where = '1=1', ...args) =>
  getDb().prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...args).c;

describe('038_document_facts', () => {
  it('is recorded in _migrations', () => {
    const row = getDb().prepare("SELECT filename FROM _migrations WHERE filename = '038_document_facts.sql'").get();
    expect(row).toBeTruthy();
  });

  it('creates document_fact_reads with every expected column', () => {
    const columns = getDb().prepare('PRAGMA table_info(document_fact_reads)').all().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'trip_id', 'booking_id', 'artifact_file_id', 'attachment_id', 'content_hash', 'model',
      'prompt_version', 'status', 'fact_count', 'verified_count', 'input_tokens', 'output_tokens',
      'total_ms', 'stop_reason', 'error', 'created_at',
    ]);
  });

  it('creates document_facts with every expected column', () => {
    const columns = getDb().prepare('PRAGMA table_info(document_facts)').all().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'read_id', 'trip_id', 'booking_id', 'artifact_file_id', 'attachment_id', 'kind', 'label',
      'value', 'quote', 'page', 'verified_page', 'quote_verified', 'value_at', 'value_tz', 'tz_source',
      'applies_from', 'applies_to', 'confidence', 'position', 'created_at',
    ]);
  });

  it('creates the read-key, per-trip, per-source and fact indexes', () => {
    const names = (table) => getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
    ).all(table).map((r) => r.name);
    expect(names('document_fact_reads')).toEqual(expect.arrayContaining([
      'idx_document_fact_reads_key', 'idx_document_fact_reads_trip', 'idx_document_fact_reads_artifact_file', 'idx_document_fact_reads_attachment',
    ]));
    expect(names('document_facts')).toEqual(expect.arrayContaining([
      'idx_document_facts_trip_due', 'idx_document_facts_booking', 'idx_document_facts_read',
    ]));
  });

  it('generates a 32-character hex id', async () => {
    const { tripId, bookingId } = await makeTrip();
    const id = insertRead(tripId, { attachmentId: makeAttachment(bookingId) });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  describe('CHECK constraints', () => {
    it('document_fact_reads requires exactly one source', async () => {
      const { tripId, bookingId } = await makeTrip();
      const attachmentId = makeAttachment(bookingId);
      const { fileId } = makeImportFile();
      expect(() => insertRead(tripId, {})).toThrow(/CHECK/);
      expect(() => insertRead(tripId, { artifactFileId: fileId, attachmentId })).toThrow(/CHECK/);
      expect(() => insertRead(tripId, { artifactFileId: fileId })).not.toThrow();
      expect(() => insertRead(tripId, { bookingId, attachmentId })).not.toThrow();
    });

    it('document_fact_reads limits status to the six values', async () => {
      const { tripId, bookingId } = await makeTrip();
      const attachmentId = makeAttachment(bookingId);
      for (const status of ['complete', 'refused', 'truncated', 'invalid', 'error', 'skipped']) {
        expect(() => insertRead(tripId, { attachmentId, status })).not.toThrow();
      }
      expect(() => insertRead(tripId, { attachmentId, status: 'bogus' })).toThrow(/CHECK/);
    });

    it('document_facts requires exactly one source', async () => {
      const { tripId, bookingId } = await makeTrip();
      const attachmentId = makeAttachment(bookingId);
      const { fileId } = makeImportFile();
      const readId = insertRead(tripId, { attachmentId });
      expect(() => insertFact(readId, tripId, {})).toThrow(/CHECK/);
      expect(() => insertFact(readId, tripId, { artifactFileId: fileId, attachmentId })).toThrow(/CHECK/);
      expect(() => insertFact(readId, tripId, { attachmentId })).not.toThrow();
      expect(() => insertFact(readId, tripId, { artifactFileId: fileId })).not.toThrow();
    });

    it('document_facts limits kind, tz_source, confidence and quote_verified', async () => {
      const { tripId, bookingId } = await makeTrip();
      const attachmentId = makeAttachment(bookingId);
      const readId = insertRead(tripId, { attachmentId });
      for (const kind of ['deadline', 'window', 'requirement', 'instruction', 'allowance', 'contact', 'restriction', 'cost_condition']) {
        expect(() => insertFact(readId, tripId, { attachmentId, kind })).not.toThrow();
      }
      expect(() => insertFact(readId, tripId, { attachmentId, kind: 'bogus' })).toThrow(/CHECK/);
      expect(() => insertFact(readId, tripId, { attachmentId, tz_source: 'guess' })).toThrow(/CHECK/);
      expect(() => insertFact(readId, tripId, { attachmentId, confidence: 'certain' })).toThrow(/CHECK/);
      expect(() => insertFact(readId, tripId, { attachmentId, quote_verified: 2 })).toThrow(/CHECK/);
    });
  });

  describe('cascades', () => {
    it('deleting a trip removes its reads and facts', async () => {
      const { tripId, bookingId } = await makeTrip('Cascade trip');
      const attachmentId = makeAttachment(bookingId);
      const readId = insertRead(tripId, { bookingId, attachmentId });
      insertFact(readId, tripId, { bookingId, attachmentId });
      expect(count('document_facts', 'trip_id = ?', tripId)).toBe(1);

      getDb().prepare('DELETE FROM trips WHERE id = ?').run(tripId);

      expect(count('document_fact_reads', 'trip_id = ?', tripId)).toBe(0);
      expect(count('document_facts', 'trip_id = ?', tripId)).toBe(0);
    });

    it('deleting a booking removes its attachment reads and facts', async () => {
      const { tripId, bookingId } = await makeTrip('Cascade booking');
      const attachmentId = makeAttachment(bookingId);
      const readId = insertRead(tripId, { bookingId, attachmentId });
      insertFact(readId, tripId, { bookingId, attachmentId });

      getDb().prepare('DELETE FROM bookings WHERE id = ?').run(bookingId);

      expect(count('document_fact_reads', 'id = ?', readId)).toBe(0);
      expect(count('document_facts', 'read_id = ?', readId)).toBe(0);
    });

    it('deleting an attachment removes its reads and facts but leaves the booking', async () => {
      const { tripId, bookingId } = await makeTrip('Cascade attachment');
      const attachmentId = makeAttachment(bookingId);
      const readId = insertRead(tripId, { bookingId, attachmentId });
      insertFact(readId, tripId, { bookingId, attachmentId });

      getDb().prepare('DELETE FROM booking_attachments WHERE id = ?').run(attachmentId);

      expect(count('document_fact_reads', 'id = ?', readId)).toBe(0);
      expect(count('document_facts', 'read_id = ?', readId)).toBe(0);
      expect(count('bookings', 'id = ?', bookingId)).toBe(1);
    });

    it('deleting an import file (or its artifact) removes its reads and facts', async () => {
      const { tripId } = await makeTrip('Cascade import');
      const { artifactId, fileId } = makeImportFile();
      const readId = insertRead(tripId, { artifactFileId: fileId });
      insertFact(readId, tripId, { artifactFileId: fileId });

      getDb().prepare('DELETE FROM import_artifacts WHERE id = ?').run(artifactId);

      expect(count('document_fact_reads', 'id = ?', readId)).toBe(0);
      expect(count('document_facts', 'read_id = ?', readId)).toBe(0);
    });

    it('deleting a read removes its facts', async () => {
      const { tripId, bookingId } = await makeTrip('Cascade read');
      const attachmentId = makeAttachment(bookingId);
      const readId = insertRead(tripId, { bookingId, attachmentId });
      insertFact(readId, tripId, { bookingId, attachmentId });

      getDb().prepare('DELETE FROM document_fact_reads WHERE id = ?').run(readId);

      expect(count('document_facts', 'read_id = ?', readId)).toBe(0);
      expect(count('booking_attachments', 'id = ?', attachmentId)).toBe(1);
    });
  });
});
