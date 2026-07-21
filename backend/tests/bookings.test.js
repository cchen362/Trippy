import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));
vi.mock('../src/config.js', () => ({
  config: { anthropicApiKey: 'test-key' },
}));

const { initDb, getDb } = await import('../src/db/database.js');
const { runMigrations } = await import('../src/db/migrations.js');
const authService = await import('../src/services/auth.js');
const { createTrip } = await import('../src/services/trips.js');
const { createBooking, listBookings, deleteBooking } = await import('../src/services/bookings.js');
const { addAttachment } = await import('../src/services/attachments.js');
const { createArtifactAndExtract, deleteArtifact } = await import('../src/services/importer.js');
const { createExpense } = await import('../src/services/expenses.js');
const { inviteCollaborator } = await import('../src/services/collaboration.js');

const trainTicketBase64 = readFileSync(join(__dirname, 'fixtures/train-ticket.png')).toString('base64');

function claudeResponse(json) {
  return {
    content: [{ type: 'text', text: '```json\n' + JSON.stringify(json) + '\n```' }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function flightBooking(overrides = {}) {
  return {
    type: 'flight',
    title: 'MU5401',
    confirmationRef: 'ABC123',
    bookingSource: 'Trip.com',
    startDatetime: '2026-09-14T08:35',
    endDatetime: '2026-09-14T11:50',
    details: {},
    confidence: { overall: 'high', fields: {} },
    assumptions: [],
    ...overrides,
  };
}

let tmpDir;
let owner;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-bookings-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  vi.clearAllMocks();
  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function makeTrip() {
  return createTrip(owner.id, {
    title: 'Sichuan Trip',
    destinations: ['Chengdu'],
    destinationCountries: ['CN'],
    startDate: '2026-09-10',
    endDate: '2026-09-20',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
}

describe('booking documents resolution', () => {
  it('returns attachment-sourced documents for a hand-entered booking', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'hotel', title: 'Hand-entered hotel', confirmationRef: 'H1',
    });
    addAttachment(owner.id, booking.id, { mediaType: 'image/png', filename: 'a.png', content: Buffer.from('a').toString('base64') });
    addAttachment(owner.id, booking.id, { mediaType: 'application/pdf', filename: 'b.pdf', content: Buffer.from('b').toString('base64') });

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(2);
    expect(found.documents.every((d) => d.source === 'attachment')).toBe(true);
  });

  it('returns import-sourced documents for an artifact-linked booking', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse({
      isTravelRelated: true, summary: 'test', language: 'en', bookings: [flightBooking()],
    }));
    const extracted = await createArtifactAndExtract(owner.id, {
      tripId: trip.trip.id,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'flight',
      title: 'MU5401',
      detailsJson: { importedFrom: { artifactId: extracted.artifact.id, model: 'm', extractedAt: 'now' } },
    });

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(1);
    expect(found.documents[0].source).toBe('import');
    expect(found.documents[0].url).toBe(`/api/import/artifacts/${extracted.artifact.id}/files/0`);
  });

  it('combines import and attachment documents, import entries first', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse({
      isTravelRelated: true, summary: 'test', language: 'en', bookings: [flightBooking()],
    }));
    const extracted = await createArtifactAndExtract(owner.id, {
      tripId: trip.trip.id,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'flight',
      title: 'MU5401',
      detailsJson: { importedFrom: { artifactId: extracted.artifact.id, model: 'm', extractedAt: 'now' } },
    });
    addAttachment(owner.id, booking.id, { mediaType: 'image/png', filename: 'extra.png', content: Buffer.from('c').toString('base64') });

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(2);
    expect(found.documents[0].source).toBe('import');
    expect(found.documents[1].source).toBe('attachment');
  });

  it('gracefully drops import documents once the source artifact is deleted', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse({
      isTravelRelated: true, summary: 'test', language: 'en', bookings: [flightBooking()],
    }));
    const extracted = await createArtifactAndExtract(owner.id, {
      tripId: trip.trip.id,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'flight',
      title: 'MU5401',
      detailsJson: { importedFrom: { artifactId: extracted.artifact.id, model: 'm', extractedAt: 'now' } },
    });

    deleteArtifact(owner.id, extracted.artifact.id);

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(0);
  });
});

