import { useEffect, useState } from 'react';
import { mapApi } from '../services/mapApi.js';

export function useMapData(tripId, refreshKey) {
  const [mapData, setMapData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!tripId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    mapApi.data(tripId)
      .then((data) => {
        setMapData(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err);
        setLoading(false);
      });
  }, [tripId, refreshKey]);

  return {
    mapData,
    mapConfig: mapData?.mapConfig || null,
    segments: mapData?.segments || [],
    stops: mapData?.stops || [],
    loading,
    error,
  };
}
