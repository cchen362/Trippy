import { describe, it, expect } from 'vitest';
import { getMapConfig, buildDeepLink } from '../src/services/mapConfig.js';
import { gcj02ToWgs84, toDisplayCoordinates, wgs84ToGcj02 } from '../src/services/coordinates.js';

describe('getMapConfig', () => {
  it('returns amap config for CN', () => {
    const config = getMapConfig(['CN'], { maptilerKey: 'test-key' });
    expect(config.tileProvider).toBe('amap');
    expect(config.coordinateSystem).toBe('gcj02');
    expect(config.deepLinkProvider).toBe('amap');
    expect(config.tileSubdomains).toEqual(['1', '2', '3', '4']);
    expect(config.tileAttribution).toBe('© AutoNavi');
  });

  it('returns maptiler + naver for KR when MapTiler is configured', () => {
    const config = getMapConfig(['KR'], { maptilerKey: 'test-key' });
    expect(config.tileProvider).toBe('maptiler');
    expect(config.coordinateSystem).toBe('wgs84');
    expect(config.deepLinkProvider).toBe('naver');
    expect(config.tileUrl).toBe('https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=test-key');
    expect(config.tileAttribution).toContain('MapTiler');
  });

  it('returns maptiler + google for non-China maps when MapTiler is configured', () => {
    const config = getMapConfig(['JP'], { maptilerKey: 'test-key' });
    expect(config.tileProvider).toBe('maptiler');
    expect(config.coordinateSystem).toBe('wgs84');
    expect(config.deepLinkProvider).toBe('google');
    expect(config.tileUrl).toContain('api.maptiler.com');
    expect(config.tileUrl).toContain('key=test-key');
  });

  it('returns osm + google when MapTiler is not configured', () => {
    const config = getMapConfig([], { maptilerKey: '' });
    expect(config.tileProvider).toBe('osm');
    expect(config.tileSubdomains).toEqual(['a', 'b', 'c']);
    expect(config.deepLinkProvider).toBe('google');
  });

  it('is case-insensitive for CN (lowercase cn)', () => {
    const config = getMapConfig(['cn'], { maptilerKey: 'test-key' });
    expect(config.tileProvider).toBe('amap');
    expect(config.deepLinkProvider).toBe('amap');
  });

  it('CN takes precedence over KR when both present', () => {
    const config = getMapConfig(['KR', 'CN'], { maptilerKey: 'test-key' });
    expect(config.tileProvider).toBe('amap');
    expect(config.deepLinkProvider).toBe('amap');
  });
});

describe('buildDeepLink', () => {
  it('builds amap deep link correctly', () => {
    const url = buildDeepLink('amap', 31.2, 121.4, 'Place');
    expect(url).toBe('https://uri.amap.com/marker?position=121.4,31.2&name=Place');
  });

  it('builds naver deep link correctly', () => {
    const url = buildDeepLink('naver', 37.5, 127.0, 'Seoul');
    expect(url).toBe('https://map.naver.com/p/search/Seoul?c=127,37.5,15,0,0,0,dh');
  });

  it('builds google deep link correctly', () => {
    const url = buildDeepLink('google', 31.2, 121.4, 'Place');
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=31.2,121.4');
  });

  it('defaults to google for unknown provider', () => {
    const url = buildDeepLink('unknown', 51.5, -0.1, 'London');
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=51.5,-0.1');
  });

  it('encodes label with special characters for amap', () => {
    const url = buildDeepLink('amap', 39.9, 116.4, 'Hello World');
    expect(url).toContain('Hello%20World');
  });
});

describe('wgs84ToGcj02', () => {
  it('transforms coordinates within China (Beijing)', () => {
    const result = wgs84ToGcj02(39.9, 116.4);
    expect(result.lat).not.toBe(39.9);
    expect(result.lng).not.toBe(116.4);
    expect(result.lat).toBeGreaterThan(39.8);
    expect(result.lat).toBeLessThan(40.0);
    expect(result.lng).toBeGreaterThan(116.3);
    expect(result.lng).toBeLessThan(116.5);
  });

  it('returns unchanged coordinates outside China (London)', () => {
    const result = wgs84ToGcj02(51.5, -0.1);
    expect(result.lat).toBe(51.5);
    expect(result.lng).toBe(-0.1);
  });

  it('returns unchanged for edge case outside China bounds', () => {
    const result = wgs84ToGcj02(35.68, 139.69);
    expect(result.lat).toBe(35.68);
    expect(result.lng).toBe(139.69);
  });
});

describe('gcj02ToWgs84', () => {
  it('approximately reverses WGS-84 to GCJ-02 conversion in China', () => {
    const original = { lat: 29.5605, lng: 106.5655 };
    const gcj = wgs84ToGcj02(original.lat, original.lng);
    const wgs = gcj02ToWgs84(gcj.lat, gcj.lng);

    expect(wgs.lat).toBeCloseTo(original.lat, 5);
    expect(wgs.lng).toBeCloseTo(original.lng, 5);
  });
});

describe('toDisplayCoordinates', () => {
  const amap = { coordinateSystem: 'gcj02' };
  const osm = { coordinateSystem: 'wgs84' };

  it('converts WGS-84 stops once for Amap display', () => {
    const stop = {
      lat: 29.5605,
      lng: 106.5655,
      coordinate_system: 'wgs84',
      location_status: 'resolved',
    };

    const display = toDisplayCoordinates(stop, amap);

    expect(display.canRenderMarker).toBe(true);
    expect(display.displayCoordinateSystem).toBe('gcj02');
    expect(display.displayLat).not.toBe(stop.lat);
    expect(display.displayLng).not.toBe(stop.lng);
  });

  it('passes GCJ-02 stops through for Amap display', () => {
    const stop = {
      lat: 29.5605,
      lng: 106.5655,
      coordinate_system: 'gcj02',
      location_status: 'resolved',
    };

    const display = toDisplayCoordinates(stop, amap);

    expect(display.displayLat).toBe(stop.lat);
    expect(display.displayLng).toBe(stop.lng);
    expect(display.displayCoordinateSystem).toBe('gcj02');
  });

  it('converts GCJ-02 stops to WGS-84 for non-China map display', () => {
    const wgs = { lat: 29.5605, lng: 106.5655 };
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lng);
    const stop = {
      lat: gcj.lat,
      lng: gcj.lng,
      coordinate_system: 'gcj02',
      location_status: 'resolved',
    };

    const display = toDisplayCoordinates(stop, osm);

    expect(display.displayCoordinateSystem).toBe('wgs84');
    expect(display.displayLat).toBeCloseTo(wgs.lat, 5);
    expect(display.displayLng).toBeCloseTo(wgs.lng, 5);
  });

  it('does not blindly convert unknown coordinates', () => {
    const stop = {
      lat: 29.5605,
      lng: 106.5655,
      coordinate_system: 'unknown',
      location_status: 'resolved',
    };

    const display = toDisplayCoordinates(stop, amap);

    expect(display.canRenderMarker).toBe(false);
    expect(display.displayLat).toBeNull();
    expect(display.displayLng).toBeNull();
  });

  it('allows unknown coordinates only as estimated passthrough', () => {
    const stop = {
      lat: 29.5605,
      lng: 106.5655,
      coordinate_system: 'unknown',
      location_status: 'estimated',
    };

    const display = toDisplayCoordinates(stop, amap);

    expect(display.canRenderMarker).toBe(true);
    expect(display.isEstimated).toBe(true);
    expect(display.displayLat).toBe(stop.lat);
    expect(display.displayLng).toBe(stop.lng);
    expect(display.displayCoordinateSystem).toBe('unknown');
  });
});
