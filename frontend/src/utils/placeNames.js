// Mirrors backend/src/services/claude.js's normalizeName — the two must be
// kept in lockstep. Strips punctuation and common English geographic
// suffixes so name variants ("Dujiangyan & Scenic Area" / "Dujiangyan Scenic
// Area") collapse to the same dedupe/match key.
//
// W1.3 (F-26-9): the character class used to be `[^\w\s]` with no `/u` flag —
// `\w` is ASCII-only, so CJK names (北京烤鸭, 故宫博物院, 喀什老城) all folded
// to the empty string. That made every CJK-named item after the first look
// like a duplicate of the first (insertPlaces on the backend; the show-more
// merge here on the frontend), and made any one CJK-named trip stop falsely
// match every CJK-named suggestion as "already in trip" (pickSurprise).
// `\p{L}\p{N}` with the `/u` flag folds by Unicode letter/number instead, so
// distinct CJK names stay distinct. Deliberately NOT doing NFD/diacritic
// normalization here — out of scope for this wave (W1.3 note in Plan 26).
export function normalizeName(str) {
  return (str ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
