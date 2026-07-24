// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { request } from './api.js';

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
