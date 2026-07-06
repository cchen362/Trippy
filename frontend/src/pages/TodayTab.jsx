import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTripContext } from './TripPage.jsx';
import { useMapData } from '../hooks/useMapData.js';
import { computeToday } from '../utils/todayModel.js';
import { localIso } from '../utils/date.js';
import HeroCard from '../components/today/HeroCard.jsx';
import UpcomingRow from '../components/today/UpcomingRow.jsx';
import TonightCard from '../components/today/TonightCard.jsx';
import CollapsedRow from '../components/today/CollapsedRow.jsx';

export default function TodayTab() {
  const { trip, days, bookings, live } = useTripContext();
  const { mapConfig, mapConfigByDay } = useMapData(trip?.id);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const model = useMemo(() => computeToday(days, bookings, now), [days, bookings, now]);

  if (!live) return <Navigate to="../plan" replace />;

  const todayIso = localIso(now);
  const todayDay = days.find((d) => d.date === todayIso);
  const todayMapConfig = mapConfigByDay[todayDay?.id] ?? mapConfig;
  const dayIndex = todayDay ? todayDay.dayIndex : null;
  const cityLabel = todayDay?.resolvedCity || todayDay?.city || trip.destinations?.[0] || '';
  const weekday = new Date(`${todayIso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });

  const tonightStop = model.tonight
    ? days.flatMap((d) => d.stops).find((s) => s.bookingId === model.tonight.id) || null
    : null;

  return (
    <div className="max-w-xl mx-auto pb-24">
      <div className="mb-5">
        <p className="font-mono text-[11px] tracking-[0.28em] uppercase" style={{ color: 'var(--cream-mute)' }}>
          {weekday}{dayIndex != null ? ` · Day ${dayIndex + 1} of ${days.length}` : ''}
        </p>
        {cityLabel && (
          <p className="font-display italic text-2xl" style={{ color: 'var(--cream)' }}>
            {cityLabel}
          </p>
        )}
      </div>

      <CollapsedRow items={model.collapsed} deepLinkProvider={todayMapConfig?.deepLinkProvider} mapConfig={todayMapConfig} />

      {model.hero ? (
        <div className="mb-5">
          <HeroCard item={model.hero} deepLinkProvider={todayMapConfig?.deepLinkProvider} mapConfig={todayMapConfig} />
        </div>
      ) : (
        <p className="font-body italic text-lg mb-5" style={{ color: 'var(--cream-dim)' }}>
          Free day — nothing on the clock.
        </p>
      )}

      {model.upcoming.length > 0 && (
        <div className="mb-5">
          {model.upcoming.map((item) => (
            <UpcomingRow key={`${item.kind}-${item.id}`} item={item} deepLinkProvider={todayMapConfig?.deepLinkProvider} mapConfig={todayMapConfig} />
          ))}
        </div>
      )}

      {/* When the hotel itself is the hero (no other anchors left today), the
          hero card already covers it — avoid rendering the same booking twice. */}
      {model.tonight && model.hero?.kind !== 'hotel' && (
        <TonightCard booking={model.tonight} stop={tonightStop} deepLinkProvider={todayMapConfig?.deepLinkProvider} mapConfig={todayMapConfig} />
      )}

      {model.tomorrowFirst && (
        <p className="font-body italic text-sm mt-4" style={{ color: 'var(--cream-mute)' }}>
          Tomorrow starts at {model.tomorrowFirst.time} — {model.tomorrowFirst.title}
        </p>
      )}
    </div>
  );
}
