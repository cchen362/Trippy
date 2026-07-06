import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  getOrCreateDestination,
  listActivePlaces,
  insertPlaces,
  listExclusionNames,
} from '../src/db/discoveryCatalogue.js';

let tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-catalogue-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM discovery_places').run();
  db.prepare('DELETE FROM discovery_destinations').run();
});

describe('getOrCreateDestination', () => {
  it('creates a new destination row on first call', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'kyoto', countryCode: 'JP', displayName: 'Kyoto' });

    expect(dest.id).toBeDefined();
    expect(dest.city_key).toBe('kyoto');
    expect(dest.country_code).toBe('JP');
    expect(dest.display_name).toBe('Kyoto');
    expect(dest.generation_count).toBe(0);
  });

  it('returns the same row on subsequent calls with the same key', () => {
    const db = getDb();
    const first = getOrCreateDestination(db, { cityKey: 'osaka', countryCode: 'JP', displayName: 'Osaka' });
    const second = getOrCreateDestination(db, { cityKey: 'osaka', countryCode: 'JP', displayName: 'Osaka' });

    expect(second.id).toBe(first.id);
  });

  it('treats (city, "") and (city, "CN") as distinct destinations', () => {
    const db = getDb();
    const unknownCountry = getOrCreateDestination(db, { cityKey: 'chengdu', countryCode: '', displayName: 'Chengdu' });
    const knownCountry = getOrCreateDestination(db, { cityKey: 'chengdu', countryCode: 'CN', displayName: 'Chengdu' });

    expect(unknownCountry.id).not.toBe(knownCountry.id);

    const rows = db.prepare('SELECT * FROM discovery_destinations WHERE city_key = ?').all('chengdu');
    expect(rows).toHaveLength(2);
  });

  it('defaults a missing countryCode to the empty-string bucket', () => {
    const db = getDb();
    const created = getOrCreateDestination(db, { cityKey: 'nara', countryCode: undefined, displayName: 'Nara' });
    expect(created.country_code).toBe('');

    const refetched = getOrCreateDestination(db, { cityKey: 'nara', countryCode: '', displayName: 'Nara' });
    expect(refetched.id).toBe(created.id);
  });
});

describe('insertPlaces', () => {
  function makeItem(overrides = {}) {
    return {
      category: 'culture',
      name: 'Kinkakuji',
      description: 'A gold-leafed Zen temple beside a reflecting pond.',
      whyItFits: 'Quiet at opening, mobbed by mid-morning tour buses.',
      estimatedDuration: '1 hour',
      openingHours: '9:00-17:00',
      localName: '金閣寺',
      aliases: ['Golden Pavilion'],
      lat: 35.03,
      lng: 135.73,
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('creates categories on first insert and returns inserted rows', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'kyoto', countryCode: 'JP', displayName: 'Kyoto' });

    const inserted = insertPlaces(db, dest.id, [makeItem()], 0);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].category).toBe('culture');
    expect(inserted[0].name).toBe('Kinkakuji');

    const stored = listActivePlaces(db, dest.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('active');
    expect(stored[0].provenance).toBe('unverified');
  });

  it('never stores non-null lat/lng even when provided by the caller', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'kyoto', countryCode: 'JP', displayName: 'Kyoto' });

    const inserted = insertPlaces(db, dest.id, [makeItem({ lat: 35.03, lng: 135.73 })], 0);

    expect(inserted[0].lat).toBeNull();
    expect(inserted[0].lng).toBeNull();
  });

  it('dedupes by normalized name within the same destination', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'kyoto', countryCode: 'JP', displayName: 'Kyoto' });

    insertPlaces(db, dest.id, [makeItem({ name: 'Dujiangyan Scenic Area' })], 0);
    const secondBatch = insertPlaces(db, dest.id, [makeItem({ name: 'Dujiangyan & Scenic Area' })], 1);

    // Second call normalizes to the same key as the first — skipped, not inserted.
    expect(secondBatch).toHaveLength(0);
    const stored = listActivePlaces(db, dest.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Dujiangyan Scenic Area');
  });

  it('does not dedupe the same place name across distinct destinations', () => {
    const db = getDb();
    const kyoto = getOrCreateDestination(db, { cityKey: 'kyoto', countryCode: 'JP', displayName: 'Kyoto' });
    const osaka = getOrCreateDestination(db, { cityKey: 'osaka', countryCode: 'JP', displayName: 'Osaka' });

    insertPlaces(db, kyoto.id, [makeItem({ name: 'Central Park' })], 0);
    const osakaInserted = insertPlaces(db, osaka.id, [makeItem({ name: 'Central Park' })], 0);

    expect(osakaInserted).toHaveLength(1);
    expect(listActivePlaces(db, kyoto.id)).toHaveLength(1);
    expect(listActivePlaces(db, osaka.id)).toHaveLength(1);
  });

  it('never removes existing items — insertPlaces only adds', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'kobe', countryCode: 'JP', displayName: 'Kobe' });

    insertPlaces(db, dest.id, [makeItem({ name: 'Kinkakuji' })], 0);
    insertPlaces(db, dest.id, [], 1); // empty batch — nothing to add
    insertPlaces(db, dest.id, [makeItem({ name: 'Nijo Castle' })], 1);

    const stored = listActivePlaces(db, dest.id);
    expect(stored.map((r) => r.name).sort()).toEqual(['Kinkakuji', 'Nijo Castle']);
  });

  it('stamps the batch number passed in on every inserted row', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'nagoya', countryCode: 'JP', displayName: 'Nagoya' });

    const batch0 = insertPlaces(db, dest.id, [makeItem({ name: 'First Batch Spot' })], 0);
    const batch1 = insertPlaces(db, dest.id, [makeItem({ name: 'Second Batch Spot' })], 1);

    expect(batch0[0].batch).toBe(0);
    expect(batch1[0].batch).toBe(1);
  });

  it('stamps generatedAt from the item, defaulting to now when absent', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'sendai', countryCode: 'JP', displayName: 'Sendai' });

    const explicit = insertPlaces(db, dest.id, [makeItem({ name: 'Stamped Spot', generatedAt: '2020-05-05T00:00:00.000Z' })], 0);
    expect(explicit[0].generated_at).toBe('2020-05-05T00:00:00.000Z');

    const before = Date.now();
    const defaulted = insertPlaces(db, dest.id, [makeItem({ name: 'Unstamped Spot', generatedAt: undefined })], 0);
    const after = Date.now();
    const stampMs = new Date(defaulted[0].generated_at).getTime();
    expect(stampMs).toBeGreaterThanOrEqual(before);
    expect(stampMs).toBeLessThanOrEqual(after);
  });

  it('handles null/empty aliases and a null localName', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'sapporo', countryCode: 'JP', displayName: 'Sapporo' });

    const inserted = insertPlaces(db, dest.id, [makeItem({
      name: 'Odori Park', localName: null, aliases: undefined,
    })], 0);

    expect(inserted[0].local_name).toBeNull();
    expect(JSON.parse(inserted[0].aliases_json)).toEqual([]);
  });
});

