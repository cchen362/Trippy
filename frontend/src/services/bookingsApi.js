import { request } from './api.js';

export const bookingsApi = {
  list: (tripId) => request(`/api/trips/${tripId}/bookings`),
  create: (tripId, data) => request(`/api/trips/${tripId}/bookings`, { method: 'POST', body: data }),
  update: (bookingId, data) => request(`/api/bookings/${bookingId}`, { method: 'PATCH', body: data }),
  remove: (bookingId) => request(`/api/bookings/${bookingId}`, { method: 'DELETE' }),
  lookupHotels: (query) => request(`/api/lookups/places/hotels?q=${encodeURIComponent(query)}`),
  lookupFlight: ({ carrierCode, flightNumber, departureDate }) => request(
    `/api/lookups/flights?carrierCode=${encodeURIComponent(carrierCode)}&flightNumber=${encodeURIComponent(flightNumber)}&departureDate=${encodeURIComponent(departureDate)}`
  ),
};
