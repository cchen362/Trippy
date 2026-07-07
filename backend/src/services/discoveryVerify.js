// Post-generation verification worker (Plan 7, Wave 2). After the discover route
// inserts freshly generated places into discovery_places, it enqueues their ids
// here for asynchronous, best-effort verification against the real-places
// resolver (services/placeResolver.js). This module owns none of the SSE
// response — enqueueForVerification is fire-and-forget from the route's point
// of view (it returns a promise the route never awaits) and every failure mode
// here is isolated so a stuck or throwing lookup can never affect serving.
//
// Queue model: one in-process, serial FIFO queue per destination_id. Multiple
// enqueue calls for the same destination append to the same queue; a queue
// already draining keeps draining rather than starting a second concurrent
// drain (Nominatim's 1 req/s throttle lives inside placeResolver.js itself —
// this module must not add a second, possibly-conflicting throttle).
//
// Persistence of "pending" across restarts: pending rows are a DB fact, not an
// in-memory one (the in-memory queue is lost on restart). The simplest correct
// way to eventually retry them without a separate startup scan is: every call
// to enqueueForVerification first re-collects any of this destination's rows
// still marked provenance='pending' and folds them back into the queue ahead of
// the new ids. So a pending row gets retried the next time anyone browses (or
// "show more"s) that destination — no separate background scan needed.

import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { resolvePlace } from './placeResolver.js';

// destinationId -> { items: number[], draining: boolean, promise: Promise }
const queues = new Map();

// Daily resolver-call budget (Trust criteria: default 500/day, guards cost —
// this is a call-count cap, not a rate limiter; Nominatim's own 1 req/s pacing
// is unaffected and lives in placeResolver.js). Tracked in-memory per UTC day;
// re-read from config on every check so tests can mutate config directly.
let budgetDate = null;
let budgetUsed = 0;
let budgetExhaustedLoggedForDate = null;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function resetBudgetIfNewDay() {
  const today = todayUtc();
  if (budgetDate !== today) {
    budgetDate = today;
    budgetUsed = 0;
  }
}

function hasResolverBudget() {
  resetBudgetIfNewDay();
  return budgetUsed < config.discoveryResolverDailyBudget;
}

function consumeResolverBudget() {
  resetBudgetIfNewDay();
  budgetUsed += 1;
}

function logBudgetExhaustedOnce() {
  resetBudgetIfNewDay();
  if (budgetExhaustedLoggedForDate === budgetDate) return;
  budgetExhaustedLoggedForDate = budgetDate;
  console.error(
    '[discoveryVerify] daily resolver budget exhausted (%d) — remaining items left pending',
    config.discoveryResolverDailyBudget,
  );
}

// Wraps a single resolvePlace call with the budget gate. Returns `null` as a
// sentinel meaning "budget exhausted, did not call the resolver" — distinct
// from a legitimate resolution object (including an unresolved one).
async function budgetedResolve(args) {
  if (!hasResolverBudget()) return null;
  consumeResolverBudget();
  return resolvePlace(args);
}

// A confident hit: locationStatus is 'resolved' (not 'estimated'/'unresolved'),
// and when both the resolved country and destination country are known they
// match case-insensitively. Unknown-country destinations, or a resolution that
// didn't report a country, always pass the country check (nothing to compare).
function isConfidentHit(resolution, destination) {
  if (!resolution || resolution.locationStatus !== 'resolved') return false;
  const destCountry = destination.country_code || '';
  const resolvedCountry = resolution.countryCode || '';
  if (!destCountry || !resolvedCountry) return true;
  return destCountry.toLowerCase() === resolvedCountry.toLowerCase();
}

// Merges the newcomer's provider_place_id duplicate into the earlier (lower
// id) active row holding the same identity: union-merge aliases, archive the
// newcomer. "Archived" (not "suppressed") — a place-id duplicate isn't
// necessarily a bad place, just a repeat we've already recorded once.
function dedupeByProviderId(db, destinationId, newRowId, providerId) {
  const earlier = db.prepare(`
    SELECT * FROM discovery_places
    WHERE destination_id = ? AND provider_place_id = ? AND status = 'active' AND id != ?
    ORDER BY id ASC LIMIT 1
  `).get(destinationId, providerId, newRowId);
  if (!earlier) return;

  const newRow = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(newRowId);
  if (!newRow) return;

  const earlierAliases = JSON.parse(earlier.aliases_json || '[]');
  const newAliases = JSON.parse(newRow.aliases_json || '[]');
  const merged = [...new Set([...earlierAliases, ...newAliases])];

  db.prepare('UPDATE discovery_places SET aliases_json = ? WHERE id = ?')
    .run(JSON.stringify(merged), earlier.id);
  db.prepare(`UPDATE discovery_places SET status = 'archived' WHERE id = ?`).run(newRowId);

  console.error(
    '[discoveryVerify] archived duplicate place=%s (kept=%s) provider_place_id=%s',
    newRowId, earlier.id, providerId,
  );
}

