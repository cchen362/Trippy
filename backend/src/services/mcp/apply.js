// Plan 28 W2.5/W3.2/W3.4/W3.5: applies a pending booking or delete draft atomically.
// Mirrors applyProposal's resolve-then-write split (services/copilotProposals.js) —
// all provider I/O happens before the transaction opens, and the transaction
// itself is DB-only so it can never observe a cancellation.
import { getDb } from '../../db/database.js';
import { resolveBookingStopData, writeBookingStop } from '../stops.js';
import { writeBookingRow, deleteBooking } from '../bookings.js';
import { createTrip, eachDate } from '../trips.js';
import { maxBytesForMediaType } from '../attachments.js';
import { issueUploadTicket } from './uploads.js';
import { validateBookingDraft } from './validate.js';
import { validateDelete, computeDeleteFingerprint } from './prepareDelete.js';
import { getDraftForUser, markDraftStatus, computeBookingFingerprint } from './drafts.js';

const TERMINAL_STATUSES = ['expired', 'stale', 'invalid', 'rejected'];

// W3.4: issues an upload ticket for the draft's source document, if any, INSIDE the
// same write transaction as the booking insert(s) — DB-only, so it is safe to nest
// (issueUploadTicket only reads/writes rows on the same connection). A coded failure
// (attachment_limit, too_large, …) still lets the booking save — the owner boundary is
// "a booking may be saved when the document can't be transferred, and the result must
// say so" — but an uncoded failure (a real DB fault) propagates and rolls back with it.
function issueSourceDocument({ userId, tokenId, source, bookingsResult }) {
  const kind = source?.kind;
  if (kind === 'manual' || !kind) {
    return { status: 'not_requested' };
  }
  if (kind === 'email_text') {
    // Text is recorded on the draft only (kind + sha256, never the body) — there is
    // nothing to transfer over MCP for this source kind.
    return { status: 'unsupported' };
  }
  if (kind !== 'screenshot' && kind !== 'pdf') {
    return { status: 'unsupported' };
  }
  if (!source.sha256) {
    return { status: 'unsupported', reason: 'sha256_required' };
  }

  const targetIndex = source.sourceBookingIndex ?? 0;
  const bookingId = bookingsResult[targetIndex]?.bookingId;
  const mediaType = source.mediaType ?? (kind === 'pdf' ? 'application/pdf' : 'image/png');

  try {
    const ticket = issueUploadTicket({
      userId,
      tokenId,
      bookingId,
      mediaType,
      sizeBytes: source.sizeBytes ?? maxBytesForMediaType(mediaType),
      sha256: source.sha256,
    });
    return {
      status: 'pending_upload',
      ticket: {
        id: ticket.id,
        bookingIndex: targetIndex,
        expiresAt: ticket.expiresAt,
        maxBytes: ticket.maxBytes,
        requiredSha256: ticket.requiredSha256,
      },
    };
  } catch (error) {
    if (error.code) {
      return { status: 'failed', reason: error.code };
    }
    throw error;
  }
}

