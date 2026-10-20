import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The suite-wide stub (tests/setup/noDiscoveryPrewarm.js) makes prewarmTripScopes a no-op for
// every unit file; this file tests the real one, so it opts back in. The kick tests below
// fail loudly (no generation ever starts) if the unmock does not take effect.
vi.unmock('../src/services/discoveryPrewarm.js');

// --- Mock claude.js: discoverDestination is the controllable model call. ---
const { mockDiscoverDestination } = vi.hoisted(() => ({ mockDiscoverDestination: vi.fn() }));

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const SCENE_TYPES = [
  'temple_shrine', 'market', 'street_neighborhood', 'nature_outdoors', 'museum_gallery',
  'landmark_architecture', 'food_drink', 'nightlife', 'beach_water', 'viewpoint',
  'wellness', 'hotel_stay', 'entertainment', 'generic',
];
function coerceSceneType(value) {
  return SCENE_TYPES.includes(value) ? value : null;
}
vi.mock('../src/services/claude.js', () => ({
  discoverDestination: mockDiscoverDestination,
  normalizeName,
  coerceSceneType,
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

// Verification runs after every generation; an unresolved default keeps it off the network.
const { mockResolvePlace } = vi.hoisted(() => ({
  mockResolvePlace: vi.fn(async () => ({
    lat: null, lng: null, coordinateSystem: 'unknown', coordinateSource: null,
    locationStatus: 'unresolved', confidence: 0, resolvedName: null, resolvedAddress: null,
    providerId: null, provider: 'unresolved', countryCode: null,
    businessStatus: null, rating: null, ratingCount: null,
  })),
}));
vi.mock('../src/services/placeResolver.js', () => ({ resolvePlace: mockResolvePlace }));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import * as tripService from '../src/services/trips.js';
import { prewarmTripScopes } from '../src/services/discoveryPrewarm.js';
import {
  getOrCreateDestination,
  getDailyGenerationCount,
  incrementDailyGenerationCount,
  findDestination,
} from '../src/db/discoveryCatalogue.js';
import { __resetDiscoveryVerifyForTests, waitForVerificationDrain } from '../src/services/discoveryVerify.js';
import {
  runCatalogueGeneration,
  getRunningGeneration,
  __resetRunningGenerationsForTests,
} from '../src/services/discoveryGeneration.js';

let tmpDir;
let userId;
let park;

const FAKE_CATEGORIES = [
  { category: 'culture', items: [{ name: 'Longshan Temple', description: 'A temple.' }] },
];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-prewarm-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  userId = authService.setup('admin', 'password123', 'Admin').user.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function parkedGate() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release };
}

// Holds every model call open until park.release(), then emits one category.
function parkDiscovery() {
  mockDiscoverDestination.mockImplementation(async (dest, exclusions, cb) => {
    await park.gate;
    FAKE_CATEGORIES.forEach((cat) => cb(cat));
    return FAKE_CATEGORIES;
  });
}

function destinationRows() {
  return getDb().prepare('SELECT * FROM discovery_destinations ORDER BY id').all();
}

// Releases the gate and waits out every generation and verification drain, so nothing runs
// past the test that started it.
async function settleAll() {
  park.release();
  for (const row of destinationRows()) {
    const running = getRunningGeneration(row.id);
    if (running) await running.settled;
    await waitForVerificationDrain(row.id);
  }
}

// Kicks are detached async functions; a few macrotask turns let them reach the model call.
async function tick() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function sqlTimestamp(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function seedDestination({ cityKey, countryCode, displayName, lastGeneratedAt, places = 1 }) {
  const db = getDb();
  const row = getOrCreateDestination(db, { cityKey, countryCode, displayName });
  db.prepare('UPDATE discovery_destinations SET last_generated_at = ?, generation_count = 1 WHERE id = ?')
    .run(lastGeneratedAt, row.id);
  for (let n = 1; n <= places; n += 1) {
    const name = `${displayName} Place ${n}`;
    db.prepare(`
      INSERT INTO discovery_places (
        destination_id, category, name, normalized_name, description, provenance, status, batch, generated_at
      ) VALUES (?, 'culture', ?, ?, 'd', 'unverified', 'active', 0, ?)
    `).run(row.id, name, normalizeName(name), new Date().toISOString());
  }
  return row;
}

function makeTrip(destinations, options) {
  return tripService.createTrip(userId, {
    title: 'Prewarm Trip',
    startDate: '2026-06-01',
    endDate: '2026-06-05',
    destinations,
    interestTags: ['culture'],
    pace: 'relaxed',
    travellers: 2,
  }, options).trip;
}

const TAIWAN = [
  { city: 'Taipei', countryCode: 'TW' },
  { city: 'Taichung', countryCode: 'TW' },
  { city: 'Kaohsiung', countryCode: 'TW' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDiscoverDestination.mockReset();
  __resetDiscoveryVerifyForTests();
  __resetRunningGenerationsForTests();
  const db = getDb();
  db.prepare('DELETE FROM discovery_places').run();
  db.prepare('DELETE FROM discovery_destinations').run();
  db.prepare('DELETE FROM discovery_generation_daily').run();
  park = parkedGate();
  parkDiscovery();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await settleAll();
  vi.restoreAllMocks();
});

describe('trip-scope pre-warm (Plan 35 W4, D-35-3)', () => {
  it('kicks one generation per country-coded scope, one registry entry each, and skips a scope with no country', async () => {
    makeTrip([...TAIWAN, { city: 'Nowhere Town' }]);
    await tick();

    const rows = destinationRows();
    expect(rows.map((r) => r.city_key).sort()).toEqual(['kaohsiung', 'taichung', 'taipei']);
    expect(rows.every((r) => r.country_code === 'TW')).toBe(true);
    // One registry entry per destination while the model calls are parked.
    for (const row of rows) expect(getRunningGeneration(row.id)).not.toBeNull();
    expect(mockDiscoverDestination).toHaveBeenCalledTimes(3);
    expect(mockDiscoverDestination.mock.calls.map((c) => c[0]).sort()).toEqual([
      'Kaohsiung, Taiwan (TW)', 'Taichung, Taiwan (TW)', 'Taipei, Taiwan (TW)',
    ]);

    await settleAll();
    for (const row of rows) expect(getDailyGenerationCount(getDb(), row.id)).toBe(1);
    expect(findDestination(getDb(), 'nowhere town', '')).toBeFalsy();
  });

  it('does not kick a destination whose catalogue is already fresh', async () => {
    seedDestination({ cityKey: 'taipei', countryCode: 'TW', displayName: 'Taipei', lastGeneratedAt: sqlTimestamp(0) });
    makeTrip([{ city: 'Taipei', countryCode: 'TW' }]);
    await tick();

    expect(mockDiscoverDestination).not.toHaveBeenCalled();
  });

  it('does not kick a destination that is already generating', async () => {
    const db = getDb();
    const row = getOrCreateDestination(db, { cityKey: 'taipei', countryCode: 'TW', displayName: 'Taipei' });
    const first = runCatalogueGeneration(db, { destinationRow: row, claudeDestination: 'x', useExclusions: false });
    expect(getRunningGeneration(row.id)).not.toBeNull();

    makeTrip([{ city: 'Taipei', countryCode: 'TW' }]);
    await tick();

    expect(mockDiscoverDestination).toHaveBeenCalledTimes(1);
    park.release();
    await first;
    expect(getDailyGenerationCount(db, row.id)).toBe(1);
  });

  it('does not kick a stale destination that has hit the daily generation cap', async () => {
    const row = seedDestination({ cityKey: 'taipei', countryCode: 'TW', displayName: 'Taipei', lastGeneratedAt: sqlTimestamp(8) });
    for (let n = 0; n < 3; n += 1) incrementDailyGenerationCount(getDb(), row.id);
    expect(getDailyGenerationCount(getDb(), row.id)).toBe(3);

    makeTrip([{ city: 'Taipei', countryCode: 'TW' }]);
    await tick();

    expect(mockDiscoverDestination).not.toHaveBeenCalled();
  });

  it('kicks a stale destination under the cap with its stored names as exclusions', async () => {
    seedDestination({ cityKey: 'taipei', countryCode: 'TW', displayName: 'Taipei', lastGeneratedAt: sqlTimestamp(8), places: 2 });
    makeTrip([{ city: 'Taipei', countryCode: 'TW' }]);
    await tick();

    expect(mockDiscoverDestination).toHaveBeenCalledTimes(1);
    const exclusions = mockDiscoverDestination.mock.calls[0][1];
    expect(exclusions.length).toBeGreaterThan(0);
    expect(exclusions.join(' | ')).toContain('Taipei Place 1');
  });

  it('kicks a never-generated destination without exclusions', async () => {
    makeTrip([{ city: 'Taipei', countryCode: 'TW' }]);
    await tick();

    expect(mockDiscoverDestination).toHaveBeenCalledTimes(1);
    expect(mockDiscoverDestination.mock.calls[0][1]).toEqual([]);
  });

  it('kicks duplicate scopes of one destination once', async () => {
    const scopes = [
      { label: 'Taipei', countryCode: 'TW', canonicalKey: 'taipei' },
      { label: 'Taipei City', countryCode: 'TW', canonicalKey: 'taipei' },
    ];
    const kicked = prewarmTripScopes(getDb(), scopes, { tripId: 't-dup' });
    await tick();

    expect(kicked).toEqual(['taipei|TW']);
    expect(mockDiscoverDestination).toHaveBeenCalledTimes(1);
  });

  it('updateTrip kicks a newly added country-coded chip, and re-saving the same chips kicks nothing', async () => {
    const trip = makeTrip([{ city: 'Taipei', countryCode: 'TW' }]);
    await tick();
    await settleAll();
    expect(mockDiscoverDestination).toHaveBeenCalledTimes(1);

    mockDiscoverDestination.mockClear();
    park = parkedGate();
    parkDiscovery();
    const chips = [{ city: 'Taipei', countryCode: 'TW' }, { city: 'Tainan', countryCode: 'TW' }];
    tripService.updateTrip(userId, trip.id, { destinations: chips });
    await tick();

    // Taipei is fresh from the first kick; only the new chip generates.
    expect(mockDiscoverDestination).toHaveBeenCalledTimes(1);
    expect(mockDiscoverDestination.mock.calls[0][0]).toBe('Tainan, Taiwan (TW)');

    await settleAll();
    mockDiscoverDestination.mockClear();
    tripService.updateTrip(userId, trip.id, { destinations: chips });
    await tick();
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
  });

  it('createTrip with prewarmDiscovery: false kicks nothing', async () => {
    makeTrip(TAIWAN, { prewarmDiscovery: false });
    await tick();

    expect(mockDiscoverDestination).not.toHaveBeenCalled();
    expect(destinationRows()).toHaveLength(0);
  });
});
