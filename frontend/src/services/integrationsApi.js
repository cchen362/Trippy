import { request } from './api.js';

export const integrationsApi = {
  list: () => request('/api/integrations/tokens'),
  create: (data) => request('/api/integrations/tokens', { method: 'POST', body: data }),
  revoke: (id) => request(`/api/integrations/tokens/${id}/revoke`, { method: 'POST' }),
  remove: (id) => request(`/api/integrations/tokens/${id}`, { method: 'DELETE' }),
};
