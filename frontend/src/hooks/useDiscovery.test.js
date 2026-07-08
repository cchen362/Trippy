// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDiscovery } from './useDiscovery.js';
import { discoveryApi } from '../services/discoveryApi.js';

vi.mock('../services/discoveryApi.js', () => ({
  discoveryApi: {
    discover: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDiscovery — reset()', () => {
  it('aborts the in-flight controller and clears the cache without throwing', async () => {
    let capturedSignal;
    // Never resolves — simulates an in-flight SSE stream reset() must abort.
    discoveryApi.discover.mockImplementation((tripId, destination, countryCode, interestTags, onChunk, signal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });

    const { result } = renderHook(() => useDiscovery('trip-1'));

    act(() => {
      result.current.discover('Testville', 'TV');
    });

    expect(capturedSignal.aborted).toBe(false);
    expect(result.current.getDestination('Testville', 'TV').loading).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(capturedSignal.aborted).toBe(true);
    expect(result.current.getDestination('Testville', 'TV')).toEqual({
      partialResults: {},
      completedCategories: new Set(),
      loading: false,
      error: null,
      cached: false,
    });
  });
});
