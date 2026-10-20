import { request } from './api.js';

export const factsApi = {
  list: (tripId) => request(`/api/trips/${tripId}/facts`),
};
