// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStops } from './useStops.js';
import { stopsApi } from '../services/stopsApi.js';

vi.mock('../services/stopsApi.js', () => ({
  stopsApi: {
    update: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Plan 21 W1 / D3: useStops opts into the shared page banner. A rejected stop
// mutation must route its error to onError AND rethrow so the caller can react.
describe('useStops onError contract (Plan 21 D3)', () => {
  it('calls onError with the error and rethrows when a mutation rejects', async () => {
    const failure = new Error('stop update failed');
    stopsApi.update.mockRejectedValueOnce(failure);
    const onError = vi.fn();

    const { result } = renderHook(() => useStops({ onChanged: vi.fn(), onError }));

    let caught;
    await act(async () => {
      try {
        await result.current.updateStop('stop-1', { note: 'x' });
      } catch (err) {
        caught = err;
      }
    });

    // The banner channel received it...
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    // ...and the caller still saw the rejection (rethrow preserved — D5).
    expect(caught).toBe(failure);
    // saving flag released in finally.
    expect(result.current.saving).toBe(false);
  });

  it('no longer exposes a latched error field', () => {
    const { result } = renderHook(() => useStops({ onChanged: vi.fn(), onError: vi.fn() }));
    expect('error' in result.current).toBe(false);
  });
});
