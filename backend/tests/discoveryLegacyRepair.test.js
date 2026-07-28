import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { CATEGORY_ACTIVE_CAP } from '../src/db/discoveryCatalogue.js';
import { buildPlaceQueryKey } from '../src/services/placeResolver.js';
import {
  findEmptyCountryDestinations,
  deleteEmptyCountryDestinations,
  classifyNeverChecked,
  repairNeverCheckedRows,
} from '../scripts/discoveryLegacyRepair.js';

// Plan 26 W5 — exercises the two one-off repairs against a disposable DB.

let tmpDir;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-legacy-repair-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM discovery_verification_attempts').run();
  db.prepare('DELETE FROM discovery_generation_daily').run();
  db.prepare('DELETE FROM discovery_places').run();
  db.prepare('DELETE FROM discovery_destinations').run();
  db.prepare('DELETE FROM place_resolution_cache').run();
});

function makeDestination(db, { cityKey, countryCode = '', displayName }) {
  return db.prepare(
    'INSERT INTO discovery_destinations (city_key, country_code, display_name) VALUES (?, ?, ?)',
  ).run(cityKey, countryCode, displayName).lastInsertRowid;
}

function makePlace(db, destinationId, {
  name, localName = null, category = 'sight', provenance = 'unverified', status = 'active',
}) {
  return db.prepare(`
    INSERT INTO discovery_places
      (destination_id, category, name, normalized_name, local_name, aliases_json, description, provenance, status, batch, generated_at)
    VALUES (?, ?, ?, ?, ?, '[]', 'desc', ?, ?, 0, datetime('now'))
  `).run(destinationId, category, name, name.toLowerCase(), localName, provenance, status).lastInsertRowid;
}

function insertAttempt(db, placeId, destinationId) {
  db.prepare(`
    INSERT INTO discovery_verification_attempts (
      place_id, destination_id, attempted_at, source_field, provider, query_variant,
      escalated, network_requests, location_status, match_score, returned_name,
      returned_country, error, outcome, reason, reverification
    ) VALUES (?, ?, datetime('now'), 'name', 'nominatim', 'x', 0, 1, 'resolved', NULL, NULL, NULL, NULL, 'verified', 'ok', 0)
  `).run(placeId, destinationId);
}

function insertCacheFossil(db, queryKey) {
  db.prepare(`
    INSERT INTO place_resolution_cache (
      query_key, query_text, city, country, provider, provider_id, name, address,
      lat, lng, coordinate_system, confidence, raw_json, resolved_country, updated_at
    ) VALUES (?, 'x', 'city', 'CN', 'nominatim', 'p1', 'x', NULL, 1, 1, 'wgs84', 0.9, NULL, 'CN', datetime('now'))
  `).run(queryKey);
}

describe('classifyNeverChecked', () => {
  it('classifies a row with a discovery_verification_attempts row as CHECKED', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'checked-attempt', countryCode: 'CN', displayName: 'Checked Attempt' });
    const placeId = makePlace(db, destId, { name: 'Attempt Place' });
    insertAttempt(db, placeId, destId);

    const place = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(placeId);
    const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destId);
    const result = classifyNeverChecked(db, place, destination);

    expect(result.checked).toBe(true);
    expect(result.evidence).toBe('attempts');
  });

  it('classifies a row with a place_resolution_cache fossil under the NAME key as CHECKED', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'checked-name-cache', countryCode: 'CN', displayName: 'Checked Name Cache' });
    const placeId = makePlace(db, destId, { name: 'Name Cache Place' });
    const key = buildPlaceQueryKey({ queryText: 'Name Cache Place', city: 'Checked Name Cache', country: 'CN' });
    insertCacheFossil(db, key);

    const place = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(placeId);
    const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destId);
    const result = classifyNeverChecked(db, place, destination);

    expect(result.checked).toBe(true);
    expect(result.evidence).toBe('cache_name');
  });

  it('classifies a row with a place_resolution_cache fossil under the LOCAL_NAME key only as CHECKED', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'checked-local-cache', countryCode: 'CN', displayName: 'Checked Local Cache' });
    const placeId = makePlace(db, destId, { name: 'Local Cache Place', localName: '本地名' });
    const localKey = buildPlaceQueryKey({ queryText: '本地名', city: 'Checked Local Cache', country: 'CN' });
    insertCacheFossil(db, localKey);

    const place = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(placeId);
    const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destId);
    const result = classifyNeverChecked(db, place, destination);

    expect(result.checked).toBe(true);
    expect(result.evidence).toBe('cache_local_name');
  });

  it('classifies a row with neither evidence as NEVER CHECKED', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'never-checked', countryCode: 'CN', displayName: 'Never Checked' });
    const placeId = makePlace(db, destId, { name: 'Untouched Place' });

    const place = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(placeId);
    const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destId);
    const result = classifyNeverChecked(db, place, destination);

    expect(result.checked).toBe(false);
    expect(result.evidence).toBeNull();
  });
});

