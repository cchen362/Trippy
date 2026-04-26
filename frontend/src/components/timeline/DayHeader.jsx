import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import GoldRule from '../common/GoldRule.jsx';

export default function DayHeader({ day, dayNumber, onCityOverride }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  if (!day) return null;

  const city = day.resolvedCity ?? day.city;

  const startEdit = () => {
    setDraft(day.cityOverride ?? city ?? '');
    setEditing(true);
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSave = async () => {
    if (!onCityOverride) return;
    setSaving(true);
    try {
      await onCityOverride(day.date, draft.trim() || null);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') setEditing(false);
  };

  return (
    <div className="mb-6">
      <GoldRule className="mb-4" />
      <div className="flex items-center gap-2 mb-2">
        {editing ? (
          <>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={saving}
              className="font-mono text-[11px] tracking-[0.28em] uppercase bg-transparent border-b"
              style={{ color: 'var(--gold)', borderColor: 'var(--gold-line)', outline: 'none', width: '160px' }}
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              aria-label="Save city name"
              style={{ color: 'var(--gold)', opacity: saving ? 0.5 : 1 }}
            >
              <Check size={13} />
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              aria-label="Cancel edit"
              style={{ color: 'var(--cream-mute)' }}
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <>
            <p className="font-mono text-[11px] tracking-[0.28em] uppercase" style={{ color: 'var(--gold)' }}>
              {city} · Day {dayNumber}
            </p>
            {onCityOverride && (
              <button
                type="button"
                onClick={startEdit}
                aria-label="Edit city name"
                title={day.cityOverride ? `Override active: ${day.cityOverride}` : 'Override city name'}
                className="hover:opacity-100 transition-opacity"
                style={{ color: 'var(--gold)', opacity: day.cityOverride ? 1 : 0.4, padding: '2px' }}
              >
                <Pencil size={11} />
              </button>
            )}
          </>
        )}
      </div>
      <h2 className="font-display italic text-4xl sm:text-5xl mb-2" style={{ color: 'var(--cream)' }}>
        {day.theme || day.phase || city}
      </h2>
      <p className="font-body text-lg" style={{ color: 'var(--cream-dim)' }}>
        {new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', weekday: 'long' }).format(
          new Date(`${day.date}T00:00:00`),
        )}
        {' · '}
        {day.stops.length} stops
      </p>
    </div>
  );
}
