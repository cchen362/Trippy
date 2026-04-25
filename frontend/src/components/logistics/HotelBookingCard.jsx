import { formatShortDate, computeNights } from './bookingCardUtils.js';

function Row({ label, value, valueStyle, last }) {
  if (!value) return null;
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3 ${last ? '' : 'hairline-row'}`}
    >
      <span className="font-mono text-[11px] tracking-[0.22em] uppercase flex-shrink-0" style={{ color: 'var(--cream-mute)' }}>
        {label}
      </span>
      <span className="font-mono text-[13px] tracking-[0.1em] text-right" style={valueStyle || { color: 'var(--cream)' }}>
        {value}
      </span>
    </div>
  );
}

export default function HotelBookingCard({ booking, onOpen }) {
  const nights = computeNights(booking.startDatetime, booking.endDatetime);
  const checkInStr = formatShortDate(booking.startDatetime);
  const checkOutStr = formatShortDate(booking.endDatetime);
  const checkOutDisplay = checkOutStr
    ? `${checkOutStr}${nights > 0 ? ` · ${nights} ${nights === 1 ? 'night' : 'nights'}` : ''}`
    : null;

  // Determine the last visible row for border-bottom removal.
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
      className="w-full text-left rounded-xl border overflow-hidden focus-visible:ring-2 focus-visible:ring-[var(--gold-line)]"
      style={{ borderColor: 'var(--ink-border)' }}
    >
      {/* HERO ZONE — label + hotel name; glow anchored to this section */}
      <div className="px-5 pt-5 pb-5 relative" style={{ background: 'var(--ink-surface)' }}>
        <div className="hotel-glow" />
        <p className="font-mono text-[11px] tracking-[0.26em] uppercase mb-3" style={{ color: 'var(--gold)' }}>
          Accommodation
        </p>
        <h3 className="font-display italic text-2xl sm:text-3xl leading-tight" style={{ color: 'var(--cream)' }}>
          {booking.title}
        </h3>
      </div>

      {/* DATA ZONE — rows */}
      <div className="px-5 pb-4" style={{ background: 'var(--ink-mid)' }}>
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
