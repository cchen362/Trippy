# Plan 1: Scaffold + Auth + Data Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working monorepo with Express backend, React frontend, SQLite database, full auth system (invite-code + sessions), seed data for the Chengdu/Chongqing reference trip, and Docker setup — all tested and running locally before any UI feature work begins.

**Architecture:** Monorepo with `/frontend` (Vite + React + Tailwind) and `/backend` (Express + better-sqlite3). Auth follows the AI-HTML-Builder pattern ported to Node.js: httpOnly cookie sessions, invite-code registration, admin panel endpoints. SQLite migrations run in-order at server startup.

**Tech Stack:** Node.js 20, Express 4, better-sqlite3, bcrypt, React 18, Vite 5, Tailwind CSS 3, Vitest (backend unit tests), Docker + docker-compose

**Design spec:** `docs/superpowers/specs/2026-04-23-trippy-design.md`

---

## File Map

```
/
├── .env.example                         # already created
├── .gitignore                           # already created
├── CLAUDE.md                            # already created
├── docker-compose.yml
├── Dockerfile
│
├── /backend
│   ├── package.json
│   ├── src/
│   │   ├── index.js                     # Express app entry, startup
│   │   ├── config.js                    # env vars with validation
│   │   ├── middleware/
│   │   │   ├── auth.js                  # requireAuth, requireAdmin
│   │   │   └── errorHandler.js          # global error handler
│   │   ├── db/
│   │   │   ├── database.js              # SQLite connection singleton
│   │   │   ├── migrations.js            # run migrations in order
│   │   │   └── migrations/
│   │   │       ├── 001_auth.sql         # users, auth_sessions, settings
│   │   │       ├── 002_trips.sql        # trips, trip_collaborators, share_links
│   │   │       ├── 003_days_stops.sql   # days, stops
│   │   │       ├── 004_bookings.sql     # bookings
│   │   │       └── 005_ai.sql           # discovery_cache, copilot_messages
│   │   ├── services/
│   │   │   └── auth.js                  # business logic: register, login, validate
│   │   └── routes/
│   │       ├── auth.js                  # POST /api/auth/* + /api/admin/*
│   │       └── health.js                # GET /api/health
│   └── tests/
│       ├── auth.test.js
│       └── migrations.test.js
│
├── /frontend
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx                      # AuthGate logic
│       ├── index.css                    # CSS variables, Google Fonts import
│       ├── context/
│       │   └── AuthContext.jsx          # auth state, login/register/logout
│       ├── services/
│       │   └── api.js                   # fetch wrapper, authApi, adminApi
│       ├── pages/
│       │   ├── SetupPage.jsx            # first-run admin setup
│       │   └── LoginPage.jsx            # login + register tabs
│       └── components/
│           └── admin/
│               └── AdminPanel.jsx       # invite code + user management
│
└── /data                                # gitignored — SQLite lives here
    └── seed/
        └── chengdu-chongqing.json       # reference trip seed data
```

---

## Task 1: Backend scaffold

**Files:**
- Create: `backend/package.json`
- Create: `backend/src/index.js`
- Create: `backend/src/config.js`

- [ ] **Step 1: Create backend package.json**

```json
{
  "name": "trippy-backend",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "dev": "node --watch src/index.js",
    "start": "node src/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^9.6.0",
    "bcrypt": "^5.1.1",
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create backend/src/config.js**

```js
// Validates all required env vars at startup — fail fast, never silently
const required = [
  'SESSION_SECRET',
  'DB_PATH',
  'ANTHROPIC_API_KEY',
  'UNSPLASH_ACCESS_KEY',
  'GOOGLE_PLACES_API_KEY',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET,
  dbPath: process.env.DB_PATH || './data/trippy.db',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  unsplashAccessKey: process.env.UNSPLASH_ACCESS_KEY,
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY,
  maptilerKey: process.env.MAPTILER_API_KEY || '',
  isProd: process.env.NODE_ENV === 'production',
};
```

- [ ] **Step 3: Create backend/src/index.js**

```js
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';

