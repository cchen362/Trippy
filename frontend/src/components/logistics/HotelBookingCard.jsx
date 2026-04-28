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
      className="logistics-card w-full text-left focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]"
    >
      <div className="logistics-card-top">
        <p className="logistics-eyebrow">
          Accommodation
        </p>
        <h3 className="logistics-card-title">
          {booking.title}
        </h3>
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
