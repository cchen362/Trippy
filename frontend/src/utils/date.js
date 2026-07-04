// Local (device) calendar date as YYYY-MM-DD — never UTC, so "today" matches
// what the traveler's clock actually shows, regardless of timezone offset.
export function localIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
  const offsetMs = ((hour - get('hour')) * 60 + (minute - get('minute'))) * 60_000;
  return new Date(utcCandidate + offsetMs);
}
