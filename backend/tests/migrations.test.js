import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigrations } from '../src/db/migrations.js';
import { initDb, getDb } from '../src/db/database.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpDir;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
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
    expect(tables).toContain('discovery_cache');
    expect(tables).toContain('global_discovery_cache');
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

  it('tracks migration versions to avoid re-running', () => {
    const db = getDb();
    // Running again should not throw
    expect(() => runMigrations()).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) as c FROM _migrations').get();
    expect(count.c).toBe(9);
  });
});