describe('repairNeverCheckedRows', () => {
  it('repairs a never-checked row to provenance=pending, status=active', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'repair-active', countryCode: 'CN', displayName: 'Repair Active' });
    const placeId = makePlace(db, destId, { name: 'Repair Me', status: 'active' });

    const report = repairNeverCheckedRows(db, { apply: true });

    expect(report.neverChecked.some((p) => p.id === placeId)).toBe(true);
    expect(report.rowsWritten).toBeGreaterThan(0);

    const row = db.prepare('SELECT provenance, status FROM discovery_places WHERE id = ?').get(placeId);
    expect(row.provenance).toBe('pending');
    expect(row.status).toBe('active');
  });

  it('un-archives an archived never-checked row', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'repair-archived', countryCode: 'CN', displayName: 'Repair Archived' });
    const placeId = makePlace(db, destId, { name: 'Archived Repair Me', status: 'archived' });

    repairNeverCheckedRows(db, { apply: true });

    const row = db.prepare('SELECT provenance, status FROM discovery_places WHERE id = ?').get(placeId);
    expect(row.provenance).toBe('pending');
    expect(row.status).toBe('active');
  });

  it('never touches a suppressed row', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'repair-suppressed', countryCode: 'CN', displayName: 'Repair Suppressed' });
    const placeId = makePlace(db, destId, { name: 'Suppressed Place', status: 'suppressed' });

    const report = repairNeverCheckedRows(db, { apply: true });

    expect(report.neverChecked.some((p) => p.id === placeId)).toBe(false);
    const row = db.prepare('SELECT provenance, status FROM discovery_places WHERE id = ?').get(placeId);
    expect(row.provenance).toBe('unverified');
    expect(row.status).toBe('suppressed');
  });

  it('excludes checked rows from repair and reports the correct exclusion evidence counts', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'exclusion-mix', countryCode: 'CN', displayName: 'Exclusion Mix' });

    const attemptPlaceId = makePlace(db, destId, { name: 'Attempt Checked' });
    insertAttempt(db, attemptPlaceId, destId);

    const cachePlaceId = makePlace(db, destId, { name: 'Cache Checked' });
    insertCacheFossil(db, buildPlaceQueryKey({ queryText: 'Cache Checked', city: 'Exclusion Mix', country: 'CN' }));

    const neverCheckedPlaceId = makePlace(db, destId, { name: 'Genuinely Never Checked' });

    const report = repairNeverCheckedRows(db, { apply: false });

    expect(report.excluded.attempts).toBeGreaterThanOrEqual(1);
    expect(report.excluded.cache_name).toBeGreaterThanOrEqual(1);
    expect(report.neverChecked.map((p) => p.id)).toContain(neverCheckedPlaceId);
    expect(report.neverChecked.map((p) => p.id)).not.toContain(attemptPlaceId);
    expect(report.neverChecked.map((p) => p.id)).not.toContain(cachePlaceId);

    // dry run must not have written anything
    const row = db.prepare('SELECT provenance FROM discovery_places WHERE id = ?').get(neverCheckedPlaceId);
    expect(row.provenance).toBe('unverified');
  });

  it('reports cap pressure for an affected destination+category', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'cap-pressure', countryCode: 'CN', displayName: 'Cap Pressure' });
    // Fill the category to just under the cap with verified active rows.
    for (let i = 0; i < CATEGORY_ACTIVE_CAP - 1; i += 1) {
      makePlace(db, destId, { name: `Filler ${i}`, category: 'sight', provenance: 'verified', status: 'active' });
    }
    const archivedNeverCheckedId = makePlace(db, destId, { name: 'Archived Never Checked', category: 'sight', status: 'archived' });

    const report = repairNeverCheckedRows(db, { apply: false });
    const entry = report.capPressure.find((c) => c.destinationId === destId && c.category === 'sight');

    expect(entry).toBeDefined();
    expect(entry.currentActive).toBe(CATEGORY_ACTIVE_CAP - 1);
    expect(entry.becomingActive).toBe(1);
    expect(entry.resultingTotal).toBe(CATEGORY_ACTIVE_CAP);
    expect(entry.exceedsCap).toBe(false);
    expect(report.neverChecked.map((p) => p.id)).toContain(archivedNeverCheckedId);
  });
});

