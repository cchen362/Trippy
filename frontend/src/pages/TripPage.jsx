import { useEffect, useState } from 'react';
import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Users } from 'lucide-react';
import AdminSettingsPanel from '../components/admin/AdminSettingsPanel.jsx';
import LoadingScreen from '../components/common/LoadingScreen.jsx';
import BottomNav from '../components/nav/BottomNav.jsx';
import TopBar from '../components/nav/TopBar.jsx';
import CopilotFab from '../components/copilot/CopilotFab.jsx';
import CopilotPanel from '../components/copilot/CopilotPanel.jsx';
import TripShareModal from '../components/collaboration/TripShareModal.jsx';
import { useBookings } from '../hooks/useBookings.js';
import { useCopilot } from '../hooks/useCopilot.js';
import { useStops } from '../hooks/useStops.js';
import { useTrip } from '../hooks/useTrip.js';
import { discoveryApi } from '../services/discoveryApi.js';

export function useTripContext() {
  return useOutletContext();
}

export default function TripPage() {
  const { tripId } = useParams();
  const tripState = useTrip(tripId);
  const stopActions = useStops({ onChanged: tripState.refresh });
  const bookingActions = useBookings({ tripId, onChanged: tripState.refresh });
  const copilotState = useCopilot(tripId);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    if (tripId) window.localStorage.setItem('trippy:lastTripId', tripId);
  }, [tripId]);

  // Pre-warm the discovery cache as soon as the trip loads so the panel opens instantly.
  // Fire-and-forget — if the cache is already fresh the server returns immediately at no cost.
  useEffect(() => {
    if (!tripState.trip || tripState.loading) return;
    const destination =
      tripState.days[0]?.resolvedCity ??
      tripState.days[0]?.city ??
      tripState.trip.destinations?.[0];
    if (!destination) return;
    discoveryApi.discover(tripState.trip.id, destination, tripState.trip.interestTags ?? [], () => {}).catch(() => {});
  }, [tripState.trip?.id]);

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
      <TopBar
        title={tripState.trip.title}
        actions={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
              style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)', background: 'rgba(255,255,255,0.02)' }}
              aria-label="Open people and share settings"
              title="People and share"
            >
              <Users size={18} />
            </button>
            <AdminSettingsPanel />
          </div>
        )}
      />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        <Outlet context={{ ...tripState, ...stopActions, ...bookingActions }} />
      </main>
      {!copilotOpen && <CopilotFab onClick={() => setCopilotOpen(true)} />}
      <AnimatePresence>
        {shareOpen && (
          <TripShareModal
            tripId={tripId}
            onClose={() => setShareOpen(false)}
          />
        )}
        {copilotOpen && (
          <CopilotPanel
            copilot={copilotState}
            days={tripState.days}
            onClose={() => setCopilotOpen(false)}
            onMutationApplied={() => tripState.refresh()}
          />
        )}
      </AnimatePresence>
      <BottomNav tripId={tripId} />
    </div>
  );
}
