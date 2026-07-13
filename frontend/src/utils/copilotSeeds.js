const FALLBACK_PROMPT = "What's worth knowing about this trip?";
const FOOD_TYPES = new Set(['food', 'restaurant', 'meal']);

function dayLabel(day, dayNumber) {
  const city = day?.resolvedCity ?? day?.city ?? null;
  return city ? `Day ${dayNumber} in ${city}` : `Day ${dayNumber}`;
}

function densityPrompt(day, dayNumber) {
  if (!day) return null;
  const stops = Array.isArray(day.stops) ? day.stops : [];
  const label = dayLabel(day, dayNumber);
  if (stops.length === 0) return `How should I shape ${label} with no stops planned yet?`;

  const timedCount = stops.filter((stop) => typeof stop.time === 'string' && stop.time.trim()).length;
  if (timedCount === 0) {
    return `How should I order the ${stops.length} untimed ${stops.length === 1 ? 'stop' : 'stops'} on ${label}?`;
  }
  if (timedCount < stops.length) {
    const untimedCount = stops.length - timedCount;
    return `How does ${label} flow with ${stops.length} stops, including ${untimedCount} untimed?`;
  }
  return `How does the flow look across the ${stops.length} timed ${stops.length === 1 ? 'stop' : 'stops'} on ${label}?`;
}

function appetitePrompt(day, dayNumber) {
  if (!day) return null;
  const stops = Array.isArray(day.stops) ? day.stops : [];
  if (stops.length === 0 || stops.some((stop) => FOOD_TYPES.has(String(stop.type || '').toLowerCase()))) {
    return null;
  }
  return `Where should I plan a meal around the stops on ${dayLabel(day, dayNumber)}?`;
}

function bookingDate(booking) {
  const value = booking?.startDatetime ?? booking?.endDatetime ?? booking?.detailsJson?.departureDate ?? null;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function displayDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function bookingSubject(booking) {
  const type = typeof booking?.type === 'string' && booking.type.trim()
    ? booking.type.trim().toLowerCase()
    : 'booking';
  const route = booking?.origin && booking?.destination
    ? ` from ${booking.origin} to ${booking.destination}`
    : '';
  const place = !route && typeof booking?.title === 'string' && booking.title.trim()
    ? ` for ${booking.title.trim()}`
    : '';
  return `${type}${route || place}`;
}

function nextBookingPrompt(bookings, activeDay) {
  const threshold = activeDay?.date ?? null;
  const candidates = (Array.isArray(bookings) ? bookings : [])
    .map((booking) => ({ booking, date: bookingDate(booking) }))
    .filter(({ date }) => date && (!threshold || date >= threshold))
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = candidates[0];
  if (!next) return null;
  return `What do I need ready for the ${bookingSubject(next.booking)} on ${displayDate(next.date)}?`;
}

export function deriveCopilotSeeds({ days = [], bookings = [], activeDayId = null } = {}) {
  const dayList = Array.isArray(days) ? days : [];
  const activeIndex = activeDayId
    ? dayList.findIndex((day) => day.id === activeDayId)
    : (dayList.length > 0 ? 0 : -1);
  const activeDay = activeIndex >= 0 ? dayList[activeIndex] : null;
  const dayNumber = activeIndex + 1;

  const prompts = [
    densityPrompt(activeDay, dayNumber),
    appetitePrompt(activeDay, dayNumber),
    nextBookingPrompt(bookings, activeDay),
  ].filter(Boolean).slice(0, 3);

  return prompts.length > 0 ? prompts : [FALLBACK_PROMPT];
}

export { FALLBACK_PROMPT };
