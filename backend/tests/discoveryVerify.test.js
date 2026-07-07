import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// vi.hoisted is required because vi.mock factories run before this file's own
// import statements (ES module imports are hoisted ahead of other top-level
// code) — a plain top-level const would still be in the TDZ when the factory runs.
const { mockResolvePlace } = vi.hoisted(() => ({ mockResolvePlace: vi.fn() }));
vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: mockResolvePlace,
}));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { config } from '../src/config.js';
import { getOrCreateDestination, insertPlaces } from '../src/db/discoveryCatalogue.js';
import {
  enqueueForVerification,
  waitForVerificationDrain,
  __resetDiscoveryVerifyForTests,
} from '../src/services/discoveryVerify.js';

let tmpDir;
let originalRatingEnrichment;
let originalBudget;

function resolvedHit(overrides = {}) {
  return {
    lat: 35.0, lng: 135.0, coordinateSystem: 'wgs84', coordinateSource: 'manual_lookup',
    locationStatus: 'resolved', confidence: 0.9, resolvedName: 'Resolved Name', resolvedAddress: 'Some Address',
    providerId: 'osm:node/123', provider: 'nominatim', countryCode: 'JP',
    businessStatus: null, rating: null, ratingCount: null,
    ...overrides,
  };
}

function unresolvedHit(overrides = {}) {
  return {
    lat: null, lng: null, coordinateSystem: 'unknown', coordinateSource: null,
    locationStatus: 'unresolved', confidence: 0, resolvedName: null, resolvedAddress: null,
    providerId: null, provider: 'unresolved', countryCode: null,
    businessStatus: null, rating: null, ratingCount: null,
    ...overrides,
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-discovery-verify-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetDiscoveryVerifyForTests();
  originalRatingEnrichment = config.discoveryRatingEnrichment;
  originalBudget = config.discoveryResolverDailyBudget;
  config.discoveryRatingEnrichment = false;
  config.discoveryResolverDailyBudget = 500;
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
});

afterEach(() => {
  config.discoveryRatingEnrichment = originalRatingEnrichment;
  config.discoveryResolverDailyBudget = originalBudget;
});

function makeDestination(overrides = {}) {
  const db = getDb();
  return getOrCreateDestination(db, {
    cityKey: 'verifytest', countryCode: 'JP', displayName: 'Verifytest', ...overrides,
  });
}

function insertOne(destId, overrides = {}) {
  const db = getDb();
  const [row] = insertPlaces(db, destId, [{
    category: 'culture', name: 'Test Place', description: 'd', ...overrides,
  }], 0);
  return row;
}

describe('discoveryVerify — pipeline fixtures', () => {
  it('a real place resolves to verified with provider id and coordinates', async () => {
    const dest = makeDestination();
    const place = insertOne(dest.id, { name: 'Fushimi Inari' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ providerId: 'osm:node/999', lat: 34.9, lng: 135.7 }));

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('verified');
    expect(updated.provider_place_id).toBe('osm:node/999');
    expect(updated.lat).toBe(34.9);
    expect(updated.lng).toBe(135.7);
    expect(updated.verified_at).not.toBeNull();
  });

  it('a fabricated place with no confident resolver hit ends up unverified', async () => {
    const dest = makeDestination();
    const place = insertOne(dest.id, { name: 'Totally Made Up Place' });
    mockResolvePlace.mockResolvedValue(unresolvedHit());

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');
    expect(updated.provider_place_id).toBeNull();
  });

  it('a resolved place reported CLOSED_PERMANENTLY is verified but suppressed at ingest', async () => {
    const dest = makeDestination();
    const place = insertOne(dest.id, { name: 'Shuttered Cafe' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ businessStatus: 'CLOSED_PERMANENTLY' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('verified');
    expect(updated.status).toBe('suppressed');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('suppressed'),
      place.id, place.name,
    );
    errorSpy.mockRestore();
  });

  it('a local-name duplicate of an already-verified item is place-id deduped (archived, aliases merged)', async () => {
    const dest = makeDestination();
    const original = insertOne(dest.id, { name: 'Kinkaku-ji', aliases: ['Golden Pavilion'] });
    const duplicate = insertOne(dest.id, { name: 'Kinkakuji Temple', localName: '金閣寺', aliases: ['Rokuon-ji'] });

    mockResolvePlace.mockResolvedValue(resolvedHit({ providerId: 'google:ChIJshared' }));

    await enqueueForVerification(getDb(), dest.id, [original.id]);
    await waitForVerificationDrain(dest.id);
    await enqueueForVerification(getDb(), dest.id, [duplicate.id]);
    await waitForVerificationDrain(dest.id);

    const originalAfter = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(original.id);
    const duplicateAfter = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(duplicate.id);

    expect(originalAfter.status).toBe('active');
    expect(duplicateAfter.status).toBe('archived');
    const mergedAliases = JSON.parse(originalAfter.aliases_json);
    expect(mergedAliases).toEqual(expect.arrayContaining(['Golden Pavilion', 'Rokuon-ji']));
  });
});

