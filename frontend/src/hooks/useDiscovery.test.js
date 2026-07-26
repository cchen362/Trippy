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
    // notice: null added by W1.5 (routes an honest server decline like
    // 'catalogue_full' separately from a genuine `error`) — see the notice
    // routing tests below.
    expect(result.current.getDestination('Testville', 'TV')).toEqual({
      partialResults: {},
      completedCategories: new Set(),
      loading: false,
      error: null,
      notice: null,
      cached: false,
    });
  });
});

describe('useDiscovery — decline notices (W1.5)', () => {
  it('routes a catalogue_full decline to notice, not error, and clears loading', async () => {
    discoveryApi.discover.mockImplementation(async (tripId, destination, countryCode, interestTags, onChunk) => {
      onChunk({ type: 'category', category: 'essentials', items: [{ id: 1, name: 'Existing Spot' }] });
      onChunk({ type: 'error', code: 'catalogue_full', message: 'Every category here is already full.' });
    });

    const { result } = renderHook(() => useDiscovery('trip-1'));

    await act(async () => {
      await result.current.showMore('Testville', 'TV');
    });

    const entry = result.current.getDestination('Testville', 'TV');
    expect(entry.error).toBeNull();
    expect(entry.notice).toEqual({ code: 'catalogue_full', message: 'Every category here is already full.' });
    // The "Show more" button must not stay stuck mid-loading on a decline.
    expect(entry.loading).toBe(false);
    // Results already streamed stay on screen — a decline must not wipe them.
    expect(entry.partialResults.essentials).toEqual([{ id: 1, name: 'Existing Spot' }]);
  });

  it('still routes an error with no known code to error, not notice', async () => {
    discoveryApi.discover.mockImplementation(async (tripId, destination, countryCode, interestTags, onChunk) => {
      onChunk({ type: 'error', message: 'Something genuinely broke' });
    });

    const { result } = renderHook(() => useDiscovery('trip-1'));

    await act(async () => {
      await result.current.discover('Brokenville', 'BV');
    });

    const entry = result.current.getDestination('Brokenville', 'BV');
    expect(entry.notice).toBeNull();
    expect(entry.error).toBeInstanceOf(Error);
    expect(entry.error.message).toBe('Something genuinely broke');
  });

  it('clears a stale notice when a fresh showMore call starts', async () => {
    discoveryApi.discover.mockImplementationOnce(async (tripId, destination, countryCode, interestTags, onChunk) => {
      onChunk({ type: 'error', code: 'catalogue_full', message: 'Full for now.' });
    });

    const { result } = renderHook(() => useDiscovery('trip-1'));

    await act(async () => {
      await result.current.showMore('Testville', 'TV');
    });
    expect(result.current.getDestination('Testville', 'TV').notice).not.toBeNull();

    discoveryApi.discover.mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      result.current.showMore('Testville', 'TV');
    });

    expect(result.current.getDestination('Testville', 'TV').notice).toBeNull();
  });
});
