import { getDb } from '../db/database.js';
import { syncStopWithBooking } from './stops.js';
import { assertBookingAccess, assertTripAccess } from './trips.js';

function parseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function formatBooking(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    title: row.title,
    confirmationRef: row.confirmation_ref,
    bookingSource: row.booking_source,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    origin: row.origin,
    destination: row.destination,
    terminalOrStation: row.terminal_or_station,
    showInItinerary: Boolean(row.show_in_itinerary),
    originTz:      row.origin_tz      || null,
    destinationTz: row.destination_tz || null,
    detailsJson: parseJson(row.details_json),
    createdAt: row.created_at,
  };
}

function normalizeDetailsJson(value) {
  if (!value) return '{}';
  return JSON.stringify(value);
}

function validateBookingPayload(input, { partial = false } = {}) {
  if (!partial || input.type !== undefined) {
    if (!input.type) {
      throw Object.assign(new Error('Booking type is required'), { status: 400 });
    }
  }

  if (!partial || input.title !== undefined) {
    if (!input.title?.trim()) {
      throw Object.assign(new Error('Booking title is required'), { status: 400 });
    }
  }
}

function defaultShowInItinerary(input) {
  if (input.showInItinerary !== undefined) return input.showInItinerary ? 1 : 0;
  if (input.type === 'hotel' || input.type === 'train' || input.type === 'flight') return 1;
  if (input.type === 'other') return input.startDatetime && input.destination ? 1 : 0;
  return 0;
}

export function listBookings(userId, tripId) {
  assertTripAccess(userId, tripId);
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM bookings
    WHERE trip_id = ?
    ORDER BY COALESCE(start_datetime, end_datetime, created_at) ASC, created_at ASC
  `).all(tripId).map(formatBooking);
}

export async function createBooking(userId, tripId, input) {
  validateBookingPayload(input);
  assertTripAccess(userId, tripId);
  const db = getDb();

  const row = db.prepare(`
    INSERT INTO bookings (
      trip_id, type, title, confirmation_ref, booking_source, start_datetime, end_datetime,
      origin, destination, terminal_or_station, details_json, show_in_itinerary,
      origin_tz, destination_tz
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    tripId,
    input.type,
    input.title.trim(),
    input.confirmationRef || null,
    input.bookingSource || null,
    input.startDatetime || null,
    input.endDatetime || null,
    input.origin || null,
    input.destination || null,
    input.terminalOrStation || null,
    normalizeDetailsJson(input.detailsJson),
    defaultShowInItinerary(input),
    input.originTz      || null,
    input.destinationTz || null,
  );

  await syncStopWithBooking(row);
  return formatBooking(row);
}

export async function updateBooking(userId, bookingId, input) {
  validateBookingPayload(input, { partial: true });
  const existing = assertBookingAccess(userId, bookingId);
  const db = getDb();

  const row = db.prepare(`
    UPDATE bookings
    SET
      type = ?,
      title = ?,
      confirmation_ref = ?,
      booking_source = ?,
      start_datetime = ?,
      end_datetime = ?,
      origin = ?,
      destination = ?,
      terminal_or_station = ?,
      details_json = ?,
      show_in_itinerary = ?,
      origin_tz = ?,
      destination_tz = ?
    WHERE id = ?
    RETURNING *
  `).get(
    input.type ?? existing.type,
    input.title?.trim() ?? existing.title,
    input.confirmationRef ?? existing.confirmation_ref,
    input.bookingSource ?? existing.booking_source,
    input.startDatetime ?? existing.start_datetime,
    input.endDatetime ?? existing.end_datetime,
    input.origin ?? existing.origin,
    input.destination ?? existing.destination,
    input.terminalOrStation ?? existing.terminal_or_station,
    input.detailsJson !== undefined ? normalizeDetailsJson(input.detailsJson) : existing.details_json,
    input.showInItinerary !== undefined ? (input.showInItinerary ? 1 : 0) : existing.show_in_itinerary,
    input.originTz      !== undefined ? (input.originTz      || null) : existing.origin_tz,
    input.destinationTz !== undefined ? (input.destinationTz || null) : existing.destination_tz,
    bookingId,
  );

  await syncStopWithBooking(row);
  return formatBooking(row);
}

export function deleteBooking(userId, bookingId) {
  const db = getDb();
  assertBookingAccess(userId, bookingId);
  db.prepare('DELETE FROM stops WHERE booking_id = ? AND booking_required = 1').run(bookingId);
  db.prepare('UPDATE stops SET booking_id = NULL WHERE booking_id = ?').run(bookingId);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(bookingId);
  return { ok: true };
}
