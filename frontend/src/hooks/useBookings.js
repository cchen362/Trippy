import { useCallback, useState } from 'react';
import { bookingsApi } from '../services/bookingsApi.js';

export function useBookings({ tripId, onChanged }) {
  const [saving, setSaving] = useState(false);

  const run = useCallback(async (action) => {
    setSaving(true);
    try {
      const result = await action();
      await onChanged?.();
      return result;
    } finally {
      setSaving(false);
    }
  }, [onChanged]);

  return {
    saving,
    createBooking: (data) => run(() => bookingsApi.create(tripId, data)),
    updateBooking: (bookingId, data) => run(() => bookingsApi.update(bookingId, data)),
    deleteBooking: (bookingId, deleteExpenseIds) => run(() => bookingsApi.remove(bookingId, deleteExpenseIds)),
    lookupHotels: bookingsApi.lookupHotels,
    lookupHotelDetails: bookingsApi.lookupHotelDetails,
    lookupFlight: bookingsApi.lookupFlight,
    lookupCities: bookingsApi.lookupCities,
  };
}
