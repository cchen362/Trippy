import { Link } from 'react-router-dom';
import { tripIsLive } from '../../utils/tripStatus.js';
import { formatCountdown } from '../../utils/date.js';
import TripRouteCover, { hasLocatedGeo } from './TripRouteCover.jsx';

function formatDateRange(startDate, endDate) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${formatter.format(new Date(`${startDate}T00:00:00`))} - ${formatter.format(new Date(`${endDate}T00:00:00`))}`;
}

export default function TripCard({ trip }) {
  const hasRoute = hasLocatedGeo(trip.destinationsGeo);

  return (
    <Link
      to={`/trips/${trip.id}/${tripIsLive(trip) ? 'today' : 'plan'}`}
      className="block relative overflow-hidden transition-transform duration-300 hover:-translate-y-1 min-h-[236px] sm:min-h-[264px]"
      style={{
        borderRadius: 'var(--radius-l)',
        border: '1px solid',
        borderColor: trip.status === 'active' ? 'var(--gold-line)' : 'var(--ink-border-strong)',
        background: 'var(--ink-satin)',
        boxShadow: 'var(--shadow-deep)',
        opacity: trip.status === 'past' ? 0.72 : 1,
      }}
    >
      <TripRouteCover destinationsGeo={trip.destinationsGeo} status={trip.status} />

      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(96deg, rgba(13,11,9,0.94) 0%, rgba(13,11,9,0.52) 46%, rgba(13,11,9,0.06) 100%)',
        }}
      />

      <div
        className="relative grid min-h-[236px] sm:min-h-[264px]"
        style={{
          gridTemplateRows: 'auto 1fr auto',
          padding: '22px 24px',
        }}
      >
        <div style={{ minHeight: 30 }}>
          {trip.status === 'active' && (
            <div className="inline-flex items-center gap-2">
              <span className="trip-live-dot" style={{ background: 'var(--gold)' }} />
              <span className="font-mono text-[10px] tracking-[0.24em] uppercase" style={{ color: 'var(--cream)' }}>
                Active now
              </span>
            </div>
          )}
          {trip.status === 'upcoming' && (
            <span className="font-mono text-[10px] tracking-[0.24em] uppercase" style={{ color: 'var(--cream-dim)' }}>
              {formatCountdown(trip.startDate)}
            </span>
          )}
        </div>
        <div />
        <div style={{ alignSelf: 'end', maxWidth: '92%' }}>
          {!hasRoute && (
            <div style={{ width: 46, height: 1, marginBottom: 14, background: 'var(--gold-line)' }} />
          )}
          <p className="font-mono text-[10px] tracking-[0.24em] uppercase mb-3" style={{ color: 'var(--cream-dim)' }}>
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
    </Link>
  );
}
