import { useCallback, useEffect, useRef, useState } from 'react';
import { factsApi } from '../services/factsApi.js';

// Plan 37: the facts the reader found in a booking's documents, keyed by booking id.
// Per-route store, instantiated by LogisticsTab only and never lifted into TripPage
// (same rule as useExpenses: a fetch nobody on the screen needs is not paid on every
// trip screen).
//
// Follow-up (Q-37-7): a document read runs after an attach or an import confirm, so the
// facts are usually not there yet when the first fetch returns. `refresh({ followUp })`
// fetches now and schedules exactly ONE more fetch FOLLOW_UP_DELAY_MS later. The
// follow-up never re-arms, so this cannot turn into polling, and nothing on screen
// says "Reading…" while it waits.
//
// Failure degrades quietly: facts are an addition to a booking, not part of it. A failed
// load keeps the last good data, exposes no error state, and logs to the console, so
// Logistics offline renders exactly as it did before facts existed.
const FOLLOW_UP_DELAY_MS = 10000;

export function useDocumentFacts(tripId) {
  const [factsByBooking, setFactsByBooking] = useState({});
  const [readsPending, setReadsPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const requestIdRef = useRef(0);
  const followUpTimerRef = useRef(null);

  const clearFollowUpTimer = useCallback(() => {
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    if (!tripId) return;
    const requestId = (requestIdRef.current += 1);
    try {
      const result = await factsApi.list(tripId);
      if (requestId !== requestIdRef.current) return; // superseded — drop
      const next = {};
      for (const entry of result?.bookings || []) {
        if (entry?.bookingId && Array.isArray(entry.facts) && entry.facts.length > 0) {
          next[entry.bookingId] = entry.facts;
        }
      }
      setFactsByBooking(next);
      setReadsPending(result?.readsPending ?? 0);
      setLoaded(true);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error('[facts] load failed:', err?.message || err);
    }
  }, [tripId]);

  const refresh = useCallback(({ followUp = false } = {}) => {
    const first = load();
    if (followUp) {
      clearFollowUpTimer();
      followUpTimerRef.current = setTimeout(() => {
        followUpTimerRef.current = null;
        load();
      }, FOLLOW_UP_DELAY_MS);
    }
    return first;
  }, [load, clearFollowUpTimer]);

  useEffect(() => {
    requestIdRef.current += 1; // anything still in flight belongs to the previous trip
    setFactsByBooking({});
    setReadsPending(0);
    setLoaded(false);
    clearFollowUpTimer();
    load();
    return () => {
      requestIdRef.current += 1;
      clearFollowUpTimer();
    };
  }, [tripId, load, clearFollowUpTimer]);

  return { factsByBooking, readsPending, loaded, refresh };
}
