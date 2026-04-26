import { request, requestStream } from './api.js';

export const discoveryApi = {
  discover: (tripId, destination, interestTags, onChunk, signal) =>
    requestStream(
      `/api/trips/${tripId}/discover`,
      { destination, interestTags },
      onChunk,
      signal,
    ),
  clearCache: (tripId, destination) =>
    request(`/api/trips/${tripId}/discover/cache`, { method: 'DELETE', body: destination ? { destination } : undefined }),
};
