import { request } from './api.js';

export const expensesApi = {
  list: (tripId) => request(`/api/trips/${tripId}/expenses`),
  create: (tripId, data) => request(`/api/trips/${tripId}/expenses`, { method: 'POST', body: data }),
  update: (tripId, expenseId, data) => request(`/api/trips/${tripId}/expenses/${expenseId}`, {
    method: 'PATCH',
    body: data,
  }),
  remove: (tripId, expenseId) => request(`/api/trips/${tripId}/expenses/${expenseId}`, { method: 'DELETE' }),
  setOwedSettled: (tripId, expenseId, owedId, settled) => request(
    `/api/trips/${tripId}/expenses/${expenseId}/owed/${owedId}`,
    { method: 'PATCH', body: { settled } },
  ),
};
