import { Loader2 } from 'lucide-react';
import ExtractedBookingCard from './ExtractedBookingCard.jsx';

export default function ExtractionReview({
  extraction,
  draftBookings,
  onToggleIncluded,
  onEditCard,
  onExtendTrip,
  onExtendTripStart,
  onRetry,
  onConfirm,
  confirming,
  submitError,
  tripEndDate,
  tripStartDate,
}) {
  const isEmpty = !extraction.isTravelRelated || extraction.bookings.length === 0;
  const includedCount = draftBookings.filter((d) => d.included).length;

  if (isEmpty) {
    return (
      <div className="text-center py-12">
        <h3 className="font-display italic text-2xl mb-3" style={{ color: 'var(--cream)' }}>
          {extraction.isTravelRelated ? "We couldn't find any bookings in that." : "This doesn't look like travel."}
        </h3>
        <p className="font-body text-lg mb-6" style={{ color: 'var(--cream-dim)' }}>
          {extraction.summary}
        </p>
        <button type="button" onClick={onRetry} className="modal-action">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="font-body text-lg mb-6" style={{ color: 'var(--cream-dim)' }}>
        {extraction.summary}
      </p>

      <div className="space-y-3">
        {draftBookings.map((draft) => (
          <ExtractedBookingCard
            key={draft.localId}
            draft={draft}
            onToggleIncluded={onToggleIncluded}
            onEdit={onEditCard}
            onExtendTrip={onExtendTrip}
            tripEndDate={tripEndDate}
            onExtendTripStart={onExtendTripStart}
            tripStartDate={tripStartDate}
          />
        ))}
      </div>

      {submitError && (
        <p className="mt-4 font-mono text-xs" style={{ color: '#e05a5a' }}>
          {submitError}
        </p>
      )}

      <div
        className="sticky bottom-0 pt-4 mt-6 border-t flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        style={{ borderColor: 'var(--ink-border)', background: 'var(--ink-surface)' }}
      >
        <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
          {includedCount} of {draftBookings.length} included
        </span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={includedCount === 0 || confirming}
          className="px-5 py-4 rounded-2xl font-mono text-xs tracking-[0.28em] uppercase inline-flex items-center justify-center gap-2"
          style={{ background: 'var(--gold)', color: 'var(--ink-deep)', opacity: includedCount === 0 || confirming ? 0.5 : 1 }}
        >
          {confirming && <Loader2 size={14} className="animate-spin" />}
          {confirming ? 'Adding...' : `Add ${includedCount} bookings`}
        </button>
      </div>
    </>
  );
}
