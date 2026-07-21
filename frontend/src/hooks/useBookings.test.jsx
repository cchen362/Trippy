// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBookings } from './useBookings.js';
import { bookingsApi } from '../services/bookingsApi.js';

vi.mock('../services/bookingsApi.js', () => ({
  bookingsApi: {
    remove: vi.fn(),
    lookupHotels: vi.fn(),
    lookupHotelDetails: vi.fn(),
    lookupFlight: vi.fn(),
    lookupCities: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Plan 21 W1 / D3: useBookings does NOT opt into the shared page banner. Booking
// failures are owned inline by the modals/tabs. The hook must have no error
// side-channel at all — only a rethrow so callers can render inline.
describe('useBookings owns errors inline, not via the banner (Plan 21 D3)', () => {
  it('rethrows a rejected mutation without any onError channel', async () => {
    const failure = new Error('booking delete failed');
    bookingsApi.remove.mockRejectedValueOnce(failure);

    const { result } = renderHook(() => useBookings({ tripId: 'trip-1', onChanged: vi.fn() }));

    let caught;
    await act(async () => {
      try {
        await result.current.deleteBooking('booking-1', []);
      } catch (err) {
        caught = err;
      }
    });

    // Caller must see the rejection to render its inline error.
    expect(caught).toBe(failure);
    expect(result.current.saving).toBe(false);
  });

  it('exposes no latched error field for anything to mirror into the banner', () => {
    const { result } = renderHook(() => useBookings({ tripId: 'trip-1', onChanged: vi.fn() }));
    expect('error' in result.current).toBe(false);
  });
});
