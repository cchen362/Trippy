import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock claude.js (discoveryCatalogue.js imports normalizeName/coerceSceneType
// from it at module load time) — mirrors discovery.test.js's fakes closely enough,
// the real behavior is covered there and in claude.test.js.
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
  discoverDestination: vi.fn(),
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

// --- Mock the place resolver (trips.js transitively imports it) so no real
// network call ever happens during these tests. vi.hoisted is required because
// vi.mock factories run before this file's own top-level const declarations.
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
import { searchDiscoveryCatalogue } from '../src/services/copilotGrounding.js';

let tmpDir;
let userId;
let tripId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-copilot-grounding-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  const result = authService.setup('admin', 'password123', 'Admin');
  userId = result.user.id;

  const trip = tripService.createTrip(userId, {
    title: 'Shanghai Loop',
    startDate: '2026-06-01',
    endDate: '2026-06-07',
    destinations: ['Shanghai'],
    destinationCountries: ['CN'],
    interestTags: ['culture', 'food & drink'],
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
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
  getDb().prepare('DELETE FROM discovery_generation_daily').run();
  getDb().prepare('DELETE FROM days WHERE trip_id = ?').run(tripId);
});

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function staleSql(daysAgo = 8) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function seedDestination({ cityKey, countryCode = '', displayName, lastGeneratedAt = nowSql(), generationCount = 1 }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discovery_destinations (city_key, country_code, display_name, last_generated_at, generation_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(cityKey, countryCode, displayName, lastGeneratedAt, generationCount);
  return db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?').get(cityKey, countryCode);
}

function seedPlace(destinationId, {
  category, name, description = `${name} description`, localName = null, aliases = [],
  whyGo = null, estimatedDuration = null, provenance = 'unverified', batch = 0,
  generatedAt = new Date().toISOString(), status = 'active',
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO discovery_places (
      destination_id, category, name, normalized_name, local_name, aliases_json,
      description, why_go, estimated_duration, provenance, status, batch, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    destinationId, category, name, normalizeName(name), localName, JSON.stringify(aliases),
    description, whyGo, estimatedDuration, provenance, status, batch, generatedAt,
  );
  return db.prepare('SELECT * FROM discovery_places WHERE destination_id = ? AND name = ?').get(destinationId, name);
}

function insertDay(city, { date = '2026-06-02', id } = {}) {
  const db = getDb();
  const dayId = id || `day-${city}-${date}`;
  db.prepare(`INSERT INTO days (id, trip_id, date, city) VALUES (?, ?, ?, ?)`).run(dayId, tripId, date, city);
  return dayId;
}

async function detail() {
  return tripService.getTripDetail(tripId, userId);
}

describe('searchDiscoveryCatalogue', () => {
  it('returns fresh state with places for an in-scope, freshly generated destination', async () => {
    const dest = seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'culture', name: 'Yu Garden' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai' });

    expect(result.catalogueState).toBe('fresh');
    expect(result.places).toHaveLength(1);
    expect(result.places[0].name).toBe('Yu Garden');
  });

  it('returns stale state (places still returned) when last_generated_at is 8+ days old', async () => {
    const dest = seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai', lastGeneratedAt: staleSql(8) });
    seedPlace(dest.id, { category: 'culture', name: 'The Bund' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai' });

    expect(result.catalogueState).toBe('stale');
    expect(result.places.map((p) => p.name)).toEqual(['The Bund']);
  });

  it('returns empty when no destination row exists for an in-scope destination', async () => {
    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai' });

    expect(result).toEqual({ catalogueState: 'empty', places: [] });
  });

  it('returns empty when a destination row exists but has zero active places', async () => {
    seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai' });

    expect(result).toEqual({ catalogueState: 'empty', places: [] });
  });

  it('resolves an admin-suffix near match (day-derived "Kaohsiung City" scope vs searched "Kaohsiung")', async () => {
    insertDay('Kaohsiung City');
    const dest = seedDestination({ cityKey: 'kaohsiungcity', countryCode: '', displayName: 'Kaohsiung City', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'culture', name: 'Pier-2 Art Center' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Kaohsiung' });

    expect(result.catalogueState).toBe('fresh');
    expect(result.places.map((p) => p.name)).toEqual(['Pier-2 Art Center']);
  });

  it('adopts the single existing country-coded row when the matched scope has no countryCode', async () => {
    // Day-derived scope (no stored trip_scopes row) — buildTripScopes drops countryCode
    // for these, so the resolver falls back to the D6 single-country-coded-row idiom.
    insertDay('Chengdu');
    const dest = seedDestination({ cityKey: 'chengdu', countryCode: 'CN', displayName: 'Chengdu', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'food', name: 'Kuanzhai Alley' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Chengdu' });

    expect(result.catalogueState).toBe('fresh');
    expect(result.places.map((p) => p.name)).toEqual(['Kuanzhai Alley']);
  });

  it('does NOT adopt a country-coded row when two exist for the same city key (empty state)', async () => {
    insertDay('Chengdu');
    const cn = seedDestination({ cityKey: 'chengdu', countryCode: 'CN', displayName: 'Chengdu', lastGeneratedAt: nowSql() });
    seedPlace(cn.id, { category: 'food', name: 'Kuanzhai Alley' });
    const tw = seedDestination({ cityKey: 'chengdu', countryCode: 'TW', displayName: 'Chengdu (TW)', lastGeneratedAt: nowSql() });
    seedPlace(tw.id, { category: 'food', name: 'Some Other Spot' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Chengdu' });

    expect(result).toEqual({ catalogueState: 'empty', places: [] });
  });

  it('returns out_of_scope for a destination not on the trip, and creates no catalogue row', async () => {
    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Suzhou' });

    expect(result).toEqual({ catalogueState: 'out_of_scope', places: [] });
    const row = getDb().prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').get('suzhou');
    expect(row).toBeUndefined();
  });

  describe('filtering', () => {
    async function seedFilterFixture() {
      const dest = seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai', lastGeneratedAt: nowSql() });
      seedPlace(dest.id, { category: 'food', name: 'Din Tai Fung', description: 'Famous soup dumplings for dinner.' });
      seedPlace(dest.id, { category: 'food', name: 'Xintiandi Bar', localName: '新天地', aliases: ['Rooftop Lounge'], description: 'A lively night spot.' });
      seedPlace(dest.id, { category: 'culture', name: 'Shanghai Museum', description: 'Bronze and ceramics collection.' });
      return dest;
    }

    it('matches query against name (case-insensitive)', async () => {
      await seedFilterFixture();
      const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', query: 'din tai' });
      expect(result.places.map((p) => p.name)).toEqual(['Din Tai Fung']);
    });

    it('matches query against local name and aliases (case-insensitive)', async () => {
      await seedFilterFixture();
      const byLocalName = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', query: '新天地' });
      expect(byLocalName.places.map((p) => p.name)).toEqual(['Xintiandi Bar']);

      const byAlias = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', query: 'rooftop' });
      expect(byAlias.places.map((p) => p.name)).toEqual(['Xintiandi Bar']);
    });

    it('matches query against description', async () => {
      await seedFilterFixture();
      const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', query: 'dumplings' });
      expect(result.places.map((p) => p.name)).toEqual(['Din Tai Fung']);
    });

    it('matches query against why_go (meal/occasion language lives there)', async () => {
      const dest = seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai', lastGeneratedAt: nowSql() });
      seedPlace(dest.id, { category: 'food', name: 'Lane House Kitchen', description: 'Shikumen-lane Shanghainese restaurant.', whyGo: 'A proper sit-down dinner without the tourist queue.' });
      seedPlace(dest.id, { category: 'food', name: 'Morning Bun Stand', description: 'Shengjianbao street stall.', whyGo: 'Breakfast the local way.' });

      const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', query: 'dinner' });
      expect(result.places.map((p) => p.name)).toEqual(['Lane House Kitchen']);
    });

    it('filters by exact category', async () => {
      await seedFilterFixture();
      const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', category: 'culture' });
      expect(result.places.map((p) => p.name)).toEqual(['Shanghai Museum']);
    });

    it('combines category and query filters', async () => {
      await seedFilterFixture();
      const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai', category: 'food', query: 'bar' });
      expect(result.places.map((p) => p.name)).toEqual(['Xintiandi Bar']);
    });
  });

  it('caps results at 8 when more than 8 places match', async () => {
    const dest = seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai', lastGeneratedAt: nowSql() });
    for (let i = 0; i < 10; i += 1) {
      seedPlace(dest.id, { category: 'culture', name: `Spot ${i}` });
    }

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai' });

    expect(result.catalogueState).toBe('fresh');
    expect(result.places).toHaveLength(8);
  });

  it('returns the exact compact shape with no lat/lng fields', async () => {
    const dest = seedDestination({ cityKey: 'shanghai', countryCode: 'CN', displayName: 'Shanghai', lastGeneratedAt: nowSql() });
    seedPlace(dest.id, { category: 'culture', name: 'Yu Garden' });

    const result = await searchDiscoveryCatalogue(await detail(), { destination: 'Shanghai' });

    const place = result.places[0];
    expect(Object.keys(place).sort()).toEqual(
      ['category', 'description', 'duration', 'fitLine', 'name', 'openingHours', 'placeId', 'provenance', 'whyGo'].sort(),
    );
    expect(place).not.toHaveProperty('lat');
    expect(place).not.toHaveProperty('lng');
  });
});
