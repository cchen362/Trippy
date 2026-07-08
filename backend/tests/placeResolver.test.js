import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { config } from '../src/config.js';
import { __resetPlaceResolverForTests, buildPlaceQueryKey, resolvePlace } from '../src/services/placeResolver.js';
import { gcj02ToWgs84 } from '../src/services/coordinates.js';

let tmpDir;
let originalGooglePlacesKey;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-resolver-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  __resetPlaceResolverForTests();
  vi.restoreAllMocks();
  // Default to no Google key so Nominatim-only behavior is deterministic. Tests that
  // exercise the Google Places fallback opt in by setting config.googlePlacesKey.
  originalGooglePlacesKey = config.googlePlacesKey;
  config.googlePlacesKey = '';
});

afterEach(() => {
  config.googlePlacesKey = originalGooglePlacesKey;
  vi.useRealTimers();
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('resolvePlace', () => {
  it('returns curated Chongqing overrides before any external lookup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await resolvePlace({
      queryText: 'Raffles City Chongqing',
      city: 'Chongqing',
      country: 'CN',
    });

    expect(result).toMatchObject({
      resolvedName: 'Raffles City Chongqing',
      coordinateSystem: 'wgs84',
      coordinateSource: 'curated',
      locationStatus: 'estimated',
      providerId: 'curated:raffles-city-chongqing',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses place resolution cache before Nominatim', async () => {
    const db = getDb();
    const queryKey = buildPlaceQueryKey({ queryText: 'Cached Cafe', city: 'Chongqing', country: 'CN' });
    db.prepare(`
      INSERT INTO place_resolution_cache (
        query_key, query_text, city, country, provider, provider_id, name, address,
        lat, lng, coordinate_system, confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queryKey,
      'Cached Cafe',
      'Chongqing',
      'CN',
      'manual_seed',
      'cache-1',
      'Cached Cafe',
      'Cached Address',
      29.5,
      106.5,
      'wgs84',
      0.9,
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await resolvePlace({ queryText: 'Cached Cafe', city: 'Chongqing', country: 'CN' });

    expect(result).toMatchObject({
      lat: 29.5,
      lng: 106.5,
      coordinateSystem: 'wgs84',
      coordinateSource: 'cache',
      locationStatus: 'resolved',
      providerId: 'cache-1',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches failed Nominatim lookups as unresolved', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const first = await resolvePlace({ queryText: 'No Such Test Place', city: 'Chongqing', country: 'CN' });
    const second = await resolvePlace({ queryText: 'No Such Test Place', city: 'Chongqing', country: 'CN' });

    expect(first).toMatchObject({ locationStatus: 'unresolved', coordinateSystem: 'unknown' });
    expect(second).toMatchObject({ locationStatus: 'unresolved', coordinateSystem: 'unknown' });
    // With no Google key, only Nominatim is hit on the first call; the second lookup
    // short-circuits on the fresh (< 1h) unresolved cache row without any network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes country as countrycodes instead of appending it to q', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '3.1579679',
        lon: '101.7112048',
        display_name: 'Petronas Twin Towers, Kuala Lumpur, Malaysia',
        name: 'Petronas Twin Towers',
        osm_type: 'way',
        osm_id: '279944536',
      }],
    });

    const result = await resolvePlace({
      queryText: 'Petronas Twin Towers',
      city: 'Kuala Lumpur',
      country: 'MY',
      preferNominatim: true,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe('Petronas Twin Towers, Kuala Lumpur');
    expect(url.searchParams.get('countrycodes')).toBe('my');
    expect(result).toMatchObject({
      lat: 3.1579679,
      lng: 101.7112048,
      provider: 'nominatim',
    });
  });

  it('captures the resolved country from Nominatim addressdetails', async () => {
    const db = getDb();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '3.1579679',
        lon: '101.7112048',
        display_name: 'Petronas Twin Towers, Kuala Lumpur, Malaysia',
        name: 'Petronas Twin Towers',
        osm_type: 'way',
        osm_id: '279944536',
        address: { country_code: 'my' },
      }],
    });

    const result = await resolvePlace({
      queryText: 'Petronas Twin Towers',
      city: 'Kuala Lumpur',
      country: 'MY',
      preferNominatim: true,
    });

    expect(result.countryCode).toBe('MY');
    const cached = db.prepare('SELECT * FROM place_resolution_cache WHERE query_text = ?').get('Petronas Twin Towers');
    expect(cached.resolved_country).toBe('MY');
  });

  it('passes the raw city string through to Nominatim queries unmodified (Plan 8: canonicalization moved to cache-key folding only)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '29.5601096',
        lon: '106.5733569',
        display_name: 'Jiefangbei, Chongqing, China',
        name: 'Jiefangbei',
        osm_type: 'node',
        osm_id: '1234',
      }],
    });

    await resolvePlace({
      queryText: "People's Liberation Monument",
      city: 'Chong Qing',
      country: 'CN',
      preferNominatim: true,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe("People's Liberation Monument, Chong Qing");
    expect(url.searchParams.get('countrycodes')).toBe('cn');
  });

  it('tries parenthetical query text when the full Nominatim query misses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          lat: '3.1487688',
          lon: '101.6936385',
          display_name: 'Dataran Merdeka, Kuala Lumpur, Malaysia',
          name: 'Dataran Merdeka',
          osm_type: 'way',
          osm_id: '23069513',
        }],
      });

    const result = await resolvePlace({
      queryText: 'Merdeka Square (Dataran Merdeka)',
      city: 'Kuala Lumpur',
      country: 'MY',
      preferNominatim: true,
    });

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')).toBe('Merdeka Square (Dataran Merdeka), Kuala Lumpur');
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('q')).toBe('Dataran Merdeka, Kuala Lumpur');
    expect(result).toMatchObject({
      lat: 3.1487688,
      lng: 101.6936385,
      resolvedName: 'Dataran Merdeka',
      provider: 'nominatim',
    });
  });

  it('tries local-name aliases when the display name misses Nominatim', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          lat: '29.5601078',
          lon: '106.5733671',
          display_name: 'Jiefangbei, Chongqing, China',
          name: 'Jiefangbei',
          osm_type: 'node',
          osm_id: '5678',
        }],
      });

    const result = await resolvePlace({
      queryText: "People's Liberation Monument",
      city: 'Chongqing',
      country: 'CN',
      aliases: ['Jiefangbei'],
      preferNominatim: true,
    });

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')).toBe("People's Liberation Monument, Chongqing");
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('q')).toBe('Jiefangbei, Chongqing');
    expect(result).toMatchObject({
      lat: 29.5601078,
      lng: 106.5733671,
      provider: 'nominatim',
    });
  });

  it('retries unresolved Nominatim cache rows when preferNominatim is true', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          lat: '4.597479',
          lon: '101.090106',
          display_name: 'Ipoh, Perak, Malaysia',
          name: 'Ipoh',
          osm_type: 'relation',
          osm_id: '123',
        }],
      });

    const first = await resolvePlace({
      queryText: 'Ipoh',
      city: null,
      country: 'MY',
      preferNominatim: true,
    });
    __resetPlaceResolverForTests();
    const second = await resolvePlace({
      queryText: 'Ipoh',
      city: null,
      country: 'MY',
      preferNominatim: true,
    });

    expect(first).toMatchObject({ locationStatus: 'unresolved' });
    expect(second).toMatchObject({
      lat: 4.597479,
      lng: 101.090106,
      provider: 'nominatim',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to Google Places Text Search when Nominatim misses', async () => {
    config.googlePlacesKey = 'test-google-key';
    const db = getDb();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return { ok: true, json: async () => [] };
      }
      return {
        ok: true,
        json: async () => ({
          places: [{
            id: 'ChIJ_test_place',
            displayName: { text: 'Test Coffee Roasters' },
            formattedAddress: '1 Test Street, Kuala Lumpur, Malaysia',
            location: { latitude: 3.1478, longitude: 101.6953 },
            addressComponents: [
              { longText: 'Kuala Lumpur', shortText: 'Kuala Lumpur', types: ['locality'] },
              { longText: 'Malaysia', shortText: 'MY', types: ['country', 'political'] },
            ],
          }],
        }),
      };
    });

    const result = await resolvePlace({
      queryText: 'Test Coffee Roasters',
      city: 'Kuala Lumpur',
      country: 'MY',
    });

    const googleCall = fetchMock.mock.calls.find(([url]) => String(url).includes('places.googleapis.com'));
    expect(googleCall).toBeTruthy();
    expect(String(googleCall[0])).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(googleCall[1].method).toBe('POST');
    expect(googleCall[1].headers['X-Goog-FieldMask']).toBe('places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.businessStatus');
    const body = JSON.parse(googleCall[1].body);
    expect(body).toMatchObject({
      textQuery: 'Test Coffee Roasters, Kuala Lumpur',
      languageCode: 'en',
      pageSize: 1,
      regionCode: 'MY',
    });

    expect(result).toMatchObject({
      lat: 3.1478,
      lng: 101.6953,
      coordinateSystem: 'wgs84',
      coordinateSource: 'places',
      locationStatus: 'resolved',
      provider: 'google_places',
      providerId: 'google:ChIJ_test_place',
      countryCode: 'MY',
    });
    expect(result).not.toHaveProperty('updatedAtMs');

    const cached = db.prepare('SELECT * FROM place_resolution_cache WHERE query_text = ?').get('Test Coffee Roasters');
    expect(cached.provider).toBe('google_places');
    expect(cached.provider_id).toBe('google:ChIJ_test_place');
    expect(cached.resolved_country).toBe('MY');
  });

  it('converts GCJ-02 coordinates to WGS-84 for Google Places results in mainland China', async () => {
    config.googlePlacesKey = 'test-google-key';
    // GCJ-02 ("Mars") coordinates as Google would report them for a mainland-China place.
    const gcjLat = 29.5630;
    const gcjLng = 106.5507;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return { ok: true, json: async () => [] };
      }
      return {
        ok: true,
        json: async () => ({
          places: [{
            id: 'ChIJ_cn_test_place',
            displayName: { text: 'Great Hall of the People' },
            formattedAddress: 'Chongqing, China',
            location: { latitude: gcjLat, longitude: gcjLng },
            addressComponents: [
              { longText: 'Chongqing', shortText: 'Chongqing', types: ['administrative_area_level_1'] },
              { longText: 'China', shortText: 'CN', types: ['country', 'political'] },
            ],
          }],
        }),
      };
    });

    const result = await resolvePlace({
      queryText: 'Great Hall of the People',
      city: 'Chongqing',
      country: 'CN',
    });

    expect(fetchMock).toHaveBeenCalled();
    const expected = gcj02ToWgs84(gcjLat, gcjLng);
    expect(result.lat).toBeCloseTo(expected.lat, 9);
    expect(result.lng).toBeCloseTo(expected.lng, 9);
    // Sanity check the shift is in the expected ~0.001-0.006 degree GCJ-02/WGS-84 range,
    // not a no-op (which would indicate the conversion wasn't actually applied).
    expect(Math.abs(result.lat - gcjLat)).toBeGreaterThan(0.0005);
    expect(Math.abs(result.lat - gcjLat)).toBeLessThan(0.01);
    expect(result.coordinateSystem).toBe('wgs84');
    expect(result.countryCode).toBe('CN');
  });

  it('does not convert coordinates for Google Places results outside mainland China (Hong Kong)', async () => {
    config.googlePlacesKey = 'test-google-key';
    const hkLat = 22.3193;
    const hkLng = 114.1694;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return { ok: true, json: async () => [] };
      }
      return {
        ok: true,
        json: async () => ({
          places: [{
            id: 'ChIJ_hk_test_place',
            displayName: { text: 'Victoria Peak' },
            formattedAddress: 'Hong Kong',
            location: { latitude: hkLat, longitude: hkLng },
            addressComponents: [
              { longText: 'Hong Kong', shortText: 'HK', types: ['country', 'political'] },
            ],
          }],
        }),
      };
    });

    const result = await resolvePlace({
      queryText: 'Victoria Peak',
      city: 'Hong Kong',
      country: 'HK',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.lat).toBe(hkLat);
    expect(result.lng).toBe(hkLng);
    expect(result.coordinateSystem).toBe('wgs84');
    expect(result.countryCode).toBe('HK');
  });

  it('retries stale unresolved cache rows over the network but keeps fresh ones short-circuited', async () => {
    const db = getDb();
    const staleKey = buildPlaceQueryKey({ queryText: 'Stale Miss Place', city: 'Ipoh', country: 'MY' });
    const freshKey = buildPlaceQueryKey({ queryText: 'Fresh Miss Place', city: 'Ipoh', country: 'MY' });

    const insertUnresolved = (queryKey, queryText, age) => {
      db.prepare(`
        INSERT INTO place_resolution_cache (
          query_key, query_text, city, country, provider, provider_id, name, address,
          lat, lng, coordinate_system, confidence, raw_json, updated_at
        )
        VALUES (?, ?, 'Ipoh', 'MY', 'nominatim', NULL, NULL, NULL, NULL, NULL, 'unknown', 0, NULL, datetime('now', ?))
      `).run(queryKey, queryText, age);
    };

    // Two hours old -> should be retried over the network.
    insertUnresolved(staleKey, 'Stale Miss Place', '-2 hours');
    // One minute old -> should still short-circuit.
    insertUnresolved(freshKey, 'Fresh Miss Place', '-1 minutes');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '4.597479',
        lon: '101.090106',
        display_name: 'Ipoh, Perak, Malaysia',
        name: 'Ipoh',
        osm_type: 'relation',
        osm_id: '123',
      }],
    });

    const stale = await resolvePlace({ queryText: 'Stale Miss Place', city: 'Ipoh', country: 'MY' });
    expect(stale).toMatchObject({ lat: 4.597479, lng: 101.090106, provider: 'nominatim' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fresh = await resolvePlace({ queryText: 'Fresh Miss Place', city: 'Ipoh', country: 'MY' });
    expect(fresh).toMatchObject({ locationStatus: 'unresolved', coordinateSystem: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throttles Nominatim requests to one per second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await resolvePlace({ queryText: 'First Missing Place', city: 'Chongqing', country: 'CN' });

    let settled = false;
    const second = resolvePlace({ queryText: 'Second Missing Place', city: 'Chongqing', country: 'CN' })
      .then((result) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({ locationStatus: 'unresolved' });
  });
});
