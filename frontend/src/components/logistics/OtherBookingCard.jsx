import { formatShortDate } from './bookingCardUtils.js';

function Row({ label, value, valueStyle, last }) {
  if (!value) return null;
  return (
    <div className={`flex items-center justify-between gap-4 py-3 ${last ? '' : 'hairline-row'}`}>
      <span className="font-mono text-[11px] tracking-[0.22em] uppercase flex-shrink-0" style={{ color: 'var(--cream-mute)' }}>
        {label}
      </span>
      <span className="font-mono text-[13px] tracking-[0.1em] text-right" style={valueStyle || { color: 'var(--cream)' }}>
        {value}
      </span>
    </div>
  );
}

export default function OtherBookingCard({ booking, onOpen }) {
  const startStr = formatShortDate(booking.startDatetime);
  const endStr = formatShortDate(booking.endDatetime);
  const whenStr = startStr && endStr && startStr !== endStr
    ? `${startStr} → ${endStr}`
    : (startStr || endStr || null);

  const typeLabel = (booking.type || 'other').toUpperCase();

  return (
    <button
      type="button"
      onClick={() => onOpen(booking)}
      className="w-full text-left rounded-xl border focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]"
      style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}
    >
      <div className="px-5 pt-5 pb-1">
        <p className="font-mono text-[11px] tracking-[0.26em] uppercase mb-3" style={{ color: 'var(--cream-mute)' }}>
          {typeLabel}
        </p>
        <h3 className="font-display italic text-2xl leading-tight mb-4" style={{ color: 'var(--cream)' }}>
          {booking.title}
        </h3>
      </div>

      <div className="px-5 pb-4">
        <Row label="WHEN" value={whenStr} last={!booking.destination && !booking.confirmationRef} />
        <Row label="WHERE" value={booking.destination} last={!booking.confirmationRef} />
        <Row
          label="CONFIRMATION"
          value={booking.confirmationRef}
          valueStyle={{ color: 'var(--gold)' }}
          last
        />
      </div>
    </button>
  );
}
