import { request, requestStream } from './api.js';

export const discoveryApi = {
  discover: (tripId, destination, countryCode, interestTags, onChunk, signal, more = false) =>
    requestStream(
      `/api/trips/${tripId}/discover`,
      {
        destination,
        interestTags,
        ...(countryCode ? { countryCode } : {}),
        ...(more ? { more: true } : {}),
      },
      onChunk,
      signal,
    ),
  reportPlace: (placeId, tripId) =>
    request(`/api/discovery/places/${placeId}/report`, { method: 'POST', body: { tripId } }),
};
