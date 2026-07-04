import { Navigation } from 'lucide-react';
import { buildDeepLink } from '../../utils/deepLink.js';

export default function NavigateIcon({ lat, lng, label, deepLinkProvider }) {
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
