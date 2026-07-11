import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

// Mock only the EXTERNAL I/O reached through stops.js — geocoding, Unsplash, and the Haiku
// photo descriptor. The real resolve/write split, validation, fingerprinting, and the atomic
// transaction all run for real against a temp SQLite DB.
vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: vi.fn().mockResolvedValue({
    lat: 30.0, lng: 120.0, resolvedName: 'Resolved Place', resolvedAddress: 'Some Address',
    coordinateSystem: 'wgs84', coordinateSource: 'nominatim', locationStatus: 'resolved',
    confidence: 0.9, providerId: 'osm:1', countryCode: 'CN',
  }),
}));
vi.mock('../src/services/unsplash.js', () => ({
  selectPhoto: vi.fn().mockResolvedValue(null),
  trackDownload: vi.fn(),
}));
vi.mock('../src/services/claude.js', () => ({
  generatePhotoDescriptor: vi.fn().mockResolvedValue(null),
}));

const {
  createProposal,
  applyProposal,
  rejectProposal,
  validateProposalOperations,
  computeTripFingerprint,
  computeLossWarnings,
  listProposalsForTrip,
} = await import('../src/services/copilotProposals.js');

let tmpDir;
let userId;
let tripId;
let otherTripId;
let dayId;
let day2Id;
let otherDayId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-proposals-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  const db = getDb();

  userId = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin)
    VALUES ('owner', 'hash', 'Owner', 1) RETURNING id
  `).get().id;

  tripId = db.prepare(`
    INSERT INTO trips (title, owner_id, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES ('Trip A', ?, '2026-05-01', '2026-05-03', 'couple', '[]', 'moderate', 'upcoming') RETURNING id
  `).get(userId).id;

  otherTripId = db.prepare(`
    INSERT INTO trips (title, owner_id, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES ('Trip B', ?, '2026-06-01', '2026-06-03', 'solo', '[]', 'moderate', 'upcoming') RETURNING id
  `).get(userId).id;

  dayId = db.prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-05-01', 'City A') RETURNING id").get(tripId).id;
  day2Id = db.prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-05-02', 'City A') RETURNING id").get(tripId).id;
  otherDayId = db.prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-06-01', 'City B') RETURNING id").get(otherTripId).id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function insertStop({ dayId: d = dayId, title = 'Stop', sortOrder = 1, note = null, photoSource = null, bookingId = null } = {}) {
  return getDb().prepare(`
    INSERT INTO stops (day_id, title, type, sort_order, note, photo_source, booking_id)
    VALUES (?, ?, 'experience', ?, ?, ?, ?) RETURNING id
  `).get(d, title, sortOrder, note, photoSource, bookingId).id;
}

function stopOrder(d) {
  return getDb().prepare('SELECT id FROM stops WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC').all(d).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Validation (schema mirror + trip membership + D6 + D7)
// ---------------------------------------------------------------------------

describe('validateProposalOperations', () => {
  it('accepts a well-formed add_stop', () => {
    const r = validateProposalOperations(
      [{ action: 'add_stop', dayId, stop: { title: 'Panda Base', type: 'experience', time: null } }],
      tripId,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown action (D12)', () => {
    const r = validateProposalOperations([{ action: 'teleport_stop', stopId: 'x' }], tripId);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown action/i);
  });

  it('rejects an unknown field on an operation (disguised move via update_stop.dayId)', () => {
    const stopId = insertStop({ title: 'Guard Field' });
    const r = validateProposalOperations(
      [{ action: 'update_stop', stopId, dayId: day2Id, fields: { title: 'x' } }],
      tripId,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unexpected field "dayId"/);
  });

  it('rejects a photo field inside update_stop.fields', () => {
    const stopId = insertStop({ title: 'Guard Photo' });
    const r = validateProposalOperations(
      [{ action: 'update_stop', stopId, fields: { unsplashPhotoUrl: 'http://x' } }],
      tripId,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot change field "unsplashPhotoUrl"/);
  });

  it('rejects a cross-trip stop reference (closes fact 3)', () => {
    const otherStop = insertStop({ dayId: otherDayId, title: 'Foreign Stop' });
    const r = validateProposalOperations([{ action: 'remove_stop', stopId: otherStop }], tripId);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not part of this trip/);
  });

  it('rejects a cross-trip dayId on add_stop', () => {
    const r = validateProposalOperations(
      [{ action: 'add_stop', dayId: otherDayId, stop: { title: 'x', type: 'food' } }],
      tripId,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not part of this trip/);
  });

  it('refuses a booking-linked stop (D6)', () => {
    const db = getDb();
    const bookingId = db.prepare("INSERT INTO bookings (trip_id, type, title) VALUES (?, 'flight', 'CA123') RETURNING id").get(tripId).id;
    const stopId = insertStop({ title: 'Booked Flight', bookingId });
    const r = validateProposalOperations([{ action: 'remove_stop', stopId }], tripId);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/booking-linked/i);
    expect(r.reason).toMatch(/Logistics/);
  });

  it('rejects an invalid time format (D7)', () => {
    const r = validateProposalOperations(
      [{ action: 'add_stop', dayId, stop: { title: 'x', type: 'food', time: '25:99' } }],
      tripId,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HH:MM/);
  });

  it('accepts null time and a valid HH:MM', () => {
    expect(validateProposalOperations([{ action: 'add_stop', dayId, stop: { title: 'x', type: 'food', time: '09:30' } }], tripId).ok).toBe(true);
    expect(validateProposalOperations([{ action: 'add_stop', dayId, stop: { title: 'x', type: 'food', time: null } }], tripId).ok).toBe(true);
  });

  it('rejects an empty operations array', () => {
    expect(validateProposalOperations([], tripId).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createProposal — records invalid proposals loudly (D12)
// ---------------------------------------------------------------------------

describe('createProposal', () => {
  it('stores a valid tool call as pending', () => {
    const stopId = insertStop({ title: 'Create Valid' });
    const result = createProposal({ tripId, userId, messageId: null, operations: [{ action: 'remove_stop', stopId }] });
    expect(result.status).toBe('pending');
    expect(result.proposalId).toBeDefined();
  });

  it('stores an invalid tool call as invalid with a reason (never a silent no-op)', () => {
    const result = createProposal({ tripId, userId, messageId: null, operations: [{ action: 'bogus' }] });
    expect(result.status).toBe('invalid');
    expect(result.statusReason).toMatch(/unknown action/i);
    const row = getDb().prepare('SELECT status, status_reason FROM copilot_proposals WHERE id = ?').get(result.proposalId);
    expect(row.status).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// Loss warnings (D5)
// ---------------------------------------------------------------------------

describe('computeLossWarnings', () => {
  it('warns when removing a stop with a user note', () => {
    const stopId = insertStop({ title: 'Has Note', note: 'my private plan' });
    const warnings = computeLossWarnings([{ action: 'remove_stop', stopId }], tripId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].losses).toContain('note');
  });

  it('warns when updating a stop with a user-pinned photo', () => {
    const stopId = insertStop({ title: 'Pinned Photo', photoSource: 'user' });
    const warnings = computeLossWarnings([{ action: 'update_stop', stopId, fields: { time: '10:00' } }], tripId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].losses).toContain('photo');
  });

  it('does not warn for a stop with neither note nor user photo', () => {
    const stopId = insertStop({ title: 'Plain Stop' });
    expect(computeLossWarnings([{ action: 'remove_stop', stopId }], tripId)).toHaveLength(0);
  });

  it('surfaces warnings in the created proposal + history', () => {
    const stopId = insertStop({ title: 'Warned Stop', note: 'keep me' });
    const { proposalId, warnings } = createProposal({ tripId, userId, messageId: null, operations: [{ action: 'remove_stop', stopId }] });
    expect(warnings[0].losses).toContain('note');
    const fromHistory = listProposalsForTrip(tripId).find((p) => p.id === proposalId);
    expect(fromHistory.warnings[0].stopId).toBe(stopId);
  });
});

// ---------------------------------------------------------------------------
// applyProposal — atomicity, staleness, move ordering
// ---------------------------------------------------------------------------

describe('applyProposal', () => {
  it('applies an add_stop, creating the stop and marking the proposal applied', async () => {
    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [{ action: 'add_stop', dayId, stop: { title: 'New Museum', type: 'experience', time: null } }],
    });
    await applyProposal({ tripId, userId, proposalId });

    const db = getDb();
    expect(db.prepare("SELECT id FROM stops WHERE day_id = ? AND title = 'New Museum'").get(dayId)).toBeDefined();
    expect(db.prepare('SELECT status FROM copilot_proposals WHERE id = ?').get(proposalId).status).toBe('applied');
  });

  it('rolls back completely when one operation fails mid-proposal (D4 atomicity)', async () => {
    // remove_stop(A) then update_stop(A): both valid at creation, but at write time the
    // update targets a row the remove just deleted → writeUpdateStop throws → the whole
    // transaction (including the delete) rolls back.
    const stopId = insertStop({ title: 'Atomic Victim', sortOrder: 20 });
    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [
        { action: 'remove_stop', stopId },
        { action: 'update_stop', stopId, fields: { time: '12:00' } },
      ],
    });

    await expect(applyProposal({ tripId, userId, proposalId })).rejects.toBeTruthy();

    const db = getDb();
    // The delete was rolled back — the stop still exists.
    expect(db.prepare('SELECT id FROM stops WHERE id = ?').get(stopId)).toBeDefined();
    // The proposal was NOT marked applied.
    expect(db.prepare('SELECT status FROM copilot_proposals WHERE id = ?').get(proposalId).status).toBe('pending');
  });

  it('returns 409 stale when the trip changed between proposal and apply', async () => {
    const stopId = insertStop({ title: 'Stale Target', sortOrder: 30 });
    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [{ action: 'remove_stop', stopId }],
    });

    // Structural change: add another stop to the same day → fingerprint drifts.
    insertStop({ title: 'Interloper', sortOrder: 31 });

    await expect(applyProposal({ tripId, userId, proposalId })).rejects.toMatchObject({ status: 409 });
    expect(getDb().prepare('SELECT status FROM copilot_proposals WHERE id = ?').get(proposalId).status).toBe('stale');
    // Nothing was applied — the target stop survives.
    expect(getDb().prepare('SELECT id FROM stops WHERE id = ?').get(stopId)).toBeDefined();
  });

  it('translates move_stop position into 1-based sort_order (no 0-vs-1 collision)', async () => {
    // Fresh day to isolate ordering.
    const md = getDb().prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-05-03', 'City A') RETURNING id").get(tripId).id;
    const s1 = insertStop({ dayId: md, title: 'M1', sortOrder: 1 });
    const s2 = insertStop({ dayId: md, title: 'M2', sortOrder: 2 });
    const s3 = insertStop({ dayId: md, title: 'M3', sortOrder: 3 });

    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [{ action: 'move_stop', stopId: s3, toDayId: md, position: 0 }],
    });
    await applyProposal({ tripId, userId, proposalId });

    expect(stopOrder(md)).toEqual([s3, s1, s2]);
    const orders = getDb().prepare('SELECT sort_order FROM stops WHERE day_id = ? ORDER BY sort_order ASC').all(md).map((r) => r.sort_order);
    expect(orders).toEqual([1, 2, 3]);
  });

  it('moves a stop across days and reindexes both days', async () => {
    const from = getDb().prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-05-04', 'City A') RETURNING id").get(tripId).id;
    const to = getDb().prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-05-05', 'City A') RETURNING id").get(tripId).id;
    const a = insertStop({ dayId: from, title: 'A', sortOrder: 1 });
    const b = insertStop({ dayId: from, title: 'B', sortOrder: 2 });
    const c = insertStop({ dayId: to, title: 'C', sortOrder: 1 });

    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [{ action: 'move_stop', stopId: a, toDayId: to, position: 1 }],
    });
    await applyProposal({ tripId, userId, proposalId });

    expect(stopOrder(from)).toEqual([b]);
    expect(stopOrder(to)).toEqual([c, a]);
  });

  it('rejects applying a non-pending proposal with 409', async () => {
    const stopId = insertStop({ title: 'Once', sortOrder: 40 });
    const { proposalId } = createProposal({ tripId, userId, messageId: null, operations: [{ action: 'remove_stop', stopId }] });
    await applyProposal({ tripId, userId, proposalId });
    await expect(applyProposal({ tripId, userId, proposalId })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an unknown / cross-trip proposal id with 404', async () => {
    await expect(applyProposal({ tripId, userId, proposalId: 'nope' })).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// rejectProposal
// ---------------------------------------------------------------------------

describe('rejectProposal', () => {
  it('marks a pending proposal rejected and leaves the trip untouched', () => {
    const stopId = insertStop({ title: 'Reject Target', sortOrder: 50 });
    const { proposalId } = createProposal({ tripId, userId, messageId: null, operations: [{ action: 'remove_stop', stopId }] });
    rejectProposal({ tripId, userId, proposalId });
    expect(getDb().prepare('SELECT status FROM copilot_proposals WHERE id = ?').get(proposalId).status).toBe('rejected');
    expect(getDb().prepare('SELECT id FROM stops WHERE id = ?').get(stopId)).toBeDefined();
  });

  it('cannot reject an already-applied proposal', async () => {
    const stopId = insertStop({ title: 'Applied Then Reject', sortOrder: 51 });
    const { proposalId } = createProposal({ tripId, userId, messageId: null, operations: [{ action: 'remove_stop', stopId }] });
    await applyProposal({ tripId, userId, proposalId });
    expect(() => rejectProposal({ tripId, userId, proposalId })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeTripFingerprint
// ---------------------------------------------------------------------------

describe('computeTripFingerprint', () => {
  it('is stable across calls and changes when a stop time changes', () => {
    const d = getDb().prepare("INSERT INTO days (trip_id, date, city) VALUES (?, '2026-05-06', 'City A') RETURNING id").get(tripId).id;
    const s = insertStop({ dayId: d, title: 'FP', sortOrder: 1 });
    const before = computeTripFingerprint(tripId);
    expect(computeTripFingerprint(tripId)).toBe(before);
    getDb().prepare('UPDATE stops SET time = ? WHERE id = ?').run('08:00', s);
    expect(computeTripFingerprint(tripId)).not.toBe(before);
  });
});
