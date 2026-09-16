// Plan 28 W2.3: deterministic, no-network* validation for an MCP booking draft.
// (*resolvePlace is called with allowNetwork:false for the timezone-suggestion
// path only — that is a cache read, never a fetch; see suggestTimezoneForField.)
//
// This is the single place `prepare_draft` and `apply_draft` share for turning
// raw BookingInput objects into NormalizedBooking rows plus an Issue list —
// apply.js re-runs this exact function before writing anything, so the two
// call sites can never drift.
import { getDb } from '../../db/database.js';
import { assertTripAccess } from '../trips.js';
import { defaultShowInItinerary } from '../bookings.js';
import {
  BOOKING_TYPES,
  normalizeDatetime,
  normalizeTz,
  findDuplicateConfirmationRef,
  bookingDatePosition,
} from '../importer.js';
import { resolvePlace } from '../placeResolver.js';
import { cityFromIata, cityFromAirportString } from '../../utils/airports.js';
import { find as tzFind } from 'geo-tz';

const IATA_RE = /^[A-Z]{3}$/;
const SOURCE_KINDS = ['screenshot', 'pdf', 'email_text', 'manual'];

const TYPE_REQUIRED_FIELDS = {
  flight: ['title', 'startDatetime', 'origin', 'destination'],
  train: ['title', 'startDatetime', 'origin', 'destination'],
  bus: ['title', 'startDatetime', 'origin', 'destination'],
  ferry: ['title', 'startDatetime', 'origin', 'destination'],
  hotel: ['title', 'startDatetime', 'endDatetime', 'destination'],
  other: ['title', 'startDatetime'],
};

function sameFold(a, b) {
  const an = a ?? null;
  const bn = b ?? null;
  if (an === null && bn === null) return true;
  if (an === null || bn === null) return false;
  return String(an).toLowerCase() === String(bn).toLowerCase();
}

// Cache-only geocode lookup used solely to suggest an IANA time zone. allowNetwork:
// false makes resolvePlace short-circuit to a cache hit or `unresolved()` — never a
// fetch (confirmed at the cache short-circuit in placeResolver.js) — so this keeps
// prepare_draft/apply_draft's validation pass free of network I/O.
async function tzFromCacheOnlyPlace(queryText) {
  if (!queryText) return null;
  try {
    const result = await resolvePlace({ queryText, allowNetwork: false });
    if (result && Number.isFinite(result.lat) && Number.isFinite(result.lng)) {
      return tzFind(result.lat, result.lng)[0] || null;
    }
  } catch {
    return null;
  }
  return null;
}

// D-28-10: a missing origin/destination time zone is never a blocker — the booking's
// wall-clock time is stored exactly as supplied (no conversion), the same way the
// import/confirm UI already stores it. This only computes a *suggestion* to surface
// to the model/user; it never changes what gets written.
async function suggestTimezoneForField(detailsJson, locationValue) {
  if (Number.isFinite(detailsJson?.lat) && Number.isFinite(detailsJson?.lng)) {
    const zone = tzFind(detailsJson.lat, detailsJson.lng)[0];
    if (zone) return zone;
  }
  if (!locationValue || typeof locationValue !== 'string') return null;

  const direct = await tzFromCacheOnlyPlace(locationValue);
  if (direct) return direct;

  const trimmed = locationValue.trim();
  const cityGuess = IATA_RE.test(trimmed) ? cityFromIata(trimmed) : cityFromAirportString(trimmed);
  if (cityGuess) {
    const fromCity = await tzFromCacheOnlyPlace(cityGuess);
    if (fromCity) return fromCity;
  }
  return null;
}

function validateSourceShape(source, issues) {
  if (!source || typeof source !== 'object' || !SOURCE_KINDS.includes(source.kind)) {
    issues.push({
      severity: 'blocker',
      code: 'missing_required_field',
      field: 'source.kind',
      message: `source.kind must be one of ${SOURCE_KINDS.join(', ')}.`,
    });
    return null;
  }
  // Store exactly these fields — never email text or any other raw content (W3).
  return {
    kind: source.kind,
    sha256: source.sha256 ?? null,
    mediaType: source.mediaType ?? null,
    sizeBytes: source.sizeBytes ?? null,
  };
}

