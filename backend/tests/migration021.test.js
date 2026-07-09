import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

// Plan 8 Wave 6: exercises 021_canonicalize_discovery_keys.js against a fixture DB
// seeded with every pollution shape found in the 2026-07-09 owner-reviewed production
// inventory, plus rows that must survive untouched.

let tmpDir;

function insertDestination(db, { cityKey, countryCode, displayName, placesCount = 1, dailyCount = 1 }) {
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO discovery_destinations (city_key, country_code, display_name, last_generated_at, generation_count)
     VALUES (?, ?, ?, datetime('now'), 1)`,
  ).run(cityKey, countryCode, displayName);

  for (let i = 0; i < placesCount; i += 1) {
    db.prepare(
      `INSERT INTO discovery_places
         (destination_id, category, name, normalized_name, aliases_json, description, provenance, status, batch, generated_at)
       VALUES (?, 'sight', ?, ?, '[]', 'test place', 'unverified', 'active', 0, datetime('now'))`,
    ).run(id, `${displayName} place ${i}`, `${cityKey}-place-${i}`);
  }

  for (let i = 0; i < dailyCount; i += 1) {
    db.prepare(
      `INSERT INTO discovery_generation_daily (destination_id, utc_date, count) VALUES (?, ?, 1)`,
    ).run(id, `2026-07-0${i + 1}`);
  }

  return Number(id);
}

function countChildren(db, destinationId) {
  const places = db.prepare('SELECT COUNT(*) c FROM discovery_places WHERE destination_id = ?').get(destinationId).c;
  const daily = db.prepare('SELECT COUNT(*) c FROM discovery_generation_daily WHERE destination_id = ?').get(destinationId).c;
  return { places, daily };
}

function getDestination(db, cityKey, countryCode) {
  return db.prepare(
    'SELECT * FROM discovery_destinations WHERE city_key = ? AND country_code = ?',
  ).get(cityKey, countryCode);
}

describe('021_canonicalize_discovery_keys — no MY twin exists (stamp path)', () => {
  let ids;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-021a-'));
    initDb(join(tmpDir, 'test.db'));
    await runMigrations();
    // Migrations 021/022 already ran against this fresh DB (idempotent no-ops).
    // Now seed pollution rows directly and re-run 021 in isolation via runMigrations()
    // is not possible (already recorded) — instead call the migration's up() directly.
    const db = getDb();

    ids = {};
    // Rule 1: un-normalized key — city_key doesn't fold from display_name.
    ids.staleKey = insertDestination(db, {
      cityKey: 'staleoldkey',
      countryCode: 'XX',
      displayName: 'Totally Different City',
    });
    // Rule 2: reviewed fragment row.
    ids.fragment = insertDestination(db, {
      cityKey: 'kabupatenbadung',
      countryCode: 'ID',
      displayName: 'Kabupaten Badung',
    });
    // Rule 3: empty-country twins.
    ids.chengduEmpty = insertDestination(db, {
      cityKey: 'chengdu',
      countryCode: '',
      displayName: 'Chengdu',
    });
    ids.chengduCN = insertDestination(db, {
      cityKey: 'chengdu',
      countryCode: 'CN',
      displayName: 'Chengdu',
    });
    // Rule 4: Kuala Lumpur, no MY twin — gets stamped.
    ids.klEmpty = insertDestination(db, {
      cityKey: 'kualalumpur',
      countryCode: '',
      displayName: 'Kuala Lumpur',
    });
    // Untouched: clean rows.
    ids.bali = insertDestination(db, { cityKey: 'bali', countryCode: 'ID', displayName: 'Bali' });
    ids.taipei = insertDestination(db, { cityKey: 'taipei', countryCode: 'TW', displayName: 'Taipei' });
    ids.beijing = insertDestination(db, { cityKey: '北京', countryCode: '', displayName: '北京' });

    const mod = await import('../src/db/migrations/021_canonicalize_discovery_keys.js');
    mod.up(db);
  });

  afterAll(() => {
    getDb().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes the un-normalized-key row and its children', () => {
    const db = getDb();
    expect(db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(ids.staleKey)).toBeUndefined();
    expect(countChildren(db, ids.staleKey)).toEqual({ places: 0, daily: 0 });
  });

  it('deletes the reviewed fragment row (kabupatenbadung|ID) and its children', () => {
    const db = getDb();
    expect(getDestination(db, 'kabupatenbadung', 'ID')).toBeUndefined();
    expect(countChildren(db, ids.fragment)).toEqual({ places: 0, daily: 0 });
  });

  it('deletes the empty-country chengdu twin, keeps chengdu|CN', () => {
    const db = getDb();
    expect(getDestination(db, 'chengdu', '')).toBeUndefined();
    expect(countChildren(db, ids.chengduEmpty)).toEqual({ places: 0, daily: 0 });

    const cn = getDestination(db, 'chengdu', 'CN');
    expect(cn).toBeTruthy();
    expect(cn.id).toBe(ids.chengduCN);
    expect(countChildren(db, ids.chengduCN)).toEqual({ places: 1, daily: 1 });
  });

  it('stamps kualalumpur empty-country row to MY (no prior MY twin)', () => {
    const db = getDb();
    expect(getDestination(db, 'kualalumpur', '')).toBeUndefined();
    const my = getDestination(db, 'kualalumpur', 'MY');
    expect(my).toBeTruthy();
    expect(my.id).toBe(ids.klEmpty);
    // Children preserved — this row was updated in place, not deleted+recreated.
    expect(countChildren(db, ids.klEmpty)).toEqual({ places: 1, daily: 1 });
  });

  it('leaves clean rows (bali|ID, taipei|TW, 北京|"") untouched', () => {
    const db = getDb();
    expect(getDestination(db, 'bali', 'ID')).toBeTruthy();
    expect(getDestination(db, 'taipei', 'TW')).toBeTruthy();
    expect(getDestination(db, '北京', '')).toBeTruthy();
    expect(countChildren(db, ids.bali)).toEqual({ places: 1, daily: 1 });
    expect(countChildren(db, ids.taipei)).toEqual({ places: 1, daily: 1 });
    expect(countChildren(db, ids.beijing)).toEqual({ places: 1, daily: 1 });
  });

  it('is idempotent: running up(db) again changes nothing', async () => {
    const db = getDb();
    const before = {
      destinations: db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c,
      places: db.prepare('SELECT COUNT(*) c FROM discovery_places').get().c,
      daily: db.prepare('SELECT COUNT(*) c FROM discovery_generation_daily').get().c,
      klRow: getDestination(db, 'kualalumpur', 'MY'),
    };

    const mod = await import('../src/db/migrations/021_canonicalize_discovery_keys.js');
    mod.up(db);

    const after = {
      destinations: db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c,
      places: db.prepare('SELECT COUNT(*) c FROM discovery_places').get().c,
      daily: db.prepare('SELECT COUNT(*) c FROM discovery_generation_daily').get().c,
      klRow: getDestination(db, 'kualalumpur', 'MY'),
    };

    expect(after.destinations).toBe(before.destinations);
    expect(after.places).toBe(before.places);
    expect(after.daily).toBe(before.daily);
    expect(after.klRow.id).toBe(before.klRow.id);
    expect(after.klRow.country_code).toBe('MY');
  });
});

describe('021_canonicalize_discovery_keys — MY twin already exists (delete path)', () => {
  let ids;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-021b-'));
    initDb(join(tmpDir, 'test.db'));
    await runMigrations();
    const db = getDb();

    ids = {};
    ids.klEmpty = insertDestination(db, { cityKey: 'kualalumpur', countryCode: '', displayName: 'Kuala Lumpur' });
    ids.klMY = insertDestination(db, { cityKey: 'kualalumpur', countryCode: 'MY', displayName: 'Kuala Lumpur' });

    const mod = await import('../src/db/migrations/021_canonicalize_discovery_keys.js');
    mod.up(db);
  });

  afterAll(() => {
    getDb().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes the empty-country row and keeps the existing MY row', () => {
    const db = getDb();
    expect(getDestination(db, 'kualalumpur', '')).toBeUndefined();
    expect(countChildren(db, ids.klEmpty)).toEqual({ places: 0, daily: 0 });

    const my = getDestination(db, 'kualalumpur', 'MY');
    expect(my).toBeTruthy();
    expect(my.id).toBe(ids.klMY);
    expect(countChildren(db, ids.klMY)).toEqual({ places: 1, daily: 1 });
  });

  it('is idempotent: running up(db) again changes nothing', async () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c;

    const mod = await import('../src/db/migrations/021_canonicalize_discovery_keys.js');
    mod.up(db);

    const after = db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c;
    expect(after).toBe(before);
  });
});
