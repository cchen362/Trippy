import { request, requestStream } from './api.js';

export const copilotApi = {
  history: (tripId) => request(`/api/trips/${tripId}/copilot/history`),
  send: (tripId, message, onChunk, signal) =>
    requestStream(`/api/trips/${tripId}/copilot`, { message }, onChunk, signal),
  apply: (tripId, proposalId) =>
    request(`/api/trips/${tripId}/copilot/apply`, {
      method: 'POST',
      body: { proposalId },
    }),
  reject: (tripId, proposalId) =>
    request(`/api/trips/${tripId}/copilot/proposals/${proposalId}/reject`, { method: 'POST' }),
  clear: (tripId) =>
    request(`/api/trips/${tripId}/copilot/history`, { method: 'DELETE' }),
};
