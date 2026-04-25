import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminSettingsPanel from '../components/admin/AdminSettingsPanel.jsx';
import LoadingScreen from '../components/common/LoadingScreen.jsx';
import BottomNav from '../components/nav/BottomNav.jsx';
import NewTripModal from '../components/trips/NewTripModal.jsx';
import TripCard from '../components/trips/TripCard.jsx';
import { tripsApi } from '../services/tripsApi.js';

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
      const response = await tripsApi.list();
      setTrips(response.trips || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTrips();
  }, []);

  useEffect(() => {
    if (loading || !isStandalonePwa()) return;
    const lastTripId = window.localStorage.getItem('trippy:lastTripId');
    if (lastTripId && trips.some((trip) => trip.id === lastTripId)) {
      navigate(`/trips/${lastTripId}/plan`, { replace: true });
    }
  }, [loading, navigate, trips]);

  const grouped = useMemo(() => groupTrips(trips), [trips]);

  const handleCreateTrip = async (payload) => {
    setSaving(true);
    try {
      const created = await tripsApi.create(payload);
      setOpen(false);
      await loadTrips();
      navigate(`/trips/${created.trip.id}/plan`);
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
            </div>
            <AdminSettingsPanel />
          </div>
        </section>

        {error && <p className="font-mono text-xs mb-6" style={{ color: '#e05a5a' }}>{error}</p>}

        {['active', 'upcoming', 'past'].map((section, sectionIndex) => (
          grouped[section].length > 0 && (
            <section key={section} className="mb-10">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-mono text-[11px] tracking-[0.3em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                  {section}
                </h2>
                <span className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
                  {grouped[section].length}
                </span>
              </div>
              <div className="grid lg:grid-cols-2 gap-5">
                {grouped[section].map((trip, index) => (
                  <motion.div key={trip.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: (sectionIndex * 0.08) + (index * 0.05) }}>
                    <TripCard trip={trip} />
                  </motion.div>
                ))}
              </div>
            </section>
          )
        ))}

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full sm:w-auto px-6 py-4 rounded-2xl border font-mono text-xs tracking-[0.28em] uppercase"
          style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)', background: 'var(--gold-soft)' }}
        >
          + New Trip
        </button>
      </main>

      <BottomNav />
      <NewTripModal open={open} onClose={() => setOpen(false)} onSubmit={handleCreateTrip} saving={saving} />
    </div>
  );
}
