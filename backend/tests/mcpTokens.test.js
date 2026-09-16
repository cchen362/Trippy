import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import {
  SCOPES, createToken, listTokens, revokeToken, deleteToken, verifyToken,
} from '../src/services/integrationTokens.js';
import integrationRoutes from '../src/routes/integrations.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

let tmpDir;
let owner;
let other;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-mcp-tokens-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('token-owner', 'password123', 'Token Owner').user;
  const { value: inviteCode } = getDb().prepare("SELECT value FROM settings WHERE key='invite_code'").get();
  other = authService.register('token-other', 'password123', 'Token Other', inviteCode).user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('createToken', () => {
  it('returns a trp_-prefixed plaintext token and a hash-free record', () => {
    const { token, record } = createToken(owner.id, { name: 'CLI', scopes: ['trips:read'] });

    expect(token.startsWith('trp_')).toBe(true);
    expect(token.length).toBe(4 + 43);
    expect(record.tokenPrefix).toBe(token.slice(0, 12));
    expect(record.tokenPrefix.length).toBe(12);
    expect(record).not.toHaveProperty('tokenHash');
    expect(record).not.toHaveProperty('token_hash');
    expect(record.scopes).toEqual(['trips:read']);
    expect(record.revokedAt).toBeNull();
  });

  it('de-duplicates and orders scopes to match SCOPES order', () => {
    const { record } = createToken(owner.id, {
      name: 'dup', scopes: ['documents:write', 'trips:read', 'trips:read'],
    });
    expect(record.scopes).toEqual(['trips:read', 'documents:write']);
  });

  it('rejects an unknown scope', () => {
    expect(() => createToken(owner.id, { name: 'bad', scopes: ['not:a:scope'] })).toThrow();
  });

  it('rejects an empty scopes array', () => {
    expect(() => createToken(owner.id, { name: 'bad', scopes: [] })).toThrow();
  });

  it('rejects a missing or too-long name', () => {
    expect(() => createToken(owner.id, { name: '', scopes: SCOPES })).toThrow();
    expect(() => createToken(owner.id, { name: 'x'.repeat(65), scopes: SCOPES })).toThrow();
  });

  it('rejects an invalid expiresInDays', () => {
    expect(() => createToken(owner.id, { name: 'x', scopes: SCOPES, expiresInDays: 0 })).toThrow();
    expect(() => createToken(owner.id, { name: 'x', scopes: SCOPES, expiresInDays: -1 })).toThrow();
    expect(() => createToken(owner.id, { name: 'x', scopes: SCOPES, expiresInDays: 3651 })).toThrow();
    expect(() => createToken(owner.id, { name: 'x', scopes: SCOPES, expiresInDays: 1.5 })).toThrow();
  });

  it('accepts a null expiresInDays (non-expiring)', () => {
    const { record } = createToken(owner.id, { name: 'never', scopes: SCOPES, expiresInDays: null });
    expect(record.expiresAt).toBeNull();
  });
});

