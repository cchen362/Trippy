import { describe, it, expect } from 'vitest';
import { runTripHealthChecks } from '../src/services/tripHealth.js';

function stop(overrides = {}) {
  return {
    id: 's1', title: 'Stop', type: 'experience', time: null, bookingId: null,
    locationStatus: 'resolved', ...overrides,
  };
}

function day(overrides = {}) {
  return { id: 'd1', date: '2026-05-01', stops: [], ...overrides };
}

// Single-day trip by default (zero hotel-nights needed) so tests for the other four
// checks don't also have to neutralize check 3 — tests that exercise check 3 override
// trip/bookings explicitly.
function tripDetail(overrides = {}) {
  return {
    trip: { startDate: '2026-05-01', endDate: '2026-05-01' },
    days: [],
    bookings: [],
    ...overrides,
  };
}

describe('runTripHealthChecks — clean trip', () => {
  it('yields zero findings for a healthy trip', () => {
    const detail = tripDetail({
      trip: { startDate: '2026-05-01', endDate: '2026-05-02' },
      days: [
        day({ id: 'd1', date: '2026-05-01', stops: [stop({ id: 's1', time: '09:00' })] }),
        day({ id: 'd2', date: '2026-05-02', stops: [stop({ id: 's2', time: null })] }),
      ],
      bookings: [{ id: 'b1', type: 'hotel', startDatetime: '2026-05-01T15:00', endDatetime: '2026-05-02T11:00' }],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });

  it('yields zero findings with no bookings, a single-day trip, and all-untimed stops', () => {
    const detail = tripDetail({
      trip: { startDate: '2026-05-01', endDate: '2026-05-01' },
      days: [day({ id: 'd1', date: '2026-05-01', stops: [stop({ id: 's1' }), stop({ id: 's2' })] })],
      bookings: [],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });
});

describe('check 1 — activity outside trip range', () => {
  it('flags a non-transit stop dated before the trip range when there is no transit anchor', () => {
    const detail = tripDetail({
      days: [
        day({ id: 'd0', date: '2026-04-30', stops: [stop({ id: 's0', title: 'Early museum' })] }),
        day({ id: 'd1', date: '2026-05-01', stops: [] }),
      ],
    });
    const findings = runTripHealthChecks(detail);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'activity_outside_range', dayId: 'd0', stopId: 's0' });
  });

  it('widens the range to a transit anchor so a stop on that day is no longer flagged', () => {
    const detail = tripDetail({
      days: [
        day({
          id: 'd0', date: '2026-04-30',
          stops: [stop({ id: 'flight', type: 'transit' }), stop({ id: 's0', title: 'Airport dinner' })],
        }),
        day({ id: 'd1', date: '2026-05-01', stops: [] }),
      ],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });

  it('never flags a transit stop itself', () => {
    const detail = tripDetail({
      days: [day({ id: 'd0', date: '2026-04-30', stops: [stop({ id: 'flight', type: 'transit' })] })],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });
});

describe('check 2 — overlapping timed anchors', () => {
  it('flags two stops sharing the exact same clock time on the same day', () => {
    const detail = tripDetail({
      days: [day({
        stops: [
          stop({ id: 's1', title: 'Dinner', time: '19:00' }),
          stop({ id: 's2', title: 'Show', time: '19:00' }),
        ],
      })],
    });
    const findings = runTripHealthChecks(detail);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'overlapping_anchors', dayId: 'd1' });
  });

  it('does not flag stops at different times or an untimed stop alongside a timed one', () => {
    const detail = tripDetail({
      days: [day({
        stops: [
          stop({ id: 's1', time: '09:00' }),
          stop({ id: 's2', time: '11:00' }),
          stop({ id: 's3', time: null }),
        ],
      })],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });
});

describe('check 3 — hotel-night gaps', () => {
  it('flags a night with no covering hotel booking', () => {
    const detail = tripDetail({
      trip: { startDate: '2026-05-01', endDate: '2026-05-04' },
      bookings: [{ id: 'b1', type: 'hotel', startDatetime: '2026-05-01T15:00', endDatetime: '2026-05-03T11:00' }],
    });
    const findings = runTripHealthChecks(detail);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'hotel_night_gap', date: '2026-05-03' });
  });

  it('reports zero gaps when a hotel booking spans every night', () => {
    const detail = tripDetail({
      trip: { startDate: '2026-05-01', endDate: '2026-05-04' },
      bookings: [{ id: 'b1', type: 'hotel', startDatetime: '2026-05-01T15:00', endDatetime: '2026-05-04T11:00' }],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });

  it('needs zero nights for a single-day trip regardless of bookings', () => {
    const detail = tripDetail({ trip: { startDate: '2026-05-01', endDate: '2026-05-01' }, bookings: [] });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });
});

describe('check 4 — unresolved stop locations', () => {
  it('flags a stop with locationStatus unresolved and leaves others alone', () => {
    const detail = tripDetail({
      days: [day({
        stops: [
          stop({ id: 's1', locationStatus: 'unresolved' }),
          stop({ id: 's2', locationStatus: 'user_confirmed' }),
        ],
      })],
    });
    const findings = runTripHealthChecks(detail);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'unresolved_location', stopId: 's1' });
  });
});

describe('check 5 — booking-linked stop time drift', () => {
  it('flags a stop whose time no longer matches its (timed) booking', () => {
    const detail = tripDetail({
      days: [day({ stops: [stop({ id: 's1', bookingId: 'b1', time: '09:00' })] })],
      bookings: [{ id: 'b1', type: 'flight', startDatetime: '2026-05-01T08:00' }],
    });
    const findings = runTripHealthChecks(detail);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'booking_time_drift', stopId: 's1', bookingId: 'b1' });
  });

  it('does not flag a stop already in sync with its booking', () => {
    const detail = tripDetail({
      days: [day({ stops: [stop({ id: 's1', bookingId: 'b1', time: '08:00' })] })],
      bookings: [{ id: 'b1', type: 'flight', startDatetime: '2026-05-01T08:00' }],
    });
    expect(runTripHealthChecks(detail)).toEqual([]);
  });

  it('applies the hotel 15:00 default when the booking carries a date but no time', () => {
    const drifted = tripDetail({
      days: [day({ stops: [stop({ id: 's1', bookingId: 'b1', time: '10:00' })] })],
      bookings: [{ id: 'b1', type: 'hotel', startDatetime: '2026-05-01' }],
    });
    expect(runTripHealthChecks(drifted)).toHaveLength(1);

    const inSync = tripDetail({
      days: [day({ stops: [stop({ id: 's1', bookingId: 'b1', time: '15:00' })] })],
      bookings: [{ id: 'b1', type: 'hotel', startDatetime: '2026-05-01' }],
    });
    expect(runTripHealthChecks(inSync)).toEqual([]);
  });

  it('skips drift detection when the booking has no date at all or is missing entirely', () => {
    const noBooking = tripDetail({
      days: [day({ stops: [stop({ id: 's1', bookingId: 'missing', time: '10:00' })] })],
      bookings: [],
    });
    expect(runTripHealthChecks(noBooking)).toEqual([]);

    const noStartDatetime = tripDetail({
      days: [day({ stops: [stop({ id: 's1', bookingId: 'b1', time: '10:00' })] })],
      bookings: [{ id: 'b1', type: 'flight', startDatetime: null }],
    });
    expect(runTripHealthChecks(noStartDatetime)).toEqual([]);
  });
});

describe('dayId scoping', () => {
  it('returns only findings attributable to the requested day', () => {
    const detail = tripDetail({
      trip: { startDate: '2026-05-01', endDate: '2026-05-03' },
      days: [
        day({ id: 'd1', date: '2026-05-01', stops: [stop({ id: 's1', locationStatus: 'unresolved' })] }),
        day({ id: 'd2', date: '2026-05-02', stops: [stop({ id: 's2', locationStatus: 'unresolved' })] }),
      ],
      bookings: [{ id: 'b1', type: 'hotel', startDatetime: '2026-05-01T15:00', endDatetime: '2026-05-03T11:00' }],
    });
    const scoped = runTripHealthChecks(detail, { dayId: 'd1' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ check: 'unresolved_location', dayId: 'd1' });
  });

  it('drops a day-less finding (hotel-night gap with no matching day row) when scoped', () => {
    const detail = tripDetail({
      trip: { startDate: '2026-05-01', endDate: '2026-05-03' },
      days: [],
      bookings: [],
    });
    // Unscoped: two dayless hotel_night_gap findings (no day rows at all).
    expect(runTripHealthChecks(detail)).toHaveLength(2);
    // Scoped to any dayId: dropped, since a dayless finding can't be attributed to it.
    expect(runTripHealthChecks(detail, { dayId: 'd1' })).toEqual([]);
  });
});
