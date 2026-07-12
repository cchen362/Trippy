// Deterministic trip-health checks (Plan 12 Wave 3, G6). Pure functions over the
// getTripDetail() shape — no DB, no model calls. The model explains/prioritizes
// findings and offers repairs through the normal propose_itinerary_changes path;
// detection itself lives entirely here so it is honest and reproducible.
//
// Boundaries this file enforces on purpose (do not "improve" past them):
// - Check 2 (overlapping anchors) never infers a missing duration — it only flags
//   two timed stops sharing the exact same clock time. Durations are soft hints
//   elsewhere in the product; treating them as hard intervals would be a guess.
// - Check 1 (activity outside range) widens the trip's date range to the
//   first/last day carrying a transit stop when any exist (an overnight flight can
//   legitimately sit outside trip.startDate/endDate), falling back to the trip's
//   own dates only when there are no transit stops at all.
// - Check 5 (booking time drift) mirrors services/stops.js's inferBookingStop time
//   derivation exactly (hotel defaults to 15:00 when the booking carries a date but
//   no time; other types require a full ISO datetime) so "drift" only ever means
//   the stop's own `time` disagrees with what its booking would produce today.

function checkActivityOutsideRange(trip, days) {
  const findings = [];
  const transitDates = [];
  for (const day of days) {
    for (const stop of day.stops || []) {
      if (stop.type === 'transit') transitDates.push(day.date);
    }
  }
  transitDates.sort();

  const rangeStart = transitDates[0] || trip.startDate;
  const rangeEnd = transitDates[transitDates.length - 1] || trip.endDate;
  if (!rangeStart || !rangeEnd) return findings;

  for (const day of days) {
    if (day.date >= rangeStart && day.date <= rangeEnd) continue;
    for (const stop of day.stops || []) {
      if (stop.type === 'transit') continue;
      findings.push({
        check: 'activity_outside_range',
        severity: 'warning',
        message: `"${stop.title}" is scheduled on ${day.date}, outside the trip's active range (${rangeStart} to ${rangeEnd}).`,
        dayId: day.id,
        stopId: stop.id,
        date: day.date,
      });
    }
  }
  return findings;
}

function checkOverlappingAnchors(days) {
  const findings = [];
  for (const day of days) {
    const timed = (day.stops || []).filter((stop) => stop.time);
    for (let i = 0; i < timed.length; i += 1) {
      for (let j = i + 1; j < timed.length; j += 1) {
        if (timed[i].time !== timed[j].time) continue;
        findings.push({
          check: 'overlapping_anchors',
          severity: 'warning',
          message: `"${timed[i].title}" and "${timed[j].title}" are both set for ${timed[i].time} on ${day.date}.`,
          dayId: day.id,
          stopId: timed[i].id,
          date: day.date,
        });
      }
    }
  }
  return findings;
}

function eachNight(startDate, endDate) {
  const nights = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor < end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

function checkHotelNightGaps(trip, days, bookings) {
  const findings = [];
  if (!trip.startDate || !trip.endDate) return findings;

  const hotelBookings = bookings.filter(
    (booking) => booking.type === 'hotel' && booking.startDatetime && booking.endDatetime,
  );
  const dayByDate = new Map(days.map((day) => [day.date, day]));

  for (const night of eachNight(trip.startDate, trip.endDate)) {
    const covered = hotelBookings.some((booking) => {
      const checkIn = String(booking.startDatetime).slice(0, 10);
      const checkOut = String(booking.endDatetime).slice(0, 10);
      return checkIn <= night && night < checkOut;
    });
    if (covered) continue;

    const day = dayByDate.get(night);
    findings.push({
      check: 'hotel_night_gap',
      severity: 'warning',
      message: `No hotel booking covers the night of ${night}.`,
      dayId: day ? day.id : undefined,
      date: night,
    });
  }
  return findings;
}

function checkUnresolvedLocations(days) {
  const findings = [];
  for (const day of days) {
    for (const stop of day.stops || []) {
      if (stop.locationStatus !== 'unresolved') continue;
      findings.push({
        check: 'unresolved_location',
        severity: 'info',
        message: `"${stop.title}" doesn't have a resolved map location yet.`,
        dayId: day.id,
        stopId: stop.id,
        date: day.date,
      });
    }
  }
  return findings;
}

// Mirrors stops.js's inferBookingStop time derivation exactly (not a new inference —
// the same rule that already governs what time a booking-linked stop should carry).
function expectedBookingStopTime(booking) {
  const [datePart, timePart] = String(booking.startDatetime || '').split('T');
  if (booking.type === 'hotel') {
    if (!datePart) return null;
    return timePart ? timePart.slice(0, 5) : '15:00';
  }
  if (!datePart || !timePart) return null;
  return timePart.slice(0, 5);
}

function checkBookingTimeDrift(days, bookings) {
  const findings = [];
  const bookingsById = new Map(bookings.map((booking) => [booking.id, booking]));

  for (const day of days) {
    for (const stop of day.stops || []) {
      if (stop.bookingId == null) continue;
      const booking = bookingsById.get(stop.bookingId);
      if (!booking) continue;

      const expected = expectedBookingStopTime(booking);
      if (expected === null || stop.time === expected) continue;

      findings.push({
        check: 'booking_time_drift',
        severity: 'warning',
        message: `"${stop.title}" shows ${stop.time ?? 'no time'}, but its booking is at ${expected}.`,
        dayId: day.id,
        stopId: stop.id,
        bookingId: booking.id,
        date: day.date,
      });
    }
  }
  return findings;
}

// runTripHealthChecks(tripDetail, { dayId? }) — tripDetail is the exact getTripDetail()
// return shape. When dayId is given, results are scoped to findings attributable to
// that day (a finding with no day, like an unmatched hotel-night gap, is dropped rather
// than guessed into a day).
export function runTripHealthChecks(tripDetail, { dayId } = {}) {
  const { trip, days = [], bookings = [] } = tripDetail;

  const findings = [
    ...checkActivityOutsideRange(trip, days),
    ...checkOverlappingAnchors(days),
    ...checkHotelNightGaps(trip, days, bookings),
    ...checkUnresolvedLocations(days),
    ...checkBookingTimeDrift(days, bookings),
  ];

  if (dayId) return findings.filter((finding) => finding.dayId === dayId);
  return findings;
}
