// ES2015+ treats date-only strings ("2026-06-11") as UTC midnight,
// which flips day-of-week for users east of UTC. Force local-time parsing.
function toLocalDate(input) {
  if (!input) return null;
  const iso = typeof input === 'string' && !input.includes('T') ? `${input}T00:00:00` : input;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Optional `tz` (IANA zone, e.g. "Asia/Singapore") is reserved for upcoming
// timezone-aware rendering — pass nothing for now, formatters use local zone.
export function formatShortDate(iso, tz) {
  const d = toLocalDate(iso);
  if (!d) return '';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (tz) opts.timeZone = tz;
  return d.toLocaleDateString('en-GB', opts);
}

export function formatTime(iso, tz) {
  const d = toLocalDate(iso);
  if (!d) return '';
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (tz) opts.timeZone = tz;
  return d.toLocaleTimeString('en-GB', opts);
}

export function computeNights(checkIn, checkOut) {
  const a = toLocalDate(checkIn);
  const b = toLocalDate(checkOut);
  if (!a || !b) return 0;
  // Using setHours(0,0,0,0) makes the diff DST-safe across spring-forward boundaries.
  const aMid = new Date(a); aMid.setHours(0, 0, 0, 0);
  const bMid = new Date(b); bMid.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((bMid - aMid) / 86400000));
}

export function iataFromOriginString(s) {
  if (!s) return '';
  const match = s.match(/^([A-Z]{3})\b/);
  return match ? match[1] : s.slice(0, 3).toUpperCase();
}
