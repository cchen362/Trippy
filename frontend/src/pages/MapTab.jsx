import { useEffect, useMemo, useState } from 'react';
import { useTripContext } from './TripPage.jsx';
import { useMapData } from '../hooks/useMapData.js';
import DayTabs from '../components/timeline/DayTabs.jsx';
import MapSequencePanel from '../components/map/MapSequencePanel.jsx';
import TripMap from '../components/map/TripMap.jsx';

// TopBar ~56px + BottomNav ~64px + DayTabs ~52px + main vertical padding ~48px = ~220px
const MAP_HEIGHT = 'calc(100vh - 220px)';

const chipBaseStyle = {
  borderRadius: 999,
  padding: '8px 12px',
  fontFamily: "'DM Mono', monospace",
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function MapTab() {
  const { trip, days, bookings, activeDayId, setActiveDayId, updateStop, saving } = useTripContext();
  const [focusedSegmentId, setFocusedSegmentId] = useState('all');
  const [correctionStop, setCorrectionStop] = useState(null);
  const [correctionCenter, setCorrectionCenter] = useState(null);
  const mapRefreshKey = JSON.stringify([
    ...days.map((day) => ({
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
    })),
    ...(bookings || []).map((booking) => ({
      id: booking.id,
      type: booking.type,
      startDatetime: booking.startDatetime,
      destination: booking.destination,
      detailsJson: booking.detailsJson,
    })),
  ]);
  const { mapConfig, segments, stops: mapStops, loading: configLoading, error: mapError } = useMapData(trip?.id, mapRefreshKey);

  const stops = mapStops.filter((stop) => stop.dayId === activeDayId);
  const activeSegments = useMemo(
    () => segments.filter((segment) => segment.dayId === activeDayId),
    [segments, activeDayId],
  );
  const pinnedStops = stops.filter((stop) => stop.canRenderMarker);

  useEffect(() => {
    setFocusedSegmentId('all');
    setCorrectionStop(null);
    setCorrectionCenter(null);
  }, [activeDayId]);

  const startCorrection = (stop) => {
    setCorrectionStop(stop);
    setCorrectionCenter(
      Number.isFinite(Number(stop.displayLat)) && Number.isFinite(Number(stop.displayLng))
        ? { lat: Number(stop.displayLat), lng: Number(stop.displayLng) }
        : null,
    );
  };

  const cancelCorrection = () => {
    setCorrectionStop(null);
    setCorrectionCenter(null);
  };

  const saveCorrection = async () => {
    if (!correctionStop || !correctionCenter || !mapConfig) return;
    await updateStop(correctionStop.id, {
      lat: correctionCenter.lat,
      lng: correctionCenter.lng,
      coordinateSystem: mapConfig.coordinateSystem || 'wgs84',
      coordinateSource: 'user_pin',
      locationStatus: 'user_confirmed',
      locationConfidence: 1,
    });
    cancelCorrection();
  };

  const chipStyle = (active) => ({
    ...chipBaseStyle,
    color: active ? 'var(--ink-deep)' : 'var(--cream-dim)',
    background: active ? 'var(--gold)' : 'rgba(13,11,9,0.78)',
    border: active ? '1px solid rgba(13,11,9,0.6)' : '1px solid rgba(240,234,216,0.16)',
  });

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
            Loading map...
          </div>
        )}
        {mapError && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--ink-deep)',
            color: '#e05a5a',
            fontFamily: "'DM Mono', monospace",
            fontSize: 12,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            textAlign: 'center',
            padding: 24,
            zIndex: 10,
          }}>
            Map data failed to load: {mapError.message}
          </div>
        )}
        {mapConfig && (
          <TripMap
            stops={stops}
            mapConfig={mapConfig}
            focusedSegmentId={focusedSegmentId}
            correctionStop={correctionStop}
            onMapCenterChange={setCorrectionCenter}
            onStartCorrection={startCorrection}
          />
        )}
        {correctionStop && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -100%)',
              zIndex: 925,
              pointerEvents: 'none',
              display: 'grid',
              justifyItems: 'center',
            }}
          >
            <div style={{
              width: 34,
              height: 34,
              borderRadius: '50% 50% 50% 0',
              transform: 'rotate(-45deg)',
              background: 'var(--gold)',
              border: '2px solid #0d0b09',
              boxShadow: '0 12px 28px rgba(0,0,0,0.42)',
            }}>
              <div style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#0d0b09',
                margin: 9,
              }} />
            </div>
            <div style={{
              width: 42,
              height: 12,
              marginTop: -1,
              borderRadius: '50%',
              background: 'rgba(13,11,9,0.32)',
              filter: 'blur(2px)',
            }} />
          </div>
        )}
        {!configLoading && mapConfig && activeSegments.length > 0 && (
          <div
            style={{
              position: 'absolute',
              left: 12,
              top: 12,
              zIndex: 920,
              display: 'flex',
              gap: 8,
              maxWidth: 'calc(100% - 24px)',
              overflowX: 'auto',
              paddingBottom: 2,
            }}
          >
            <button
              type="button"
              onClick={() => setFocusedSegmentId('all')}
              style={chipStyle(focusedSegmentId === 'all')}
            >
              Full day
            </button>
            {activeSegments.map((segment) => (
              <button
                key={segment.id}
                type="button"
                onClick={() => setFocusedSegmentId(segment.id)}
                style={chipStyle(focusedSegmentId === segment.id)}
              >
                {segment.label}
              </button>
            ))}
          </div>
        )}
        {!configLoading && mapConfig && !correctionStop && (
          <MapSequencePanel
            stops={stops}
            focusedSegmentId={focusedSegmentId}
            onPlaceStop={startCorrection}
          />
        )}
        {correctionStop && (
          <div
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: 12,
              zIndex: 930,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: 12,
              border: '1px solid rgba(201,168,76,0.32)',
              borderRadius: 8,
              background: 'rgba(13,11,9,0.9)',
              boxShadow: '0 18px 44px rgba(0,0,0,0.36)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <p style={{
                margin: 0,
                color: 'var(--gold)',
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
              }}>
                Set pin location
              </p>
              <p style={{
                margin: '3px 0 0',
                color: 'var(--cream)',
                fontFamily: "'Playfair Display', serif",
                fontSize: 16,
                fontStyle: 'italic',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {correctionStop.title}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                onClick={cancelCorrection}
                style={{
                  ...chipBaseStyle,
                  color: 'rgba(240,234,216,0.62)',
                  background: 'transparent',
                  border: '1px solid rgba(240,234,216,0.18)',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveCorrection}
                disabled={saving || !correctionCenter}
                style={{
                  ...chipBaseStyle,
                  color: 'var(--ink-deep)',
                  background: 'var(--gold)',
                  border: '1px solid rgba(13,11,9,0.6)',
                  opacity: saving || !correctionCenter ? 0.55 : 1,
                }}
              >
                Set here
              </button>
            </div>
          </div>
        )}
        {!configLoading && mapConfig && pinnedStops.length === 0 && stops.length === 0 && !correctionStop && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', pointerEvents: 'none', zIndex: 1000
          }}>
            <div style={{
              background: 'rgba(28,26,23,0.92)', borderRadius: 8,
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
