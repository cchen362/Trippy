import L from 'leaflet';
import { Marker, Popup } from 'react-leaflet';
import OpenInMapsButton from './OpenInMapsButton.jsx';

const goldIcon = L.divIcon({
  className: '',
  html: `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10" cy="10" r="7" fill="#c9a84c" stroke="#0d0b09" stroke-width="2"/>
  </svg>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
  popupAnchor: [0, -12],
});

export default function StopMarker({ stop, deepLinkProvider }) {
  const lat = stop.displayLat ?? stop.lat;
  const lng = stop.displayLng ?? stop.lng;

  return (
    <Marker position={[lat, lng]} icon={goldIcon}>
      <Popup>
        <div style={{ background: '#1c1a17', color: '#f0ead8', minWidth: 160, padding: '8px 0' }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontStyle: 'italic', fontSize: 14, marginBottom: 4 }}>
            {stop.title}
          </div>
          {stop.time && (
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: 'rgba(240,234,216,0.6)', marginBottom: 6 }}>
              {stop.time}
            </div>
          )}
          {lat && lng && (
            <OpenInMapsButton lat={lat} lng={lng} label={stop.title} deepLinkProvider={deepLinkProvider} />
          )}
        </div>
      </Popup>
    </Marker>
  );
}
