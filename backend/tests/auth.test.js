import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import authRoutes from '../src/routes/auth.js';
import { AUTH_RATE_LIMIT } from '../src/middleware/rateLimit.js';

let tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-auth-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
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

describe('rate limiting on /api/auth', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('allows normal login traffic under the cap', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 once the request cap is exceeded', async () => {
    let lastStatus;
    for (let i = 0; i < AUTH_RATE_LIMIT + 1; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
