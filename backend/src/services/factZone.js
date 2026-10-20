// The zone a document fact's time is local to, when the document itself names none (Plan 37).
// Pure functions: no database, no network. geo-tz answers from bundled data.

import { find as tzFind } from 'geo-tz';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

// A zone's UTC offset in minutes on the given calendar date (noon UTC, so a date's offset is never
// read across a midnight boundary). Platform data via Intl: no offset table is kept here.
function offsetMinutes(zone, dateText) {
  const when = new Date(`${dateText}T12:00:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(when).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part);
  if (!m) throw new Error(`Unreadable UTC offset "${part}" for zone ${zone}`);
  if (!m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// A country's zone when the country has exactly one wall-clock time on the fact's date: every zone the
// platform lists for it shares the first zone's UTC offset. A country with two offsets (CN, US, AU) is
// genuinely ambiguous and yields null; no country is special-cased. `at` is "YYYY-MM-DD[THH:MM]" or empty
// (empty reads the offsets as of today).
export function countryZone(countryCode, at) {
  if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  const zones = new Intl.Locale(`und-${countryCode.toUpperCase()}`).timeZones;
  if (!zones?.length) return null;
  const dateText = ISO_DATE.exec(at ?? '')?.[0] ?? new Date().toISOString().slice(0, 10);
  const first = offsetMinutes(zones[0], dateText);
  return zones.every((z) => offsetMinutes(z, dateText) === first) ? zones[0] : null;
}

// Whether the platform accepts a name as a zone. The reader's schema checks a zone's shape only, and a
// client handing an unknown name to Intl.DateTimeFormat throws, so every zone is checked before it is served.
export function isKnownZone(zone) {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

// D-37-10 (Plan 37): a fact's zone is the document's; else its booking's zone column, coordinates (geo-tz) or a country whose zones all share one offset; otherwise none, never a guess.
// `booking` is the bookings row (type, origin_tz, destination_tz, details_json as stored text).
// `dayCountry` is the resolved country of the trip day the booking starts on, or null/undefined.
export function bookingZone(booking, { at, dayCountry } = {}) {
  const details = JSON.parse(booking.details_json || '{}');
  const columns = booking.type === 'flight' || booking.type === 'train'
    ? [booking.origin_tz, booking.destination_tz]
    : [booking.destination_tz, booking.origin_tz];
  const fromColumn = [...columns, details.tz].find(isKnownZone);
  if (fromColumn) return fromColumn;

  if (Number.isFinite(details.lat) && Number.isFinite(details.lng)) {
    const fromCoordinates = tzFind(details.lat, details.lng)[0];
    if (fromCoordinates) return fromCoordinates;
  }

  return countryZone(details.countryCode || dayCountry, at);
}
