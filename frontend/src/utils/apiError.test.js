import { describe, expect, it } from 'vitest';
import { friendlyError } from './apiError.js';

describe('friendlyError', () => {
  it('maps NETWORK_ERROR to context-specific copy', () => {
    expect(friendlyError({ code: 'NETWORK_ERROR' }, 'auth')).toBe(
      "Can't reach Trippy right now. Check your connection and try again."
    );
    expect(friendlyError({ code: 'NETWORK_ERROR' }, 'trips')).toBe(
      "We can't load your trips right now. Check your connection and try again."
    );
  });

  it('maps TIMEOUT to the same context-specific copy as NETWORK_ERROR', () => {
    expect(friendlyError({ code: 'TIMEOUT' }, 'auth')).toBe(
      "Can't reach Trippy right now. Check your connection and try again."
    );
    expect(friendlyError({ code: 'TIMEOUT' }, 'trips')).toBe(
      "We can't load your trips right now. Check your connection and try again."
    );
  });

  it('maps 429 to a static cooldown copy for both contexts', () => {
    expect(friendlyError({ status: 429 }, 'auth')).toBe('Too many attempts. Please wait before trying again.');
    expect(friendlyError({ status: 429 }, 'trips')).toBe('Too many attempts. Please wait before trying again.');
  });

  it('passes through the server message for other statuses', () => {
    const err = { status: 401, message: 'Invalid credentials' };
    expect(friendlyError(err, 'auth')).toBe('Invalid credentials');
    expect(friendlyError(err, 'trips')).toBe('Invalid credentials');
  });

  it('falls back to a generic message when there is no code or status', () => {
    expect(friendlyError({}, 'auth')).toBe('Something went wrong. Please try again.');
    expect(friendlyError({}, 'trips')).toBe('Something went wrong. Please try again.');
  });
});
