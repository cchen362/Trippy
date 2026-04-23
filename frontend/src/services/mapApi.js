import { request } from './api.js';

export const mapApi = {
  config: (tripId) => request(`/api/trips/${tripId}/map-config`),
};
