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

  it('enforces the category cap after insert', async () => {
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
    expect(activeCount).toBe(45);
    const archivedCount = db.prepare(
      `SELECT COUNT(*) AS c FROM discovery_places WHERE destination_id = ? AND status = 'archived'`,
    ).get(destinationRow.id).c;
    expect(archivedCount).toBe(5);
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

  it('relays the onCategory callback to discoverDestination', async () => {
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

    expect(onCategory).toHaveBeenCalledTimes(FAKE_CATEGORIES.length);
    expect(mockDiscoverDestination.mock.calls[0][2]).toBe(onCategory);
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
