// Near-match adjacency (Plan 27, Wave 2) — deterministic, zero model calls,
// zero score impact.
//
// Like discoveryRank.js, everything in this file is a PURE function: no
// `db`, no `fetch`, no `await`, no `console.*`. This runs AFTER rankPlaces
// has already produced a final score-ordered array — it never reads or
// writes a score, and it never changes which rows exist, only where they
// sit. Callers must wire it in strictly between rankPlaces(...) and
// serialization (routes/discovery.js groupPlaceRowsByCategory).
//
// Containment, not overlap. An earlier measurement against the live corpus
// tried grouping any two names that share a token ("overlap") and it was
// unusable: it grouped 77% of a category into one blob and put a war
// cemetery next to a railway station just because both contain "Kuala" and
// "Lumpur". Token-SET-CONTAINMENT — the shorter name's token set is a
// subset of the longer's — is the rule that actually holds up: "Lotus Pond"
// ⊂ "Dragon and Tiger Pagodas (Lotus Pond)" groups correctly, while "Kuala
// Lumpur War Cemetery" and "Kuala Lumpur Railway Station" correctly stay
// apart, because neither token set contains the other — each holds a token
// ("cemetery", "station") the other lacks. Note there is NO threshold here
// and none should be added: containment is all-or-nothing, and how MUCH two
// names share is deliberately never consulted.
import { normalizeName } from './claude.js';

// Splits a normalized name into its token set. Rows whose set comes back
// EMPTY are never grouped with anything else and are excluded from the
// relation entirely — normalizeName strips generic geographic suffixes
// (e.g. "Scenic Area" alone normalizes to ""), and the empty set is
// trivially a subset of every other set. Without this guard, one such row
// would test as "contained in" everything and collapse an entire category
// into a single connected component.
function tokenSet(name) {
  const normalized = normalizeName(name ?? '');
  if (!normalized) return null;
  return new Set(normalized.split(' '));
}

// True when `a` is a subset of `b` (every element of `a` is in `b`).
function isSubset(a, b) {
  for (const token of a) {
    if (!b.has(token)) return false;
  }
  return true;
}

// Two non-empty token sets near-match when either is a subset of the other
// (equal sets count, since a set is trivially a subset of itself).
function isNearMatch(a, b) {
  return isSubset(a, b) || isSubset(b, a);
}

// Groups a rank-ordered array of place rows so near-matches (by the
// containment rule above) sit adjacent to one another, without changing
// which rows exist, their scores, or their object identity — this is a
// REORDER ONLY, run once per (destination, category) after rankPlaces has
// already decided relative strength.
//
// Grouping is by connected component over the pairwise near-match
// relation, not just by pair: "House of Matahari" is contained in both
// "House of Matahari Crafts" and "House of Matahari Batik Workshops", even
// though those two longer names are not near-matches of each other, and
// all three must land in one group. The category-sized arrays this runs
// over (tens of rows) make a plain O(n²) pairwise comparison + union-find
// the clearest implementation; no need for anything cleverer.
//
// A group's position in the output is the position its strongest-ranked
// (i.e. first-appearing) member already earned — walking the input in rank
// order and emitting each row's whole group the first time any member of
// it is reached guarantees this. Members within a group keep their
// existing relative rank order.
export function groupAdjacentNearMatches(rankedRows) {
  const n = rankedRows.length;
  const sets = rankedRows.map((row) => tokenSet(row.name));

  // Union-find over row indices. Rows with a null (empty) token set never
  // union with anything, so they stay singleton groups by construction.
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i += 1) {
    if (sets[i] === null) continue;
    for (let j = i + 1; j < n; j += 1) {
      if (sets[j] === null) continue;
      if (isNearMatch(sets[i], sets[j])) union(i, j);
    }
  }

  // Collect original indices per group root, preserving rank order within
  // each group (we walk i from 0..n-1, the rows' existing rank order).
  const groupMembers = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!groupMembers.has(root)) groupMembers.set(root, []);
    groupMembers.get(root).push(i);
  }

  const emitted = new Array(n).fill(false);
  const result = [];
  for (let i = 0; i < n; i += 1) {
    if (emitted[i]) continue;
    const root = find(i);
    for (const memberIndex of groupMembers.get(root)) {
      result.push(rankedRows[memberIndex]);
      emitted[memberIndex] = true;
    }
  }

  return result;
}