describe('discoveryVerify — country matching', () => {
  it('rejects a resolved hit whose country does not match the destination country', async () => {
    const dest = makeDestination({ cityKey: 'verifytest2', countryCode: 'JP' });
    const place = insertOne(dest.id, { name: 'Wrong Country Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ countryCode: 'CN' }));

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');
  });

  it('accepts a resolved hit for an unknown-country destination regardless of resolved country', async () => {
    const dest = makeDestination({ cityKey: 'verifytest3', countryCode: '' });
    const place = insertOne(dest.id, { name: 'Any Country Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ countryCode: 'FR' }));

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('verified');
  });
});

describe('discoveryVerify — rating enrichment flag', () => {
  it('never writes rating/rating_count when DISCOVERY_RATING_ENRICHMENT is off', async () => {
    config.discoveryRatingEnrichment = false;
    const dest = makeDestination({ cityKey: 'verifytest4' });
    const place = insertOne(dest.id, { name: 'Rated Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ rating: 4.5, ratingCount: 200 }));

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.rating).toBeNull();
    expect(updated.rating_count).toBeNull();
  });

  it('writes rating/rating_count when DISCOVERY_RATING_ENRICHMENT is on', async () => {
    config.discoveryRatingEnrichment = true;
    const dest = makeDestination({ cityKey: 'verifytest5' });
    const place = insertOne(dest.id, { name: 'Rated Place 2' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ rating: 4.5, ratingCount: 200 }));

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.rating).toBe(4.5);
    expect(updated.rating_count).toBe(200);
  });
});

describe('discoveryVerify — worker failure isolation', () => {
  it('a thrown lookup marks only that item unverified, and does not stop the rest of the queue', async () => {
    const dest = makeDestination({ cityKey: 'verifytest6' });
    const good1 = insertOne(dest.id, { name: 'Good One' });
    const bad = insertOne(dest.id, { name: 'Boom Place' });
    const good2 = insertOne(dest.id, { name: 'Good Two' });

    mockResolvePlace.mockImplementation(async ({ queryText }) => {
      if (queryText === 'Boom Place') throw new Error('exploded');
      return resolvedHit({ providerId: `osm:node/${queryText}` });
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueueForVerification(getDb(), dest.id, [good1.id, bad.id, good2.id]);
    await waitForVerificationDrain(dest.id);
    errorSpy.mockRestore();

    const rows = getDb().prepare('SELECT * FROM discovery_places WHERE id IN (?, ?, ?)').all(good1.id, bad.id, good2.id);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[good1.id].provenance).toBe('verified');
    expect(byId[bad.id].provenance).toBe('unverified');
    expect(byId[good2.id].provenance).toBe('verified');
  });
});

describe('discoveryVerify — resolver-call daily budget', () => {
  it('marks items beyond the budget as pending (not unverified), and logs the exhaustion once', async () => {
    config.discoveryResolverDailyBudget = 2;
    const dest = makeDestination({ cityKey: 'verifytest7' });
    const places = [1, 2, 3, 4, 5].map((n) => insertOne(dest.id, { name: `Budget Place ${n}` }));

    mockResolvePlace.mockResolvedValue(unresolvedHit());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueForVerification(getDb(), dest.id, places.map((p) => p.id));
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(2);

    const rows = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ? ORDER BY id').all(dest.id);
    const pendingCount = rows.filter((r) => r.provenance === 'pending').length;
    const unverifiedCount = rows.filter((r) => r.provenance === 'unverified').length;
    // The 2 items processed within budget got a real (unresolved) lookup and
    // landed at the terminal 'unverified' state; the 3 beyond the cap never
    // got a resolver call at all and are deferred as 'pending'.
    expect(unverifiedCount).toBe(2);
    expect(pendingCount).toBe(3);

    const exhaustionLogs = errorSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('daily resolver budget exhausted'));
    expect(exhaustionLogs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('retries pending items on the next enqueue call once budget is available again', async () => {
    config.discoveryResolverDailyBudget = 1;
    const dest = makeDestination({ cityKey: 'verifytest8' });
    const places = [insertOne(dest.id, { name: 'First' }), insertOne(dest.id, { name: 'Second' })];

    mockResolvePlace.mockResolvedValue(resolvedHit());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueueForVerification(getDb(), dest.id, places.map((p) => p.id));
    await waitForVerificationDrain(dest.id);
    errorSpy.mockRestore();

    const afterFirstDrain = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ? ORDER BY id').all(dest.id);
    expect(afterFirstDrain.filter((r) => r.provenance === 'pending')).toHaveLength(1);

    // Raise the budget and enqueue again (with no new ids) — the pending row
    // should be picked back up and retried.
    config.discoveryResolverDailyBudget = 500;
    await enqueueForVerification(getDb(), dest.id, []);
    await waitForVerificationDrain(dest.id);

    const afterSecondDrain = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ? ORDER BY id').all(dest.id);
    expect(afterSecondDrain.filter((r) => r.provenance === 'pending')).toHaveLength(0);
    expect(afterSecondDrain.filter((r) => r.provenance === 'verified')).toHaveLength(2);
  });
});
