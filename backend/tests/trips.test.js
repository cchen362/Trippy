import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip, updateTrip, listDaysForTrip, getDayGeo } from '../src/services/trips.js';

let tmpDir;
let owner;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-trips-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function makeTrip(overrides = {}) {
  return createTrip(owner.id, {
    title: 'Sichuan Trip',
    destinations: ['Chengdu'],
    destinationCountries: ['CN'],
    startDate: '2026-09-10',
    endDate: '2026-09-20',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
    ...overrides,
  });
}

function dayIdFor(tripId, date) {
  return getDb().prepare('SELECT id FROM days WHERE trip_id = ? AND date = ?').get(tripId, date).id;
}

function addStopOnDate(tripId, date) {
  const dayId = dayIdFor(tripId, date);
  getDb().prepare(`
    INSERT INTO stops (day_id, title, type) VALUES (?, 'Test Stop', 'explore')
  `).run(dayId);
}

describe('updateTrip — end-date extend/shorten (existing behavior, parity coverage)', () => {
  it('extends the trip end date and auto-creates new day rows seeded with the default city', () => {
    const trip = makeTrip();
    const updated = updateTrip(owner.id, trip.trip.id, { endDate: '2026-09-23' });

    expect(updated.trip.endDate).toBe('2026-09-23');
    const newDates = updated.days.filter((d) => d.date > '2026-09-20').map((d) => d.date);
    expect(newDates).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect(updated.days.find((d) => d.date === '2026-09-21').city).toBe('Chengdu');
  });

  it('shortens the trip end date and deletes the removed day rows when they have no stops', () => {
    const trip = makeTrip();
    const updated = updateTrip(owner.id, trip.trip.id, { endDate: '2026-09-15' });

    expect(updated.trip.endDate).toBe('2026-09-15');
    expect(updated.days.some((d) => d.date > '2026-09-15')).toBe(false);
  });

  it('blocks shortening the end date when a removed day has stops', () => {
    const trip = makeTrip();
    addStopOnDate(trip.trip.id, '2026-09-18');

    expect(() => updateTrip(owner.id, trip.trip.id, { endDate: '2026-09-15' }))
      .toThrow(/Cannot shorten trip.*2026-09-18/);
  });
});

describe('updateTrip — start-date extend/shorten (M4)', () => {
  it('extends the trip start date backward and auto-creates new day rows seeded with the default city', () => {
    const trip = makeTrip();
    const updated = updateTrip(owner.id, trip.trip.id, { startDate: '2026-09-07' });

    expect(updated.trip.startDate).toBe('2026-09-07');
    const newDates = updated.days.filter((d) => d.date < '2026-09-10').map((d) => d.date).sort();
    expect(newDates).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
    expect(updated.days.find((d) => d.date === '2026-09-07').city).toBe('Chengdu');
  });

  it('shortens the trip start date and deletes the removed day rows when they have no stops', () => {
    const trip = makeTrip();
    const updated = updateTrip(owner.id, trip.trip.id, { startDate: '2026-09-13' });

    expect(updated.trip.startDate).toBe('2026-09-13');
    expect(updated.days.some((d) => d.date < '2026-09-13')).toBe(false);
  });

  it('blocks shortening the start date when a removed day has stops', () => {
    const trip = makeTrip();
    addStopOnDate(trip.trip.id, '2026-09-11');

    expect(() => updateTrip(owner.id, trip.trip.id, { startDate: '2026-09-13' }))
      .toThrow(/Cannot shorten trip.*2026-09-11/);
  });

  it('is a no-op when startDate equals the existing start date', () => {
    const trip = makeTrip();
    const updated = updateTrip(owner.id, trip.trip.id, { startDate: '2026-09-10' });
    expect(updated.trip.startDate).toBe('2026-09-10');
    expect(updated.days).toHaveLength(11); // unchanged day count
  });
});

