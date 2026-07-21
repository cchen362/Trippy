import { naiveIsoToAbsolute } from '../../utils/date.js';
import { formatMinor } from '../../utils/currency.js';

// ES2015+ treats date-only strings ("2026-06-11") as UTC midnight,
// which flips day-of-week for users east of UTC. Force local-time parsing.
function toLocalDate(input) {
  if (!input) return null;
  const iso = typeof input === 'string' && !input.includes('T') ? `${input}T00:00:00` : input;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatShortDate(iso, tz) {
  if (!iso) return '';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (tz) {
    try {
      const d = naiveIsoToAbsolute(iso, tz);
      opts.timeZone = tz;
      return d.toLocaleDateString('en-GB', opts);
    } catch {
      // fall through to device-tz path
    }
  }
  const d = toLocalDate(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-GB', opts);
}

export function formatTime(iso, tz) {
  if (!iso) return '';
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (tz) {
    try {
      const d = naiveIsoToAbsolute(iso, tz);
      opts.timeZone = tz;
      return d.toLocaleTimeString('en-GB', opts);
    } catch {
      // fall through to device-tz path
    }
  }
  const d = toLocalDate(iso);
  if (!d) return '';
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

// One mono line summarizing a booking's linked expenses, per review §3.2: no payer,
// no repayment state, no converted/summed totals across currencies — ever.
export function costLineText(expenseSummary) {
  if (!expenseSummary || expenseSummary.count === 0) return 'Add cost';
  if (expenseSummary.count === 1 && expenseSummary.single) {
    return `Cost · ${formatMinor(expenseSummary.single.amount, expenseSummary.single.currency)}`;
  }
  return `${expenseSummary.count} costs logged`;
}

// Returns the short timezone abbreviation for a naive ISO string interpreted in `tz`.
// E.g. tzAbbr('Asia/Singapore', '2026-06-08T08:45') → 'SGT'.
// Returns null if tz is absent or Intl throws (e.g. unknown zone).
export function tzAbbr(tz, iso) {
  if (!tz || !iso) return null;
  try {
    const d = naiveIsoToAbsolute(iso, tz);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    }).formatToParts(d);
    return parts.find((p) => p.type === 'timeZoneName')?.value || null;
  } catch {
    return null;
  }
}
