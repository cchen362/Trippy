import { Link } from 'react-router-dom';

function formatDateRange(startDate, endDate) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${formatter.format(new Date(`${startDate}T00:00:00`))} - ${formatter.format(new Date(`${endDate}T00:00:00`))}`;
}

const STATUS_COPY = {
  active: 'Active',
  upcoming: 'Upcoming',
  past: 'Past',
};

export default function TripCard({ trip }) {
  const photo = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80';

  return (
    <Link
      to={`/trips/${trip.id}/plan`}
      className="block rounded-2xl overflow-hidden border transition-transform duration-300 hover:-translate-y-1"
      style={{
        borderColor: trip.status === 'active' ? 'var(--gold-line)' : 'var(--ink-border)',
        background: 'var(--ink-surface)',
      }}
    >
      <div className="relative min-h-[220px] sm:min-h-[260px]">
        <img src={photo} alt="" className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0 trip-card-overlay" />
        <div className="relative h-full p-5 sm:p-6 flex flex-col justify-between">
          <div className="flex items-start justify-between gap-3">
            <span
              className="font-mono text-[10px] tracking-[0.28em] uppercase px-3 py-2 rounded-full border"
              style={{
                color: trip.status === 'active' ? 'var(--gold)' : 'var(--cream)',
                borderColor: trip.status === 'active' ? 'var(--gold-line)' : 'rgba(240,234,216,0.18)',
                background: trip.status === 'active' ? 'var(--gold-soft)' : 'rgba(13,11,9,0.24)',
              }}
            >
              {STATUS_COPY[trip.status] || trip.status}
            </span>
            {trip.status === 'active' && (
              <span className="font-mono text-[10px] tracking-[0.28em] uppercase" style={{ color: 'var(--gold)' }}>
                Active Now
              </span>
            )}
          </div>

          <div>
            <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-3" style={{ color: 'var(--cream-dim)' }}>
              {(trip.destinations || []).join(' · ') || 'Trip'}
            </p>
            <h2 className="font-display italic text-3xl sm:text-4xl mb-3" style={{ color: 'var(--cream)' }}>
              {trip.title}
            </h2>
            <p className="font-mono text-xs tracking-[0.18em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              {formatDateRange(trip.startDate, trip.endDate)}
            </p>
          </div>
        </div>
      </div>
    </Link>
  );
}
