import L from 'leaflet';
import { Marker, Popup } from 'react-leaflet';
import OpenInMapsButton from './OpenInMapsButton.jsx';

function statusLabel(stop) {
  if (stop.locationStatus === 'user_confirmed') return 'User confirmed';
  if (stop.isEstimated || stop.locationStatus === 'estimated') return 'Estimated';
  if (stop.locationStatus === 'unresolved') return 'Unresolved';
  return 'Resolved';
}

function buildStopIcon(stop) {
  const estimated = stop.isEstimated || stop.locationStatus === 'estimated';
  const fill = estimated ? 'rgba(201,168,76,0.72)' : '#c9a84c';
  const ring = estimated
    ? '<circle cx="16" cy="16" r="13" fill="none" stroke="rgba(240,234,216,0.82)" stroke-width="2" stroke-dasharray="3 4"/>'
    : '<circle cx="16" cy="16" r="13" fill="none" stroke="#0d0b09" stroke-width="3"/>';

  return L.divIcon({
    className: '',
    html: `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      ${ring}
      <circle cx="16" cy="16" r="10" fill="${fill}" stroke="rgba(13,11,9,0.72)" stroke-width="1.5"/>
      <text x="16" y="19.5" text-anchor="middle" font-family="DM Mono, monospace" font-size="10" font-weight="700" fill="#0d0b09">${stop.routeNumber}</text>
    </svg>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -17],
  });
}

const actionStyle = {
  width: '100%',
  marginTop: 7,
  border: '1px solid rgba(201,168,76,0.5)',
  borderRadius: 999,
  background: 'rgba(201,168,76,0.14)',
  color: 'var(--gold)',
  fontFamily: "'DM Mono', monospace",
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  padding: '7px 10px',
  cursor: 'pointer',
};

export default function StopMarker({ stop, deepLinkProvider, muted = false, onStartCorrection }) {
  const lat = stop.displayLat ?? stop.lat;
  const lng = stop.displayLng ?? stop.lng;
  const icon = buildStopIcon(stop);
  const correctionLabel = stop.isEstimated || stop.locationStatus === 'estimated' ? 'Check location' : 'Move pin';

  return (
    <Marker position={[lat, lng]} icon={icon} opacity={muted ? 0.42 : 1}>
      <Popup>
        <div style={{ background: '#1c1a17', color: '#f0ead8', minWidth: 160, padding: '8px 0' }}>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: stop.isEstimated ? 'rgba(240,234,216,0.55)' : 'var(--gold)',
            marginBottom: 5,
          }}>
            Stop {stop.routeNumber} - {statusLabel(stop)}
          </div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontStyle: 'italic', fontSize: 14, marginBottom: 4 }}>
            {stop.title}
          </div>
          {stop.time && (
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: 'rgba(240,234,216,0.6)', marginBottom: 6 }}>
              {stop.time}
            </div>
          )}
          {Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && (
            <OpenInMapsButton lat={lat} lng={lng} label={stop.title} deepLinkProvider={deepLinkProvider} />
          )}
          {onStartCorrection && (
            <button
              type="button"
              onClick={() => onStartCorrection(stop)}
              style={actionStyle}
            >
              {correctionLabel}
            </button>
          )}
        </div>
      </Popup>
    </Marker>
  );
}