describe('verifyToken', () => {
  it('resolves a valid plaintext token', () => {
    const { token, record } = createToken(owner.id, { name: 'CLI', scopes: ['trips:read'] });
    const result = verifyToken(token);
    expect(result).toEqual({
      id: record.id, userId: owner.id, scopes: ['trips:read'], expiresAt: null,
    });
  });

  it('returns null for a wrong token', () => {
    createToken(owner.id, { name: 'CLI', scopes: ['trips:read'] });
    expect(verifyToken('trp_totallywrongtoken')).toBeNull();
  });

  it('returns null for a non-trp_ string and for non-strings', () => {
    expect(verifyToken('not-a-token')).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
    expect(verifyToken(null)).toBeNull();
  });

  it('returns null for a revoked token', () => {
    const { token, record } = createToken(owner.id, { name: 'CLI', scopes: ['trips:read'] });
    revokeToken(owner.id, record.id);
    expect(verifyToken(token)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const { token, record } = createToken(owner.id, { name: 'CLI', scopes: ['trips:read'] });
    getDb().prepare("UPDATE integration_tokens SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(record.id);
    expect(verifyToken(token)).toBeNull();
  });

  it('throttles last_used_at updates to once per 60s', () => {
    const { token, record } = createToken(owner.id, { name: 'CLI', scopes: ['trips:read'] });

    // A real "10 seconds ago" timestamp (well inside the 60s throttle window)
    // computed by SQLite itself, so it is unambiguous regardless of host
    // timezone — the value this test asserts stays UNCHANGED.
    const recentSentinel = getDb().prepare("SELECT datetime('now', '-10 seconds') AS t").get().t;
    getDb().prepare('UPDATE integration_tokens SET last_used_at = ? WHERE id = ?').run(recentSentinel, record.id);
    verifyToken(token);
    const withinWindowStamp = getDb().prepare('SELECT last_used_at FROM integration_tokens WHERE id = ?').get(record.id).last_used_at;
    expect(withinWindowStamp).toBe(recentSentinel);

    const staleSentinel = '2000-01-01 00:00:00';
    getDb().prepare('UPDATE integration_tokens SET last_used_at = ? WHERE id = ?').run(staleSentinel, record.id);
    verifyToken(token);
    const afterStaleStamp = getDb().prepare('SELECT last_used_at FROM integration_tokens WHERE id = ?').get(record.id).last_used_at;
    expect(afterStaleStamp).not.toBe(staleSentinel);
  });
});

describe('listTokens', () => {
  it('lists only the caller own tokens by default, including revoked ones', () => {
    const { record: r1 } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    const { record: r2 } = createToken(owner.id, { name: 'b', scopes: ['trips:read'] });
    createToken(other.id, { name: 'other-token', scopes: ['trips:read'] });
    revokeToken(owner.id, r2.id);

    const tokens = listTokens(owner.id);
    expect(tokens).toHaveLength(2);
    expect(tokens.find((t) => t.id === r1.id).revokedAt).toBeNull();
    expect(tokens.find((t) => t.id === r2.id).revokedAt).toBeTruthy();
  });

  it('with all:true includes every user token with username attached', () => {
    createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    createToken(other.id, { name: 'b', scopes: ['trips:read'] });

    const tokens = listTokens(owner.id, { all: true });
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => typeof t.username === 'string')).toBe(true);
  });
});

