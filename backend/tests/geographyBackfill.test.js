import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { getTripDetail } from '../src/services/trips.js';
import { getSharedTrip } from '../src/services/share.js';
import { getTripMapData } from '../src/services/mapData.js';

// Plan 6 Wave 4 test spec: run the full migration suite (001->015) against a snapshot of
// the real dev/production-shaped DB and assert trip detail, share payload, and map-data
// outputs are semantically identical before/after for the two real trips. This is a
// browser-adjacent sanity check that green unit tests alone don't provide (Wave 2's
// routes/map.js regression was only caught by manual verification, not tests).
//
// NOTE: the dev backend's file watcher auto-restarted (picking up the migration files
// this wave adds) and applied 014/015 to the real data/trippy.db before this test file
// existed, so the live DB is already post-migration — there's no way to re-capture its
// raw destinations/destination_countries columns live. The "before" facts below were
// captured directly by hand-querying data/trippy.db earlier in the same session, prior to
// any Wave 4 migration running (2026-07-07): trip "Chengdu - Chongqing" had
// destinations=["Chengdu","Chongqing"] / destination_countries=["CN"]; trip
// "Ipoh - Kuala Lumpur" had destinations=["Ipoh","Kuala Lumpur"] / destination_countries=
// ["MY"]; 7 gcj02 stops, all on the Chengdu-Chongqing trip; 1 share link, for that trip.
// (Historical snapshot only — the live dev DB has since grown more CN content; the gcj02
// safety-net test below asserts the CN-confinement invariant rather than that frozen count.)

const REAL_DB_PATH = join(process.cwd(), 'data', 'trippy.db');

const PRE_MIGRATION_FACTS = {
  trips: [
    { title: 'Chengdu - Chongqing', destinations: ['Chengdu', 'Chongqing'], destinationCountries: ['CN'] },
    { title: 'Ipoh - Kuala Lumpur', destinations: ['Ipoh', 'Kuala Lumpur'], destinationCountries: ['MY'] },
  ],
};

let tmpDir;
let ownerId;
let liveTrips;
let liveShareLinks;

// Resolved city text can come from a hotel booking's extracted detailsJson.city rather
// than the trip's originally-seeded/created chip spelling (e.g. this real trip's Regent
// Chongqing hotel booking has detailsJson.city = "Chong Qing", two words, while the trip
// was created with the chip "Chongqing", one word) -- a pre-existing extraction-vs-seed
// spelling quirk, not something Wave 4 introduces (Wave 3's EditTripModal already prefers
// this same resolved-geo text client-side). Normalize case/whitespace before comparing so
// the test asserts the semantic content the plan calls for, not byte-identical strings.
function normalizeCityForComparison(city) {
  return city.toLowerCase().replace(/\s+/g, '');
}

