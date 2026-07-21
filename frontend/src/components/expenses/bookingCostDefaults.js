import { localIso } from '../../utils/date.js';

// A cost created from booking context inherits the booking's identity, but it is its
// own financial record from that moment on — editing the booking later never rewrites it.
export const CATEGORY_BY_BOOKING_TYPE = { hotel: 'lodging', flight: 'transport', train: 'transport', bus: 'transport', ferry: 'transport', other: 'other' };

export function categoryForBookingType(type) {
  return CATEGORY_BY_BOOKING_TYPE[type] ?? 'other';
}

export function bookingCostDefaults(booking, currentUserId) {
  return {
    title: booking.title || '',
    category: categoryForBookingType(booking.type),
    expenseDate: localIso(),
    payerUserId: currentUserId,
  };
}
