import bcrypt from 'bcrypt';
import { randomBytes, timingSafeEqual } from 'crypto';
import { getDb } from '../db/database.js';

const SALT_ROUNDS = 12;
const SESSION_DAYS = 30;

export function needsSetup() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
  return row.c === 0;
}

export function setup(username, password, displayName) {
  const db = getDb();
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const userId = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, 1) RETURNING id, username, display_name, is_admin'
  ).get(username, passwordHash, displayName);

  const inviteCode = randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
  db.prepare("INSERT INTO settings (key, value) VALUES ('invite_code', ?)").run(inviteCode);

  return { token: _createSession(userId.id), user: userId };
}

export function register(username, password, displayName, inviteCode) {
  const db = getDb();
  const stored = db.prepare("SELECT value FROM settings WHERE key='invite_code'").get();
  const codeMatch = stored &&
    stored.value.length === inviteCode.length &&
    timingSafeEqual(Buffer.from(stored.value), Buffer.from(inviteCode));
  if (!codeMatch) throw Object.assign(new Error('Invalid invite code'), { status: 403 });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw Object.assign(new Error('Username already taken'), { status: 409 });

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const user = db.prepare(
    'INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?) RETURNING id, username, display_name, is_admin'
  ).get(username, passwordHash, displayName);

  return { token: _createSession(user.id), user };
}

export function login(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }
  const { password_hash, ...safeUser } = user;
  return { token: _createSession(user.id), user: safeUser };
}

export function validateToken(token) {
  const db = getDb();
  const session = db.prepare(
    "SELECT s.*, u.id as uid, u.username, u.display_name, u.is_admin FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).get(token);
  if (!session) return null;
  return { id: session.uid, username: session.username, display_name: session.display_name, is_admin: session.is_admin };
}

export function logout(token) {
  getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

export function getInviteCode() {
  return getDb().prepare("SELECT value FROM settings WHERE key='invite_code'").get()?.value;
}

export function regenerateInviteCode() {
  const newCode = randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('invite_code', ?)").run(newCode);
  return newCode;
}

export function listUsers() {
  return getDb().prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at').all();
}

export function deleteUser(userId, requestingUserId) {
  if (userId === requestingUserId) throw Object.assign(new Error('Cannot delete yourself'), { status: 400 });
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function _createSession(userId) {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO auth_sessions (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
  // Clean up expired sessions lazily
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
  return token;
}