describe('booking expenseSummary aggregate', () => {
  it('is null for a booking with no linked expenses', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });

    const bookings = listBookings(owner.id, trip.trip.id);
    expect(bookings.find((b) => b.id === booking.id).expenseSummary).toBe(null);
  });

  it('reports single with the exact expense when exactly one is linked', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const { expense } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });

    const bookings = listBookings(owner.id, trip.trip.id);
    const summary = bookings.find((b) => b.id === booking.id).expenseSummary;
    expect(summary.count).toBe(1);
    expect(summary.single).toEqual({ expenseId: expense.id, amount: 42000, currency: 'JPY' });
  });

  it('reports count with no single when several expenses are linked, across payers and currencies', async () => {
    const trip = makeTrip();
    const inviteCode = authService.getInviteCode();
    const friend = authService.register('friend', 'password123', 'Travel Friend', inviteCode).user;
    inviteCollaborator(owner.id, trip.trip.id, 'friend');

    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });
    createExpense(friend.id, trip.trip.id, {
      amount: 30, currency: 'SGD', category: 'lodging', expenseDate: '2026-09-12', bookingId: booking.id,
    });

    const bookings = listBookings(owner.id, trip.trip.id);
    const summary = bookings.find((b) => b.id === booking.id).expenseSummary;
    expect(summary.count).toBe(2);
    expect(summary.single).toBe(null);
  });

  it('createBooking and updateBooking responses carry no stale expenseSummary', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    expect(booking.expenseSummary).toBe(null);

    createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });

    const { updateBooking } = await import('../src/services/bookings.js');
    const updated = await updateBooking(owner.id, booking.id, { title: 'Hotel (renamed)' });
    // The response itself doesn't recompute the aggregate — a linked expense already
    // exists at this point, but the client relies on its next list/detail refresh.
    expect(updated.expenseSummary).toBe(null);
  });
});

