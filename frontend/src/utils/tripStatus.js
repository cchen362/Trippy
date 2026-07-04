import { localIso } from './date.js';

// Independent of the server's computed trip.status field — this is a pure
// local-date comparison so Today-tab correctness never depends on how the
// backend's status semantics might evolve.
export function tripIsLive(trip, now = new Date()) {
  if (!trip?.startDate || !trip?.endDate) return false;
  const today = localIso(now);
  return trip.startDate <= today && today <= trip.endDate;
}
