import { useEffect, useState } from 'react';

const monoStyle = {
  fontFamily: "'DM Mono', monospace",
  fontSize: '11px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
};

export default function StopCard({ stop, expanded, onToggle, onDelete, onUpdate, days, onMove }) {
  const [action, setAction] = useState(null); // null | 'delete' | 'move'
  const [noteValue, setNoteValue] = useState(stop.note || '');
  const [noteDirty, setNoteDirty] = useState(false);

  useEffect(() => {
    if (!expanded) setAction(null);
  }, [expanded]);

  useEffect(() => {
    if (!noteDirty) setNoteValue(stop.note || '');
  }, [stop.note]);

  const handleNoteBlur = async () => {
    if (!noteDirty) return;
    setNoteDirty(false);
    await onUpdate(stop.id, { note: noteValue });
  };

  const otherDays = days ? days.filter((d) => d.id !== stop.dayId) : [];
  const canMove = !stop.bookingId && otherDays.length > 0;

  return (
    <div className="relative pl-10">
      <span
        className="absolute left-[8px] top-8 w-[9px] h-[9px] rounded-full"
        style={{ background: 'var(--gold)' }}
      />
      <div
        className="rounded-2xl overflow-hidden border"
        style={{
          borderColor: stop.isFeatured ? 'var(--gold-line)' : 'var(--ink-border)',
          minHeight: stop.isFeatured ? '180px' : '136px',
        }}
      >
        <div className="relative h-full">
          {stop.unsplashPhotoUrl ? (
            <img src={stop.unsplashPhotoUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #3d3021, #101010)' }} />
          )}
          <div className="absolute inset-0 trip-card-overlay" />
          {expanded && (
            <div
              className="absolute inset-x-0 bottom-0"
              style={{
                top: '35%',
                background: 'linear-gradient(to bottom, transparent 0%, rgba(13,11,9,0.82) 30%, rgba(13,11,9,0.88) 100%)',
                borderRadius: '0 0 16px 16px',
                pointerEvents: 'none',
              }}
            />
          )}
          <div className="relative z-10 p-4 sm:p-5 h-full flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => onToggle(stop.id)} className="text-left">
                <p className="font-mono text-[11px] tracking-[0.24em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
                  {stop.type}
                </p>
                <h3 className="font-display italic text-2xl sm:text-[30px]" style={{ color: 'var(--cream)' }}>
                  {stop.title}
                </h3>
              </button>
              <span className="rounded-full border px-3 py-2 font-mono text-[10px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)', borderColor: 'rgba(240,234,216,0.18)', background: 'rgba(13,11,9,0.22)' }}>
                Drag
              </span>
            </div>

            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="font-mono text-xs tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                  {stop.time || 'Flexible'}
                </p>
                {stop.duration && (
                  <p className="font-body text-base" style={{ color: 'var(--cream-dim)' }}>{stop.duration}</p>
                )}
              </div>
              {stop.estimatedCost && (
                <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-dim)' }}>
                  {stop.estimatedCost}
                </p>
              )}
            </div>

            {expanded && (
              <div className="pt-3 border-t" style={{ borderColor: 'rgba(240,234,216,0.14)' }}>
                <textarea
                  value={noteValue}
                  onChange={(e) => { setNoteValue(e.target.value); setNoteDirty(true); }}
                  onBlur={handleNoteBlur}
                  placeholder="Add notes, directions, tips..."
                  rows={3}
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid rgba(240,234,216,0.14)',
                    color: 'var(--cream-dim)',
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: '18px',
                    lineHeight: 1.6,
                    resize: 'none',
                    outline: 'none',
                    paddingBottom: '8px',
                    marginBottom: '8px',
                  }}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {stop.bestTime && <span className="pill">{stop.bestTime}</span>}
                  {stop.bookingRequired && <span className="pill">Booking Required</span>}
                </div>

                <div style={{ marginTop: '12px' }}>
                  {action === null && (
                    <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                      <button type="button" onClick={() => setAction('delete')}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                        Remove
                      </button>
                      {canMove && (
                        <button type="button" onClick={() => setAction('move')}
                          style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                          Move to →
                        </button>
                      )}
                    </div>
                  )}

                  {action === 'delete' && (
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                      <button type="button" onClick={() => onDelete(stop.id)}
                        style={{ ...monoStyle, color: '#e05a5a' }}>
                        Remove?
                      </button>
                      <button type="button" onClick={() => setAction(null)}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {action === 'move' && (
                    <div>
                      <p style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: '10px',
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: 'rgba(240,234,216,0.35)',
                        margin: '0 0 8px 0',
                      }}>
                        Move to
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                        {otherDays.map((day) => (
                          <button
                            key={day.id}
                            type="button"
                            onClick={() => onMove(stop.id, day.id)}
                            style={{
                              fontFamily: "'DM Mono', monospace",
                              fontSize: '10px',
                              letterSpacing: '0.18em',
                              textTransform: 'uppercase',
                              color: 'var(--cream-dim)',
                              background: 'rgba(240,234,216,0.06)',
                              border: '1px solid rgba(240,234,216,0.15)',
                              borderRadius: '999px',
                              padding: '4px 12px',
                              cursor: 'pointer',
                            }}
                          >
                            Day {days.indexOf(day) + 1}{day.city ? ` · ${day.city}` : ''}
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => setAction(null)}
                        style={{ ...monoStyle, color: 'rgba(240,234,216,0.35)' }}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
