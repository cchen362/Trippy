import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { __resetPlaceResolverForTests, buildPlaceQueryKey, resolvePlace } from '../src/services/placeResolver.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-resolver-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
  __resetPlaceResolverForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
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

  it('uses exact discovery cache matches before Nominatim and caches the result', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO global_discovery_cache (destination, result_json)
      VALUES (?, ?)
    `).run('chongqing', JSON.stringify([
      {
        category: 'essentials',
        items: [
          { name: 'Tiny Test Museum', description: 'A test place.', lat: 29.61, lng: 106.51 },
        ],
      },
    ]));
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const result = await resolvePlace({ queryText: 'Tiny Test Museum', city: 'Chongqing', country: 'CN' });
    const cached = db.prepare('SELECT * FROM place_resolution_cache WHERE query_text = ?').get('Tiny Test Museum');

    expect(result).toMatchObject({
      lat: 29.61,
      lng: 106.51,
      coordinateSystem: 'wgs84',
      coordinateSource: 'discovery',
      locationStatus: 'estimated',
      provider: 'discovery_cache',
    });
    expect(cached.provider).toBe('discovery_cache');
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

  it('canonicalizes spaced China city names for Nominatim queries', async () => {
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
    expect(url.searchParams.get('q')).toBe("People's Liberation Monument, Chongqing");
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
