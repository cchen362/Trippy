import { naiveIsoToAbsolute } from '../../utils/date.js';
import { formatAtAsWritten } from './factFormat.js';

// D-37-6 (Plan 37): a deadline's moment is real once its zone is known; with no zone it keeps its whole written day.
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Wall-clock { date: "YYYY-MM-DD", time: "HH:MM" } of an instant in `tz`, via Intl, never local getters.
function wallClock(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

const hasTime = (at) => at.length >= 16 && at[10] === 'T';

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The instant a deadline falls due in `tz`: its moment, or the end of its day when date-only.
function dueInstant(at, tz) {
  return hasTime(at) ? naiveIsoToAbsolute(at, tz) : naiveIsoToAbsolute(nextDay(at.slice(0, 10)), tz);
}

// The real instant of a timed deadline whose zone is known; null otherwise.
export function deadlineInstant(fact) {
  if (!fact.at || !fact.tz || !hasTime(fact.at)) return null;
  return naiveIsoToAbsolute(fact.at, fact.tz);
}

export function isDeadlineAhead(fact, now, deviceTz = deviceZone()) {
  if (!fact.at) return false;
  if (!fact.tz) return fact.at.slice(0, 10) >= wallClock(now, deviceTz).date;
  return dueInstant(fact.at, fact.tz).getTime() > now.getTime();
}

// Sortable number: the due instant; an unknown zone reads the wall clock in the device zone.
export function deadlineSortKey(fact, deviceTz = deviceZone()) {
  return dueInstant(fact.at, fact.tz || deviceTz).getTime();
}

export function compareDeadlines(a, b, deviceTz = deviceZone()) {
  const diff = deadlineSortKey(a, deviceTz) - deadlineSortKey(b, deviceTz);
  return diff || String(a.label).localeCompare(String(b.label));
}

// The device-local date a countdown counts to: the instant's date on this device when the zone is known and timed.
export function deadlineCountdownDate(fact, deviceTz = deviceZone()) {
  const instant = deadlineInstant(fact);
  return instant ? wallClock(instant, deviceTz).date : fact.at.slice(0, 10);
}

// "02:00 your time" or "13 Nov 02:00 your time", only when the zone is known, the deadline is timed
// and the device's clock reads differently from the moment as written; otherwise ''.
export function yourTimeNote(fact, deviceTz = deviceZone()) {
  const instant = deadlineInstant(fact);
  if (!instant) return '';
  const device = wallClock(instant, deviceTz);
  if (`${device.date}T${device.time}` === fact.at.slice(0, 16)) return '';
  const when = formatAtAsWritten(`${device.date}T${device.time}`);
  const text = device.date === fact.at.slice(0, 10) ? when.time : `${when.date} ${when.time}`;
  return `${text} your time`;
}