const app = express();

app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use(errorHandler);

async function start() {
  initDb(config.dbPath);
  runMigrations();
  app.listen(config.port, () => {
    console.log(`Trippy backend running on :${config.port} [${config.nodeEnv}]`);
  });
}

start();
```

- [ ] **Step 4: Install backend dependencies**

```bash
cd backend && npm install
```

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/src/index.js backend/src/config.js
git commit -m "feat: backend scaffold with Express and config validation"
```

---

## Task 2: Database layer — connection + migrations

**Files:**
- Create: `backend/src/db/database.js`
- Create: `backend/src/db/migrations.js`
- Create: `backend/src/db/migrations/001_auth.sql`
- Create: `backend/src/db/migrations/002_trips.sql`
- Create: `backend/src/db/migrations/003_days_stops.sql`
- Create: `backend/src/db/migrations/004_bookings.sql`
- Create: `backend/src/db/migrations/005_ai.sql`
- Create: `backend/src/middleware/errorHandler.js`
- Create: `backend/src/routes/health.js`
- Test: `backend/tests/migrations.test.js`

- [ ] **Step 1: Write the failing migration test**

```js
// backend/tests/migrations.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { initDb, getDb } from '../src/db/database.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpDir;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('migrations', () => {
  it('creates all required tables', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    expect(tables).toContain('users');
    expect(tables).toContain('auth_sessions');
    expect(tables).toContain('settings');
    expect(tables).toContain('trips');
    expect(tables).toContain('trip_collaborators');
    expect(tables).toContain('share_links');
    expect(tables).toContain('days');
    expect(tables).toContain('stops');
    expect(tables).toContain('bookings');
    expect(tables).toContain('discovery_cache');
    expect(tables).toContain('copilot_messages');
  });

  it('tracks migration versions to avoid re-running', () => {
    const db = getDb();
    // Running again should not throw
    expect(() => runMigrations()).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) as c FROM _migrations').get();
    expect(count.c).toBe(5);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd backend && npm test
```
Expected: FAIL — `runMigrations is not a function` or similar import error.

- [ ] **Step 3: Create backend/src/db/database.js**

```js
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db;

export function initDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}
```

- [ ] **Step 4: Create migration SQL files**

`backend/src/db/migrations/001_auth.sql`:
```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`backend/src/db/migrations/002_trips.sql`:
```sql
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destinations TEXT NOT NULL DEFAULT '[]',
  destination_countries TEXT NOT NULL DEFAULT '[]',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  travellers TEXT NOT NULL DEFAULT 'couple',
  interest_tags TEXT NOT NULL DEFAULT '[]',
  pace TEXT NOT NULL DEFAULT 'moderate',
  status TEXT NOT NULL DEFAULT 'upcoming',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trip_collaborators (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`backend/src/db/migrations/003_days_stops.sql`:
```sql
CREATE TABLE IF NOT EXISTS days (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  city TEXT NOT NULL,
  phase TEXT,
  hotel TEXT,
  theme TEXT,
  color_code TEXT,
  UNIQUE(trip_id, date)
);

CREATE TABLE IF NOT EXISTS stops (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  day_id TEXT NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  time TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'explore',
  note TEXT,
  lat REAL,
  lng REAL,
  unsplash_photo_url TEXT,
  estimated_cost TEXT,
  booking_required INTEGER DEFAULT 0,
  best_time TEXT,
  duration TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`backend/src/db/migrations/004_bookings.sql`:
```sql
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  confirmation_ref TEXT,
  booking_source TEXT,
  start_datetime TEXT,
  end_datetime TEXT,
  origin TEXT,
  destination TEXT,
  terminal_or_station TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`backend/src/db/migrations/005_ai.sql`:
```sql
CREATE TABLE IF NOT EXISTS discovery_cache (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  interest_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trip_id, destination, interest_hash)
);

CREATE TABLE IF NOT EXISTS copilot_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 5: Create backend/src/db/migrations.js**

```js
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export function runMigrations() {
  const db = getDb();

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    console.log(`Migration applied: ${file}`);
  }
}
```

- [ ] **Step 6: Create backend/src/middleware/errorHandler.js**

```js
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (status >= 500) {
    console.error('[ERROR]', err);
  }

  res.status(status).json({ error: message });
}
```

- [ ] **Step 7: Create backend/src/routes/health.js**

```js
import { Router } from 'express';
import { getDb } from '../db/database.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

