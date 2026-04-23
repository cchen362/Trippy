const OSM_CONFIG = {
  tileProvider: 'osm',
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSubdomains: ['a', 'b', 'c'],
  tileAttribution: '© OpenStreetMap contributors',
  coordinateSystem: 'wgs84',
};

export function getMapConfig(destinationCountries) {
  const upper = (destinationCountries || []).map((c) => c.toUpperCase());

  if (upper.includes('CN')) {
    return {
      tileProvider: 'amap',
      tileUrl: 'http://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=7',
      tileSubdomains: ['1', '2', '3', '4'],
      tileAttribution: '© AutoNavi',
      coordinateSystem: 'gcj02',
      deepLinkProvider: 'amap',
    };
  }

  if (upper.includes('KR')) {
    return {
      ...OSM_CONFIG,
      deepLinkProvider: 'naver',
    };
  }

  return {
    ...OSM_CONFIG,
    deepLinkProvider: 'google',
  };
}

export function buildDeepLink(provider, lat, lng, label) {
  switch (provider) {
    case 'amap':
      return `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(label)}`;
    case 'naver':
      return `https://map.naver.com/v5/search/${encodeURIComponent(label)}?c=${lng},${lat},15,0,0,0,dh`;
    default:
      return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
}

// WGS-84 to GCJ-02 (China's Mars Coordinate System) conversion.
// Only transforms coordinates within China's approximate bounding box.
// Algorithm based on the well-known eviltransform implementation.
const CHINA_LAT_MIN = 3.86;
const CHINA_LAT_MAX = 53.55;
const CHINA_LNG_MIN = 73.66;
const CHINA_LNG_MAX = 135.05;

const A = 6378245.0; // Krasovsky 1940 semi-major axis
const EE = 0.00669342162296594323; // Eccentricity squared

function isInChina(lat, lng) {
  return lat >= CHINA_LAT_MIN && lat <= CHINA_LAT_MAX &&
         lng >= CHINA_LNG_MIN && lng <= CHINA_LNG_MAX;
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
  if (!isInChina(lat, lng)) {
    return { lat, lng };
  }

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);

  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);

  return {
    lat: lat + dLat,
    lng: lng + dLng,
  };
}