function rawDay(tripId, date) {
  return getDb().prepare('SELECT city, city_country FROM days WHERE trip_id = ? AND date = ?').get(tripId, date);
}

describe('createTrip — paired destinations (Plan 6 Wave 1)', () => {
  it('accepts destinations as {city, countryCode} pairs and seeds city_country from the first pair', () => {
    const trip = createTrip(owner.id, {
      title: 'Multi-city Trip',
      destinations: [{ city: 'Chengdu', countryCode: 'CN' }, { city: 'Chongqing', countryCode: 'CN' }],
      startDate: '2026-09-10',
      endDate: '2026-09-12',
      travellers: 'solo',
      interestTags: [],
      pace: 'moderate',
    });

    expect(trip.trip.destinations).toEqual(['Chengdu', 'Chongqing']);
    expect(trip.trip.destinationCountries).toEqual(['CN', 'CN']);
    const day = rawDay(trip.trip.id, '2026-09-10');
    expect(day.city).toBe('Chengdu');
    expect(day.city_country).toBe('CN');
  });

  it('still accepts the legacy string-array destinations shape', () => {
    const trip = makeTrip();
    const day = rawDay(trip.trip.id, '2026-09-10');
    expect(day.city).toBe('Chengdu');
    expect(day.city_country).toBe('CN');
  });
});

describe('updateTrip — extension seeding from the adjacent day (Plan 6 Wave 1)', () => {
  it("seeds a forward extension from the current last day's pair, not destinations[0]", () => {
    const trip = makeTrip(); // destinations ['Chengdu'] / ['CN'], 2026-09-10..20
    // Simulate the last day's resolved identity having diverged from the trip's first destination.
    getDb().prepare('UPDATE days SET city = ?, city_country = ? WHERE trip_id = ? AND date = ?')
      .run('Chongqing', 'CN', trip.trip.id, '2026-09-20');

    const updated = updateTrip(owner.id, trip.trip.id, { endDate: '2026-09-22' });
    const newDay = updated.days.find((d) => d.date === '2026-09-21');
    expect(newDay.city).toBe('Chongqing');
    expect(rawDay(trip.trip.id, '2026-09-21').city_country).toBe('CN');
  });

  it("seeds a backward extension from the current first day's pair, not destinations[0]", () => {
    const trip = makeTrip();
    getDb().prepare('UPDATE days SET city = ?, city_country = ? WHERE trip_id = ? AND date = ?')
      .run('Macau', 'MO', trip.trip.id, '2026-09-10');

    const updated = updateTrip(owner.id, trip.trip.id, { startDate: '2026-09-08' });
    const newDay = updated.days.find((d) => d.date === '2026-09-09');
    expect(newDay.city).toBe('Macau');
    expect(rawDay(trip.trip.id, '2026-09-09').city_country).toBe('MO');
  });
});

