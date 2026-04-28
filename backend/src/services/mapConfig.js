import { config } from '../config.js';

const OSM_CONFIG = {
  tileProvider: 'osm',
  tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSubdomains: ['a', 'b', 'c'],
  tileAttribution: '© OpenStreetMap contributors',
  coordinateSystem: 'wgs84',
};

function mapTilerConfig(maptilerKey) {
  return {
    tileProvider: 'maptiler',
    tileUrl: `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${encodeURIComponent(maptilerKey)}`,
    tileSubdomains: [],
    tileAttribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
    coordinateSystem: 'wgs84',
  };
}

export function getMapConfig(destinationCountries, options = {}) {
  const upper = (destinationCountries || []).map((c) => c.toUpperCase());
  const maptilerKey = options.maptilerKey ?? config.maptilerKey;

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
    if (maptilerKey) {
      return {
        ...mapTilerConfig(maptilerKey),
        deepLinkProvider: 'naver',
      };
    }

    return {
      ...OSM_CONFIG,
      deepLinkProvider: 'naver',
    };
  }

  if (maptilerKey) {
    return {
      ...mapTilerConfig(maptilerKey),
      deepLinkProvider: 'google',
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
      return `https://map.naver.com/p/search/${encodeURIComponent(label)}?c=${lng},${lat},15,0,0,0,dh`;
    default:
      return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
}
