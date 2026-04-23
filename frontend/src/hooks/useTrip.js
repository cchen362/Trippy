import { useCallback, useEffect, useState } from 'react';
import { tripsApi } from '../services/tripsApi.js';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function pickDefaultDay(days) {
  if (!days.length) return null;
  const today = todayIso();
  const todayMatch = days.find((day) => day.date === today);
  return todayMatch?.id || days[0].id;
}

export function useTrip(tripId) {
  const [detail, setDetail] = useState(null);
  const [activeDayId, setActiveDayId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!tripId) return;

    setLoading(true);
    setError(null);
    try {
      const nextDetail = await tripsApi.detail(tripId);
      setDetail(nextDetail);
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
