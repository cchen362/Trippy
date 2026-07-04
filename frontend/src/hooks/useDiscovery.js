import { useCallback, useReducer, useRef } from 'react';
import { discoveryApi } from '../services/discoveryApi.js';

const EMPTY_ENTRY = { partialResults: {}, completedCategories: new Set(), loading: false, error: null, cached: false };

// Strips punctuation and common geographic suffixes so "Dujiangyan & Scenic Area"
// and "Dujiangyan Scenic Area" collapse to the same canonical key. Mirrors the
// server-side normalizeName in backend/src/services/claude.js.
function normalizeName(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  // Appends fresh picks that exclude everything already shown for this destination.
  // Sets loading on the existing entry WITHOUT clearing partialResults, so the grid
  // stays populated while new items stream in and merge alongside the old ones.
  const showMore = useCallback(async (destination) => {
    if (!destination?.trim()) return;
    const key = norm(destination);
    const current = cacheRef.current[key];
    if (current?.loading) return;

    abortRefs.current[key]?.abort();
    const controller = new AbortController();
    abortRefs.current[key] = controller;

    cacheRef.current[key] = { ...(current ?? EMPTY_ENTRY), loading: true, error: null };
    forceRender();

    try {
      await discoveryApi.discover(tripId, destination.trim(), [], (chunk) => {
        if (chunk.type === 'category') {
          const entry = cacheRef.current[key];
          const existingItems = entry.partialResults[chunk.category] ?? [];
          const seen = new Set(
            Object.values(entry.partialResults).flat().map((item) => normalizeName(item?.name)),
          );
          const newItems = chunk.items.filter((item) => {
            const n = normalizeName(item?.name);
            if (!n || seen.has(n)) return false;
            seen.add(n);
            return true;
          });
          cacheRef.current[key] = {
            ...entry,
            partialResults: { ...entry.partialResults, [chunk.category]: [...existingItems, ...newItems] },
            completedCategories: new Set([...entry.completedCategories, chunk.category]),
          };
          forceRender();
        } else if (chunk.type === 'done') {
          cacheRef.current[key] = { ...cacheRef.current[key], cached: chunk.cached ?? false };
        } else if (chunk.type === 'error') {
          cacheRef.current[key] = { ...cacheRef.current[key], loading: false, error: new Error(chunk.message || 'Discovery failed') };
          forceRender();
        }
      }, controller.signal, true);

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

  // Returns the discovery state for a specific destination (or an empty entry if not yet fetched)
  const getDestination = useCallback((destination) => {
    return cacheRef.current[norm(destination)] ?? EMPTY_ENTRY;
  }, []);

  // True if any destination is currently loading — used for the pulsing dot in PlanTab
  const isAnyLoading = Object.values(cacheRef.current).some((e) => e.loading);

  return { discover, showMore, getDestination, isAnyLoading };
}
