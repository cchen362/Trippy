import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import StopMarker from './StopMarker.jsx';

function hasDisplayCoordinates(stop) {
  return stop?.canRenderMarker
    && Number.isFinite(Number(stop.displayLat))
    && Number.isFinite(Number(stop.displayLng));
}

function MapBounds({ stops, boundsKey }) {
  const map = useMap();
  useEffect(() => {
    if (stops.length === 0) return;
    const bounds = stops.map(s => [s.displayLat, s.displayLng]);
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [boundsKey, map]);
  return null;
}

function MapCenterReporter({ enabled, onChange }) {
  const map = useMapEvents({
    moveend: () => {
      if (!enabled || !onChange) return;
      const center = map.getCenter();
      onChange({ lat: center.lat, lng: center.lng });
    },
    click: (event) => {
      if (!enabled) return;
      map.panTo(event.latlng);
    },
  });

  useEffect(() => {
    if (!enabled || !onChange) return;
    const center = map.getCenter();
    onChange({ lat: center.lat, lng: center.lng });
  }, [enabled, map, onChange]);

  return null;
}

function CorrectionTargetPan({ stop }) {
  const map = useMap();
  useEffect(() => {
    if (!hasDisplayCoordinates(stop)) return;
    map.panTo([stop.displayLat, stop.displayLng]);
  }, [stop?.id, map]);
  return null;
}

function bearingDegrees(start, end) {
  const [lat1, lng1] = start.map((value) => Number(value) * Math.PI / 180);
  const [lat2, lng2] = end.map((value) => Number(value) * Math.PI / 180);
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function midpoint(start, end) {
  return [
    (Number(start[0]) + Number(end[0])) / 2,
    (Number(start[1]) + Number(end[1])) / 2,
  ];
}

function buildConnectors(stops) {
  const connectors = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const current = stops[index];
    const next = stops[index + 1];

    if (hasDisplayCoordinates(current) && hasDisplayCoordinates(next)) {
      connectors.push({
        id: `${current.id}:${next.id}`,
        from: [current.displayLat, current.displayLng],
        to: [next.displayLat, next.displayLng],
        dashed: current.type === 'transit' || next.type === 'transit',
      });
      continue;
    }

    if (hasDisplayCoordinates(current) && next?.type === 'transit' && !hasDisplayCoordinates(next)) {
      const afterTransit = stops[index + 2];
      if (hasDisplayCoordinates(afterTransit)) {
        connectors.push({
          id: `${current.id}:${next.id}:${afterTransit.id}`,
          from: [current.displayLat, current.displayLng],
          to: [afterTransit.displayLat, afterTransit.displayLng],
          dashed: true,
        });
        index += 1;
      }
    }
  }
  return connectors;
}

function ArrowMarker({ connector }) {
  const center = midpoint(connector.from, connector.to);
  const rotation = bearingDegrees(connector.from, connector.to);
  const arrowColor = connector.dashed ? 'rgba(240,234,216,0.72)' : '#f0ebe3';
  const icon = useMemo(() => L.divIcon({
    className: '',
    html: `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <circle cx="9" cy="9" r="8" fill="#0d0b09" fill-opacity="0.82" stroke="rgba(240,234,216,0.18)" stroke-width="1"/>
      <text x="9" y="13" text-anchor="middle" font-family="DM Mono,monospace" font-size="11" fill="${arrowColor}" transform="rotate(${rotation}, 9, 9)">↑</text>
    </svg>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  }), [connector.dashed, rotation]);

  return (
    <Marker
      position={center}
      icon={icon}
      interactive={false}
      keyboard={false}
    />
  );
}

export default function TripMap({
  stops,
  mapConfig,
  focusedSegmentId = 'all',
  correctionStop = null,
  onMapCenterChange,
  onStartCorrection,
}) {
  const pinnedStops = stops.filter(hasDisplayCoordinates);
  const focusedStops = focusedSegmentId === 'all'
    ? pinnedStops
    : pinnedStops.filter((stop) => stop.routeSegmentId === focusedSegmentId);
  const boundsStops = focusedStops.length > 0 ? focusedStops : pinnedStops;
  const boundsKey = `${focusedSegmentId}:${boundsStops.map((stop) => `${stop.id}:${stop.displayLat}:${stop.displayLng}`).join('|')}`;
  const connectors = buildConnectors(stops);
  const correctionMode = Boolean(correctionStop);

  const isMuted = (stop) => focusedSegmentId !== 'all' && stop.routeSegmentId !== focusedSegmentId;
  const isConnectorMuted = (connector) => focusedSegmentId !== 'all'
    && !connector.id.split(':').some((id) => stops.find((stop) => stop.id === id)?.routeSegmentId === focusedSegmentId);

  return (
    <MapContainer
      center={[20, 100]}
      zoom={4}
      style={{ width: '100%', height: '100%' }}
      zoomControl={true}
    >
      <TileLayer
        url={mapConfig.tileUrl}
        subdomains={mapConfig.tileSubdomains}
        attribution={mapConfig.tileAttribution}
      />
      <MapBounds stops={boundsStops} boundsKey={boundsKey} />
      <MapCenterReporter enabled={correctionMode} onChange={onMapCenterChange} />
      {correctionMode && <CorrectionTargetPan stop={correctionStop} />}
      {connectors.filter((c) => !c.dashed).map((connector) => (
        <Polyline
          key={`${connector.id}:under`}
          positions={[connector.from, connector.to]}
          pathOptions={{
            color: '#0d0b09',
            weight: 5,
            opacity: isConnectorMuted(connector) ? 0.24 : 0.65,
          }}
        />
      ))}
      {connectors.filter((c) => !c.dashed).map((connector) => (
        <Polyline
          key={`${connector.id}:pearl`}
          positions={[connector.from, connector.to]}
          pathOptions={{
            color: '#f0ebe3',
            weight: 2.5,
            opacity: isConnectorMuted(connector) ? 0.24 : 0.92,
          }}
        />
      ))}
      {connectors.filter((c) => c.dashed).map((connector) => (
        <Polyline
          key={connector.id}
          positions={[connector.from, connector.to]}
          pathOptions={{
            color: 'rgba(240,234,216,0.66)',
            weight: 2,
            opacity: isConnectorMuted(connector) ? 0.24 : 0.72,
            dashArray: '7 8',
          }}
        />
      ))}
      {connectors.map((connector) => (
        <ArrowMarker key={`${connector.id}:arrow`} connector={connector} />
      ))}
      {pinnedStops.map(stop => (
        <StopMarker
          key={stop.id}
          stop={stop}
          deepLinkProvider={mapConfig.deepLinkProvider}
          muted={isMuted(stop)}
          onStartCorrection={onStartCorrection}
        />
      ))}
    </MapContainer>
  );
}
