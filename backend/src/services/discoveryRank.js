// Trip ranking layer (Plan 7, Wave 3) — deterministic, zero model calls.
//
// Everything in this file is a PURE function: no `db`, no `fetch`, no
// `await`, no model calls, no `console.*`. All logging/IO lives in the
// callers (routes/discovery.js, db/discoveryCatalogue.js). This is a hard
// requirement — see the Wave 3 plan section and its reviewer checklist.
//
// The global catalogue owns place facts; the trip owns fit (review doc
// §5). Nothing here is written back to the shared catalogue — it only
// computes an order and a line of trip-fit prose for a given request.

// Copied verbatim from frontend/src/components/discovery/DiscoveryPanel.jsx
// (lines 7-20) — this mapping now lives server-side too so the route can
// compute category-match boosts and category ordering without a round trip
// to the client. Keep the two copies in sync if the mapping ever changes;
// Wave 4 may consolidate them into a single shared source.
export const TAG_TO_CATEGORY = {
  'food & drink': 'food',
  'nature': 'nature',
  'culture': 'culture',
  'nightlife': 'nightlife',
  'architecture': 'architecture',
  'wellness': 'wellness',
  'history': 'culture',
  'art': 'culture',
  'markets': 'hidden_gems',
  'shopping': 'hidden_gems',
  'adventure': 'nature',
  'off the beaten path': 'hidden_gems',
};

// Parses free-text duration estimates ("2 hours", "1-2 hours", "30 minutes",
// "half day", "full day", ...) into a representative hour figure. Returns
// `null` when the text can't be confidently parsed — callers must treat that
// as "unknown", never as zero.
export function parseDurationHours(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().trim();

  if (/half\s*-?\s*day/.test(t)) return 4;
  if (/full\s*-?\s*day/.test(t)) return 8;

  // Range form: "1-2 hours", "1 to 2 hours", "30-45 minutes".
  const rangeMatch = t.match(
    /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)/,
  );
  if (rangeMatch) {
    const a = parseFloat(rangeMatch[1]);
    const b = parseFloat(rangeMatch[2]);
    const unit = rangeMatch[3];
    const avgValue = (a + b) / 2;
    return /min/.test(unit) ? avgValue / 60 : avgValue;
  }

  // Single value form: "2 hours", "1.5 hr", "30 minutes".
  const singleMatch = t.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)/);
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);
    const unit = singleMatch[2];
    return /min/.test(unit) ? value / 60 : value;
  }

  return null;
}

// Maps a trip's declared interest tags to the set of catalogue categories
// they boost, via TAG_TO_CATEGORY (case-insensitive, matching the frontend's
// tag.toLowerCase() convention).
function interestCategorySet(interestTags) {
  const set = new Set();
  for (const tag of interestTags || []) {
    const mapped = TAG_TO_CATEGORY[String(tag).toLowerCase()];
    if (mapped) set.add(mapped);
  }
  return set;
}

// Duration/pace fit: fast pace favors short items (<=2h), relaxed pace
// favors long items (>=3h). Moderate pace, and any duration that can't be
// parsed, is neutral (0) — never a penalty.
function paceFit(item, prefs) {
  const hours = parseDurationHours(item.estimated_duration);
  if (hours === null) return 0;
  if (prefs.pace === 'fast') return hours <= 2 ? 1 : 0;
  if (prefs.pace === 'relaxed') return hours >= 3 ? 1 : 0;
  return 0;
}

// score(item, prefs) =
//     3.0 · verified                    // provenance ('pending' counts as unverified)
//   − 0.75 · batch                      // later "show more" batches rank lower
//   + 1.5 · categoryMatchesInterest     // TAG_TO_CATEGORY mapping
//   + 0.5 · paceFit                     // parsed estimatedDuration vs prefs.pace
//   + quality (flag only)               // (rating − 3.5) · log10(1 + rating_count)
export function score(item, prefs) {
  const verified = item.provenance === 'verified' ? 1 : 0;
  const batch = typeof item.batch === 'number' ? item.batch : 0;

  const categoryMatchesInterest = interestCategorySet(prefs.interestTags).has(item.category) ? 1 : 0;

  const fit = paceFit(item, prefs);

  // Quality term is ONLY added when a rating is actually present — its
  // absence contributes nothing, it is not treated as a zero rating.
  let quality = 0;
  if (item.rating !== null && item.rating !== undefined) {
    quality = (item.rating - 3.5) * Math.log10(1 + (item.rating_count || 0));
  }

  return 3.0 * verified - 0.75 * batch + 1.5 * categoryMatchesInterest + 0.5 * fit + quality;
}

// Returns a NEW array, sorted by score(item, prefs) descending. Stable sort
// (Array.prototype.sort is stable in Node/V8) preserves the caller's
// original order on ties — callers pass items pre-ordered by (category, id)
// i.e. generation order, so ties keep Claude's editorial order, which is a
// real prior (see review doc §6.3). No secondary id-based comparator is
// added on purpose.
export function rankPlaces(items, prefs) {
  return items
    .map((item) => ({ item, s: score(item, prefs) }))
    .sort((a, b) => b.s - a.s)
    .map((entry) => entry.item);
}

// Orders the categories present in a catalogue response for a given trip:
//   1. 'essentials' first, if present.
//   2. Then, for each declared interest tag in order, its mapped category
//      (if present and not already added).
//   3. Then every remaining present category, in its original relative order.
//   4. If travellers === 'family', 'nightlife' (if present) moves to the end.
export function orderCategories(categoriesPresent, prefs) {
  const present = new Set(categoriesPresent);
  const added = new Set();
  const result = [];

  if (present.has('essentials')) {
    result.push('essentials');
    added.add('essentials');
  }

  for (const tag of prefs.interestTags || []) {
    const mapped = TAG_TO_CATEGORY[String(tag).toLowerCase()];
    if (mapped && present.has(mapped) && !added.has(mapped)) {
      result.push(mapped);
      added.add(mapped);
    }
  }

  for (const category of categoriesPresent) {
    if (!added.has(category)) {
      result.push(category);
      added.add(category);
    }
  }

  if (prefs.travellers === 'family' && added.has('nightlife')) {
    const idx = result.indexOf('nightlife');
    result.splice(idx, 1);
    result.push('nightlife');
  }

  return result;
}
