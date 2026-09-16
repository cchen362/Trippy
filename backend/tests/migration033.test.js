import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';

// Plan 28 W1: exercises 033_integration_tokens.sql on a fresh disposable DB.

let tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-033-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('033_integration_tokens', () => {
  it('is recorded in _migrations', () => {
    const db = getDb();
    const row = db.prepare("SELECT filename FROM _migrations WHERE filename = '033_integration_tokens.sql'").get();
    expect(row).toBeTruthy();
  });

  it('creates the table with every expected column', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(integration_tokens)').all().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'user_id', 'name', 'token_hash', 'token_prefix', 'scopes_json',
      'created_at', 'expires_at', 'last_used_at', 'revoked_at',
    ]);
  });

  it('creates the user and prefix indexes', () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'integration_tokens'",
    ).all().map((r) => r.name);
    expect(indexes).toContain('idx_integration_tokens_user');
    expect(indexes).toContain('idx_integration_tokens_prefix');
  });

  it('enforces UNIQUE on token_hash', () => {
    const db = getDb();
    const user = authService.setup('m033-owner', 'password123', 'M033 Owner').user;
    db.prepare(`
      INSERT INTO integration_tokens (user_id, name, token_hash, token_prefix, scopes_json)
      VALUES (?, 'a', 'samehash', 'trp_prefix1', '["trips:read"]')
    `).run(user.id);
    expect(() => db.prepare(`
      INSERT INTO integration_tokens (user_id, name, token_hash, token_prefix, scopes_json)
      VALUES (?, 'b', 'samehash', 'trp_prefix2', '["trips:read"]')
    `).run(user.id)).toThrow();
  });

  it('cascade-deletes tokens when the owning user is deleted', () => {
    const db = getDb();
    const { value: inviteCode } = db.prepare("SELECT value FROM settings WHERE key='invite_code'").get();
    const user = authService.register('m033-cascade', 'password123', 'M033 Cascade', inviteCode).user;
    db.prepare(`
      INSERT INTO integration_tokens (user_id, name, token_hash, token_prefix, scopes_json)
      VALUES (?, 'cascade token', 'cascadehash', 'trp_cascade1', '["trips:read"]')
    `).run(user.id);

    expect(db.prepare('SELECT COUNT(*) AS c FROM integration_tokens WHERE user_id = ?').get(user.id).c).toBe(1);

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    expect(db.prepare('SELECT COUNT(*) AS c FROM integration_tokens WHERE user_id = ?').get(user.id).c).toBe(0);
  });
});
