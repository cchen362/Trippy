import { localIso, naiveIsoToAbsolute } from './date.js';

function localIsoFromDatetime(iso) {
  return iso.split('T')[0];
}

function timeOfDay(iso) {
  const [, timePart = '00:00'] = iso.split('T');
  return timePart.slice(0, 5);
}

function addDaysIso(iso, n) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + n);
  return localIso(date);
}

// Absolute instant for a booking's naive wall-clock datetime, preferring its
// own timezone (D1) so "has passed" is correct even if the device clock is in
// a different zone than the booking (e.g. the day of a long-haul flight).
// Falls back to device-local interpretation when no tz is stored.
function bookingInstant(iso, tz) {
  if (tz) {
    try {
      return naiveIsoToAbsolute(iso, tz);
    } catch {
      // unknown/invalid tz — fall through to device-local parsing
    }
  }
  return new Date(iso);
}

function tonightHotelHero(bookings, todayIso) {
  return (
    bookings.find((b) => {
      if (b.type !== 'hotel') return false;
      if (!b.startDatetime || !b.endDatetime) return false;
      const checkIn = localIsoFromDatetime(b.startDatetime);
      const checkOut = localIsoFromDatetime(b.endDatetime);
      // Active every night of the stay — check-in through the night before
      // checkout — not just the first night.
      return checkIn <= todayIso && todayIso < checkOut;
    }) || null
  );
}

function firstTimedItemForDay(day, bookings) {
  if (!day) return null;
  const dayIso = day.date;
  const stops = [...day.stops].sort((a, b) => a.sortOrder - b.sortOrder);
  const stopBookingIds = new Set(stops.filter((s) => s.bookingId).map((s) => s.bookingId));

  const candidates = [];
  stops.forEach((stop) => {
    if (stop.time) candidates.push({ time: stop.time, title: stop.title });
  });
  bookings.forEach((b) => {
    if (b.type === 'hotel') return;
    if (!b.startDatetime) return;
    if (localIsoFromDatetime(b.startDatetime) !== dayIso) return;
    if (stopBookingIds.has(b.id)) return; // already represented by a stop above
    candidates.push({ time: timeOfDay(b.startDatetime), title: b.title });
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return candidates[0];
}

function emptyResult(days, bookings, todayIso) {
  const tomorrowDay = days.find((d) => d.date === addDaysIso(todayIso, 1));
  return {
    collapsed: [],
    hero: null,
    upcoming: [],
    tonight: tonightHotelHero(bookings, todayIso),
    tomorrowFirst: firstTimedItemForDay(tomorrowDay, bookings),
  };
}

// Pure anchor-flow derivation (D2). Anchors are today's bookings (by their
// departure/relevant local date — never arrival, so overnight bookings only
// anchor their departure day) plus any stop with an explicit time. Activities
// (untimed stops) are never individually clock-judged — one collapses only
// once an anchor positioned after it in the day's order has passed.
export function computeToday(days, bookings, now = new Date()) {
  const todayIso = localIso(now);
  const todayDay = days.find((d) => d.date === todayIso);
  if (!todayDay) return emptyResult(days, bookings, todayIso);

  const bookingsById = new Map(bookings.map((b) => [b.id, b]));
  const stops = [...todayDay.stops].sort((a, b) => a.sortOrder - b.sortOrder);
  const activities = stops.filter((s) => !s.time);

  const stopBookingIds = new Set(stops.filter((s) => s.bookingId).map((s) => s.bookingId));

  const todaysBookingAnchors = bookings.filter((b) => {
    if (b.type === 'hotel') return false;
    if (!b.startDatetime) return false;
    return localIsoFromDatetime(b.startDatetime) === todayIso;
  });
  // Anchors hidden from the itinerary (or simply unlinked to a stop today)
  // still anchor by time — they just have no native sortOrder.
  const hiddenAnchors = todaysBookingAnchors.filter((b) => !stopBookingIds.has(b.id));

  const timedAnchors = [];

  stops.forEach((stop) => {
    if (!stop.time) return;
    const booking = stop.bookingId ? bookingsById.get(stop.bookingId) || null : null;
    timedAnchors.push({
      kind: 'stop',
      id: stop.id,
      time: stop.time,
      sortOrder: stop.sortOrder,
      stop,
      booking,
    });
  });

  hiddenAnchors.forEach((booking) => {
    timedAnchors.push({
      kind: 'booking',
      id: booking.id,
      time: timeOfDay(booking.startDatetime),
      sortOrder: null,
      stop: null,
      booking,
    });
  });

  // Sort by clock time; same-time tie-break: stop-linked anchors win over
  // hidden booking anchors (rare collision — a deterministic, documented rule
  // rather than one with real-world stakes), then stable by id.
  timedAnchors.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'stop' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  timedAnchors.forEach((anchor) => {
    const instant = anchor.booking?.startDatetime
      ? bookingInstant(anchor.booking.startDatetime, anchor.booking.originTz)
      : new Date(`${todayIso}T${anchor.time}`);
    anchor.passed = instant <= now;
  });

  // Give every hidden (no-stop) anchor a synthetic position between the
  // timed stops immediately before/after it by clock time, so the whole day
  // — activities, stop-anchors, and hidden anchors alike — can be ordered
  // as one sequence for the collapse rule below.
  const timedStopsOnly = timedAnchors.filter((a) => a.kind === 'stop');
  timedAnchors.forEach((anchor) => {
    if (anchor.kind !== 'booking') return;
    const before = [...timedStopsOnly].reverse().find((a) => a.time <= anchor.time);
    const after = timedStopsOnly.find((a) => a.time > anchor.time);
    if (before) anchor.sortOrder = before.sortOrder + 0.5;
    else if (after) anchor.sortOrder = after.sortOrder - 0.5;
    else anchor.sortOrder = -0.5; // no timed stops today at all
  });

  const daySequence = [
    ...activities.map((s) => ({ kind: 'activity', id: s.id, sortOrder: s.sortOrder, stop: s, booking: null })),
    ...timedAnchors,
  ].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return String(a.id).localeCompare(String(b.id));
  });

  const nextAnchor = timedAnchors.find((a) => !a.passed) || null;
  const tonight = tonightHotelHero(bookings, todayIso);
  const hero = nextAnchor
    ? { kind: nextAnchor.kind, time: nextAnchor.time, stop: nextAnchor.stop, booking: nextAnchor.booking }
    : tonight
      ? { kind: 'hotel', booking: tonight }
      : null;

  let cutoffSortOrder = null;
  daySequence.forEach((item) => {
    if ((item.kind === 'stop' || item.kind === 'booking') && item.passed) {
      cutoffSortOrder = item.sortOrder;
    }
  });

  const collapsed = [];
  const upcoming = [];
  daySequence.forEach((item) => {
    if (item === nextAnchor) return; // hero is rendered separately, never listed
    if (cutoffSortOrder !== null && item.sortOrder <= cutoffSortOrder) {
      collapsed.push(item);
    } else {
      upcoming.push(item);
    }
  });

  const tomorrowDay = days.find((d) => d.date === addDaysIso(todayIso, 1));
  const tomorrowFirst = firstTimedItemForDay(tomorrowDay, bookings);

  return { collapsed, hero, upcoming, tonight, tomorrowFirst };
}
