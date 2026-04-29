import { request } from './api.js';

export const tripsApi = {
  list: () => request('/api/trips'),
  create: (data) => request('/api/trips', { method: 'POST', body: data }),
  detail: (tripId) => request(`/api/trips/${tripId}/detail`),
  days: (tripId) => request(`/api/trips/${tripId}/days`),
  collaborators: (tripId) => request(`/api/trips/${tripId}/collaborators`),
  inviteCollaborator: (tripId, username) => request(`/api/trips/${tripId}/collaborators`, {
    method: 'POST',
    body: { username },
  }),
  removeCollaborator: (tripId, userId) => request(`/api/trips/${tripId}/collaborators/${userId}`, {
    method: 'DELETE',
  }),
  createShareLink: (tripId) => request(`/api/trips/${tripId}/share`, { method: 'POST' }),
  update: (tripId, data) => request(`/api/trips/${tripId}`, { method: 'PATCH', body: data }),
  remove: (tripId) => request(`/api/trips/${tripId}`, { method: 'DELETE' }),
  sharedDetail: (token) => request(`/api/share/${token}`, { silent401: true }),
  patchDayCityOverride: (tripId, date, cityOverride) => request(`/api/trips/${tripId}/days/${date}`, {
    method: 'PATCH',
    body: { cityOverride: cityOverride ?? null },
  }),
};
