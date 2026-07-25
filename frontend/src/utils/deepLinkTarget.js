// Plan 24 W1 — single frontend owner for "how do I open this stop externally."
//
// `linkCoordinateSystemForProvider` and the provider precedence in
// `resolveDeepLinkTarget` are DELIBERATE mirrors of two backend files:
//   - backend/src/services/mapConfig.js (the provider -> datum mapping,
//     `linkCoordinateSystemForProvider`)
//   - backend/src/services/mapData.js (the country-then-day provider
//     precedence at the `deepLinkProvider` computation, F7)
// If either backend file's rule changes, update this file too. The mirror
// is kept honest by a Wave 3 parity test asserting Maps and Today agree for
// the same stop (D-24-6, the Plan 21 "accept a mirror, make the mirror
// provable" pattern) — do not let this file silently drift from those two.
import { toDisplayCoordinates } from './coordinates.js';

export function linkCoordinateSystemForProvider(provider) {
  return provider === 'amap' ? 'gcj02' : 'wgs84';
}

function resolveProvider(stop, dayMapConfig) {
  const rawCountry = stop?.countryCode ?? stop?.country_code;
  const stopCountry = typeof rawCountry === 'string' ? rawCountry.trim().toUpperCase() : '';

  if (stopCountry === 'CN') return 'amap';
  if (stopCountry === 'KR') return 'naver';
  if (stopCountry) return 'google';

  return dayMapConfig?.deepLinkProvider ?? null;
}

// Mirrors backend mapData.js:236-237 exactly (F7, D-24-6). Returns
// { provider, lat, lng } or null — never a partial result, and never a
// provider of 'google' by default when nothing is known (D-24-7): a null
// provider must never silently become a Google URL via buildDeepLink's
// `default:` branch.
export function resolveDeepLinkTarget(stop, dayMapConfig) {
  const provider = resolveProvider(stop, dayMapConfig);
  if (!provider) return null;

  const { lat, lng } = toDisplayCoordinates(stop, { coordinateSystem: linkCoordinateSystemForProvider(provider) });

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { provider, lat, lng };
}
