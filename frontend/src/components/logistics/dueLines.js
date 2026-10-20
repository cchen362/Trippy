import { localIso } from '../../utils/date.js';

export function dueLines(bookings, factsByBooking, today = localIso()) {
  // D-37-6 (Plan 37): Due is the trip's deadline facts dated today or later, ordered by at; a shared document's deadline shows once naming each booking, and same-booking duplicates (same at, same label) collapse.
  const byId = new Map();
  const entries = [];
  const normal = (label) => String(label || '').trim().toLowerCase();

  for (const booking of bookings || []) {
    const facts = factsByBooking?.[booking.id];
    if (!Array.isArray(facts)) continue;
    for (const fact of facts) {
      if (fact.kind !== 'deadline' || !fact.at || fact.at.slice(0, 10) < today) continue;
      let entry = byId.get(fact.id);
      if (!entry) {
        const label = normal(fact.label);
        entry = entries.find((e) => e.norm === label && e.at === fact.at && e.bookings.has(booking.id));
      }
      if (!entry) {
        entry = { key: fact.id, label: fact.label, at: fact.at, norm: normal(fact.label), bookings: new Map() };
        entries.push(entry);
      }
      byId.set(fact.id, entry);
      entry.bookings.set(booking.id, booking);
    }
  }

  const byStart = (a, b) => {
    const sa = a.startDatetime || '';
    const sb = b.startDatetime || '';
    if (!sa !== !sb) return sa ? -1 : 1;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  };

  return entries
    .map((e) => ({
      key: e.key,
      label: e.label,
      at: e.at,
      titles: [...e.bookings.values()].sort(byStart).map((b) => b.title),
    }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : String(a.label).localeCompare(String(b.label))));
}
