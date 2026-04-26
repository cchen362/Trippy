import { useCallback, useReducer, useRef } from 'react';
import { discoveryApi } from '../services/discoveryApi.js';

const EMPTY_ENTRY = { partialResults: {}, completedCategories: new Set(), loading: false, error: null, cached: false };

export function useDiscovery(tripId) {
  // cacheRef is the source of truth: { [normalizedDestination]: DiscoveryEntry }
  // Using a ref avoids stale closures inside async callbacks.
  const cacheRef = useRef({});
  const abortRefs = useRef({});
  // forceRender triggers re-renders when cacheRef mutates.
  const [, forceRender] = useReducer((n) => n + 1, 0);

  // Normalizes a city name into a stable cache key, collapsing spelling variants
  // ("Cheng Du" and "Chengdu" → "chengdu"; "Xi'an" → "xian"; "São Paulo" → "saopaulo").
  const norm = (d) =>
    d?.trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip combining diacritics
      .replace(/[\s'‘’\-\.]/g, '')             // strip spaces, apostrophes, hyphens, periods
    ?? '';

  const discover = useCallback(async (destination) => {
    if (!destination?.trim()) return;
    const key = norm(destination);
    const current = cacheRef.current[key];

    // Skip if already loading or already has results for this destination
    if (current?.loading) return;
    if (current && Object.keys(current.partialResults).length > 0) return;

    abortRefs.current[key]?.abort();
    const controller = new AbortController();
    abortRefs.current[key] = controller;

    cacheRef.current[key] = { ...EMPTY_ENTRY, loading: true };
    forceRender();

    try {
      await discoveryApi.discover(tripId, destination.trim(), [], (chunk) => {
        if (chunk.type === 'category') {
          const entry = cacheRef.current[key];
          cacheRef.current[key] = {
            ...entry,
            partialResults: { ...entry.partialResults, [chunk.category]: chunk.items },
            completedCategories: new Set([...entry.completedCategories, chunk.category]),
          };
          forceRender();
        } else if (chunk.type === 'done') {
          cacheRef.current[key] = { ...cacheRef.current[key], cached: chunk.cached ?? false };
        } else if (chunk.type === 'error') {
          cacheRef.current[key] = { ...cacheRef.current[key], loading: false, error: new Error(chunk.message || 'Discovery failed') };
          forceRender();
        }
      }, controller.signal);

      cacheRef.current[key] = { ...cacheRef.current[key], loading: false };
      forceRender();
    } catch (err) {
      if (err.name !== 'AbortError') {
        cacheRef.current[key] = { ...cacheRef.current[key], loading: false, error: err };
        forceRender();
      }
    } finally {
      if (abortRefs.current[key] === controller) delete abortRefs.current[key];
    }
  }, [tripId]);

  const refresh = useCallback(async (destination) => {
    const key = norm(destination);
    abortRefs.current[key]?.abort();
    delete cacheRef.current[key];
    forceRender();
    await discoveryApi.clearCache(tripId, destination);
    await discover(destination);
  }, [tripId, discover]);

  // Returns the discovery state for a specific destination (or an empty entry if not yet fetched)
  const getDestination = useCallback((destination) => {
    return cacheRef.current[norm(destination)] ?? EMPTY_ENTRY;
  }, []);

  // True if any destination is currently loading — used for the pulsing dot in PlanTab
  const isAnyLoading = Object.values(cacheRef.current).some((e) => e.loading);

  return { discover, refresh, getDestination, isAnyLoading };
}
