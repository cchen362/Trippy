// Plan 19 Wave 1: trip expenses — shared spending diary with owed amounts.
// CRUD is transactional (expense + owed rows atomic). FX conversion into the trip's
// summary currency NEVER blocks a save — it is stamped asynchronously via setImmediate
// after the response-producing call returns, per D5. Money is always integer minor units.
import { getDb } from '../db/database.js';
import { assertTripAccess } from './trips.js';
import { getRate } from './fx.js';
import { minorUnitsFor } from '../utils/currency.js';

const CATEGORIES = new Set(['lodging', 'transport', 'food', 'activity', 'shopping', 'other']);

// Overall budget for the same-request stamping wait in listExpenses (W3.5 item c):
// one bounded window across ALL stragglers, not per-row, so a list with many
// unestimated rows still responds promptly.
const LIST_STAMP_BUDGET_MS = 700;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundHalfUp(value) {
  return Math.floor(value + 0.5);
}

function convertMinor(amountMinor, fromCurrency, rate, toCurrency) {
  if (amountMinor == null || rate == null) return null;
  const major = amountMinor / 10 ** minorUnitsFor(fromCurrency);
  const convertedMajor = major * rate;
  return roundHalfUp(convertedMajor * 10 ** minorUnitsFor(toCurrency));
}

