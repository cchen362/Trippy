import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import LoadingScreen from '../components/common/LoadingScreen.jsx';
import BottomNav from '../components/nav/BottomNav.jsx';
import TopBar from '../components/nav/TopBar.jsx';
import { useBookings } from '../hooks/useBookings.js';
import { useStops } from '../hooks/useStops.js';
import { useTrip } from '../hooks/useTrip.js';

export function useTripContext() {
  return useOutletContext();
}

export default function TripPage() {
  const { tripId } = useParams();
  const tripState = useTrip(tripId);
  const stopActions = useStops({ onChanged: tripState.refresh });
  const bookingActions = useBookings({ tripId, onChanged: tripState.refresh });

  if (tripState.loading) {
    return <LoadingScreen label="Loading itinerary..." />;
  }

  if (tripState.error || !tripState.trip) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center" style={{ background: 'var(--ink-deep)' }}>
        <div>
          <p className="font-mono text-xs tracking-[0.28em] uppercase mb-3" style={{ color: '#e05a5a' }}>Trip Unavailable</p>
          <p className="font-body text-xl" style={{ color: 'var(--cream-dim)' }}>
            {tripState.error?.message || 'We could not load this trip.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--ink-deep)' }}>
      <TopBar title={tripState.trip.title} />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        <Outlet context={{ ...tripState, ...stopActions, ...bookingActions }} />
      </main>
      <BottomNav tripId={tripId} />
    </div>
  );
}
