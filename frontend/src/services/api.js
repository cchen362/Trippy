// All fetch calls go through here. Throws on non-2xx.
export async function request(path, options = {}) {
  const { silent401 = false, headers: extraHeaders, body, timeoutMs, ...restOptions } = options;

  let signal = restOptions.signal;
  let timer;
  let controller;
  if (timeoutMs) {
    controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetch(path, {
      credentials: 'include',
      ...restOptions,
      signal,
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
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('Request timed out'), { status: 408, timeout: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestStream(path, body, onChunk, signal) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (res.status === 401) {
    window.dispatchEvent(new Event('auth:unauthorized'));
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status });
  }

  if (!res.body) {
    throw new Error('SSE response has no body');
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  const parseChunk = (line) => {
    if (!line.startsWith('data: ')) return;
    try {
      onChunk(JSON.parse(line.slice(6)));
    } catch (e) {
      console.error('[requestStream] malformed SSE chunk:', line, e);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // keep incomplete chunk
      for (const line of lines) parseChunk(line);
    }
    // Flush any trailing data that arrived without a trailing blank line
    if (buffer) parseChunk(buffer);
  } finally {
    reader.cancel();
  }
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
