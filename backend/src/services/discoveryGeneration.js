// Extracted generation pipeline (Plan 12 Wave 2): the co-pilot's G3 background
// generation kick (services/copilotGrounding.js) needs to fire the exact same
// generate/merge sequence routes/discovery.js's POST /:tripId/discover handler
// uses, but without depending on that route or its SSE plumbing (the kick runs
// detached from any request/response). This module is the route-independent
// core of that sequence — build exclusions, call discoverDestination, then
// flatten/insert/cap/enqueue/bump-counters — so there is exactly one place the
// sequence is implemented; the route calls this too.
import { discoverDestination } from './claude.js';
import { enqueueForVerification } from './discoveryVerify.js';
import {
  listExclusionNames,
  insertPlaces,
  enforceCategoryCap,
  incrementDailyGenerationCount,
} from '../db/discoveryCatalogue.js';

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
export async function runCatalogueGeneration(db, { destinationRow, claudeDestination, useExclusions, onCategory }) {
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
  // been passed to onCategory, if the generation as a whole yields fewer than
  // MIN_CATEGORIES_WITH_ITEMS usable categories (the guard added after the
  // production incident where a truncated generation was stored as a fresh
  // 7-day catalogue). With this change, the categories that DID complete
  // before the throw are already persisted — before W1 nothing was inserted
  // until the whole generation succeeded. This is safe because:
  //   - last_generated_at / generation_count are only bumped below, AFTER
  //     discoverDestination() resolves without throwing — a throw never
  //     marks the catalogue "freshly generated", so the actual harm the
  //     MIN_CATEGORIES guard exists to prevent still cannot happen.
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
    if (onCategory) onCategory({ category: categoryObj.category, inserted });
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
