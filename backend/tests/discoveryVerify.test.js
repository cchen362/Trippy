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
let originalEscalationBudget;

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
  originalEscalationBudget = config.discoveryEscalationDailyBudget;
  config.discoveryRatingEnrichment = false;
  config.discoveryResolverDailyBudget = 500;
  config.discoveryEscalationDailyBudget = 50;
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
});

afterEach(() => {
  config.discoveryRatingEnrichment = originalRatingEnrichment;
  config.discoveryResolverDailyBudget = originalBudget;
  config.discoveryEscalationDailyBudget = originalEscalationBudget;
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

  // Plan 26 W2.2 (F-26-8): this test used to be named "accepts a resolved hit
  // for an unknown-country destination regardless of resolved country" and
  // asserted `provenance === 'verified'`. That old behaviour was pinned on
  // purpose at the time (there was nothing to compare against, so any
  // resolved country was let through) — it is deliberately narrowed here:
  // with no destination country there is nothing to check identity against,
  // so "verified" would be a claim the system cannot support. The affected
  // production population is exactly the two empty-country test destinations
  // (北京, 南疆) scheduled for deletion in W5.1 — this narrowing costs no
  // real user-visible verified content today.
  it('records the resolved country and lands unverified for an unknown-country destination with a resolved-country hit', async () => {
    const dest = makeDestination({ cityKey: 'verifytest3', countryCode: '' });
    const place = insertOne(dest.id, { name: 'Any Country Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ countryCode: 'FR' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');

    const recordingLogs = errorSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('empty-country destination — cannot country-check'));
    expect(recordingLogs).toHaveLength(1);
    expect(recordingLogs[0]).toEqual(expect.arrayContaining([place.id, place.name, dest.id, dest.display_name, 'FR']));
    errorSpy.mockRestore();
  });

  it('lands unverified for an unknown-country destination even when the resolution reports no country at all', async () => {
    const dest = makeDestination({ cityKey: 'verifytest3b', countryCode: '' });
    const place = insertOne(dest.id, { name: 'No Country Reported Place' });
    // The W2.2 narrowing is deliberately uniform across both empty-destination
    // cases. A hit that reports NO country is weaker evidence than one that
    // reports a mismatching country, so passing this while failing the test
    // above would be exactly backwards — an empty-country destination simply
    // cannot produce a country-checked 'verified' row.
    mockResolvePlace.mockResolvedValue(resolvedHit({ countryCode: null }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');

    // Still recorded, with 'none' standing in for the absent resolved country.
    const recordingLogs = errorSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('empty-country destination — cannot country-check'));
    expect(recordingLogs).toHaveLength(1);
    expect(recordingLogs[0]).toEqual(expect.arrayContaining([place.id, place.name, 'none']));
    errorSpy.mockRestore();
  });

  it('still accepts a resolution with no country at all when the destination country is known (unchanged)', async () => {
    const dest = makeDestination({ cityKey: 'verifytest3c', countryCode: 'JP' });
    const place = insertOne(dest.id, { name: 'Known Dest No Country Reported' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ countryCode: null }));

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

describe('discoveryVerify — escalation daily sub-budget (Plan 26 W2.3, D-26-4)', () => {
  it('passes an escalateWeakHit function to every resolvePlace call', async () => {
    const dest = makeDestination({ cityKey: 'verifytest10' });
    const place = insertOne(dest.id, { name: 'Escalation Wiring Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit());

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(1);
    expect(typeof mockResolvePlace.mock.calls[0][0].escalateWeakHit).toBe('function');
  });

  it('caps escalateWeakHit at the configured ceiling and logs exhaustion exactly once', async () => {
    config.discoveryEscalationDailyBudget = 2;
    const dest = makeDestination({ cityKey: 'verifytest11' });
    const place = insertOne(dest.id, { name: 'Escalation Ceiling Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    // The real escalation trigger (a weak Nominatim hit + a configured Google
    // key) lives in the mocked-out resolver, so we drive the sub-budget
    // directly through the function baseArgs actually handed to resolvePlace.
    const escalateWeakHit = mockResolvePlace.mock.calls[0][0].escalateWeakHit;
    expect(escalateWeakHit()).toBe(true);
    expect(escalateWeakHit()).toBe(true);
    expect(escalateWeakHit()).toBe(false);
    expect(escalateWeakHit()).toBe(false);

    const exhaustionLogs = errorSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('daily escalation sub-budget exhausted'));
    expect(exhaustionLogs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('is independent of the resolver lookup budget in both directions', async () => {
    config.discoveryEscalationDailyBudget = 1;
    config.discoveryResolverDailyBudget = 500;
    const dest = makeDestination({ cityKey: 'verifytest12' });
    const places = [
      insertOne(dest.id, { name: 'Independence One' }),
      insertOne(dest.id, { name: 'Independence Two' }),
      insertOne(dest.id, { name: 'Independence Three' }),
    ];
    mockResolvePlace.mockResolvedValue(resolvedHit());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await enqueueForVerification(getDb(), dest.id, places.map((p) => p.id));
    await waitForVerificationDrain(dest.id);

    // Exhaust the escalation sub-budget directly (ceiling of 1) after the
    // fact — this must not have consumed or been gated by resolver lookups.
    const escalateWeakHit = mockResolvePlace.mock.calls[0][0].escalateWeakHit;
    expect(escalateWeakHit()).toBe(true);
    expect(escalateWeakHit()).toBe(false);

    // All 3 resolver lookups ran to completion (verified) — the exhausted
    // escalation sub-budget did not reduce resolver lookups performed.
    expect(mockResolvePlace).toHaveBeenCalledTimes(3);
    const rows = getDb().prepare('SELECT * FROM discovery_places WHERE destination_id = ?').all(dest.id);
    expect(rows.every((r) => r.provenance === 'verified')).toBe(true);
    errorSpy.mockRestore();
  });
});

describe('discoveryVerify — in-flight dedup across concurrent enqueue calls (Plan 26 W1.2 follow-on)', () => {
  it('does not re-resolve a row that is already in-flight when enqueueForVerification is called again mid-drain', async () => {
    const dest = makeDestination({ cityKey: 'verifytest9' });
    const place = insertOne(dest.id, { name: 'Slow Place' });

    let releaseFirst;
    const firstCallGate = new Promise((resolve) => { releaseFirst = resolve; });
    mockResolvePlace.mockImplementation(async () => {
      await firstCallGate;
      return resolvedHit();
    });

    // Kick off the drain — insertPlaces already stamped the row 'pending', and
    // it is now shifted off queue.items and awaiting resolvePlace (still
    // provenance='pending' in the DB, since verifyOne only flips it once the
    // resolver call settles).
    const drainPromise = enqueueForVerification(getDb(), dest.id, [place.id]);

    // Simulate the W1.4 change (enqueueForVerification firing once per
    // completed category instead of once per generation): a second call
    // arrives for the same destination with no new ids, while the first row
    // is still mid-flight. Without the in-flight exclusion this would
    // re-collect the pending row and add a duplicate resolvePlace call.
    // Not awaited — real callers (the route) never await this either, and
    // its returned promise is the same in-flight drain, which won't settle
    // until releaseFirst() below runs.
    enqueueForVerification(getDb(), dest.id, []);

    releaseFirst();
    await drainPromise;
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(1);
    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('verified');
  });
});
