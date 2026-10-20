// Extracted generation pipeline (Plan 12 Wave 2): the co-pilot's G3 background
// generation kick (services/copilotGrounding.js) needs to fire the exact same
// generate/merge sequence routes/discovery.js's POST /:tripId/discover handler
// uses, but without depending on that route or its SSE plumbing (the kick runs
// detached from any request/response). This module is the route-independent
// core of that sequence — build exclusions, call discoverDestination, then
// flatten/insert/cap/enqueue/bump-counters — so there is exactly one place the
// sequence is implemented; the route calls this too.
import { discoverDestination, DISCOVERY_CATEGORIES } from './claude.js';
import { enqueueForVerification } from './discoveryVerify.js';
import {
  listExclusionNames,
  insertPlaces,
  enforceCategoryCap,
  incrementDailyGenerationCount,
} from '../db/discoveryCatalogue.js';

// D-33-1: a destination has at most one generation in flight. Concurrent requests (the
// /discover route or a co-pilot kick) join the running one, never start a second, and never
// spend the daily cap. Keyed by discovery_destinations.id; the registry is in-process, which
// is correct because the backend is a single process by design (the same assumption the
// provider budgets in config.js make).
const runningGenerations = new Map();

// D-35-2 (Plan 35 W2): what a running generation is doing, as the SSE status/thinking events report it.
// `deliveredCategories` is the delivery-ordered list of categories handed over so far; `writing` is the
// category the model is expected to be on next, taken from the LAST delivered one in the prompt's fixed
// order (not from the count), so it stays right if the model skips a category. `first` is true for a
// true first generation and false for a merge (stale refresh / show more).
export function generationProgress(deliveredCategories, first) {
  const distinct = new Set(deliveredCategories);
  const last = deliveredCategories.length ? deliveredCategories[deliveredCategories.length - 1] : null;
  const writing = last === null
    ? DISCOVERY_CATEGORIES[0]
    : (DISCOVERY_CATEGORIES[DISCOVERY_CATEGORIES.indexOf(last) + 1] ?? null);
  return { categoriesDone: distinct.size, writing, first: Boolean(first) };
}

// Returns null when nothing is generating for this destination, otherwise
// `{ settled, subscribe, progress }`. `settled` NEVER rejects: it resolves `{ ok: true }` when the
// generation finishes, or `{ ok: false, error }` when it throws, so a joiner can await it
// without a try/catch of its own. `subscribe(listener)` registers a per-category listener
// called with `{ category, inserted }` right after that category is persisted, and returns
// an unsubscribe function. `progress()` returns the generationProgress of what has been
// delivered so far.
//
// Callers must check this and, on null, start their own generation with no await between
// the check and the runCatalogueGeneration call: that gap being synchronous is what makes
// the check-then-start atomic on a single thread.
export function getRunningGeneration(destinationId) {
  const entry = runningGenerations.get(destinationId);
  return entry
    ? {
      settled: entry.settled,
      subscribe: entry.subscribe,
      progress: () => generationProgress(entry.delivered, entry.first),
    }
    : null;
}

// Test-only escape hatch: vitest's module registry is shared across test files unless
// explicitly reset, so a generation left pending at test end would otherwise leak its
// entry into the next test.
export function __resetRunningGenerationsForTests() {
  runningGenerations.clear();
}

