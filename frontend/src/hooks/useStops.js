import { useCallback, useState } from 'react';
import { stopsApi } from '../services/stopsApi.js';

export function useStops({ onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (action) => {
    setSaving(true);
    setError(null);
    try {
      const result = await action();
      await onChanged?.();
      return result;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [onChanged]);

  return {
    saving,
    error,
    createStop: (dayId, data) => run(() => stopsApi.create(dayId, data)),
    updateStop: (stopId, data) => run(() => stopsApi.update(stopId, data)),
    deleteStop: (stopId) => run(() => stopsApi.remove(stopId)),
    reorderStops: (dayId, orderedStopIds) => run(() => stopsApi.reorder(dayId, orderedStopIds)),
  };
}
