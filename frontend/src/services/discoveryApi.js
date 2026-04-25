import { request } from './api.js';

export const discoveryApi = {
  discover: (tripId, destination, interestTags) =>
    request(`/api/trips/${tripId}/discover`, {
      method: 'POST',
      body: { destination, interestTags },
      timeoutMs: 60000,
    }),
  clearCache: (tripId) =>
    request(`/api/trips/${tripId}/discover/cache`, { method: 'DELETE' }),
};
