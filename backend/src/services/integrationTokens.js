// Plan 28 W1 (D-28-1): personal integration tokens, not OAuth. A token is minted
// once, shown to the owner in plaintext exactly one time, and stored only as a
// sha256 hash — deliberately unlike auth_sessions, which stores its (short-lived,
// cookie-only) session token as plaintext (F-28-25). Losing the plaintext after
// creation is the intended behaviour, not a bug: revoke and reissue.
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { getDb } from '../db/database.js';

// D-28-6: the fixed scope vocabulary a token can carry. trips:write and
// documents:write are reserved for a later wave (W1 ships read tools only) but
// are declared here now so token minting/UI never needs a second migration to
// add a scope.
export const SCOPES = ['trips:read', 'trips:write', 'documents:write'];

export const TOKEN_PREFIX_LENGTH = 12; // 'trp_' + 8 chars

const LAST_USED_THROTTLE_MS = 60_000;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound() {
  return Object.assign(new Error('Token not found'), { status: 404 });
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

// SQLite's datetime('now') (used for last_used_at) returns a naive
// 'YYYY-MM-DD HH:MM:SS' UTC string with no timezone designator. Handing that
// straight to `new Date(...)` makes V8 parse it as LOCAL time, silently
// shifting it by the host's UTC offset — correct on a UTC host, wrong
// everywhere else. expires_at is unaffected: it is always written as a JS
// `.toISOString()` value, which already carries 'Z'.
function parseSqliteUtcDatetime(value) {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function validateName(name) {
  if (typeof name !== 'string') throw badRequest('name is required');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw badRequest('name must be between 1 and 64 characters');
  }
  return trimmed;
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw badRequest('scopes must be a non-empty array');
  }
  const deduped = [...new Set(scopes)];
  for (const scope of deduped) {
    if (!SCOPES.includes(scope)) {
      throw badRequest(`Unknown scope: ${scope}`);
    }
  }
  // Stored in SCOPES order, not caller-submitted order, so the same scope set
  // always serializes identically regardless of how the client sent it.
  return SCOPES.filter((scope) => deduped.includes(scope));
}

function validateExpiresInDays(expiresInDays) {
  if (expiresInDays === null || expiresInDays === undefined) return null;
  if (!Number.isInteger(expiresInDays) || expiresInDays <= 0 || expiresInDays > 3650) {
    throw badRequest('expiresInDays must be a positive integer of at most 3650, or null');
  }
  return expiresInDays;
}

function toRecord(row) {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.username !== undefined ? { username: row.username } : {}),
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: JSON.parse(row.scopes_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createToken(userId, { name, scopes, expiresInDays = null } = {}) {
  const validName = validateName(name);
  const validScopes = validateScopes(scopes);
  const validExpiresInDays = validateExpiresInDays(expiresInDays);

  const token = 'trp_' + randomBytes(32).toString('base64url');
  const tokenPrefix = token.slice(0, TOKEN_PREFIX_LENGTH);
  const tokenHash = sha256Hex(token);
  const expiresAt = validExpiresInDays
    ? new Date(Date.now() + validExpiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const row = getDb().prepare(`
    INSERT INTO integration_tokens (user_id, name, token_hash, token_prefix, scopes_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(userId, validName, tokenHash, tokenPrefix, JSON.stringify(validScopes), expiresAt);

  return { token, record: toRecord(row) };
}

export function listTokens(userId, { all = false } = {}) {
  const db = getDb();
  if (all) {
    return db.prepare(`
      SELECT it.*, u.username AS username
      FROM integration_tokens it
      JOIN users u ON u.id = it.user_id
      ORDER BY it.created_at DESC
    `).all().map(toRecord);
  }
  return db.prepare(`
    SELECT * FROM integration_tokens WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId).map(toRecord);
}

export function revokeToken(userId, id, { isAdmin = false } = {}) {
  const db = getDb();
  const row = isAdmin
    ? db.prepare(`
        UPDATE integration_tokens SET revoked_at = datetime('now')
        WHERE id = ? AND revoked_at IS NULL
        RETURNING *
      `).get(id)
    : db.prepare(`
        UPDATE integration_tokens SET revoked_at = datetime('now')
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        RETURNING *
      `).get(id, userId);

  if (!row) throw notFound();
  return toRecord(row);
}

// Plan 28 W5.6: revoke is the instant-kill-plus-audit-trail step and stays
// forever (W1 deviation 5 — the list only grows). Delete is a separate
// cleanup action available on revoked rows only; deleting a still-live token
// is refused with 409 so a row can never vanish while its hash still
// authenticates verifyToken.
export function deleteToken(userId, id, { isAdmin = false } = {}) {
  const db = getDb();
  const row = isAdmin
    ? db.prepare('SELECT * FROM integration_tokens WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM integration_tokens WHERE id = ? AND user_id = ?').get(id, userId);

  if (!row) throw notFound();
  if (row.revoked_at === null) {
    throw Object.assign(new Error('Revoke this token before deleting it'), { status: 409, code: 'token_live' });
  }

  db.prepare('DELETE FROM integration_tokens WHERE id = ?').run(id);
  return toRecord(row);
}

export function verifyToken(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.startsWith('trp_')) return null;

  const db = getDb();
  const tokenHash = sha256Hex(plaintext);
  const tokenHashBuffer = Buffer.from(tokenHash, 'hex');
  const prefix = plaintext.slice(0, TOKEN_PREFIX_LENGTH);

  const candidates = db.prepare(`
    SELECT * FROM integration_tokens WHERE token_prefix = ?
  `).all(prefix);

  const now = new Date();
  let match = null;
  for (const candidate of candidates) {
    const candidateHashBuffer = Buffer.from(candidate.token_hash, 'hex');
    if (candidateHashBuffer.length !== tokenHashBuffer.length) continue;
    if (!timingSafeEqual(candidateHashBuffer, tokenHashBuffer)) continue;
    match = candidate;
    break;
  }

  if (!match) return null;
  if (match.revoked_at) return null;
  if (match.expires_at && new Date(match.expires_at) <= now) return null;

  const lastUsedAt = match.last_used_at ? parseSqliteUtcDatetime(match.last_used_at) : null;
  if (!lastUsedAt || now.getTime() - lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    db.prepare(`UPDATE integration_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(match.id);
  }

  return {
    id: match.id,
    userId: match.user_id,
    scopes: JSON.parse(match.scopes_json),
    expiresAt: match.expires_at,
  };
}