async function validateOneBooking(booking, index, { tripRow, existingBookingRows, dayDates }) {
  const issues = [];

  if (!booking || typeof booking !== 'object') {
    issues.push({
      severity: 'blocker', code: 'missing_required_field', bookingIndex: index, field: 'type',
      message: 'A booking object is required.',
    });
    return { normalized: null, issues, plannedEffect: null };
  }

  // D-28-9: `cost` is never accepted on a booking prepared over MCP — the app's
  // expense flow (with its own validation/currency resolution) is the only
  // supported way to attach a cost, so a `cost` key here is refused outright
  // rather than silently dropped or partially re-validated.
  if (Object.prototype.hasOwnProperty.call(booking, 'cost')) {
    issues.push({
      severity: 'blocker', code: 'cost_not_accepted', bookingIndex: index, field: 'cost',
      message: 'cost is not accepted on a booking prepared over MCP.',
    });
  }

  const type = booking.type;
  if (!BOOKING_TYPES.includes(type)) {
    issues.push({
      severity: 'blocker', code: 'missing_required_field', bookingIndex: index, field: 'type',
      message: `type must be one of ${BOOKING_TYPES.join(', ')}.`,
    });
  }

  const requiredFields = TYPE_REQUIRED_FIELDS[type] || TYPE_REQUIRED_FIELDS.other;
  for (const field of requiredFields) {
    let value = booking[field];
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null || value === '') {
      issues.push({
        severity: 'blocker', code: 'missing_required_field', bookingIndex: index, field,
        message: `${field} is required for a ${type || 'booking'}.`,
      });
    }
  }

  let startDatetime = null;
  if (booking.startDatetime !== undefined && booking.startDatetime !== null && booking.startDatetime !== '') {
    startDatetime = normalizeDatetime(booking.startDatetime);
    if (!startDatetime) {
      issues.push({
        severity: 'blocker', code: 'invalid_datetime', bookingIndex: index, field: 'startDatetime',
        message: 'startDatetime could not be parsed.',
      });
    }
  }

  let endDatetime = null;
  if (booking.endDatetime !== undefined && booking.endDatetime !== null && booking.endDatetime !== '') {
    endDatetime = normalizeDatetime(booking.endDatetime);
    if (!endDatetime) {
      issues.push({
        severity: 'blocker', code: 'invalid_datetime', bookingIndex: index, field: 'endDatetime',
        message: 'endDatetime could not be parsed.',
      });
    }
  }

  if (startDatetime && endDatetime && endDatetime < startDatetime) {
    issues.push({
      severity: 'blocker', code: 'end_before_start', bookingIndex: index,
      message: 'endDatetime is before startDatetime.',
    });
  }

  const originTzProvided = booking.originTz !== undefined && booking.originTz !== null && booking.originTz !== '';
  let originTz = null;
  if (originTzProvided) {
    originTz = normalizeTz(booking.originTz);
    if (!originTz) {
      issues.push({
        severity: 'blocker', code: 'invalid_timezone', bookingIndex: index, field: 'originTz',
        message: 'originTz is not a recognized IANA time zone.',
      });
    }
  }

  const destinationTzProvided = booking.destinationTz !== undefined && booking.destinationTz !== null && booking.destinationTz !== '';
  let destinationTz = null;
  if (destinationTzProvided) {
    destinationTz = normalizeTz(booking.destinationTz);
    if (!destinationTz) {
      issues.push({
        severity: 'blocker', code: 'invalid_timezone', bookingIndex: index, field: 'destinationTz',
        message: 'destinationTz is not a recognized IANA time zone.',
      });
    }
  }

  const detailsJson = booking.detailsJson && typeof booking.detailsJson === 'object' ? booking.detailsJson : {};

  // D-28-10: tz omitted (not "invalid" — that's handled above) is informational only.
  const tzGapsToCheck = [];
  if (['flight', 'train', 'bus', 'ferry'].includes(type)) {
    if (!originTzProvided) tzGapsToCheck.push({ field: 'originTz', locationValue: booking.origin });
    if (!destinationTzProvided) tzGapsToCheck.push({ field: 'destinationTz', locationValue: booking.destination });
  } else if (type === 'hotel') {
    if (!destinationTzProvided) tzGapsToCheck.push({ field: 'destinationTz', locationValue: booking.destination });
  }
  for (const gap of tzGapsToCheck) {
    const suggestion = await suggestTimezoneForField(detailsJson, gap.locationValue);
    issues.push({
      severity: 'info',
      code: 'timezone_unknown',
      bookingIndex: index,
      field: gap.field,
      message: `${gap.field} was not supplied; the wall-clock time is stored exactly as given, with no conversion.`,
      ...(suggestion ? { suggestion } : {}),
    });
  }

  let existingDuplicate = null;
  if (tripRow) {
    const position = bookingDatePosition(tripRow, { startDatetime });
    if (position) {
      issues.push({
        severity: 'blocker', code: 'outside_trip_dates', bookingIndex: index,
        message: `startDatetime falls ${position.side} the trip's dates (${tripRow.start_date} to ${tripRow.end_date}).`,
      });
    }

    existingDuplicate = findDuplicateConfirmationRef(existingBookingRows, {
      type, confirmationRef: booking.confirmationRef ?? null,
    });
    if (existingDuplicate) {
      issues.push({
        severity: 'warning', code: 'duplicate_confirmation_ref', bookingIndex: index,
        existingBookingId: existingDuplicate.id,
        message: 'A booking with this confirmation reference already exists on this trip.',
      });
    }

    if (startDatetime) {
      const startDate = startDatetime.slice(0, 10);
      const probableMatch = existingBookingRows.find((eb) => {
        if (existingDuplicate && eb.id === existingDuplicate.id) return false;
        if (eb.type !== type) return false;
        if (!eb.start_datetime || eb.start_datetime.slice(0, 10) !== startDate) return false;
        return sameFold(eb.origin, booking.origin ?? null) && sameFold(eb.destination, booking.destination ?? null);
      });
      if (probableMatch) {
        issues.push({
          severity: 'warning', code: 'probable_duplicate', bookingIndex: index,
          existingBookingId: probableMatch.id,
          message: 'A similar booking (same type, date, origin, and destination) already exists on this trip.',
        });
      }
    }
  }

  // The same rule writeBookingRow applies at insert time, so the preview and the
  // written row can never disagree about whether a stop is due.
  const showInItinerary = Boolean(defaultShowInItinerary({
    type, startDatetime, destination: booking.destination ?? null, showInItinerary: booking.showInItinerary,
  }));

  let plannedEffect = null;
  if (tripRow && startDatetime) {
    const startDate = startDatetime.slice(0, 10);
    if (!showInItinerary) {
      plannedEffect = { bookingIndex: index, stop: { willCreate: false, date: startDate, reason: 'not_shown_in_itinerary' } };
    } else if (!dayDates.has(startDate)) {
      issues.push({
        severity: 'info', code: 'no_day_for_date', bookingIndex: index,
        message: `The trip has no day for ${startDate}.`,
      });
      plannedEffect = { bookingIndex: index, stop: { willCreate: false, date: startDate, reason: 'no_day_for_date' } };
    } else {
      plannedEffect = { bookingIndex: index, stop: { willCreate: true, date: startDate } };
    }
  }

  const normalized = {
    type: type ?? null,
    title: typeof booking.title === 'string' ? booking.title.trim() : (booking.title ?? null),
    confirmationRef: booking.confirmationRef ?? null,
    bookingSource: booking.bookingSource ?? null,
    startDatetime,
    endDatetime,
    origin: booking.origin ?? null,
    destination: booking.destination ?? null,
    terminalOrStation: booking.terminalOrStation ?? null,
    originTz,
    destinationTz,
    detailsJson,
    showInItinerary,
  };

  return { normalized, issues, plannedEffect };
}

