export default function DayTabs({ days, activeDayId, onSelect }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {days.map((day) => {
        const isActive = day.id === activeDayId;
        const date = new Date(`${day.date}T00:00:00`);
        const label = new Intl.DateTimeFormat(undefined, {
          weekday: 'short',
          day: 'numeric',
        }).format(date);

        return (
          <button
            key={day.id}
            onClick={() => onSelect(day.id)}
            className="shrink-0 px-4 py-3 rounded-full border"
            style={{
              background: isActive ? 'var(--gold-soft)' : 'transparent',
              borderColor: isActive ? 'var(--gold-line)' : 'var(--ink-border)',
              color: isActive ? 'var(--gold)' : 'var(--cream-dim)',
            }}
          >
            <span className="font-mono text-[11px] tracking-[0.22em] uppercase">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
