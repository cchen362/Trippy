// Single source of truth for provider deep links (D7) — was previously
// duplicated inline in OpenInMapsButton.jsx.
export function buildDeepLink(provider, lat, lng, label) {
  if (provider === 'amap') {
    return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(label)}`;
  }
  if (provider === 'naver') {
    return `https://map.naver.com/p/search/${encodeURIComponent(label)}?c=${lng},${lat},15,0,0,0,dh`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