function isTripMember(tripId, userId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM trips t
    LEFT JOIN trip_collaborators tc ON tc.trip_id = t.id
    WHERE t.id = ? AND (t.owner_id = ? OR tc.user_id = ?)
    LIMIT 1
  `).get(tripId, userId, userId);
  return Boolean(row);
}

function getTripRow(tripId) {
  return getDb().prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
}

function formatExpense(row, owedRows) {
  return {
    id: row.id,
    tripId: row.trip_id,
    bookingId: row.booking_id,
    payerUserId: row.payer_user_id,
    payerName: row.payer_name,
    title: row.title,
    note: row.note,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    expenseDate: row.expense_date,
    summaryAmount: row.summary_amount,
    summaryCurrency: row.summary_currency,
    fxRate: row.fx_rate,
    fxRateDate: row.fx_rate_date,
    fxSource: row.fx_source,
    owed: owedRows.map((o) => ({
      id: o.id,
      name: o.name,
      amount: o.amount,
      settled: Boolean(o.settled),
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fetchExpenseRow(db, expenseId) {
  return db.prepare(`
    SELECT e.*, u.display_name AS payer_name
    FROM expenses e
    JOIN users u ON u.id = e.payer_user_id
    WHERE e.id = ?
  `).get(expenseId);
}

function fetchOwedRows(db, expenseId) {
  return db.prepare('SELECT * FROM expense_owed WHERE expense_id = ? ORDER BY rowid ASC').all(expenseId);
}

function getExpenseInTripOrThrow(tripId, expenseId) {
  const db = getDb();
  const row = fetchExpenseRow(db, expenseId);
  if (!row || row.trip_id !== tripId) {
    throw Object.assign(new Error('Expense not found'), { status: 404 });
  }
  return row;
}

function validateCategory(category) {
  if (!CATEGORIES.has(category)) {
    throw Object.assign(new Error(`Category must be one of: ${[...CATEGORIES].join(', ')}`), { status: 400 });
  }
}

function validateOwedSum(owed, amount) {
  const sum = owed.reduce((total, o) => total + o.amount, 0);
  if (sum > amount) {
    throw Object.assign(new Error('Owed amounts exceed the expense amount'), { status: 400 });
  }
}

function normalizeOwedInput(owed) {
  if (!Array.isArray(owed)) return [];
  return owed.map((o) => {
    if (!o.name?.trim()) {
      throw Object.assign(new Error('Each owed entry requires a name'), { status: 400 });
    }
    if (!Number.isInteger(o.amount) || o.amount < 0) {
      throw Object.assign(new Error('Owed amount must be a non-negative integer'), { status: 400 });
    }
    return { name: o.name.trim(), amount: o.amount, settled: Boolean(o.settled) };
  });
}

function resolveBookingId(tripId, bookingId) {
  if (bookingId === undefined || bookingId === null) return null;
  const db = getDb();
  const booking = db.prepare('SELECT id, trip_id FROM bookings WHERE id = ?').get(bookingId);
  if (!booking || booking.trip_id !== tripId) {
    throw Object.assign(new Error('bookingId must belong to this trip'), { status: 400 });
  }
  return booking.id;
}

function resolvePayerUserId(tripId, requestingUserId, payerUserId) {
  const resolved = payerUserId ?? requestingUserId;
  if (!isTripMember(tripId, resolved)) {
    throw Object.assign(new Error('payerUserId must be a trip collaborator or owner'), { status: 400 });
  }
  return resolved;
}

// Computes the FX-facing fields to persist immediately at write time — identity
// (expense currency === trip summary currency) and manual-override paths never touch
// the network, so both resolve synchronously. Anything else leaves summary_amount null
// for the async stamping pass.
function resolveFxOnWrite({ amount, currency, expenseDate, tripSummaryCurrency, manualRate }) {
  if (manualRate !== undefined && manualRate !== null) {
    if (typeof manualRate !== 'number' || !Number.isFinite(manualRate) || manualRate <= 0) {
      throw Object.assign(new Error('manualRate must be a positive number'), { status: 400 });
    }
    if (!tripSummaryCurrency) {
      throw Object.assign(new Error('Trip has no summary currency set'), { status: 400 });
    }
    return {
      summaryAmount: convertMinor(amount, currency, manualRate, tripSummaryCurrency),
      summaryCurrency: tripSummaryCurrency,
      fxRate: manualRate,
      fxRateDate: expenseDate,
      fxSource: 'manual',
    };
  }

  if (tripSummaryCurrency && currency === tripSummaryCurrency) {
    return {
      summaryAmount: amount,
      summaryCurrency: tripSummaryCurrency,
      fxRate: null,
      fxRateDate: null,
      fxSource: null,
    };
  }

  return {
    summaryAmount: null,
    summaryCurrency: tripSummaryCurrency || null,
    fxRate: null,
    fxRateDate: null,
    fxSource: null,
  };
}

// Fire-and-forget provider stamping. Never throws to the caller — errors resolve to
// "leave unestimated," which is the documented D5(e) failure mode.
function scheduleStamp(expenseId) {
  setImmediate(() => {
    stampExpenseFx(expenseId).catch(() => {});
  });
}

async function stampExpenseFx(expenseId) {
  const db = getDb();
  const row = fetchExpenseRow(db, expenseId);
  if (!row || row.summary_amount !== null) return;

  const trip = getTripRow(row.trip_id);
  if (!trip?.summary_currency) return;
  if (row.currency === trip.summary_currency) return;

  const rate = await getRate(row.currency, trip.summary_currency, row.expense_date);
  if (rate == null) return;

  const summaryAmount = convertMinor(row.amount, row.currency, rate, trip.summary_currency);

  db.prepare(`
    UPDATE expenses
    SET summary_amount = ?, summary_currency = ?, fx_rate = ?, fx_rate_date = ?, fx_source = 'provider', updated_at = datetime('now')
    WHERE id = ? AND summary_amount IS NULL
  `).run(summaryAmount, trip.summary_currency, rate, row.expense_date, expenseId);
}

function writeOwedRows(db, expenseId, owed) {
  db.prepare('DELETE FROM expense_owed WHERE expense_id = ?').run(expenseId);
  const insert = db.prepare('INSERT INTO expense_owed (expense_id, name, amount, settled) VALUES (?, ?, ?, ?)');
  for (const o of owed) {
    insert.run(expenseId, o.name, o.amount, o.settled ? 1 : 0);
  }
}

export async function listExpenses(userId, tripId) {
  const trip = assertTripAccess(userId, tripId);
  const db = getDb();

  const rows = db.prepare(`
    SELECT e.*, u.display_name AS payer_name
    FROM expenses e
    JOIN users u ON u.id = e.payer_user_id
    WHERE e.trip_id = ?
    ORDER BY e.expense_date DESC, e.created_at DESC
  `).all(tripId);

  const unestimatedIds = rows.filter((row) => row.summary_amount === null).map((row) => row.id);

  if (unestimatedIds.length > 0 && trip.summary_currency) {
    // Bounded same-request stamping: give the stragglers up to LIST_STAMP_BUDGET_MS
    // (total, not per-row) to resolve so this response can carry healed rows.
    // Attempts that don't finish in time are left running (not cancelled) — they
    // may still stamp the DB after this response is sent, per D5(e).
    const stampPromises = unestimatedIds.map((id) => stampExpenseFx(id).catch(() => {}));
    await Promise.race([Promise.allSettled(stampPromises), delay(LIST_STAMP_BUDGET_MS)]);
  } else {
    for (const id of unestimatedIds) scheduleStamp(id);
  }

  const finalRows = unestimatedIds.length > 0
    ? db.prepare(`
        SELECT e.*, u.display_name AS payer_name
        FROM expenses e
        JOIN users u ON u.id = e.payer_user_id
        WHERE e.trip_id = ?
        ORDER BY e.expense_date DESC, e.created_at DESC
      `).all(tripId)
    : rows;

  const expenses = finalRows.map((row) => formatExpense(row, fetchOwedRows(db, row.id)));

  return {
    expenses,
    totals: computeTotals(tripId, userId, trip.summary_currency),
    summaryCurrency: trip.summary_currency || null,
  };
}

// Validates and resolves a create payload. Performs NO database writes, so a caller
// can fail the whole operation before anything is persisted. Shared by createExpense
// and the composite booking+cost path in bookings.js.
export function prepareExpenseCreate(userId, tripId, input) {
  const trip = assertTripAccess(userId, tripId);

  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw Object.assign(new Error('amount is required and must be a positive integer'), { status: 400 });
  }
  if (!input.currency || typeof input.currency !== 'string') {
    throw Object.assign(new Error('currency is required'), { status: 400 });
  }
  if (!input.expenseDate || typeof input.expenseDate !== 'string') {
    throw Object.assign(new Error('expenseDate is required'), { status: 400 });
  }
  validateCategory(input.category);

  const currency = input.currency.trim().toUpperCase();
  const owed = normalizeOwedInput(input.owed);
  validateOwedSum(owed, input.amount);

  const payerUserId = resolvePayerUserId(tripId, userId, input.payerUserId);
  const bookingId = resolveBookingId(tripId, input.bookingId);
  const fx = resolveFxOnWrite({
    amount: input.amount,
    currency,
    expenseDate: input.expenseDate,
    tripSummaryCurrency: trip.summary_currency || null,
    manualRate: input.manualRate,
  });

  return { trip, tripId, input, currency, owed, payerUserId, bookingId, fx };
}

// Performs the expense + owed row inserts. MUST be called inside a db.transaction()
// owned by the caller. `bookingIdOverride` lets the composite create path link the
// expense to a booking row inserted moments earlier in the same transaction.
export function insertPreparedExpense(db, prepared, bookingIdOverride = undefined) {
  const { tripId, input, currency, owed, payerUserId, fx } = prepared;
  const bookingId = bookingIdOverride !== undefined ? bookingIdOverride : prepared.bookingId;

  const row = db.prepare(`
    INSERT INTO expenses (
      trip_id, booking_id, payer_user_id, title, note, category, amount, currency,
      expense_date, summary_amount, summary_currency, fx_rate, fx_rate_date, fx_source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    tripId, bookingId, payerUserId, input.title?.trim() || null, input.note?.trim() || null,
    input.category, input.amount, currency, input.expenseDate,
    fx.summaryAmount, fx.summaryCurrency, fx.fxRate, fx.fxRateDate, fx.fxSource,
  );
  const expenseId = row.id;
  writeOwedRows(db, expenseId, owed);
  return expenseId;
}