describe('deriveDayGeo / listDaysForTrip resolvedCountry (Plan 6 Wave 2)', () => {
  it('China-only trip: every day resolves the seeded country (regression anchor)', () => {
    const trip = makeTrip();
    const days = listDaysForTrip(trip.trip.id, owner.id, []);
    expect(days.every((d) => d.resolvedCity === 'Chengdu' && d.resolvedCountry === 'CN')).toBe(true);
  });

  it('carries the pair forward from the previous day when a later day has no seed country', () => {
    const trip = makeTrip();
    const db = getDb();
    // A hotel booking (layer 2) is what actually moves a day's resolved city mid-trip —
    // the previous-day layer (4) outranks the seed (5), so only override/hotel/transit
    // evidence can make a day diverge from what the day before it resolved to.
    db.prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Chongqing Hotel', '2026-09-11T15:00', '2026-09-12T11:00', ?)
    `).run(trip.trip.id, JSON.stringify({ city: 'Chongqing', countryCode: 'CN' }));
    db.prepare('UPDATE days SET city_country = NULL WHERE trip_id = ? AND date = ?')
      .run(trip.trip.id, '2026-09-12');

    const bookings = db.prepare('SELECT * FROM bookings WHERE trip_id = ?').all(trip.trip.id)
      .map((row) => ({
        type: row.type,
        startDatetime: row.start_datetime,
        endDatetime: row.end_datetime,
        detailsJson: JSON.parse(row.details_json),
      }));

    const days = listDaysForTrip(trip.trip.id, owner.id, bookings);
    const day11 = days.find((d) => d.date === '2026-09-11');
    const day12 = days.find((d) => d.date === '2026-09-12');
    expect(day11.resolvedCity).toBe('Chongqing');
    expect(day11.resolvedCountry).toBe('CN');
    expect(day12.resolvedCity).toBe('Chongqing'); // carried forward from 09-11
    expect(day12.resolvedCountry).toBe('CN'); // carried forward despite the null seed country
  });

  it('city and country may come from different layers: override city with no country falls through to the active hotel country', () => {
    const trip = makeTrip();
    const db = getDb();
    db.prepare('UPDATE days SET city_override = ? WHERE trip_id = ? AND date = ?')
      .run('Melaka', trip.trip.id, '2026-09-10');
    db.prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Melaka Hotel', '2026-09-10T15:00', '2026-09-11T11:00', ?)
    `).run(trip.trip.id, JSON.stringify({ city: 'Melaka', countryCode: 'MY' }));

    const bookings = db.prepare('SELECT * FROM bookings WHERE trip_id = ?').all(trip.trip.id)
      .map((row) => ({
        type: row.type,
        startDatetime: row.start_datetime,
        endDatetime: row.end_datetime,
        detailsJson: JSON.parse(row.details_json),
      }));

    const days = listDaysForTrip(trip.trip.id, owner.id, bookings);
    const day10 = days.find((d) => d.date === '2026-09-10');
    expect(day10.resolvedCity).toBe('Melaka'); // override wins city
    expect(day10.resolvedCountry).toBe('MY'); // no country on the override — falls through to the hotel
  });

  it('missing-country trip: a null-country day falls through the whole precedence to null', () => {
    const trip = createTrip(owner.id, {
      title: 'KL Trip',
      destinations: ['Kuala Lumpur'],
      destinationCountries: [],
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      travellers: 'couple',
      interestTags: [],
      pace: 'moderate',
    });
    const days = listDaysForTrip(trip.trip.id, owner.id, []);
    expect(days[0].resolvedCity).toBe('Kuala Lumpur');
    expect(days[0].resolvedCountry).toBeNull();
  });
});

