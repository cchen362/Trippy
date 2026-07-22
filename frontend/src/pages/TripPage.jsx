import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Edit2, Users, Wallet } from 'lucide-react';
import AdminSettingsPanel from '../components/admin/AdminSettingsPanel.jsx';
import ErrorBanner from '../components/common/ErrorBanner.jsx';
import LoadingScreen from '../components/common/LoadingScreen.jsx';
import BottomNav from '../components/nav/BottomNav.jsx';
import TopBar from '../components/nav/TopBar.jsx';
import CopilotFab from '../components/copilot/CopilotFab.jsx';
import CopilotPanel from '../components/copilot/CopilotPanel.jsx';
import TripShareModal from '../components/collaboration/TripShareModal.jsx';
import EditTripModal from '../components/trips/EditTripModal.jsx';
import { useBookings } from '../hooks/useBookings.js';
import { useCopilot } from '../hooks/useCopilot.js';
import { useDiscovery } from '../hooks/useDiscovery.js';
import { useStops } from '../hooks/useStops.js';
import { useTrip } from '../hooks/useTrip.js';
import { bookingsApi } from '../services/bookingsApi.js';
import { tripsApi } from '../services/tripsApi.js';
import { tripIsLive } from '../utils/tripStatus.js';
import { contextForRoute } from '../utils/copilotContext.js';

export function useTripContext() {
  return useOutletContext();
}

export default function TripPage() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isExpensesRoute = location.pathname.endsWith('/expenses');
  const tripState = useTrip(tripId);
  const [pageError, setPageError] = useState(null);
  const reportError = useCallback((err, fallback) => setPageError(err?.message || fallback), []);
  // D3 CONTRACT: useStops opts into the shared page banner via onError; useBookings does NOT.
  // Four stop call sites depend on this banner surfacing their failures — do not remove onError
  // without re-homing them: PlanTab.handleReorder, PlanTab.handleDeleteStop,
  // StopCard.handleNoteBlur, TransitStop.handleNoteBlur.
  const stopActions = useStops({ onChanged: tripState.refresh, onError: reportError });
  const bookingActions = useBookings({ tripId, onChanged: tripState.refresh });
  const copilotState = useCopilot(tripId);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotContext, setCopilotContext] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const discovery = useDiscovery(tripId);

  useEffect(() => {
    if (tripId) window.localStorage.setItem('trippy:lastTripId', tripId);
  }, [tripId]);

  // A banner must not outlive the screen that produced it (D4). Every current producer
  // leaves the user on its originating tab, so clearing on pathname change is safe.
  useEffect(() => {
    setPageError(null);
  }, [location.pathname]);

  const openCopilot = (context) => {
    setCopilotContext(context ? { ...context } : null);
    setCopilotOpen(true);
  };

  // Pre-warm discovery as soon as trip loads — state lives here so it survives tab navigation.
  useEffect(() => {
    if (!tripState.trip || tripState.loading) return;
    const destination =
      tripState.days[0]?.resolvedCity ??
      tripState.days[0]?.city ??
      tripState.trip.destinations?.[0];
    if (!destination) return;
    const countryCode =
      tripState.days[0]?.resolvedCountry ??
      tripState.trip.destinationCountries?.[0] ??
      null;
    discovery.discover(destination, countryCode);
  }, [tripState.trip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async () => {
    setDeleting(true);
    setPageError(null);
    try {
      await tripsApi.remove(tripId);
      navigate('/');
    } catch (err) {
      reportError(err, 'Could not delete this trip.');
    } finally {
      setDeleting(false);
    }
  };

  const handleEditSave = async (updates) => {
    setEditSaving(true);
    setPageError(null);
    try {
      await tripsApi.update(tripId, updates);
      await tripState.refresh();
      // If interest tags changed, clear discovery so tabs update on next open
      discovery.reset();
    } catch (err) {
      reportError(err, 'Could not save trip settings.');
    } finally {
      setEditSaving(false);
    }
  };

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

  const isLive = tripIsLive(tripState.trip);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--ink-deep)' }}>
      <TopBar
        title={tripState.trip.title}
        actions={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!isExpensesRoute) {
                  navigate(`/trips/${tripId}/expenses`, { state: { from: location.pathname } });
                  return;
                }
                const from = location.state?.from;
                const target = from && from.startsWith(`/trips/${tripId}`) ? from : `/trips/${tripId}`;
                navigate(target);
              }}
              className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
              style={{ borderColor: 'var(--ink-border)', color: isExpensesRoute ? 'var(--gold)' : 'var(--cream-dim)', background: 'rgba(255,255,255,0.02)' }}
              aria-label={isExpensesRoute ? 'Close trip expenses' : 'Open trip expenses'}
              title="Expenses"
            >
              <Wallet size={18} />
            </button>
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
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
              style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)', background: 'rgba(255,255,255,0.02)' }}
              aria-label="Edit trip settings"
              title="Edit trip"
            >
              <Edit2 size={16} />
            </button>
            <AdminSettingsPanel />
          </div>
        )}
      />
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        <ErrorBanner message={pageError} onDismiss={() => setPageError(null)} className="mb-6" />
        <Outlet context={{ ...tripState, stopActions, bookingActions, discovery, live: isLive, reportError, openCopilot }} />
      </main>
      {!copilotOpen && (
        <CopilotFab
          onClick={() => {
            openCopilot(contextForRoute(location.pathname, tripState.activeDayId));
          }}
        />
      )}
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
            context={copilotContext}
            trip={tripState.trip}
            days={tripState.days}
            bookings={tripState.bookings}
            activeDayId={tripState.activeDayId}
            onClose={() => setCopilotOpen(false)}
            onMutationApplied={() => tripState.refresh()}
            ownerId={tripState.trip.ownerId}
          />
        )}
        {editOpen && (
          <EditTripModal
            trip={tripState.trip}
            days={tripState.days}
            open={editOpen}
            onClose={() => setEditOpen(false)}
            onSubmit={handleEditSave}
            saving={editSaving}
            onDelete={handleDelete}
            deleting={deleting}
            lookupCities={bookingsApi.lookupCities}
          />
        )}
      </AnimatePresence>
      <BottomNav tripId={tripId} live={isLive} />
    </div>
  );
}