describe('listExclusionNames', () => {
  it('returns names for a destination, most-recent first, capped at the given limit', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'hiroshima', countryCode: 'JP', displayName: 'Hiroshima' });

    insertPlaces(db, dest.id, [
      { category: 'culture', name: 'Spot A', description: 'x' },
      { category: 'culture', name: 'Spot B', description: 'x' },
      { category: 'culture', name: 'Spot C', description: 'x' },
    ], 0);

    const capped = listExclusionNames(db, dest.id, 2);
    expect(capped).toHaveLength(2);
    // Most recently inserted (highest id) first.
    expect(capped).toEqual(['Spot C', 'Spot B']);

    const uncapped = listExclusionNames(db, dest.id);
    expect(uncapped).toHaveLength(3);
  });

  it('returns an empty array for a destination with no places', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'fukuoka', countryCode: 'JP', displayName: 'Fukuoka' });

    expect(listExclusionNames(db, dest.id)).toEqual([]);
  });

  it('includes archived rows alongside active ones', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'sendai2', countryCode: 'JP', displayName: 'Sendai 2' });
    insertPlaces(db, dest.id, [{ category: 'food', name: 'Active Spot', description: 'x' }], 0);
    db.prepare(`
      INSERT INTO discovery_places (destination_id, category, name, normalized_name, description, status, generated_at)
      VALUES (?, 'food', 'Archived Spot', 'archived spot', 'x', 'archived', datetime('now'))
    `).run(dest.id);

    const names = listExclusionNames(db, dest.id, 400);
    expect(names).toEqual(expect.arrayContaining(['Active Spot', 'Archived Spot']));
  });
});

// ---------------------------------------------------------------------------
// listActivePlaces — status filtering and ordering
// ---------------------------------------------------------------------------

