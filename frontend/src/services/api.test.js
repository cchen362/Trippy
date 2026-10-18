// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { request, requestStream } from './api.js';

function jsonResponse({ ok, status, body }) {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe('request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a fetch TypeError("Failed to fetch") to a NETWORK_ERROR with no status', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    let caught;
    try {
      await request('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('NETWORK_ERROR');
    expect(caught.status).toBeUndefined();
  });

  it('maps a fetch TypeError("Load failed") to NETWORK_ERROR regardless of browser wording', async () => {
    fetch.mockRejectedValue(new TypeError('Load failed'));
    let caught;
    try {
      await request('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('NETWORK_ERROR');
    expect(caught.status).toBeUndefined();
  });

  it('does not tag a malformed 2xx body with code or status', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('bad json')),
    });
    let caught;
    try {
      await request('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBeUndefined();
    expect(caught.status).toBeUndefined();
  });

  it('preserves a 429 status with no code', async () => {
    fetch.mockResolvedValue(
      jsonResponse({ ok: false, status: 429, body: { error: 'Too many requests, please try again later' } })
    );
    let caught;
    try {
      await request('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(429);
    expect(caught.code).toBeUndefined();
  });

  it('preserves a 401 status and message', async () => {
    fetch.mockResolvedValue(
      jsonResponse({ ok: false, status: 401, body: { error: 'Invalid credentials' } })
    );
    let caught;
    try {
      await request('/api/x', { silent401: true });
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(401);
    expect(caught.message).toBe('Invalid credentials');
  });

  it('preserves a 400 status and message', async () => {
    fetch.mockResolvedValue(
      jsonResponse({ ok: false, status: 400, body: { error: 'Missing fields' } })
    );
    let caught;
    try {
      await request('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught.status).toBe(400);
    expect(caught.message).toBe('Missing fields');
  });

  it('returns the parsed body on a happy path', async () => {
    fetch.mockResolvedValue(jsonResponse({ ok: true, status: 200, body: { trips: [] } }));
    const result = await request('/api/x');
    expect(result).toEqual({ trips: [] });
  });
});

// Builds a fetch Response whose body is a real ReadableStream of SSE bytes. When
// `signal` is given the stream errors the way a browser's fetch body does on
// abort, so reader.read() rejects with an AbortError.
function sseResponse(parts, { signal, hold = false } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (!hold) controller.close();
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
  return { ok: true, status: 200, body };
}

describe('requestStream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers every chunk, including a trailing one with no blank line', async () => {
    fetch.mockResolvedValue(
      sseResponse(['data: {"n":1}\n\ndata: {"n":2}\n\n', 'data: {"n"', ':3}'])
    );
    const chunks = [];
    await requestStream('/api/x', {}, (c) => chunks.push(c));
    expect(chunks).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('rejects the caller with AbortError on abort and leaves no unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      fetch.mockImplementation((path, init) =>
        Promise.resolve(sseResponse(['data: {"n":1}\n\n'], { signal: init.signal, hold: true }))
      );
      const chunks = [];
      const pending = requestStream('/api/x', {}, (c) => chunks.push(c), controller.signal);
      // Let the first chunk through, then abort mid-stream.
      await vi.waitFor(() => expect(chunks).toEqual([{ n: 1 }]));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      // Unhandled rejections surface on a later macrotask than the rejection itself.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
