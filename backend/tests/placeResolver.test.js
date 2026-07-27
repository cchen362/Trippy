import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
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
      // This is also the Google name-similarity ACCEPTANCE case (F-26-8): the
      // returned displayName exactly matches queryText, so the strong-match path
      // keeps today's resolved/0.9 values unchanged.
      locationStatus: 'resolved',
      confidence: 0.9,
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

// Plan 26 W1.1 (F-26-5): the module-global 1 req/s Nominatim gate now grants by
// priority rather than plain FIFO, so an interactive caller (add-stop, booking-
// linked resolution, day-override country inference) doesn't queue behind a
// draining background verification batch. Background work may be delayed but
// never starved outright.
describe('resolvePlace — priority-aware Nominatim gate', () => {
  it('grants an interactive waiter ahead of already-queued background waiters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });

    // Warm up the gate: the very first lookup after a reset finds the gate
    // already open and is granted synchronously (no timer needed, matching
    // the pre-W1.1 fast path) — consume that slot first so the real scenario
    // below exercises the actual queued-grant path for every waiter.
    await resolvePlace({ queryText: 'Warm Up', city: 'Chongqing', country: 'CN' });

    const order = [];
    const bg1 = resolvePlace({ queryText: 'BG One', city: 'Chongqing', country: 'CN', priority: 'background' })
      .then(() => order.push('bg1'));
    const bg2 = resolvePlace({ queryText: 'BG Two', city: 'Chongqing', country: 'CN', priority: 'background' })
      .then(() => order.push('bg2'));
    const bg3 = resolvePlace({ queryText: 'BG Three', city: 'Chongqing', country: 'CN', priority: 'background' })
      .then(() => order.push('bg3'));

    // Let all three background waiters enqueue (and the pump's first timer get
    // scheduled) before the interactive caller arrives — this is the scenario
    // a plain FIFO gate would get wrong.
    await Promise.resolve();
    await Promise.resolve();

    const interactive = resolvePlace({ queryText: 'Interactive One', city: 'Chongqing', country: 'CN' })
      .then(() => order.push('interactive'));

    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([bg1, bg2, bg3, interactive]);

    expect(order[0]).toBe('interactive');
    expect(order).toEqual(expect.arrayContaining(['bg1', 'bg2', 'bg3']));
  });

  it('does not starve a background waiter indefinitely, even while interactive waiters keep arriving', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });

    // Warm up the gate for the same reason as above — otherwise the very
    // first waiter pushed (here, the background one) would be granted
    // synchronously for free, defeating the starvation scenario being tested.
    await resolvePlace({ queryText: 'Warm Up', city: 'Chongqing', country: 'CN' });

    const order = [];
    const bg = resolvePlace({ queryText: 'Starved BG Place', city: 'Chongqing', country: 'CN', priority: 'background' })
      .then(() => order.push('bg'));

    // Ten interactive waiters enqueued up front — more than enough to keep
    // out-competing the background waiter on priority alone for every 1-second
    // grant until MAX_BACKGROUND_DEFERRAL_MS (10,000ms) elapses since bg was
    // enqueued: grants at t=1000..9000ms (9 of them) go to interactive
    // waiters; by the grant at t=10000ms bg's wait has reached the bound and
    // it must win regardless of how many interactive waiters remain queued.
    const interactives = Array.from({ length: 10 }, (_, i) => resolvePlace({
      queryText: `Interactive Place ${i}`,
      city: 'Chongqing',
      country: 'CN',
    }).then(() => order.push(`interactive-${i}`)));

    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10000);

    expect(order[9]).toBe('bg');
    expect(order.slice(0, 9).every((entry) => entry.startsWith('interactive'))).toBe(true);

    await Promise.all([bg, ...interactives.slice(0, 9)]);
  });

  it('never grants two Nominatim slots inside one interval, regardless of priority mix', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T00:00:00Z'));
    const grantTimes = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      grantTimes.push(Date.now());
      return { ok: true, json: async () => [] };
    });

    const calls = Array.from({ length: 5 }, (_, i) => resolvePlace({
      queryText: `Pacing Place ${i}`,
      city: 'Chongqing',
      country: 'CN',
      priority: i % 2 === 0 ? 'interactive' : 'background',
    }));

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(calls);

    expect(grantTimes).toHaveLength(5);
    for (let i = 1; i < grantTimes.length; i += 1) {
      expect(grantTimes[i] - grantTimes[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  });
});

