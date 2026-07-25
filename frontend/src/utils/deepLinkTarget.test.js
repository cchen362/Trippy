import { describe, expect, it } from 'vitest';
import { resolveDeepLinkTarget, linkCoordinateSystemForProvider } from './deepLinkTarget.js';

// Plan 24 W3 (D-24-6) — this file is NEW. resolveDeepLinkTarget mirrors
// backend mapData.js F7 provider precedence; the mirror is only trustworthy
// if a test asserts both surfaces agree on the rule shape (D-24-6, F8/D-24-7).
describe('resolveDeepLinkTarget provider precedence', () => {
  it('CN country code resolves to amap', () => {
    const stop = { countryCode: 'CN', lat: 30, lng: 120, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, null);
    expect(result.provider).toBe('amap');
  });

  it('KR country code resolves to naver', () => {
    const stop = { countryCode: 'KR', lat: 37.5, lng: 127, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, null);
    expect(result.provider).toBe('naver');
  });

  it('any other non-empty country code (TW, JP) resolves to google', () => {
    const tw = resolveDeepLinkTarget({ countryCode: 'TW', lat: 25, lng: 121, coordinateSystem: 'wgs84' }, null);
    const jp = resolveDeepLinkTarget({ countryCode: 'JP', lat: 35, lng: 139, coordinateSystem: 'wgs84' }, null);
    expect(tw.provider).toBe('google');
    expect(jp.provider).toBe('google');
  });

  // F7 — the stop's own country must win over a conflicting day fallback.
  it('the stop\'s own country beats a conflicting dayMapConfig.deepLinkProvider', () => {
    const stop = { countryCode: 'TW', lat: 25, lng: 121, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, { deepLinkProvider: 'amap' });
    expect(result.provider).toBe('google');
  });

  it('falls back to dayMapConfig.deepLinkProvider when the stop has no country', () => {
    const stop = { countryCode: null, lat: 30, lng: 120, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, { deepLinkProvider: 'amap' });
    expect(result.provider).toBe('amap');
  });

  // F8 / D-24-7 — no link may be emitted with an unknown provider; the load
  // window must render nothing rather than defaulting to Google.
  it('returns null when the stop has no country and dayMapConfig has no deepLinkProvider', () => {
    const stop = { countryCode: null, lat: 30, lng: 120, coordinateSystem: 'wgs84' };
    expect(resolveDeepLinkTarget(stop, null)).toBeNull();
    expect(resolveDeepLinkTarget(stop, undefined)).toBeNull();
    expect(resolveDeepLinkTarget(stop, {})).toBeNull();
  });

  it('accepts the snake_case country_code shape as well as countryCode', () => {
    const stop = { country_code: 'KR', lat: 37.5, lng: 127, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, null);
    expect(result.provider).toBe('naver');
  });
});

describe('resolveDeepLinkTarget coordinate finiteness', () => {
  it('returns null when coordinates are non-finite (null, undefined, NaN)', () => {
    const base = { countryCode: 'JP', coordinateSystem: 'wgs84' };
    expect(resolveDeepLinkTarget({ ...base, lat: null, lng: 139 }, null)).toBeNull();
    expect(resolveDeepLinkTarget({ ...base, lat: 35, lng: undefined }, null)).toBeNull();
    expect(resolveDeepLinkTarget({ ...base, lat: NaN, lng: 139 }, null)).toBeNull();
  });
});

describe('resolveDeepLinkTarget datum conversion', () => {
  it('a wgs84-stored CN stop returns GCJ-02-shifted link coordinates (amap)', () => {
    const stop = { countryCode: 'CN', lat: 29.560110, lng: 106.573357, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, null);
    expect(result.provider).toBe('amap');
    expect(result.lat).not.toBe(stop.lat);
    expect(result.lng).not.toBe(stop.lng);
  });

  it('a wgs84 stop with a google provider returns the stored coordinates unchanged', () => {
    const stop = { countryCode: 'TW', lat: 25.033, lng: 121.565, coordinateSystem: 'wgs84' };
    const result = resolveDeepLinkTarget(stop, null);
    expect(result.provider).toBe('google');
    expect(result.lat).toBe(stop.lat);
    expect(result.lng).toBe(stop.lng);
  });

  // A gcj02-stored CN stop under amap must NOT be double-converted.
  it('a gcj02-stored CN stop under amap is not double-converted (returns stored pair verbatim)', () => {
    const stop = { countryCode: 'CN', lat: 29.557226, lng: 106.577047, coordinateSystem: 'gcj02' };
    const result = resolveDeepLinkTarget(stop, null);
    expect(result.provider).toBe('amap');
    expect(result.lat).toBe(stop.lat);
    expect(result.lng).toBe(stop.lng);
  });
});

describe('linkCoordinateSystemForProvider', () => {
  it('amap maps to gcj02', () => {
    expect(linkCoordinateSystemForProvider('amap')).toBe('gcj02');
  });

  it('google, naver, and an unknown string map to wgs84', () => {
    expect(linkCoordinateSystemForProvider('google')).toBe('wgs84');
    expect(linkCoordinateSystemForProvider('naver')).toBe('wgs84');
    expect(linkCoordinateSystemForProvider('bing')).toBe('wgs84');
  });
});
