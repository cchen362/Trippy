import { request } from './api.js';

export const factsApi = {
  // wait: the server holds the reply until this trip's document reads have settled (capped there).
  list: (tripId, { wait = false } = {}) => request(`/api/trips/${tripId}/facts${wait ? '?wait=1' : ''}`),
};
