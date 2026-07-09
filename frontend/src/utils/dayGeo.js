// Shared display-label helper for a day's geography. `resolvedCity` is the
// derived, always-scope-grade city name (already reflects any override); the
// raw seed `city` is only a fallback for days that haven't been resolved yet.
export function dayDisplayLabel(day) {
  return day?.resolvedCity ?? day?.city ?? '';
}
