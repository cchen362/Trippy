// Frontend twin of backend/src/services/coordinates.js (H4). The WGS-84 <->
// GCJ-02 conversion math is copied verbatim from that file — it is a pure,
// well-known algorithm with no dependencies, so a faithful port here (rather
// than an HTTP round-trip for every Today-tab render) keeps navigation fast
// without diverging from the backend's math. If the formulas ever need to
// change, update both files together.
const CHINA_LAT_MIN = 3.86;
const CHINA_LAT_MAX = 53.55;
const CHINA_LNG_MIN = 73.66;
const CHINA_LNG_MAX = 135.05;

const A = 6378245.0;
const EE = 0.00669342162296594323;

export function isInChina(lat, lng) {
  return lat >= CHINA_LAT_MIN && lat <= CHINA_LAT_MAX
    && lng >= CHINA_LNG_MIN && lng <= CHINA_LNG_MAX;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

export function wgs84ToGcj02(lat, lng) {
  if (!isInChina(lat, lng)) return { lat, lng };

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);

  return { lat: lat + dLat, lng: lng + dLng };
}

function hasCoordinates(stop) {
  return Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);
}

// Mirrors backend toDisplayCoordinates' wgs84 guard exactly (H4 CRITICAL
// nuance): only ever convert coordinates whose stored system is 'wgs84'.
// Stops already saved as 'gcj02' (e.g. a user-corrected pin under an AMap
// config) must pass through untouched — converting them again would
// double-shift the pin. 'unknown' systems also pass through untouched here
// (Today tab has no "estimated" fallback path the way the map view does;
// NavigateIcon simply won't render without finite coordinates).
export function toDisplayCoordinates(stop, mapConfig) {
  if (!hasCoordinates(stop)) return { lat: null, lng: null };

  const coordinateSystem = stop?.coordinateSystem ?? stop?.coordinate_system ?? 'unknown';
  const targetSystem = mapConfig?.coordinateSystem === 'gcj02' ? 'gcj02' : 'wgs84';

  if (targetSystem === 'gcj02' && coordinateSystem === 'wgs84') {
    return wgs84ToGcj02(stop.lat, stop.lng);
  }

  return { lat: stop.lat, lng: stop.lng };
}
