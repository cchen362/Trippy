import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createToken } from '../src/services/integrationTokens.js';

// Plan 28 W2: exercises 034_mcp_drafts.sql on a fresh disposable DB.

let tmpDir;
let userId;
let tokenId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-034-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  const user = authService.setup('m034-owner', 'password123', 'M034 Owner').user;
  userId = user.id;
  tokenId = createToken(userId, { name: 'test token', scopes: ['trips:read'] }).record.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function baseRow(overrides = {}) {
  return {
    user_id: userId,
    token_id: tokenId,
    idempotency_key: 'idem-1',
    kind: 'booking',
    target_json: '{}',
    bookings_json: '[]',
    issues_json: '[]',
    planned_effects_json: '[]',
    source_json: '{}',
    status: 'pending',
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function insertDraft(db, overrides = {}) {
  const row = baseRow(overrides);
  return db.prepare(`
    INSERT INTO mcp_drafts (
      user_id, token_id, idempotency_key, kind, target_json, bookings_json,
      issues_json, planned_effects_json, source_json, status, expires_at
    )
    VALUES (@user_id, @token_id, @idempotency_key, @kind, @target_json, @bookings_json,
      @issues_json, @planned_effects_json, @source_json, @status, @expires_at)
    RETURNING *
  `).get(row);
}

describe('034_mcp_drafts', () => {
  it('is recorded in _migrations', () => {
    const db = getDb();
    const row = db.prepare("SELECT filename FROM _migrations WHERE filename = '034_mcp_drafts.sql'").get();
    expect(row).toBeTruthy();
  });

  it('creates the table with every expected column', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(mcp_drafts)').all().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'user_id', 'token_id', 'idempotency_key', 'kind', 'target_json',
      'bookings_json', 'issues_json', 'planned_effects_json', 'source_json',
      'trip_id', 'booking_fingerprint', 'status', 'status_reason', 'result_json',
      'created_at', 'expires_at', 'applied_at',
    ]);
  });

  it('creates the status/expiry index', () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_drafts'",
    ).all().map((r) => r.name);
    expect(indexes).toContain('idx_mcp_drafts_status_expiry');
  });

  it('defaults kind to booking and status to pending', () => {
    const db = getDb();
    const row = db.prepare(`
      INSERT INTO mcp_drafts (
        user_id, token_id, idempotency_key, target_json, bookings_json,
        issues_json, planned_effects_json, source_json, expires_at
      )
      VALUES (?, ?, 'idem-defaults', '{}', '[]', '[]', '[]', '{}', '2099-01-01T00:00:00.000Z')
      RETURNING *
    `).get(userId, tokenId);
    expect(row.kind).toBe('booking');
    expect(row.status).toBe('pending');
  });

  it('enforces UNIQUE(user_id, idempotency_key)', () => {
    const db = getDb();
    insertDraft(db, { idempotency_key: 'idem-unique' });
    expect(() => insertDraft(db, { idempotency_key: 'idem-unique' })).toThrow();
  });

  it('enforces the CHECK on kind', () => {
    const db = getDb();
    expect(() => insertDraft(db, { idempotency_key: 'idem-kind', kind: 'bogus' })).toThrow();
  });

  it('enforces the CHECK on status', () => {
    const db = getDb();
    expect(() => insertDraft(db, { idempotency_key: 'idem-status', status: 'bogus' })).toThrow();
  });

  it('cascade-deletes drafts when the owning user is deleted', () => {
    const db = getDb();
    const { value: inviteCode } = db.prepare("SELECT value FROM settings WHERE key='invite_code'").get();
    const user = authService.register('m034-cascade', 'password123', 'M034 Cascade', inviteCode).user;
    const token = createToken(user.id, { name: 'cascade token', scopes: ['trips:read'] }).record;
    insertDraft(db, { user_id: user.id, token_id: token.id, idempotency_key: 'idem-cascade' });

    expect(db.prepare('SELECT COUNT(*) AS c FROM mcp_drafts WHERE user_id = ?').get(user.id).c).toBe(1);

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    expect(db.prepare('SELECT COUNT(*) AS c FROM mcp_drafts WHERE user_id = ?').get(user.id).c).toBe(0);
  });
});
