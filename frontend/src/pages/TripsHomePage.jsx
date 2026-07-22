import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminSettingsPanel from '../components/admin/AdminSettingsPanel.jsx';
import LoadingScreen from '../components/common/LoadingScreen.jsx';
import UserAccountButton from '../components/common/UserAccountButton.jsx';
import BottomNav from '../components/nav/BottomNav.jsx';
import NewTripModal from '../components/trips/NewTripModal.jsx';
import TripCard from '../components/trips/TripCard.jsx';
import { tripsApi } from '../services/tripsApi.js';
import { bookingsApi } from '../services/bookingsApi.js';
import { importApi } from '../services/importApi.js';
import { localIso } from '../utils/date.js';

function groupTrips(trips) {
  return {
    active: trips.filter((trip) => trip.status === 'active'),
    upcoming: trips.filter((trip) => trip.status === 'upcoming'),
    past: trips.filter((trip) => trip.status === 'past'),
  };
}

function isStandalonePwa() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
}

export default function TripsHomePage() {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const loadTrips = async () => {
    setLoading(true);
    try {
      const response = await tripsApi.list(localIso());
      setTrips(response.trips || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTrips();
  }, []);

  // Resume-last-trip only applies to a cold app launch in the installed PWA. Without
  // a once-per-session guard, mounting this page from in-app navigation (e.g. TopBar's
  // "← Trips" link) would instantly bounce back to the last trip, making it impossible
  // to reach the trips list, switch trips, or start a new one while the app is running.
  useEffect(() => {
    if (loading || !isStandalonePwa()) return;
    if (window.sessionStorage.getItem('trippy:resumedThisSession')) return;
    const lastTripId = window.localStorage.getItem('trippy:lastTripId');
    if (lastTripId && trips.some((trip) => trip.id === lastTripId)) {
      window.sessionStorage.setItem('trippy:resumedThisSession', '1');
      navigate(`/trips/${lastTripId}/plan`, { replace: true });
    }
  }, [loading, navigate, trips]);

  const grouped = useMemo(() => groupTrips(trips), [trips]);

  const handleCreateTrip = async ({ captureArtifactId, captureBookings, ...tripFields }) => {
    setSaving(true);
    try {
      const created = await tripsApi.create(tripFields);
      setOpen(false);
      await loadTrips();
      if (captureArtifactId) {
        // Trip creation is the point of no return — if confirming the captured
        // bookings fails, the trip still exists (recoverable via Logistics' own
        // capture entry point) rather than risking a duplicate trip on retry.
        let importFailed = false;
        try {
          await importApi.confirm(captureArtifactId, { tripId: created.trip.id, bookings: captureBookings });
        } catch (err) {
          console.error('Failed to import captured bookings into new trip', err);
          importFailed = true;
        }
        navigate(`/trips/${created.trip.id}/logistics`, {
          state: importFailed
            ? { bannerMessage: "We saved your trip but couldn't import the bookings — try Add bookings again." }
            : undefined,
        });
      } else {
        navigate(`/trips/${created.trip.id}/plan`);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <LoadingScreen label="Gathering your trips..." />;
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--ink-deep)' }}>
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 pb-10">
        <section className="pt-8 sm:pt-12 pb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] tracking-[0.32em] uppercase mb-3" style={{ color: 'var(--gold)' }}>
                Trips
              </p>
              <h1 className="font-display italic text-5xl sm:text-6xl mb-3" style={{ color: 'var(--cream)' }}>
                Where next?
              </h1>
              <p className="font-body text-xl max-w-2xl" style={{ color: 'var(--cream-dim)' }}>
                Your journeys, bookings, and day plans stay in one quietly dramatic place.
              </p>
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="w-full sm:w-auto mt-6 px-6 py-4 rounded-2xl border font-mono text-xs tracking-[0.28em] uppercase"
                style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)', background: 'var(--gold-soft)' }}
              >
                + New Trip
              </button>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <UserAccountButton />
              <AdminSettingsPanel />
            </div>
          </div>
        </section>

        {error && <p className="font-mono text-xs mb-6" style={{ color: '#e05a5a' }}>{error}</p>}

        {trips.length === 0 ? (
          <div className="py-16 sm:py-24 flex flex-col items-center gap-4 text-center">
            <h2 className="font-display italic text-4xl sm:text-5xl" style={{ color: 'var(--cream)' }}>
              No journeys yet
            </h2>
            <p className="font-body text-xl" style={{ color: 'var(--cream-dim)' }}>
              Where does it begin?
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-2 px-6 py-4 rounded-2xl border font-mono text-xs tracking-[0.28em] uppercase"
              style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)', background: 'var(--gold-soft)' }}
            >
              + New Trip
            </button>
          </div>
        ) : (
          ['active', 'upcoming', 'past'].map((section, sectionIndex) => (
            grouped[section].length > 0 && (
              <section key={section} className="mb-10">
                <h2 className="font-mono text-[11px] tracking-[0.3em] uppercase mb-4" style={{ color: 'var(--cream-mute)' }}>
                  {section}
                  <span style={{ color: 'var(--cream-dim)' }}> &middot; {grouped[section].length}</span>
                </h2>
                <div className="grid lg:grid-cols-2 gap-5">
                  {grouped[section].map((trip, index) => (
                    <motion.div key={trip.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: (sectionIndex * 0.08) + (index * 0.05) }}>
                      <TripCard trip={trip} />
                    </motion.div>
                  ))}
                </div>
              </section>
            )
          ))
        )}
      </main>

      <BottomNav />
      <NewTripModal
        open={open}
        onClose={() => setOpen(false)}
        onSubmit={handleCreateTrip}
        saving={saving}
        lookupCities={bookingsApi.lookupCities}
      />
    </div>
  );
}
