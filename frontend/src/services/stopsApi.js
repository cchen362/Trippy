import { request } from './api.js';

export const stopsApi = {
  create: (dayId, data) => request(`/api/days/${dayId}/stops`, { method: 'POST', body: data }),
  update: (stopId, data) => request(`/api/stops/${stopId}`, { method: 'PATCH', body: data }),
  remove: (stopId) => request(`/api/stops/${stopId}`, { method: 'DELETE' }),
  reorder: (dayId, orderedStopIds) => request(`/api/days/${dayId}/stops/reorder`, {
    method: 'POST',
    body: { orderedStopIds },
  }),
};
