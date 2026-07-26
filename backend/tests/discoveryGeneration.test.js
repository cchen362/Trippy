import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock claude.js before importing the module under test — mirrors
// discovery.test.js's fakes closely enough (real dedupe/scene-type behavior is
// covered separately by discoveryCatalogue.test.js and claude.test.js).
// vi.hoisted is required (not a plain top-level const) because vi.mock
// factories run before this file's own import statements execute.
const { mockDiscoverDestination } = vi.hoisted(() => ({
  mockDiscoverDestination: vi.fn(),
}));

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
// enqueued after every insert never makes a real network call.
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
import { getOrCreateDestination, getDailyGenerationCount } from '../src/db/discoveryCatalogue.js';
import { __resetDiscoveryVerifyForTests, waitForVerificationDrain } from '../src/services/discoveryVerify.js';
import { runCatalogueGeneration } from '../src/services/discoveryGeneration.js';

let tmpDir;

const FAKE_CATEGORIES = [
  { category: 'culture', items: [{ name: 'Fushimi Inari', description: 'A mountain shrine famous for its endless vermillion torii gates.' }] },
  { category: 'food', items: [{ name: 'Ramen Alley', description: 'A narrow alley of ramen counters.' }] },
];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-generation-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
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
});

function makeDestination(overrides = {}) {
  const db = getDb();
  return getOrCreateDestination(db, {
    cityKey: 'kyoto',
    countryCode: 'JP',
    displayName: 'Kyoto',
    ...overrides,
  });
}

