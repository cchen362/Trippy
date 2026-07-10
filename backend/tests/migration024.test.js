import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { canonicalGeoKey } from '../src/utils/geoIdentity.js';

// Plan 9 Wave 5.2: exercises 024_geo_data_repair.js against a fixture DB seeded
// with every pollution shape found in the 2026-07-10 owner-reviewed production
// inventory, plus rows that must survive untouched.

let tmpDir;
let userId;

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

function insertTrip(db, title) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO trips (title, owner_id, start_date, end_date) VALUES (?, ?, '2026-08-01', '2026-08-10')`,
  ).run(title, userId);
  // trips.id is a TEXT PK with a randomblob default — lastInsertRowid is the internal
  // rowid, not the text id, so re-select by title/owner to get the real id.
  return db.prepare('SELECT id FROM trips WHERE title = ? AND owner_id = ?').get(title, userId).id;
}

function insertDay(db, tripId, { date, city, cityCountry = null }) {
  db.prepare(
    `INSERT INTO days (trip_id, date, city, city_country) VALUES (?, ?, ?, ?)`,
  ).run(tripId, date, city, cityCountry);
  return db.prepare('SELECT id FROM days WHERE trip_id = ? AND date = ?').get(tripId, date).id;
}

function insertScope(db, tripId, { label, countryCode, canonicalKey, position = 0 }) {
  db.prepare(`
    INSERT INTO trip_scopes (trip_id, label, country_code, kind, place_id, bounds_json, source, canonical_key, position)
    VALUES (?, ?, ?, NULL, NULL, NULL, 'test-seed', ?, ?)
  `).run(tripId, label, countryCode, canonicalKey, position);
}

describe('024_geo_data_repair', () => {
  let ids = {};
  let dayIds = {};

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-024-'));
    initDb(join(tmpDir, 'test.db'));
    await runMigrations();
    const db = getDb();

    db.prepare(
      `INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ('tester', 'x', 'Tester', 0)`,
    ).run();
    userId = db.prepare('SELECT id FROM users WHERE username = ?').get('tester').id;

    // 杭州市|CN with children → deleted; hangzhou|CN survives untouched.
    ids.hangzhouCjk = insertDestination(db, { cityKey: canonicalGeoKey('杭州市'), countryCode: 'CN', displayName: '杭州市' });
    ids.hangzhouClean = insertDestination(db, { cityKey: 'hangzhou', countryCode: 'CN', displayName: 'Hangzhou' });

    // kualalumpur|'' twin + kualalumpur|MY (with children) → '' deleted, MY intact.
    ids.klEmpty = insertDestination(db, { cityKey: 'kualalumpur', countryCode: '', displayName: 'Kuala Lumpur' });
    ids.klMy = insertDestination(db, { cityKey: 'kualalumpur', countryCode: 'MY', displayName: 'Kuala Lumpur' });

    // Free-text 北京|'' with no twin → untouched.
    ids.beijing = insertDestination(db, { cityKey: '北京', countryCode: '', displayName: '北京' });

    // georgetown|MY and georgetown|GY (two candidates) → ambiguous day stays NULL.
    ids.georgetownMy = insertDestination(db, { cityKey: 'georgetown', countryCode: 'MY', displayName: 'Georgetown' });
    ids.georgetownGy = insertDestination(db, { cityKey: 'georgetown', countryCode: 'GY', displayName: 'Georgetown' });

    // Trips + days.
    const klTrip = insertTrip(db, 'KL Trip');
    dayIds.klDay = insertDay(db, klTrip, { date: '2026-08-01', city: 'Kuala Lumpur', cityCountry: null });

    const noMatchTrip = insertTrip(db, 'No Match Trip');
    dayIds.noMatchDay = insertDay(db, noMatchTrip, { date: '2026-08-01', city: 'Nowhereville', cityCountry: null });

    const ambiguousTrip = insertTrip(db, 'Ambiguous Trip');
    dayIds.ambiguousDay = insertDay(db, ambiguousTrip, { date: '2026-08-01', city: 'Georgetown', cityCountry: null });

    const scopeOnlyTrip = insertTrip(db, 'Scope Only Trip');
    dayIds.scopeOnlyDay = insertDay(db, scopeOnlyTrip, { date: '2026-08-01', city: 'Scopetown', cityCountry: null });
    insertScope(db, scopeOnlyTrip, { label: 'Scopetown', countryCode: 'FR', canonicalKey: canonicalGeoKey('Scopetown') });

    // A day that already has a stamp — must not be re-evaluated/altered (city_country IS NOT NULL guard).
    const stampedTrip = insertTrip(db, 'Already Stamped Trip');
    dayIds.stampedDay = insertDay(db, stampedTrip, { date: '2026-08-01', city: 'Kuala Lumpur', cityCountry: 'MY' });
  });

  afterAll(() => {
    getDb().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computeRepairPlan is read-only: calling it changes no row counts', async () => {
    const db = getDb();
    const before = {
      destinations: db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c,
      days: db.prepare("SELECT COUNT(*) c FROM days WHERE city_country IS NOT NULL").get().c,
    };

    const mod = await import('../src/db/migrations/024_geo_data_repair.js');
    const plan = mod.computeRepairPlan(db);
    expect(plan.dayStamps.length).toBeGreaterThan(0);
    expect(plan.emptyCountryTwinDeletes.length).toBeGreaterThan(0);
    expect(plan.reviewedCjkDeletes.length).toBeGreaterThan(0);

    const after = {
      destinations: db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c,
      days: db.prepare("SELECT COUNT(*) c FROM days WHERE city_country IS NOT NULL").get().c,
    };
    expect(after).toEqual(before);
  });

  it('deletes the 杭州市|CN row and its children, leaves hangzhou|CN untouched', async () => {
    const db = getDb();
    const mod = await import('../src/db/migrations/024_geo_data_repair.js');
    mod.up(db);

    expect(getDestination(db, canonicalGeoKey('杭州市'), 'CN')).toBeUndefined();
    expect(countChildren(db, ids.hangzhouCjk)).toEqual({ places: 0, daily: 0 });

    const clean = getDestination(db, 'hangzhou', 'CN');
    expect(clean).toBeTruthy();
    expect(clean.id).toBe(ids.hangzhouClean);
    expect(countChildren(db, ids.hangzhouClean)).toEqual({ places: 1, daily: 1 });
  });

  it('deletes the kualalumpur|"" twin and its children, keeps kualalumpur|MY intact', () => {
    const db = getDb();
    expect(getDestination(db, 'kualalumpur', '')).toBeUndefined();
    expect(countChildren(db, ids.klEmpty)).toEqual({ places: 0, daily: 0 });

    const my = getDestination(db, 'kualalumpur', 'MY');
    expect(my).toBeTruthy();
    expect(my.id).toBe(ids.klMy);
    expect(countChildren(db, ids.klMy)).toEqual({ places: 1, daily: 1 });
  });

  it('stamps the KL trip day (Kuala Lumpur, NULL) to MY via the catalogue evidence', () => {
    const db = getDb();
    const day = db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.klDay);
    expect(day.city_country).toBe('MY');
  });

  it('leaves a day whose city matches no catalogue/scope row as NULL', () => {
    const db = getDb();
    const day = db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.noMatchDay);
    expect(day.city_country).toBeNull();
  });

  it('leaves a day whose city matches two different countries as NULL', () => {
    const db = getDb();
    const day = db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.ambiguousDay);
    expect(day.city_country).toBeNull();
  });

  it('stamps a day via a trip_scopes-only match (no catalogue row)', () => {
    const db = getDb();
    const day = db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.scopeOnlyDay);
    expect(day.city_country).toBe('FR');
  });

  it('leaves an already-stamped day untouched', () => {
    const db = getDb();
    const day = db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.stampedDay);
    expect(day.city_country).toBe('MY');
  });

  it('leaves free-text 北京|"" (no twin) untouched', () => {
    const db = getDb();
    const row = getDestination(db, '北京', '');
    expect(row).toBeTruthy();
    expect(row.id).toBe(ids.beijing);
  });

  it('leaves the georgetown ambiguous rows untouched', () => {
    const db = getDb();
    expect(getDestination(db, 'georgetown', 'MY')).toBeTruthy();
    expect(getDestination(db, 'georgetown', 'GY')).toBeTruthy();
  });

  it('is idempotent: running up(db) again changes nothing', async () => {
    const db = getDb();
    const before = {
      destinations: db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c,
      places: db.prepare('SELECT COUNT(*) c FROM discovery_places').get().c,
      daily: db.prepare('SELECT COUNT(*) c FROM discovery_generation_daily').get().c,
      klDayCountry: db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.klDay).city_country,
      scopeOnlyDayCountry: db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.scopeOnlyDay).city_country,
    };

    const mod = await import('../src/db/migrations/024_geo_data_repair.js');
    mod.up(db);

    const after = {
      destinations: db.prepare('SELECT COUNT(*) c FROM discovery_destinations').get().c,
      places: db.prepare('SELECT COUNT(*) c FROM discovery_places').get().c,
      daily: db.prepare('SELECT COUNT(*) c FROM discovery_generation_daily').get().c,
      klDayCountry: db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.klDay).city_country,
      scopeOnlyDayCountry: db.prepare('SELECT city_country FROM days WHERE id = ?').get(dayIds.scopeOnlyDay).city_country,
    };

    expect(after).toEqual(before);
  });
});
