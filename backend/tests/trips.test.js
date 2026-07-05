import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip, updateTrip } from '../src/services/trips.js';

let tmpDir;
let owner;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-trips-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
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
