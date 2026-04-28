import { useEffect } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import StopMarker from './StopMarker.jsx';

function MapBounds({ stops }) {
  const map = useMap();
  useEffect(() => {
    if (stops.length === 0) return;
    const bounds = stops.map(s => [s.displayLat, s.displayLng]);
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [stops, map]);
  return null;
}

export default function TripMap({ stops, mapConfig }) {
  const pinnedStops = stops.filter(s => s.canRenderMarker);

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
      <MapBounds stops={pinnedStops} />
      {pinnedStops.map(stop => (
        <StopMarker
          key={stop.id}
          stop={stop}
          deepLinkProvider={mapConfig.deepLinkProvider}
        />
      ))}
    </MapContainer>
  );
}
