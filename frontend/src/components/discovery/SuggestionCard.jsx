import { useEffect, useRef, useState } from 'react';
import { Flag, X } from 'lucide-react';
import { useIsPresent } from 'framer-motion';
import DayPicker from './DayPicker.jsx';
import { canonicalGeoKey } from '../../utils/geoIdentity.js';

function parseLocalDateParts(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function normalizeName(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function SuggestionCard({
  suggestion,
  days,
  onAddToDay,
  destination,
  onReport,
  onOpenCopilot,
  detailsOpen: controlledDetailsOpen,
  onDetailsChange,
}) {
  const {
    id, name, localName, description, whyItFits, whyItMatches,
    estimatedDuration, openingHours, provenance, fitLine,
  } = suggestion;
  const whyText = whyItFits ?? whyItMatches;
  const isVerified = provenance === 'verified';
  const showLocalName = localName && normalizeName(localName) !== normalizeName(name);
  const displayName = showLocalName ? `${name} (${localName})` : name;

  const [uncontrolledDetailsOpen, setUncontrolledDetailsOpen] = useState(false);
  const detailsOpen = controlledDetailsOpen ?? uncontrolledDetailsOpen;
  const isPresent = useIsPresent();
  const detailsButtonRef = useRef(null);
  const wasDetailsOpenRef = useRef(detailsOpen);

  const setDetailsOpen = (nextOpen) => {
    if (controlledDetailsOpen === undefined) setUncontrolledDetailsOpen(nextOpen);
    onDetailsChange?.(nextOpen);
  };

  useEffect(() => {
    if (wasDetailsOpenRef.current && !detailsOpen) detailsButtonRef.current?.focus();
    wasDetailsOpenRef.current = detailsOpen;
  }, [detailsOpen]);

  const [reportStage, setReportStage] = useState('idle');
  const [reporting, setReporting] = useState(false);
  const reportRef = useRef(null);

  useEffect(() => {
    if (reportStage !== 'confirming') return undefined;
    function onOutsideInteraction(event) {
      if (reportRef.current && !reportRef.current.contains(event.target)) setReportStage('idle');
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setReportStage('idle');
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
    } catch (error) {
      console.error('[discovery] report failed:', error);
      setReporting(false);
      setReportStage('idle');
    }
  };

  const normalizedDestination = canonicalGeoKey(destination ?? '');
  const normalizedName = normalizeName(name);
  const relevantDays = normalizedDestination
    ? (days ?? []).filter((day) => canonicalGeoKey(day.resolvedCity ?? day.city ?? '') === normalizedDestination)
    : (days ?? []);
  const addedToDayIds = new Set(
    relevantDays.flatMap((day) =>
      (day.stops ?? [])
        .filter((stop) => normalizeName(stop.title) === normalizedName)
        .map(() => day.id)),
  );
  const matchingDays = (days ?? []).filter((day) => addedToDayIds.has(day.id));
  const isInTrip = matchingDays.length > 0;
  const compactDays = matchingDays.map((day) => `Day ${(day.dayIndex ?? 0) + 1}`).join(' · ');

  const [pickerOpen, setPickerOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef(null);

  const handleAddToDay = async (dayId, suggestionArg) => {
    if (adding) return;
    setAdding(true);
    try {
      await onAddToDay(dayId, suggestionArg);
    } catch (error) {
      console.error('[discovery] add to day failed:', error);
    } finally {
      setAdding(false);
    }
  };

  return (
    <article className={`discovery-card${detailsOpen ? ' discovery-card-selected' : ''}`}>
      <div className="discovery-card-summary">
        <div className="discovery-card-heading">
          <h3 className="discovery-card-title discovery-clamp-2">{displayName}</h3>
          {isInTrip ? (
            <span className="discovery-card-in-trip discovery-clamp-1"><span>In trip</span> · {compactDays}</span>
          ) : estimatedDuration ? (
            <span className="discovery-card-duration">{estimatedDuration}</span>
          ) : null}
        </div>

        {description && <p className="discovery-card-description discovery-clamp-2">{description}</p>}
        {whyText && (
          <p className="discovery-card-insight discovery-clamp-1">
            <span aria-hidden="true">✦</span> {whyText}
          </p>
        )}

        <div className="discovery-card-actions">
          {days?.length > 0 && (
            <div className="discovery-card-add-wrap">
              <button
                ref={addButtonRef}
                type="button"
                className={`discovery-card-add${isInTrip ? ' is-added' : ''}`}
                onClick={() => !isInTrip && !adding && setPickerOpen((open) => !open)}
                disabled={isInTrip || adding}
              >
                {isInTrip ? '✓ Added' : adding ? 'Adding…' : 'Add to day'}
              </button>
              {!isInTrip && !adding && pickerOpen && (
                <DayPicker
                  addedDayIds={addedToDayIds}
                  days={days}
                  suggestion={suggestion}
                  onAddToDay={handleAddToDay}
                  onClose={() => setPickerOpen(false)}
                  anchorRef={addButtonRef}
                />
              )}
            </div>
          )}

          {onOpenCopilot && name && (
            <button
              type="button"
              className="discovery-card-copilot"
              onClick={() => onOpenCopilot({ tab: 'discovery', discoveryName: name })}
            >
              Ask co-pilot
            </button>
          )}

          {id != null && onReport && (
            <div ref={reportRef} className={`discovery-card-report${reportStage === 'confirming' ? ' is-confirming' : ''}`}>
              {reportStage === 'idle' ? (
                <button
                  type="button"
                  onClick={() => setReportStage('confirming')}
                  aria-label="Report this place"
                  title="Report this place"
                  className="discovery-card-report-trigger"
                >
                  <Flag size={13} />
                </button>
              ) : (
                <>
                  <button type="button" onClick={handleReport} disabled={reporting} className="discovery-card-report-reason">Not real</button>
                  <button type="button" onClick={handleReport} disabled={reporting} className="discovery-card-report-reason">Closed</button>
                  <button
                    type="button"
                    onClick={() => setReportStage('idle')}
                    disabled={reporting}
                    aria-label="Cancel report"
                    className="discovery-card-report-cancel"
                  >
                    <X size={12} />
                  </button>
                </>
              )}
            </div>
          )}

          <button
            ref={detailsButtonRef}
            type="button"
            className="discovery-card-details-trigger"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            Details {detailsOpen ? '↑' : '↓'}
          </button>
        </div>
      </div>

      {detailsOpen && isPresent && (
        <section
          role="region"
          aria-label={`Details for ${name}`}
          className="discovery-card-detail"
        >
          <div className="discovery-card-detail-header">
            <h4>{displayName}</h4>
            <button type="button" onClick={() => setDetailsOpen(false)} aria-label="Close details">
              <X size={18} />
            </button>
          </div>
          <div className="discovery-card-detail-scroll">
            {description && <p className="discovery-card-detail-description">{description}</p>}
            {whyText && (
              <div className="discovery-card-detail-insight">
                <span>Local insight</span>
                <p>{whyText}</p>
              </div>
            )}
            {fitLine && <p className="discovery-card-fit-line">{fitLine}</p>}
            <div className="discovery-card-metadata">
              <span>{isVerified ? 'Verified' : 'Unverified'}</span>
              {estimatedDuration && <span>{estimatedDuration}</span>}
              {openingHours && (
                <span title="Hours may be outdated — confirm before you go">
                  {openingHours} — verify
                </span>
              )}
            </div>
            {isInTrip && (
              <div className="discovery-card-detail-days">
                <span>In trip</span>
                {matchingDays.map((day) => (
                  <span key={day.id}>
                    {day.date
                      ? `Day ${(day.dayIndex ?? 0) + 1} · ${parseLocalDateParts(day.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                      : `Day ${(day.dayIndex ?? 0) + 1}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </article>
  );
}
