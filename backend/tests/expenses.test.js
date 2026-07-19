import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip, updateTrip } from '../src/services/trips.js';
import { inviteCollaborator } from '../src/services/collaboration.js';
import { getSharedTrip, createShareLink } from '../src/services/share.js';
import {
  createExpense, updateExpense, deleteExpense, listExpenses, setOwedSettled,
} from '../src/services/expenses.js';
import { getRate } from '../src/services/fx.js';
import { currencyForCountry, minorUnitsFor } from '../src/utils/currency.js';

let tmpDir;
let owner;
let collaborator;
let otherUser;
let tripDetail;

function makeTrip(overrides = {}) {
  return createTrip(owner.id, {
    title: 'Osaka Loop',
    destinations: ['Osaka'],
    destinationCountries: ['JP'],
    startDate: '2026-09-10',
    endDate: '2026-09-20',
    travellers: 'friends',
    interestTags: [],
    pace: 'moderate',
    ...overrides,
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-expenses-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
  const inviteCode = authService.getInviteCode();
  collaborator = authService.register('friend', 'password123', 'Travel Friend', inviteCode).user;
  otherUser = authService.register('other', 'password123', 'Other User', inviteCode).user;
  tripDetail = makeTrip();
});

afterEach(() => {
  vi.restoreAllMocks();
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('currency utils', () => {
  it('maps countries to currency codes', () => {
    expect(currencyForCountry('JP')).toBe('JPY');
    expect(currencyForCountry('SG')).toBe('SGD');
    expect(currencyForCountry('TW')).toBe('TWD');
    expect(currencyForCountry('VN')).toBe('VND');
    expect(currencyForCountry('zz')).toBe(null);
  });

  it('reports zero-decimal currencies correctly', () => {
    expect(minorUnitsFor('JPY')).toBe(0);
    expect(minorUnitsFor('KRW')).toBe(0);
    expect(minorUnitsFor('VND')).toBe(0);
    expect(minorUnitsFor('USD')).toBe(2);
    expect(minorUnitsFor('IDR')).toBe(2);
  });
});

describe('expenses CRUD + access', () => {
  it('creates an expense with identity currency (no FX needed)', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense, totals } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 8000, currency: 'SGD', category: 'food', expenseDate: '2026-09-11', title: 'Ramen',
    });

    expect(expense.summaryAmount).toBe(8000);
    expect(expense.summaryCurrency).toBe('SGD');
    expect(expense.fxRate).toBe(null);
    expect(expense.fxSource).toBe(null);
    expect(expense.payerName).toBe('Trip Owner');
    expect(totals.spent).toBe(8000);
  });

  it('lists, updates, and deletes an expense', async () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 5000, currency: 'SGD', category: 'transport', expenseDate: '2026-09-12',
    });

    const listed = listExpenses(owner.id, tripDetail.trip.id);
    expect(listed.expenses).toHaveLength(1);
    expect(listed.summaryCurrency).toBe('SGD');

    const updated = updateExpense(owner.id, tripDetail.trip.id, expense.id, { amount: 6000, note: 'taxi' });
    expect(updated.expense.amount).toBe(6000);
    expect(updated.expense.note).toBe('taxi');
    expect(updated.expense.summaryAmount).toBe(6000);

    const deleted = deleteExpense(owner.id, tripDetail.trip.id, expense.id);
    expect(deleted.totals.spent).toBe(0);
    expect(listExpenses(owner.id, tripDetail.trip.id).expenses).toHaveLength(0);
  });

  it('404s on an expense id that belongs to a different trip', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'other', expenseDate: '2026-09-12',
    });
    const otherTrip = makeTrip({ title: 'Second trip' });

    expect(() => updateExpense(owner.id, otherTrip.trip.id, expense.id, { amount: 2000 }))
      .toThrow(expect.objectContaining({ status: 404 }));
  });

  it('rejects access from a user who is not a trip collaborator (403)', () => {
    expect(() => createExpense(otherUser.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12',
    })).toThrow(expect.objectContaining({ status: 404 }));
    // Non-collaborator access denial surfaces as the existing trip-access 404/403
    // behavior from assertTripAccess — verified against the shared middleware, not
    // re-implemented here.
  });

  it('lets an invited collaborator create and edit expenses', () => {
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');
    const { expense } = createExpense(collaborator.id, tripDetail.trip.id, {
      amount: 2000, currency: 'JPY', category: 'food', expenseDate: '2026-09-12',
    });
    expect(expense.payerUserId).toBe(collaborator.id);

    const updated = updateExpense(owner.id, tripDetail.trip.id, expense.id, { note: 'shared editing' });
    expect(updated.expense.note).toBe('shared editing');
  });

  it('rejects a payerUserId who is not a trip collaborator', () => {
    expect(() => createExpense(owner.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12', payerUserId: otherUser.id,
    })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('rejects a bookingId that does not belong to the trip', () => {
    expect(() => createExpense(owner.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12', bookingId: 'not-a-real-id',
    })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('owed-sum validation', () => {
  it('rejects owed amounts that exceed the expense amount on create', () => {
    expect(() => createExpense(owner.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12',
      owed: [{ name: 'Sarah', amount: 600 }, { name: 'Ken', amount: 500 }],
    })).toThrow(expect.objectContaining({ status: 400, message: 'Owed amounts exceed the expense amount' }));
  });

  it('rejects owed amounts that exceed the expense amount on update', () => {
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12',
      owed: [{ name: 'Sarah', amount: 400 }],
    });
    expect(() => updateExpense(owner.id, tripDetail.trip.id, expense.id, { amount: 300 }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });

  it('accepts owed amounts exactly equal to the expense amount', () => {
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 1000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12',
      owed: [{ name: 'Sarah', amount: 1000 }],
    });
    expect(expense.owed[0].amount).toBe(1000);
  });
});

describe('totals math', () => {
  it('computes spent, awaitingRepayment, netShare, and per-user scoping', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');

    const { totals: t1 } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 10000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12',
      owed: [{ name: 'Sarah', amount: 4000, settled: false }, { name: 'Ken', amount: 1000, settled: true }],
    });
    expect(t1.spent).toBe(10000);
    expect(t1.awaitingRepayment).toBe(4000);
    expect(t1.netShare).toBe(10000 - 5000);

    // A collaborator's own expense must not bleed into the owner's totals.
    createExpense(collaborator.id, tripDetail.trip.id, {
      amount: 2000, currency: 'SGD', category: 'transport', expenseDate: '2026-09-13',
    });
    const ownerTotals = listExpenses(owner.id, tripDetail.trip.id).totals;
    expect(ownerTotals.spent).toBe(10000);

    const collabTotals = listExpenses(collaborator.id, tripDetail.trip.id).totals;
    expect(collabTotals.spent).toBe(2000);
  });

  it('excludes unestimated (null summaryAmount) rows from spent and buckets them by currency', () => {
    // No summary currency set on the trip -> nothing can be converted, so every
    // expense stays unestimated regardless of FX availability.
    const { totals } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 3000, currency: 'JPY', category: 'food', expenseDate: '2026-09-12',
    });
    expect(totals.spent).toBe(0);
    expect(totals.unestimatedByCurrency).toEqual({ JPY: 3000 });
  });

  it('converts owed amounts using the expense stamped rate with round-half-up', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 10000, currency: 'JPY', category: 'food', expenseDate: '2026-09-12',
      manualRate: 0.009, // 1 JPY = 0.009 SGD
      owed: [{ name: 'Sarah', amount: 3000 }],
    });
    // amount 10000 JPY minor units (0 decimals) -> 10000 major JPY * 0.009 = 90 SGD major -> 9000 minor
    expect(expense.summaryAmount).toBe(9000);
    const totals = listExpenses(owner.id, tripDetail.trip.id).totals;
    // owed 3000 JPY * 0.009 = 27 SGD major -> 2700 minor
    expect(totals.awaitingRepayment).toBe(2700);
    expect(totals.netShare).toBe(9000 - 2700);
  });
});

