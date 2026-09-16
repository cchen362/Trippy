import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

// Mock only the EXTERNAL I/O reached through stops.js — geocoding, Unsplash, and the Haiku
// photo descriptor. The real resolve/write split, and the rest of the write path, run for
// real against a temp SQLite DB. Plan 28 W2.2 (F-28-5).
vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: vi.fn().mockResolvedValue({
    lat: 35.0, lng: 135.7, resolvedName: 'Resolved Place', resolvedAddress: 'Some Address',
    coordinateSystem: 'wgs84', coordinateSource: 'nominatim', locationStatus: 'resolved',
    confidence: 0.9, providerId: 'osm:1', countryCode: 'JP',
  }),
}));
vi.mock('../src/services/unsplash.js', () => ({
  selectPhoto: vi.fn().mockResolvedValue(null),
  trackDownload: vi.fn(),
}));
vi.mock('../src/services/claude.js', () => ({
  generatePhotoDescriptor: vi.fn().mockResolvedValue(null),
}));

const {
  resolveBookingStopData,
  writeBookingStop,
  syncStopWithBooking,
} = await import('../src/services/stops.js');
const { writeBookingRow } = await import('../src/services/bookings.js');
const { createTrip } = await import('../src/services/trips.js');
const authService = await import('../src/services/auth.js');

let tmpDir;
let userId;
let tripId;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-booking-stop-split-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  userId = authService.setup('split-owner', 'password123', 'Split Owner').user.id;
  const trip = createTrip(userId, {
    title: 'Kyoto Trip',
    startDate: '2026-05-01',
    endDate: '2026-05-03',
    destinations: ['Kyoto'],
    destinationCountries: ['JP'],
  }).trip;
  tripId = trip.id;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function hotelInput(overrides = {}) {
  return {
    type: 'hotel',
    title: 'Hotel Gion',
    startDatetime: '2026-05-01T15:00:00',
    endDatetime: '2026-05-02T11:00:00',
    destination: 'Kyoto',
    ...overrides,
  };
}

describe('resolveBookingStopData / writeBookingStop split', () => {
  it('resolves and writes a stop for a hotel booking inside trip dates', async () => {
    const booking = writeBookingRow(tripId, hotelInput());

    const resolved = await resolveBookingStopData(booking);
    expect(resolved.ok).toBe(true);
    expect(resolved.day.date).toBe('2026-05-01');

    const stop = writeBookingStop(resolved);
    expect(stop).toBeTruthy();

    const rows = getDb().prepare('SELECT * FROM stops WHERE booking_id = ?').all(booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].booking_id).toBe(booking.id);
    expect(rows[0].booking_required).toBe(1);
  });

  it('returns no_day_for_date when the booking date falls outside the trip', async () => {
    const booking = writeBookingRow(tripId, hotelInput({
      startDatetime: '2026-06-15T15:00:00',
      endDatetime: '2026-06-16T11:00:00',
    }));

    const resolved = await resolveBookingStopData(booking);
    expect(resolved).toMatchObject({ ok: false, reason: 'no_day_for_date' });

    const stop = writeBookingStop(resolved);
    expect(stop).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM stops WHERE booking_id = ?').get(booking.id).c).toBe(0);
  });

  it('returns not_shown_in_itinerary when showInItinerary is false', async () => {
    const booking = writeBookingRow(tripId, hotelInput({ showInItinerary: false }));
    expect(booking.show_in_itinerary).toBe(0);

    const resolved = await resolveBookingStopData(booking);
    expect(resolved).toMatchObject({ ok: false, reason: 'not_shown_in_itinerary' });

    const stop = writeBookingStop(resolved);
    expect(stop).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM stops WHERE booking_id = ?').get(booking.id).c).toBe(0);
  });

  it('is transaction-safe: a throw after writeBookingStop leaves no stop row persisted', async () => {
    const booking = writeBookingRow(tripId, hotelInput());
    const resolved = await resolveBookingStopData(booking);

    const db = getDb();
    expect(() => {
      db.transaction(() => {
        writeBookingStop(resolved);
        throw new Error('boom');
      })();
    }).toThrow('boom');

    expect(getDb().prepare('SELECT COUNT(*) AS c FROM stops WHERE booking_id = ?').get(booking.id).c).toBe(0);
  });

  it('syncStopWithBooking produces the same stop row as resolve+write for the same booking input', async () => {
    const bookingA = writeBookingRow(tripId, hotelInput());
    const bookingB = writeBookingRow(tripId, hotelInput());

    const resolvedA = await resolveBookingStopData(bookingA);
    const stopA = writeBookingStop(resolvedA);

    const stopBFormatted = await syncStopWithBooking(bookingB);
    expect(stopBFormatted).toBeTruthy();

    const rowA = getDb().prepare('SELECT * FROM stops WHERE booking_id = ?').get(bookingA.id);
    const rowB = getDb().prepare('SELECT * FROM stops WHERE booking_id = ?').get(bookingB.id);

    const ignoredKeys = new Set(['id', 'booking_id', 'day_id', 'created_at', 'sort_order']);
    const stripped = (row) => Object.fromEntries(
      Object.entries(row).filter(([key]) => !ignoredKeys.has(key)),
    );

    expect(stripped(rowA)).toEqual(stripped(rowB));
    expect(stopA).toBeTruthy();
  });
});
