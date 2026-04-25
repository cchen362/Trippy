// Strips punctuation and common geographic suffixes — mirrors the backend normalization
// so "IN TRIP" detection is consistent with what Claude's dedup pass uses.
function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function SuggestionCard({ suggestion, days, onAddToDay }) {
  const { name, description, whyItMatches, estimatedDuration, openingHours } = suggestion;

  const normalizedName = normalizeName(name ?? '');
  const addedToDayIds = new Set(
    (days ?? []).flatMap((d) =>
      (d.stops ?? [])
        .filter((s) => normalizeName(s.title ?? '') === normalizedName)
        .map(() => d.id),
    ),
  );
  const isInTrip = addedToDayIds.size > 0;

  return (
    <div
      style={{
        background: '#1c1a17',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '12px',
        padding: '12px 14px',
        marginBottom: '8px',
      }}
    >
      {/* Name + IN TRIP badge */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
        <p
          style={{
            fontFamily: "'Playfair Display', serif",
            fontStyle: 'italic',
            fontSize: '14px',
            color: 'var(--cream)',
            margin: 0,
            flex: 1,
          }}
        >
          {name}
        </p>
        {isInTrip && (
          <span
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '9px',
              letterSpacing: '0.12em',
              color: 'var(--gold)',
              border: '1px solid rgba(201,168,76,0.5)',
              borderRadius: '999px',
              padding: '1px 6px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            IN TRIP
          </span>
        )}
      </div>

      {/* Description */}
      {description && (
        <p
          style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: '13px',
            color: 'rgba(240,234,216,0.70)',
            margin: '0 0 4px 0',
            lineHeight: '1.5',
          }}
        >
          {description}
        </p>
      )}

      {/* Why it matches */}
      {whyItMatches && (
        <p
          style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontStyle: 'italic',
            fontSize: '12px',
            color: 'rgba(240,234,216,0.50)',
            margin: '0 0 8px 0',
            lineHeight: '1.4',
          }}
        >
          {whyItMatches}
        </p>
      )}

      {/* Duration / Opening Hours pills */}
      {(estimatedDuration || openingHours) && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
          {estimatedDuration && (
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                color: 'var(--gold)',
                border: '1px solid rgba(201,168,76,0.4)',
                borderRadius: '999px',
                padding: '2px 8px',
                letterSpacing: '0.06em',
              }}
            >
              {estimatedDuration}
            </span>
          )}
          {openingHours && (
            <span
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: '10px',
                color: 'var(--gold)',
                border: '1px solid rgba(201,168,76,0.4)',
                borderRadius: '999px',
                padding: '2px 8px',
                letterSpacing: '0.06em',
              }}
            >
              {openingHours}
            </span>
          )}
        </div>
      )}

      {/* Add to Day */}
      {days && days.length > 0 && (
        <div>
          <p
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: '10px',
              color: 'rgba(240,234,216,0.50)',
              letterSpacing: '0.18em',
              margin: '0 0 5px 0',
            }}
          >
            ADD TO DAY
          </p>
          <div
            style={{
              display: 'flex',
              gap: '6px',
              overflowX: 'auto',
              paddingBottom: '2px',
            }}
          >
            {days.map((day) => {
              const added = addedToDayIds.has(day.id);
              return (
                <button
                  key={day.id}
                  onClick={() => onAddToDay(day.id, suggestion)}
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: '10px',
                    color: added ? '#0d0b09' : 'rgba(240,234,216,0.70)',
                    border: '1px solid rgba(201,168,76,0.3)',
                    borderRadius: '6px',
                    padding: '3px 8px',
                    background: added ? 'var(--gold)' : 'transparent',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    letterSpacing: '0.04em',
                  }}
                >
                  {added ? '✓ ' : ''}{day.date ? new Date(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : `Day ${day.day_number ?? day.id}`}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