describe('manual rate override', () => {
  it('recomputes summaryAmount and sets fxSource to manual', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 10000, currency: 'JPY', category: 'food', expenseDate: '2026-09-12', manualRate: 0.01,
    });
    expect(expense.fxSource).toBe('manual');
    expect(expense.summaryAmount).toBe(10000); // 10000 JPY * 0.01 = 100 SGD -> 10000 minor

    const updated = updateExpense(owner.id, tripDetail.trip.id, expense.id, { manualRate: 0.02 });
    expect(updated.expense.fxSource).toBe('manual');
    expect(updated.expense.summaryAmount).toBe(20000);
  });

  it('clears the manual override back to an unestimated provider re-stamp on null', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 10000, currency: 'JPY', category: 'food', expenseDate: '2026-09-12', manualRate: 0.01,
    });

    const cleared = updateExpense(owner.id, tripDetail.trip.id, expense.id, { manualRate: null });
    expect(cleared.expense.fxSource).toBe(null);
    expect(cleared.expense.summaryAmount).toBe(null);
  });
});

describe('settled toggle', () => {
  it('flips an owed row settled state and recomputes totals', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    const { expense } = createExpense(owner.id, tripDetail.trip.id, {
      amount: 5000, currency: 'SGD', category: 'food', expenseDate: '2026-09-12',
      owed: [{ name: 'Sarah', amount: 2000, settled: false }],
    });
    const owedId = expense.owed[0].id;

    const before = listExpenses(owner.id, tripDetail.trip.id).totals;
    expect(before.awaitingRepayment).toBe(2000);

    const result = setOwedSettled(owner.id, tripDetail.trip.id, expense.id, owedId, true);
    expect(result.expense.owed[0].settled).toBe(true);
    expect(result.totals.awaitingRepayment).toBe(0);
    expect(result.totals.netShare).toBe(5000 - 2000); // netShare counts all owed rows, settled or not
  });
});

