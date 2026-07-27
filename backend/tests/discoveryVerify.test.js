import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// vi.hoisted is required because vi.mock factories run before this file's own
// import statements (ES module imports are hoisted ahead of other top-level
// code) — a plain top-level const would still be in the TDZ when the factory runs.
const { mockResolvePlace } = vi.hoisted(() => ({ mockResolvePlace: vi.fn() }));

// Plan 26 W3.1: the real resolvePlace invokes its `onAttempt` opt-in once per
// provider interaction (see placeResolver.js's emitAttempt/baseAttemptRecord).
// This mock is entirely test-controlled (mockResolvePlace), so it must honour
// that contract itself, or discoveryVerify.js's actual-request-cost budget
// accounting (W3.2) would never see any spend and every old "gates at N
// calls" assertion below would silently stop meaning anything.
//
// Default behaviour: if the test's mock (via mockResolvedValue/mockImplementation)
// does NOT call onAttempt itself, this wrapper auto-emits exactly one attempt
// record per call (networkRequests: 1, mirroring the returned resolution's own
// fields) — preserving the pre-W3 "each call is worth 1 unit" semantics that
// most fixtures rely on. A test that needs precise control over attempt
// records/network-request counts (e.g. simulating several Nominatim variants)
// calls the `onAttempt` it's handed directly from inside its own
// mockImplementation; when it does, this wrapper's auto-emit is skipped.
vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: async (args) => {
    const collected = [];
    const trackedOnAttempt = typeof args.onAttempt === 'function'
      ? (record) => { collected.push(record); args.onAttempt(record); }
      : null;

    const resolution = await mockResolvePlace({ ...args, onAttempt: trackedOnAttempt });

    if (trackedOnAttempt && collected.length === 0 && resolution) {
      trackedOnAttempt({
        provider: resolution.provider ?? null,
        queryVariant: args.queryText,
        networkRequests: 1,
        escalated: false,
        locationStatus: resolution.locationStatus ?? null,
        confidence: resolution.confidence ?? null,
        resolvedName: resolution.resolvedName ?? null,
        resolvedCountry: resolution.countryCode ?? null,
        error: null,
      });
    }

    return resolution;
  },
}));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { config } from '../src/config.js';
import { getOrCreateDestination, insertPlaces, recordVerificationAttempts, listVerificationAttempts } from '../src/db/discoveryCatalogue.js';
import {
  enqueueForVerification,
  enqueueForReverification,
  waitForVerificationDrain,
  getDiscoveryBudgetStatus,
  __resetDiscoveryVerifyForTests,
} from '../src/services/discoveryVerify.js';

let tmpDir;
let originalRatingEnrichment;
let originalBudget;
let originalEscalationBudget;
let originalReverifyBudget;
let originalReverifyPerDestination;

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
  originalBudget = config.discoveryResolverDailyRequestBudget;
  originalEscalationBudget = config.discoveryEscalationDailyBudget;
  originalReverifyBudget = config.discoveryReverifyDailyRequestBudget;
  originalReverifyPerDestination = config.discoveryReverifyPerDestinationDaily;
  config.discoveryRatingEnrichment = false;
  config.discoveryResolverDailyRequestBudget = 1000;
  config.discoveryEscalationDailyBudget = 50;
  config.discoveryReverifyDailyRequestBudget = 150;
  config.discoveryReverifyPerDestinationDaily = 25;
  getDb().prepare('DELETE FROM discovery_verification_attempts').run();
  getDb().prepare('DELETE FROM discovery_places').run();
  getDb().prepare('DELETE FROM discovery_destinations').run();
});

