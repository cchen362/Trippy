import { describe, it, expect } from 'vitest';
import { getMapConfig, buildDeepLink, wgs84ToGcj02 } from '../src/services/mapConfig.js';

describe('getMapConfig', () => {
  it('returns amap config for CN', () => {
    const config = getMapConfig(['CN']);
    expect(config.tileProvider).toBe('amap');
    expect(config.coordinateSystem).toBe('gcj02');
    expect(config.deepLinkProvider).toBe('amap');
    expect(config.tileSubdomains).toEqual(['1', '2', '3', '4']);
    expect(config.tileAttribution).toBe('© AutoNavi');
  });

  it('returns osm + naver for KR', () => {
    const config = getMapConfig(['KR']);
    expect(config.tileProvider).toBe('osm');
    expect(config.coordinateSystem).toBe('wgs84');
    expect(config.deepLinkProvider).toBe('naver');
    expect(config.tileSubdomains).toEqual(['a', 'b', 'c']);
    expect(config.tileAttribution).toBe('© OpenStreetMap contributors');
  });

  it('returns osm + google for JP', () => {
    const config = getMapConfig(['JP']);
    expect(config.tileProvider).toBe('osm');
    expect(config.coordinateSystem).toBe('wgs84');
    expect(config.deepLinkProvider).toBe('google');
  });

  it('returns osm + google for empty array', () => {
    const config = getMapConfig([]);
    expect(config.tileProvider).toBe('osm');
    expect(config.deepLinkProvider).toBe('google');
  });

  it('is case-insensitive for CN (lowercase cn)', () => {
    const config = getMapConfig(['cn']);
    expect(config.tileProvider).toBe('amap');
    expect(config.deepLinkProvider).toBe('amap');
  });

  it('CN takes precedence over KR when both present', () => {
    const config = getMapConfig(['KR', 'CN']);
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
    expect(url).toBe('https://map.naver.com/v5/search/Seoul?c=127,37.5,15,0,0,0,dh');
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
    // Result should differ from input — GCJ-02 offset in Beijing is ~200-500m
    expect(result.lat).not.toBe(39.9);
    expect(result.lng).not.toBe(116.4);
    // But should stay in roughly the same area
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
    // Tokyo is outside China's approximate bounds
    const result = wgs84ToGcj02(35.68, 139.69);
    expect(result.lat).toBe(35.68);
    expect(result.lng).toBe(139.69);
  });
});
