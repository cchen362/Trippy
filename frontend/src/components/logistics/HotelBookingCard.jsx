import { Paperclip } from 'lucide-react';
import { formatShortDate, computeNights } from './bookingCardUtils.js';

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

export default function HotelBookingCard({ booking, onOpen }) {
  const hotelTz = booking.originTz || null;
  const nights = computeNights(booking.startDatetime, booking.endDatetime);
  const checkInStr = formatShortDate(booking.startDatetime, hotelTz);
  const checkOutStr = formatShortDate(booking.endDatetime, hotelTz);
  const checkOutDisplay = checkOutStr
    ? `${checkOutStr}${nights > 0 ? ` \u00b7 ${nights} ${nights === 1 ? 'night' : 'nights'}` : ''}`
    : null;

  const rows = [
    checkInStr,
    checkOutDisplay,
    booking.bookingSource,
    booking.confirmationRef,
  ].filter(Boolean);
  const lastIndex = rows.length - 1;

  return (
    <button
      type="button"
      onClick={() => onOpen(booking)}
      aria-label={`Hotel booking: ${booking.title}. Opens details.`}
      className="logistics-card w-full text-left focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]"
    >
      <span className="logistics-keyline" aria-hidden="true" />
      <span className="logistics-card-affordance" aria-hidden="true">&rsaquo;</span>
      <div className="logistics-card-top flex items-start justify-between gap-2">
        <div>
          <p className="logistics-eyebrow">
            Accommodation
          </p>
          <h3 className="logistics-card-title">
            {booking.title}
          </h3>
        </div>
        {booking.documents?.length > 0 && (
          <Paperclip size={16} style={{ color: 'var(--gold)' }} aria-label="Documents attached" />
        )}
      </div>

      <div className="logistics-card-rows">
        <Row label="CHECK-IN" value={checkInStr} last={lastIndex === 0} />
        <Row label="CHECK-OUT" value={checkOutDisplay} last={lastIndex === 1} />
        <Row label="BOOKED VIA" value={booking.bookingSource} last={lastIndex === 2} />
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
