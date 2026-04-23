import { useTripContext } from './TripPage.jsx';
import { useMapConfig } from '../hooks/useMapConfig.js';
import DayTabs from '../components/timeline/DayTabs.jsx';
import TripMap from '../components/map/TripMap.jsx';

export default function MapTab() {
  const { trip, days, activeDay, activeDayId, setActiveDayId } = useTripContext();
  const { mapConfig, loading: configLoading } = useMapConfig(trip?.id);

  const stops = activeDay?.stops ?? [];

  if (configLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0b09' }}>
        <DayTabs days={days} activeDayId={activeDayId} onSelect={setActiveDayId} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(240,234,216,0.6)', fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
          Loading map…
        </div>
      </div>
    );
  }

  const pinnedStops = stops.filter(s => s.lat && s.lng);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0b09' }}>
      <DayTabs days={days} activeDayId={activeDayId} onSelect={setActiveDayId} />
      <div style={{ flex: 1, position: 'relative' }}>
        {mapConfig ? (
          <TripMap stops={stops} mapConfig={mapConfig} />
        ) : null}
        {!configLoading && pinnedStops.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', pointerEvents: 'none', zIndex: 1000
          }}>
            <div style={{
              background: 'rgba(28,26,23,0.92)', borderRadius: 12,
              padding: '16px 24px', border: '1px solid rgba(255,255,255,0.07)',
              fontFamily: "'DM Mono', monospace", fontSize: 12,
              color: 'rgba(240,234,216,0.6)', textAlign: 'center'
            }}>
              No pinned stops for this day
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
