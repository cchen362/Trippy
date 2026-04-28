import { useTripContext } from './TripPage.jsx';
import { useMapData } from '../hooks/useMapData.js';
import DayTabs from '../components/timeline/DayTabs.jsx';
import TripMap from '../components/map/TripMap.jsx';

// TopBar ~56px + BottomNav ~64px + DayTabs ~52px + main vertical padding ~48px = ~220px
const MAP_HEIGHT = 'calc(100vh - 220px)';

export default function MapTab() {
  const { trip, days, activeDayId, setActiveDayId } = useTripContext();
  const mapRefreshKey = JSON.stringify(days.map((day) => ({
    id: day.id,
    stops: (day.stops || []).map((stop) => [
      stop.id,
      stop.time,
      stop.sortOrder,
      stop.lat,
      stop.lng,
      stop.locationStatus,
      stop.coordinateSystem,
    ]),
  })));
  const { mapConfig, stops: mapStops, loading: configLoading } = useMapData(trip?.id, mapRefreshKey);

  const stops = mapStops.filter((stop) => stop.dayId === activeDayId);
  const pinnedStops = stops.filter((stop) => stop.canRenderMarker);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--ink-deep)' }}>
      <DayTabs days={days} activeDayId={activeDayId} onSelect={setActiveDayId} />
      <div style={{ position: 'relative', height: MAP_HEIGHT, minHeight: 300 }}>
        {configLoading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', background: 'var(--ink-deep)',
            color: 'rgba(240,234,216,0.6)', fontFamily: "'DM Mono', monospace", fontSize: 12, zIndex: 10
          }}>
            Loading map…
          </div>
        )}
        {mapConfig && <TripMap stops={stops} mapConfig={mapConfig} />}
        {!configLoading && mapConfig && pinnedStops.length === 0 && (
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
