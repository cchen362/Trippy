import { useCallback, useState } from 'react';
import { bookingsApi } from '../services/bookingsApi.js';

export function useBookings({ tripId, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (action) => {
    setSaving(true);
    setError(null);
    try {
      const result = await action();
      await onChanged?.();
      return result;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [onChanged]);

  return {
    saving,
    error,
    createBooking: (data) => run(() => bookingsApi.create(tripId, data)),
    updateBooking: (bookingId, data) => run(() => bookingsApi.update(bookingId, data)),
    deleteBooking: (bookingId) => run(() => bookingsApi.remove(bookingId)),
    lookupHotels: bookingsApi.lookupHotels,
    lookupHotelDetails: bookingsApi.lookupHotelDetails,
    lookupFlight: bookingsApi.lookupFlight,
  };
}
