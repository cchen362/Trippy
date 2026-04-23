// All fetch calls go through here. Throws on non-2xx.
async function request(path, options = {}) {
  const { silent401 = false, headers: extraHeaders, body, ...restOptions } = options;
  const res = await fetch(path, {
    credentials: 'include',
    ...restOptions,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !silent401) {
    window.dispatchEvent(new Event('auth:unauthorized'));
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status });
  }

  return res.json();
}

export const authApi = {
  status: () => request('/api/auth/status'),
  setup: (data) => request('/api/auth/setup', { method: 'POST', body: data }),
  login: (data) => request('/api/auth/login', { method: 'POST', body: data }),
  register: (data) => request('/api/auth/register', { method: 'POST', body: data }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me', { silent401: true }),
};

export const adminApi = {
  getInviteCode: () => request('/api/auth/admin/invite-code'),
  regenerateInviteCode: () => request('/api/auth/admin/invite-code', { method: 'POST' }),
  listUsers: () => request('/api/auth/admin/users'),
  deleteUser: (id) => request(`/api/auth/admin/users/${id}`, { method: 'DELETE' }),
};
