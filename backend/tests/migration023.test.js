import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';

// Plan 9 Wave 2 §2.1: exercises 023_trip_scopes.js's backfill against trips inserted
// directly via raw SQL (bypassing createTrip, which already writes its own trip_scopes
// rows post-023 — so backfill would see them and skip). This mirrors migration021's
// pattern of seeding fixture rows directly, then invoking mod.up(db) again in isolation.

let tmpDir;
let ownerId;

function insertTrip(db, { title = 'Test Trip', startDate = '2026-01-01', endDate = '2026-01-05' } = {}) {
  return db.prepare(`
    INSERT INTO trips (title, owner_id, start_date, end_date)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get(title, ownerId, startDate, endDate).id;
}

function insertDay(db, tripId, { date, city, cityCountry = null, cityOverride = null, cityOverrideCountry = null }) {
  db.prepare(`
    INSERT INTO days (trip_id, date, city, city_country, city_override, city_override_country)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tripId, date, city, cityCountry, cityOverride, cityOverrideCountry);
}

function scopesForTrip(db, tripId) {
  return db.prepare('SELECT label, country_code, source, kind, place_id, bounds_json, position FROM trip_scopes WHERE trip_id = ? ORDER BY position ASC').all(tripId);
}

describe('023_trip_scopes — backfill', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-023-'));
    initDb(join(tmpDir, 'test.db'));
    await runMigrations();
    ownerId = authService.setup('owner023', 'password123', 'Owner 023').user.id;
  });

  afterAll(() => {
    getDb().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('F12: backfills Shanghai (seed) and Melaka (override), never the hotel-resolved 杭州市', async () => {
    const db = getDb();
    const tripId = insertTrip(db, { title: 'Shanghai Melaka Trip' });
    insertDay(db, tripId, { date: '2026-01-01', city: 'Shanghai', cityCountry: 'CN' });
    insertDay(db, tripId, {
      date: '2026-01-02', city: 'Shanghai', cityCountry: 'CN', cityOverride: 'Melaka', cityOverrideCountry: 'MY',
    });
    // A hotel booking resolving 杭州市 lives only in bookings.details_json — never a day
    // column — so it must never appear in the backfilled scopes.
    db.prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Hangzhou Hotel', '2026-01-01T15:00', '2026-01-02T11:00', ?)
    `).run(tripId, JSON.stringify({ locality: '杭州市', countryCode: 'CN' }));

    const mod = await import('../src/db/migrations/023_trip_scopes.js');
    mod.up(db);

    const scopes = scopesForTrip(db, tripId);
    expect(scopes.map((s) => s.label)).toEqual(['Shanghai', 'Melaka']);
    expect(scopes.every((s) => s.source === 'seed-backfill')).toBe(true);
    expect(scopes[0]).toMatchObject({ country_code: 'CN', position: 0 });
    expect(scopes[1]).toMatchObject({ country_code: 'MY', position: 1 });
    expect(scopes.some((s) => s.label === '杭州市')).toBe(false);
  });

  it('dedupes seed and override labels that fold to the same canonical key, first label wins', async () => {
    const db = getDb();
    const tripId = insertTrip(db, { title: 'Dedup Trip' });
    insertDay(db, tripId, { date: '2026-02-01', city: 'Chengdu', cityCountry: 'CN' });
    insertDay(db, tripId, {
      date: '2026-02-02', city: 'chengdu', cityCountry: 'CN', cityOverride: 'Chengdu', cityOverrideCountry: 'CN',
    });

    const mod = await import('../src/db/migrations/023_trip_scopes.js');
    mod.up(db);

    const scopes = scopesForTrip(db, tripId);
    expect(scopes.map((s) => s.label)).toEqual(['Chengdu']);
  });

  it('is idempotent: a trip that already has scope rows is skipped entirely on re-run', async () => {
    const db = getDb();
    const tripId = insertTrip(db, { title: 'Already Scoped Trip' });
    insertDay(db, tripId, { date: '2026-03-01', city: 'Taipei', cityCountry: 'TW' });

    const mod = await import('../src/db/migrations/023_trip_scopes.js');
    mod.up(db);
    const firstRun = scopesForTrip(db, tripId);
    expect(firstRun).toHaveLength(1);

    mod.up(db);
    const secondRun = scopesForTrip(db, tripId);
    expect(secondRun).toEqual(firstRun);
  });

  it('skips a trip with no city labels at all (no rows inserted, no throw)', async () => {
    const db = getDb();
    const tripId = insertTrip(db, { title: 'Empty Trip' });

    const mod = await import('../src/db/migrations/023_trip_scopes.js');
    expect(() => mod.up(db)).not.toThrow();

    expect(scopesForTrip(db, tripId)).toEqual([]);
  });
});
