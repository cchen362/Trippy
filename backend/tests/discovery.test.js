import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

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

// Helper: compute the same hash the route uses
function computeHash(destination, tags) {
  return createHash('sha256')
    .update(JSON.stringify([destination.toLowerCase(), ...[...tags].sort()]))
    .digest('hex');
}

// Helper: simulate the route handler directly (bypassing Express middleware)
// so tests don't need a running HTTP server
async function callDiscover(body, tripRow = null) {
  const { default: handler } = await import('../src/routes/discovery.js');

  // Build a minimal mock request
  const req = {
    params: { tripId },
    body,
    user: { id: userId },
    trip: tripRow ?? getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId),
  };

  let statusCode = 200;
  let responseBody;
  const res = {
    status(code) { statusCode = code; return res; },
    json(data) { responseBody = data; return res; },
  };

  let nextErr;
  const next = (err) => { nextErr = err; };

  // Find the POST /:tripId/discover handler in the router stack
  // Router stack: index 0 = requireAuth, then the route layers
  const stack = handler.stack;
  // Grab all layers matching /:tripId/discover with POST method
  const layer = stack.find(
    (l) => l.route && l.route.path === '/:tripId/discover' && l.route.methods.post,
  );

  if (!layer) throw new Error('Route layer not found');

  // Run each handler in the route stack (skip middleware we've already applied)
  const routeHandlers = layer.route.stack;
  // routeHandlers: [requireTripAccess, async handler]
  // For tests we set req.trip directly, skip requireTripAccess
  const asyncHandler = routeHandlers[routeHandlers.length - 1].handle;
  await asyncHandler(req, res, next);

  return { statusCode, responseBody, error: nextErr };
}

