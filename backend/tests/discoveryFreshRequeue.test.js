import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Plan 35 W4 (D-35-3, F-35-12): the /discover fresh path re-queues a destination's 'pending'
// rows. Route-level, through the real handler; the model and the resolver are the only fakes.
// vi.hoisted: vi.mock factories run before this file's own top-level code.
const { mockDiscoverDestination, mockResolvePlace } = vi.hoisted(() => ({
  mockDiscoverDestination: vi.fn(),
  mockResolvePlace: vi.fn(),
}));

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

vi.mock('../src/services/claude.js', () => ({
  discoverDestination: mockDiscoverDestination,
  normalizeName,
  coerceSceneType: () => null,
  DISCOVERY_CATEGORIES: ['essentials', 'culture', 'food', 'nature', 'nightlife', 'hidden_gems', 'architecture', 'wellness'],
}));

vi.mock('../src/config.js', () => ({
  config: {
    anthropicApiKey: 'test-key',
    frontendUrl: 'http://localhost:5173',
    isProd: false,
    nodeEnv: 'test',
    port: 3001,
    dbPath: ':memory:',
    googlePlacesKey: '',
    discoveryRatingEnrichment: false,
    discoveryResolverDailyRequestBudget: 1000,
    discoveryEscalationDailyBudget: 50,
    discoveryReverifyDailyRequestBudget: 150,
    discoveryReverifyPerDestinationDaily: 25,
  },
}));

vi.mock('../src/services/placeResolver.js', () => ({ resolvePlace: mockResolvePlace }));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import * as tripService from '../src/services/trips.js';
import { __resetDiscoveryVerifyForTests, waitForVerificationDrain } from '../src/services/discoveryVerify.js';
import { __resetRunningGenerationsForTests } from '../src/services/discoveryGeneration.js';

const UNRESOLVED = {
  lat: null, lng: null, coordinateSystem: 'unknown', coordinateSource: null,
  locationStatus: 'unresolved', confidence: 0, resolvedName: null, resolvedAddress: null,
  providerId: null, provider: 'unresolved', countryCode: null,
  businessStatus: null, rating: null, ratingCount: null,
};

let tmpDir;
let userId;
let tripId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-fresh-requeue-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  userId = authService.setup('admin', 'password123', 'Admin').user.id;
  tripId = tripService.createTrip(userId, {
    title: 'Kansai', startDate: '2026-06-01', endDate: '2026-06-03',
    destinations: ['Kobe'], destinationCountries: ['JP'],
  }).trip.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePlace.mockResolvedValue(UNRESOLVED);
  __resetDiscoveryVerifyForTests();
  __resetRunningGenerationsForTests();
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
});

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// A destination generated just now (fresh), holding the given places at the given provenance.
// D-36-1: fresh also needs every category present, so one filler place tops up each other category.
function seedFreshDestination(cityKey, displayName, places) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discovery_destinations (city_key, country_code, display_name, last_generated_at, generation_count)
    VALUES (?, 'JP', ?, ?, 1)
  `).run(cityKey, displayName, nowSql());
  const dest = db.prepare(`SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = 'JP'`).get(cityKey);
  for (const { name, provenance } of places) {
    db.prepare(`
      INSERT INTO discovery_places (destination_id, category, name, normalized_name, description, provenance, status, batch, generated_at)
      VALUES (?, 'culture', ?, ?, 'd', ?, 'active', 0, ?)
    `).run(dest.id, name, normalizeName(name), provenance, new Date().toISOString());
  }
  for (const category of ['essentials', 'food', 'nature', 'nightlife', 'hidden_gems', 'architecture', 'wellness']) {
    const name = `${displayName} ${category} filler`;
    db.prepare(`
      INSERT INTO discovery_places (destination_id, category, name, normalized_name, description, provenance, status, batch, generated_at)
      VALUES (?, ?, ?, ?, 'd', 'unverified', 'active', 0, ?)
    `).run(dest.id, category, name, normalizeName(name), new Date().toISOString());
  }
  return dest;
}

async function callDiscover(body) {
  const { default: router } = await import('../src/routes/discovery.js');
  const events = [];
  const res = {
    destroyed: false, writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write(chunk) { try { events.push(JSON.parse(chunk.replace(/^data: /, '').trim())); } catch { /* not JSON */ } },
    end() { this.writableEnded = true; },
  };
  const req = {
    params: { tripId }, body, user: { id: userId },
    trip: getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId),
  };
  let error;
  const layer = router.stack.find((l) => l.route?.path === '/:tripId/discover' && l.route.methods.post);
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res, (err) => { error = err; });
  return { events, error };
}

function provenances(destinationId) {
  return getDb().prepare('SELECT provenance FROM discovery_places WHERE destination_id = ?').all(destinationId)
    .map((r) => r.provenance);
}

describe('POST /trips/:tripId/discover — fresh path re-queues pending rows (D-35-3, F-35-12)', () => {
  it('drains the pending rows of a fresh destination it serves, without generating', async () => {
    const dest = seedFreshDestination('kobe', 'Kobe', [
      { name: 'Meriken Park', provenance: 'pending' },
      { name: 'Kobe Beef Alley', provenance: 'pending' },
      { name: 'Ikuta Shrine', provenance: 'unverified' },
    ]);

    const { events, error } = await callDiscover({ destination: 'Kobe', countryCode: 'JP' });
    await waitForVerificationDrain(dest.id);

    expect(error).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'done', cached: true });
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
    // Only the two pending rows are looked up; the already-checked row is not.
    expect(mockResolvePlace).toHaveBeenCalledTimes(2);
    expect(provenances(dest.id)).not.toContain('pending');
  });

  it('makes no resolver call when the fresh destination has no pending rows', async () => {
    const dest = seedFreshDestination('himeji', 'Himeji', [{ name: 'Himeji Castle', provenance: 'unverified' }]);

    const { error } = await callDiscover({ destination: 'Himeji', countryCode: 'JP' });
    await waitForVerificationDrain(dest.id);

    expect(error).toBeUndefined();
    expect(mockResolvePlace).not.toHaveBeenCalled();
  });
});
