import { useState, useRef, useEffect } from 'react';
import { Flag, X } from 'lucide-react';
import DayPicker from './DayPicker.jsx';
import { canonicalGeoKey } from '../../utils/geoIdentity.js';

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

export default function SuggestionCard({ suggestion, days, onAddToDay, destination, onReport, onOpenCopilot }) {
  const { id, name, localName, description, whyItFits, whyItMatches, estimatedDuration, openingHours, provenance, fitLine } = suggestion;
  const whyText = whyItFits ?? whyItMatches;
  const isVerified = provenance === 'verified';
  // Two-step report (icon → reason choice) rather than a single tap, so a
  // stray touch on a dense card grid can't silently suppress a real place.
  // Both reasons call the same suppress endpoint (the backend has no reason
  // taxonomy — decision 3 is a plain boolean suppress) — the choice exists
  // to make the user's tap deliberate, not to change what gets stored.
  const [reportStage, setReportStage] = useState('idle'); // 'idle' | 'confirming'
  const [reporting, setReporting] = useState(false);
  const reportRef = useRef(null);

  useEffect(() => {
    if (reportStage !== 'confirming') return;
    function onOutsideInteraction(e) {
      if (reportRef.current && !reportRef.current.contains(e.target)) {
        setReportStage('idle');
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setReportStage('idle');
    }
    document.addEventListener('mousedown', onOutsideInteraction);
    document.addEventListener('touchstart', onOutsideInteraction);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onOutsideInteraction);
      document.removeEventListener('touchstart', onOutsideInteraction);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [reportStage]);

  const handleReport = async () => {
    if (reporting || id == null) return;
    setReporting(true);
    try {
      await onReport(id);
    } catch (err) {
      console.error('[discovery] report failed:', err);
      setReporting(false);
      setReportStage('idle');
    }
  };
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
  const normalizedDestination = canonicalGeoKey(destination ?? '');
  const normalizedName = normalizeName(name ?? '');
  const relevantDays = normalizedDestination
    ? (days ?? []).filter((d) => canonicalGeoKey(d.resolvedCity ?? d.city ?? '') === normalizedDestination)
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
  const [adding, setAdding] = useState(false);
  const btnRef = useRef(null);

  // Per-suggestion pending guard (Wave 4 §4.2) — not a global lock: adding a
  // different suggestion stays available while this one's request is in
  // flight, and out-of-order refreshes are already made safe by the
  // useTrip.refresh id guard (§4.1). onAddToDay resolves only once the
  // triggered refresh has landed (useStops.run awaits onChanged() before
  // returning), so "Adding…" naturally holds until the new stop is visible.
  const handleAddToDay = async (dayId, suggestionArg) => {
    if (adding) return;
    setAdding(true);
    try {
      await onAddToDay(dayId, suggestionArg);
    } catch (err) {
      // Failure is already surfaced via the shared TripPage error banner
      // (stopActions.error) — nothing local to recover here.
      console.error('[discovery] add to day failed:', err);
    } finally {
      setAdding(false);
    }
  };

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
        // Fill the grid/flex parent so cards in the same row share one height
        // (no-op in non-flex contexts like the surprise-pick block).
        flex: 1,
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
        {/* Day badges live here, not in the footer — the footer's bottom-anchor
            (marginTop:'auto' on the meta badges below) only holds a constant-height
            group flush; a variable-height trailing block would push that group up
            on in-trip cards, misaligning it against cards without one. */}
        {isInTrip && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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

      {/* Fit line (Wave 4, honesty-gated) — always visible, distinct from the
          hover-revealed Local insight quote below: shorter, structural, and
          never claims an interest/pace the trip didn't declare. */}
      {fitLine && (
        <p style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontStyle: 'italic',
          fontSize: 14,
          lineHeight: 1.5,
          color: '#6e5e50',
          letterSpacing: '0.01em',
          margin: '-6px 0 0',
        }}>
          {fitLine}
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

      {/* Meta badges — marginTop:'auto' pins this and everything after it
          (Add to Day, persistent day badges) to the card's bottom edge, so
          footers align across a row regardless of how much description/
          fit-line/local-insight text precedes them. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 'auto' }}>
        {/* Provenance tag — gold is already spent on duration/"In trip" above,
            so this uses low-emphasis cream rather than competing for the accent. */}
        <span style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: isVerified ? 'rgba(240,235,227,0.5)' : 'rgba(240,235,227,0.32)',
        }}>
          {isVerified ? 'VERIFIED' : 'UNVERIFIED'}
        </span>
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

      {/* Add to Day + Report */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        {days && days.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              ref={btnRef}
              onClick={() => !isInTrip && !adding && setPickerOpen(v => !v)}
              disabled={isInTrip || adding}
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                cursor: (isInTrip || adding) ? 'default' : 'pointer',
                borderRadius: 3,
                padding: '12px 16px',
                background: isInTrip ? 'rgba(201,160,80,0.1)' : 'transparent',
                color: isInTrip ? '#c9a050' : (adding ? 'rgba(80,68,56,0.5)' : '#504438'),
                border: `1px solid ${isInTrip ? 'rgba(201,160,80,0.35)' : 'rgba(201,160,80,0.12)'}`,
                opacity: adding ? 0.6 : 1,
                transition: 'all 150ms',
              }}
            >
              {isInTrip ? '✓ Added' : adding ? 'Adding…' : 'Add to day'}
            </button>

            {!isInTrip && !adding && pickerOpen && days.length > 0 && (
              <DayPicker
                addedDayIds={addedToDayIds}
                days={days}
                suggestion={suggestion}
                onAddToDay={handleAddToDay}
                onClose={() => setPickerOpen(false)}
                anchorRef={btnRef}
              />
            )}
          </div>
        )}

        {/* Report — only meaningful once the place has a real catalogue id
            (freshly-streamed, not-yet-inserted generation items don't have
            one yet, so there is nothing honest to report against). Icon-only
            by default (bottom-right of the row) so it doesn't compete with
            "Add to day" or read as a warning on every card in the grid;
            expands to an explicit two-choice confirm on tap. */}
        {onOpenCopilot && name && (
          <button
            type="button"
            onClick={() => onOpenCopilot({ tab: 'discovery', discoveryName: name })}
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#504438',
              background: 'none',
              border: 'none',
              padding: '12px 0',
              marginLeft: 'auto',
              cursor: 'pointer',
            }}
          >
            Ask co-pilot
          </button>
        )}

        {id != null && onReport && (
          <div ref={reportRef} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {reportStage === 'idle' ? (
              <button
                onClick={() => setReportStage('confirming')}
                aria-label="Report this place"
                title="Report this place"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'none', border: 'none', padding: 6,
                  color: 'rgba(240,235,227,0.28)', cursor: 'pointer',
                }}
              >
                <Flag size={13} />
              </button>
            ) : (
              <>
                <button
                  onClick={handleReport}
                  disabled={reporting}
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: reporting ? 'rgba(224,90,90,0.3)' : 'rgba(224,90,90,0.7)',
                    background: 'rgba(224,90,90,0.08)',
                    border: '1px solid rgba(224,90,90,0.25)',
                    borderRadius: 3, padding: '5px 9px',
                    cursor: reporting ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Not real
                </button>
                <button
                  onClick={handleReport}
                  disabled={reporting}
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: reporting ? 'rgba(224,90,90,0.3)' : 'rgba(224,90,90,0.7)',
                    background: 'rgba(224,90,90,0.08)',
                    border: '1px solid rgba(224,90,90,0.25)',
                    borderRadius: 3, padding: '5px 9px',
                    cursor: reporting ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Closed
                </button>
                <button
                  onClick={() => setReportStage('idle')}
                  disabled={reporting}
                  aria-label="Cancel report"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'none', border: 'none', padding: 4,
                    color: 'rgba(240,235,227,0.28)',
                    cursor: reporting ? 'default' : 'pointer',
                  }}
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
