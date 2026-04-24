import { request } from './api.js';

export const tripsApi = {
  list: () => request('/api/trips'),
  create: (data) => request('/api/trips', { method: 'POST', body: data }),
  detail: (tripId) => request(`/api/trips/${tripId}/detail`),
  days: (tripId) => request(`/api/trips/${tripId}/days`),
};