export async function applyDraft({ userId, draftId, report = async () => {}, signal }) {
  const draft = getDraftForUser(userId, draftId);
  if (!draft) {
    throw Object.assign(new Error('Draft not found'), { code: 'not_found', status: 404 });
  }

  if (draft.status === 'applied') {
    // draft.result carries its own stored `status: 'applied'` — spread first so
    // the `already_applied` override below always wins.
    return { ...draft.result, status: 'already_applied' };
  }
  if (TERMINAL_STATUSES.includes(draft.status)) {
    throw Object.assign(
      new Error(`This draft is ${draft.status}. Prepare the draft again.`),
      { code: draft.status, status: 409 },
    );
  }

  if (draft.kind === 'delete') {
    return applyDeleteDraft({ userId, draft });
  }

  // Re-validate against the CURRENT trip state (a day range or a booking may have
  // changed since prepare). draft.bookings are already normalized, so a blocker that
  // lived only on the raw input (cost_not_accepted) cannot resurface from this pass —
  // the blockers stored at prepare time are carried forward and refused alongside
  // anything the live re-check finds.
  const revalidation = await validateBookingDraft({ userId, target: draft.target, bookings: draft.bookings, source: draft.source });
  const blockers = [
    ...draft.issues.filter((issue) => issue.severity === 'blocker'),
    ...revalidation.issues.filter((issue) => issue.severity === 'blocker'),
  ];
  if (blockers.length > 0) {
    markDraftStatus(draftId, 'invalid', blockers[0].message);
    throw Object.assign(
      new Error('This draft has a blocking issue and cannot be applied.'),
      { code: 'apply_refused', status: 422, issues: blockers },
    );
  }

  const isNewTrip = Boolean(revalidation.newTrip);
  const tripId = draft.tripId;

  // D-28-5/W3.1: a newTrip draft has no trip yet, so its stored bookingFingerprint is
  // NULL by design (services/mcp/tools.js only fingerprints an existing-trip draft) —
  // there is nothing for it to have gone stale against. The staleness check still
  // applies, unchanged, to every existing-trip ({ tripId }) draft.
  if (!(isNewTrip && draft.bookingFingerprint === null)) {
    const currentFingerprint = computeBookingFingerprint(tripId);
    if (currentFingerprint !== draft.bookingFingerprint) {
      const reason = 'The trip changed since this draft was prepared. Prepare the draft again.';
      markDraftStatus(draftId, 'stale', reason);
      throw Object.assign(new Error(reason), { code: 'stale', status: 409 });
    }
  }

  const normalizedBookings = revalidation.bookings;
  const total = normalizedBookings.length;

  // Resolve phase — all provider I/O (Nominatim/Google/Unsplash, via
  // resolveBookingStopData) happens here, before any write. The very first
  // report() call below is what upgrades an SSE-capable transport before any
  // slow provider call, keeping Cloudflare's keep-alive flowing (F-28-14(b)).
  await report({ progress: 0, total, message: `Resolving ${total} booking${total === 1 ? '' : 's'}…` });

  // Test seam for the Plan 28 W2 Cloudflare timing gate (F-28-14(b)): holds the
  // resolve phase open so a ≥ 120 s apply can be driven through the public host
  // without a destination that genuinely takes that long. Inert unless the env
  // var is set; never set it in a normal .env. Read per call, not at import.
  const resolveDelayMs = Number(process.env.MCP_APPLY_RESOLVE_DELAY_MS) || 0;
  if (resolveDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, resolveDelayMs));
  }

  // W3.1: for a newTrip target the real days don't exist yet (createTrip runs inside
  // the write transaction below, F-28-12/D-28-3) — a provisional day, keyed only by
  // whether the booking's date falls in the client-supplied range, stands in during
  // the resolve phase. `dayDates`/`newTrip` are undefined for an existing-trip target,
  // which makes resolveBookingStopData fall back to its normal DB day lookup.
  const newTrip = revalidation.newTrip;
  const newTripDayDates = newTrip ? new Set(eachDate(newTrip.startDate, newTrip.endDate)) : null;

  const resolvedStops = [];
  for (let i = 0; i < total; i += 1) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Apply cancelled by the client before any write'), { code: 'cancelled', status: 499 });
    }
    const normalized = normalizedBookings[i];
    // A provisional, not-yet-inserted row: resolveBookingStopData only reads from
    // it, and its existing-stop lookup by booking_id = null finds nothing — correct
    // for a booking that does not exist yet.
    const provisionalRow = {
      id: null,
      trip_id: tripId,
      type: normalized.type,
      title: normalized.title,
      confirmation_ref: normalized.confirmationRef,
      booking_source: normalized.bookingSource,
      start_datetime: normalized.startDatetime,
      end_datetime: normalized.endDatetime,
      origin: normalized.origin,
      destination: normalized.destination,
      terminal_or_station: normalized.terminalOrStation,
      details_json: JSON.stringify(normalized.detailsJson || {}),
      show_in_itinerary: normalized.showInItinerary ? 1 : 0,
    };

    let resolveOptions;
    if (newTrip) {
      const startDate = normalized.startDatetime ? normalized.startDatetime.slice(0, 10) : null;
      resolveOptions = {
        day: startDate && newTripDayDates.has(startDate)
          ? {
            id: null,
            trip_id: null,
            date: startDate,
            city: newTrip.destinations[0].city,
            city_country: newTrip.destinations[0].countryCode,
          }
          : null,
      };
    }

    resolvedStops.push(await resolveBookingStopData(provisionalRow, resolveOptions));
    await report({ progress: i + 1, total, message: `Resolved booking ${i + 1} of ${total}.` });
  }

  const appliedAt = new Date().toISOString();

  // D-28-3: all-or-nothing — the new trip (if any), every booking insert, its stop
  // write, the source-document ticket, and the draft's applied flip commit in one
  // transaction. createTrip's own db.transaction() nests as a savepoint under this
  // one (F-28-12/D-28-3), so a failure anywhere — including a booking's resolved stop
  // write — rolls the trip back too, never leaving an empty shell trip behind. Any
  // throw above this point leaves the draft `pending` untouched; this transaction is
  // DB-only and milliseconds long, so it never checks the abort signal (Plan 11 D4's
  // same reasoning for applyProposal's write phase).
  const applyTxn = getDb().transaction(() => {
    let effectiveTripId = tripId;
    if (newTrip) {
      const created = createTrip(userId, {
        title: newTrip.title,
        startDate: newTrip.startDate,
        endDate: newTrip.endDate,
        destinations: newTrip.destinations,
      });
      effectiveTripId = created.trip.id;
    }

    const bookingsResult = [];
    for (let i = 0; i < total; i += 1) {
      const normalized = normalizedBookings[i];
      const row = writeBookingRow(effectiveTripId, normalized);
      const resolved = resolvedStops[i];

      let stopId = null;
      let stopReason;
      if (resolved.ok) {
        // The resolve phase carried id: null (and, for a newTrip, day: null too); the
        // real booking and day rows now exist, so this is the one point where the
        // resolved object is wired to both before writeBookingStop reads them.
        resolved.booking = row;
        const realDay = getDb().prepare('SELECT * FROM days WHERE trip_id = ? AND date = ?')
          .get(effectiveTripId, resolved.inferred.date);
        resolved.day = realDay;
        const stop = writeBookingStop(resolved);
        stopId = stop ? stop.id : null;
      } else {
        stopReason = resolved.reason;
      }

      bookingsResult.push({
        bookingIndex: i,
        bookingId: row.id,
        stopId,
        ...(stopReason ? { stopReason } : {}),
      });
    }

    const sourceDocument = issueSourceDocument({
      userId, tokenId: draft.tokenId, source: draft.source, bookingsResult,
    });

    const result = {
      status: 'applied',
      tripId: effectiveTripId,
      createdTrip: Boolean(newTrip),
      bookings: bookingsResult,
      sourceDocument,
    };
    markDraftStatus(draftId, 'applied', null, { resultJson: JSON.stringify(result), appliedAt });
    return result;
  });

  return applyTxn();
}

