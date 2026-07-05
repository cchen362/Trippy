import { Navigation } from 'lucide-react';
import { buildDeepLink } from '../../utils/deepLink.js';
import { toDisplayCoordinates } from '../../utils/coordinates.js';

// H4: converts the stop's raw (possibly wgs84) coordinates to the map
// provider's display system before building the deep link, mirroring
// backend/src/services/mapData.js's displayLat/displayLng so Today-tab
// navigation lands on the same pin as the Map tab (see utils/coordinates.js
// for the guarded conversion — only wgs84-stored stops are ever converted).
export default function NavigateIcon({ stop, label, deepLinkProvider, mapConfig }) {
  const { lat, lng } = toDisplayCoordinates(stop, mapConfig);

  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  const href = buildDeepLink(deepLinkProvider, lat, lng, label);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Navigate to ${label}`}
      className="inline-flex items-center justify-center w-8 h-8 rounded-full border"
      style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)' }}
    >
      <Navigation size={14} />
    </a>
  );
}