describe('composite booking + cost create', () => {
  function countBookings(tripId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?').get(tripId).n;
  }

  function countExpenses(tripId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM expenses WHERE trip_id = ?').get(tripId).n;
  }

  it('persists the booking and its linked cost atomically, with owed rows', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'hotel',
      title: 'Hotel',
      cost: {
        amount: 42000,
        currency: 'JPY',
        category: 'lodging',
        expenseDate: '2026-09-11',
        title: 'Hotel deposit',
        owed: [{ name: 'Friend', amount: 10000 }],
      },
    });

    expect(booking.expenseSummary).toEqual({
      count: 1,
      single: { expenseId: expect.any(String), amount: 42000, currency: 'JPY' },
    });

    const db = getDb();
    const expenseRows = db.prepare('SELECT * FROM expenses WHERE trip_id = ?').all(trip.trip.id);
    expect(expenseRows).toHaveLength(1);
    expect(expenseRows[0].booking_id).toBe(booking.id);
    expect(expenseRows[0].trip_id).toBe(trip.trip.id);
    expect(expenseRows[0].amount).toBe(42000);
    expect(expenseRows[0].currency).toBe('JPY');
    expect(expenseRows[0].category).toBe('lodging');

    const owedRows = db.prepare('SELECT * FROM expense_owed WHERE expense_id = ?').all(expenseRows[0].id);
    expect(owedRows).toHaveLength(1);
    expect(owedRows[0]).toMatchObject({ name: 'Friend', amount: 10000 });
  });

  it('rolls back the whole create when the cost amount is invalid', async () => {
    const trip = makeTrip();
    await expect(createBooking(owner.id, trip.trip.id, {
      type: 'hotel',
      title: 'Hotel',
      cost: { amount: 0, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11' },
    })).rejects.toMatchObject({ status: 400 });

    expect(countBookings(trip.trip.id)).toBe(0);
    expect(countExpenses(trip.trip.id)).toBe(0);
  });

  it('rolls back the whole create when owed exceeds the cost amount', async () => {
    const trip = makeTrip();
    await expect(createBooking(owner.id, trip.trip.id, {
      type: 'hotel',
      title: 'Hotel',
      cost: {
        amount: 1000,
        currency: 'JPY',
        category: 'lodging',
        expenseDate: '2026-09-11',
        owed: [{ name: 'Friend', amount: 5000 }],
      },
    })).rejects.toMatchObject({ status: 400 });

    expect(countBookings(trip.trip.id)).toBe(0);
    expect(countExpenses(trip.trip.id)).toBe(0);
  });

  it('rejects a cost payerUserId that is not a trip member, with no booking created', async () => {
    const trip = makeTrip();
    await expect(createBooking(owner.id, trip.trip.id, {
      type: 'hotel',
      title: 'Hotel',
      cost: {
        amount: 1000,
        currency: 'JPY',
        category: 'lodging',
        expenseDate: '2026-09-11',
        payerUserId: 'not-a-real-user-id',
      },
    })).rejects.toMatchObject({ status: 400 });

    expect(countBookings(trip.trip.id)).toBe(0);
    expect(countExpenses(trip.trip.id)).toBe(0);
  });

  it('rejects a cost carrying a bookingId, with no booking created', async () => {
    const trip = makeTrip();
    const other = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Other hotel' });

    await expect(createBooking(owner.id, trip.trip.id, {
      type: 'hotel',
      title: 'Hotel',
      cost: {
        amount: 1000,
        currency: 'JPY',
        category: 'lodging',
        expenseDate: '2026-09-11',
        bookingId: other.id,
      },
    })).rejects.toMatchObject({ status: 400 });

    // Only the pre-existing "Other hotel" booking remains.
    expect(countBookings(trip.trip.id)).toBe(1);
    expect(countExpenses(trip.trip.id)).toBe(0);
  });

  it('creates no expense and returns null expenseSummary when no cost is provided', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });

    expect(booking.expenseSummary).toBe(null);
    expect(countExpenses(trip.trip.id)).toBe(0);
  });
});

