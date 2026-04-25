import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import LoadingScreen from '../components/common/LoadingScreen.jsx';
import { tripsApi } from '../services/tripsApi.js';

function formatDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function StopPreview({ stop, index }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.045 }}
      className="relative overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--ink-border)', background: 'var(--ink-mid)' }}
    >
      {stop.unsplashPhotoUrl && (
        <div
          className="h-36 bg-cover bg-center"
          style={{ backgroundImage: `linear-gradient(180deg, rgba(13,11,9,0.05), rgba(13,11,9,0.82)), url(${stop.unsplashPhotoUrl})` }}
        />
      )}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--gold)' }}>
            {stop.time || 'Flexible'}
          </p>
          <span className="pill">{stop.type}</span>
        </div>
        <h3 className="font-display italic text-2xl mb-2" style={{ color: 'var(--cream)' }}>
          {stop.title}
        </h3>
        {stop.note && (
          <p className="font-body text-lg leading-relaxed" style={{ color: 'var(--cream-dim)' }}>
            {stop.note}
          </p>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          {stop.duration && <span className="pill">{stop.duration}</span>}
          {stop.bestTime && <span className="pill">{stop.bestTime}</span>}
          {stop.estimatedCost && <span className="pill">{stop.estimatedCost}</span>}
        </div>
      </div>
    </motion.article>
  );
}

export default function ShareViewPage() {
  const { token } = useParams();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tripsApi.sharedDetail(token)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Share link unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <LoadingScreen label="Opening shared itinerary..." />;

  if (error || !detail?.trip) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center" style={{ background: 'var(--ink-deep)' }}>
        <div>
          <p className="font-mono text-xs tracking-[0.28em] uppercase mb-3" style={{ color: '#e05a5a' }}>Share Unavailable</p>
          <p className="font-body text-xl" style={{ color: 'var(--cream-dim)' }}>
            {error || 'This shared itinerary could not be loaded.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--ink-deep)' }}>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <header className="pb-8 sm:pb-10 border-b" style={{ borderColor: 'var(--ink-border)' }}>
          <p className="font-mono text-[11px] tracking-[0.32em] uppercase mb-3" style={{ color: 'var(--gold)' }}>
            Shared itinerary
          </p>
          <h1 className="font-display italic text-5xl sm:text-6xl mb-4" style={{ color: 'var(--cream)' }}>
            {detail.trip.title}
          </h1>
          <p className="font-body text-xl" style={{ color: 'var(--cream-dim)' }}>
            {detail.trip.startDate} to {detail.trip.endDate}
          </p>
        </header>

        <div className="space-y-10 py-8">
          {detail.days.map((day, dayIndex) => (
            <section key={day.id}>
              <div className="mb-4">
                <p className="font-mono text-[11px] tracking-[0.28em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>
                  Day {dayIndex + 1} / {formatDate(day.date)}
                </p>
                <h2 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
                  {day.city || day.theme || 'Open day'}
                </h2>
              </div>
              <div className="grid gap-4">
                {day.stops.length > 0 ? (
                  day.stops.map((stop, stopIndex) => (
                    <StopPreview key={stop.id} stop={stop} index={stopIndex} />
                  ))
                ) : (
                  <p className="font-mono text-[11px] tracking-[0.2em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                    No stops scheduled
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
