import { request, requestStream } from './api.js';

export const copilotApi = {
  history: (tripId) => request(`/api/trips/${tripId}/copilot/history`),
  send: (tripId, message, onChunk) =>
    requestStream(`/api/trips/${tripId}/copilot`, { message }, onChunk),
  apply: (tripId, mutation) =>
    request(`/api/trips/${tripId}/copilot/apply`, {
      method: 'POST',
      body: mutation,
    }),
};
