import { request } from './api.js';

export const mapApi = {
  config: (tripId) => request(`/api/trips/${tripId}/map-config`),
  data: (tripId) => request(`/api/trips/${tripId}/map-data`),
};
