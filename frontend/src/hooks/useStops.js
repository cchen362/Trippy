import { useCallback, useState } from 'react';
import { stopsApi } from '../services/stopsApi.js';

export function useStops({ onChanged, onError }) {
  const [saving, setSaving] = useState(false);

  const run = useCallback(async (action) => {
    setSaving(true);
    try {
      const result = await action();
      await onChanged?.();
      return result;
    } catch (err) {
      onError?.(err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [onChanged, onError]);

  return {
    saving,
    createStop: (dayId, data) => run(() => stopsApi.create(dayId, data)),
    updateStop: (stopId, data) => run(() => stopsApi.update(stopId, data)),
    deleteStop: (stopId) => run(() => stopsApi.remove(stopId)),
    reorderStops: (dayId, orderedStopIds) => run(() => stopsApi.reorder(dayId, orderedStopIds)),
  };
}
