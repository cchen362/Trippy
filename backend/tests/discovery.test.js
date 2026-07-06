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

vi.mock('../src/services/claude.js', () => ({
  discoverDestination: mockDiscoverDestination,
  normalizeName,
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
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
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

function seedPlace(destinationId, { category, name, generatedAt = new Date().toISOString(), batch = 0 }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discovery_places (
      destination_id, category, name, normalized_name, description, provenance, status, batch, generated_at
    ) VALUES (?, ?, ?, ?, ?, 'unverified', 'active', ?, ?)
  `).run(destinationId, category, name, normalizeName(name), `${name} description`, batch, generatedAt);
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

    const { events, error } = await callDiscover({ destination: 'Nagano' });

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

    const { events, error } = await callDiscover({ destination: 'Brand New City' });

    expect(error).toBeUndefined();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toMatch(/unavailable/i);
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();
  });
});
