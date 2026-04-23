export default function BookingCard({ booking, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(booking)}
      className="w-full text-left rounded-2xl border p-4 sm:p-5"
      style={{ background: 'var(--ink-surface)', borderColor: 'var(--ink-border)' }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.24em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
            {booking.type}
          </p>
          <h3 className="font-display italic text-2xl" style={{ color: 'var(--cream)' }}>
            {booking.title}
          </h3>
        </div>
        {booking.confirmationRef && (
          <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--gold)' }}>
            {booking.confirmationRef}
          </span>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        {booking.startDatetime && <span className="pill">{booking.startDatetime.replace('T', ' ')}</span>}
        {booking.bookingSource && <span className="pill">{booking.bookingSource}</span>}
        {booking.origin && booking.destination && <span className="pill">{booking.origin} → {booking.destination}</span>}
      </div>
    </button>
  );
}