describe('deleteEmptyCountryDestinations', () => {
  it('refuses when the live set has an EXTRA destination not in --expect-destinations', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'empty-extra', countryCode: '', displayName: 'Empty Extra' });

    expect(() => deleteEmptyCountryDestinations(db, [])).toThrow(/does not match/);
    // nothing deleted
    expect(db.prepare('SELECT 1 FROM discovery_destinations WHERE id = ?').get(destId)).toBeDefined();
  });

  it('refuses when --expect-destinations names an id MISSING from the live set', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'empty-present', countryCode: '', displayName: 'Empty Present' });

    expect(() => deleteEmptyCountryDestinations(db, [destId, destId + 999])).toThrow(/does not match/);
    expect(db.prepare('SELECT 1 FROM discovery_destinations WHERE id = ?').get(destId)).toBeDefined();
  });

  it('refuses when a target destination holds a verified place', () => {
    const db = getDb();
    const destId = makeDestination(db, { cityKey: 'empty-verified', countryCode: '', displayName: 'Empty Verified' });
    makePlace(db, destId, { name: 'Verified Place', provenance: 'verified' });

    expect(() => deleteEmptyCountryDestinations(db, [destId])).toThrow(/verified/i);
    expect(db.prepare('SELECT 1 FROM discovery_destinations WHERE id = ?').get(destId)).toBeDefined();
  });

  it('deletes the destination, its places, attempts, and generation_daily rows, leaving other destinations untouched', () => {
    const db = getDb();
    const targetId = makeDestination(db, { cityKey: 'empty-target', countryCode: '', displayName: 'Empty Target' });
    const otherId = makeDestination(db, { cityKey: 'other-country', countryCode: 'JP', displayName: 'Other Country' });

    const placeId = makePlace(db, targetId, { name: 'Target Place', provenance: 'unverified' });
    insertAttempt(db, placeId, targetId);
    db.prepare(`
      INSERT INTO discovery_generation_daily (destination_id, utc_date, count)
      VALUES (?, strftime('%Y-%m-%d', 'now'), 1)
    `).run(targetId);

    const otherPlaceId = makePlace(db, otherId, { name: 'Other Place', provenance: 'verified' });

    const { perDestination } = deleteEmptyCountryDestinations(db, [targetId]);

    expect(perDestination).toHaveLength(1);
    expect(perDestination[0].destinationDeleted).toBe(1);
    expect(perDestination[0].placesDeleted).toBe(1);
    expect(perDestination[0].attemptsDeleted).toBe(1);
    expect(perDestination[0].generationDailyDeleted).toBe(1);

    expect(db.prepare('SELECT 1 FROM discovery_destinations WHERE id = ?').get(targetId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM discovery_places WHERE id = ?').get(placeId)).toBeUndefined();

    expect(db.prepare('SELECT 1 FROM discovery_destinations WHERE id = ?').get(otherId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM discovery_places WHERE id = ?').get(otherPlaceId)).toBeDefined();
  });

  it('findEmptyCountryDestinations derives NULL and empty-string country codes alike', () => {
    const db = getDb();
    makeDestination(db, { cityKey: 'blank-country', countryCode: '', displayName: 'Blank Country' });
    const found = findEmptyCountryDestinations(db);
    expect(found.some((d) => d.city_key === 'blank-country')).toBe(true);
  });
});
