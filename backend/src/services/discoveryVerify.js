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
//
// Plan 26 W3.3 adds a second admission path, enqueueForReverification, which
// feeds terminal `unverified` rows (never retried by the path above) through
// this SAME queue/drainQueue machinery, tagged via queue.reverifyIds so
// verifyOne knows to pass refreshCache:true and stamp reverification=1 on the
// attempt rows it writes. See enqueueForReverification below for the caps.

import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { resolvePlace } from './placeResolver.js';
import { recordVerificationAttempts } from '../db/discoveryCatalogue.js';

// destinationId -> { items: number[], draining: boolean, promise: Promise,
//   inFlightId: number|null, reverifyIds: Set<number> }
const queues = new Map();

function getOrCreateQueue(destinationId) {
  let queue = queues.get(destinationId);
  if (!queue) {
    queue = { items: [], draining: false, promise: Promise.resolve(), inFlightId: null, reverifyIds: new Set() };
    queues.set(destinationId, queue);
  }
  return queue;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Plan 26 W3.2 (F-26-6): daily cap on discovery-verification RESOLVER
// REQUESTS — real provider HTTP calls, not lookups (see config.js for why the
// unit changed). Tracked in-memory per UTC day; re-read from config on every
// check so tests can mutate config directly.
//
// The gate still has to run BEFORE a resolvePlace call (you cannot know a
// lookup's real request cost in advance — it depends on how many Nominatim
// variants get tried and whether Google gets consulted). The DEBIT after the
// call is the actual `networkRequests` summed from the attempt records the
// resolver reported via onAttempt, not a flat 1. This means a single lookup
// can overshoot the daily ceiling by a few requests — that is a deliberate,
// bounded property of gate-before/debit-after accounting, not an attempt at
// an exact ceiling.
let budgetDate = null;
let budgetUsed = 0;
let budgetExhaustedLoggedForDate = null;

function resetBudgetIfNewDay() {
  const today = todayUtc();
  if (budgetDate !== today) {
    budgetDate = today;
    budgetUsed = 0;
  }
}

function hasResolverBudget() {
  resetBudgetIfNewDay();
  return budgetUsed < config.discoveryResolverDailyRequestBudget;
}

function consumeResolverBudget(networkRequests) {
  resetBudgetIfNewDay();
  budgetUsed += networkRequests;
}

function logBudgetExhaustedOnce() {
  resetBudgetIfNewDay();
  if (budgetExhaustedLoggedForDate === budgetDate) return;
  budgetExhaustedLoggedForDate = budgetDate;
  console.error(
    '[discoveryVerify] daily resolver REQUEST budget exhausted (%d) — remaining items left pending',
    config.discoveryResolverDailyRequestBudget,
  );
}

// Plan 26 W2.3 (D-26-4): a second, independent daily counter bounding GOOGLE
// PLACES REQUESTS spent escalating past a weak Nominatim hit during
// verification. Mirrors budgetDate/budgetUsed/budgetExhaustedLoggedForDate
// above exactly (same reset-on-new-UTC-day semantics, same todayUtc()) but is
// tracked separately so escalation spend can never eat into or be masked by
// the resolver lookup budget, and so its exhaustion is logged distinctly.
let escalationBudgetDate = null;
let escalationBudgetUsed = 0;
let escalationBudgetExhaustedLoggedForDate = null;

function resetEscalationBudgetIfNewDay() {
  const today = todayUtc();
  if (escalationBudgetDate !== today) {
    escalationBudgetDate = today;
    escalationBudgetUsed = 0;
  }
}

function logEscalationBudgetExhaustedOnce() {
  resetEscalationBudgetIfNewDay();
  if (escalationBudgetExhaustedLoggedForDate === escalationBudgetDate) return;
  escalationBudgetExhaustedLoggedForDate = escalationBudgetDate;
  console.error(
    '[discoveryVerify] daily escalation sub-budget exhausted (%d) — weak Nominatim hits left unescalated',
    config.discoveryEscalationDailyBudget,
  );
}

// Passed to placeResolver.js as the `escalateWeakHit` opt-in (see baseArgs
// below): called at most once per resolvePlace call, and only at the moment
// escalation would actually fire, so this counts real Google requests, not
// attempts. Returns true and consumes one unit when today's sub-budget has
// room; returns false otherwise, logging exhaustion once per UTC day.
function tryConsumeEscalationBudget() {
  resetEscalationBudgetIfNewDay();
  if (escalationBudgetUsed >= config.discoveryEscalationDailyBudget) {
    logEscalationBudgetExhaustedOnce();
    return false;
  }
  escalationBudgetUsed += 1;
  return true;
}

// Plan 26 W3.3 (F-26-12): a THIRD, independent daily counter bounding
// RE-VERIFICATION spend — reaching terminal `unverified` rows that ordinary
// verification never revisits. Same gate-before/debit-actual-after shape as
// the main resolver budget above (re-verification issues real, uncached
// provider requests — that's the entire point of refreshCache:true — so its
// cost is exactly as unpredictable in advance). Kept on its own counter so a
// re-verification run can never crowd out same-day fresh-generation
// verification, or vice versa.
let reverifyBudgetDate = null;
let reverifyBudgetUsed = 0;
let reverifyBudgetExhaustedLoggedForDate = null;

function resetReverifyBudgetIfNewDay() {
  const today = todayUtc();
  if (reverifyBudgetDate !== today) {
    reverifyBudgetDate = today;
    reverifyBudgetUsed = 0;
  }
}

function hasReverifyBudget() {
  resetReverifyBudgetIfNewDay();
  return reverifyBudgetUsed < config.discoveryReverifyDailyRequestBudget;
}

function consumeReverifyBudget(networkRequests) {
  resetReverifyBudgetIfNewDay();
  reverifyBudgetUsed += networkRequests;
}

function logReverifyBudgetExhaustedOnce() {
  resetReverifyBudgetIfNewDay();
  if (reverifyBudgetExhaustedLoggedForDate === reverifyBudgetDate) return;
  reverifyBudgetExhaustedLoggedForDate = reverifyBudgetDate;
  console.error(
    '[discoveryVerify] daily re-verification REQUEST budget exhausted (%d) — remaining terminal-unverified rows left for another day',
    config.discoveryReverifyDailyRequestBudget,
  );
}

// Plan 26 W3.3: the STRUCTURAL half of "throttled so it can never consume a
// day's budget in one destination" (plan line 194) — the global counter above
// is the cost half, this is the per-destination ROW ceiling (how many
// terminal-unverified rows one destination may be admitted for
// re-verification per UTC day), tracked in-memory per destination. Without
// this, one destination's backlog could exhaust the global re-verification
// budget by itself and starve every other destination for the rest of the
// day, even though the global counter alone would technically still be
// "correctly" bounding total spend.
const reverifyDestinationCounts = new Map(); // destinationId -> { date, count }

function admitReverifyForDestination(destinationId) {
  const today = todayUtc();
  const entry = reverifyDestinationCounts.get(destinationId);
  const state = (!entry || entry.date !== today) ? { date: today, count: 0 } : entry;
  if (state.count >= config.discoveryReverifyPerDestinationDaily) {
    reverifyDestinationCounts.set(destinationId, state);
    return false;
  }
  state.count += 1;
  reverifyDestinationCounts.set(destinationId, state);
  return true;
}

// Wraps a single resolvePlace call with the budget gate appropriate to the
// caller. `collector` is the array `onAttempt` pushes into for this one call
// — used both to persist attempt rows (verifyOne) and to compute the actual
// request cost debited here. Returns `null` as a sentinel meaning "budget
// exhausted, did not call the resolver" — distinct from a legitimate
// resolution object (including an unresolved one).
async function budgetedResolve(args, collector, { reverification = false } = {}) {
  const hasBudget = reverification ? hasReverifyBudget() : hasResolverBudget();
  if (!hasBudget) return null;

  const resolution = await resolvePlace(args);

  const requestsSpent = collector.reduce((sum, attempt) => sum + (attempt.networkRequests || 0), 0);
  if (reverification) consumeReverifyBudget(requestsSpent);
  else consumeResolverBudget(requestsSpent);

  return resolution;
}

// Fixed reason vocabulary — mirrors migrations/032_discovery_verification_attempts.sql.
const REASON = {
  OK: 'ok',
  NO_RESULT: 'no_result',
  WEAK_MATCH: 'weak_match',
  COUNTRY_MISMATCH: 'country_mismatch',
  EMPTY_DESTINATION_COUNTRY: 'empty_destination_country',
  RESOLVER_ERROR: 'resolver_error',
  BUDGET_EXHAUSTED: 'budget_exhausted',
};

// A confident hit: locationStatus is 'resolved' (not 'estimated'/'unresolved'),
// and the destination's country is known and matches the resolved country
// case-insensitively. A resolution that didn't report a country still passes
// when the DESTINATION's country is known (nothing to compare — unchanged,
// pre-existing behaviour that W2 deliberately does not narrow).
//
// F-26-8 (Plan 26 W2.2): an EMPTY destination country no longer earns a free
// pass, in EITHER direction. With no destination country there is nothing to
// check identity against, so returning true here would be a "verified" claim
// the system cannot support — it previously let a vague query attach to any
// resolved country and receive the product's strongest trust label. Note the
// check is uniform on purpose: a hit that reports no country at all is weaker
// evidence than one that reports a mismatching country, so passing the former
// while failing the latter would be exactly backwards. Such hits now fall
// through to the caller's terminal 'unverified' path.
//
// Production cost of the narrowing is nil: the only two empty-country
// destinations are 北京 and 南疆 (the owner's own CJK free-text test
// destinations), which hold 162 active rows and ZERO verified rows today, and
// are deleted outright in W5.1 (D-26-3). W4.5 then blocks shared-catalogue
// creation for unknown-country destinations, so this path stops being
// reachable at all.
//
// Plan 26 W3.1: this used to end in a console.error recording the resolved
// country for the empty-destination-country case, because no schema surface
// existed yet to persist it. It now returns a { confident, reason,
// resolvedCountry } result that verifyOne persists as a
// discovery_verification_attempts row (reason='empty_destination_country') —
// the log line is gone because the row is strictly more durable evidence.
function classifyHit(resolution, destination) {
  if (!resolution || resolution.locationStatus === 'unresolved') {
    return { confident: false, reason: REASON.NO_RESULT, resolvedCountry: resolution?.countryCode || null };
  }
  if (resolution.locationStatus !== 'resolved') {
    return { confident: false, reason: REASON.WEAK_MATCH, resolvedCountry: resolution.countryCode || null };
  }

  const destCountry = destination.country_code || '';
  const resolvedCountry = resolution.countryCode || '';

  if (!destCountry) {
    return { confident: false, reason: REASON.EMPTY_DESTINATION_COUNTRY, resolvedCountry: resolvedCountry || null };
  }
  if (!resolvedCountry) {
    return { confident: true, reason: REASON.OK, resolvedCountry: null };
  }
  if (destCountry.toLowerCase() === resolvedCountry.toLowerCase()) {
    return { confident: true, reason: REASON.OK, resolvedCountry };
  }
  return { confident: false, reason: REASON.COUNTRY_MISMATCH, resolvedCountry };
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

// Builds the shared per-call opt-ins passed to resolvePlace for one lookup.
// `collector` receives one pushed record per provider interaction (W3.1's
// onAttempt contract — see placeResolver.js). `refreshCache` is only ever
// true for a reverification lookup (W3.3, F-26-12 correction): without it a
// re-check would replay the cached failure forever and never issue a real
// network call, making the entire re-verification path a no-op that looks
// like it works.
function buildResolveArgs(destination, aliases, collector, { reverification }) {
  return {
    city: destination.display_name,
    country: destination.country_code || undefined,
    aliases,
    // Rating fields are a per-call opt-in on resolvePlace (placeResolver.js) — this
    // is the one caller that sets it, gated on the same flag applyVerified checks
    // before persisting rating/rating_count, so booking/stop resolution (which never
    // sets this) is never affected even when the flag is globally on.
    includeRatingFields: config.discoveryRatingEnrichment,
    // F-26-5: verification is background work sharing the module-global Nominatim
    // gate with interactive callers (add-stop, booking-linked resolution, day-
    // override country inference). Opt into 'background' priority so an
    // interactive lookup can overtake a draining verification queue instead of
    // waiting behind it (placeResolver.js waitForNominatimSlot).
    priority: 'background',
    // Plan 26 W2.3 (D-26-4): discoveryVerify is the ONLY permitted caller of this
    // opt-in. It draws from its own escalation sub-budget (config.discoveryEscalationDailyBudget),
    // separate from the resolver-lookup budget above, so Google spend past a weak
    // Nominatim hit is bounded by construction. Stop/booking resolution never sets
    // this, so the escalation branch stays unreachable from them (Plan 24 stays closed).
    escalateWeakHit: tryConsumeEscalationBudget,
    // Plan 26 W3.1: pushes one record per provider interaction into this lookup's
    // own collector array — verifyOne persists it and also sums networkRequests
    // from it to debit the correct budget counter.
    onAttempt: (attempt) => collector.push(attempt),
    // Plan 26 W3.3: see the function comment above.
    refreshCache: reverification === true,
  };
}

// recordVerificationAttempts writes a real foreign-key-constrained row
// (place_id/destination_id reference discovery_places/discovery_destinations).
// The place row is guaranteed to exist when verifyOne STARTS (its own guard),
// but verifyOne awaits a resolver call in between — a concurrent delete of
// that row (an admin migration, or in tests, a fast-teardown race against a
// still-in-flight fire-and-forget drain) can make it gone by the time this
// write runs. The actual verification outcome (the UPDATE to discovery_places)
// is a no-op WHERE clause in that case and already tolerates it; this history
// write must tolerate it the same way — logged loudly, never rethrown, so a
// lost attempt-history row for a place that's already gone can never crash
// the rest of the queue (verifyOne's whole reason for existing, per its own
// try/catch below, is isolating exactly this kind of single-item failure).
// Attempt telemetry is a side channel: it must never take down a verification
// drain. But "catch every DB error here" would hide precisely the schema and
// vocabulary bugs this table exists to expose, so the one EXPECTED failure is
// handled by name instead of by blanket rescue.
//
// That failure is the place row disappearing between enqueue and the write.
// verifyOne re-reads the row up front, but resolvePlace is awaited afterwards,
// and discovery_places rows are deleted by destination-scoped migrations
// (020/021/024 today, W5.1's 北京/南疆 delete next) whose ON DELETE CASCADE
// makes the place_id foreign key unsatisfiable through no fault of this write.
// Checking existence first means a vanished place is reported as the ordinary
// event it is — and anything that still reaches the catch below is a genuine
// defect, logged as UNEXPECTED so it reads as one.
function persistAttempts(db, args) {
  const stillExists = db.prepare('SELECT 1 FROM discovery_places WHERE id = ?').get(args.placeId);
  if (!stillExists) {
    console.error(
      '[discoveryVerify] place=%s deleted mid-verification — attempt telemetry dropped',
      args.placeId,
    );
    return;
  }
  try {
    recordVerificationAttempts(db, args);
  } catch (error) {
    console.error(
      '[discoveryVerify] UNEXPECTED verification-attempt write failure place=%s destination=%s: %s',
      args.placeId, args.destinationId, error.message,
    );
  }
}

// Persists the outcome of one lookup (either the row.name attempt or the
// row.local_name fallback) as one or more discovery_verification_attempts
// rows, then returns { confident, reason }.
function recordLookup(db, { placeId, destinationId, sourceField, resolution, destination, reverification, collector }) {
  const { confident, reason } = classifyHit(resolution, destination);
  persistAttempts(db, {
    placeId,
    destinationId,
    sourceField,
    outcome: confident ? 'verified' : 'unverified',
    reason,
    reverification,
    attempts: collector,
  });
  return { confident, reason };
}

// Verifies one place. Returns { budgetExhausted } so the drain loop knows
// whether to stop and mark the remainder of the queue pending.
async function verifyOne(db, id, destination, { reverification = false } = {}) {
  const row = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(id);
  // Row may have been archived/suppressed (e.g. by a category-cap sweep or a
  // report) between enqueue and drain — nothing left to verify.
  if (!row || row.status !== 'active') return { budgetExhausted: false };

  const aliases = JSON.parse(row.aliases_json || '[]');

  // Tracks which lookup is currently in flight so the catch block below knows
  // which source_field/collector to persist an attempt row against if
  // resolvePlace throws mid-lookup.
  let currentField = 'name';
  let currentCollector = [];

  try {
    currentField = 'name';
    currentCollector = [];
    let resolution = await budgetedResolve(
      { queryText: row.name, ...buildResolveArgs(destination, aliases, currentCollector, { reverification }) },
      currentCollector,
      { reverification },
    );
    if (resolution === null) {
      persistAttempts(db, {
        placeId: id, destinationId: destination.id, sourceField: 'name',
        outcome: 'unverified', reason: REASON.BUDGET_EXHAUSTED, reverification, attempts: [],
      });
      return { budgetExhausted: true };
    }

    let { confident } = recordLookup(db, {
      placeId: id, destinationId: destination.id, sourceField: 'name',
      resolution, destination, reverification, collector: currentCollector,
    });

    if (!confident && row.local_name) {
      currentField = 'local_name';
      currentCollector = [];
      const fallback = await budgetedResolve(
        { queryText: row.local_name, ...buildResolveArgs(destination, aliases, currentCollector, { reverification }) },
        currentCollector,
        { reverification },
      );
      if (fallback === null) {
        persistAttempts(db, {
          placeId: id, destinationId: destination.id, sourceField: 'local_name',
          outcome: 'unverified', reason: REASON.BUDGET_EXHAUSTED, reverification, attempts: [],
        });
        return { budgetExhausted: true };
      }
      resolution = fallback;
      const outcome = recordLookup(db, {
        placeId: id, destinationId: destination.id, sourceField: 'local_name',
        resolution, destination, reverification, collector: currentCollector,
      });
      confident = outcome.confident;
    }

    if (confident) {
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
    persistAttempts(db, {
      placeId: id, destinationId: destination.id, sourceField: currentField,
      outcome: 'unverified', reason: REASON.RESOLVER_ERROR, reverification, attempts: currentCollector,
    });
    db.prepare(`UPDATE discovery_places SET provenance = 'unverified' WHERE id = ?`).run(id);
  }

  return { budgetExhausted: false };
}

function markPending(db, ids) {
  if (!ids.length) return;
  const stmt = db.prepare(`UPDATE discovery_places SET provenance = 'pending' WHERE id = ? AND status = 'active'`);
  for (const id of ids) stmt.run(id);
}

// Plan 26 W3.2: emits one structured budget-status line so production drains
// are legible without a code change — plan line 192 asks both counters be
// surfaced; this is where a drain (the thing that actually spends budget)
// reports them. Runs unconditionally at the end of drainQueue via the
// try/finally below, regardless of which exit path was taken.
function logBudgetStatus(destinationId) {
  const status = getDiscoveryBudgetStatus();
  console.error(
    '[discoveryVerify] budget status destination=%s date=%s resolverRequests=%d/%d escalationRequests=%d/%d reverifyRequests=%d/%d',
    destinationId, status.date,
    status.resolverRequests.used, status.resolverRequests.budget,
    status.escalationRequests.used, status.escalationRequests.budget,
    status.reverifyRequests.used, status.reverifyRequests.budget,
  );
}

async function drainQueue(db, destinationId, queue) {
  const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationId);
  if (!destination) {
    queue.items.length = 0;
    queue.reverifyIds.clear();
    return;
  }

  try {
    while (queue.items.length > 0) {
      const id = queue.items.shift();
      const isReverify = queue.reverifyIds.has(id);
      if (isReverify) queue.reverifyIds.delete(id);

      // Tracked so a concurrent enqueueForVerification call (now firing once per
      // completed category rather than once per generation) doesn't re-collect
      // this row from provenance='pending' and re-add it to the queue while it's
      // still mid-flight here — that would look it up twice and waste resolver
      // budget for no benefit (Plan 26 W1.2 follow-on bug).
      queue.inFlightId = id;
      const outcome = await verifyOne(db, id, destination, { reverification: isReverify });
      queue.inFlightId = null;

      if (outcome.budgetExhausted) {
        if (isReverify) {
          // Re-verification budget exhaustion only pauses reverify-tagged work —
          // it is a separate counter from the main resolver budget, so ordinary
          // items still queued behind it are unaffected and keep draining.
          // Reverify-tagged remainder rows are left exactly as they were
          // (already 'unverified'; never marked 'pending', which would make
          // enqueueForVerification re-collect and double-queue them) — they
          // stay eligible for the next enqueueForReverification call.
          logReverifyBudgetExhaustedOnce();
          const stillReverify = queue.items.filter((rid) => queue.reverifyIds.has(rid));
          for (const rid of stillReverify) queue.reverifyIds.delete(rid);
          queue.items = queue.items.filter((rid) => !stillReverify.includes(rid));
          continue;
        }
        const remainder = [id, ...queue.items.splice(0, queue.items.length)]
          .filter((rid) => !queue.reverifyIds.has(rid));
        markPending(db, remainder);
        logBudgetExhaustedOnce();
        return;
      }
    }
  } finally {
    logBudgetStatus(destinationId);
  }
}

// Enqueues placeIds (typically the ids returned by insertPlaces for a fresh
// generation batch) for verification against destinationId's city/country
// context, plus any of this destination's rows still stuck at
// provenance='pending' from a prior budget-exhausted drain. Returns the
// drain's promise for tests that want determinism — the route must NEVER
// await this; it enqueues and returns immediately.
export function enqueueForVerification(db, destinationId, placeIds = []) {
  const existingQueue = queues.get(destinationId);

  const pendingRows = db.prepare(
    `SELECT id FROM discovery_places WHERE destination_id = ? AND status = 'active' AND provenance = 'pending'`,
  ).all(destinationId)
    .map((r) => r.id)
    // Exclude the row the drain is currently resolving, if any — it's still
    // provenance='pending' in the DB (only flipped to verified/unverified once
    // verifyOne finishes) but is already in-flight, so re-collecting it here
    // would queue a second, wasted lookup for the same row.
    .filter((id) => id !== existingQueue?.inFlightId);

  const combined = [...new Set([...pendingRows, ...placeIds])];

  const queue = getOrCreateQueue(destinationId);
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

// Plan 26 W3.3 (F-26-12): the bounded re-verification path. enqueueForVerification
// above only ever re-collects provenance='pending' rows, so a row that was
// CHECKED and landed at the terminal 'unverified' state is never retried —
// this is that retry path, reaching exactly the population enqueueForVerification
// cannot. Selects active/unverified rows for one destination, oldest-attempt
// (or never-attempted) first, and feeds them through the SAME queue/drainQueue
// machinery as ordinary verification so it inherits serial-per-destination
// pacing, background priority, failure isolation, and in-flight de-duplication
// for free — this deliberately does not build a second queue.
//
// Three bounds hold simultaneously, but at two different moments:
//   1. discoveryReverifyDailyRequestBudget — the global COST ceiling. This
//      cannot be pre-filtered per candidate here: nothing admitted by one
//      enqueueForReverification call has drained yet, so budgetUsed would
//      read the same not-yet-debited value for every candidate in the loop
//      below and the check would be meaningless. It is instead gated LIVE,
//      per resolvePlace call, inside budgetedResolve during drainQueue —
//      exactly where the main resolver budget is already gated. The only
//      thing checked here, once, up front, is whether the budget is ALREADY
//      exhausted from earlier calls today, so an obviously-futile admission
//      doesn't happen and the exhaustion gets logged.
//   2. discoveryReverifyPerDestinationDaily — the per-destination ROW ceiling
//      admitted per UTC day. This one IS safe to check per-candidate here,
//      at enqueue time, because it counts rows admitted, not requests spent —
//      no async gap to race.
//   3. The caller's `limit`, if given.
// This is "throttled so it can never consume a day's budget in one
// destination" (plan line 194): the per-destination cap is the structural
// half (this function), the global counter is the cost half (budgetedResolve).
//
// Re-verification lookups pass refreshCache:true (see buildResolveArgs) — the
// F-26-12 correction: without it, `resolvePlace`'s cache short-circuit would
// replay the exact cached `estimated`/country-mismatched result forever,
// issue no network call, produce no new outcome, and W2.3's Google escalation
// (which sits after the cache short-circuit) would never fire either. A
// re-verification that does not bypass the cache is a no-op that looks like
// it works.
//
// Re-verified rows keep provenance='unverified' until an attempt completes —
// this function never writes provenance='pending' (that would make
// enqueueForVerification re-collect and double-queue them). Attempt rows
// written during re-verification carry reverification=1.
export function enqueueForReverification(db, destinationId, { limit } = {}) {
  const destination = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationId);
  if (!destination) return Promise.resolve();

  const candidates = db.prepare(`
    SELECT dp.id AS id, MAX(dva.attempted_at) AS last_attempt
    FROM discovery_places dp
    LEFT JOIN discovery_verification_attempts dva ON dva.place_id = dp.id
    WHERE dp.destination_id = ? AND dp.status = 'active' AND dp.provenance = 'unverified'
    GROUP BY dp.id
    ORDER BY last_attempt ASC, dp.id ASC
  `).all(destinationId);

  if (!hasReverifyBudget()) {
    logReverifyBudgetExhaustedOnce();
    return Promise.resolve();
  }

  const admitted = [];
  for (const candidate of candidates) {
    if (typeof limit === 'number' && admitted.length >= limit) break;
    if (!admitReverifyForDestination(destinationId)) break;
    admitted.push(candidate.id);
  }

  if (admitted.length === 0) return Promise.resolve();

  const queue = getOrCreateQueue(destinationId);
  for (const id of admitted) {
    queue.reverifyIds.add(id);
    if (!queue.items.includes(id)) queue.items.push(id);
  }

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

// Plan 26 W3.2/W3.4: exposes all three daily counters together so a caller
// (currently just the drainQueue log line below and discoveryReverify.js) can
// report the full budget picture in one read, without reaching into this
// module's private state.
export function getDiscoveryBudgetStatus() {
  resetBudgetIfNewDay();
  resetEscalationBudgetIfNewDay();
  resetReverifyBudgetIfNewDay();
  return {
    date: budgetDate,
    resolverRequests: { used: budgetUsed, budget: config.discoveryResolverDailyRequestBudget },
    escalationRequests: { used: escalationBudgetUsed, budget: config.discoveryEscalationDailyBudget },
    reverifyRequests: { used: reverifyBudgetUsed, budget: config.discoveryReverifyDailyRequestBudget },
  };
}

export function __resetDiscoveryVerifyForTests() {
  queues.clear();
  budgetDate = null;
  budgetUsed = 0;
  budgetExhaustedLoggedForDate = null;
  escalationBudgetDate = null;
  escalationBudgetUsed = 0;
  escalationBudgetExhaustedLoggedForDate = null;
  reverifyBudgetDate = null;
  reverifyBudgetUsed = 0;
  reverifyBudgetExhaustedLoggedForDate = null;
  reverifyDestinationCounts.clear();
}