async function callDeleteCache(tripRow = null) {
  const { default: handler } = await import('../src/routes/discovery.js');

  const req = {
    params: { tripId },
    user: { id: userId },
    trip: tripRow ?? getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId),
  };

  let responseBody;
  const res = {
    json(data) { responseBody = data; return res; },
  };

  let nextErr;
  const next = (err) => { nextErr = err; };

  const stack = handler.stack;
  const layer = stack.find(
    (l) => l.route && l.route.path === '/:tripId/discover/cache' && l.route.methods.delete,
  );

  if (!layer) throw new Error('Delete cache route layer not found');

  const routeHandlers = layer.route.stack;
  const deleteHandler = routeHandlers[routeHandlers.length - 1].handle;
  deleteHandler(req, res, next);

  return { responseBody, error: nextErr };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();

  // Create a user
  const result = authService.setup('admin', 'password123', 'Admin');
  userId = result.user.id;

  // Create a trip with interest_tags
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
  // Clear cache between tests
  getDb().prepare('DELETE FROM discovery_cache WHERE trip_id = ?').run(tripId);
});

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
  it('returns cached result with cached: true when within 48h', async () => {
    const destination = 'Kyoto';
    const tags = ['culture', 'food'];
    const hash = computeHash(destination, tags);
    const fakeResults = { culture: [{ name: 'Temple' }], food: [], nature: [], nightlife: [], hidden_gems: [] };

    // Insert a fresh cache row
    getDb().prepare(`
      INSERT INTO discovery_cache (id, trip_id, destination, interest_hash, result_json, fetched_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
    `).run(tripId, destination, hash, JSON.stringify({ results: fakeResults, source: 'web' }));

    const { responseBody, error } = await callDiscover({ destination, interestTags: tags });

    expect(error).toBeUndefined();
    expect(responseBody.discovery.cached).toBe(true);
    expect(responseBody.discovery.results).toEqual(fakeResults);
    expect(responseBody.discovery.source).toBe('web');
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cache miss
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — cache miss', () => {
  it('calls discoverDestination and stores result in cache', async () => {
    const destination = 'Tokyo';
    const tags = ['nightlife'];
    const fakeResults = { culture: [], food: [], nature: [], nightlife: [{ name: 'Shinjuku' }], hidden_gems: [] };

    mockDiscoverDestination.mockResolvedValue({ results: fakeResults, source: 'web' });

    const { responseBody, error } = await callDiscover({ destination, interestTags: tags });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const tripRow = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    expect(mockDiscoverDestination).toHaveBeenCalledWith(destination, tags, 'relaxed', tripRow.travellers);

    expect(responseBody.discovery.cached).toBe(false);
    expect(responseBody.discovery.results).toEqual(fakeResults);
    expect(responseBody.discovery.source).toBe('web');

    // Verify stored in DB
    const hash = computeHash(destination, tags);
    const row = getDb().prepare(
      'SELECT * FROM discovery_cache WHERE trip_id = ? AND destination = ? AND interest_hash = ?'
    ).get(tripId, destination, hash);
    expect(row).toBeDefined();
    const stored = JSON.parse(row.result_json);
    expect(stored.results).toEqual(fakeResults);
  });

  it('falls back to trip interest_tags when interestTags not provided in body', async () => {
    const destination = 'Osaka';
    const fakeResults = { culture: [], food: [], nature: [], nightlife: [], hidden_gems: [] };
    mockDiscoverDestination.mockResolvedValue({ results: fakeResults, source: 'ai' });

    const { responseBody, error } = await callDiscover({ destination });

    expect(error).toBeUndefined();
    // Should have used the trip's interest_tags: ['culture', 'food']
    const tripRow = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    expect(mockDiscoverDestination).toHaveBeenCalledWith(destination, ['culture', 'food'], 'relaxed', tripRow.travellers);
    expect(responseBody.discovery.cached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expired cache
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — expired cache', () => {
  it('treats cache row older than 48h as a miss', async () => {
    const destination = 'Hiroshima';
    const tags = ['history'];
    const hash = computeHash(destination, tags);
    const staleResults = { culture: [{ name: 'Old result' }], food: [], nature: [], nightlife: [], hidden_gems: [] };
    const freshResults = { culture: [{ name: 'New result' }], food: [], nature: [], nightlife: [], hidden_gems: [] };

    // Insert expired cache row (51 hours ago)
    const expiredTime = new Date(Date.now() - 51 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    getDb().prepare(`
      INSERT INTO discovery_cache (id, trip_id, destination, interest_hash, result_json, fetched_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
    `).run(tripId, destination, hash, JSON.stringify({ results: staleResults, source: 'web' }), expiredTime);

    mockDiscoverDestination.mockResolvedValue({ results: freshResults, source: 'web' });

    const { responseBody, error } = await callDiscover({ destination, interestTags: tags });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    expect(responseBody.discovery.results).toEqual(freshResults);
    expect(responseBody.discovery.cached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hash determinism
// ---------------------------------------------------------------------------

describe('interest_hash determinism', () => {
  it('produces the same hash for same destination+tags regardless of tag order', () => {
    const h1 = computeHash('Kyoto', ['food', 'culture']);
    const h2 = computeHash('Kyoto', ['culture', 'food']);
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different destinations', () => {
    const h1 = computeHash('Kyoto', ['culture']);
    const h2 = computeHash('Tokyo', ['culture']);
    expect(h1).not.toBe(h2);
  });

  it('is case-insensitive for destination', () => {
    const h1 = computeHash('kyoto', ['culture']);
    const h2 = computeHash('KYOTO', ['culture']);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// DELETE cache
// ---------------------------------------------------------------------------

describe('DELETE /trips/:tripId/discover/cache', () => {
  it('deletes all cache rows for the trip and returns { ok: true }', async () => {
    const db = getDb();

    // Insert some cache rows
    const hash1 = computeHash('Nara', ['culture']);
    const hash2 = computeHash('Osaka', ['food']);
    db.prepare(`
      INSERT INTO discovery_cache (id, trip_id, destination, interest_hash, result_json, fetched_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
    `).run(tripId, 'Nara', hash1, JSON.stringify({ results: {}, source: 'web' }));
    db.prepare(`
      INSERT INTO discovery_cache (id, trip_id, destination, interest_hash, result_json, fetched_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
    `).run(tripId, 'Osaka', hash2, JSON.stringify({ results: {}, source: 'web' }));

    const count = db.prepare('SELECT COUNT(*) as c FROM discovery_cache WHERE trip_id = ?').get(tripId);
    expect(count.c).toBe(2);

    const { responseBody, error } = await callDeleteCache();

    expect(error).toBeUndefined();
    expect(responseBody).toEqual({ ok: true });

    const afterCount = db.prepare('SELECT COUNT(*) as c FROM discovery_cache WHERE trip_id = ?').get(tripId);
    expect(afterCount.c).toBe(0);
  });
});