afterEach(() => {
  config.discoveryRatingEnrichment = originalRatingEnrichment;
  config.discoveryResolverDailyRequestBudget = originalBudget;
  config.discoveryEscalationDailyBudget = originalEscalationBudget;
  config.discoveryReverifyDailyRequestBudget = originalReverifyBudget;
  config.discoveryReverifyPerDestinationDaily = originalReverifyPerDestination;
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

// Test helper: insertPlaces always stamps 'pending' (Plan 26 W1.2) — flips a
// row straight to the terminal 'unverified' state so reverification tests can
// exercise it without running the full verify pipeline first.
function markUnverified(placeId) {
  getDb().prepare(`UPDATE discovery_places SET provenance = 'unverified' WHERE id = ?`).run(placeId);
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

    const attemptRow = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(place.id);
    expect(attemptRow.reason).toBe('country_mismatch');
    expect(attemptRow.outcome).toBe('unverified');
    expect(attemptRow.returned_country).toBe('CN');
  });

  // Plan 26 W2.2 (F-26-8) narrowed this from "accepts a resolved hit for an
  // unknown-country destination regardless of resolved country" to landing
  // unverified. Plan 26 W3.1 then gave the narrowing's evidence a persisted
  // home: this test used to assert a console.error line (there was no schema
  // surface yet); it now asserts the discovery_verification_attempts row
  // instead — same assertion in spirit (the resolved country is recorded),
  // stronger in kind (a durable row, not a grep target).
  it('records the resolved country and lands unverified for an unknown-country destination with a resolved-country hit', async () => {
    const dest = makeDestination({ cityKey: 'verifytest3', countryCode: '' });
    const place = insertOne(dest.id, { name: 'Any Country Place' });
    mockResolvePlace.mockResolvedValue(resolvedHit({ countryCode: 'FR' }));

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');

    const attemptRow = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(place.id);
    expect(attemptRow).toBeDefined();
    expect(attemptRow.reason).toBe('empty_destination_country');
    expect(attemptRow.outcome).toBe('unverified');
    expect(attemptRow.returned_country).toBe('FR');
    expect(attemptRow.source_field).toBe('name');
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

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');

    // Still recorded, with a null returned_country standing in for the absent
    // resolved country (Plan 26 W3.1 — see comment above).
    const attemptRow = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(place.id);
    expect(attemptRow.reason).toBe('empty_destination_country');
    expect(attemptRow.returned_country).toBeNull();
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

    const badAttempt = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(bad.id);
    expect(badAttempt.reason).toBe('resolver_error');
    expect(badAttempt.outcome).toBe('unverified');
  });
});