// destinationRow: the discovery_destinations row generation is happening
// against (already resolved by the caller — this module never creates one).
// claudeDestination: the human-readable string sent to Claude, already
// composed with country context by the caller.
// useExclusions: whether to exclude this destination's already-stored names
// from the Claude call (true for "show more"/stale-refresh merge semantics,
// false for a true first generation, where there's nothing to exclude yet).
// onCategory: called once PER COMPLETED CATEGORY with `{ category, inserted }`
// — inserted is the array of full discovery_places rows insertPlaces() just
// wrote for that category (Wave 1, W1.4 / Q-26-2 — see below). Defaults to a
// no-op so callers with no live-streaming need (e.g. the background kick)
// don't have to pass one. This is a DIFFERENT contract than the pre-W1
// version, which forwarded discoverDestination's own onCategory straight
// through with raw, never-persisted Claude items (no id/provenance/batch).
async function generate(db, { destinationRow, claudeDestination, useExclusions, onCategory }, notifyListeners, recordDelivered) {
  const exclusionTitles = useExclusions
    ? listExclusionNames(db, destinationRow.id, 400)
    : [];

  const generatedAt = new Date().toISOString();
  // Batch number for this generation: the destination's generation_count
  // BEFORE it's incremented below — first generation is batch 0 (matching
  // the Wave-1 backfill migration's batch=0 for pre-existing data), second
  // generation is batch 1, etc. Computed once up front (not per category) so
  // every category from the same generation shares one batch number, exactly
  // as before.
  const batch = destinationRow.generation_count;

  const allInserted = [];

  // Wave 1 (W1.4 / Q-26-2): insert -> cap -> enqueue now run PER CATEGORY, as
  // each one completes streaming from Claude, instead of once after all eight
  // categories had arrived. Before this change, every mid-generation chunk the
  // route forwarded to the client was a raw Claude item with no DB id, no
  // provenance, no batch (F-26-11) — those cards couldn't be reported or
  // added on the trusted path, and streaming them at all during a merge
  // (`isAppend`/`isStaleRefresh`) risked showing something insertPlaces would
  // then silently drop as a duplicate. Persisting per category closes both
  // gaps: every card the caller's onCategory receives is already a real row.
  //
  // Trade-off this creates, which is intentionally NOT rolled back: claude.js
  // discoverDestination() can still throw AFTER some categories have already
  // been passed to onCategory, if the generation is truncated, refused or yields
  // no usable item at all (D-30-3, D-36-1). With this change, the categories that
  // DID complete before the throw are already persisted — before W1 nothing was
  // inserted until the whole generation succeeded. This is safe because:
  //   - last_generated_at / generation_count are only bumped below, AFTER
  //     discoverDestination() resolves without throwing — a throw never
  //     marks the catalogue "freshly generated". A short but successful
  //     generation IS stamped and counted; read-time completeness (D-36-1,
  //     isCatalogueFresh) keeps it non-fresh, so it cannot stand for a week.
  //   - the partial rows are additive and deduped by insertPlaces exactly
  //     like a normal generation's rows — they don't corrupt anything, and
  //     the next stale refresh (last_generated_at stayed at its old value)
  //     will complement them with whichever categories got cut off.
  const handleCategory = (categoryObj) => {
    const items = (categoryObj.items || []).map((item) => ({
      ...item,
      category: categoryObj.category,
      generatedAt,
    }));
    const inserted = insertPlaces(db, destinationRow.id, items, batch);

    // Bounds enforcement (decision 4): archive category surplus immediately
    // after insert. Running the cap here — before this batch has been checked
    // — is safe now for a different reason than it used to claim: W1.2 makes
    // never-checked ('pending') rows exempt from archival entirely, so the
    // rows this call just inserted cannot be archived before the verification
    // worker reaches them (F-26-3). What the cap trims on this pass is
    // surplus among rows a previous generation already had checked.
    enforceCategoryCap(db, destinationRow.id);

    // Verification is fire-and-forget: enqueue and move on. It must never
    // block or fail the caller — the queue drains after this call returns,
    // isolated from serving (see services/discoveryVerify.js).
    enqueueForVerification(db, destinationRow.id, inserted.map((row) => row.id));

    allInserted.push(...inserted);
    // Recorded before either callback fires, so the leader and every joiner already see
    // the new count (D-35-2).
    recordDelivered(categoryObj.category);
    if (onCategory) onCategory({ category: categoryObj.category, inserted });
    notifyListeners({ category: categoryObj.category, inserted });
  };

  await discoverDestination(claudeDestination, exclusionTitles, handleCategory);

  db.prepare(`
    UPDATE discovery_destinations
    SET last_generated_at = datetime('now'), generation_count = generation_count + 1
    WHERE id = ?
  `).run(destinationRow.id);
  incrementDailyGenerationCount(db, destinationRow.id);

  return { inserted: allInserted, insertedIds: allInserted.map((row) => row.id) };
}

// Runs one generation for destinationRow and registers it so concurrent callers can join
// it (D-33-1). The entry is registered synchronously, before any await, and removed in the
// `finally` on every exit. Starting a second generation for a destination that already has
// one is a caller bug (the caller skipped the getRunningGeneration check), so it throws
// instead of silently double-generating.
export async function runCatalogueGeneration(db, options) {
  const destinationId = options.destinationRow.id;
  if (runningGenerations.has(destinationId)) {
    throw new Error(
      `runCatalogueGeneration: a generation is already running for destination=${destinationId}; callers must join it via getRunningGeneration`,
    );
  }

  const listeners = new Set();
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const delivered = [];
  runningGenerations.set(destinationId, {
    settled,
    delivered,
    first: !options.useExclusions,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  // A joiner's listener failing must never abort the leader's generation, which keeps
  // persisting for the shared catalogue regardless of who is watching: log it, drop that
  // listener, carry on. The leader's own onCategory is NOT guarded this way; it propagates
  // exactly as it always has.
  const notifyListeners = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error(
          '[discoveryGeneration] listener failed destination=%s category=%s, unsubscribing: %s',
          destinationId, event.category, err.message,
        );
        listeners.delete(listener);
      }
    }
  };

  try {
    const result = await generate(db, options, notifyListeners, (category) => delivered.push(category));
    settle({ ok: true });
    return result;
  } catch (error) {
    settle({ ok: false, error });
    throw error;
  } finally {
    runningGenerations.delete(destinationId);
  }
}
