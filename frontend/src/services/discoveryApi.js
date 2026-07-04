import { requestStream } from './api.js';

export const discoveryApi = {
  discover: (tripId, destination, interestTags, onChunk, signal, more = false) =>
    requestStream(
      `/api/trips/${tripId}/discover`,
      { destination, interestTags, ...(more ? { more: true } : {}) },
      onChunk,
      signal,
    ),
};
