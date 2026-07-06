import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock claude.js before importing the route ---
const mockDiscoverDestination = vi.fn();

// Mirrors the real normalizeName in src/services/claude.js closely enough for these tests —
// the real dedupe behavior is covered separately by discoveryMerge.test.js and claude.test.js.
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
  { category: 'culture', items: [{ name: 'Fushimi Inari', lat: 34.97, lng: 135.77 }] },
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
  getDb().prepare('DELETE FROM global_discovery_cache').run();
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

  // Finding H3: the global discovery cache is shared across ALL trips/users. If the
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

  // Finding M6: fetched_at is written via SQLite datetime('now') — UTC with no zone
  // marker — but was previously parsed with `new Date(value)`, which JS interprets
  // as LOCAL time. That only produced a correct TTL comparison when the server
  // process happened to run in UTC. Force the test process into a non-UTC zone and
  // verify the comparison is still correct in both directions.
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

    it('treats a row fetched 1 hour ago (UTC, no zone marker) as fresh', async () => {
      const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      getDb().prepare(
        'INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, ?)',
      ).run('sapporo', JSON.stringify([{ category: 'culture', items: [{ name: 'Recent', lat: null, lng: null }] }]), recentTime);

      const { events, error } = await callDiscover({ destination: 'Sapporo' });

      expect(error).toBeUndefined();
      expect(mockDiscoverDestination).not.toHaveBeenCalled();
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent?.cached).toBe(true);
    });

    it('treats a row fetched 8 days ago (UTC, no zone marker) as stale', async () => {
      const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      getDb().prepare(
        'INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, ?)',
      ).run('sendai', JSON.stringify([{ category: 'culture', items: [{ name: 'Old', lat: null, lng: null }] }]), staleTime);

      mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
        const cats = [{ category: 'culture', items: [{ name: 'New', lat: null, lng: null }] }];
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
  it('merges freshly generated items into the existing stale row instead of replacing it', async () => {
    const db = getDb();
    const staleCategories = [
      { category: 'culture', items: [{ name: 'Kinkakuji', lat: null, lng: null }] },
      { category: 'food', items: [{ name: 'Ramen Alley', lat: null, lng: null }] },
    ];
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      'INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, ?)',
    ).run('fukuoka', JSON.stringify(staleCategories), expiredTime);

    const freshCategories = [
      { category: 'culture', items: [{ name: 'Nijo Castle', lat: 35.0, lng: 135.7 }] },
      { category: 'nightlife', items: [{ name: 'Pontocho Alley', lat: 35.0, lng: 135.7 }] },
    ];
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      freshCategories.forEach((cat) => onCategory(cat));
      return freshCategories;
    });

    const { events, error } = await callDiscover({ destination: 'Fukuoka' });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();

    // Exclusions passed to Claude are the already-cached titles (dedupe), not "more:true"
    const exclusionList = mockDiscoverDestination.mock.calls[0][1];
    expect(exclusionList).toEqual(expect.arrayContaining(['Kinkakuji', 'Ramen Alley']));

    // Stream contract for a stale refresh: cached breadth is streamed up front
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

    // But the DB row retains the previously cached items AND gains the new ones
    const row = db.prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('fukuoka');
    const merged = JSON.parse(row.result_json);
    expect(merged.find((c) => c.category === 'culture').items.map((i) => i.name)).toEqual(['Kinkakuji', 'Nijo Castle']);
    expect(merged.find((c) => c.category === 'food').items.map((i) => i.name)).toEqual(['Ramen Alley']);
    expect(merged.find((c) => c.category === 'nightlife').items.map((i) => i.name)).toEqual(['Pontocho Alley']);
  });

  it('stamps newly merged items with generatedAt while leaving previously cached items untouched', async () => {
    const db = getDb();
    const staleCategories = [
      { category: 'culture', items: [{ name: 'Kinkakuji', lat: null, lng: null, generatedAt: '2020-01-01T00:00:00.000Z' }] },
    ];
    const expiredTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      'INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, ?)',
    ).run('nagasaki', JSON.stringify(staleCategories), expiredTime);

    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      const cats = [{ category: 'culture', items: [{ name: 'Glover Garden', lat: null, lng: null }] }];
      cats.forEach((cat) => onCategory(cat));
      return cats;
    });

    const before = Date.now();
    const { error } = await callDiscover({ destination: 'Nagasaki' });
    const after = Date.now();

    expect(error).toBeUndefined();
    const row = db.prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('nagasaki');
    const merged = JSON.parse(row.result_json);
    const items = merged.find((c) => c.category === 'culture').items;

    const oldItem = items.find((i) => i.name === 'Kinkakuji');
    expect(oldItem.generatedAt).toBe('2020-01-01T00:00:00.000Z');

    const newItem = items.find((i) => i.name === 'Glover Garden');
    const stampMs = new Date(newItem.generatedAt).getTime();
    expect(stampMs).toBeGreaterThanOrEqual(before);
    expect(stampMs).toBeLessThanOrEqual(after);
  });

  it('stamps generatedAt on a brand-new cache row (true first generation, no prior row)', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const before = Date.now();
    const { error } = await callDiscover({ destination: 'Kobe City' });
    const after = Date.now();

    expect(error).toBeUndefined();
    const row = getDb().prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('kobecity');
    const stored = JSON.parse(row.result_json);
    const item = stored.find((c) => c.category === 'culture').items[0];
    const stampMs = new Date(item.generatedAt).getTime();
    expect(stampMs).toBeGreaterThanOrEqual(before);
    expect(stampMs).toBeLessThanOrEqual(after);
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
// Show more (append mode)
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/discover — more:true (append mode)', () => {
  it('behaves like a normal first generation when no cache row exists', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const { events, error } = await callDiscover({ destination: 'Nagoya', more: true });

    expect(error).toBeUndefined();
    expect(mockDiscoverDestination).toHaveBeenCalledOnce();
    const categoryEvents = events.filter((e) => e.type === 'category');
    expect(categoryEvents.every((e) => !e.append)).toBe(true);

    const row = getDb().prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('nagoya');
    expect(row).toBeDefined();
  });

  it('excludes cached item names and existing stop titles, streams append:true chunks, and merges into the cache', async () => {
    const db = getDb();
    const existingCategories = [
      { category: 'culture', items: [{ name: 'Kinkakuji', lat: null, lng: null }] },
      { category: 'food', items: [{ name: 'Ramen Alley', lat: null, lng: null }] },
    ];
    db.prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('kyoto', JSON.stringify(existingCategories));

    const newCategories = [
      { category: 'culture', items: [{ name: 'Nijo Castle', lat: 35.0, lng: 135.7 }] },
      { category: 'nightlife', items: [{ name: 'Pontocho Alley', lat: 35.0, lng: 135.7 }] },
    ];
    mockDiscoverDestination.mockImplementation(async (dest, existingTitles, onCategory) => {
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
    // Only the NEW items are streamed, not the pre-existing cached ones
    expect(categoryEvents.find((e) => e.category === 'culture').items.map((i) => i.name)).toEqual(['Nijo Castle']);

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.append).toBe(true);

    const row = db.prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('kyoto');
    const merged = JSON.parse(row.result_json);
    const cultureCat = merged.find((c) => c.category === 'culture');
    expect(cultureCat.items.map((i) => i.name)).toEqual(['Kinkakuji', 'Nijo Castle']);
    const nightlifeCat = merged.find((c) => c.category === 'nightlife');
    expect(nightlifeCat.items.map((i) => i.name)).toEqual(['Pontocho Alley']);
    // Untouched category still present
    const foodCat = merged.find((c) => c.category === 'food');
    expect(foodCat.items.map((i) => i.name)).toEqual(['Ramen Alley']);
  });

  it('never removes existing cached items even when the new batch is empty', async () => {
    const db = getDb();
    const existingCategories = [
      { category: 'culture', items: [{ name: 'Kinkakuji', lat: null, lng: null }] },
    ];
    db.prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('kobe', JSON.stringify(existingCategories));

    mockDiscoverDestination.mockImplementation(async () => []);

    const { error } = await callDiscover({ destination: 'Kobe', more: true });

    expect(error).toBeUndefined();
    const row = db.prepare('SELECT * FROM global_discovery_cache WHERE destination = ?').get('kobe');
    const merged = JSON.parse(row.result_json);
    expect(merged.find((c) => c.category === 'culture').items.map((i) => i.name)).toEqual(['Kinkakuji']);
  });
});
