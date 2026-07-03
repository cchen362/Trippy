import { AlertCircle } from 'lucide-react';
import { formatShortDate } from '../logistics/bookingCardUtils.js';

function Row({ label, value, valueStyle, last }) {
  if (!value) return null;
  return (
    <div className={`logistics-data-row ${last ? '' : 'logistics-data-row-divided'}`}>
      <span className="logistics-row-label">{label}</span>
      <span className="logistics-row-value" style={valueStyle || undefined}>{value}</span>
    </div>
  );
}

function whenString(data) {
  const tz = data.originTz || null;
  const start = formatShortDate(data.startDatetime, tz);
  const end = formatShortDate(data.endDatetime, tz);
  if (start && end && start !== end) return `${start} → ${end}`;
  return start || end || null;
}

function whereString(data) {
  if (data.origin && data.destination) return `${data.origin} → ${data.destination}`;
  return data.destination || data.origin || null;
}

export default function ExtractedBookingCard({
  draft, onToggleIncluded, onEdit, onExtendTrip, tripEndDate, onExtendTripStart, tripStartDate,
}) {
  const { data, warnings, included } = draft;
  const duplicateWarning = warnings.find((w) => w.type === 'duplicate');
  const afterTripEndWarning = warnings.find((w) => w.type === 'afterTripEnd');
  const beforeTripStartWarning = warnings.find((w) => w.type === 'beforeTripStart');
  const showConfidenceHint = data.confidence && data.confidence.overall !== 'high';

  return (
    <div className="logistics-card">
      <div className="logistics-card-top">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={included}
            onChange={() => onToggleIncluded(draft.localId)}
            aria-label={`Include ${data.title}`}
            style={{ width: 24, height: 24, accentColor: 'var(--gold)', marginTop: 2 }}
          />
          <div className="min-w-0 flex-1">
            <p className="logistics-eyebrow">{(data.type || 'other').toUpperCase()}</p>
            <h3 className="logistics-card-title truncate">{data.title}</h3>
          </div>
          <button
            type="button"
            onClick={() => onEdit(draft.localId)}
            className="shrink-0 font-mono text-[11px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--cream-dim)' }}
          >
            Edit
          </button>
        </div>
      </div>

      <div className="logistics-card-rows">
        <Row label="WHEN" value={whenString(data)} />
        <Row label="WHERE" value={whereString(data)} />
        <Row label="CONFIRMATION" value={data.confirmationRef} valueStyle={{ color: 'var(--gold)' }} last />
      </div>

      {(showConfidenceHint || data.assumptions?.length > 0 || duplicateWarning || afterTripEndWarning || beforeTripStartWarning) && (
        <div className="px-[18px] pb-4 space-y-2">
          {showConfidenceHint && (
            <p className="font-body text-sm flex items-start gap-2" style={{ color: 'var(--gold)' }}>
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              Double check the details — confidence is {data.confidence.overall}.
            </p>
          )}
          {data.assumptions?.map((assumption, i) => (
            <p key={i} className="font-body text-sm flex items-start gap-2" style={{ color: 'var(--gold)' }}>
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              {assumption}
            </p>
          ))}
          {duplicateWarning && (
            <p className="font-body text-sm flex items-start gap-2" style={{ color: 'var(--cream-mute)' }}>
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              Looks like you already have this booking saved.
            </p>
          )}
          {beforeTripStartWarning && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-body text-sm" style={{ color: 'var(--cream-mute)' }}>
                This is before your trip starts ({tripStartDate}).
              </p>
              <button
                type="button"
                onClick={() => onExtendTripStart(beforeTripStartWarning.suggestedStartDate)}
                className="modal-action"
              >
                Extend trip to {beforeTripStartWarning.suggestedStartDate}
              </button>
            </div>
          )}
          {afterTripEndWarning && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-body text-sm" style={{ color: 'var(--cream-mute)' }}>
                This is after your trip ends ({tripEndDate}).
              </p>
              <button
                type="button"
                onClick={() => onExtendTrip(afterTripEndWarning.suggestedEndDate)}
                className="modal-action"
              >
                Extend trip to {afterTripEndWarning.suggestedEndDate}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
