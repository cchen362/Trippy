// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTrip } from './useTrip.js';
import { tripsApi } from '../services/tripsApi.js';

vi.mock('../services/tripsApi.js', () => ({
  tripsApi: {
    detail: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const detail = (label) => ({
  trip: { id: 'trip-1' },
  days: [{ id: `day-${label}` }],
  bookings: [],
  label,
});

describe('useTrip.refresh — request id guard (Wave 4 §4.1, fixture F8)', () => {
  it('drops an older response that resolves after a newer one', async () => {
    const r1 = deferred();
    const r2 = deferred();
    tripsApi.detail.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);

    const { result } = renderHook(() => useTrip('trip-1'));

    // Initial mount fires refresh() once (R1). Fire a second refresh (R2)
    // before R1 resolves.
    await act(async () => {
      result.current.refresh();
    });

    expect(tripsApi.detail).toHaveBeenCalledTimes(2);

    // R2 (the newer request) resolves first...
    await act(async () => {
      r2.resolve(detail('R2'));
      await Promise.resolve();
    });
    expect(result.current.detail?.label).toBe('R2');

    // ...then R1 (the older, stale request) resolves after it. Its payload
    // must be dropped — state must still reflect R2.
    await act(async () => {
      r1.resolve(detail('R1'));
      await Promise.resolve();
    });
    expect(result.current.detail?.label).toBe('R2');
    expect(result.current.loading).toBe(false);
  });

  it('surfaces an error from a stale response only if it is still the latest request', async () => {
    const r1 = deferred();
    const r2 = deferred();
    tripsApi.detail.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);

    const { result } = renderHook(() => useTrip('trip-1'));

    await act(async () => {
      result.current.refresh();
    });

    // Newer request (R2) succeeds first.
    await act(async () => {
      r2.resolve(detail('R2'));
      await Promise.resolve();
    });
    expect(result.current.detail?.label).toBe('R2');
    expect(result.current.error).toBeNull();

    // Older request (R1) rejects after R2 already landed — must not clobber
    // the already-successful state with a stale error.
    await act(async () => {
      r1.reject(new Error('stale failure'));
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.detail?.label).toBe('R2');
  });
});
