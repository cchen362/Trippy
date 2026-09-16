import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { backfillContentHashes } from '../src/db/migrations/035_mcp_upload_tickets.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { createToken } from '../src/services/integrationTokens.js';

// Plan 28 W3.3: exercises 035_mcp_upload_tickets.js on a fresh disposable DB.

let tmpDir;
let userId;
let tokenId;
let tripId;
let bookingId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-035-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  const user = authService.setup('m035-owner', 'password123', 'M035 Owner').user;
  userId = user.id;
  tokenId = createToken(userId, { name: 'test token', scopes: ['trips:read'] }).record.id;

  const trip = createTrip(userId, {
    title: 'Migration 035 trip',
    destinations: ['Osaka'],
    destinationCountries: ['JP'],
    startDate: '2099-01-01',
    endDate: '2099-01-05',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
  tripId = trip.trip.id;
  const booking = await createBooking(userId, tripId, {
    type: 'hotel',
    title: 'Test hotel',
    confirmationRef: 'HOTEL1',
  });
  bookingId = booking.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('035_mcp_upload_tickets', () => {
  it('is recorded in _migrations', () => {
    const db = getDb();
    const row = db.prepare("SELECT filename FROM _migrations WHERE filename = '035_mcp_upload_tickets.js'").get();
    expect(row).toBeTruthy();
  });

  it('creates mcp_upload_tickets with every expected column', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(mcp_upload_tickets)').all().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'user_id', 'token_id', 'booking_id', 'expected_sha256', 'media_type',
      'max_bytes', 'status', 'created_at', 'expires_at', 'used_at', 'attachment_id',
    ]);
  });

  it('creates the booking and status/expiry indexes', () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_upload_tickets'",
    ).all().map((r) => r.name);
    expect(indexes).toContain('idx_mcp_upload_tickets_booking');
    expect(indexes).toContain('idx_mcp_upload_tickets_status_expiry');
  });

  it('enforces the CHECK on status', () => {
    const db = getDb();
    expect(() => db.prepare(`
      INSERT INTO mcp_upload_tickets (
        id, user_id, token_id, booking_id, expected_sha256, media_type, max_bytes, status, expires_at
      ) VALUES ('t1', ?, ?, ?, ?, 'image/png', 100, 'bogus', '2099-01-01T00:00:00.000Z')
    `).run(userId, tokenId, bookingId, 'a'.repeat(64))).toThrow();
  });

  it('adds content_hash and source to booking_attachments, source defaulting to manual', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(booking_attachments)').all();
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName.content_hash).toBeTruthy();
    expect(byName.source).toBeTruthy();
    expect(byName.source.notnull).toBe(1);
    expect(byName.source.dflt_value).toBe("'manual'");
  });

  it('creates idx_booking_attachments_hash', () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'booking_attachments'",
    ).all().map((r) => r.name);
    expect(indexes).toContain('idx_booking_attachments_hash');
  });

  it('cascade-deletes tickets when the owning booking is deleted', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO mcp_upload_tickets (id, user_id, token_id, booking_id, expected_sha256, media_type, max_bytes, expires_at)
      VALUES ('cascade-ticket', ?, ?, ?, ?, 'image/png', 100, '2099-01-01T00:00:00.000Z')
    `).run(userId, tokenId, bookingId, 'a'.repeat(64));
    expect(db.prepare('SELECT COUNT(*) as c FROM mcp_upload_tickets WHERE id = ?').get('cascade-ticket').c).toBe(1);

    db.prepare('DELETE FROM bookings WHERE id = ?').run(bookingId);

    expect(db.prepare('SELECT COUNT(*) as c FROM mcp_upload_tickets WHERE id = ?').get('cascade-ticket').c).toBe(0);
  });

  describe('backfillContentHashes', () => {
    it('hashes rows with a NULL content_hash and leaves already-hashed rows alone', async () => {
      const db = getDb();

      // Rebuild a booking to attach to, since the previous test deleted bookingId.
      const trip = createTrip(userId, {
        title: 'Backfill trip',
        destinations: ['Nara'],
        destinationCountries: ['JP'],
        startDate: '2099-02-01',
        endDate: '2099-02-05',
        travellers: 'solo',
        interestTags: [],
        pace: 'moderate',
      });
      const backfillBooking = await createBooking(userId, trip.trip.id, {
        type: 'hotel',
        title: 'Backfill hotel',
        confirmationRef: 'HOTEL2',
      });

      const content = Buffer.from('backfill-me-bytes');
      const expectedHash = createHash('sha256').update(content).digest('hex');

      const inserted = db.prepare(`
        INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
        VALUES (?, 'image/png', 'f.png', ?, ?, NULL, 'manual')
        RETURNING id
      `).get(backfillBooking.id, content.length, content);

      const untouchedHash = 'existing-hash-value';
      const untouched = db.prepare(`
        INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
        VALUES (?, 'image/png', 'g.png', ?, ?, ?, 'manual')
        RETURNING id
      `).get(backfillBooking.id, content.length, content, untouchedHash);

      const changed = backfillContentHashes(db);
      expect(changed).toBe(1);

      const row = db.prepare('SELECT content_hash FROM booking_attachments WHERE id = ?').get(inserted.id);
      expect(row.content_hash).toBe(expectedHash);

      const otherRow = db.prepare('SELECT content_hash FROM booking_attachments WHERE id = ?').get(untouched.id);
      expect(otherRow.content_hash).toBe(untouchedHash);

      // Idempotent: calling again is a no-op now that nothing is NULL.
      expect(backfillContentHashes(db)).toBe(0);
    });
  });
});
