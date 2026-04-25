import { useState, useCallback, useRef } from 'react';
import { discoveryApi } from '../services/discoveryApi.js';

export function useDiscovery(tripId) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [cached, setCached] = useState(false);
  const abortRef = useRef(null);

  const discover = useCallback(async (destination, interestTags) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      await discoveryApi.discover(tripId, destination, interestTags, (chunk) => {
        if (chunk.type === 'results') {
          setResults(chunk.results);
          setSource(chunk.source);
          setCached(chunk.cached);
        } else if (chunk.type === 'error') {
          setError(new Error(chunk.message || 'Discovery failed'));
        }
        // 'thinking' chunks: no-op — loading state is already showing
        // 'done' chunk: handled by the post-await setLoading(false) below
      }, controller.signal);
      // Stream closed — set loading false whether we got a clean 'done' event or not.
      // Handles server restarts and abrupt disconnects without permanently stuck loading state.
      setLoading(false);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err);
      setLoading(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [tripId]);

  const refresh = useCallback(async (destination, interestTags) => {
    await discoveryApi.clearCache(tripId);
    await discover(destination, interestTags);
  }, [tripId, discover]);

  return { results, loading, error, source, cached, discover, refresh };
}
