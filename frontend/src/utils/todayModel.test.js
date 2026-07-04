import { describe, expect, it } from 'vitest';
import { computeToday } from './todayModel.js';

const TODAY = '2026-07-10';
const YESTERDAY = '2026-07-09';
const TOMORROW = '2026-07-11';

function day(date, stops) {
  return { id: `day-${date}`, date, stops };
}

function stop({ id, time = null, title, sortOrder, bookingId = null }) {
  return { id, dayId: null, bookingId, time, title, sortOrder };
}

function booking({ id, type = 'other', title, startDatetime = null, endDatetime = null, originTz = null, showInItinerary = true }) {
  return { id, type, title, startDatetime, endDatetime, originTz, showInItinerary, documents: [] };
}

function nowAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = TODAY.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m);
}

describe('computeToday', () => {
  it('1. free day — no timed stops, no bookings, no active hotel', () => {
    const days = [day(TODAY, [stop({ id: 's1', title: 'Wander old town', sortOrder: 1 })])];
    const result = computeToday(days, [], nowAt('10:00'));
    expect(result.hero).toBeNull();
    expect(result.collapsed).toEqual([]);
    expect(result.upcoming).toHaveLength(1);
    expect(result.tonight).toBeNull();
  });

  it('2. morning activity collapses once an afternoon anchor passes', () => {
    const days = [
      day(TODAY, [
        stop({ id: 'a', title: 'Morning activity', sortOrder: 1 }),
        stop({ id: 'train', title: 'Train to next city', time: '14:00', sortOrder: 2 }),
        stop({ id: 'b', title: 'Later activity', sortOrder: 3 }),
      ]),
    ];
    const result = computeToday(days, [], nowAt('15:00'));
    const collapsedIds = result.collapsed.map((i) => i.id);
    expect(collapsedIds).toEqual(['a', 'train']);
    expect(result.upcoming.map((i) => i.id)).toEqual(['b']);
    expect(result.hero).toBeNull(); // train already passed, no hotel active
  });

  it('3. hero is the next unpassed timed anchor', () => {
    const days = [
      day(TODAY, [
        stop({ id: 'morning', title: 'Morning museum', time: '09:00', sortOrder: 1 }),
        stop({ id: 'afternoon', title: 'Afternoon temple', time: '13:00', sortOrder: 2 }),
      ]),
    ];
    const result = computeToday(days, [], nowAt('10:00'));
    expect(result.hero.stop.id).toBe('afternoon');
    expect(result.collapsed.map((i) => i.id)).toEqual(['morning']);
  });

  it('4. hotel fallback on check-in day', () => {
    const hotel = booking({ id: 'h1', type: 'hotel', title: 'Riverside Inn', startDatetime: `${TODAY}T15:00`, endDatetime: `${TOMORROW}T11:00` });
    const days = [day(TODAY, [stop({ id: 'a', title: 'Free activity', sortOrder: 1 })])];
    const result = computeToday(days, [hotel], nowAt('20:00'));
    expect(result.hero.kind).toBe('hotel');
    expect(result.hero.booking.id).toBe('h1');
    expect(result.tonight.id).toBe('h1');
  });

  it('5. hotel fallback fires every night of a multi-night stay', () => {
    const hotel = booking({
      id: 'h1', type: 'hotel', title: 'Riverside Inn',
      startDatetime: `${YESTERDAY}T15:00`, endDatetime: `${TOMORROW}T11:00`,
    });
    const days = [day(TODAY, [])];
    const result = computeToday(days, [hotel], nowAt('20:00'));
    expect(result.hero.kind).toBe('hotel');
    expect(result.hero.booking.id).toBe('h1');
  });

  it('6. hotel checkout day with no other anchors is a free day', () => {
    const hotel = booking({ id: 'h1', type: 'hotel', title: 'Riverside Inn', startDatetime: `${YESTERDAY}T15:00`, endDatetime: `${TODAY}T11:00` });
    const days = [day(TODAY, [])];
    const result = computeToday(days, [hotel], nowAt('09:00'));
    expect(result.hero).toBeNull();
    expect(result.tonight).toBeNull();
  });

  it('7. hidden booking anchors by time and collapses an earlier activity', () => {
    const hiddenFlight = booking({ id: 'f1', type: 'flight', title: 'Connecting flight', startDatetime: `${TODAY}T11:00`, showInItinerary: false });
    const days = [
      day(TODAY, [
        stop({ id: 'morning', title: 'Morning walk', sortOrder: 1 }),
        stop({ id: 'afternoon', title: 'Afternoon temple', time: '14:00', sortOrder: 2 }),
      ]),
    ];
    const result = computeToday(days, [hiddenFlight], nowAt('12:00'));
    // hidden flight (11:00) has passed; morning activity (sortOrder 1) is before it, so collapses
    expect(result.collapsed.map((i) => i.id)).toContain('morning');
    expect(result.collapsed.map((i) => i.id)).toContain('f1');
    expect(result.hero.stop.id).toBe('afternoon');
  });

  it('8. overnight booking departing yesterday does not re-anchor today', () => {
    const overnightTrain = booking({ id: 't1', type: 'train', title: 'Night train', startDatetime: `${YESTERDAY}T23:00`, endDatetime: `${TODAY}T02:00` });
    const days = [day(TODAY, [stop({ id: 'a', title: 'Activity', sortOrder: 1 })])];
    const result = computeToday(days, [overnightTrain], nowAt('10:00'));
    const allIds = [...result.collapsed, ...result.upcoming].map((i) => i.id);
    expect(allIds).not.toContain('t1');
    expect(result.hero).toBeNull();
  });

  it('9. same-time tie-break: stop-linked anchor wins over hidden booking anchor', () => {
    const hiddenFlight = booking({ id: 'f1', type: 'flight', title: 'Hidden flight', startDatetime: `${TODAY}T10:00`, showInItinerary: false });
    const days = [
      day(TODAY, [
        stop({ id: 'museum', title: 'Museum', time: '10:00', sortOrder: 1 }),
      ]),
    ];
    const result = computeToday(days, [hiddenFlight], nowAt('09:00'));
    // both unpassed at 09:00; hero should be the earlier-sorted one per tie-break (stop wins)
    expect(result.hero.kind).toBe('stop');
    expect(result.hero.stop.id).toBe('museum');
  });

  it('10. tomorrow-preview present and absent', () => {
    const daysWithTomorrow = [
      day(TODAY, []),
      day(TOMORROW, [stop({ id: 'x', title: 'Early departure', time: '08:15', sortOrder: 1 })]),
    ];
    const withPreview = computeToday(daysWithTomorrow, [], nowAt('10:00'));
    expect(withPreview.tomorrowFirst).toEqual({ time: '08:15', title: 'Early departure' });

    const daysNoTomorrow = [day(TODAY, []), day(TOMORROW, [])];
    const withoutPreview = computeToday(daysNoTomorrow, [], nowAt('10:00'));
    expect(withoutPreview.tomorrowFirst).toBeNull();
  });

  it('11. trailing activities after the last passed anchor stay in upcoming, not collapsed', () => {
    const days = [
      day(TODAY, [
        stop({ id: 'morning', title: 'Morning stop', time: '08:00', sortOrder: 1 }),
        stop({ id: 'later', title: 'Evening stroll', sortOrder: 2 }),
      ]),
    ];
    const result = computeToday(days, [], nowAt('20:00'));
    expect(result.collapsed.map((i) => i.id)).toEqual(['morning']);
    expect(result.upcoming.map((i) => i.id)).toEqual(['later']);
  });

  it('12. a hidden-from-itinerary booking linked to a stop is not double-counted', () => {
    const linkedFlight = booking({ id: 'f1', type: 'flight', title: 'Flight', startDatetime: `${TODAY}T09:00`, showInItinerary: false });
    const days = [
      day(TODAY, [
        stop({ id: 's1', title: 'Flight', time: '09:00', sortOrder: 1, bookingId: 'f1' }),
      ]),
    ];
    const result = computeToday(days, [linkedFlight], nowAt('08:00'));
    const allItems = [...result.collapsed, ...result.upcoming, result.hero].filter(Boolean);
    const flightRepresentations = allItems.filter((i) => i.stop?.bookingId === 'f1' || i.booking?.id === 'f1');
    expect(flightRepresentations).toHaveLength(1);
    expect(result.hero.kind).toBe('stop');
  });
});