export default router;
```

- [ ] **Step 8: Run tests — verify they pass**

```bash
cd backend && npm test
```
Expected: PASS — both migration tests green.

- [ ] **Step 9: Commit**

```bash
git add backend/src/db/ backend/src/middleware/ backend/src/routes/health.js backend/tests/migrations.test.js
git commit -m "feat: SQLite database layer with migrations"
```

---

## Task 3: Auth service + routes

**Files:**
- Create: `backend/src/services/auth.js`
- Create: `backend/src/routes/auth.js`
- Test: `backend/tests/auth.test.js`

- [ ] **Step 1: Write failing auth tests**

```js
// backend/tests/auth.test.js
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd backend && npm test tests/auth.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create backend/src/services/auth.js**

```js
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
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
  if (!stored || stored.value !== inviteCode) throw Object.assign(new Error('Invalid invite code'), { status: 403 });

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
```

- [ ] **Step 4: Create backend/src/middleware/auth.js**

```js
import { validateToken } from '../services/auth.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: 'Session expired or invalid' });

  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}
```

- [ ] **Step 5: Create backend/src/routes/auth.js**

```js
import { Router } from 'express';
import * as authService from '../services/auth.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

const COOKIE_OPTS = (isProd) => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

router.get('/status', (req, res) => {
  res.json({ needsSetup: authService.needsSetup() });
});

router.post('/setup', (req, res, next) => {
  try {
    if (!authService.needsSetup()) return res.status(409).json({ error: 'Already set up' });
    const { username, password, displayName } = req.body;
    if (!username || !password || !displayName) return res.status(400).json({ error: 'Missing fields' });
    const { token, user } = authService.setup(username, password, displayName);
    res.cookie('auth_token', token, COOKIE_OPTS(process.env.NODE_ENV === 'production'));
    res.json({ user });
  } catch (err) { next(err); }
});

router.post('/register', (req, res, next) => {
  try {
    const { username, password, displayName, inviteCode } = req.body;
    if (!username || !password || !displayName || !inviteCode) return res.status(400).json({ error: 'Missing fields' });
    const { token, user } = authService.register(username, password, displayName, inviteCode);
    res.cookie('auth_token', token, COOKIE_OPTS(process.env.NODE_ENV === 'production'));
    res.json({ user });
  } catch (err) { next(err); }
});

router.post('/login', (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const { token, user } = authService.login(username, password);
    res.cookie('auth_token', token, COOKIE_OPTS(process.env.NODE_ENV === 'production'));
    res.json({ user });
  } catch (err) { next(err); }
});

router.post('/logout', requireAuth, (req, res) => {
  authService.logout(req.cookies.auth_token);
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Admin routes
router.get('/admin/invite-code', requireAdmin, (req, res) => {
  res.json({ inviteCode: authService.getInviteCode() });
});

router.post('/admin/invite-code', requireAdmin, (req, res) => {
  res.json({ inviteCode: authService.regenerateInviteCode() });
});

router.get('/admin/users', requireAdmin, (req, res) => {
  res.json({ users: authService.listUsers() });
});

router.delete('/admin/users/:userId', requireAdmin, (req, res, next) => {
  try {
    authService.deleteUser(req.params.userId, req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
```

- [ ] **Step 6: Run all tests**

```bash
cd backend && npm test
```
Expected: All PASS — migrations + auth tests green.

