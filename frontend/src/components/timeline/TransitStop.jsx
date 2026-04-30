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

export default function TransitStop({ stop, index, expanded, onExpand, onDelete, onUpdate, days, onMove, dragHandleProps }) {
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
        className="absolute left-[9px] top-6 w-[7px] h-[7px] rounded-full border"
        style={{ borderColor: 'rgba(240,234,216,0.25)' }}
      />
      <div
        className="timeline-card"
        style={{
          background: 'var(--ink-surface)',
          borderRadius: '12px',
          borderTop: '1px solid rgba(240,234,216,0.08)',
          borderRight: '1px solid rgba(240,234,216,0.08)',
          borderBottom: '1px solid rgba(240,234,216,0.08)',
          borderLeft: '3px solid rgba(201,168,76,0.45)',
          minHeight: '80px',
        }}
      >
        <div style={{ padding: '12px 16px' }}>
          <div>
            <p style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              color: 'var(--gold)',
              margin: '0 0 4px 0',
            }}>
              TRANSIT
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
              <button
                type="button"
                onClick={() => onExpand(stop.id)}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                <h3 style={{
                  fontFamily: "'Playfair Display', serif",
                  fontStyle: 'italic',
                  fontSize: '18px',
                  color: 'var(--cream)',
                  margin: 0,
                  lineHeight: 1.3,
                }}>
                  {stop.title}
                </h3>
              </button>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                {(stop.time || index !== undefined) && (
                  <span style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: '11px',
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: 'rgba(240,234,216,0.45)',
                    whiteSpace: 'nowrap',
                    paddingTop: '4px',
                  }}>
                    {stop.time || `${index + 1}`}
                  </span>
                )}
                <span
                  {...dragHandleProps}
                  className="timeline-drag-handle cursor-grab active:cursor-grabbing"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 4px)',
                    placeContent: 'center',
                    gap: '3px',
                    minWidth: '44px',
                    minHeight: '44px',
                    margin: '-12px -12px 0 0',
                    padding: '10px',
                  }}
                >
                  {[...Array(6)].map((_, i) => (
                    <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(240,234,216,0.3)' }} />
                  ))}
                </span>
              </span>
            </div>
          </div>

          {expanded && (
            <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(240,234,216,0.10)' }}>
              <textarea
                value={noteValue}
                onChange={(e) => { setNoteValue(e.target.value); setNoteDirty(true); }}
                onBlur={handleNoteBlur}
                placeholder="Add notes, seat number, platform, directions..."
                rows={3}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(240,234,216,0.14)',
                  color: 'var(--cream-dim)',
                  fontFamily: "'Cormorant Garamond', serif",
                  fontSize: '17px',
                  lineHeight: 1.6,
                  resize: 'none',
                  outline: 'none',
                  paddingBottom: '8px',
                  marginBottom: '8px',
                  boxSizing: 'border-box',
                }}
              />

              <div style={{ marginTop: '8px' }}>
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
  );
}
