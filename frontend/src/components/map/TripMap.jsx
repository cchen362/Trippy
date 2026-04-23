import { useEffect } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import StopMarker from './StopMarker.jsx';

function wgs84ToGcj02(lat, lng) {
  // Only transform within China's approximate bounding box
  if (lat < 3.86 || lat > 53.55 || lng < 73.66 || lng > 135.05) return { lat, lng };
  const A = 6378245.0;
  const EE = 0.00669342162296594323;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function MapBounds({ stops }) {
  const map = useMap();
  useEffect(() => {
    if (stops.length === 0) return;
    const bounds = stops.map(s => [s.lat, s.lng]);
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [stops, map]);
  return null;
}

export default function TripMap({ stops, mapConfig }) {
  const pinnedStops = stops.filter(s => s.lat && s.lng);

  // Apply coordinate transform once — both MapBounds and markers use the same coords
  const transformedStops = pinnedStops.map(stop => {
    const coords = mapConfig.coordinateSystem === 'gcj02'
      ? wgs84ToGcj02(stop.lat, stop.lng)
      : { lat: stop.lat, lng: stop.lng };
    return { ...stop, lat: coords.lat, lng: coords.lng };
  });

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
      <MapBounds stops={transformedStops} />
      {transformedStops.map(stop => (
        <StopMarker
          key={stop.id}
          stop={stop}
          deepLinkProvider={mapConfig.deepLinkProvider}
        />
      ))}
    </MapContainer>
  );
}