function applyVerified(db, row, resolution, destination) {
  const suppressedForClosure = resolution.businessStatus === 'CLOSED_PERMANENTLY';
  const newStatus = suppressedForClosure ? 'suppressed' : row.status;

  // Rating fields are only ever populated under DISCOVERY_RATING_ENRICHMENT — the
  // Google field-mask tier that returns rating/userRatingCount costs more, so this
  // stays flag-guarded and reviewable rather than always-on. When the flag is off,
  // the rating/rating_count columns are left untouched (null, as for every row today).
  if (config.discoveryRatingEnrichment) {
    db.prepare(`
      UPDATE discovery_places
      SET provenance = 'verified', provider_place_id = ?, lat = ?, lng = ?,
          business_status = ?, rating = ?, rating_count = ?, status = ?, verified_at = datetime('now')
      WHERE id = ?
    `).run(
      resolution.providerId ?? null, resolution.lat ?? null, resolution.lng ?? null,
      resolution.businessStatus ?? null, resolution.rating ?? null, resolution.ratingCount ?? null,
      newStatus, row.id,
    );
  } else {
    db.prepare(`
      UPDATE discovery_places
      SET provenance = 'verified', provider_place_id = ?, lat = ?, lng = ?,
          business_status = ?, status = ?, verified_at = datetime('now')
      WHERE id = ?
    `).run(
      resolution.providerId ?? null, resolution.lat ?? null, resolution.lng ?? null,
      resolution.businessStatus ?? null, newStatus, row.id,
    );
  }

  if (suppressedForClosure) {
    console.error(
      '[discoveryVerify] suppressed place=%s name=%s reason=closed_permanently',
      row.id, row.name,
    );
  }

  if (resolution.providerId) {
    dedupeByProviderId(db, destination.id, row.id, resolution.providerId);
  }
}

// Verifies one place. Returns { budgetExhausted } so the drain loop knows
// whether to stop and mark the remainder of the queue pending.
async function verifyOne(db, id, destination) {
  const row = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(id);
  // Row may have been archived/suppressed (e.g. by a category-cap sweep or a
  // report) between enqueue and drain — nothing left to verify.
  if (!row || row.status !== 'active') return { budgetExhausted: false };

  const aliases = JSON.parse(row.aliases_json || '[]');
  const baseArgs = {
    city: destination.display_name,
    country: destination.country_code || undefined,
    aliases,
    // Rating fields are a per-call opt-in on resolvePlace (placeResolver.js) — this
    // is the one caller that sets it, gated on the same flag applyVerified checks
    // before persisting rating/rating_count, so booking/stop resolution (which never
    // sets this) is never affected even when the flag is globally on.
    includeRatingFields: config.discoveryRatingEnrichment,
  };

  try {
    let resolution = await budgetedResolve({ queryText: row.name, ...baseArgs });
    if (resolution === null) return { budgetExhausted: true };

    if (!isConfidentHit(resolution, destination) && row.local_name) {
      const fallback = await budgetedResolve({ queryText: row.local_name, ...baseArgs });
      if (fallback === null) return { budgetExhausted: true };
      resolution = fallback;
    }

    if (isConfidentHit(resolution, destination)) {
      applyVerified(db, row, resolution, destination);
    } else {
      db.prepare(`UPDATE discovery_places SET provenance = 'unverified' WHERE id = ?`).run(id);
    }
  } catch (error) {
    // CLAUDE.md: never swallow errors silently — log loudly, then isolate the
    // failure to this one item so the rest of the queue keeps draining.
    console.error(
      '[discoveryVerify] resolution failed place=%s name=%s: %s',
      id, row.name, error.message,
    );
    db.prepare(`UPDATE discovery_places SET provenance = 'unverified' WHERE id = ?`).run(id);
  }

  return { budgetExhausted: false };
}

function markPending(db, ids) {
  if (!ids.length) return;
  const stmt = db.prepare(`UPDATE discovery_places SET provenance = 'pending' WHERE id = ? AND status = 'active'`);
  for (const id of ids) stmt.run(id);
}

async function drainQueue(db, destinationId, queue) {
  const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationId);
  if (!destination) {
    queue.items.length = 0;
    return;
  }

  while (queue.items.length > 0) {
    const id = queue.items.shift();
    const outcome = await verifyOne(db, id, destination);

    if (outcome.budgetExhausted) {
      const remainder = [id, ...queue.items.splice(0, queue.items.length)];
      markPending(db, remainder);
      logBudgetExhaustedOnce();
      return;
    }
  }
}

// Enqueues placeIds (typically the ids returned by insertPlaces for a fresh
// generation batch) for verification against destinationId's city/country
// context, plus any of this destination's rows still stuck at
// provenance='pending' from a prior budget-exhausted drain. Returns the
// drain's promise for tests that want determinism — the route must NEVER
// await this; it enqueues and returns immediately.
export function enqueueForVerification(db, destinationId, placeIds = []) {
  const pendingRows = db.prepare(
    `SELECT id FROM discovery_places WHERE destination_id = ? AND status = 'active' AND provenance = 'pending'`,
  ).all(destinationId).map((r) => r.id);

  const combined = [...new Set([...pendingRows, ...placeIds])];

  let queue = queues.get(destinationId);
  if (!queue) {
    queue = { items: [], draining: false, promise: Promise.resolve() };
    queues.set(destinationId, queue);
  }
  for (const id of combined) {
    if (!queue.items.includes(id)) queue.items.push(id);
  }

  if (combined.length === 0) return queue.promise;

  if (!queue.draining) {
    queue.draining = true;
    queue.promise = drainQueue(db, destinationId, queue)
      .catch((error) => {
        console.error('[discoveryVerify] drain loop crashed destination=%s: %s', destinationId, error.message);
      })
      .finally(() => {
        queue.draining = false;
      });
  }

  return queue.promise;
}

// Test helper: await the in-flight (or most recently started) drain for a
// destination so assertions can run deterministically after verification
// settles, instead of racing a fire-and-forget background promise.
export function waitForVerificationDrain(destinationId) {
  return queues.get(destinationId)?.promise ?? Promise.resolve();
}

export function __resetDiscoveryVerifyForTests() {
  queues.clear();
  budgetDate = null;
  budgetUsed = 0;
  budgetExhaustedLoggedForDate = null;
}
