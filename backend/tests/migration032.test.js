import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

// Plan 26 W3.1: exercises 032_discovery_verification_attempts.sql — proves
// ordered application on a fresh disposable DB: the table and its indexes
// exist, nullable columns are actually nullable, _migrations records the
// filename, and re-running runMigrations() is a no-op.

let tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-032-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('032_discovery_verification_attempts', () => {
  it('creates the table with every expected column', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(discovery_verification_attempts)').all();
    const names = columns.map((c) => c.name);

    expect(names).toEqual([
      'id', 'place_id', 'destination_id', 'attempted_at', 'source_field',
      'provider', 'query_variant', 'escalated', 'network_requests',
      'location_status', 'match_score', 'returned_name', 'returned_country',
      'error', 'outcome', 'reason', 'reverification',
    ]);
  });

  it('marks the required columns NOT NULL and the provider-detail columns nullable', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(discovery_verification_attempts)').all();
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    // notnull: 1 = NOT NULL, 0 = nullable
    expect(byName.place_id.notnull).toBe(1);
    expect(byName.destination_id.notnull).toBe(1);
    expect(byName.attempted_at.notnull).toBe(1);
    expect(byName.source_field.notnull).toBe(1);
    expect(byName.outcome.notnull).toBe(1);
    expect(byName.reason.notnull).toBe(1);
    expect(byName.escalated.notnull).toBe(1);
    expect(byName.network_requests.notnull).toBe(1);
    expect(byName.reverification.notnull).toBe(1);

    expect(byName.provider.notnull).toBe(0);
    expect(byName.query_variant.notnull).toBe(0);
    expect(byName.location_status.notnull).toBe(0);
    expect(byName.match_score.notnull).toBe(0);
    expect(byName.returned_name.notnull).toBe(0);
    expect(byName.returned_country.notnull).toBe(0);
    expect(byName.error.notnull).toBe(0);
  });

  it('creates the place and destination indexes', () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'discovery_verification_attempts'",
    ).all().map((r) => r.name);

    expect(indexes).toContain('idx_discovery_verification_attempts_place');
    expect(indexes).toContain('idx_discovery_verification_attempts_destination');
  });

  it('actually persists and cascade-deletes a row with a real place/destination', () => {
    const db = getDb();
    const { lastInsertRowid: destId } = db.prepare(
      `INSERT INTO discovery_destinations (city_key, country_code, display_name) VALUES ('m032test', 'JP', 'M032 Test')`,
    ).run();
    const { lastInsertRowid: placeId } = db.prepare(`
      INSERT INTO discovery_places
        (destination_id, category, name, normalized_name, aliases_json, description, provenance, status, batch, generated_at)
      VALUES (?, 'sight', 'Test Place', 'test-place', '[]', 'd', 'unverified', 'active', 0, datetime('now'))
    `).run(destId);

    db.prepare(`
      INSERT INTO discovery_verification_attempts (
        place_id, destination_id, attempted_at, source_field, provider, query_variant,
        escalated, network_requests, location_status, match_score, returned_name,
        returned_country, error, outcome, reason, reverification
      ) VALUES (?, ?, datetime('now'), 'name', 'nominatim', 'Test Place', 0, 1, 'unresolved', NULL, NULL, NULL, NULL, 'unverified', 'no_result', 0)
    `).run(placeId, destId);

    const row = db.prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(placeId);
    expect(row).toBeDefined();
    expect(row.reason).toBe('no_result');
    expect(row.outcome).toBe('unverified');

    db.prepare('DELETE FROM discovery_places WHERE id = ?').run(placeId);
    const afterCascade = db.prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(placeId);
    expect(afterCascade).toBeUndefined();
  });

  it('records the filename in _migrations', () => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM _migrations WHERE filename = ?')
      .get('032_discovery_verification_attempts.sql');
    expect(row).toBeDefined();
  });

  it('re-running runMigrations is a no-op (idempotent)', async () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) c FROM _migrations').get().c;
    await expect(runMigrations()).resolves.not.toThrow();
    const after = db.prepare('SELECT COUNT(*) c FROM _migrations').get().c;
    expect(after).toBe(before);
  });
});