describe('discoveryVerify — per-attempt persistence (Plan 26 W3.1)', () => {
  it('persists one attempt row per emitted attempt record for a failed verification', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-attempts1' });
    const place = insertOne(dest.id, { name: 'Multi Variant Place' });

    mockResolvePlace.mockImplementation(async ({ onAttempt }) => {
      onAttempt({ provider: 'nominatim', queryVariant: 'Multi Variant Place', networkRequests: 1, locationStatus: 'unresolved', confidence: null, resolvedName: null, resolvedCountry: null, error: null });
      onAttempt({ provider: 'nominatim', queryVariant: 'Multi Variant Place (Alias)', networkRequests: 1, locationStatus: 'unresolved', confidence: null, resolvedName: null, resolvedCountry: null, error: null });
      onAttempt({ provider: 'nominatim', queryVariant: 'Multi Variant Place (Alias) [Detail]', networkRequests: 1, locationStatus: 'unresolved', confidence: null, resolvedName: null, resolvedCountry: null, error: null });
      return unresolvedHit();
    });

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    const updated = getDb().prepare('SELECT * FROM discovery_places WHERE id = ?').get(place.id);
    expect(updated.provenance).toBe('unverified');

    const rows = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ? ORDER BY id').all(place.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.reason).toBe('no_result');
      expect(row.outcome).toBe('unverified');
      expect(row.source_field).toBe('name');
    }
    expect(rows.map((r) => r.query_variant)).toEqual([
      'Multi Variant Place', 'Multi Variant Place (Alias)', 'Multi Variant Place (Alias) [Detail]',
    ]);
  });

  it('debits the actual networkRequests reported, not a flat 1 per lookup', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-attempts2' });
    const place = insertOne(dest.id, { name: 'Three Requests Place' });

    mockResolvePlace.mockImplementation(async ({ onAttempt }) => {
      onAttempt({ provider: 'nominatim', queryVariant: 'v1', networkRequests: 1, locationStatus: 'unresolved' });
      onAttempt({ provider: 'nominatim', queryVariant: 'v2', networkRequests: 1, locationStatus: 'unresolved' });
      onAttempt({ provider: 'nominatim', queryVariant: 'v3', networkRequests: 1, locationStatus: 'unresolved' });
      return unresolvedHit();
    });

    const before = getDiscoveryBudgetStatus().resolverRequests.used;
    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);
    const after = getDiscoveryBudgetStatus().resolverRequests.used;

    expect(after - before).toBe(3);
  });

  it('still writes exactly one row (with null provider fields) when budget runs out before any provider is touched', async () => {
    config.discoveryResolverDailyRequestBudget = 0;
    const dest = makeDestination({ cityKey: 'verifytest-attempts3' });
    const place = insertOne(dest.id, { name: 'Never Attempted Place' });

    await enqueueForVerification(getDb(), dest.id, [place.id]);
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).not.toHaveBeenCalled();
    const rows = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').all(place.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('budget_exhausted');
    expect(rows[0].outcome).toBe('unverified');
    expect(rows[0].provider).toBeNull();
    expect(rows[0].network_requests).toBe(0);
  });

  // Regression pin for a production defect in scripts/discoveryReverify.js: the
  // script marked its start with new Date().toISOString() and passed that as
  // `since`. attempted_at is written by SQLite's datetime('now') as
  // 'YYYY-MM-DD HH:MM:SS', and the filter compares TEXT, where ' ' (0x20) sorts
  // before 'T' (0x54) — so an ISO marker excluded every row the run had just
  // written and the summary always reported zero work. A `since` taken from
  // datetime('now') must see rows recorded after it.
  it('filters by `since` using SQLite datetime format, not JS ISO format', () => {
    const dest = makeDestination({ cityKey: 'verifytest-attempts-since' });
    const place = insertOne(dest.id, { name: 'Since Target' });
    const db = getDb();

    const sqliteSince = db.prepare("SELECT datetime('now') AS t").get().t;
    const isoSince = new Date().toISOString();

    recordVerificationAttempts(db, {
      placeId: place.id,
      destinationId: dest.id,
      sourceField: 'name',
      outcome: 'unverified',
      reason: 'no_result',
      attempts: [{ provider: 'nominatim', queryVariant: 'q', networkRequests: 1, locationStatus: 'unresolved' }],
    });

    expect(listVerificationAttempts(db, { placeId: place.id, since: sqliteSince, limit: 100 })).toHaveLength(1);
    // Documents WHY the script must not use an ISO marker — this is the bug shape.
    expect(listVerificationAttempts(db, { placeId: place.id, since: isoSince, limit: 100 })).toHaveLength(0);
  });

  it('prunes so at most the 10 most recent attempt rows per place survive', () => {
    const dest = makeDestination({ cityKey: 'verifytest-attempts4' });
    const place = insertOne(dest.id, { name: 'Prune Target' });
    const db = getDb();

    for (let i = 0; i < 15; i += 1) {
      recordVerificationAttempts(db, {
        placeId: place.id,
        destinationId: dest.id,
        sourceField: 'name',
        outcome: 'unverified',
        reason: 'no_result',
        attempts: [{ provider: 'nominatim', queryVariant: `v${i}`, networkRequests: 1, locationStatus: 'unresolved' }],
      });
    }

    const rows = listVerificationAttempts(db, { placeId: place.id, limit: 100 });
    expect(rows).toHaveLength(10);
    // Most recent 10 survive — the pruned set keeps the highest-id (latest) rows.
    expect(rows.map((r) => r.query_variant).sort()).toEqual(
      ['v10', 'v11', 'v12', 'v13', 'v14', 'v5', 'v6', 'v7', 'v8', 'v9'].sort(),
    );
  });
});

