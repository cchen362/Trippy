import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  hasCjkEvidence,
  selectCjkHotelBookings,
  mergeRefetchedFields,
} from '../scripts/refetchCjkBookingEvidence.js';

// Plan 9 Wave 5.3: exercises the exported pure/testable functions only — the
// CLI entry (main()) is guarded by an import.meta.url check and never runs
// under import, so it is not exercised here.

describe('hasCjkEvidence', () => {
  it('detects CJK in an adminAreas value only', () => {
    expect(hasCjkEvidence({ city: 'Hangzhou', adminAreas: { aal1: '浙江省', aal2: null } })).toBe(true);
  });

  it('detects CJK in locality only', () => {
    expect(hasCjkEvidence({ locality: '杭州市' })).toBe(true);
  });

  it('returns false for all-Latin fields (romanized)', () => {
    expect(hasCjkEvidence({
      city: 'Shang Hai Shi',
      locality: 'Shang Hai Shi',
      sublocality: 'Huangpu Qu',
      adminAreas: { aal1: 'Shanghai', aal2: null },
    })).toBe(false);
  });

  it('returns false for countryCode "CN" alone with Latin fields', () => {
    expect(hasCjkEvidence({ countryCode: 'CN', city: 'Shanghai', locality: 'Shanghai' })).toBe(false);
  });

  it('returns false for null/missing fields', () => {
    expect(hasCjkEvidence(null)).toBe(false);
    expect(hasCjkEvidence({})).toBe(false);
    expect(hasCjkEvidence({ city: null, locality: undefined, adminAreas: null })).toBe(false);
  });
});

describe('selectCjkHotelBookings', () => {
  let tmpDir;
  let tripId;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-refetch-'));
    initDb(join(tmpDir, 'test.db'));
    return runMigrations().then(() => {
      const db = getDb();
      db.prepare(
        `INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ('tester', 'x', 'Tester', 0)`,
      ).run();
      const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('tester').id;
      db.prepare(
        `INSERT INTO trips (title, owner_id, start_date, end_date) VALUES ('Trip', ?, '2026-08-01', '2026-08-05')`,
      ).run(userId);
      tripId = db.prepare('SELECT id FROM trips WHERE owner_id = ?').get(userId).id;
    });
  });

  afterAll(() => {
    getDb().close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertBooking({ type, title, detailsJson }) {
    const db = getDb();
    db.prepare(
      `INSERT INTO bookings (trip_id, type, title, details_json) VALUES (?, ?, ?, ?)`,
    ).run(tripId, type, title, detailsJson);
    return db.prepare('SELECT id FROM bookings WHERE trip_id = ? AND title = ?').get(tripId, title).id;
  }

  it('selects a hotel booking with CJK details and a placeId, with correct cjkFields', () => {
    const id = insertBooking({
      type: 'hotel',
      title: 'Park Hyatt Hangzhou',
      detailsJson: JSON.stringify({
        placeId: 'ChIJ-real-place-id',
        locality: '杭州市',
        sublocality: '拱墅区',
        adminAreas: { aal1: '浙江省', aal2: null },
        countryCode: 'CN',
      }),
    });

    const selected = selectCjkHotelBookings(getDb());
    const match = selected.find((s) => s.booking.id === id);
    expect(match).toBeDefined();
    expect(match.cjkFields.sort()).toEqual(['adminAreas.aal1', 'locality', 'sublocality'].sort());
  });

  it('excludes a hotel booking with CJK details but no placeId', () => {
    const id = insertBooking({
      type: 'hotel',
      title: 'No PlaceId Hotel',
      detailsJson: JSON.stringify({ locality: '杭州市' }),
    });

    const selected = selectCjkHotelBookings(getDb());
    expect(selected.find((s) => s.booking.id === id)).toBeUndefined();
  });

  it('excludes a Latin (romanized) hotel booking', () => {
    const id = insertBooking({
      type: 'hotel',
      title: 'Latin Hotel',
      detailsJson: JSON.stringify({ placeId: 'ChIJ-latin', locality: 'Hangzhou Shi', countryCode: 'CN' }),
    });

    const selected = selectCjkHotelBookings(getDb());
    expect(selected.find((s) => s.booking.id === id)).toBeUndefined();
  });

  it('excludes a non-hotel booking with CJK evidence', () => {
    const id = insertBooking({
      type: 'train',
      title: 'CJK Train',
      detailsJson: JSON.stringify({ placeId: 'ChIJ-train', locality: '杭州市' }),
    });

    const selected = selectCjkHotelBookings(getDb());
    expect(selected.find((s) => s.booking.id === id)).toBeUndefined();
  });

  it('skips a booking with corrupt details_json, warning instead of throwing', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO bookings (trip_id, type, title, details_json) VALUES (?, 'hotel', 'Corrupt Hotel', ?)`,
    ).run(tripId, '{not valid json');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => selectCjkHotelBookings(db)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('mergeRefetchedFields', () => {
  it('replaces exactly the five language-sensitive fields and preserves everything else, including unknown keys', () => {
    const existing = {
      placeId: 'ChIJ-abc',
      name: 'Park Hyatt Hangzhou',
      address: '1 Hubin Road, Hangzhou, China',
      lat: 30.25,
      lng: 120.15,
      tz: 'Asia/Shanghai',
      countryCode: 'CN',
      locality: '杭州市',
      sublocality: '拱墅区',
      adminAreas: { aal1: '浙江省', aal2: null },
      city: '杭州市',
      someFutureField: 'untouched-value',
    };
    const fresh = {
      placeId: 'ChIJ-abc-different', // fresh may report a slightly different shape; still ignored
      name: 'Should Not Be Used',
      address: 'Should Not Be Used',
      lat: 999,
      lng: 999,
      tz: 'Should/NotUsed',
      countryCode: 'CN',
      locality: 'Hangzhou',
      sublocality: 'Gongshu District',
      adminAreas: { aal1: 'Zhejiang', aal2: null },
      city: 'Hangzhou',
    };

    const merged = mergeRefetchedFields(existing, fresh);

    expect(merged.countryCode).toBe('CN');
    expect(merged.locality).toBe('Hangzhou');
    expect(merged.sublocality).toBe('Gongshu District');
    expect(merged.adminAreas).toEqual({ aal1: 'Zhejiang', aal2: null });
    expect(merged.city).toBe('Hangzhou');

    // Everything else preserved byte-identical from existing, not fresh.
    expect(merged.placeId).toBe('ChIJ-abc');
    expect(merged.name).toBe('Park Hyatt Hangzhou');
    expect(merged.address).toBe('1 Hubin Road, Hangzhou, China');
    expect(merged.lat).toBe(30.25);
    expect(merged.lng).toBe(120.15);
    expect(merged.tz).toBe('Asia/Shanghai');
    expect(merged.someFutureField).toBe('untouched-value');
  });

  it('does not mutate its inputs', () => {
    const existing = { placeId: 'p1', locality: '杭州市', name: 'Hotel' };
    const fresh = { countryCode: 'CN', locality: 'Hangzhou', sublocality: null, adminAreas: null, city: 'Hangzhou' };
    const existingSnapshot = JSON.stringify(existing);
    const freshSnapshot = JSON.stringify(fresh);

    mergeRefetchedFields(existing, fresh);

    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(fresh)).toBe(freshSnapshot);
  });
});