describe('runCatalogueGeneration', () => {
  it('inserts flattened items with the destination\'s current generation_count as batch', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination();
    expect(destinationRow.generation_count).toBe(0);

    const { inserted, insertedIds } = await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'kyoto, Japan (JP)',
      useExclusions: false,
    });

    expect(inserted).toHaveLength(2);
    expect(insertedIds).toHaveLength(2);
    const rows = db.prepare('SELECT * FROM discovery_places WHERE destination_id = ? ORDER BY id').all(destinationRow.id);
    expect(rows.map((r) => r.name)).toEqual(['Fushimi Inari', 'Ramen Alley']);
    expect(rows.every((r) => r.batch === 0)).toBe(true);
    expect(rows.every((r) => r.category)).toBeTruthy();
    expect(rows.find((r) => r.name === 'Fushimi Inari').category).toBe('culture');
    expect(rows.find((r) => r.name === 'Ramen Alley').category).toBe('food');
  });

  it('uses the batch number from a destination that has already generated before', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    let destinationRow = makeDestination({ cityKey: 'osaka' });
    // Simulate a prior generation having already bumped generation_count.
    db.prepare('UPDATE discovery_destinations SET generation_count = 2 WHERE id = ?').run(destinationRow.id);
    destinationRow = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationRow.id);

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'osaka, Japan (JP)',
      useExclusions: false,
    });

    const rows = db.prepare('SELECT * FROM discovery_places WHERE destination_id = ?').all(destinationRow.id);
    expect(rows.every((r) => r.batch === 2)).toBe(true);
  });

  // Pre-W1 behaviour: fresh inserts were stamped 'unverified' and
  // enforceCategoryCap ranked ALL unverified rows worst-first (brand-new ones
  // included) and archived surplus immediately — a newly generated row could
  // be archived before it was ever checked (F-26-3, the 78-row
  // archived+unverified population this plan repairs). W1.2 fixes the root
  // cause: fresh inserts are now stamped 'pending' (contract: "never
  // checked" vs. terminal 'unverified' = "checked and failed"), and the cap
  // exempts 'pending' rows from archiving entirely until they've had a real
  // verification attempt. With all 50 rows here still pending, none are
  // archived — the cap simply doesn't apply yet, which is the intended fix.
  it('does not archive never-checked (pending) rows even when a category exceeds the cap (W1.2)', async () => {
    const manyItems = Array.from({ length: 50 }, (_, i) => ({ name: `Spot ${i}`, description: 'd' }));
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      const cats = [{ category: 'culture', items: manyItems }];
      cats.forEach((cat) => onCategory(cat));
      return cats;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'nara' });

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'nara, Japan (JP)',
      useExclusions: false,
    });

    const activeCount = db.prepare(
      `SELECT COUNT(*) AS c FROM discovery_places WHERE destination_id = ? AND status = 'active'`,
    ).get(destinationRow.id).c;
    expect(activeCount).toBe(50);
    const archivedCount = db.prepare(
      `SELECT COUNT(*) AS c FROM discovery_places WHERE destination_id = ? AND status = 'archived'`,
    ).get(destinationRow.id).c;
    expect(archivedCount).toBe(0);
  });

  it('enqueues the inserted ids for verification', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'kobe' });

    const { insertedIds } = await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'kobe, Japan (JP)',
      useExclusions: false,
    });

    await waitForVerificationDrain(destinationRow.id);
    expect(mockResolvePlace).toHaveBeenCalledTimes(insertedIds.length);
  });

  it('updates last_generated_at and bumps generation_count', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'nagoya' });
    expect(destinationRow.last_generated_at).toBeNull();

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'nagoya, Japan (JP)',
      useExclusions: false,
    });

    const updated = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationRow.id);
    expect(updated.last_generated_at).not.toBeNull();
    expect(updated.generation_count).toBe(1);
  });

  it('increments the daily generation counter', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'sendai' });
    expect(getDailyGenerationCount(db, destinationRow.id)).toBe(0);

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'sendai, Japan (JP)',
      useExclusions: false,
    });

    expect(getDailyGenerationCount(db, destinationRow.id)).toBe(1);
  });

  it('passes stored names as exclusions when useExclusions is true', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'fukuoka' });
    db.prepare(`
      INSERT INTO discovery_places (destination_id, category, name, normalized_name, description, provenance, status, batch, generated_at)
      VALUES (?, 'culture', 'Existing Spot', ?, 'd', 'unverified', 'active', 0, datetime('now'))
    `).run(destinationRow.id, normalizeName('Existing Spot'));

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'fukuoka, Japan (JP)',
      useExclusions: true,
    });

    expect(mockDiscoverDestination.mock.calls[0][1]).toEqual(['Existing Spot']);
  });

  it('passes an empty exclusion list when useExclusions is false, even if names are stored', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, onCategory) => {
      FAKE_CATEGORIES.forEach((cat) => onCategory(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'hiroshima' });
    db.prepare(`
      INSERT INTO discovery_places (destination_id, category, name, normalized_name, description, provenance, status, batch, generated_at)
      VALUES (?, 'culture', 'Existing Spot', ?, 'd', 'unverified', 'active', 0, datetime('now'))
    `).run(destinationRow.id, normalizeName('Existing Spot'));

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'hiroshima, Japan (JP)',
      useExclusions: false,
    });

    expect(mockDiscoverDestination.mock.calls[0][1]).toEqual([]);
  });

  // Pre-W1 behaviour: onCategory was forwarded straight through to
  // discoverDestination, so the callback it received WAS the caller's own
  // function, and it fired with raw, never-persisted Claude items (no
  // id/provenance/batch — F-26-11). Wave 1 (W1.4/Q-26-2) makes insert -> cap
  // -> enqueue run per category BEFORE the caller ever sees it, so (a) the
  // callback discoverDestination actually receives is this module's own
  // internal wrapper, not the caller's onCategory, and (b) the caller's
  // onCategory now receives the PERSISTED row (real DB id, category, name)
  // instead of the raw item. This test asserts the new contract; the old
  // identity-pass-through assertion no longer holds by design.
  it('invokes onCategory once per persisted category with real, already-inserted rows', async () => {
    const onCategory = vi.fn();
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, cb) => {
      FAKE_CATEGORIES.forEach((cat) => cb(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'sapporo' });

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'sapporo, Japan (JP)',
      useExclusions: false,
      onCategory,
    });

    expect(mockDiscoverDestination.mock.calls[0][2]).not.toBe(onCategory);
    expect(onCategory).toHaveBeenCalledTimes(FAKE_CATEGORIES.length);

    const [firstCall, secondCall] = onCategory.mock.calls.map((args) => args[0]);
    expect(firstCall.category).toBe('culture');
    expect(firstCall.inserted).toHaveLength(1);
    expect(firstCall.inserted[0]).toMatchObject({ name: 'Fushimi Inari', category: 'culture' });
    expect(typeof firstCall.inserted[0].id).toBe('number');
    expect(secondCall.category).toBe('food');
    expect(secondCall.inserted[0]).toMatchObject({ name: 'Ramen Alley', category: 'food' });
  });

  // W1.4 acceptance requirement: prove the mid-generation-throw trade-off is
  // safe. claude.js's discoverDestination() can throw AFTER some categories
  // have already reached onCategory (insufficient total yield across the
  // whole generation) — with per-category persistence, those categories are
  // already written to the DB when the throw propagates, unlike the pre-W1
  // behaviour where nothing was inserted until the whole generation
  // succeeded. That's fine as long as the catalogue is never marked "fresh"
  // by a throw — the actual harm the MIN_CATEGORIES_WITH_ITEMS guard exists
  // to prevent (a truncated generation trusted as a fresh 7-day catalogue).
  it('persists categories completed before a mid-generation throw, without marking the catalogue fresh', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, cb) => {
      cb(FAKE_CATEGORIES[0]); // 'culture' completes and is persisted...
      throw new Error('[discover] insufficient yield for destination=partialcity: 1 of 2 parsed categories had items (1 items total), 0 lines dropped as unparseable');
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'partialcity' });

    await expect(runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'partialcity, Japan (JP)',
      useExclusions: false,
    })).rejects.toThrow(/insufficient yield/);

    const rows = db.prepare('SELECT * FROM discovery_places WHERE destination_id = ?').all(destinationRow.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Fushimi Inari');
    expect(rows[0].status).toBe('active');

    const updated = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationRow.id);
    expect(updated.last_generated_at).toBeNull();
    expect(updated.generation_count).toBe(0);
    expect(getDailyGenerationCount(db, destinationRow.id)).toBe(0);
  });

  it('defaults onCategory to a no-op when omitted, without throwing', async () => {
    mockDiscoverDestination.mockImplementation(async (dest, exclusions, cb) => {
      // Exercise the callback to prove the default no-op tolerates being called.
      FAKE_CATEGORIES.forEach((cat) => cb(cat));
      return FAKE_CATEGORIES;
    });

    const db = getDb();
    const destinationRow = makeDestination({ cityKey: 'yokohama' });

    await expect(runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination: 'yokohama, Japan (JP)',
      useExclusions: false,
    })).resolves.toBeDefined();
  });
});
