import { Navigation } from 'lucide-react';
import { buildDeepLink } from '../../utils/deepLink.js';
import { resolveDeepLinkTarget } from '../../utils/deepLinkTarget.js';

// Plan 24 (F8 fix): resolves the stop's own deep-link provider and
// link-datum coordinates via resolveDeepLinkTarget — the stop's own country
// wins, `mapConfig` (the day's provider) is only the fallback — rather than
// assuming the day's provider is correct and converting to its datum
// directly. Renders nothing while that resolution is unknown (e.g. before
// trip context has loaded) instead of falling back to a Google default, so
// no link is ever emitted for the wrong app or the wrong datum (D-24-7).
export default function NavigateIcon({ stop, label, mapConfig }) {
  const target = resolveDeepLinkTarget(stop, mapConfig);

  if (!target) {
    return null;
  }

  const { provider, lat, lng } = target;
  const href = buildDeepLink(provider, lat, lng, label, stop.googlePlaceId);

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
