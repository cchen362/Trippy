// Plan 28 W2.5: applies a pending booking draft atomically. Mirrors
// applyProposal's resolve-then-write split (services/copilotProposals.js) —
// all provider I/O happens before the transaction opens, and the transaction
// itself is DB-only so it can never observe a cancellation.
import { getDb } from '../../db/database.js';
import { resolveBookingStopData, writeBookingStop } from '../stops.js';
import { writeBookingRow } from '../bookings.js';
import { validateBookingDraft } from './validate.js';
import { getDraftForUser, markDraftStatus, computeBookingFingerprint } from './drafts.js';

const TERMINAL_STATUSES = ['expired', 'stale', 'invalid', 'rejected'];

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
  if (draft.kind !== 'booking') {
    // W3 introduces the 'delete' kind; nothing in this file handles it yet.
    throw Object.assign(new Error('This draft kind is not supported yet.'), { code: 'invalid', status: 400 });
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

  const tripId = draft.tripId;
  const currentFingerprint = computeBookingFingerprint(tripId);
  if (currentFingerprint !== draft.bookingFingerprint) {
    const reason = 'The trip changed since this draft was prepared. Prepare the draft again.';
    markDraftStatus(draftId, 'stale', reason);
    throw Object.assign(new Error(reason), { code: 'stale', status: 409 });
  }

  const normalizedBookings = revalidation.bookings;
  const total = normalizedBookings.length;

  // Resolve phase — all provider I/O (Nominatim/Google/Unsplash, via
  // resolveBookingStopData) happens here, before any write. The very first
  // report() call below is what upgrades an SSE-capable transport before any
  // slow provider call, keeping Cloudflare's keep-alive flowing (F-28-14(b)).
  await report({ progress: 0, total, message: `Resolving ${total} booking${total === 1 ? '' : 's'}…` });

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
    resolvedStops.push(await resolveBookingStopData(provisionalRow));
    await report({ progress: i + 1, total, message: `Resolved booking ${i + 1} of ${total}.` });
  }

  const appliedAt = new Date().toISOString();

  // D-28-3: all-or-nothing — every booking insert, its stop write, and the
  // draft's applied flip commit in one transaction. Any throw above this point
  // leaves the draft `pending` untouched; this transaction is DB-only and
  // milliseconds long, so it never checks the abort signal (Plan 11 D4's same
  // reasoning for applyProposal's write phase).
  const applyTxn = getDb().transaction(() => {
    const bookingsResult = [];
    for (let i = 0; i < total; i += 1) {
      const normalized = normalizedBookings[i];
      const row = writeBookingRow(tripId, normalized);
      const resolved = resolvedStops[i];

      let stopId = null;
      let stopReason;
      if (resolved.ok) {
        // The resolve phase carried id: null; the real row now exists, so this
        // is the one point where the resolved object is wired to it before
        // writeBookingStop reads booking.id off it.
        resolved.booking = row;
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

    const result = {
      status: 'applied',
      tripId,
      createdTrip: false,
      bookings: bookingsResult,
      // W3 adds upload tickets for screenshot/pdf sources; until then anything the
      // client offered beyond 'manual' is reported as unsupported, never as unasked.
      sourceDocument: { status: draft.source?.kind === 'manual' ? 'not_requested' : 'unsupported' },
    };
    markDraftStatus(draftId, 'applied', null, { resultJson: JSON.stringify(result), appliedAt });
    return result;
  });

  return applyTxn();
}
