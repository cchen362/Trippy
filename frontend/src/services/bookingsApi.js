import { request } from './api.js';

export const bookingsApi = {
  list: (tripId) => request(`/api/trips/${tripId}/bookings`),
  create: (tripId, data) => request(`/api/trips/${tripId}/bookings`, { method: 'POST', body: data }),
  update: (bookingId, data) => request(`/api/bookings/${bookingId}`, { method: 'PATCH', body: data }),
  remove: (bookingId, deleteExpenseIds) =>
    request(`/api/bookings/${bookingId}`, {
      method: 'DELETE',
      ...(deleteExpenseIds?.length ? { body: { deleteExpenseIds } } : {}),
    }),
  listAttachments: (bookingId) => request(`/api/bookings/${bookingId}/attachments`),
  addAttachment: (bookingId, { mediaType, filename, content }) =>
    request(`/api/bookings/${bookingId}/attachments`, { method: 'POST', body: { mediaType, filename, content } }),
  removeAttachment: (bookingId, attachmentId) =>
    request(`/api/bookings/${bookingId}/attachments/${attachmentId}`, { method: 'DELETE' }),
  lookupHotels: (query, sessionToken) => {
    const params = new URLSearchParams({ q: query });
    if (sessionToken) params.set('sessionToken', sessionToken);
    return request(`/api/lookups/places/hotels?${params}`);
  },
  lookupHotelDetails: (placeId, sessionToken) => {
    const params = new URLSearchParams();
    if (sessionToken) params.set('sessionToken', sessionToken);
    const qs = params.size ? `?${params}` : '';
    return request(`/api/lookups/places/${encodeURIComponent(placeId)}${qs}`);
  },
  lookupPlaces: (query, sessionToken, near) => {
    const params = new URLSearchParams({ q: query });
    if (sessionToken) params.set('sessionToken', sessionToken);
    if (near) params.set('near', near);
    return request(`/api/lookups/places/search?${params}`);
  },
  lookupCities: (query, sessionToken) => {
    const params = new URLSearchParams({ q: query });
    if (sessionToken) params.set('sessionToken', sessionToken);
    return request(`/api/lookups/destinations?${params}`);
  },
  lookupDestinationBounds: (placeId, sessionToken) => {
    const params = new URLSearchParams({ placeId });
    if (sessionToken) params.set('sessionToken', sessionToken);
    return request(`/api/lookups/destination-bounds?${params}`);
  },
  lookupFlight: ({ carrierCode, flightNumber, flightQuery, departureDate }) => {
    const params = new URLSearchParams({ departureDate });
    if (flightQuery) {
      params.set('flightQuery', flightQuery);
    } else {
      params.set('carrierCode', carrierCode);
      params.set('flightNumber', flightNumber);
    }
    return request(`/api/lookups/flights?${params.toString()}`);
  },
};
