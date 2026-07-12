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
// onCategory: forwarded to discoverDestination as-is; defaults to a no-op so
// callers with no live-streaming need (e.g. the background kick) don't have
// to pass one.
export async function runCatalogueGeneration(db, { destinationRow, claudeDestination, useExclusions, onCategory }) {
  const exclusionTitles = useExclusions
    ? listExclusionNames(db, destinationRow.id, 400)
    : [];

  const accumulated = await discoverDestination(
    claudeDestination,
    exclusionTitles,
    onCategory ?? (() => {}),
  );

  const generatedAt = new Date().toISOString();
  // Batch number for this generation: the destination's generation_count
  // BEFORE it's incremented below — first generation is batch 0 (matching
  // the Wave-1 backfill migration's batch=0 for pre-existing data), second
  // generation is batch 1, etc. This gives Wave 3's future recency-based
  // ranking a monotonically increasing "how recent is this batch" signal
  // without needing to build ranking now.
  const batch = destinationRow.generation_count;

  const flatItems = (accumulated || []).flatMap((cat) =>
    (cat.items || []).map((item) => ({ ...item, category: cat.category, generatedAt })),
  );
  const inserted = insertPlaces(db, destinationRow.id, flatItems, batch);
  const insertedIds = inserted.map((row) => row.id);

  // Bounds enforcement (decision 4): archive category surplus immediately
  // after insert, using only provenance/batch (Wave 3's real scorer is out of
  // scope here) — verified rows are never archived while an unverified row in
  // the same category could be archived instead, so this is correct regardless
  // of whether the async verification worker below has run yet.
  enforceCategoryCap(db, destinationRow.id);

  // Verification is fire-and-forget: enqueue and move on. It must never block
  // or fail the caller — the queue drains after this call returns, isolated
  // from serving (see services/discoveryVerify.js).
  enqueueForVerification(db, destinationRow.id, insertedIds);

  db.prepare(`
    UPDATE discovery_destinations
    SET last_generated_at = datetime('now'), generation_count = generation_count + 1
    WHERE id = ?
  `).run(destinationRow.id);
  incrementDailyGenerationCount(db, destinationRow.id);

  return { inserted, insertedIds };
}