// Post-commit side effect: schedule async FX stamping when the write left
// summary_amount null. Never call inside a transaction.
export function finalizeExpenseCreate(prepared, expenseId) {
  if (prepared.fx.summaryAmount === null && prepared.trip.summary_currency) {
    scheduleStamp(expenseId);
  }
}

export function createExpense(userId, tripId, input) {
  const prepared = prepareExpenseCreate(userId, tripId, input);
  const db = getDb();

  let expenseId;
  const run = db.transaction(() => {
    expenseId = insertPreparedExpense(db, prepared);
  });
  run();

  finalizeExpenseCreate(prepared, expenseId);

  const saved = fetchExpenseRow(db, expenseId);
  return {
    expense: formatExpense(saved, fetchOwedRows(db, expenseId)),
    totals: computeTotals(tripId, userId, prepared.trip.summary_currency),
  };
}

export function updateExpense(userId, tripId, expenseId, input) {
  const trip = assertTripAccess(userId, tripId);
  const existing = getExpenseInTripOrThrow(tripId, expenseId);
  const db = getDb();

  if (input.category !== undefined) validateCategory(input.category);

  const amount = input.amount !== undefined ? input.amount : existing.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw Object.assign(new Error('amount must be a positive integer'), { status: 400 });
  }
  const currency = input.currency !== undefined ? input.currency.trim().toUpperCase() : existing.currency;
  const expenseDate = input.expenseDate !== undefined ? input.expenseDate : existing.expense_date;

  const owedInput = input.owed !== undefined ? normalizeOwedInput(input.owed) : null;
  if (owedInput !== null) {
    validateOwedSum(owedInput, amount);
  } else {
    const currentOwed = fetchOwedRows(db, expenseId);
    validateOwedSum(currentOwed.map((o) => ({ amount: o.amount })), amount);
  }

  const payerUserId = input.payerUserId !== undefined
    ? resolvePayerUserId(tripId, userId, input.payerUserId)
    : existing.payer_user_id;
  const bookingId = input.bookingId !== undefined ? resolveBookingId(tripId, input.bookingId) : existing.booking_id;

  const currencyOrDateChanged = currency !== existing.currency || expenseDate !== existing.expense_date;
  let fx;
  if (input.manualRate !== undefined) {
    // Explicit key in the PATCH body: a number sets/recomputes the manual override,
    // null clears it and reverts to provider re-stamping (contract §FX stamping).
    fx = resolveFxOnWrite({
      amount, currency, expenseDate,
      tripSummaryCurrency: trip.summary_currency || null,
      manualRate: input.manualRate,
    });
  } else if (currencyOrDateChanged) {
    // Currency/date changed without touching manualRate: re-derive from scratch —
    // identity may now apply, or a prior manual/provider stamp is now stale.
    fx = resolveFxOnWrite({
      amount, currency, expenseDate,
      tripSummaryCurrency: trip.summary_currency || null,
      manualRate: existing.fx_source === 'manual' ? existing.fx_rate : undefined,
    });
  } else if (input.amount !== undefined && existing.fx_source === 'manual') {
    // Amount changed but the manual rate itself didn't — recompute summary_amount
    // from the still-active manual rate rather than dropping it to unestimated.
    fx = resolveFxOnWrite({
      amount, currency, expenseDate,
      tripSummaryCurrency: trip.summary_currency || null,
      manualRate: existing.fx_rate,
    });
  } else if (input.amount !== undefined && existing.summary_currency && currency === existing.summary_currency) {
    fx = resolveFxOnWrite({
      amount, currency, expenseDate,
      tripSummaryCurrency: trip.summary_currency || null,
      manualRate: undefined,
    });
  } else {
    // Nothing FX-relevant changed: keep the existing stamp as-is.
    fx = {
      summaryAmount: existing.summary_amount,
      summaryCurrency: existing.summary_currency,
      fxRate: existing.fx_rate,
      fxRateDate: existing.fx_rate_date,
      fxSource: existing.fx_source,
    };
  }

  const run = db.transaction(() => {
    db.prepare(`
      UPDATE expenses SET
        booking_id = ?, payer_user_id = ?, title = ?, note = ?, category = ?, amount = ?,
        currency = ?, expense_date = ?, summary_amount = ?, summary_currency = ?,
        fx_rate = ?, fx_rate_date = ?, fx_source = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      bookingId, payerUserId,
      input.title !== undefined ? (input.title?.trim() || null) : existing.title,
      input.note !== undefined ? (input.note?.trim() || null) : existing.note,
      input.category !== undefined ? input.category : existing.category,
      amount, currency, expenseDate,
      fx.summaryAmount, fx.summaryCurrency, fx.fxRate, fx.fxRateDate, fx.fxSource,
      expenseId,
    );
    if (owedInput !== null) {
      writeOwedRows(db, expenseId, owedInput);
    }
  });
  run();

  if (fx.summaryAmount === null && trip.summary_currency) {
    scheduleStamp(expenseId);
  }

  const saved = fetchExpenseRow(db, expenseId);
  return {
    expense: formatExpense(saved, fetchOwedRows(db, expenseId)),
    totals: computeTotals(tripId, userId, trip.summary_currency),
  };
}

export function deleteExpense(userId, tripId, expenseId) {
  const trip = assertTripAccess(userId, tripId);
  getExpenseInTripOrThrow(tripId, expenseId);
  const db = getDb();
  db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
  return { totals: computeTotals(tripId, userId, trip.summary_currency) };
}

export function setOwedSettled(userId, tripId, expenseId, owedId, settled) {
  const trip = assertTripAccess(userId, tripId);
  getExpenseInTripOrThrow(tripId, expenseId);
  const db = getDb();

  const owedRow = db.prepare('SELECT * FROM expense_owed WHERE id = ? AND expense_id = ?').get(owedId, expenseId);
  if (!owedRow) {
    throw Object.assign(new Error('Owed entry not found'), { status: 404 });
  }

  db.prepare('UPDATE expense_owed SET settled = ? WHERE id = ?').run(settled ? 1 : 0, owedId);
  db.prepare(`UPDATE expenses SET updated_at = datetime('now') WHERE id = ?`).run(expenseId);

  const saved = fetchExpenseRow(db, expenseId);
  return {
    expense: formatExpense(saved, fetchOwedRows(db, expenseId)),
    totals: computeTotals(tripId, userId, trip.summary_currency),
  };
}

// Totals scope to the SIGNED-IN user's own expenses (D1: spent-primary from the
// viewer's own outlay, not a trip-wide ledger). See the frozen contract's Totals spec.
export function computeTotals(tripId, userId, tripSummaryCurrency) {
  const db = getDb();
  const summaryCurrency = tripSummaryCurrency || null;

  const rows = db.prepare(`
    SELECT * FROM expenses WHERE trip_id = ? AND payer_user_id = ?
  `).all(tripId, userId);

  let spent = 0;
  let awaitingRepayment = 0;
  let netShare = 0;
  const unestimatedByCurrency = {};

  for (const row of rows) {
    if (row.summary_amount === null) {
      unestimatedByCurrency[row.currency] = (unestimatedByCurrency[row.currency] || 0) + row.amount;
      continue;
    }

    spent += row.summary_amount;

    const owedRows = fetchOwedRows(db, row.id);
    const effectiveRate = row.currency === row.summary_currency ? 1 : row.fx_rate;

    let allOwedConverted = 0;
    let openOwedConverted = 0;
    for (const owedRow of owedRows) {
      const converted = convertMinor(owedRow.amount, row.currency, effectiveRate, summaryCurrency) || 0;
      allOwedConverted += converted;
      if (!owedRow.settled) openOwedConverted += converted;
    }

    awaitingRepayment += openOwedConverted;
    netShare += row.summary_amount - allOwedConverted;
  }

  return {
    summaryCurrency,
    spent,
    awaitingRepayment,
    netShare,
    unestimatedByCurrency,
  };
}