export async function validateBookingDraft({ userId, target, bookings, source }) {
  const issues = [];
  let tripRow = null;

  if (!target || typeof target !== 'object') {
    issues.push({ severity: 'blocker', code: 'missing_required_field', field: 'target', message: 'target is required.' });
  } else if (target.newTrip) {
    // W3 fills this in (D-28-5). W2 refuses unconditionally — never partially
    // validate a newTrip shape here, that would imply support that doesn't exist.
    issues.push({ severity: 'blocker', code: 'new_trip_invalid', message: 'Creating a new trip over MCP is not available yet.' });
  } else if (target.tripId) {
    try {
      // D-28-7: the only membership check on this path — never a raw query.
      tripRow = assertTripAccess(userId, target.tripId);
    } catch (error) {
      if (error.status === 404) {
        throw Object.assign(new Error('Trip not found'), { code: 'not_found', status: 404 });
      }
      throw error;
    }
  } else {
    issues.push({ severity: 'blocker', code: 'missing_required_field', field: 'target', message: 'target must include tripId or newTrip.' });
  }

  const normalizedSource = validateSourceShape(source, issues);

  let existingBookingRows = [];
  let dayDates = new Set();
  if (tripRow) {
    const db = getDb();
    existingBookingRows = db.prepare(`
      SELECT id, type, confirmation_ref, start_datetime, origin, destination
      FROM bookings WHERE trip_id = ?
    `).all(tripRow.id);
    dayDates = new Set(db.prepare('SELECT date FROM days WHERE trip_id = ?').all(tripRow.id).map((r) => r.date));
  }

  if (!Array.isArray(bookings) || bookings.length === 0) {
    issues.push({ severity: 'blocker', code: 'missing_required_field', field: 'bookings', message: 'At least one booking is required.' });
  }

  const normalizedBookings = [];
  const plannedEffects = [];

  if (Array.isArray(bookings) && bookings.length > 0) {
    // Deviation from the plan's closed issue-code list (recorded for the plan
    // orchestrator): the catalogue lists `multi_leg_detected` as the only signal
    // for >1 booking, but this version's write path (apply.js) only ever inserts
    // one booking — so >1 booking is refused outright with its own blocker, and
    // multi_leg_detected still fires alongside it as the informational signal the
    // catalogue describes.
    if (bookings.length > 1) {
      issues.push({
        severity: 'blocker', code: 'multi_booking_not_available',
        message: 'This version accepts one booking per draft.',
      });
      outer: for (let a = 0; a < bookings.length; a += 1) {
        for (let b = a + 1; b < bookings.length; b += 1) {
          const ba = bookings[a];
          const bb = bookings[b];
          if (ba?.type && ba.type === bb?.type && ba?.confirmationRef && bb?.confirmationRef
            && ba.confirmationRef.toLowerCase() === bb.confirmationRef.toLowerCase()) {
            issues.push({
              severity: 'info', code: 'multi_leg_detected',
              message: 'Multiple bookings in this draft share the same type and confirmation reference.',
            });
            break outer;
          }
        }
      }
    }

    for (let i = 0; i < bookings.length; i += 1) {
      const result = await validateOneBooking(bookings[i], i, { tripRow, existingBookingRows, dayDates });
      issues.push(...result.issues);
      normalizedBookings.push(result.normalized);
      if (result.plannedEffect) plannedEffects.push(result.plannedEffect);
    }
  }

  const applyAllowed = issues.every((issue) => issue.severity !== 'blocker');

  return {
    target,
    tripRow,
    bookings: normalizedBookings,
    issues,
    plannedEffects,
    applyAllowed,
    source: normalizedSource,
  };
}

export function summarizeDraft({ bookings, issues, plannedEffects, tripRow }) {
  const n = bookings.length;
  const tripPart = tripRow ? ` for "${tripRow.title}"` : '';
  const bookingParts = bookings.filter(Boolean).map((b) => {
    const range = b.endDatetime ? `${b.startDatetime} → ${b.endDatetime}` : (b.startDatetime || 'no date');
    return `${b.type || 'booking'} "${b.title || 'Untitled'}" ${range}`;
  });
  const stopParts = plannedEffects.map((effect) => (
    effect.stop.willCreate
      ? `a stop will be created on ${effect.stop.date}`
      : `no stop will be created (${effect.stop.reason})`
  ));

  const parts = [`${n} booking${n === 1 ? '' : 's'}${tripPart}: ${bookingParts.join('; ')}`, ...stopParts];

  const blockerCount = issues.filter((issue) => issue.severity === 'blocker').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  if (blockerCount) parts.push(`${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`);
  if (warningCount) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);

  return `${parts.join('; ')}.`;
}
