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
      coordinateSystem: 'gcj02',
      coordinateSource: 'curated',
      locationStatus: 'user_confirmed',
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
      coordinateSystem: 'unknown',
      coordinateSource: 'discovery',
      locationStatus: 'resolved',
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
