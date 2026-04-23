import { useState, useEffect } from 'react';
import { mapApi } from '../services/mapApi.js';

export function useMapConfig(tripId) {
  const [mapConfig, setMapConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!tripId) return;
    setLoading(true);
    mapApi.config(tripId)
      .then(data => { setMapConfig(data.mapConfig); setLoading(false); })
      .catch(err => { setError(err); setLoading(false); });
  }, [tripId]);

  return { mapConfig, loading, error };
}