describe.skipIf(!existsSync(REAL_DB_PATH))('Wave 4 backfill — real DB snapshot semantic-identity check', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trippy-geo-backfill-'));
    const snapshotPath = join(tmpDir, 'snapshot.db');

    // Safe hot copy respecting WAL (the real DB is actively used by the running dev
    // server) rather than a raw fs.copyFileSync of a possibly-inconsistent file set.
    const sourceDb = new Database(REAL_DB_PATH, { readonly: true });
    await sourceDb.backup(snapshotPath);

    liveTrips = sourceDb.prepare('SELECT id, title FROM trips').all();
    liveShareLinks = sourceDb.prepare('SELECT token, trip_id FROM share_links').all();
    const owner = sourceDb.prepare('SELECT id FROM users LIMIT 1').get();
    ownerId = owner.id;
    sourceDb.close();

    expect(liveTrips.length).toBeGreaterThan(0);

    initDb(snapshotPath);
    // Already applied on the live DB (014/015 included) — this call proves re-running the
    // full suite against an already-migrated real snapshot is a clean no-op, per the
    // idempotence requirement.
    await runMigrations();
  });

  afterAll(() => {
    getDb().close();
    rmSync(tmpDir, { recursive: true });
  });

  it('drops the legacy columns', () => {
    const columns = getDb().prepare('PRAGMA table_info(trips)').all().map((r) => r.name);
    expect(columns).not.toContain('destinations');
    expect(columns).not.toContain('destination_countries');
  });

  it('backfills city_country on every day (no day left with a NULL seed country for a resolvable trip)', () => {
    const db = getDb();
    const unresolved = db.prepare(`
      SELECT d.id, d.trip_id, d.city FROM days d WHERE d.city_country IS NULL
    `).all();
    // Both real trips are single-country (rule 1 of the backfill algorithm), so every
    // day should have been stamped -- zero NULL-country days should remain.
    expect(unresolved).toEqual([]);
  });

  it('getTripDetail: trip.destinations/destinationCountries are semantically identical (at least as complete as) the pre-migration stored values', () => {
    for (const fact of PRE_MIGRATION_FACTS.trips) {
      const liveTrip = liveTrips.find((t) => t.title === fact.title);
      expect(liveTrip).toBeTruthy();
      const detail = getTripDetail(liveTrip.id, ownerId);
      const derivedCities = new Set(detail.trip.destinations.map(normalizeCityForComparison));
      const factCities = new Set(fact.destinations.map(normalizeCityForComparison));
      // The derived (days-sourced) set must be a SUPERSET of the old stored-column set,
      // not necessarily equal: the old `trips.destinations` column was frozen at trip
      // creation and never revisited, so it can under-represent reality once later
      // bookings add day-level identity the stale echo never captured (e.g. this real
      // "Ipoh - Kuala Lumpur" trip's return flight resolves its last day to Singapore,
      // correctly surfaced now, never present in the original creation-time chip list).
      // This is Wave 4 working as intended (days own geographic truth), not a regression.
      for (const city of factCities) expect(derivedCities.has(city)).toBe(true);
      // Every country the old column claimed must still be represented (no country lost).
      const derivedCountries = new Set(detail.trip.destinationCountries);
      for (const country of fact.destinationCountries) expect(derivedCountries.has(country)).toBe(true);
      expect(detail.days.every((d) => d.resolvedCountry)).toBe(true);
    }
  });

  it('getSharedTrip: share payload destinations are at least as complete as the pre-migration facts for the shared trip', () => {
    for (const link of liveShareLinks) {
      const liveTrip = liveTrips.find((t) => t.id === link.trip_id);
      const fact = PRE_MIGRATION_FACTS.trips.find((t) => t.title === liveTrip.title);
      // Share links can exist for trips outside the 2026-07-07 pre-migration snapshot
      // (e.g. trips seeded into the dev DB for later-wave browser verification) — there
      // are no captured facts to compare those against, so they're out of this test's scope.
      if (!fact) continue;
      const shared = getSharedTrip(link.token);
      const derivedCities = new Set(shared.trip.destinations.map(normalizeCityForComparison));
      for (const city of fact.destinations.map(normalizeCityForComparison)) expect(derivedCities.has(city)).toBe(true);
      const derivedCountries = new Set(shared.trip.destinationCountries);
      for (const country of fact.destinationCountries) expect(derivedCountries.has(country)).toBe(true);
    }
  });

  it('getTripMapData: still resolves a per-day mapConfig without error, CN trip keeps CN provider', () => {
    for (const fact of PRE_MIGRATION_FACTS.trips) {
      const liveTrip = liveTrips.find((t) => t.title === fact.title);
      const mapData = getTripMapData(ownerId, liveTrip.id);
      expect(mapData.mapConfig).toBeTruthy();
      expect(mapData.mapConfigByDay).toBeTruthy();
      if (fact.destinationCountries.includes('CN')) {
        expect(mapData.mapConfig.tileProvider).toBe('amap');
      }
    }
  });

  it('pin relabel safety net: every gcj02 stop stays confined to a China-derived trip (no pin relabeled onto a non-CN cohort)', () => {
    const db = getDb();
    const gcj02Stops = db.prepare(`
      SELECT s.id, d.trip_id FROM stops s JOIN days d ON d.id = s.day_id
      WHERE s.coordinate_system = 'gcj02'
    `).all();
    // gcj02 is mainland China's coordinate system, so the durable invariant this migration
    // safety net protects is that every gcj02 stop lives on a trip whose *derived* geography
    // is China — a pin relabeled onto a non-CN cohort would be the regression. Do NOT assert a
    // frozen total or a single trip title: this test reads the live dev DB, which has legitimately
    // grown a second CN trip since the 2026-07-07 snapshot ("Shanghai - Hangzhou (W3 verify)",
    // whose Shanghai/Hangzhou stops are correctly gcj02). The original cohort was 7 stops on
    // "Chengdu - Chongqing"; asserting the CN-confinement invariant instead survives such growth.
    expect(gcj02Stops.length).toBeGreaterThan(0);
    const cnTripIds = new Set(
      liveTrips
        .filter((t) => getTripDetail(t.id, ownerId).trip.destinationCountries.includes('CN'))
        .map((t) => t.id),
    );
    expect(gcj02Stops.every((s) => cnTripIds.has(s.trip_id))).toBe(true);
  });
});
