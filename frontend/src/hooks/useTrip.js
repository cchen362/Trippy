import { useCallback, useEffect, useRef, useState } from 'react';
import { tripsApi } from '../services/tripsApi.js';
import { localIso } from '../utils/date.js';

function pickDefaultDay(days) {
  if (!days.length) return null;
  const today = localIso();
  const todayMatch = days.find((day) => day.date === today);
  return todayMatch?.id || days[0].id;
}

export function useTrip(tripId) {
  const [detail, setDetail] = useState(null);
  const [activeDayId, setActiveDayId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const hasLoadedRef = useRef(false);
  // Monotonic request id: multiple refresh() calls can be in flight at once
  // (every stop/booking mutation triggers one via onChanged()), and network
  // responses can resolve out of send order. Only the response whose id is
  // still the latest issued is allowed to commit state — an older response
  // resolving after a newer one is dropped rather than clobbering it.
  const requestIdRef = useRef(0);

  useEffect(() => {
    hasLoadedRef.current = false;
  }, [tripId]);

  const refresh = useCallback(async () => {
    if (!tripId) return;

    const requestId = (requestIdRef.current += 1);
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      const nextDetail = await tripsApi.detail(tripId);
      if (requestId !== requestIdRef.current) return; // superseded — drop
      setDetail(nextDetail);
      hasLoadedRef.current = true;
      setActiveDayId((current) => {
        if (current && nextDetail.days.some((day) => day.id === current)) {
          return current;
        }
        return pickDefaultDay(nextDetail.days);
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return; // superseded — drop
      setError(err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    detail,
    trip: detail?.trip || null,
    days: detail?.days || [],
    bookings: detail?.bookings || [],
    activeDayId,
    setActiveDayId,
    activeDay: detail?.days.find((day) => day.id === activeDayId) || null,
    loading,
    error,
    refresh,
  };
}
