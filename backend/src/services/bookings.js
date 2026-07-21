import { getDb } from '../db/database.js';
import { syncStopWithBooking } from './stops.js';
import { assertBookingAccess, assertTripAccess } from './trips.js';
import { resolveBookingDocuments } from './documents.js';
import { prepareExpenseCreate, insertPreparedExpense, finalizeExpenseCreate } from './expenses.js';

function parseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function formatBooking(row, expenseSummary = null) {
  const detailsJson = parseJson(row.details_json);
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
    detailsJson,
    createdAt: row.created_at,
    documents: resolveBookingDocuments(row.id, detailsJson),
    expenseSummary: expenseSummary || null,
  };
}

// One grouped query for the whole trip — never per-booking. MIN() columns are only
// trusted when count = 1, where they identify the sole linked expense exactly.
function computeBookingExpenseSummaries(tripId) {
  const rows = getDb().prepare(`
    SELECT booking_id, COUNT(*) AS count,
           MIN(id) AS only_expense_id, MIN(amount) AS only_amount, MIN(currency) AS only_currency
    FROM expenses WHERE trip_id = ? AND booking_id IS NOT NULL
    GROUP BY booking_id
  `).all(tripId);

  const map = new Map();
  for (const row of rows) {
    map.set(row.booking_id, {
      count: row.count,
      single: row.count === 1
        ? { expenseId: row.only_expense_id, amount: row.only_amount, currency: row.only_currency }
        : null,
    });
  }
  return map;
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
  const rows = db.prepare(`
    SELECT *
    FROM bookings
    WHERE trip_id = ?
    ORDER BY COALESCE(start_datetime, end_datetime, created_at) ASC, created_at ASC
  `).all(tripId);
  const summaries = computeBookingExpenseSummaries(tripId);
  return rows.map((row) => formatBooking(row, summaries.get(row.id) || null));
}

export async function createBooking(userId, tripId, input) {
  validateBookingPayload(input);
  assertTripAccess(userId, tripId);
  const db = getDb();

  // A `cost` alongside the booking is prepared (validated + resolved) BEFORE any
  // write, so an invalid cost throws with nothing persisted — the transaction below
  // never opens on an already-doomed cost payload.
  let preparedCost = null;
  if (input.cost) {
    if (input.cost.bookingId !== undefined) {
      throw Object.assign(new Error('cost must not carry a bookingId — it links to the booking being created'), { status: 400 });
    }
    preparedCost = prepareExpenseCreate(userId, tripId, input.cost);
  }

  let row;
  let expenseId;
  const run = db.transaction(() => {
    row = db.prepare(`
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

    if (preparedCost) {
      expenseId = insertPreparedExpense(db, preparedCost, row.id);
    }
  });
  run();

  const expenseSummary = preparedCost
    ? { count: 1, single: { expenseId, amount: preparedCost.input.amount, currency: preparedCost.currency } }
    : null;
  if (preparedCost) {
    finalizeExpenseCreate(preparedCost, expenseId);
  }

  await syncStopWithBooking(row);
  return formatBooking(row, expenseSummary);
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
  // Editing a booking never changes its expense linkage — the caller already holds
  // an accurate expenseSummary from its last list/detail load, so this response
  // doesn't need to recompute it.
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
