const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

// A fact's `at` as the document wrote it, local to the place: "12 Nov" or "12 Nov 18:00".
// Parsed from the digits, never through Date, so no zone conversion can creep in (D-37-10).
// Returns { date, time } (time null for a date-only `at`), or null when `at` is empty or malformed.
export function formatAtAsWritten(at) {
  const match = AT_PATTERN.exec(at || '');
  if (!match) return null;
  const [, , month, day, hour, minute] = match;
  const monthLabel = MONTHS[Number(month) - 1];
  if (!monthLabel) return null;
  return { date: `${Number(day)} ${monthLabel}`, time: hour === undefined ? null : `${hour}:${minute}` };
}
