import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus } from 'lucide-react';
import AddPlaceModal from '../components/timeline/AddPlaceModal.jsx';
import DayHeader from '../components/timeline/DayHeader.jsx';
import DayTabs from '../components/timeline/DayTabs.jsx';
import Timeline from '../components/timeline/Timeline.jsx';
import DiscoveryPanel from '../components/discovery/DiscoveryPanel.jsx';
import { tripsApi } from '../services/tripsApi.js';
import { bookingsApi } from '../services/bookingsApi.js';
import { useTripContext } from './TripPage.jsx';

export default function PlanTab() {
  const {
    trip,
    days,
    activeDay,
    activeDayId,
    setActiveDayId,
    reorderStops,
    createStop,
    saving,
    deleteStop,
    updateStop,
    discovery,
    refresh,
    reportError,
    openCopilot,
  } = useTripContext();

  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [addPlaceOpen, setAddPlaceOpen] = useState(false);

  const handleReorder = async (orderedStopIds) => {
    if (!activeDay || orderedStopIds.length === 0) return;
    try {
      await reorderStops(activeDay.id, orderedStopIds);
    } catch {
      // reorderStops already recorded the failure on useStops.error (surfaced by
      // TripPage's shared banner). The optimistic order in Timeline's local state
      // never made it to the server, so refetch to re-sync `day.stops` with truth.
      await refresh();
    }
  };

  // A failed move leaves the stop on its original day (no optimistic client
  // move to roll back) — surface it explicitly via the shared error banner
  // rather than swallowing it, so a Slow-3G drop doesn't look like a no-op.
  const handleMove = (stopId, targetDayId) => updateStop(stopId, { dayId: targetDayId }).catch((err) => {
    console.error('[stops] move failed:', err);
    reportError(err, 'Could not move that stop.');
  });

  const handleDeleteStop = (stopId) => deleteStop(stopId).catch(() => {});

  const handleAddPlace = (data) => createStop(activeDay.id, data);

  const handleCityOverride = async (date, cityOverride) => {
    await tripsApi.patchDayCityOverride(trip.id, date, cityOverride);
    await refresh();
  };

  return (
    <div className="space-y-6">
      <DayTabs days={days} activeDayId={activeDayId} onSelect={setActiveDayId} />

      {/* Discover button with pulsing dot when loading in background */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setAddPlaceOpen(true)}
          disabled={!activeDay}
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--gold)',
            border: '1px solid rgba(201,168,76,0.4)',
            borderRadius: '999px',
            padding: '5px 14px',
            background: 'transparent',
            cursor: activeDay ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            opacity: activeDay ? 1 : 0.45,
          }}
        >
          <Plus size={13} />
          ADD PLACE
        </button>
        <button
          type="button"
          onClick={() => setDiscoveryOpen(true)}
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--gold)',
            border: '1px solid rgba(201,168,76,0.4)',
            borderRadius: '999px',
            padding: '5px 14px',
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
          }}
        >
          DISCOVER
          {discovery?.isAnyLoading && (
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--gold)',
                display: 'inline-block',
                animation: 'trippyPulse 1.4s ease-in-out infinite',
              }}
            />
          )}
        </button>
      </div>

      {/* Must NOT be wrapped in AnimatePresence: a stop card unmounting inside
          Timeline (on move/remove) is a descendant unmount beneath this keyed
          panel, which corrupts framer-motion's presence tracking and makes
          mode="wait" freeze the next day-tab switch on the exit animation. */}
      <motion.div
        key={activeDayId || 'no-day'}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="space-y-6"
      >
        <DayHeader
          day={activeDay}
          dayNumber={days.findIndex((day) => day.id === activeDayId) + 1}
          onCityOverride={handleCityOverride}
        />
        <Timeline day={activeDay} onReorder={handleReorder} saving={saving} onDelete={handleDeleteStop} onUpdate={updateStop} days={days} onMove={handleMove} onOpenCopilot={openCopilot} />
      </motion.div>

      <AnimatePresence>
        {discoveryOpen && (
          <DiscoveryPanel
            trip={trip}
            days={days}
            activeDay={activeDay}
            onAddStop={createStop}
            onClose={() => setDiscoveryOpen(false)}
            discovery={discovery}
            onOpenCopilot={openCopilot}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {addPlaceOpen && (
          <AddPlaceModal
            open={addPlaceOpen}
            day={activeDay}
            saving={saving}
            onClose={() => setAddPlaceOpen(false)}
            onSubmit={handleAddPlace}
            lookupPlaces={bookingsApi.lookupPlaces}
            lookupPlaceDetails={bookingsApi.lookupHotelDetails}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
