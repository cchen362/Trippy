import { useCallback, useEffect, useRef, useState } from 'react';
import { factsApi } from '../services/factsApi.js';

// Plan 37: the facts the reader found in a booking's documents, keyed by booking id.
// Per-route store, instantiated by LogisticsTab only and never lifted into TripPage
// (same rule as useExpenses: a fetch nobody on the screen needs is not paid on every
// trip screen).
//
// Waiting (D-37-15): a document read runs after an attach or an import confirm and takes
// several seconds, so the facts are not there when the first fetch returns.
// `awaitReads(bookingIds)` marks those bookings `'reading'` in `readingStatus` and makes ONE
// held request (`?wait=1`: the server holds the reply until this trip's reads have settled).
// If that reply still says reads are pending it makes exactly ONE more; any booking still
// without facts after the second becomes `'slow'`. It never polls and never re-arms.
// `arrivedIds` names the bookings whose facts landed through such a reply, so the screen can
// fade them in once; a plain load never sets it.
//
// Failure degrades quietly: facts are an addition to a booking, not part of it. A failed
// load keeps the last good data, exposes no error state, and logs to the console, so
// Logistics offline renders exactly as it did before facts existed. A failed held request
// clears its reading marks the same way.
// D-37-15 (Plan 37): after an attach or confirm, one held request (and at most one more) until the reads settle; the booking shows a reading indicator meanwhile, never a poll.

function groupFacts(result) {
  const next = {};
  for (const entry of result?.bookings || []) {
    if (entry?.bookingId && Array.isArray(entry.facts) && entry.facts.length > 0) {
      next[entry.bookingId] = entry.facts;
    }
  }
  return next;
}

export function useDocumentFacts(tripId) {
  const [factsByBooking, setFactsByBooking] = useState({});
  const [readsPending, setReadsPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [readingStatus, setReadingStatus] = useState({});
  const [arrivedIds, setArrivedIds] = useState([]);
  const requestIdRef = useRef(0);
  const awaitIdRef = useRef(0);
  const factsRef = useRef({});
  const readingRef = useRef({});
  const baselineRef = useRef({});

  const setReading = useCallback((next) => {
    readingRef.current = next;
    setReadingStatus(next);
  }, []);

  const clearMarks = useCallback((ids) => {
    const next = { ...readingRef.current };
    for (const id of ids) {
      delete next[id];
      delete baselineRef.current[id];
    }
    setReading(next);
  }, [setReading]);

  const applyResult = useCallback((result) => {
    const next = groupFacts(result);
    factsRef.current = next;
    setFactsByBooking(next);
    setReadsPending(result?.readsPending ?? 0);
    setLoaded(true);
    return next;
  }, []);

  const load = useCallback(async () => {
    if (!tripId) return;
    const requestId = (requestIdRef.current += 1);
    try {
      const result = await factsApi.list(tripId);
      if (requestId !== requestIdRef.current) return; // superseded — drop
      applyResult(result);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error('[facts] load failed:', err?.message || err);
    }
  }, [tripId, applyResult]);

  const refresh = useCallback(() => {
    setArrivedIds([]);
    return load();
  }, [load]);

  const awaitReads = useCallback(async (bookingIds) => {
    if (!tripId) return;
    const added = (bookingIds || []).filter(Boolean);
    // A newer call takes over the bookings an older one was still waiting on, so none is
    // left marked by a call whose reply will now be dropped.
    const carried = Object.keys(readingRef.current).filter((id) => readingRef.current[id] === 'reading');
    const ids = [...new Set([...carried, ...added])];
    if (ids.length === 0) return;

    const waitId = (awaitIdRef.current += 1);
    setArrivedIds([]);
    const marked = { ...readingRef.current };
    for (const id of ids) {
      marked[id] = 'reading';
      if (!(id in baselineRef.current) || added.includes(id)) {
        baselineRef.current[id] = factsRef.current[id]?.length ?? 0;
      }
    }
    setReading(marked);

    let remaining = ids;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      try {
        result = await factsApi.list(tripId, { wait: true });
      } catch (err) {
        if (waitId !== awaitIdRef.current) return;
        console.error('[facts] wait failed:', err?.message || err);
        clearMarks(remaining);
        return;
      }
      if (waitId !== awaitIdRef.current) return; // superseded or unmounted — drop
      requestIdRef.current += 1; // a plain load still in flight is older than this reply
      const next = applyResult(result);

      const arrived = remaining.filter((id) => (next[id]?.length ?? 0) > baselineRef.current[id]);
      if (arrived.length > 0) setArrivedIds((prev) => [...new Set([...prev, ...arrived])]);

      if ((result?.readsPending ?? 0) === 0) {
        clearMarks(remaining);
        return;
      }
      remaining = remaining.filter((id) => !arrived.includes(id));
      clearMarks(arrived);
      if (remaining.length === 0) return;
    }
    const slow = { ...readingRef.current };
    for (const id of remaining) slow[id] = 'slow';
    setReading(slow);
  }, [tripId, applyResult, clearMarks, setReading]);

  useEffect(() => {
    requestIdRef.current += 1; // anything still in flight belongs to the previous trip
    awaitIdRef.current += 1;
    factsRef.current = {};
    baselineRef.current = {};
    setFactsByBooking({});
    setReadsPending(0);
    setLoaded(false);
    setReading({});
    setArrivedIds([]);
    load();
    return () => {
      requestIdRef.current += 1;
      awaitIdRef.current += 1;
    };
  }, [tripId, load, setReading]);

  return { factsByBooking, readsPending, loaded, readingStatus, arrivedIds, refresh, awaitReads };
}
