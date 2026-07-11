import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations } from '../src/db/migrations.js';
import { initDb, getDb } from '../src/db/database.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('migrations', () => {
  it('creates all required tables', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    expect(tables).toContain('users');
    expect(tables).toContain('auth_sessions');
    expect(tables).toContain('settings');
    expect(tables).toContain('trips');
    expect(tables).toContain('trip_collaborators');
    expect(tables).toContain('share_links');
    expect(tables).toContain('days');
    expect(tables).toContain('stops');
    expect(tables).toContain('bookings');
    expect(tables).toContain('place_resolution_cache');
    expect(tables).toContain('copilot_messages');
  });

  it('adds stop location metadata columns', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(stops)').all().map((r) => r.name);

    expect(columns).toContain('location_query');
    expect(columns).toContain('resolved_name');
    expect(columns).toContain('resolved_address');
    expect(columns).toContain('coordinate_system');
    expect(columns).toContain('coordinate_source');
    expect(columns).toContain('location_status');
    expect(columns).toContain('location_confidence');
    expect(columns).toContain('provider_id');
  });

  it('adds booking itinerary visibility column', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(bookings)').all().map((r) => r.name);

    expect(columns).toContain('show_in_itinerary');
  });

  it('adds booking timezone columns', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(bookings)').all().map((r) => r.name);

    expect(columns).toContain('origin_tz');
    expect(columns).toContain('destination_tz');
  });

  it('adds day/stop geography columns', () => {
    const db = getDb();
    const dayColumns = db.prepare('PRAGMA table_info(days)').all().map((r) => r.name);
    const stopColumns = db.prepare('PRAGMA table_info(stops)').all().map((r) => r.name);
    const cacheColumns = db.prepare('PRAGMA table_info(place_resolution_cache)').all().map((r) => r.name);

    expect(dayColumns).toContain('city_country');
    expect(dayColumns).toContain('city_override_country');
    expect(stopColumns).toContain('country_code');
    expect(cacheColumns).toContain('resolved_country');
  });

  it('tracks migration versions to avoid re-running', async () => {
    const db = getDb();
    // Running again should not throw (idempotent — already-applied files are skipped)
    await expect(runMigrations()).resolves.not.toThrow();
    const count = db.prepare('SELECT COUNT(*) as c FROM _migrations').get();
    // 001-018, 019 (fix_google_cn_coordinates), 020 (reset_bali_catalogue),
    // 021 (canonicalize_discovery_keys), 022 (drop_dead_discovery_cache),
    // 023 (trip_scopes), 024 (geo_data_repair), 025 (stop_photo_attribution),
    // 026 (discovery_place_photo_descriptor), and 027 (stop_photo_source).
    expect(count.c).toBe(27);
  });

  it('adds stop photo attribution columns (Plan 10 Wave 1)', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(stops)').all().map((r) => r.name);

    expect(columns).toContain('unsplash_photo_id');
    expect(columns).toContain('photo_attribution_json');
    expect(columns).toContain('photo_query');
    expect(columns).toContain('scene_type');
  });

  it('adds the stop photo_source column (Plan 10 Wave 4)', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(stops)').all().map((r) => r.name);

    expect(columns).toContain('photo_source');
  });

  it('adds discovery place photo descriptor columns (Plan 10 Wave 3)', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(discovery_places)').all().map((r) => r.name);

    expect(columns).toContain('photo_query');
    expect(columns).toContain('scene_type');
  });

  it('retires the legacy trip destination array columns', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(trips)').all().map((r) => r.name);

    expect(columns).not.toContain('destinations');
    expect(columns).not.toContain('destination_countries');
  });

  it('runs the 014 backfill without error against a fresh, trip-free DB', () => {
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) c FROM trips').get().c).toBe(0);
  });

  it('retires the single-blob global_discovery_cache table (Plan 7 Wave 4)', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    expect(tables).not.toContain('global_discovery_cache');
    // The normalized catalogue tables that replaced it stay present.
    expect(tables).toContain('discovery_destinations');
    expect(tables).toContain('discovery_places');
  });

  it('drops the dead discovery_cache table (Plan 8 Wave 6)', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    expect(tables).not.toContain('discovery_cache');
    // The normalized catalogue tables that replaced it stay present.
    expect(tables).toContain('discovery_destinations');
    expect(tables).toContain('discovery_places');
  });
});