// W3.5 (D-28-8/I-28-2): re-preview + fingerprint check, then exactly
// deleteBooking(userId, bookingId, { deleteExpenseIds }) inside one transaction — the
// same all-or-nothing unit D-28-3 uses for a booking draft, just with a single
// destructive call instead of N inserts.
function applyDeleteDraft({ userId, draft }) {
  const { bookingId, deleteExpenseIds } = draft.target;

  let validation;
  try {
    validation = validateDelete({ userId, bookingId, deleteExpenseIds });
  } catch (error) {
    // Booking access revoked or the booking deleted elsewhere between prepare and
    // apply — the draft is marked invalid (never leak existence any further than
    // the not_found error code itself already does).
    if (error.code === 'not_found') markDraftStatus(draft.id, 'invalid', 'Booking not found.');
    throw error;
  }

  const blockers = validation.issues.filter((issue) => issue.severity === 'blocker');
  if (blockers.length > 0) {
    markDraftStatus(draft.id, 'invalid', blockers[0].message);
    throw Object.assign(
      new Error('This draft has a blocking issue and cannot be applied.'),
      { code: 'apply_refused', status: 422, issues: blockers },
    );
  }

  const currentFingerprint = computeDeleteFingerprint(validation.booking, validation.linkedStopIds, validation.linkedExpenseIds);
  if (currentFingerprint !== draft.bookingFingerprint) {
    const reason = 'The booking or its linked costs changed since this draft was prepared. Prepare the draft again.';
    markDraftStatus(draft.id, 'stale', reason);
    throw Object.assign(new Error(reason), { code: 'stale', status: 409 });
  }

  const appliedAt = new Date().toISOString();
  const tripId = validation.booking.tripId;
  const deletedStopIds = validation.requiredStopIds;
  const unlinkedStopIds = validation.linkedStopIds.filter((id) => !deletedStopIds.includes(id));
  const deletedExpenseIds = validation.linkedExpenses.filter((e) => e.effect === 'willDelete').map((e) => e.id);
  const unlinkedExpenseIds = validation.linkedExpenses.filter((e) => e.effect === 'willUnlink').map((e) => e.id);

  const applyTxn = getDb().transaction(() => {
    deleteBooking(userId, bookingId, { deleteExpenseIds: validation.deleteExpenseIds });

    const result = {
      status: 'applied',
      tripId,
      deleted: { bookingId, stopId: deletedStopIds[0] ?? null, expenseIds: deletedExpenseIds },
      unlinked: { stopIds: unlinkedStopIds, expenseIds: unlinkedExpenseIds },
    };
    markDraftStatus(draft.id, 'applied', null, { resultJson: JSON.stringify(result), appliedAt });
    return result;
  });

  return applyTxn();
}