- [ ] **Step 7: Manual smoke test — start the server**

```bash
cp .env.example .env
# Fill in SESSION_SECRET (run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
# Fill in DB_PATH=./data/trippy.db
# Other API keys can be placeholder for now
cd backend && npm run dev
```

Then test:
```bash
curl http://localhost:3001/api/health
# Expected: {"status":"ok","db":"connected"}

curl http://localhost:3001/api/auth/status
# Expected: {"needsSetup":true}
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/auth.js backend/src/routes/auth.js backend/src/middleware/auth.js backend/tests/auth.test.js
git commit -m "feat: auth service — invite-code registration, sessions, admin endpoints"
```

---

## Task 4: Frontend scaffold

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.js`
- Create: `frontend/tailwind.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/index.css`
- Create: `frontend/src/main.jsx`

- [ ] **Step 1: Create frontend/package.json**

```json
{
  "name": "trippy-frontend",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.4",
    "vite": "^5.3.1"
  }
}
```

- [ ] **Step 2: Create frontend/vite.config.js**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 3: Create frontend/tailwind.config.js**

```js
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'ink-deep': '#0d0b09',
        'ink-mid': '#1c1a17',
        'ink-surface': '#232018',
        gold: '#c9a84c',
        cream: '#f0ead8',
      },
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        body: ['"Cormorant Garamond"', 'serif'],
        mono: ['"DM Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 4: Create frontend/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0d0b09" />
  <title>Trippy</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=DM+Mono:wght@300;400&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
```

- [ ] **Step 5: Create frontend/src/index.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --ink-deep:    #0d0b09;
  --ink-mid:     #1c1a17;
  --ink-surface: #232018;
  --ink-border:  rgba(255,255,255,0.07);
  --gold:        #c9a84c;
  --gold-soft:   rgba(201,168,76,0.12);
  --gold-line:   rgba(201,168,76,0.28);
  --cream:       #f0ead8;
  --cream-dim:   rgba(240,234,216,0.60);
  --cream-mute:  rgba(240,234,216,0.28);
}

* { box-sizing: border-box; }

body {
  background: var(--ink-deep);
  color: var(--cream-dim);
  font-family: 'Cormorant Garamond', serif;
  margin: 0;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

/* Scrollbar — webkit */
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
```

- [ ] **Step 6: Create frontend/src/main.jsx**

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 7: Install frontend dependencies**

```bash
cd frontend && npm install
```

- [ ] **Step 8: Commit**

```bash
git add frontend/
git commit -m "feat: frontend scaffold — Vite + React + Tailwind with design tokens"
```

---

## Task 5: Auth context + API client

**Files:**
- Create: `frontend/src/services/api.js`
- Create: `frontend/src/context/AuthContext.jsx`

- [ ] **Step 1: Create frontend/src/services/api.js**

```js
// All fetch calls go through here. Throws on non-2xx.
async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    window.dispatchEvent(new Event('auth:unauthorized'));
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status });
  }

  return res.json();
}

export const authApi = {
  status: () => request('/api/auth/status'),
  setup: (data) => request('/api/auth/setup', { method: 'POST', body: data }),
  login: (data) => request('/api/auth/login', { method: 'POST', body: data }),
  register: (data) => request('/api/auth/register', { method: 'POST', body: data }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
};

export const adminApi = {
  getInviteCode: () => request('/api/auth/admin/invite-code'),
  regenerateInviteCode: () => request('/api/auth/admin/invite-code', { method: 'POST' }),
  listUsers: () => request('/api/auth/admin/users'),
  deleteUser: (id) => request(`/api/auth/admin/users/${id}`, { method: 'DELETE' }),
};
```

- [ ] **Step 2: Create frontend/src/context/AuthContext.jsx**

```jsx
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../services/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    authApi.status()
      .then(({ needsSetup }) => {
        if (needsSetup) { setNeedsSetup(true); setLoading(false); return; }
        return authApi.me().then(({ user }) => setUser(user)).catch(() => {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = () => { setUser(null); };
    window.addEventListener('auth:unauthorized', handler);
    return () => window.removeEventListener('auth:unauthorized', handler);
  }, []);

  const setup = useCallback(async (username, password, displayName) => {
    setError(null);
    try {
      const { user } = await authApi.setup({ username, password, displayName });
      setNeedsSetup(false);
      setUser(user);
    } catch (err) { setError(err.message); throw err; }
  }, []);

  const login = useCallback(async (username, password) => {
    setError(null);
    try {
      const { user } = await authApi.login({ username, password });
      setUser(user);
    } catch (err) { setError(err.message); throw err; }
  }, []);

  const register = useCallback(async (username, password, displayName, inviteCode) => {
    setError(null);
    try {
      const { user } = await authApi.register({ username, password, displayName, inviteCode });
      setUser(user);
    } catch (err) { setError(err.message); throw err; }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, needsSetup, loading, error, clearError, setup, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/api.js frontend/src/context/AuthContext.jsx
git commit -m "feat: auth context and API client"
```

---

## Task 6: Auth UI — Setup, Login, Register pages

**Files:**
- Create: `frontend/src/pages/SetupPage.jsx`
- Create: `frontend/src/pages/LoginPage.jsx`
- Create: `frontend/src/App.jsx`

- [ ] **Step 1: Create frontend/src/pages/SetupPage.jsx**

```jsx
import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function SetupPage() {
  const { setup, error } = useAuth();
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try { await setup(form.username, form.password, form.displayName); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--ink-deep)' }}>
      <div className="w-full max-w-sm">
        <div className="w-5 h-px mb-4" style={{ background: 'var(--gold)' }} />
        <p className="font-mono text-xs tracking-widest uppercase mb-2" style={{ color: 'var(--gold)' }}>First Launch</p>
        <h1 className="font-display italic text-3xl mb-1" style={{ color: 'var(--cream)' }}>Create Admin Account</h1>
        <p className="font-body text-sm mb-8" style={{ color: 'var(--cream-mute)' }}>You're the first. Set up your admin account to begin.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {[
            { name: 'displayName', label: 'Display Name', type: 'text' },
            { name: 'username', label: 'Username', type: 'text' },
            { name: 'password', label: 'Password', type: 'password' },
          ].map(({ name, label, type }) => (
            <div key={name}>
              <label className="font-mono text-xs tracking-widest uppercase block mb-1" style={{ color: 'var(--cream-mute)' }}>{label}</label>
              <input
                type={type}
                value={form[name]}
                onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))}
                required
                className="w-full px-3 py-2 rounded text-sm font-mono"
                style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)', outline: 'none' }}
              />
            </div>
          ))}

          {error && <p className="font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 font-mono text-xs tracking-widest uppercase mt-2"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', borderRadius: '4px', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Setting up…' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create frontend/src/pages/LoginPage.jsx**

```jsx
import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage() {
  const { login, register, error, clearError } = useAuth();
  const [tab, setTab] = useState('login');
  const [form, setForm] = useState({ username: '', password: '', displayName: '', inviteCode: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    clearError();
    try {
      if (tab === 'login') await login(form.username, form.password);
      else await register(form.username, form.password, form.displayName, form.inviteCode);
    } finally { setLoading(false); }
  };

  const field = (name, label, type = 'text') => (
    <div key={name}>
      <label className="font-mono text-xs tracking-widest uppercase block mb-1" style={{ color: 'var(--cream-mute)' }}>{label}</label>
      <input
        type={type}
        value={form[name]}
        onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))}
        required
        className="w-full px-3 py-2 rounded text-sm font-mono"
        style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)', outline: 'none' }}
      />
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--ink-deep)' }}>
      <div className="w-full max-w-sm">
        <div className="w-5 h-px mb-4" style={{ background: 'var(--gold)' }} />
        <p className="font-mono text-xs tracking-widest uppercase mb-1" style={{ color: 'var(--gold)' }}>Trippy</p>
        <h1 className="font-display italic text-3xl mb-8" style={{ color: 'var(--cream)' }}>Welcome back.</h1>

        {/* Tabs */}
        <div className="flex mb-6 gap-1">
          {['login', 'register'].map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); clearError(); }}
              className="flex-1 py-2 font-mono text-xs tracking-widest uppercase"
              style={{
                background: tab === t ? 'var(--gold-soft)' : 'transparent',
                border: '1px solid',
                borderColor: tab === t ? 'var(--gold-line)' : 'var(--ink-border)',
                color: tab === t ? 'var(--gold)' : 'var(--cream-mute)',
                borderRadius: '4px',
              }}
            >
              {t === 'login' ? 'Sign In' : 'Register'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {tab === 'register' && field('displayName', 'Display Name')}
          {field('username', 'Username')}
          {field('password', 'Password', 'password')}
          {tab === 'register' && field('inviteCode', 'Invite Code')}

          {error && <p className="font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 font-mono text-xs tracking-widest uppercase mt-2"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', borderRadius: '4px', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? '…' : tab === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create frontend/src/App.jsx**

```jsx
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';

function AuthGate() {
  const { user, needsSetup, loading } = useAuth();

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--ink-deep)' }}>
      <div className="font-mono text-xs tracking-widest uppercase" style={{ color: 'var(--cream-mute)' }}>Loading…</div>
    </div>
  );

  if (needsSetup) return <SetupPage />;
  if (!user) return <LoginPage />;

  // Main app — placeholder until Plan 2
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--ink-deep)' }}>
      <div>
        <div className="w-5 h-px mb-3" style={{ background: 'var(--gold)' }} />
        <p className="font-mono text-xs tracking-widest uppercase mb-1" style={{ color: 'var(--gold)' }}>Signed in as {user.username}</p>
        <h1 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>Trippy</h1>
        <p className="font-body text-sm mt-2" style={{ color: 'var(--cream-mute)' }}>Main app coming in Plan 2.</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
```

- [ ] **Step 4: Start both servers and verify end-to-end**

Terminal 1:
```bash
cd backend && npm run dev
```

Terminal 2:
```bash
cd frontend && npm run dev
```

Open http://localhost:5173 — expect the Setup page (first run). Create admin account. Should redirect to the placeholder "Signed in" screen.

Open again in incognito — expect Login page. Register with invite code from admin panel (check backend logs or hit `GET /api/auth/admin/invite-code` with the admin cookie).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat: auth UI — setup page, login/register, auth gate"
```

---

## Task 7: Seed data

**Files:**
- Create: `data/seed/chengdu-chongqing.json`
- Create: `backend/src/db/seed.js`

- [ ] **Step 1: Create the seed data file**

```json
{
  "trip": {
    "title": "Chengdu & Chongqing",
    "destinations": ["Chengdu", "Chongqing"],
    "destination_countries": ["CN"],
    "start_date": "2025-06-08",
    "end_date": "2025-06-17",
    "travellers": "couple",
    "interest_tags": ["food", "culture", "history", "nature", "city"],
    "pace": "moderate"
  },
  "days": [
    {
      "date": "2025-06-08",
      "city": "Chengdu",
      "phase": "Chengdu I",
      "hotel": "Waldorf Astoria Chengdu",
      "theme": "Arrival",
      "color_code": "#c9a84c",
      "stops": [
        {
          "time": "14:20",
          "title": "Arrive Chengdu Tianfu Airport",
          "type": "transit",
          "note": "Collect luggage, clear customs. Airport is ~45 min from city centre.",
          "lat": 30.3062, "lng": 104.4440,
          "duration": "1h",
          "sort_order": 1
        },
        {
          "time": "16:00",
          "title": "Waldorf Astoria Chengdu",
          "type": "hotel",
          "note": "Check in. Take time to settle — long travel day.",
          "lat": 30.6571, "lng": 104.0678,
          "duration": "30m",
          "sort_order": 2,
          "is_featured": true
        },
        {
          "time": "19:30",
          "title": "Taikoo Li evening stroll",
          "type": "explore",
          "note": "Open-air lifestyle district adjacent to the Daci Temple. Good for a relaxed first evening walk.",
          "lat": 30.6600, "lng": 104.0820,
          "duration": "1.5h",
          "sort_order": 3
        }
      ]
    },
    {
      "date": "2025-06-09",
      "city": "Chongqing",
      "phase": "Chongqing",
      "hotel": "Regent Chongqing",
      "theme": "City Centre",
      "color_code": "#81a2be",
      "stops": [
        {
          "time": "09:22",
          "title": "Chengdu East → Chongqing",
          "type": "transit",
          "note": "G8604. Platform TBC. Chongqing North Station exit — take metro Line 3 to Jiefangbei.",
          "lat": 29.5628, "lng": 106.5510,
          "duration": "1h 45m",
          "sort_order": 1
        },
        {
          "time": "11:15",
          "title": "Hongya Cave",
          "type": "explore",
          "note": "18-storey stilted building complex over the Jialing River. Best visited before the afternoon crowds.",
          "lat": 29.5605, "lng": 106.5655,
          "duration": "2h",
          "estimated_cost": "Free entry",
          "sort_order": 2,
          "is_featured": true
        },
        {
          "time": "13:30",
          "title": "Xiaomian noodles lunch",
          "type": "food",
          "note": "Chongqing's iconic spicy noodle dish. Look for a busy local spot near Jiefangbei.",
          "lat": 29.5572, "lng": 106.5722,
          "duration": "45m",
          "estimated_cost": "¥20–40 pp",
          "sort_order": 3
        },
        {
          "time": "15:00",
          "title": "Ciqikou Ancient Town",
          "type": "explore",
          "note": "Ming/Qing dynasty heritage street. Antiques, Chongqing snacks, teahouses. Take metro Line 1 → Ciqikou.",
          "lat": 29.5667, "lng": 106.4333,
          "duration": "2.5h",
          "sort_order": 4
        },
        {
          "time": "19:00",
          "title": "Regent Chongqing",
          "type": "hotel",
          "note": "Check in. River view rooms look toward the confluence of the Yangtze and Jialing.",
          "lat": 29.5578, "lng": 106.5697,
          "sort_order": 5,
          "is_featured": true
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Create backend/src/db/seed.js**

```js
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function seedIfEmpty(adminUserId) {
  const db = getDb();
  const tripCount = db.prepare('SELECT COUNT(*) as c FROM trips').get();
  if (tripCount.c > 0) return; // already seeded

  const raw = readFileSync(join(__dirname, '../../data/seed/chengdu-chongqing.json'), 'utf8');
  const { trip, days } = JSON.parse(raw);

  const insertTrip = db.prepare(`
    INSERT INTO trips (title, owner_id, destinations, destination_countries, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
    RETURNING id
  `);

  const { id: tripId } = insertTrip.get(
    trip.title,
    adminUserId,
    JSON.stringify(trip.destinations),
    JSON.stringify(trip.destination_countries),
    trip.start_date,
    trip.end_date,
    trip.travellers,
    JSON.stringify(trip.interest_tags),
    trip.pace
  );

  const insertDay = db.prepare(`
    INSERT INTO days (trip_id, date, city, phase, hotel, theme, color_code) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);

  const insertStop = db.prepare(`
    INSERT INTO stops (day_id, time, title, type, note, lat, lng, estimated_cost, duration, sort_order, is_featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const day of days) {
    const { id: dayId } = insertDay.get(tripId, day.date, day.city, day.phase, day.hotel, day.theme, day.color_code);
    for (const stop of day.stops) {
      insertStop.run(
        dayId, stop.time, stop.title, stop.type, stop.note ?? null,
        stop.lat ?? null, stop.lng ?? null,
        stop.estimated_cost ?? null, stop.duration ?? null,
        stop.sort_order, stop.is_featured ? 1 : 0
      );
    }
  }

  console.log(`Seed: inserted trip "${trip.title}" (${days.length} days)`);
}
```

- [ ] **Step 3: Wire seed into startup — update backend/src/index.js**

Add after `runMigrations()`:
```js
import { seedIfEmpty } from './db/seed.js';

// In start():
runMigrations();
// Seed reference data if DB is empty (dev only)
if (config.nodeEnv === 'development') {
  const adminUser = getDb().prepare('SELECT id FROM users WHERE is_admin = 1').get();
  if (adminUser) seedIfEmpty(adminUser.id);
}
```

Full updated `start()` function:
```js
async function start() {
  initDb(config.dbPath);
  runMigrations();

  if (config.nodeEnv === 'development') {
    const { getDb } = await import('./db/database.js');
    const { seedIfEmpty } = await import('./db/seed.js');
    const adminUser = getDb().prepare('SELECT id FROM users WHERE is_admin = 1').get();
    if (adminUser) seedIfEmpty(adminUser.id);
  }

  app.listen(config.port, () => {
    console.log(`Trippy backend running on :${config.port} [${config.nodeEnv}]`);
  });
}
```

- [ ] **Step 4: Restart backend and verify seed runs**

```bash
cd backend && npm run dev
```
Expected output includes: `Seed: inserted trip "Chengdu & Chongqing" (2 days)`

- [ ] **Step 5: Commit**

```bash
git add data/seed/ backend/src/db/seed.js backend/src/index.js
git commit -m "feat: seed data — Chengdu/Chongqing reference trip"
```

---

## Task 8: Docker setup

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

# Backend deps
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Frontend deps + build
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Copy backend source
COPY backend/ ./backend/

# Copy seed data
COPY data/ ./data/

ENV NODE_ENV=production
ENV PORT=3001

# Serve frontend static files from Express in prod
RUN npm install -g serve

EXPOSE 3001

CMD ["node", "backend/src/index.js"]
```

- [ ] **Step 2: Update backend/src/index.js to serve frontend in production**

Add after middleware setup, before routes:
```js
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Serve frontend in production
if (config.isProd) {
  const frontendDist = join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendDist));
  // After API routes, fall through to index.html for client-side routing
}
```

Add after all routes, before errorHandler:
```js
if (config.isProd) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(__dirname, '../../frontend/dist/index.html'));
    }
  });
}
```

- [ ] **Step 3: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  trippy:
    build: .
    ports:
      - "3001:3001"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
    restart: unless-stopped
```

- [ ] **Step 4: Create .dockerignore**

```
node_modules
frontend/node_modules
backend/node_modules
*.db
*.db-shm
*.db-wal
.env
.git
.superpowers
docs
```

- [ ] **Step 5: Build and test Docker image**

```bash
docker compose build
docker compose up
```

Open http://localhost:3001 — expect the Trippy auth page served from the Docker container.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: Docker setup for production deployment"
```

---

## Plan 1 Complete — Verification Checklist

Before marking Plan 1 done and moving to Plan 2:

- [ ] `npm test` in `/backend` — all tests pass (migrations + auth)
- [ ] `GET /api/health` returns `{"status":"ok","db":"connected"}`
- [ ] First-run setup flow works end-to-end in browser
- [ ] Login and register flows work with invite code
- [ ] Seed data loads on dev server startup
- [ ] `docker compose up` serves the app at http://localhost:3001
- [ ] `.env` created and filled with real API keys
- [ ] No `console.error` or unhandled promise rejections in the logs

**Next:** [Plan 2 — Core UI: Trips Home, Day Timeline, Logistics Dashboard](./2026-04-23-plan-2-core-ui.md)
