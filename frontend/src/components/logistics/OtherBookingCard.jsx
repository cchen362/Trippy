import { formatShortDate } from './bookingCardUtils.js';

function Row({ label, value, valueStyle, last }) {
  if (!value) return null;
  return (
    <div className={`logistics-data-row ${last ? '' : 'logistics-data-row-divided'}`}>
      <span className="logistics-row-label">
        {label}
      </span>
      <span className="logistics-row-value" style={valueStyle || undefined}>
        {value}
      </span>
    </div>
  );
}

export default function OtherBookingCard({ booking, onOpen }) {
  const tz = booking.originTz || null;
  const startStr = formatShortDate(booking.startDatetime, tz);
  const endStr = formatShortDate(booking.endDatetime, tz);
  const whenStr = startStr && endStr && startStr !== endStr
    ? `${startStr} \u2192 ${endStr}`
    : (startStr || endStr || null);

  const typeLabel = (booking.type || 'other').toUpperCase();

  return (
    <button
      type="button"
      onClick={() => onOpen(booking)}
      className="logistics-card w-full text-left focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]"
    >
      <div className="logistics-card-top">
        <p className="logistics-eyebrow">
          {typeLabel}
        </p>
        <h3 className="logistics-card-title">
          {booking.title}
        </h3>
      </div>

      <div className="logistics-card-rows">
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
