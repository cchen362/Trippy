import { useState, useEffect, useRef } from 'react';

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function DayPicker({ addedDayIds, days, suggestion, onAddToDay, onClose, anchorRef }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 220 });

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const popoverHeight = Math.min(days.length * 44 + 52, 320);
      const spaceAbove = rect.top;
      const openUpward = spaceAbove > popoverHeight + 8;
      setPos({
        top: openUpward ? rect.top - popoverHeight - 8 : rect.bottom + 8,
        left: rect.left,
        width: Math.max(rect.width, 220),
      });
    }

    function onMouseDown(e) {
      if (
        ref.current && !ref.current.contains(e.target) &&
        anchorRef.current && !anchorRef.current.contains(e.target)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        background: '#1a1410',
        border: '1px solid rgba(201,160,80,0.22)',
        borderRadius: 4,
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        zIndex: 9999,
        overflow: 'hidden',
        animation: 'fadeUp 0.18s ease both',
      }}
    >
      <div style={{
        padding: '12px 16px 8px',
        borderBottom: '1px solid rgba(240,235,227,0.06)',
      }}>
        <span style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: '#504438',
        }}>Add to day</span>
      </div>
      {days.map(day => {
        const added = addedDayIds.has(day.id);
        const label = day.date
          ? new Date(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
          : `Day ${day.day_number ?? day.id}`;
        return (
          <button
            key={day.id}
            className="discovery-day-btn"
            onClick={() => { onAddToDay(day.id, suggestion); onClose(); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '10px 16px',
              background: added ? 'rgba(201,160,80,0.08)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid rgba(240,235,227,0.04)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontSize: 16,
              color: added ? '#c9a050' : '#f0ebe3',
              letterSpacing: '0.01em',
            }}>
              {`Day ${(day.dayIndex ?? 0) + 1}`}
            </span>
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              color: added ? '#c9a050' : '#504438',
              letterSpacing: '0.08em',
            }}>
              {added ? '✓ added' : label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function SuggestionCard({ suggestion, days, onAddToDay }) {
  const { name, localName, description, whyItFits, whyItMatches, estimatedDuration, openingHours } = suggestion;
  const whyText = whyItFits ?? whyItMatches;
  const showLocalName = localName && normalizeName(localName) !== normalizeName(name);
  const displayName = showLocalName ? `${name} (${localName})` : name;

  const normalizedName = normalizeName(name ?? '');
  const addedToDayIds = new Set(
    (days ?? []).flatMap((d) =>
      (d.stops ?? [])
        .filter((s) => normalizeName(s.title ?? '') === normalizedName)
        .map(() => d.id),
    ),
  );
  const isInTrip = addedToDayIds.size > 0;

  const [pickerOpen, setPickerOpen] = useState(false);
  const btnRef = useRef(null);

  return (
    <div
      className="discovery-card"
      style={{
        position: 'relative',
        background: '#1a1410',
        border: '1px solid rgba(201,160,80,0.12)',
        borderRadius: 4,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        marginBottom: 0,
      }}
    >
      {/* Name + IN TRIP badge + separator */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h3 style={{
            fontFamily: "'Playfair Display', serif",
            fontStyle: 'italic',
            fontSize: 22,
            fontWeight: 500,
            color: '#f0ebe3',
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
            margin: 0,
            flex: 1,
          }}>
            {displayName}
          </h3>
          {isInTrip && (
            <span style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#c9a050',
              border: '1px solid rgba(201,160,80,0.35)',
              borderRadius: 2,
              padding: '3px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              marginTop: 3,
            }}>
              In trip
            </span>
          )}
        </div>
        <div style={{ width: 28, height: 1, background: 'rgba(201,160,80,0.35)' }} />
      </div>

      {/* Description — 3-line clamp */}
      {description && (
        <p style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 17,
          lineHeight: 1.72,
          color: '#8a7a6a',
          letterSpacing: '0.01em',
          margin: 0,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {description}
        </p>
      )}

      {/* Local insight — hidden by default, revealed on card hover via CSS */}
      {whyText && (
        <div
          className="discovery-card-hint"
          style={{ borderLeft: '2px solid rgba(201,160,80,0.4)', paddingLeft: 16, marginTop: -4 }}
        >
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 9,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'rgba(201,160,80,0.6)',
            marginBottom: 7,
          }}>
            Local insight
          </div>
          <p style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontStyle: 'italic',
            fontSize: 18,
            lineHeight: 1.72,
            color: '#b0a090',
            letterSpacing: '0.01em',
            margin: 0,
          }}>
            {whyText}
          </p>
        </div>
      )}

      {/* Meta badges */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {estimatedDuration && (
          <span style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.08em',
            color: '#c9a050',
            border: '1px solid rgba(201,160,80,0.28)',
            borderRadius: 2,
            padding: '4px 10px',
          }}>
            {estimatedDuration}
          </span>
        )}
        {openingHours && (
          <span style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.08em',
            color: '#8a7a6a',
            border: '1px solid rgba(240,235,227,0.1)',
            borderRadius: 2,
            padding: '4px 10px',
          }}>
            {openingHours}
          </span>
        )}
      </div>

      {/* Add to Day */}
      {days && days.length > 0 && (
        <div style={{ position: 'relative' }}>
          <button
            ref={btnRef}
            onClick={() => setPickerOpen(v => !v)}
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              borderRadius: 3,
              padding: '9px 16px',
              background: isInTrip ? 'rgba(201,160,80,0.1)' : 'transparent',
              color: isInTrip ? '#c9a050' : '#504438',
              border: `1px solid ${isInTrip ? 'rgba(201,160,80,0.35)' : 'rgba(201,160,80,0.12)'}`,
              transition: 'all 150ms',
            }}
          >
            {isInTrip ? '✓ Added' : 'Add to day'}
          </button>

          {pickerOpen && days.length > 0 && (
            <DayPicker
              addedDayIds={addedToDayIds}
              days={days}
              suggestion={suggestion}
              onAddToDay={onAddToDay}
              onClose={() => setPickerOpen(false)}
              anchorRef={btnRef}
            />
          )}
        </div>
      )}

      {/* Persistent day badges */}
      {isInTrip && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: -8 }}>
          {days.filter(d => addedToDayIds.has(d.id)).map(day => (
            <span key={day.id} style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              letterSpacing: '0.1em',
              color: '#c9a050',
              background: 'rgba(201,160,80,0.08)',
              border: '1px solid rgba(201,160,80,0.28)',
              borderRadius: 2,
              padding: '3px 10px',
            }}>
              {day.date
                ? `Day ${(day.dayIndex ?? 0) + 1} · ${new Date(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                : `Day ${(day.dayIndex ?? 0) + 1}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
