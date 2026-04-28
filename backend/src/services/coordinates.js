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

export function gcj02ToWgs84(lat, lng) {
  if (!isInChina(lat, lng)) return { lat, lng };

  let minLat = lat - 0.01;
  let maxLat = lat + 0.01;
  let minLng = lng - 0.01;
  let maxLng = lng + 0.01;
  let wgsLat = lat;
  let wgsLng = lng;

  for (let i = 0; i < 30; i += 1) {
    wgsLat = (minLat + maxLat) / 2;
    wgsLng = (minLng + maxLng) / 2;
    const converted = wgs84ToGcj02(wgsLat, wgsLng);
    const dLat = converted.lat - lat;
    const dLng = converted.lng - lng;

    if (Math.abs(dLat) < 1e-7 && Math.abs(dLng) < 1e-7) break;
    if (dLat > 0) maxLat = wgsLat;
    else minLat = wgsLat;
    if (dLng > 0) maxLng = wgsLng;
    else minLng = wgsLng;
  }

  return { lat: wgsLat, lng: wgsLng };
}

function hasCoordinates(stop) {
  return Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);
}

export function toDisplayCoordinates(stop, mapConfig) {
  const locationStatus = stop?.location_status ?? stop?.locationStatus ?? 'unresolved';
  const coordinateSystem = stop?.coordinate_system ?? stop?.coordinateSystem ?? 'unknown';
  const isEstimated = locationStatus === 'estimated';

  if (!hasCoordinates(stop)) {
    return {
      displayLat: null,
      displayLng: null,
      displayCoordinateSystem: mapConfig?.coordinateSystem ?? 'wgs84',
      canRenderMarker: false,
      isEstimated,
    };
  }

  const targetSystem = mapConfig?.coordinateSystem === 'gcj02' ? 'gcj02' : 'wgs84';
  if (coordinateSystem === 'unknown' && !isEstimated) {
    return {
      displayLat: null,
      displayLng: null,
      displayCoordinateSystem: targetSystem,
      canRenderMarker: false,
      isEstimated,
    };
  }

  let display = { lat: stop.lat, lng: stop.lng };
  if (targetSystem === 'gcj02' && coordinateSystem === 'wgs84') {
    display = wgs84ToGcj02(stop.lat, stop.lng);
  } else if (targetSystem === 'wgs84' && coordinateSystem === 'gcj02') {
    display = gcj02ToWgs84(stop.lat, stop.lng);
  }

  return {
    displayLat: display.lat,
    displayLng: display.lng,
    displayCoordinateSystem: coordinateSystem === 'unknown' ? 'unknown' : targetSystem,
    canRenderMarker: true,
    isEstimated,
  };
}
