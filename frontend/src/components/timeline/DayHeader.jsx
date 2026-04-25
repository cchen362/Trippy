import GoldRule from '../common/GoldRule.jsx';

export default function DayHeader({ day, dayNumber }) {
  if (!day) return null;

  const city = day.resolvedCity ?? day.city;

  return (
    <div className="mb-6">
      <GoldRule className="mb-4" />
      <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
        {city} · Day {dayNumber}
      </p>
      <h2 className="font-display italic text-4xl sm:text-5xl mb-2" style={{ color: 'var(--cream)' }}>
        {day.theme || day.phase || city}
      </h2>
      <p className="font-body text-lg" style={{ color: 'var(--cream-dim)' }}>
        {new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${day.date}T00:00:00`))}
        {' · '}
        {day.stops.length} stops
      </p>
    </div>
  );
}
