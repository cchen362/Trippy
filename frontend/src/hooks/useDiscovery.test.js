// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StrictMode, useEffect } from 'react';
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

describe('useDiscovery — country_required decline (W4.5, F-26-26)', () => {
  it('routes a country_required decline to notice (not error) with destination and suggestedCountryCode', async () => {
    discoveryApi.discover.mockImplementation(async (tripId, destination, countryCode, interestTags, onChunk) => {
      onChunk({
        type: 'error',
        code: 'country_required',
        message: "We don't know which country Suzhou is in — confirm it and we'll start its catalogue.",
        destination: 'Suzhou',
        suggestedCountryCode: 'MY',
      });
    });

    const { result } = renderHook(() => useDiscovery('trip-1'));

    await act(async () => {
      await result.current.discover('Suzhou', null);
    });

    const entry = result.current.getDestination('Suzhou', null);
    expect(entry.error).toBeNull();
    expect(entry.loading).toBe(false);
    expect(entry.notice).toEqual({
      code: 'country_required',
      message: "We don't know which country Suzhou is in — confirm it and we'll start its catalogue.",
      destination: 'Suzhou',
      suggestedCountryCode: 'MY',
    });
  });
});

describe('useDiscovery — unmount (Plan 33 M2)', () => {
  it('aborts an in-flight discover request when the hook unmounts', () => {
    let capturedSignal;
    discoveryApi.discover.mockImplementation((tripId, destination, countryCode, interestTags, onChunk, signal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });

    const { result, unmount } = renderHook(() => useDiscovery('trip-1'));
    act(() => {
      result.current.discover('Testville', 'TV');
    });
    expect(capturedSignal.aborted).toBe(false);

    unmount();

    expect(capturedSignal.aborted).toBe(true);
  });

  it('lets a remounted hook fire discover again for the same key (StrictMode cycle)', () => {
    const signals = [];
    discoveryApi.discover.mockImplementation((tripId, destination, countryCode, interestTags, onChunk, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });

    // StrictMode in dev: effects run, clean up, run again on the same instance.
    // The first discover's entry must not survive as a stuck `loading: true`.
    const first = renderHook(() => useDiscovery('trip-1'));
    act(() => {
      first.result.current.discover('Testville', 'TV');
    });
    first.unmount();

    const second = renderHook(() => useDiscovery('trip-1'));
    act(() => {
      second.result.current.discover('Testville', 'TV');
    });

    expect(discoveryApi.discover).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(second.result.current.getDestination('Testville', 'TV').loading).toBe(true);
  });

  it('does not stay stuck loading under real StrictMode effect double-invocation', () => {
    const signals = [];
    discoveryApi.discover.mockImplementation((tripId, destination, countryCode, interestTags, onChunk, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });

    // Mirrors TripPage's pre-warm: discover() from a mount effect. StrictMode
    // runs effect -> cleanup -> effect on the SAME instance (refs preserved).
    const { result } = renderHook(
      () => {
        const discovery = useDiscovery('trip-1');
        useEffect(() => {
          discovery.discover('Testville', 'TV');
        }, [discovery.discover]);
        return discovery;
      },
      { wrapper: StrictMode },
    );

    expect(discoveryApi.discover).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(result.current.getDestination('Testville', 'TV').loading).toBe(true);
  });

  it('is a no-op when unmounted while idle', () => {
    const { unmount } = renderHook(() => useDiscovery('trip-1'));
    expect(() => unmount()).not.toThrow();
    expect(discoveryApi.discover).not.toHaveBeenCalled();
  });
});
