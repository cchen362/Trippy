import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import DayHeader from '../components/timeline/DayHeader.jsx';
import DayTabs from '../components/timeline/DayTabs.jsx';
import Timeline from '../components/timeline/Timeline.jsx';
import DiscoveryPanel from '../components/discovery/DiscoveryPanel.jsx';
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
  } = useTripContext();

  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  const handleReorder = async (orderedStopIds) => {
    if (!activeDay || orderedStopIds.length === 0) return;
    await reorderStops(activeDay.id, orderedStopIds);
  };

  return (
    <div className="space-y-6">
      <DayTabs days={days} activeDayId={activeDayId} onSelect={setActiveDayId} />

      {/* Discover button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
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
          }}
        >
          DISCOVER
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeDayId || 'no-day'}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
          className="space-y-6"
        >
          <DayHeader day={activeDay} dayNumber={days.findIndex((day) => day.id === activeDayId) + 1} />
          <Timeline day={activeDay} onReorder={handleReorder} saving={saving} />
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {discoveryOpen && (
          <DiscoveryPanel
            trip={trip}
            days={days}
            activeDay={activeDay}
            onAddStop={createStop}
            onClose={() => setDiscoveryOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
