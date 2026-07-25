// Single source of truth for provider deep links (D7) — was previously
// duplicated inline in OpenInMapsButton.jsx.
//
// `googlePlaceId` (Plan 24 Wave 2) is a pre-decided, nullable, bare place ID
// (the `google:` prefix already stripped by the backend's one owning helper,
// D-24-3) — this file contains zero clause logic of its own about when an
// ID is trustworthy.
//
// `query` always carries the exact coordinates (D-24-5, F13): per Google's
// documented contract, `query` is required for all search requests and is
// the safety net — "If you specify both parameters, the query is only used
// if Google Maps cannot find the place ID." That means a resolvable-but-
// relocated ID still moves the destination; the `query` fallback only
// protects against NOT_FOUND. That is a known, accepted limitation (review
// §3, G1), not something this helper works around.
export function buildDeepLink(provider, lat, lng, label, googlePlaceId) {
  if (provider === 'amap') {
    return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(label)}`;
  }
  if (provider === 'naver') {
    return `https://map.naver.com/p/search/${encodeURIComponent(label)}?c=${lng},${lat},15,0,0,0,dh`;
  }
  const base = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  if (typeof googlePlaceId === 'string' && googlePlaceId.length > 0) {
    return `${base}&query_place_id=${encodeURIComponent(googlePlaceId)}`;
  }
  return base;
}