describe('revokeToken', () => {
  it('revokes the caller own token', () => {
    const { record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    const revoked = revokeToken(owner.id, record.id);
    expect(revoked.revokedAt).toBeTruthy();
  });

  it('throws 404 when revoking a token that is not the caller own', () => {
    const { record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    expect(() => revokeToken(other.id, record.id)).toThrow('Token not found');
  });

  it('throws 404 when revoking an already-revoked token', () => {
    const { record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    revokeToken(owner.id, record.id);
    expect(() => revokeToken(owner.id, record.id)).toThrow('Token not found');
  });

  it('lets an admin revoke another user token', () => {
    const { record } = createToken(other.id, { name: 'a', scopes: ['trips:read'] });
    const revoked = revokeToken(owner.id, record.id, { isAdmin: true });
    expect(revoked.revokedAt).toBeTruthy();
  });
});

describe('deleteToken', () => {
  it('throws 409 when the token is still live', () => {
    const { record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    expect(() => deleteToken(owner.id, record.id)).toThrow('Revoke this token before deleting it');
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM integration_tokens WHERE id = ?').get(record.id).n;
    expect(count).toBe(1);
  });

  it('deletes the row once revoked, and verifyToken stays null before and after', () => {
    const { token, record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });
    revokeToken(owner.id, record.id);
    expect(verifyToken(token)).toBeNull();

    deleteToken(owner.id, record.id);
    expect(verifyToken(token)).toBeNull();

    const count = getDb().prepare('SELECT COUNT(*) AS n FROM integration_tokens WHERE id = ?').get(record.id).n;
    expect(count).toBe(0);
  });

  it('throws 404 when deleting another user revoked token as a non-admin', () => {
    const { record } = createToken(other.id, { name: 'a', scopes: ['trips:read'] });
    revokeToken(other.id, record.id, { isAdmin: false });
    expect(() => deleteToken(owner.id, record.id)).toThrow('Token not found');
  });

  it('lets an admin delete another user revoked token', () => {
    const { record } = createToken(other.id, { name: 'a', scopes: ['trips:read'] });
    revokeToken(owner.id, record.id, { isAdmin: true });
    const deleted = deleteToken(owner.id, record.id, { isAdmin: true });
    expect(deleted.id).toBe(record.id);
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM integration_tokens WHERE id = ?').get(record.id).n;
    expect(count).toBe(0);
  });

  it('throws 404 when deleting an unknown id', () => {
    expect(() => deleteToken(owner.id, 'not-a-real-id')).toThrow('Token not found');
  });
});

describe('GET /api/integrations/tokens route — all=1 admin gating', () => {
  function buildApp() {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/integrations', integrationRoutes);
    return app;
  }

  it('ignores ?all=1 for a non-admin, returns own tokens only', async () => {
    createToken(owner.id, { name: 'owner-token', scopes: ['trips:read'] });
    createToken(other.id, { name: 'other-token', scopes: ['trips:read'] });

    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const loginRes = await fetch(`http://localhost:${port}/api/integrations/tokens`, {
        headers: { Cookie: `auth_token=${authService.login('token-other', 'password123').token}` },
      });
      // token-other is a non-admin; ?all=1 must be ignored.
      const withAll = await fetch(`http://localhost:${port}/api/integrations/tokens?all=1`, {
        headers: { Cookie: `auth_token=${authService.login('token-other', 'password123').token}` },
      });
      const body = await withAll.json();
      expect(body.tokens).toHaveLength(1);
      expect(body.tokens[0].name).toBe('other-token');
      expect(loginRes.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('honours ?all=1 for an admin', async () => {
    createToken(owner.id, { name: 'owner-token', scopes: ['trips:read'] });
    createToken(other.id, { name: 'other-token', scopes: ['trips:read'] });

    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const adminToken = authService.login('token-owner', 'password123').token;
      const res = await fetch(`http://localhost:${port}/api/integrations/tokens?all=1`, {
        headers: { Cookie: `auth_token=${adminToken}` },
      });
      const body = await res.json();
      expect(body.tokens).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});

describe('POST .../revoke and DELETE .../tokens/:id routes', () => {
  function buildApp() {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/integrations', integrationRoutes);
    // The other buildApp() in this file never exercises an error path, so it
    // never needed this — these tests assert 409/404 bodies, which need the
    // same error-rendering middleware production mounts (index.js).
    app.use(errorHandler);
    return app;
  }

  it('DELETE on a live token returns 409 and leaves the row usable', async () => {
    const { token, record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });

    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const cookie = `auth_token=${authService.login('token-owner', 'password123').token}`;
      const res = await fetch(`http://localhost:${port}/api/integrations/tokens/${record.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Revoke this token before deleting it');

      const count = getDb().prepare('SELECT COUNT(*) AS n FROM integration_tokens WHERE id = ?').get(record.id).n;
      expect(count).toBe(1);
      expect(verifyToken(token)).not.toBeNull();
    } finally {
      server.close();
    }
  });

  it('POST .../revoke then DELETE succeeds and removes the row', async () => {
    const { record } = createToken(owner.id, { name: 'a', scopes: ['trips:read'] });

    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const cookie = `auth_token=${authService.login('token-owner', 'password123').token}`;

      const revokeRes = await fetch(`http://localhost:${port}/api/integrations/tokens/${record.id}/revoke`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(revokeRes.status).toBe(200);

      const deleteRes = await fetch(`http://localhost:${port}/api/integrations/tokens/${record.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect(deleteRes.status).toBe(200);

      const count = getDb().prepare('SELECT COUNT(*) AS n FROM integration_tokens WHERE id = ?').get(record.id).n;
      expect(count).toBe(0);
    } finally {
      server.close();
    }
  });

  it('DELETE on an unknown id returns 404', async () => {
    const app = buildApp();
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const cookie = `auth_token=${authService.login('token-owner', 'password123').token}`;
      const res = await fetch(`http://localhost:${port}/api/integrations/tokens/not-a-real-id`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
