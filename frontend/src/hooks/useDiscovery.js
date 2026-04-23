import { useState, useCallback } from 'react';
import { discoveryApi } from '../services/discoveryApi.js';

export function useDiscovery(tripId) {
  const [results, setResults] = useState(null); // { culture, food, nature, nightlife, hidden_gems }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null); // 'web' | 'ai'
  const [cached, setCached] = useState(false);

  const discover = useCallback(async (destination, interestTags) => {
    setLoading(true);
    setError(null);
    try {
      const data = await discoveryApi.discover(tripId, destination, interestTags);
      setResults(data.discovery.results);
      setSource(data.discovery.source);
      setCached(data.discovery.cached);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  const refresh = useCallback(async (destination, interestTags) => {
    await discoveryApi.clearCache(tripId);
    await discover(destination, interestTags);
  }, [tripId, discover]);

  return { results, loading, error, source, cached, discover, refresh };
}