describe('listActivePlaces', () => {
  it('excludes suppressed/archived rows', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'nagasaki2', countryCode: 'JP', displayName: 'Nagasaki 2' });
    insertPlaces(db, dest.id, [{ category: 'food', name: 'Visible Place', description: 'd' }], 0);
    db.prepare(`
      INSERT INTO discovery_places (destination_id, category, name, normalized_name, description, status, generated_at)
      VALUES (?, 'food', 'Hidden Place', 'hidden place', 'd', 'suppressed', datetime('now'))
    `).run(dest.id);

    const rows = listActivePlaces(db, dest.id);
    expect(rows.map((r) => r.name)).toEqual(['Visible Place']);
  });

  it('orders by category then insertion (id) order', () => {
    const db = getDb();
    const dest = getOrCreateDestination(db, { cityKey: 'matsuyama', countryCode: 'JP', displayName: 'Matsuyama' });
    insertPlaces(db, dest.id, [
      { category: 'food', name: 'Zeta Diner', description: 'd' },
      { category: 'culture', name: 'Alpha Museum', description: 'd' },
      { category: 'food', name: 'Alpha Diner', description: 'd' },
    ], 0);

    const rows = listActivePlaces(db, dest.id);
    expect(rows.map((r) => `${r.category}:${r.name}`)).toEqual([
      'culture:Alpha Museum',
      'food:Zeta Diner',
      'food:Alpha Diner',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Migration 016 — idempotence and backfill parity
// ---------------------------------------------------------------------------

describe('016 migration — idempotence and backfill parity', () => {
  it('running migrations twice does not error or duplicate discovery_destinations/discovery_places rows', async () => {
    const db = getDb();
    const destBefore = db.prepare('SELECT COUNT(*) as c FROM discovery_destinations').get().c;
    const placesBefore = db.prepare('SELECT COUNT(*) as c FROM discovery_places').get().c;

    await expect(runMigrations()).resolves.not.toThrow();

    const destAfter = db.prepare('SELECT COUNT(*) as c FROM discovery_destinations').get().c;
    const placesAfter = db.prepare('SELECT COUNT(*) as c FROM discovery_places').get().c;
    expect(destAfter).toBe(destBefore);
    expect(placesAfter).toBe(placesBefore);
  });

  it('backfill produces exactly one discovery_places row per blob item, mapped field-for-field', () => {
    // Simulates what migration 016's backfill does: seed a fixture blob (as a
    // pre-016 production row would look), flatten it the same way the
    // migration does, and verify item-count parity plus correct field mapping
    // (whyItFits -> why_go, localName -> local_name, aliases -> aliases_json,
    // lat/lng forced null even when present in the source blob).
    const db = getDb();

    const blobCategories = [
      {
        category: 'culture',
        items: [
          {
            name: 'Fushimi Inari', description: 'Iconic torii gates.',
            whyItFits: 'Photogenic at dawn.', estimatedDuration: '2h', openingHours: '24/7',
            localName: '伏見稲荷大社', aliases: ['Fushimi Inari Taisha'],
            lat: 34.97, lng: 135.77, generatedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
      {
        category: 'food',
        items: [
          { name: 'Nishiki Market', description: 'Covered food market.', whyItFits: null, estimatedDuration: '1h', openingHours: '9am-6pm' },
        ],
      },
    ];

    db.prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, datetime('now'))`,
    ).run('backfilltestcity', JSON.stringify(blobCategories));

    const dest = getOrCreateDestination(db, { cityKey: 'backfilltestcity', countryCode: '', displayName: 'backfilltestcity' });
    const flatItems = blobCategories.flatMap((cat) =>
      cat.items.map((item) => ({
        category: cat.category,
        name: item.name,
        description: item.description,
        whyItFits: item.whyItFits,
        estimatedDuration: item.estimatedDuration,
        openingHours: item.openingHours,
        localName: item.localName ?? null,
        aliases: item.aliases ?? [],
        lat: null,
        lng: null,
        generatedAt: item.generatedAt ?? '2025-06-01 00:00:00',
      })),
    );
    const inserted = insertPlaces(db, dest.id, flatItems, 0);

    const blobItemCount = blobCategories.reduce((sum, cat) => sum + cat.items.length, 0);
    expect(inserted).toHaveLength(blobItemCount);

    const rows = listActivePlaces(db, dest.id);
    expect(rows).toHaveLength(blobItemCount);

    const fushimi = rows.find((r) => r.name === 'Fushimi Inari');
    expect(fushimi.why_go).toBe('Photogenic at dawn.');
    expect(fushimi.local_name).toBe('伏見稲荷大社');
    expect(JSON.parse(fushimi.aliases_json)).toEqual(['Fushimi Inari Taisha']);
    expect(fushimi.lat).toBeNull();
    expect(fushimi.lng).toBeNull();
    expect(fushimi.generated_at).toBe('2025-01-01T00:00:00.000Z');

    const nishiki = rows.find((r) => r.name === 'Nishiki Market');
    expect(nishiki.why_go).toBeNull();
    expect(nishiki.local_name).toBeNull();
    expect(JSON.parse(nishiki.aliases_json)).toEqual([]);
  });

  it('the real migration backfill preserves the old row\'s fetched_at as last_generated_at, so a destination cached moments before the migration is not immediately treated as stale', async () => {
    const db = getDb();
    const { up } = await import('../src/db/migrations/016_discovery_catalogue.js');

    db.prepare(
      `INSERT INTO global_discovery_cache (destination, result_json, fetched_at) VALUES (?, ?, ?)`,
    ).run('freshnesstestcity', JSON.stringify([
      { category: 'culture', items: [{ name: 'Some Temple', description: 'd', whyItFits: 'w', estimatedDuration: '1h', openingHours: '9-5' }] },
    ]), '2026-07-06 12:00:00');

    up(db);

    const dest = db.prepare(
      'SELECT * FROM discovery_destinations WHERE city_key = ?',
    ).get('freshnesstestcity');

    expect(dest.last_generated_at).toBe('2026-07-06 12:00:00');
    expect(dest.generation_count).toBe(1);
  });
});
