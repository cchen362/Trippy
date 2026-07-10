import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock claude.js before importing the route ---
const mockDiscoverDestination = vi.fn();

// Mirrors the real normalizeName in src/services/claude.js closely enough for these tests —
// the real dedupe behavior is covered separately by discoveryCatalogue.test.js and claude.test.js.
function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mirrors the real coerceSceneType in src/services/claude.js — discoveryCatalogue.js's
// insertPlaces (exercised transitively via the /discover route) imports it directly.
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

// --- Mock config to avoid env var validation ---
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
    discoveryResolverDailyBudget: 500,
  },
}));

// --- Mock the place resolver so the fire-and-forget verification worker
// (enqueued by routes/discovery.js after every insert) never makes a real
// network call during these route-level tests. Route tests care about the SSE
// contract and catalogue writes, not verification outcomes — a default
// "unresolved" response keeps provenance at its unverified default regardless
// of the worker's (unawaited, racy-by-construction) timing relative to
// assertions. Tests that specifically exercise verification behavior override
// this per-test and await discoveryVerify's drain explicitly.
//
// vi.hoisted is required here (not a plain top-level const) because vi.mock
// factories run before any of this file's own import statements execute (ES
// module imports are hoisted ahead of other top-level code) — trips.js
// transitively imports placeResolver.js, so the factory below can run before
// a plain const would have been initialized.
const { mockResolvePlace } = vi.hoisted(() => ({
  mockResolvePlace: vi.fn(async () => ({
    lat: null, lng: null, coordinateSystem: 'unknown', coordinateSource: null,
    locationStatus: 'unresolved', confidence: 0, resolvedName: null, resolvedAddress: null,
    providerId: null, provider: 'unresolved', countryCode: null,
    businessStatus: null, rating: null, ratingCount: null,
  })),
}));
vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: mockResolvePlace,
}));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import * as tripService from '../src/services/trips.js';
import { __resetDiscoveryVerifyForTests, waitForVerificationDrain } from '../src/services/discoveryVerify.js';

let tmpDir;
let userId;
let tripId;

const FAKE_CATEGORIES = [
  { category: 'culture', items: [{ name: 'Fushimi Inari', description: 'A mountain shrine famous for its endless vermillion torii gates.', lat: 34.97, lng: 135.77 }] },
  { category: 'food', items: [] },
];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

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
  mockResolvePlace.mockImplementation(async () => ({
    lat: null, lng: null, coordinateSystem: 'unknown', coordinateSource: null,
    locationStatus: 'unresolved', confidence: 0, resolvedName: null, resolvedAddress: null,
    providerId: null, provider: 'unresolved', countryCode: null,
    businessStatus: null, rating: null, ratingCount: null,
  }));
  __resetDiscoveryVerifyForTests();
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
  getDb().prepare('DELETE FROM discovery_generation_daily').run();
  getDb().prepare('DELETE FROM days WHERE trip_id = ?').run(tripId);
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

