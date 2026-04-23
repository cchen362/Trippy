import { request } from './api.js';

export const discoveryApi = {
  discover: (tripId, destination, interestTags) =>
    request(`/api/trips/${tripId}/discover`, {
      method: 'POST',
      body: JSON.stringify({ destination, interestTags }),
    }),
  clearCache: (tripId) =>
    request(`/api/trips/${tripId}/discover/cache`, { method: 'DELETE' }),
};