describe('updateTrip — destination chip editor semantics (Plan 6 Wave 3 §3.3)', () => {
  it('renaming a chip updates the seed on matching non-override days only', () => {
    const trip = createTrip(owner.id, {
      title: 'Multi-city Trip',
      destinations: [{ city: 'Chengdu', countryCode: 'CN' }, { city: 'Chongqing', countryCode: 'CN' }],
      startDate: '2026-09-10',
      endDate: '2026-09-12',
      travellers: 'solo',
      interestTags: [],
      pace: 'moderate',
    });
    const tripId = trip.trip.id;
    // All three days seed to 'Chengdu' by default (createTrip seeds every day from the
    // first pair) — set day 3 to 'Chongqing' to simulate a real multi-city seed, and mark
    // day 2 as having an override so we can verify it's left untouched.
    getDb().prepare('UPDATE days SET city = ?, city_country = ? WHERE trip_id = ? AND date = ?')
      .run('Chongqing', 'CN', tripId, '2026-09-12');
    getDb().prepare('UPDATE days SET city_override = ?, city_override_country = ? WHERE trip_id = ? AND date = ?')
      .run('Chengdu Old Town', 'CN', tripId, '2026-09-11');

    // Rename 'Chengdu' -> 'Chengdu Renamed' (same slot/index 0)
    const updated = updateTrip(owner.id, tripId, {
      destinations: [{ city: 'Chengdu Renamed', countryCode: 'CN' }, { city: 'Chongqing', countryCode: 'CN' }],
    });

    expect(updated.trip.destinations).toEqual(['Chengdu Renamed', 'Chongqing']);
    // day 09-10 had seed 'Chengdu', no override -> retargeted to the renamed pair
    const day10 = rawDay(tripId, '2026-09-10');
    expect(day10.city).toBe('Chengdu Renamed');
    expect(day10.city_country).toBe('CN');
    // day 09-11 has an override -> untouched (seed AND override both unchanged)
    const day11 = getDb().prepare('SELECT city, city_country, city_override, city_override_country FROM days WHERE trip_id = ? AND date = ?').get(tripId, '2026-09-11');
    expect(day11.city_override).toBe('Chengdu Old Town');
    expect(day11.city_override_country).toBe('CN');
    // day 09-12 already seeded to 'Chongqing' (still present in the new list) -> untouched
    const day12 = rawDay(tripId, '2026-09-12');
    expect(day12.city).toBe('Chongqing');
  });

  it('reordering chips alone does not rewrite any day seed', () => {
    const trip = createTrip(owner.id, {
      title: 'Multi-city Trip',
      destinations: [{ city: 'Chengdu', countryCode: 'CN' }, { city: 'Chongqing', countryCode: 'CN' }],
      startDate: '2026-09-10',
      endDate: '2026-09-11',
      travellers: 'solo',
      interestTags: [],
      pace: 'moderate',
    });
    const tripId = trip.trip.id;
    getDb().prepare('UPDATE days SET city = ?, city_country = ? WHERE trip_id = ? AND date = ?')
      .run('Chongqing', 'CN', tripId, '2026-09-11');

    const before10 = rawDay(tripId, '2026-09-10');
    const before11 = rawDay(tripId, '2026-09-11');

    // Same two cities, reversed order — no rename, no removal
    updateTrip(owner.id, tripId, {
      destinations: [{ city: 'Chongqing', countryCode: 'CN' }, { city: 'Chengdu', countryCode: 'CN' }],
    });

    const after10 = rawDay(tripId, '2026-09-10');
    const after11 = rawDay(tripId, '2026-09-11');
    expect(after10).toEqual(before10);
    expect(after11).toEqual(before11);
  });

  it('removing a chip with no replacement at that slot nulls the seed country and keeps the city (no explicit replacement)', () => {
    const trip = makeTrip(); // single destination 'Chengdu'/'CN'
    const tripId = trip.trip.id;

    updateTrip(owner.id, tripId, { destinations: [] });

    const day = rawDay(tripId, '2026-09-10');
    // No replacement pair at index 0 -> city left as-is, country cleared (per implementation:
    // replacement?.city ?? day.city, replacement?.countryCode ?? null)
    expect(day.city).toBe('Chengdu');
    expect(day.city_country).toBeNull();
  });
});

describe('getDayGeo (Plan 6 Wave 2 — geocoding-bias helper)', () => {
  it('resolves the same pair listDaysForTrip would, for a single dayId', () => {
    const trip = makeTrip();
    const dayId = dayIdFor(trip.trip.id, '2026-09-10');
    const geo = getDayGeo(dayId);
    expect(geo).toEqual({ city: 'Chengdu', countryCode: 'CN' });
  });

  it('carries the previous day pair forward when walking to the target day', () => {
    const trip = makeTrip();
    getDb().prepare(`
      INSERT INTO bookings (trip_id, type, title, start_datetime, end_datetime, details_json)
      VALUES (?, 'hotel', 'Chongqing Hotel', '2026-09-11T15:00', '2026-09-12T11:00', ?)
    `).run(trip.trip.id, JSON.stringify({ city: 'Chongqing', countryCode: 'CN' }));
    const dayId = dayIdFor(trip.trip.id, '2026-09-12');
    const geo = getDayGeo(dayId);
    expect(geo).toEqual({ city: 'Chongqing', countryCode: 'CN' });
  });
});
