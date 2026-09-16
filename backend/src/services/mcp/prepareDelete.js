// Plan 28 W3.5 (D-28-8): delete_booking exists ONLY as prepare_delete → apply_draft —
// the sole destructive MCP tool, and it never runs without a preview the user has seen.
// I-28-2: linked costs are kept and unlinked unless the client names them in
// deleteExpenseIds, exactly like the app's BookingDeleteReview default.
import { createHash } from 'crypto';
import { getDb } from '../../db/database.js';
import { assertBookingAccess } from '../trips.js';
import { fetchOwedRows } from '../expenses.js';
import { formatMinor } from '../../utils/currency.js';
import { computeBookingFingerprint } from './drafts.js';

// Mirrors frontend/src/utils/owedNames.js's normalizeOwedName exactly — a comparison
// key only, never a rewrite of the stored name. Duplicated rather than shared because
// backend and frontend have no shared module today (same split as utils/currency.js).
function normalizeOwedName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '');
}

function openRepaymentsConsequence(ownerRows, currency) {
  if (ownerRows.length === 0) return null;
  const sum = ownerRows.reduce((total, row) => total + row.amount, 0);
  const people = new Set(ownerRows.map((row) => normalizeOwedName(row.name))).size;
  if (people === 1) {
    return `includes ${ownerRows[0].name}'s ${formatMinor(sum, currency)} open repayment`;
  }
  return `includes ${formatMinor(sum, currency)} in open repayments across ${people} people`;
}

// Mirrors BookingDeleteReview.jsx's formatOpenRepaymentsAggregate: sums open owed rows
// per currency across every willDelete expense, joined with ' + ', never summed across
// currencies.
function formatOpenRepaymentsAggregate(byCurrency) {
  if (byCurrency.size === 0) return null;
  return [...byCurrency.entries()].map(([currency, amount]) => formatMinor(amount, currency)).join(' + ');
}

export function validateDelete({ userId, bookingId, deleteExpenseIds }) {
  let bookingRow;
  try {
    bookingRow = assertBookingAccess(userId, bookingId);
  } catch (error) {
    if (error.status === 404) {
      // Never distinguish "doesn't exist" from "exists but not yours" (mirrors
      // services/mcp/uploads.js's assertBookingAccessOr).
      throw Object.assign(new Error('Booking not found'), { code: 'not_found', status: 404 });
    }
    throw error;
  }

  const rawIds = deleteExpenseIds === undefined || deleteExpenseIds === null ? [] : deleteExpenseIds;
  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw Object.assign(new Error('deleteExpenseIds must be an array of expense ids'), { code: 'invalid_argument', status: 400 });
  }
  const requestedIds = new Set(rawIds);

  const db = getDb();

  const linkedStopRows = db.prepare(`
    SELECT s.id, s.title, s.booking_required, d.date AS day_date
    FROM stops s
    JOIN days d ON d.id = s.day_id
    WHERE s.booking_id = ?
    ORDER BY s.booking_required DESC, s.id
  `).all(bookingId);
  const linkedStopIds = linkedStopRows.map((row) => row.id);
  // deleteBooking removes EVERY booking_required stop and unlinks the rest — the
  // apply result reports exactly that split, not just the headline linkedStop.
  const requiredStopIds = linkedStopRows.filter((row) => row.booking_required).map((row) => row.id);
  const linkedStop = linkedStopRows.length > 0
    ? {
      id: linkedStopRows[0].id,
      title: linkedStopRows[0].title,
      dayDate: linkedStopRows[0].day_date,
      effect: linkedStopRows[0].booking_required ? 'willDelete' : 'willUnlink',
    }
    : null;

  const expenseRows = db.prepare(`
    SELECT * FROM expenses WHERE booking_id = ? ORDER BY expense_date, id
  `).all(bookingId);
  const linkedExpenseIds = expenseRows.map((row) => row.id);

  const issues = [];
  for (const id of requestedIds) {
    if (!linkedExpenseIds.includes(id)) {
      issues.push({
        severity: 'blocker', code: 'expense_not_linked', field: 'deleteExpenseIds', expenseId: id,
        message: `Expense ${id} is not linked to this booking.`,
      });
    }
  }

  const openByCurrency = new Map();
  const linkedExpenses = expenseRows.map((row) => {
    const effect = requestedIds.has(row.id) ? 'willDelete' : 'willUnlink';
    const entry = {
      id: row.id,
      description: row.title || row.category,
      amountMinor: row.amount,
      currency: row.currency,
      effect,
    };
    if (effect === 'willDelete') {
      const openRows = fetchOwedRows(db, row.id).filter((o) => !o.settled);
      const consequence = openRepaymentsConsequence(openRows, row.currency);
      if (consequence) {
        entry.openRepayments = consequence;
        const sum = openRows.reduce((total, o) => total + o.amount, 0);
        openByCurrency.set(row.currency, (openByCurrency.get(row.currency) || 0) + sum);
      }
    }
    return entry;
  });

  return {
    booking: {
      id: bookingRow.id,
      type: bookingRow.type,
      title: bookingRow.title,
      confirmationRef: bookingRow.confirmation_ref,
      startDatetime: bookingRow.start_datetime,
      tripId: bookingRow.trip_id,
    },
    linkedStop,
    linkedStopIds,
    requiredStopIds,
    linkedExpenses,
    linkedExpenseIds,
    deleteExpenseIds: [...requestedIds],
    openRepaymentsAggregate: formatOpenRepaymentsAggregate(openByCurrency),
    issues,
    applyAllowed: issues.length === 0,
  };
}

// Schema note: "additionally covers the linked stop id and linked expense ids" — every
// currently-linked expense, not only the ones named in deleteExpenseIds, so a cost
// added (or removed) after preview goes stale rather than silently surviving or dying.
export function computeDeleteFingerprint(bookingRow, linkedStopIds, linkedExpenseIds) {
  const base = computeBookingFingerprint(bookingRow.tripId ?? bookingRow.trip_id);
  const stopsPart = [...linkedStopIds].sort().join(',');
  const expensesPart = [...linkedExpenseIds].sort().join(',');
  return createHash('sha256').update(`${base}::${stopsPart}::${expensesPart}`).digest('hex');
}

export function summarizeDelete(validation) {
  const { booking, linkedStop, linkedExpenses, openRepaymentsAggregate } = validation;
  const dateLabel = (booking.startDatetime || '').slice(0, 10) || 'no date';
  const parts = [`Delete ${booking.type || 'booking'} "${booking.title}" (${dateLabel})`];

  if (linkedStop) {
    parts.push(linkedStop.effect === 'willDelete'
      ? `its stop on ${linkedStop.dayDate} will be removed`
      : `its stop on ${linkedStop.dayDate} will be kept and unlinked`);
  }

  const willUnlink = linkedExpenses.filter((e) => e.effect === 'willUnlink');
  const willDelete = linkedExpenses.filter((e) => e.effect === 'willDelete');

  if (willUnlink.length === 1) {
    parts.push(`1 linked cost (${formatMinor(willUnlink[0].amountMinor, willUnlink[0].currency)}) will be kept and unlinked`);
  } else if (willUnlink.length > 1) {
    parts.push(`${willUnlink.length} linked costs will be kept and unlinked`);
  }

  if (willDelete.length > 0) {
    const suffix = openRepaymentsAggregate ? ` (includes ${openRepaymentsAggregate} in open repayments)` : '';
    parts.push(`${willDelete.length} linked cost${willDelete.length === 1 ? '' : 's'} will be deleted${suffix}`);
  }

  return `${parts.join('; ')}.`;
}