// Helper: directly seed the new catalogue tables the way a prior generation would have.
function seedDestination({ cityKey, countryCode = '', displayName, lastGeneratedAt, generationCount = 1 }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discovery_destinations (city_key, country_code, display_name, last_generated_at, generation_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(cityKey, countryCode, displayName, lastGeneratedAt, generationCount);
  return db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?').get(cityKey, countryCode);
}

function seedPlace(destinationId, { category, name, generatedAt = new Date().toISOString(), batch = 0, estimatedDuration = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discovery_places (
      destination_id, category, name, normalized_name, description, estimated_duration, provenance, status, batch, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'unverified', 'active', ?, ?)
  `).run(destinationId, category, name, normalizeName(name), `${name} description`, estimatedDuration, batch, generatedAt);
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
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

  it('returns 400 when countryCode is not a 2-letter uppercase code', async () => {
    const { error } = await callDiscover({ destination: 'Kyoto', countryCode: 'japan' });
    expect(error).toBeDefined();
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/countryCode/i);
  });
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — cache hit', () => {
  it('streams stored active places and done:{cached:true} when within TTL', async () => {
    const dest = seedDestination({ cityKey: 'kyoto', displayName: 'Kyoto', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'culture', name: 'Kinkakuji' });

    const { events, error } = await callDiscover({ destination: 'Kyoto' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    const categoryEvent = events.find((e) => e.type === 'category');
    expect(categoryEvent?.category).toBe('culture');
    expect(categoryEvent?.items[0].name).toBe('Kinkakuji');
    expect(categoryEvent?.items[0].lat).toBeNull();
    expect(categoryEvent?.items[0].lng).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache miss
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — cache miss', () => {
  it('calls discoverDestination and stores result in the discovery catalogue', async () => {
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

    const destRow = getDb().prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('tokyo');
    expect(destRow).toBeDefined();
    expect(destRow.generation_count).toBe(1);
    const places = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ?').all(destRow.id);
    // FAKE_CATEGORIES has 1 non-empty category with 1 item — only non-empty items get rows.
    expect(places).toHaveLength(1);
    expect(places[0].name).toBe('Fushimi Inari');
  });

  // Finding H3: the discovery catalogue is shared across ALL trips/users. If the
  // requesting trip's own itinerary stops were passed to Claude as exclusions, the
  // first trip to ask about a city would permanently shrink what every other trip
  // sees for that city. Trip-owned items must be filtered client-side at display
  // time instead — the server-side generation call must never see trip stop titles.
  it('does NOT pass the requesting trip stop titles as exclusions on first generation', async () => {
    const db = getDb();
    const dayId = 'test-day-fushimi';
    db.prepare(
      `INSERT INTO days (id, trip_id, date, city) VALUES (?, ?, '2026-06-02', 'Kyoto')`,
    ).run(dayId, tripId);
    db.prepare(
      `INSERT INTO stops (day_id, title) VALUES (?, 'Fushimi Inari')`,
    ).run(dayId);

    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { error } = await callDiscover({ destination: 'Nara' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const exclusionList = mockDiscoverDestination.mock.calls[0][1];
    expect(exclusionList).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Expired cache
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — expired cache', () => {
  it('treats a destination whose catalogue is older than 7 days as a miss', async () => {
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'hiroshima', displayName: 'Hiroshima', lastGeneratedAt: expiredTime });
    seedPlace(dest.id, { category: 'culture', name: 'Old result' });

    const freshCategories = [{ category: 'culture', items: [{ name: 'New result', description: 'A newly generated spot.', lat: null, lng: null }] }];
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      freshCategories.forEach((cat) => onCategory(cat));
      return freshCategories;
    });

    const { events, error } = await callDiscover({ destination: 'Hiroshima' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(false);
  });

  // Finding M6: last_generated_at is written via SQLite datetime('now') — UTC with
  // no zone marker — but was previously parsed with `new Date(value)`, which JS
  // interprets as LOCAL time. That only produced a correct TTL comparison when the
  // server process happened to run in UTC. Force the test process into a non-UTC
  // zone and verify the comparison is still correct in both directions.
  describe('TTL comparison is correct regardless of process timezone', () => {
    const originalTz = process.env.TZ;

    beforeEach(() => {
      // UTC-12 — as far from UTC as the IANA database goes, to make a timezone bug
      // in either direction (ahead/behind) produce an obviously wrong result.
      process.env.TZ = 'Etc/GMT+12';
    });

    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('treats a destination generated 1 hour ago (UTC, no zone marker) as fresh', async () => {
      const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const dest = seedDestination({ cityKey: 'sapporo', displayName: 'Sapporo', lastGeneratedAt: recentTime });
      seedPlace(dest.id, { category: 'culture', name: 'Recent' });

      const { events, error } = await callDiscover({ destination: 'Sapporo' });

      expect(error).toBeUndefined();
      expect(mockDiscoverDestination).not.toHaveBeenCalled();
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent?.cached).toBe(true);
    });

    it('treats a destination generated 8 days ago (UTC, no zone marker) as stale', async () => {
      const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const dest = seedDestination({ cityKey: 'sendai', displayName: 'Sendai', lastGeneratedAt: staleTime });
      seedPlace(dest.id, { category: 'culture', name: 'Old' });

      mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
        const cats = [{ category: 'culture', items: [{ name: 'New', description: 'A newly generated spot.', lat: null, lng: null }] }];
        cats.forEach((cat) => onCategory(cat));
        return cats;
      });

      const { events, error } = await callDiscover({ destination: 'Sendai' });

      expect(error).toBeUndefined();
      expect(mockDiscoverDestination).toHaveBeenCalledOnce();
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent?.cached).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Merge-on-refresh (stale TTL, not an explicit "show more")
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — merge-on-refresh', () => {
  it('adds freshly generated items to the existing stale catalogue instead of replacing it', async () => {
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'fukuoka', displayName: 'Fukuoka', lastGeneratedAt: expiredTime });
    seedPlace(dest.id, { category: 'culture', name: 'Kinkakuji' });
    seedPlace(dest.id, { category: 'food', name: 'Ramen Alley' });

    const freshCategories = [
      { category: 'culture', items: [{ name: 'Nijo Castle', description: 'A castle with painted sliding doors and creaky nightingale floors.', lat: 35.0, lng: 135.7 }] },
      { category: 'nightlife', items: [{ name: 'Pontocho Alley', description: 'A narrow lantern-lit alley of riverside restaurants.', lat: 35.0, lng: 135.7 }] },
    ];
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      freshCategories.forEach((cat) => onCategory(cat));
      return freshCategories;
    });

    const { events, error } = await callDiscover({ destination: 'Fukuoka' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();

    // Exclusions passed to Claude are the already-stored names (dedupe), not "more:true"
    const exclusionList = mockDiscoverDestination.mock.calls[0][1];
    expect(exclusionList).toEqual(expect.arrayContaining(['Kinkakuji', 'Ramen Alley']));

    // Stream contract for a stale refresh: stored breadth is streamed up front
    // (instant grid), the mid-generation delta is suppressed, and the full merged
    // set is streamed at the end. The client's non-append protocol replaces each
    // category with the last version received, so the final visible state must be
    // the MERGED set — never the bare delta. No event carries the append flag
    // (this is a full page load, not a "show more" continuation).
    const categoryEvents = events.filter((e) => e.type === 'category');
    expect(categoryEvents.every((e) => e.append === undefined)).toBe(true);
    const lastVersionOf = (name) => categoryEvents.filter((e) => e.category === name).at(-1);
    expect(lastVersionOf('culture').items.map((i) => i.name)).toEqual(['Kinkakuji', 'Nijo Castle']);
    expect(lastVersionOf('food').items.map((i) => i.name)).toEqual(['Ramen Alley']);
    expect(lastVersionOf('nightlife').items.map((i) => i.name)).toEqual(['Pontocho Alley']);
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(false);
    expect(doneEvent?.append).toBeUndefined();

    // But the DB retains the previously stored items AND gains the new ones
    const db = getDb();
    const activeNames = (category) => db.prepare(
      `SELECT name FROM discovery_places WHERE destination_id = ? AND category = ? AND status = 'active' ORDER BY id`,
    ).all(dest.id, category).map((r) => r.name);
    expect(activeNames('culture')).toEqual(['Kinkakuji', 'Nijo Castle']);
    expect(activeNames('food')).toEqual(['Ramen Alley']);
    expect(activeNames('nightlife')).toEqual(['Pontocho Alley']);
  });

  it('stamps newly added items with generatedAt while leaving previously stored items untouched', async () => {
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'nagasaki', displayName: 'Nagasaki', lastGeneratedAt: expiredTime });
    seedPlace(dest.id, { category: 'culture', name: 'Kinkakuji', generatedAt: '2020-01-01T00:00:00.000Z' });

    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      const cats = [{ category: 'culture', items: [{ name: 'Glover Garden', description: 'A hillside garden of preserved merchant houses.', lat: null, lng: null }] }];
      cats.forEach((cat) => onCategory(cat));
      return cats;
    });

    const before = Date.now();
    const { error } = await callDiscover({ destination: 'Nagasaki' });
    const after = Date.now();

    expect(error).toBeUndefined();
    const db = getDb();
    const oldItem = db.prepare(`SELECT * FROM discovery_places WHERE destination_id = ? AND name = ?`).get(dest.id, 'Kinkakuji');
    expect(oldItem.generated_at).toBe('2020-01-01T00:00:00.000Z');

    const newItem = db.prepare(`SELECT * FROM discovery_places WHERE destination_id = ? AND name = ?`).get(dest.id, 'Glover Garden');
    const stampMs = new Date(newItem.generated_at).getTime();
    expect(stampMs).toBeGreaterThanOrEqual(before);
    expect(stampMs).toBeLessThanOrEqual(after);
  });

  it('stamps generatedAt on a brand-new destination (true first generation, no prior row)', async () => {
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const before = Date.now();
    const { error } = await callDiscover({ destination: 'Kobe City' });
    const after = Date.now();

    expect(error).toBeUndefined();
    const db = getDb();
    const dest = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('kobecity');
    const item = db.prepare('SELECT * FROM discovery_places WHERE destination_id = ?').get(dest.id);
    const stampMs = new Date(item.generated_at).getTime();
    expect(stampMs).toBeGreaterThanOrEqual(before);
    expect(stampMs).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// Destination key normalization
// ---------------------------------------------------------------------------

describe('destination key normalization', () => {
  it('matches an existing destination regardless of input case', async () => {
    const dest = seedDestination({ cityKey: 'osaka', displayName: 'Osaka', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'food', name: 'Dotonbori Street Food' });

    const { events, error } = await callDiscover({ destination: 'OSAKA' });

    expect(error).toBeUndefined();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Show more (append mode)
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — more:true (append mode)', () => {
  it('behaves like a normal first generation when no destination catalogue exists', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { events, error } = await callDiscover({ destination: 'Nagoya', more: true });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const categoryEvents = events.filter((e) => e.type === 'category');
    expect(categoryEvents.every((e) => !e.append)).toBe(true);

    const destRow = getDb().prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('nagoya');
    expect(destRow).toBeDefined();
  });

  it('excludes stored item names and existing stop titles, streams append:true chunks, and adds to the catalogue', async () => {
    const dest = seedDestination({ cityKey: 'kyoto', displayName: 'Kyoto', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'culture', name: 'Kinkakuji' });
    seedPlace(dest.id, { category: 'food', name: 'Ramen Alley' });

    const newCategories = [
      { category: 'culture', items: [{ name: 'Nijo Castle', description: 'A castle with painted sliding doors and creaky nightingale floors.', lat: 35.0, lng: 135.7 }] },
      { category: 'nightlife', items: [{ name: 'Pontocho Alley', description: 'A narrow lantern-lit alley of riverside restaurants.', lat: 35.0, lng: 135.7 }] },
    ];
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      newCategories.forEach((cat) => onCategory(cat));
      return newCategories;
    });

    const { events, error } = await callDiscover({ destination: 'Kyoto', more: true });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const exclusionList = mockDiscoverDestination.mock.calls[0][1];
    expect(exclusionList).toEqual(expect.arrayContaining(['Kinkakuji', 'Ramen Alley']));

    const categoryEvents = events.filter((e) => e.type === 'category');
    expect(categoryEvents.length).toBe(2);
    expect(categoryEvents.every((e) => e.append === true)).toBe(true);
    // Only the NEW items are streamed, not the pre-existing stored ones
    expect(categoryEvents.find((e) => e.category === 'culture').items.map((i) => i.name)).toEqual(['Nijo Castle']);

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.append).toBe(true);

    const db = getDb();
    const activeNames = (category) => db.prepare(
      `SELECT name FROM discovery_places WHERE destination_id = ? AND category = ? AND status = 'active' ORDER BY id`,
    ).all(dest.id, category).map((r) => r.name);
    expect(activeNames('culture')).toEqual(['Kinkakuji', 'Nijo Castle']);
    expect(activeNames('nightlife')).toEqual(['Pontocho Alley']);
    // Untouched category still present
    expect(activeNames('food')).toEqual(['Ramen Alley']);
  });

  it('never removes existing stored items even when the new batch is empty', async () => {
    const dest = seedDestination({ cityKey: 'kobe', displayName: 'Kobe', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'culture', name: 'Kinkakuji' });

    mockDiscoverDestination.mockImplementation(async () => []);

    const { error } = await callDiscover({ destination: 'Kobe', more: true });

    expect(error).toBeUndefined();
    const db = getDb();
    const activeNames = db.prepare(
      `SELECT name FROM discovery_places WHERE destination_id = ? AND status = 'active' ORDER BY id`,
    ).all(dest.id).map((r) => r.name);
    expect(activeNames).toEqual(['Kinkakuji']);
  });
});

// ---------------------------------------------------------------------------
// Country-qualified destination keys — (city, '') vs (city, 'MY') distinctness
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — country-qualified destinations', () => {
  it('treats (city, "") and (city, "MY") as distinct catalogues with independent item sets', async () => {
    // Seed an unknown-country Georgetown with its own stored place.
    const unknownDest = seedDestination({ cityKey: 'georgetown', countryCode: '', displayName: 'Georgetown', lastGeneratedAt: nowSql() });
    seedPlace(unknownDest.id, { category: 'culture', name: 'Guyana National Museum' });

    // Now discover Georgetown, Malaysia — should be a cache MISS (distinct
    // destination row) even though an unqualified "Georgetown" already exists.
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      const cats = [{ category: 'culture', items: [{ name: 'Fort Cornwallis', description: 'A star fort at the mouth of the Prai river.', lat: null, lng: null }] }];
      cats.forEach((cat) => onCategory(cat));
      return cats;
    });

    const { events, error } = await callDiscover({ destination: 'Georgetown', countryCode: 'MY' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    // Exclusions for the MY catalogue must NOT include the unqualified catalogue's items —
    // they are entirely separate destinations sharing only a city name.
    const exclusionList = mockDiscoverDestination.mock.calls[0][1];
    expect(exclusionList).toEqual([]);

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(false);

    const db = getDb();
    const unknownRow = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?').get('georgetown', '');
    const myRow = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?').get('georgetown', 'MY');
    expect(unknownRow).toBeDefined();
    expect(myRow).toBeDefined();
    expect(unknownRow.id).not.toBe(myRow.id);

    const unknownItems = db.prepare('SELECT name FROM discovery_places WHERE destination_id = ?').all(unknownRow.id).map((r) => r.name);
    const myItems = db.prepare('SELECT name FROM discovery_places WHERE destination_id = ?').all(myRow.id).map((r) => r.name);
    expect(unknownItems).toEqual(['Guyana National Museum']);
    expect(myItems).toEqual(['Fort Cornwallis']);
  });

  it('composes the country into the string sent to Claude but not into the cache key', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { error } = await callDiscover({ destination: 'Chengdu', countryCode: 'CN' });

    expect(error).toBeUndefined();
    const claudeDestinationArg = mockDiscoverDestination.mock.calls[0][0];
    expect(claudeDestinationArg.toLowerCase()).toContain('chengdu');
    expect(claudeDestinationArg.toLowerCase()).toContain('cn');

    const db = getDb();
    const destRow = db.prepare('SELECT * FROM discovery_destinations WHERE country_code = ?').get('CN');
    // The stored city_key stays the bare normalized city — no country suffix leaks into it.
    expect(destRow.city_key).toBe('chengdu');
  });
});

// ---------------------------------------------------------------------------
// D6 empty-country guard (Plan 9 Wave 5.1, fixture F10) — an EMPTY-countryCode
// request reuses the single existing country-coded catalogue row for the same
// city key instead of minting a fresh ''-bucket twin. Zero or multiple
// country-coded rows keep today's ''-bucket behavior exactly.
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — D6 empty-country guard', () => {
  it('reuses the single existing country-coded row (kualalumpur|MY) for an empty-countryCode request — no "" row created', async () => {
    const myDest = seedDestination({ cityKey: 'kualalumpur', countryCode: 'MY', displayName: 'Kuala Lumpur', lastGeneratedAt: nowSql() });
    seedPlace(myDest.id, { category: 'culture', name: 'Petronas Towers' });

    const { events, error } = await callDiscover({ destination: 'Kuala Lumpur' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).not.toHaveBeenCalled(); // cache hit against the MY row
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    const categoryEvent = events.find((e) => e.type === 'category');
    expect(categoryEvent?.items[0].name).toBe('Petronas Towers');

    const db = getDb();
    const allRows = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').all('kualalumpur');
    expect(allRows).toHaveLength(1);
    expect(allRows[0].country_code).toBe('MY');
  });

  it('falls back to the "" bucket as today when zero country-coded rows exist', async () => {
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { error } = await callDiscover({ destination: 'Novaria' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();

    const db = getDb();
    const row = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('novaria');
    expect(row).toBeDefined();
    expect(row.country_code).toBe('');
  });

  it('falls back to the "" bucket as today when two country-coded rows exist (georgetown|MY, georgetown|GY)', async () => {
    seedDestination({ cityKey: 'georgetown', countryCode: 'MY', displayName: 'Georgetown' });
    seedDestination({ cityKey: 'georgetown', countryCode: 'GY', displayName: 'Georgetown' });

    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { error } = await callDiscover({ destination: 'Georgetown' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();

    const db = getDb();
    const emptyRow = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?').get('georgetown', '');
    expect(emptyRow).toBeDefined();
    const allRows = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').all('georgetown');
    expect(allRows).toHaveLength(3);
  });

  it('leaves a CJK free-text key (北京) with no country-coded twin in the "" bucket, unchanged', async () => {
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { error } = await callDiscover({ destination: '北京' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();

    const db = getDb();
    const row = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('北京');
    expect(row).toBeDefined();
    expect(row.country_code).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Golden fixture — route serves identical category/item sets before/after
// migrating a blob into the new catalogue (whyItFits mapped correctly)
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — golden fixture parity', () => {
  it('serves the exact same category/item shape a pre-Wave-1 blob would have, after being backfilled into the catalogue', async () => {
    // This is the shape the OLD global_discovery_cache blob stored for a
    // destination, and the shape an old client expects streamed back.
    const goldenBlobCategories = [
      {
        category: 'culture',
        items: [{
          name: 'Todaiji Temple',
          description: 'A vast wooden hall housing a 15-metre bronze Buddha.',
          whyItFits: 'Arrive at opening to have the hall nearly to yourself before the tour groups.',
          estimatedDuration: '1.5 hours',
          openingHours: '8:00-17:00',
          localName: '東大寺',
          aliases: ['Todai-ji'],
          lat: null,
          lng: null,
          generatedAt: '2025-03-01T00:00:00.000Z',
        }],
      },
    ];

    const dest = seedDestination({ cityKey: 'nara2', displayName: 'Nara2', lastGeneratedAt: nowSql() });
    // Simulate the backfill: insert the golden blob's item via insertPlaces
    // (the same function migration 016 uses), rather than re-deriving field
    // mapping logic in this test.
    const { insertPlaces } = await import('../src/db/discoveryCatalogue.js');
    insertPlaces(getDb(), dest.id, goldenBlobCategories.flatMap((cat) =>
      cat.items.map((item) => ({ ...item, category: cat.category })),
    ), 0);

    const { events, error } = await callDiscover({ destination: 'Nara2' });

    expect(error).toBeUndefined();
    const categoryEvent = events.find((e) => e.type === 'category' && e.category === 'culture');
    expect(categoryEvent.items).toHaveLength(1);
    const streamedItem = categoryEvent.items[0];

    // Field-for-field parity with the original blob item, mapping whyItFits correctly.
    expect(streamedItem.name).toBe(goldenBlobCategories[0].items[0].name);
    expect(streamedItem.description).toBe(goldenBlobCategories[0].items[0].description);
    expect(streamedItem.whyItFits).toBe(goldenBlobCategories[0].items[0].whyItFits);
    expect(streamedItem.estimatedDuration).toBe(goldenBlobCategories[0].items[0].estimatedDuration);
    expect(streamedItem.openingHours).toBe(goldenBlobCategories[0].items[0].openingHours);
    expect(streamedItem.localName).toBe(goldenBlobCategories[0].items[0].localName);
    expect(streamedItem.aliases).toEqual(goldenBlobCategories[0].items[0].aliases);
    expect(streamedItem.lat).toBeNull();
    expect(streamedItem.lng).toBeNull();
    expect(streamedItem.generatedAt).toBe(goldenBlobCategories[0].items[0].generatedAt);

    // Wave 3 additive fields — old fields above stay byte-identical; these
    // are new, never a replacement for anything an old client reads.
    expect(streamedItem.whyGo).toBe(goldenBlobCategories[0].items[0].whyItFits);
    // Never verified in this test (the mocked resolver always returns
    // 'unresolved' — see beforeEach), so provenance stays at insertPlaces's
    // default and lat/lng confirm the "unverified stays null" rule even
    // though the row's actual lat/lng columns are always null anyway.
    expect(streamedItem.provenance).toBe('unverified');
    expect(typeof streamedItem.batch).toBe('number');
    // insertPlaces never sets provider_place_id — no resolver has run.
    expect(streamedItem.placeRef).toBeNull();
    // Wave 4 additive field: the real discovery_places.id, needed by the
    // client to call the report/suppress endpoint (POST .../places/:id/report).
    expect(typeof streamedItem.id).toBe('number');
    // The seeded trip (see beforeAll) has interestTags: ['culture', 'food'],
    // pace: 'relaxed'. This item is category 'culture' (an honestly declared
    // interest) with estimatedDuration '1.5 hours' — under 3h, so it does
    // NOT satisfy the 'relaxed' pace-fit rule, and it is not verified. So
    // fitLine may honestly claim the category match and nothing else.
    expect(streamedItem.fitLine).toBe('Matches culture');
  });
});

// ---------------------------------------------------------------------------
// Generation failure with an existing catalogue (graceful degrade)
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — generation failure', () => {
  it('serves the existing catalogue with done:{cached:true, generationFailed:true} instead of an error, when a catalogue already exists', async () => {
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'nagano', displayName: 'Nagano', lastGeneratedAt: expiredTime });
    seedPlace(dest.id, { category: 'culture', name: 'Zenkoji Temple' });

    mockDiscoverDestination.mockImplementation(async () => {
      throw new Error('Claude API unavailable');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await callDiscover({ destination: 'Nagano' });
    errorSpy.mockRestore();

    expect(error).toBeUndefined();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeUndefined();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    expect(doneEvent?.generationFailed).toBe(true);
    const categoryEvent = events.find((e) => e.type === 'category');
    expect(categoryEvent?.items.map((i) => i.name)).toEqual(['Zenkoji Temple']);
  });

  it('streams type:error when generation fails and there is no existing catalogue at all', async () => {
    mockDiscoverDestination.mockImplementation(async () => {
      throw new Error('Claude API unavailable');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await callDiscover({ destination: 'Brand New City' });
    errorSpy.mockRestore();

    expect(error).toBeUndefined();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toMatch(/unavailable/i);
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();
  });

  // Production incident (verified root cause): a generation that threw after
  // parsing too few usable categories (the new minimum-yield guard in
  // claude.js) must never be treated as a successful generation by the route
  // — last_generated_at and the daily generation counter must stay exactly as
  // they were before the attempt, and the request must serve the stored
  // catalogue rather than committing the thin/failed result as fresh.
  it('does not update last_generated_at or the daily generation count when generation fails, and re-serves the stored catalogue unchanged', async () => {
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'balitest', countryCode: 'ID', displayName: 'Bali', lastGeneratedAt: expiredTime, generationCount: 1 });
    seedPlace(dest.id, { category: 'wellness', name: 'Old Karsa Spa' });
    getDb().prepare(
      `INSERT INTO discovery_generation_daily (destination_id, utc_date, count) VALUES (?, strftime('%Y-%m-%d','now'), 1)`,
    ).run(dest.id);

    // Mirrors the real discoverDestination throwing on insufficient yield.
    mockDiscoverDestination.mockImplementation(async () => {
      throw new Error('[discover] insufficient yield for destination=bali: 1 of 1 parsed categories had items (10 items total), 7 lines dropped as unparseable');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await callDiscover({ destination: 'Balitest', countryCode: 'ID' });
    errorSpy.mockRestore();

    expect(error).toBeUndefined();
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.cached).toBe(true);
    expect(doneEvent?.generationFailed).toBe(true);

    // The pre-existing stored catalogue is served, untouched.
    const categoryEvent = events.find((e) => e.type === 'category');
    expect(categoryEvent?.items.map((i) => i.name)).toEqual(['Old Karsa Spa']);

    // Neither the lifetime generation_count/last_generated_at nor the daily
    // counter were bumped by the failed attempt — the DB is exactly as it
    // was before the request, apart from the row's identity.
    const destRow = getDb().prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(dest.id);
    expect(destRow.last_generated_at).toBe(expiredTime);
    expect(destRow.generation_count).toBe(1);
    const dailyRow = getDb().prepare(
      `SELECT count FROM discovery_generation_daily WHERE destination_id = ? AND utc_date = strftime('%Y-%m-%d','now')`,
    ).get(dest.id);
    expect(dailyRow.count).toBe(1);
    const places = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ?').all(dest.id);
    expect(places).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Generation limit (Plan 7 Wave 2, decision 4 — max 3 generations/destination/day)
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — generation limit', () => {
  it('blocks a 4th generation for the same destination on the same UTC day with an SSE generation_limit error', async () => {
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'limitcity', displayName: 'Limitcity', lastGeneratedAt: staleTime });
    seedPlace(dest.id, { category: 'culture', name: 'Existing Spot' });
    getDb().prepare(
      `INSERT INTO discovery_generation_daily (destination_id, utc_date, count) VALUES (?, strftime('%Y-%m-%d','now'), 3)`,
    ).run(dest.id);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await callDiscover({ destination: 'Limitcity' });
    errorSpy.mockRestore();

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).not.toHaveBeenCalled();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.code).toBe('generation_limit');
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();
  });

  it('allows generation on a new UTC day even though the destination has 3+ generations from a previous day', async () => {
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const dest = seedDestination({ cityKey: 'limitcity2', displayName: 'Limitcity2', lastGeneratedAt: staleTime, generationCount: 5 });
    seedPlace(dest.id, { category: 'culture', name: 'Old Spot' });
    getDb().prepare(
      `INSERT INTO discovery_generation_daily (destination_id, utc_date, count) VALUES (?, '2020-01-01', 3)`,
    ).run(dest.id);

    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { events, error } = await callDiscover({ destination: 'Limitcity2' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    const dailyRow = getDb().prepare(
      `SELECT count FROM discovery_generation_daily WHERE destination_id = ? AND utc_date = strftime('%Y-%m-%d','now')`,
    ).get(dest.id);
    expect(dailyRow.count).toBe(1);
  });

  it('increments the daily counter on each successful generation and blocks the 4th attempt within one test-driven day', async () => {
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      const cats = [{ category: 'culture', items: [{ name: `Spot ${Math.random()}`, description: 'd' }] }];
      cats.forEach((cat) => onCategory(cat));
      return cats;
    });

    // Generation 1: brand new destination (cache miss).
    await callDiscover({ destination: 'Repeatcity' });
    const dest = getDb().prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('repeatcity');

    // Force subsequent calls to also be treated as generations by making the
    // catalogue look stale each time (this test only cares about the counter).
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const forceStale = () => getDb().prepare(
      'UPDATE discovery_destinations SET last_generated_at = ? WHERE id = ?',
    ).run(staleTime, dest.id);

    forceStale();
    await callDiscover({ destination: 'Repeatcity' }); // generation 2
    forceStale();
    await callDiscover({ destination: 'Repeatcity' }); // generation 3
    forceStale();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events } = await callDiscover({ destination: 'Repeatcity' }); // 4th — blocked
    errorSpy.mockRestore();

    expect(mockDiscoverDestination).toHaveBeenCalledTimes(3);
    expect(events.find((e) => e.type === 'error')?.code).toBe('generation_limit');
  });
});

// ---------------------------------------------------------------------------
// Report/suppress endpoint
// ---------------------------------------------------------------------------

async function callReport(placeId, body, requestingUserId) {
  const { discoveryPlacesRouter } = await import('../src/routes/discovery.js');
  const req = {
    params: { placeId: String(placeId) },
    body,
    user: { id: requestingUserId ?? userId },
  };
  const res = {
    jsonBody: null,
    json(payload) { this.jsonBody = payload; },
  };
  let nextErr;
  const next = (err) => { nextErr = err; };

  const layer = discoveryPlacesRouter.stack.find(
    (l) => l.route?.path === '/places/:placeId/report' && l.route.methods.post,
  );
  if (!layer) throw new Error('report route not found');
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res, next);

  return { res, error: nextErr };
}

describe('POST /api/discovery/places/:placeId/report', () => {
  it('suppresses the place, logs, and excludes it from listActivePlaces and future exclusion names', async () => {
    const dest = seedDestination({ cityKey: 'reportcity', displayName: 'Reportcity', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'food', name: 'Bad Ramen' });
    const place = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ?').get(dest.id);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, error } = await callReport(place.id, { tripId });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[discovery] suppressed'),
      place.id, place.name, userId, tripId,
    );
    errorSpy.mockRestore();

    expect(error).toBeUndefined();
    expect(res.jsonBody).toEqual({ suppressed: true });

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.status).toBe('suppressed');

    const { listActivePlaces, listExclusionNames } = await import('../src/db/discoveryCatalogue.js');
    expect(listActivePlaces(getDb(), dest.id)).toHaveLength(0);
    expect(listExclusionNames(getDb(), dest.id)).toContain('Bad Ramen');
  });

  it('rejects with 400 when tripId is missing from the body', async () => {
    const dest = seedDestination({ cityKey: 'reportcity2', displayName: 'Reportcity2', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'food', name: 'Some Spot' });
    const place = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ?').get(dest.id);

    const { error } = await callReport(place.id, {});
    expect(error).toBeDefined();
    expect(error.status).toBe(400);
  });

  it('rejects with 404 when the requesting user has no access to the given trip', async () => {
    const dest = seedDestination({ cityKey: 'reportcity3', displayName: 'Reportcity3', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'food', name: 'Some Spot' });
    const place = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ?').get(dest.id);

    const { error } = await callReport(place.id, { tripId: 'nonexistent-trip-id' });
    expect(error).toBeDefined();
    expect(error.status).toBe(404);
  });

  it('rejects with 404 when the place does not exist', async () => {
    const { error } = await callReport(999999, { tripId });
    expect(error).toBeDefined();
    expect(error.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Verification worker failure isolation (route-level, using the SSE harness)
// ---------------------------------------------------------------------------

describe('verification worker — failure isolation', () => {
  it('a resolvePlace throw for one item leaves that item unverified without affecting others or the SSE response', async () => {
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      const cats = [{
        category: 'culture',
        items: [
          { name: 'Good Place', description: 'd1' },
          { name: 'Bad Place', description: 'd2' },
        ],
      }];
      cats.forEach((cat) => onCategory(cat));
      return cats;
    });

    mockResolvePlace.mockImplementation(async ({ queryText }) => {
      if (queryText === 'Bad Place') throw new Error('lookup exploded');
      return {
        lat: 1, lng: 2, coordinateSystem: 'wgs84', coordinateSource: 'manual_lookup',
        locationStatus: 'resolved', confidence: 0.9, resolvedName: queryText, resolvedAddress: 'addr',
        providerId: 'osm:node/1', provider: 'nominatim', countryCode: null,
        businessStatus: null, rating: null, ratingCount: null,
      };
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await callDiscover({ destination: 'Failtown' });

    expect(error).toBeUndefined();
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();

    const dest = getDb().prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('failtown');
    await waitForVerificationDrain(dest.id);
    errorSpy.mockRestore();

    const rows = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ? ORDER BY name').all(dest.id);
    const bad = rows.find((r) => r.name === 'Bad Place');
    const good = rows.find((r) => r.name === 'Good Place');
    expect(bad.provenance).toBe('unverified');
    expect(good.provenance).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Pollution invariant: two trips with different prefs browsing the same
// destination must leave the global tables identical regardless of order.
// ---------------------------------------------------------------------------

describe('pollution invariant', () => {
  async function callDiscoverAsTrip(tripRow, body) {
    const { default: handler } = await import('../src/routes/discovery.js');
    const req = { params: { tripId: tripRow.id }, body, user: { id: userId }, trip: tripRow };
    const { res, events } = makeSseRes();
    let nextErr;
    const next = (err) => { nextErr = err; };
    const layer = handler.stack.find(
      (l) => l.route?.path === '/:tripId/discover' && l.route.methods.post,
    );
    await layer.route.stack[layer.route.stack.length - 1].handle(req, res, next);
    return { events, error: nextErr };
  }

  function snapshotDestination(cityKey) {
    const db = getDb();
    const destRows = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').all(cityKey);
    const placeRows = db.prepare(`
      SELECT category, name, description, provenance, status, batch
      FROM discovery_places WHERE destination_id IN (SELECT id FROM discovery_destinations WHERE city_key = ?)
      ORDER BY category, name
    `).all(cityKey);
    return {
      destinations: destRows.map((r) => ({ country_code: r.country_code, display_name: r.display_name })),
      places: placeRows,
    };
  }

  it('leaves discovery_destinations/discovery_places identical whichever of two differently-prefed trips generates first', async () => {
    const tripA = tripService.createTrip(userId, {
      title: 'Pollution A', startDate: '2026-06-01', endDate: '2026-06-05',
      destinations: ['Pollutionville'], destinationCountries: ['JP'],
      interestTags: ['food'], pace: 'fast', travellers: 1,
    }).trip;
    const tripB = tripService.createTrip(userId, {
      title: 'Pollution B', startDate: '2026-06-01', endDate: '2026-06-05',
      destinations: ['Pollutionville'], destinationCountries: ['JP'],
      interestTags: ['nightlife'], pace: 'relaxed', travellers: 4,
    }).trip;

    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    await callDiscoverAsTrip(tripA, { destination: 'Pollutionville' });
    await callDiscoverAsTrip(tripB, { destination: 'Pollutionville' });
    const orderAB = snapshotDestination('pollutionville');

    getDb().prepare('DELETE FROM discovery_places').run();
    getDb().prepare('DELETE FROM discovery_destinations').run();
    getDb().prepare('DELETE FROM discovery_generation_daily').run();
    mockDiscoverDestination.mockClear();
    mockDiscoverDestination.mockImplementation(async (d, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    await callDiscoverAsTrip(tripB, { destination: 'Pollutionville' });
    await callDiscoverAsTrip(tripA, { destination: 'Pollutionville' });
    const orderBA = snapshotDestination('pollutionville');

    expect(orderAB.destinations).toHaveLength(1);
    expect(orderBA.destinations).toEqual(orderAB.destinations);
    expect(orderBA.places).toEqual(orderAB.places);
  });
});

// ---------------------------------------------------------------------------
// Wave 3 scenario 1 (plan §Wave 3, review doc §3 row 1): solo fast-paced food
// trip vs. slow-paced family trip browsing the SAME catalogue must get
// different category order, different item order, and different fitLines —
// but the identical underlying set of rows.
// ---------------------------------------------------------------------------

describe('Wave 3 — scenario 1: same catalogue, different trip prefs', () => {
  async function callDiscoverAsTrip(tripRow, body) {
    const { default: handler } = await import('../src/routes/discovery.js');
    const req = { params: { tripId: tripRow.id }, body, user: { id: userId }, trip: tripRow };
    const { res, events } = makeSseRes();
    let nextErr;
    const next = (err) => { nextErr = err; };
    const layer = handler.stack.find(
      (l) => l.route?.path === '/:tripId/discover' && l.route.methods.post,
    );
    await layer.route.stack[layer.route.stack.length - 1].handle(req, res, next);
    return { events, error: nextErr };
  }

  it('same global rows, different category order, different item order, different fit lines', async () => {
    // Categories chosen so alphabetical DB order (culture, essentials, food,
    // nightlife, wellness) is NOT already "nightlife last" — otherwise the
    // family-demotes-nightlife rule would be a no-op and prove nothing.
    const dest = seedDestination({ cityKey: 'scenario1city', displayName: 'Scenario1City', lastGeneratedAt: nowSql() });

    seedPlace(dest.id, { category: 'essentials', name: 'Essential Spot' });
    seedPlace(dest.id, { category: 'culture', name: 'Culture Spot' });
    seedPlace(dest.id, { category: 'nightlife', name: 'Night Owl' });
    seedPlace(dest.id, { category: 'wellness', name: 'Spa Retreat' });
    // Two food items with different durations — pace-fit is the only thing
    // that differentiates them (same category, same provenance, same batch).
    seedPlace(dest.id, { category: 'food', name: 'Quick Bite', estimatedDuration: '1 hour' });
    seedPlace(dest.id, { category: 'food', name: 'Long Feast', estimatedDuration: '4 hours' });

    const tripADto = tripService.createTrip(userId, {
      title: 'Scenario1 A', startDate: '2026-06-01', endDate: '2026-06-05',
      destinations: ['Scenario1City'], destinationCountries: ['JP'],
      interestTags: ['food & drink'], pace: 'fast', travellers: 'solo',
    }).trip;
    const tripBDto = tripService.createTrip(userId, {
      title: 'Scenario1 B', startDate: '2026-06-01', endDate: '2026-06-05',
      destinations: ['Scenario1City'], destinationCountries: ['JP'],
      interestTags: [], pace: 'relaxed', travellers: 'family',
    }).trip;
    // req.trip in production is the RAW SQL row (set by requireTripAccess),
    // not tripService's camelCase DTO — re-fetch raw rows so interest_tags
    // (snake_case, JSON-string column) is actually readable by the route,
    // matching real middleware behavior exactly.
    const tripA = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripADto.id);
    const tripB = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripBDto.id);

    const { events: eventsA, error: errorA } = await callDiscoverAsTrip(tripA, { destination: 'Scenario1City' });
    const { events: eventsB, error: errorB } = await callDiscoverAsTrip(tripB, { destination: 'Scenario1City' });

    expect(errorA).toBeUndefined();
    expect(errorB).toBeUndefined();

    const categoryEventsA = eventsA.filter((e) => e.type === 'category');
    const categoryEventsB = eventsB.filter((e) => e.type === 'category');

    const categoryOrderA = categoryEventsA.map((e) => e.category);
    const categoryOrderB = categoryEventsB.map((e) => e.category);

    // Profile A: solo, fast pace, interested in food & drink -> 'food' is
    // interest-mapped and moves up right after essentials; nightlife has no
    // reason to move since travellers isn't 'family'.
    expect(categoryOrderA).toEqual(['essentials', 'food', 'culture', 'nightlife', 'wellness']);
    // Profile B: family, relaxed pace, no declared interests -> categories
    // stay in their natural (alphabetical) order EXCEPT nightlife, which is
    // demoted all the way to the end because travellers === 'family'.
    expect(categoryOrderB).toEqual(['essentials', 'culture', 'food', 'wellness', 'nightlife']);
    expect(categoryOrderA).not.toEqual(categoryOrderB);

    // Item order within 'food' (present in both) must differ: A's fast pace
    // favors the short item, B's relaxed pace favors the long one.
    const foodItemsA = categoryEventsA.find((e) => e.category === 'food').items.map((i) => i.name);
    const foodItemsB = categoryEventsB.find((e) => e.category === 'food').items.map((i) => i.name);
    expect(foodItemsA).toEqual(['Quick Bite', 'Long Feast']);
    expect(foodItemsB).toEqual(['Long Feast', 'Quick Bite']);

    // Fit lines reflect each trip's own honestly-declared prefs.
    const quickBiteA = categoryEventsA.find((e) => e.category === 'food').items.find((i) => i.name === 'Quick Bite');
    const longFeastB = categoryEventsB.find((e) => e.category === 'food').items.find((i) => i.name === 'Long Feast');
    expect(quickBiteA.fitLine).toBe('Matches food · ~1h');
    expect(longFeastB.fitLine).toBe('~4h');

    // Same underlying set of rows for both — only order/fitLines differ.
    const allNamesA = categoryEventsA.flatMap((e) => e.items.map((i) => i.name)).sort();
    const allNamesB = categoryEventsB.flatMap((e) => e.items.map((i) => i.name)).sort();
    expect(new Set(allNamesA)).toEqual(new Set(allNamesB));
    expect(allNamesA).toEqual(['Culture Spot', 'Essential Spot', 'Long Feast', 'Night Owl', 'Quick Bite', 'Spa Retreat']);
  });

  it('never claims an interest the trip did not declare (fitLine honesty gate)', async () => {
    // A trip that only declared 'history' (maps to 'culture') browsing a
    // destination with a strong food item must never say "Matches food" —
    // even though the item objectively fits the food category.
    const dest = seedDestination({ cityKey: 'honestycity', displayName: 'HonestyCity', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'food', name: 'Tempting Ramen Stall', estimatedDuration: '1 hour' });
    seedPlace(dest.id, { category: 'culture', name: 'History Museum', estimatedDuration: '2 hours' });

    const tripDto = tripService.createTrip(userId, {
      title: 'Honesty Trip', startDate: '2026-06-01', endDate: '2026-06-05',
      destinations: ['HonestyCity'], destinationCountries: ['JP'],
      interestTags: ['history'], pace: 'moderate', travellers: 'couple',
    }).trip;
    const trip = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripDto.id);

    const { events, error } = await callDiscoverAsTrip(trip, { destination: 'HonestyCity' });
    expect(error).toBeUndefined();

    const foodEvent = events.find((e) => e.type === 'category' && e.category === 'food');
    const ramen = foodEvent.items.find((i) => i.name === 'Tempting Ramen Stall');
    expect(ramen.fitLine).not.toContain('Matches food');
    // Moderate pace is neutral, so no duration claim either; unverified, so
    // no "verified place" claim. Nothing honest applies -> empty fitLine.
    expect(ramen.fitLine).toBe('');

    // The declared interest (history -> culture) DOES get an honest claim.
    const cultureEvent = events.find((e) => e.type === 'category' && e.category === 'culture');
    const museum = cultureEvent.items.find((i) => i.name === 'History Museum');
    expect(museum.fitLine).toBe('Matches culture');
  });
});
