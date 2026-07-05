import { useState, useRef } from 'react';
import DayPicker from './DayPicker.jsx';

// Parses a 'YYYY-MM-DD' calendar date string as local (device) midnight rather
// than UTC midnight. `new Date('YYYY-MM-DD')` parses as UTC, which renders as
// the previous day in negative-UTC-offset timezones — this avoids that bug.
function parseLocalDateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function SuggestionCard({ suggestion, days, onAddToDay, destination }) {
  const { name, localName, description, whyItFits, whyItMatches, estimatedDuration, openingHours } = suggestion;
  const whyText = whyItFits ?? whyItMatches;
  const showLocalName = localName && normalizeName(localName) !== normalizeName(name);
  const displayName = showLocalName ? `${name} (${localName})` : name;

  // "In trip" matches by normalized title alone, which false-positives on generic
  // names ("Old Town", "Central Market") shared across unrelated cities and would
  // permanently disable Add for a place the trip has never actually visited.
  // Scope the match to days whose resolved city matches the destination currently
  // being browsed in Discover — that's the tightest boundary the data supports
  // (suggestions don't carry their own city; they're all fetched per-destination),
  // and it keeps the indicator meaningful: a same-named place added under a
  // different city no longer shadows this one.
  const normalizedDestination = normalizeName(destination ?? '');
  const normalizedName = normalizeName(name ?? '');
  const relevantDays = normalizedDestination
    ? (days ?? []).filter((d) => normalizeName(d.resolvedCity ?? d.city ?? '') === normalizedDestination)
    : (days ?? []);
  const addedToDayIds = new Set(
    relevantDays.flatMap((d) =>
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

      {/* Description */}
      {description && (
        <p style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 17,
          lineHeight: 1.72,
          color: '#8a7a6a',
          letterSpacing: '0.01em',
          margin: 0,
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
          // Cached discovery results can sit for up to 48h (and the underlying
          // Claude data may itself be older), so hours are a hint, not a fact
          // of record — never render this as if it were freshly verified.
          <span
            title="Hours may be outdated — confirm before you go"
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 11,
              letterSpacing: '0.08em',
              color: '#6e5e50',
              fontStyle: 'italic',
              border: '1px dashed rgba(240,235,227,0.1)',
              borderRadius: 2,
              padding: '4px 10px',
            }}>
            {openingHours} — verify
          </span>
        )}
      </div>

      {/* Add to Day */}
      {days && days.length > 0 && (
        <div style={{ position: 'relative' }}>
          <button
            ref={btnRef}
            onClick={() => !isInTrip && setPickerOpen(v => !v)}
            disabled={isInTrip}
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              cursor: isInTrip ? 'default' : 'pointer',
              borderRadius: 3,
              padding: '12px 16px',
              background: isInTrip ? 'rgba(201,160,80,0.1)' : 'transparent',
              color: isInTrip ? '#c9a050' : '#504438',
              border: `1px solid ${isInTrip ? 'rgba(201,160,80,0.35)' : 'rgba(201,160,80,0.12)'}`,
              transition: 'all 150ms',
            }}
          >
            {isInTrip ? '✓ Added' : 'Add to day'}
          </button>

          {!isInTrip && pickerOpen && days.length > 0 && (
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
                ? `Day ${(day.dayIndex ?? 0) + 1} · ${parseLocalDateParts(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                : `Day ${(day.dayIndex ?? 0) + 1}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
