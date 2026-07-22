// Local (device) calendar date as YYYY-MM-DD — never UTC, so "today" matches
// what the traveler's clock actually shows, regardless of timezone offset.
export function localIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Humane-scale countdown to a future YYYY-MM-DD local calendar date, e.g.
// "Tomorrow", "In 5 days", "In 2 weeks", "In 3 months". Both dates are parsed
// as local calendar dates (never UTC) so the day diff matches what the
// traveler's clock/calendar actually shows. Returns '' for non-positive diffs —
// callers only invoke this for trips whose start is still in the future.
export function formatCountdown(startDate, now = new Date()) {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const start = new Date(startYear, startMonth - 1, startDay);
  const [todayYear, todayMonth, todayDay] = localIso(now).split('-').map(Number);
  const today = new Date(todayYear, todayMonth - 1, todayDay);
  const days = Math.round((start.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  if (days <= 0) return '';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `In ${days} days`;
  if (days < 56) return `In ${Math.round(days / 7)} weeks`;
  return `In ${Math.round(days / 30)} months`;
}

// Converts a naive wall-clock ISO string (e.g. "2026-06-08T08:45") to the
// absolute UTC instant that corresponds to that wall-clock time in `tz`.
// Required because new Date("2026-06-08T08:45") parses in the *device* timezone,
// so passing { timeZone } to a formatter afterward corrects the wrong reference.
export function naiveIsoToAbsolute(iso, tz) {
  const [datePart, timePart = '00:00'] = iso.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.slice(0, 5).split(':').map(Number);
  const utcCandidate = Date.UTC(year, month - 1, day, hour, minute);
  const d = new Date(utcCandidate);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Compare the FULL rendered timestamp (year/month/day/hour/minute), not just
  // hour/minute — otherwise a UTC candidate that lands on a different calendar
  // day in `tz` (e.g. evenings in UTC+8, early mornings in negative offsets)
  // produces an offset that's off by a day, shifting the result 24h.
  const renderedUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offsetMs = utcCandidate - renderedUtc;
  return new Date(utcCandidate + offsetMs);
}
