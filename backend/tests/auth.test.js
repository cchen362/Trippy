import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';

let tmpDir;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-auth-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('authService.needsSetup', () => {
  it('returns true when no users exist', () => {
    expect(authService.needsSetup()).toBe(true);
  });
});

describe('authService.setup', () => {
  it('creates admin user and invite code, returns session token', () => {
    const result = authService.setup('admin', 'password123', 'Admin');
    expect(result.token).toBeTruthy();
    expect(result.user.username).toBe('admin');
    expect(result.user.is_admin).toBe(1);
    expect(authService.needsSetup()).toBe(false);

    const db = getDb();
    const code = db.prepare("SELECT value FROM settings WHERE key='invite_code'").get();
    expect(code.value).toHaveLength(8);
  });
});

describe('authService.register', () => {
  it('registers a new user with valid invite code', () => {
    const db = getDb();
    const { value: code } = db.prepare("SELECT value FROM settings WHERE key='invite_code'").get();
    const result = authService.register('traveller', 'pass456', 'Traveller', code);
    expect(result.token).toBeTruthy();
    expect(result.user.is_admin).toBe(0);
  });

  it('throws with invalid invite code', () => {
    expect(() =>
      authService.register('other', 'pass', 'Other', 'WRONGCODE')
    ).toThrow('Invalid invite code');
  });

  it('throws with duplicate username', () => {
    const db = getDb();
    const { value: code } = db.prepare("SELECT value FROM settings WHERE key='invite_code'").get();
    expect(() =>
      authService.register('traveller', 'pass', 'Dup', code)
    ).toThrow('Username already taken');
  });
});

describe('authService.login', () => {
  it('returns session token for valid credentials', () => {
    const result = authService.login('admin', 'password123');
    expect(result.token).toBeTruthy();
  });

  it('throws for wrong password', () => {
    expect(() => authService.login('admin', 'wrongpass')).toThrow('Invalid credentials');
  });

  it('throws for unknown username', () => {
    expect(() => authService.login('nobody', 'pass')).toThrow('Invalid credentials');
  });
});

describe('authService.validateToken', () => {
  it('returns user for valid token', () => {
    const { token } = authService.login('admin', 'password123');
    const user = authService.validateToken(token);
    expect(user.username).toBe('admin');
  });

  it('returns null for invalid token', () => {
    expect(authService.validateToken('bad-token')).toBeNull();
  });
});