// Plan 26 W2.1 (F-26-8): Google Text Search's first result was previously trusted
// unconditionally (hardcoded resolved/0.9) with no name-similarity check, unlike the
// Nominatim path (classifyNominatimResult). These prove the shared check now applies
// on both paths.
describe('resolvePlace — Google Places name-similarity check', () => {
  it('does not label an unrelated Google result "resolved" when Nominatim misses entirely', async () => {
    config.googlePlacesKey = 'test-google-key';
    const db = getDb();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return { ok: true, json: async () => [] };
      }
      return {
        ok: true,
        json: async () => ({
          places: [{
            id: 'ChIJ_unrelated_place',
            displayName: { text: 'Totally Different Place' },
            formattedAddress: 'Somewhere Not Kuala Lumpur',
            location: { latitude: 3.111, longitude: 101.222 },
            addressComponents: [
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

    expect(result).toMatchObject({
      locationStatus: 'estimated',
      confidence: 0.55,
      provider: 'google_places',
    });
    expect(result.locationStatus).not.toBe('resolved');

    // A cache read must reproduce 'estimated' too (readCache's `< 0.7 -> estimated` rule).
    const cached = db.prepare('SELECT * FROM place_resolution_cache WHERE query_text = ?').get('Test Coffee Roasters');
    expect(cached.confidence).toBe(0.55);
  });
});

// Plan 26 W2.3 (F-26-7): resolvePlace previously returned any Nominatim result
// immediately, even a weak 'estimated' one, suppressing a stronger Google attempt.
// escalateWeakHit is an opt-in that lets a caller (discovery verification) authorise
// exactly one Google escalation on a weak Nominatim hit.
describe('resolvePlace — Google escalation past a weak Nominatim hit (opt-in)', () => {
  function mockWeakNominatimThenGoogle(googlePlace) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return {
          ok: true,
          json: async () => [{
            lat: '3.1000',
            lon: '101.2000',
            // Name/address unrelated to the query and city -> weak match (estimated).
            display_name: 'Random Diner, Somewhere Else, Malaysia',
            name: 'Random Diner',
            osm_type: 'node',
            osm_id: '999',
          }],
        };
      }
      return {
        ok: true,
        json: async () => ({ places: googlePlace ? [googlePlace] : [] }),
      };
    });
  }

  it('escalates a weak Nominatim hit to Google and returns the strong Google result, but caches the Nominatim row', async () => {
    config.googlePlacesKey = 'test-google-key';
    const db = getDb();
    const fetchMock = mockWeakNominatimThenGoogle({
      id: 'ChIJ_escalated_place',
      displayName: { text: 'Escalation Target' },
      formattedAddress: '1 Escalation Target, Kuala Lumpur, Malaysia',
      location: { latitude: 3.15, longitude: 101.7 },
      addressComponents: [
        { longText: 'Malaysia', shortText: 'MY', types: ['country', 'political'] },
      ],
    });

    const result = await resolvePlace({
      queryText: 'Escalation Target',
      city: 'Kuala Lumpur',
      country: 'MY',
      escalateWeakHit: () => true,
    });

    expect(result).toMatchObject({
      provider: 'google_places',
      locationStatus: 'resolved',
      providerId: 'google:ChIJ_escalated_place',
    });

    const googleCall = fetchMock.mock.calls.find(([url]) => String(url).includes('places.googleapis.com'));
    expect(googleCall).toBeTruthy();

    // CACHE RULE: the escalated Google result must never overwrite the Nominatim
    // cache row — place_resolution_cache is shared with interactive stop/booking
    // resolution and must not be silently re-routed onto a Google-named row.
    const cached = db.prepare('SELECT * FROM place_resolution_cache WHERE query_text = ?').get('Escalation Target');
    expect(cached.provider).toBe('nominatim');
    expect(cached.name).toBe('Random Diner');
  });

  it('does not call Google when escalateWeakHit declines', async () => {
    config.googlePlacesKey = 'test-google-key';
    const fetchMock = mockWeakNominatimThenGoogle(null);

    const result = await resolvePlace({
      queryText: 'Escalation Target',
      city: 'Kuala Lumpur',
      country: 'MY',
      escalateWeakHit: () => false,
    });

    expect(result).toMatchObject({ provider: 'nominatim', locationStatus: 'estimated' });
    const googleCall = fetchMock.mock.calls.find(([url]) => String(url).includes('places.googleapis.com'));
    expect(googleCall).toBeFalsy();
  });

  it('keeps the Nominatim result when the escalated Google result is also weak', async () => {
    config.googlePlacesKey = 'test-google-key';
    const fetchMock = mockWeakNominatimThenGoogle({
      id: 'ChIJ_still_unrelated',
      displayName: { text: 'Also Unrelated' },
      formattedAddress: 'Nowhere Near Kuala Lumpur',
      location: { latitude: 3.16, longitude: 101.71 },
      addressComponents: [
        { longText: 'Malaysia', shortText: 'MY', types: ['country', 'political'] },
      ],
    });

    const result = await resolvePlace({
      queryText: 'Escalation Target',
      city: 'Kuala Lumpur',
      country: 'MY',
      escalateWeakHit: () => true,
    });

    // Google was consulted (opted in and authorised)...
    const googleCall = fetchMock.mock.calls.find(([url]) => String(url).includes('places.googleapis.com'));
    expect(googleCall).toBeTruthy();
    // ...but it did not win just by existing: the weak Google result loses to the
    // (also weak) Nominatim result, which is what's returned.
    expect(result).toMatchObject({ provider: 'nominatim', locationStatus: 'estimated' });
  });
});

// Plan 26 W2.3 acceptance gate: PROVING (not just testing) that stops.js/bookings.js
// behaviour is byte-identical before and after this wave. A green suite alone is
// explicitly insufficient per the plan — these assert directly on the fetch mock and
// on the source files themselves.
describe('resolvePlace — Plan 24 compatibility proof (stops.js / bookings.js untouched)', () => {
  it('never calls Google when invoked with the exact argument shape stops.js:189/:831 use (no escalateWeakHit), even on a weak Nominatim hit with a Google key configured', async () => {
    config.googlePlacesKey = 'test-google-key';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return {
          ok: true,
          json: async () => [{
            lat: '3.1000',
            lon: '101.2000',
            display_name: 'Random Diner, Somewhere Else, Malaysia',
            name: 'Random Diner',
            osm_type: 'node',
            osm_id: '999',
          }],
        };
      }
      throw new Error('Google Places must not be called for a caller that did not opt into escalateWeakHit');
    });

    // Exact shape of the stops.js:189 call (queryText/city/country/aliases/allowNetwork/
    // preferNominatim) — deliberately no escalateWeakHit key at all.
    const result = await resolvePlace({
      queryText: 'Escalation Target',
      city: 'Kuala Lumpur',
      country: 'MY',
      aliases: [],
      allowNetwork: true,
      preferNominatim: false,
    });

    const googleCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('places.googleapis.com'));
    expect(googleCalls).toHaveLength(0);
    expect(result).toMatchObject({ provider: 'nominatim', locationStatus: 'estimated' });
  });

  it('does not reference escalateWeakHit, onAttempt, or refreshCache anywhere in stops.js or bookings.js (structural pin — expected to fail loudly if a future edit opts either file into escalation/telemetry/cache-refresh)', () => {
    const stopsSource = readFileSync(
      new URL('../src/services/stops.js', import.meta.url),
      'utf8',
    );
    const bookingsSource = readFileSync(
      new URL('../src/services/bookings.js', import.meta.url),
      'utf8',
    );

    expect(stopsSource).not.toMatch(/escalateWeakHit/);
    expect(bookingsSource).not.toMatch(/escalateWeakHit/);
    expect(stopsSource).not.toMatch(/onAttempt/);
    expect(bookingsSource).not.toMatch(/onAttempt/);
    expect(stopsSource).not.toMatch(/refreshCache/);
    expect(bookingsSource).not.toMatch(/refreshCache/);
  });

  it('short-circuits on a cached estimated row with zero fetches when invoked with the exact argument shape stops.js:189/:831 use (proves refreshCache defaults off for real callers)', async () => {
    const db = getDb();
    const queryKey = buildPlaceQueryKey({ queryText: 'Weakly Cached Place', city: 'Kuala Lumpur', country: 'MY' });
    db.prepare(`
      INSERT INTO place_resolution_cache (
        query_key, query_text, city, country, provider, provider_id, name, address,
        lat, lng, coordinate_system, confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queryKey,
      'Weakly Cached Place',
      'Kuala Lumpur',
      'MY',
      'nominatim',
      'node:1',
      'Weakly Cached Place',
      'Somewhere, Kuala Lumpur, Malaysia',
      3.1,
      101.2,
      'wgs84',
      0.55, // < 0.7 -> readCache classifies this as 'estimated'
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    // Exact shape of the stops.js:189 call (queryText/city/country/aliases/allowNetwork/
    // preferNominatim) — no refreshCache key at all.
    const result = await resolvePlace({
      queryText: 'Weakly Cached Place',
      city: 'Kuala Lumpur',
      country: 'MY',
      aliases: [],
      allowNetwork: true,
      preferNominatim: false,
    });

    expect(result).toMatchObject({ locationStatus: 'estimated', provider: 'nominatim' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Plan 26 W3.1 (F-26-6/F-26-7 follow-up): onAttempt is a per-call opt-in that records
// one attempt per provider interaction so W3.4 can measure the corpus instead of
// grepping console output. Every existing caller passes none, so these tests opt in
// explicitly.
describe('resolvePlace — onAttempt telemetry (opt-in)', () => {
  it('emits one record per Nominatim query variant tried, in order, only the winner carrying a resolved name', async () => {
    // "Merdeka Square (Dataran Merdeka)" expands (nominatimQueryTexts) into three
    // variants: the original, the parenthetical content, and the stripped form.
    // The full/original variant misses; the parenthetical variant hits.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          lat: '3.1487688',
          lon: '101.6936385',
          display_name: 'Dataran Merdeka, Kuala Lumpur, Malaysia',
          name: 'Dataran Merdeka',
          osm_type: 'way',
          osm_id: '23069513',
          address: { country_code: 'my' },
        }],
      });

    const attempts = [];
    const result = await resolvePlace({
      queryText: 'Merdeka Square (Dataran Merdeka)',
      city: 'Kuala Lumpur',
      country: 'MY',
      preferNominatim: true,
      onAttempt: (record) => attempts.push(record),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.resolvedName).toBe('Dataran Merdeka');

    const nominatimAttempts = attempts.filter((a) => a.provider === 'nominatim');
    expect(nominatimAttempts).toHaveLength(2);
    expect(nominatimAttempts[0]).toMatchObject({
      queryVariant: 'Merdeka Square (Dataran Merdeka)',
      networkRequests: 1,
      locationStatus: 'unresolved',
      resolvedName: null,
    });
    expect(nominatimAttempts[1]).toMatchObject({
      queryVariant: 'Dataran Merdeka',
      networkRequests: 1,
      locationStatus: 'resolved',
      resolvedName: 'Dataran Merdeka',
    });
    // Exactly the winner carries a non-null resolvedName.
    expect(nominatimAttempts.filter((a) => a.resolvedName !== null)).toHaveLength(1);
  });

  it('emits a cache record with networkRequests 0 and issues zero fetches on a cache short-circuit', async () => {
    const db = getDb();
    const queryKey = buildPlaceQueryKey({ queryText: 'Cached Cafe', city: 'Chongqing', country: 'CN' });
    db.prepare(`
      INSERT INTO place_resolution_cache (
        query_key, query_text, city, country, provider, provider_id, name, address,
        lat, lng, coordinate_system, confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queryKey, 'Cached Cafe', 'Chongqing', 'CN', 'manual_seed', 'cache-1',
      'Cached Cafe', 'Cached Address', 29.5, 106.5, 'wgs84', 0.9,
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const attempts = [];
    await resolvePlace({
      queryText: 'Cached Cafe',
      city: 'Chongqing',
      country: 'CN',
      onAttempt: (record) => attempts.push(record),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: 'cache',
      networkRequests: 0,
      locationStatus: 'resolved',
      providerId: 'cache-1',
    });
  });

  it('emits records with escalated:true for the escalation Google call and escalated:false for the miss-fallback Google call', async () => {
    config.googlePlacesKey = 'test-google-key';

    // Escalation path: weak Nominatim hit, escalateWeakHit authorises a Google call
    // that also comes back weak (so it doesn't win and doesn't short-circuit).
    const escalationFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return {
          ok: true,
          json: async () => [{
            lat: '3.1000',
            lon: '101.2000',
            display_name: 'Random Diner, Somewhere Else, Malaysia',
            name: 'Random Diner',
            osm_type: 'node',
            osm_id: '999',
          }],
        };
      }
      return {
        ok: true,
        json: async () => ({
          places: [{
            id: 'ChIJ_still_unrelated',
            displayName: { text: 'Also Unrelated' },
            formattedAddress: 'Nowhere Near Kuala Lumpur',
            location: { latitude: 3.16, longitude: 101.71 },
            addressComponents: [{ longText: 'Malaysia', shortText: 'MY', types: ['country', 'political'] }],
          }],
        }),
      };
    });

    const escalationAttempts = [];
    await resolvePlace({
      queryText: 'Escalation Target',
      city: 'Kuala Lumpur',
      country: 'MY',
      escalateWeakHit: () => true,
      onAttempt: (record) => escalationAttempts.push(record),
    });

    const escalationGoogleAttempt = escalationAttempts.find((a) => a.provider === 'google_places');
    expect(escalationGoogleAttempt).toMatchObject({ escalated: true, networkRequests: 1 });
    escalationFetch.mockRestore();

    // Miss-fallback path: Nominatim misses entirely, Google is consulted as the
    // ordinary fallback (no escalateWeakHit involved).
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('nominatim')) {
        return { ok: true, json: async () => [] };
      }
      return {
        ok: true,
        json: async () => ({
          places: [{
            id: 'ChIJ_fallback_place',
            displayName: { text: 'Fallback Place' },
            formattedAddress: '1 Fallback Place, Kuala Lumpur, Malaysia',
            location: { latitude: 3.15, longitude: 101.7 },
            addressComponents: [{ longText: 'Malaysia', shortText: 'MY', types: ['country', 'political'] }],
          }],
        }),
      };
    });

    const fallbackAttempts = [];
    await resolvePlace({
      queryText: 'Fallback Place',
      city: 'Kuala Lumpur',
      country: 'MY',
      onAttempt: (record) => fallbackAttempts.push(record),
    });

    const fallbackGoogleAttempt = fallbackAttempts.find((a) => a.provider === 'google_places');
    expect(fallbackGoogleAttempt).toMatchObject({ escalated: false, networkRequests: 1 });
  });

  it('does not let a throwing onAttempt callback break resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
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
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await resolvePlace({
      queryText: 'Throwing Attempt Place',
      city: 'Chongqing',
      country: 'CN',
      onAttempt: () => { throw new Error('onAttempt callback exploded'); },
    });

    expect(result).toMatchObject({ provider: 'nominatim', resolvedName: 'Jiefangbei' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// Plan 26 W3.3 (F-26-12 correction): the naive staleness test only retries a cached
// 'unresolved' row over the network. A weak 'estimated' cached hit — one of the two
// largest failure classes in the unverified corpus — would replay the cache forever
// without refreshCache. This is the regression test for the whole of W3.3.
describe('resolvePlace — refreshCache (opt-in scoped cache bypass, W3.3)', () => {
  it('issues a live Nominatim request against a cached estimated row when refreshCache is true, and zero requests without it', async () => {
    const db = getDb();
    const queryKey = buildPlaceQueryKey({ queryText: 'Weak Estimated Hit', city: 'Ipoh', country: 'MY' });
    db.prepare(`
      INSERT INTO place_resolution_cache (
        query_key, query_text, city, country, provider, provider_id, name, address,
        lat, lng, coordinate_system, confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queryKey, 'Weak Estimated Hit', 'Ipoh', 'MY', 'nominatim', 'node:5',
      'Weak Estimated Hit', 'Somewhere, Ipoh, Malaysia', 4.5, 101.0, 'wgs84', 0.55,
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '4.597479',
        lon: '101.090106',
        display_name: 'Weak Estimated Hit, Ipoh, Malaysia',
        name: 'Weak Estimated Hit',
        osm_type: 'relation',
        osm_id: '123',
      }],
    });

    const withoutRefresh = await resolvePlace({ queryText: 'Weak Estimated Hit', city: 'Ipoh', country: 'MY' });
    expect(withoutRefresh).toMatchObject({ locationStatus: 'estimated', provider: 'nominatim' });
    expect(fetchMock).not.toHaveBeenCalled();

    const withRefresh = await resolvePlace({
      queryText: 'Weak Estimated Hit',
      city: 'Ipoh',
      country: 'MY',
      refreshCache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(withRefresh).toMatchObject({
      lat: 4.597479,
      lng: 101.090106,
      provider: 'nominatim',
    });
  });
});

// F-26-23: classifyNameMatch's city half used to compare via normalizeText, which
// preserves spaces, while a Discovery destination's free-text display_name can be
// spaced arbitrarily ('kualalumpur', 'Chong Qing'). That made the city half fail even
// when the provider's name/address came back byte-identical, permanently capping 106
// production rows at estimated/0.55. The fix reuses canonicalGeoKey (the same folding
// the geography-identity layer already uses to treat 'Kuala Lumpur' and 'kualalumpur'
// as one destination) for the city comparison only.
//
// The fold is boundary-aware on the ADDRESS side, and the Anshan case below is why:
// folding separators out of the whole address string makes 'Xi'an, Shanxi, China'
// contain 'anshan', which would hand the real city Anshan a false 'resolved' in an
// unrelated province — the same wrongly-Verified failure W2.1 closed on the Google
// path, manufactured across two unrelated address components.
describe('resolvePlace — city-match folding (F-26-23)', () => {

  it('does NOT resolve when the city only appears by straddling two unrelated address components', async () => {
    // 'Anshan' is a real city. Folding all separators out of "Xi'an, Shanxi, China" gives
    // 'xianshanxichina', which CONTAINS 'anshan' — so a whole-string fold would
    // label an Anshan query resolved/0.9 against an address 1,500 km away. The
    // match must align to the address's own word boundaries.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '34.3416',
        lon: '108.9398',
        display_name: "Bell Tower, Xi'an, Shanxi, China",
        name: 'Bell Tower',
        osm_type: 'way',
        osm_id: '999',
      }],
    });

    const result = await resolvePlace({
      queryText: 'Bell Tower',
      city: 'Anshan',
      country: 'CN',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'estimated', confidence: 0.55 });
  });

  it('still matches a city that is the prefix of a single address token', async () => {
    // Guards the opposite over-tightening: requiring whole-run equality alone would
    // break 'Chengdu' against a 'Chengdushi' address component.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '30.6570',
        lon: '104.0658',
        display_name: 'Wuhou Shrine, Chengdushi, Sichuan, China',
        name: 'Wuhou Shrine',
        osm_type: 'way',
        osm_id: '1000',
      }],
    });

    const result = await resolvePlace({
      queryText: 'Wuhou Shrine',
      city: 'Chengdu',
      country: 'CN',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'resolved', confidence: 0.78 });
  });

  it('resolves when the caller city is the unspaced production form ("kualalumpur") and the name matches exactly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '3.1390',
        lon: '101.6869',
        display_name: 'Islamic Arts Museum Malaysia, Kuala Lumpur, Malaysia',
        name: 'Islamic Arts Museum Malaysia',
        osm_type: 'way',
        osm_id: '111',
      }],
    });

    const result = await resolvePlace({
      queryText: 'Islamic Arts Museum Malaysia',
      city: 'kualalumpur',
      country: 'MY',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'resolved', confidence: 0.78 });
  });

  it('resolves when the caller city has extra internal spacing ("Chong Qing") and the name matches exactly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '29.5630',
        lon: '106.5516',
        display_name: 'Jiefangbei, Chongqing, China',
        name: 'Jiefangbei',
        osm_type: 'node',
        osm_id: '222',
      }],
    });

    const result = await resolvePlace({
      queryText: 'Jiefangbei',
      city: 'Chong Qing',
      country: 'CN',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'resolved', confidence: 0.78 });
  });

  it('still resolves a well-formed city ("Shanghai") with an exact name match, unchanged by the fold', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '31.2323',
        lon: '121.4762',
        display_name: 'The Bund, Shanghai, China',
        name: 'The Bund',
        osm_type: 'way',
        osm_id: '333',
      }],
    });

    const result = await resolvePlace({
      queryText: 'The Bund',
      city: 'Shanghai',
      country: 'CN',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'resolved', confidence: 0.78 });
  });

  it('still classifies estimated when the name matches exactly but the address is in a genuinely different city (regression guard)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '1.3521',
        lon: '103.8198',
        display_name: 'The Bund, Singapore, Singapore',
        name: 'The Bund',
        osm_type: 'way',
        osm_id: '444',
      }],
    });

    const result = await resolvePlace({
      queryText: 'The Bund',
      city: 'Shanghai',
      country: 'CN',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'estimated', confidence: 0.55 });
  });

  it('stays vacuously true (resolved) when no city is given at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{
        lat: '29.5630',
        lon: '106.5516',
        display_name: 'Jiefangbei, Chongqing, China',
        name: 'Jiefangbei',
        osm_type: 'node',
        osm_id: '555',
      }],
    });

    const result = await resolvePlace({
      queryText: 'Jiefangbei',
      city: null,
      country: 'CN',
      preferNominatim: true,
    });

    expect(result).toMatchObject({ locationStatus: 'resolved', confidence: 0.78 });
  });
});