describe('discoveryVerify — resolver-call daily budget', () => {
  it('marks items beyond the budget as pending (not unverified), and logs the exhaustion once', async () => {
    config.discoveryResolverDailyRequestBudget = 2;
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
      typeof call[0] === 'string' && call[0].includes('daily resolver REQUEST budget exhausted'));
    expect(exhaustionLogs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('retries pending items on the next enqueue call once budget is available again', async () => {
    config.discoveryResolverDailyRequestBudget = 1;
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
    config.discoveryResolverDailyRequestBudget = 1000;
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
    config.discoveryResolverDailyRequestBudget = 1000;
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

describe('discoveryVerify — enqueueForReverification (Plan 26 W3.3, F-26-12)', () => {
  it('passes refreshCache:true to resolvePlace — the anti-no-op property', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-reverify1' });
    const place = insertOne(dest.id, { name: 'Reverify Refresh Place' });
    markUnverified(place.id);
    mockResolvePlace.mockResolvedValue(resolvedHit());

    await enqueueForReverification(getDb(), dest.id);
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(1);
    expect(mockResolvePlace.mock.calls[0][0].refreshCache).toBe(true);
  });

  it('does not pick up provenance=pending or provenance=verified rows', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-reverify2' });
    const pendingPlace = insertOne(dest.id, { name: 'Still Pending Place' });
    const verifiedPlace = insertOne(dest.id, { name: 'Already Verified Place' });
    getDb().prepare(`UPDATE discovery_places SET provenance = 'verified' WHERE id = ?`).run(verifiedPlace.id);
    const unverifiedPlace = insertOne(dest.id, { name: 'Terminal Unverified Place' });
    markUnverified(unverifiedPlace.id);

    mockResolvePlace.mockResolvedValue(resolvedHit());
    await enqueueForReverification(getDb(), dest.id);
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(1);
    expect(mockResolvePlace.mock.calls[0][0].queryText).toBe('Terminal Unverified Place');

    const pendingAfter = getDb().prepare('SELECT provenance FROM discovery_places WHERE id = ?').get(pendingPlace.id);
    const verifiedAfter = getDb().prepare('SELECT provenance FROM discovery_places WHERE id = ?').get(verifiedPlace.id);
    expect(pendingAfter.provenance).toBe('pending');
    expect(verifiedAfter.provenance).toBe('verified');
  });

  it('writes reverification=1 on attempt rows produced during re-verification', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-reverify3' });
    const place = insertOne(dest.id, { name: 'Reverify Marked Place' });
    markUnverified(place.id);
    mockResolvePlace.mockResolvedValue(unresolvedHit());

    await enqueueForReverification(getDb(), dest.id);
    await waitForVerificationDrain(dest.id);

    const row = getDb().prepare('SELECT * FROM discovery_verification_attempts WHERE place_id = ?').get(place.id);
    expect(row.reverification).toBe(1);
  });

  it('never writes provenance=pending — a re-verified row stays unverified until an attempt completes', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-reverify3b' });
    const place = insertOne(dest.id, { name: 'Stays Unverified Place' });
    markUnverified(place.id);
    mockResolvePlace.mockResolvedValue(unresolvedHit());

    await enqueueForReverification(getDb(), dest.id);
    await waitForVerificationDrain(dest.id);

    const row = getDb().prepare('SELECT provenance FROM discovery_places WHERE id = ?').get(place.id);
    expect(row.provenance).toBe('unverified');
  });

  it('respects the per-destination daily row cap', async () => {
    config.discoveryReverifyPerDestinationDaily = 2;
    const dest = makeDestination({ cityKey: 'verifytest-reverify4' });
    const places = [1, 2, 3, 4, 5].map((n) => insertOne(dest.id, { name: `Cap Place ${n}` }));
    places.forEach((p) => markUnverified(p.id));

    mockResolvePlace.mockResolvedValue(unresolvedHit());
    await enqueueForReverification(getDb(), dest.id);
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(2);
    const stillUnverified = getDb().prepare(
      `SELECT COUNT(*) c FROM discovery_places WHERE destination_id = ? AND provenance = 'unverified'`,
    ).get(dest.id).c;
    // All 5 remain 'unverified' — the 2 admitted got a real (unresolved)
    // re-check and landed back at 'unverified'; the 3 declined were never
    // touched and are also still 'unverified'.
    expect(stillUnverified).toBe(5);
  });

  it('respects the global re-verification request budget', async () => {
    config.discoveryReverifyDailyRequestBudget = 2;
    config.discoveryReverifyPerDestinationDaily = 25;
    const dest = makeDestination({ cityKey: 'verifytest-reverify5' });
    const places = [1, 2, 3, 4, 5].map((n) => insertOne(dest.id, { name: `Budget Place ${n}` }));
    places.forEach((p) => markUnverified(p.id));

    mockResolvePlace.mockResolvedValue(unresolvedHit());
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await enqueueForReverification(getDb(), dest.id);
    await waitForVerificationDrain(dest.id);
    errorSpy.mockRestore();

    // Only 2 requests' worth of budget existed — the live gate inside
    // budgetedResolve (mirroring the main resolver budget) stops the drain
    // there even though all 5 were admitted at enqueue time (per-destination
    // cap only bounds row COUNT, not request COST).
    expect(mockResolvePlace).toHaveBeenCalledTimes(2);
  });

  it('respects the limit option', async () => {
    const dest = makeDestination({ cityKey: 'verifytest-reverify6' });
    const places = [1, 2, 3].map((n) => insertOne(dest.id, { name: `Limit Place ${n}` }));
    places.forEach((p) => markUnverified(p.id));

    mockResolvePlace.mockResolvedValue(unresolvedHit());
    await enqueueForReverification(getDb(), dest.id, { limit: 1 });
    await waitForVerificationDrain(dest.id);

    expect(mockResolvePlace).toHaveBeenCalledTimes(1);
  });
});