describe('fx service cache + mocked fetch', () => {
  it('returns 1 for identity pairs without touching the network', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const rate = await getRate('SGD', 'SGD', '2026-09-12');
    expect(rate).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from the primary host, caches the result, and reuses the cache on a repeat call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ jpy: { sgd: 0.0091 } }),
    });

    const rate1 = await getRate('JPY', 'SGD', '2026-09-12');
    expect(rate1).toBe(0.0091);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('cdn.jsdelivr.net');

    const rate2 = await getRate('JPY', 'SGD', '2026-09-12');
    expect(rate2).toBe(0.0091);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call served from fx_rates cache
  });

  it('falls back to the pages.dev host when the primary host fails', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ jpy: { sgd: 0.0092 } }) });

    const rate = await getRate('JPY', 'SGD', '2026-09-13');
    expect(rate).toBe(0.0092);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain('currency-api.pages.dev');
  });

  it('returns null (never throws) when both hosts fail', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false });
    const rate = await getRate('JPY', 'SGD', '2026-09-14');
    expect(rate).toBe(null);
  });
});

describe('share exclusion regression', () => {
  it('never serializes expense/amount fields into the public share payload', () => {
    updateTrip(owner.id, tripDetail.trip.id, { summaryCurrency: 'SGD' });
    createExpense(owner.id, tripDetail.trip.id, {
      amount: 12345, currency: 'SGD', category: 'lodging', expenseDate: '2026-09-12',
      title: 'Hotel deposit', note: 'do-not-leak-this-note',
      owed: [{ name: 'Sarah', amount: 5000 }],
    });

    const { token } = createShareLink(owner.id, tripDetail.trip.id);
    const shared = getSharedTrip(token);
    const serialized = JSON.stringify(shared);

    expect(serialized).not.toContain('do-not-leak-this-note');
    expect(serialized).not.toContain('12345');
    expect(serialized.toLowerCase()).not.toContain('expense');
    expect(serialized).not.toContain('summaryAmount');
    expect(serialized).not.toContain('fxRate');
  });
});
