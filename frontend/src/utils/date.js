// Local (device) calendar date as YYYY-MM-DD — never UTC, so "today" matches
// what the traveler's clock actually shows, regardless of timezone offset.
export function localIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
