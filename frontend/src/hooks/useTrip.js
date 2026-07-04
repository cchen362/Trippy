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

  useEffect(() => {
    hasLoadedRef.current = false;
  }, [tripId]);

  const refresh = useCallback(async () => {
    if (!tripId) return;

    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      const nextDetail = await tripsApi.detail(tripId);
      setDetail(nextDetail);
      hasLoadedRef.current = true;
      setActiveDayId((current) => {
        if (current && nextDetail.days.some((day) => day.id === current)) {
          return current;
        }
        return pickDefaultDay(nextDetail.days);
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
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
