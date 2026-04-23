export default function SuggestionCard({ suggestion, days, onAddToDay }) {
  const { name, description, whyItMatches, estimatedDuration, openingHours } = suggestion;

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
      {/* Name */}
      <p
        style={{
          fontFamily: "'Playfair Display', serif",
          fontStyle: 'italic',
          fontSize: '14px',
          color: 'var(--cream)',
          margin: '0 0 4px 0',
        }}
      >
        {name}
      </p>

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
            {days.map((day) => (
              <button
                key={day.id}
                onClick={() => onAddToDay(day.id, suggestion)}
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: '10px',
                  color: 'rgba(240,234,216,0.70)',
                  border: '1px solid rgba(201,168,76,0.3)',
                  borderRadius: '6px',
                  padding: '3px 8px',
                  background: 'transparent',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  letterSpacing: '0.04em',
                }}
              >
                {day.date ? new Date(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : `Day ${day.day_number ?? day.id}`}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
