const COPILOT_TABS = new Set(['today', 'plan', 'logistics', 'map', 'discovery']);

export function contextForRoute(pathname, activeDayId) {
  const tab = pathname.split('/').filter(Boolean).at(-1);
  if (!COPILOT_TABS.has(tab)) return null;
  return activeDayId ? { tab, dayId: activeDayId } : { tab };
}

export function formatContextChip(context, days = []) {
  if (!context?.tab) return null;

  if (context.tab === 'discovery') {
    return [context.tab, context.discoveryName].filter(Boolean).join(' · ');
  }

  const parts = [context.tab];
  const dayIndex = context.dayId
    ? days.findIndex((day) => day.id === context.dayId)
    : -1;
  const day = dayIndex >= 0 ? days[dayIndex] : null;
  const dayNumber = context.dayNumber ?? (dayIndex >= 0 ? dayIndex + 1 : null);
  const dayCity = context.dayCity ?? day?.resolvedCity ?? day?.city ?? null;

  if (dayNumber) parts.push(`Day ${dayNumber}`);
  if (dayCity) parts.push(dayCity);

  let stopName = context.stopName ?? null;
  if (!stopName && context.stopId) {
    stopName = days
      .flatMap((candidateDay) => candidateDay.stops || [])
      .find((stop) => stop.id === context.stopId)?.title ?? null;
  }
  if (stopName) parts.push(stopName);

  return parts.join(' · ');
}
