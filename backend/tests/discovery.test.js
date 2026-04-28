import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock claude.js before importing the route ---
const mockDiscoverDestination = vi.fn();

vi.mock('../src/services/claude.js', () => ({
  discoverDestination: mockDiscoverDestination,
}));

// --- Mock config to avoid env var validation ---
vi.mock('../src/config.js', () => ({
  config: {
    anthropicApiKey: 'test-key',
    frontendUrl: 'http://localhost:5173',
    isProd: false,
    nodeEnv: 'test',
    port: 3001,
    dbPath: ':memory:',
  },
}));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import * as tripService from '../src/services/trips.js';

let tmpDir;
let userId;
let tripId;

const FAKE_CATEGORIES = [
  { category: 'culture', items: [{ name: 'Fushimi Inari', lat: 34.97, lng: 135.77 }] },
  { category: 'food', items: [] },
];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();

  const result = authService.setup('admin', 'password123', 'Admin');
  userId = result.user.id;

  const trip = tripService.createTrip(userId, {
    title: 'Test Trip',
    startDate: '2026-06-01',
    endDate: '2026-06-07',
    destinations: ['Kyoto'],
    destinationCountries: ['JP'],
    interestTags: ['culture', 'food'],
    pace: 'relaxed',
    travellers: 2,
  });
  tripId = trip.trip.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  getDb().prepare('DELETE FROM global_discovery_cache').run();
});

// Helper: build an SSE-capable mock res and collect emitted events
function makeSseRes() {
  const events = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    setHeader() {},
    flushHeaders() { this.headersSent = true; },
    write(chunk) {
      const line = chunk.replace(/^data: /, '').trim();
      try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    },
    end() { this.writableEnded = true; },
  };
  return { res, events };
}

// Helper: invoke the POST /:tripId/discover handler directly
async function callDiscover(body) {
  const { default: handler } = await import('../src/routes/discovery.js');
  const req = {
    params: { tripId },
    body,
    user: { id: userId },
    trip: getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId),
  };
  const { res, events } = makeSseRes();
  let nextErr;
  const next = (err) => { nextErr = err; };

  const layer = handler.stack.find(
    (l) => l.route?.path === '/:tripId/discover' && l.route.methods.post,
  );
  if (!layer) throw new Error('Route layer not found');
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res, next);

  return { events, error: nextErr };
}

// Helper: invoke the DELETE /:tripId/discover/cache handler directly
function callDeleteCache(body = {}) {
  const { default: handler } = require('../src/routes/discovery.js');
  return _callDeleteCacheAsync(body);
}

async function _callDeleteCacheAsync(body = {}) {
  const { default: handler } = await import('../src/routes/discovery.js');
  const req = {
    params: { tripId },
    body,
    user: { id: userId },
    trip: getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId),
  };
  let responseBody;
  const res = { json(data) { responseBody = data; } };
  let nextErr;
  const next = (err) => { nextErr = err; };

  const layer = handler.stack.find(
    (l) => l.route?.path === '/:tripId/discover/cache' && l.route.methods.delete,
  );
  if (!layer) throw new Error('Delete cache route layer not found');
  layer.route.stack[layer.route.stack.length - 1].handle(req, res, next);

  return { responseBody, error: nextErr };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — validation', () => {
  it('returns 400 when destination is missing', async () => {
    const { error } = await callDiscover({});
    expect(error).toBeDefined();
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/destination/i);
  });

  it('returns 400 when destination is empty string', async () => {
    const { error } = await callDiscover({ destination: '   ' });
    expect(error).toBeDefined();
    expect(error.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — cache hit', () => {
  it('streams cached categories and done:{cached:true} when within TTL', async () => {
    const storedCategories = [
      { category: 'culture', items: [{ name: 'Kinkakuji', lat: null, lng: null }] },
    ];
    getDb().prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('kyoto', JSON.stringify(storedCategories));

    const { events, error } = await callDiscover({ destination: 'Kyoto' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    const categoryEvent = events.find((e) => e.type === 'category');
    expect(categoryEvent?.category).toBe('culture');
  });
});

// ---------------------------------------------------------------------------
// Cache miss
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — cache miss', () => {
  it('calls discoverDestination and stores result in global cache', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { events, error } = await callDiscover({ destination: 'Tokyo' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    expect(mockDiscoverDestination.mock.calls[0][0]).toBe('tokyo');

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(false);

    const row = getDb().prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('tokyo');
    expect(row).toBeDefined();
    expect(JSON.parse(row.result_json)).toHaveLength(FAKE_CATEGORIES.length);
  });
});

// ---------------------------------------------------------------------------
// Expired cache
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — expired cache', () => {
  it('treats cache row older than 7 days as a miss', async () => {
    const staleCategories = [{ category: 'culture', items: [{ name: 'Old result', lat: null, lng: null }] }];
    const freshCategories = [{ category: 'culture', items: [{ name: 'New result', lat: null, lng: null }] }];

    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    getDb().prepare(
      'INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, ?)',
    ).run('hiroshima', JSON.stringify(staleCategories), expiredTime);

    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      freshCategories.forEach((cat) => onCategory(cat));
      return freshCategories;
    });

    const { events, error } = await callDiscover({ destination: 'Hiroshima' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Destination key normalization
// ---------------------------------------------------------------------------

describe('destination key normalization', () => {
  it('matches cached entry regardless of input case', async () => {
    getDb().prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('osaka', JSON.stringify([{ category: 'food', items: [] }]));

    const { events, error } = await callDiscover({ destination: 'OSAKA' });

    expect(error).toBeUndefined();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE cache
// ---------------------------------------------------------------------------

describe('DELETE /trips/:tripId/discover/cache', () => {
  it('deletes the global cache row for the given destination and returns { ok: true }', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('nara', JSON.stringify([]));
    db.prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('osaka', JSON.stringify([]));

    const { responseBody, error } = await _callDeleteCacheAsync({ destination: 'Nara' });

    expect(error).toBeUndefined();
    expect(responseBody).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) as c FROM global_discovery_cache WHERE destination = ?').get('nara').c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM global_discovery_cache WHERE destination = ?').get('osaka').c).toBe(1);
  });

  it('returns { ok: true } with no destination (no-op)', async () => {
    const { responseBody, error } = await _callDeleteCacheAsync({});
    expect(error).toBeUndefined();
    expect(responseBody).toEqual({ ok: true });
  });
});