describe('deleteBooking with linked expenses', () => {
  function countBookingsById(bookingId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM bookings WHERE id = ?').get(bookingId).n;
  }

  function expenseRow(expenseId) {
    return getDb().prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  }

  function owedRows(expenseId) {
    return getDb().prepare('SELECT * FROM expense_owed WHERE expense_id = ?').all(expenseId);
  }

  it('deletes the booking and leaves all linked expenses unlinked when no ids are given', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const { expense: e1 } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
      owed: [{ name: 'Friend', amount: 10000 }],
    });
    const { expense: e2 } = createExpense(owner.id, trip.trip.id, {
      amount: 12000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-12', bookingId: booking.id,
    });

    const result = deleteBooking(owner.id, booking.id);
    expect(result).toEqual({ ok: true, deletedExpenseCount: 0 });
    expect(countBookingsById(booking.id)).toBe(0);

    const row1 = expenseRow(e1.id);
    const row2 = expenseRow(e2.id);
    expect(row1.booking_id).toBe(null);
    expect(row2.booking_id).toBe(null);
    expect(owedRows(e1.id)).toHaveLength(1);
  });

  it('deletes the booking and empty deleteExpenseIds array behaves the same as no body', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const { expense } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });

    const result = deleteBooking(owner.id, booking.id, { deleteExpenseIds: [] });
    expect(result).toEqual({ ok: true, deletedExpenseCount: 0 });
    expect(countBookingsById(booking.id)).toBe(0);
    expect(expenseRow(expense.id).booking_id).toBe(null);
  });

  it('deletes exactly the one selected expense and its owed rows, leaving the other unlinked', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const { expense: e1 } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
      owed: [{ name: 'Friend', amount: 10000 }],
    });
    const { expense: e2 } = createExpense(owner.id, trip.trip.id, {
      amount: 12000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-12', bookingId: booking.id,
    });

    const result = deleteBooking(owner.id, booking.id, { deleteExpenseIds: [e1.id] });
    expect(result).toEqual({ ok: true, deletedExpenseCount: 1 });
    expect(countBookingsById(booking.id)).toBe(0);
    expect(expenseRow(e1.id)).toBeUndefined();
    expect(owedRows(e1.id)).toHaveLength(0);

    const row2 = expenseRow(e2.id);
    expect(row2).toBeDefined();
    expect(row2.booking_id).toBe(null);
  });

  it('deletes all selected expenses when many are given', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const { expense: e1 } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });
    const { expense: e2 } = createExpense(owner.id, trip.trip.id, {
      amount: 12000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-12', bookingId: booking.id,
    });

    const result = deleteBooking(owner.id, booking.id, { deleteExpenseIds: [e1.id, e2.id] });
    expect(result).toEqual({ ok: true, deletedExpenseCount: 2 });
    expect(countBookingsById(booking.id)).toBe(0);
    expect(expenseRow(e1.id)).toBeUndefined();
    expect(expenseRow(e2.id)).toBeUndefined();
  });

  it('rejects an expense id from a different trip with 404 and deletes nothing', async () => {
    const trip = makeTrip();
    const otherTrip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const otherBooking = await createBooking(owner.id, otherTrip.trip.id, { type: 'hotel', title: 'Other hotel' });
    const { expense: ownExpense } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });
    const { expense: foreignExpense } = createExpense(owner.id, otherTrip.trip.id, {
      amount: 5000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: otherBooking.id,
    });

    expect(() => deleteBooking(owner.id, booking.id, { deleteExpenseIds: [ownExpense.id, foreignExpense.id] }))
      .toThrow(expect.objectContaining({ status: 404 }));

    expect(countBookingsById(booking.id)).toBe(1);
    expect(expenseRow(ownExpense.id)).toBeDefined();
    expect(expenseRow(foreignExpense.id)).toBeDefined();
  });

  it('rejects an expense id linked to a different booking (same trip) with 400 and deletes nothing', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const otherBooking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Other hotel' });
    const { expense: ownExpense } = createExpense(owner.id, trip.trip.id, {
      amount: 42000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: booking.id,
    });
    const { expense: otherBookingExpense } = createExpense(owner.id, trip.trip.id, {
      amount: 5000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11', bookingId: otherBooking.id,
    });

    expect(() => deleteBooking(owner.id, booking.id, { deleteExpenseIds: [ownExpense.id, otherBookingExpense.id] }))
      .toThrow(expect.objectContaining({ status: 400 }));

    expect(countBookingsById(booking.id)).toBe(1);
    expect(expenseRow(ownExpense.id)).toBeDefined();
    expect(expenseRow(otherBookingExpense.id)).toBeDefined();
  });

  it('rejects an expense id that is unlinked (same trip, no booking) with 400 and deletes nothing', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });
    const { expense: unlinkedExpense } = createExpense(owner.id, trip.trip.id, {
      amount: 5000, currency: 'JPY', category: 'lodging', expenseDate: '2026-09-11',
    });

    expect(() => deleteBooking(owner.id, booking.id, { deleteExpenseIds: [unlinkedExpense.id] }))
      .toThrow(expect.objectContaining({ status: 400 }));

    expect(countBookingsById(booking.id)).toBe(1);
    expect(expenseRow(unlinkedExpense.id)).toBeDefined();
  });

  it('rejects a nonexistent hex id with 404 and deletes nothing', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });

    expect(() => deleteBooking(owner.id, booking.id, { deleteExpenseIds: ['deadbeefdeadbeefdeadbeefdeadbeef'] }))
      .toThrow(expect.objectContaining({ status: 404 }));

    expect(countBookingsById(booking.id)).toBe(1);
  });

  it('rejects deleteExpenseIds that is not an array with 400', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hotel' });

    expect(() => deleteBooking(owner.id, booking.id, { deleteExpenseIds: 'abc' }))
      .toThrow(expect.objectContaining({ status: 400 }));

    expect(countBookingsById(booking.id)).toBe(1);
  });
});
