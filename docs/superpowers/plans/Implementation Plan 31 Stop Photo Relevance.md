# Implementation Plan 31 — Stop Photo Relevance (short-query retry + whole-word gate)

**Status:** **DEPLOYED to production in Plan 30 Deploy B at `a2c47d5` (2026-10-19; migration 037 applied). Owner production click-through pending.** W1 COMPLETE (2026-10-18) — DEPLOYED with Plan 30 Deploy A at `a12f473` (2026-10-18). Owner ruling 2026-10-18: ships with the next Plan 30 deploy (it is on `main`, so any deploy from `main` carries it). Owner production QA PASSED 2026-10-18: a new manual stop got its photo (Plan 30 Deploy A record).

**Source:** `docs/superpowers/reviews/2026-10-18-stop-photo-fallback-investigation.md` (`5ea2560`). Owner approved remedies R1 + R2 on 2026-10-18; R3 deferred.

**Scope:** backend only — `backend/src/services/unsplash.js` and its tests. No migration, no model call, no descriptor-prompt change (its request body is sha-pinned by Plan 30 W2), no Unsplash tier change (`docs/DECISIONS.md`, CLOSED). No backfill: stored photos stay as they are (Plan 10 D4, D6); the new behaviour applies to new stops, title/type edits that already re-run the pipeline, and `refresh-photos`.

---

## 0. Verified facts (from the review — do not re-derive)

1. Of 36 measured fallbacks on the 50 descriptor fixtures, **22 (61%) were Unsplash returning zero results** for the 6–8-word descriptor query; one rare word sinks it.
2. **10 (28%)** had the place name in the photo's `description`, which the gate never reads: `mapPhoto` sets `alt = alt_description || description`, and `alt_description` was present on 640/640 results.
3. The search endpoint returned `tags` on **0/640** results.
4. The gate matches substrings: `din` passes on "buil**din**g", `tai` on "s**tai**nless".
5. Measured on cached results: today 15/50 fallbacks (Haiku 5.5) → **5/50** with R1 + R2; Haiku 4.5 21 → 8. About one recovered photo in five is a related-but-wrong place (Tsukiji → Sensō-ji's Nakamise).

## 1. Decisions (owner-approved 2026-10-18)

- **D-31-1 — Retry a shorter query when Unsplash returns nothing.** If the primary search returns **zero results**, retry with the query's first 4 words; if no result from that qualifies, retry with the first 3 words; then the existing scene fallback. A retry is skipped when it would not shorten the query already sent. Retried pools go through the same gate (significant tokens recomputed from the shortened query) and trip exclusion. A primary that returned results which all failed the gate does **not** retry. This **reopens Plan 10 D2**'s "tier count equals today's (primary → fallback → none)": the pipeline is now primary → up to two shortened retries → scene fallback → none. Cost: at most two extra searches, only on zero-result stops (~0.3–0.5 calls per new stop).
- **D-31-2 — The gate reads alt text, description, and tags, as whole words.** Haystack = `alt_description` + `description` + `tags` (as Plan 10 W2.1 always specified; the code read description only when alt was missing). A significant token matches a haystack word exactly or as a simple plural (`dumpling`/`dumplings`, `market`/`markets`). No substring matching. Accepted trade-off: a few photos that pass today only by accident (`past` in "pastel", `mount` in "mountain") will now fall back unless their caption carries the word.
- **D-31-3 — R3 (owner-wide fallback exclusion) is deferred**, not rejected: revisit only if a production read shows the same fallback photo on stops across trips. Plan 10 D5 (scene-pool caching) stays an open default and is not pursued.

## 2. Waves

### W1 — Retry + gate (backend)

1.1 `mapPhoto`: add `description` (raw `photo.description || ''`); keep `alt` as today (StopCard swap strip uses it for `<img alt>`).
1.2 `passesGate`: whole-word, plural-tolerant match over `alt_description` + `description` + `tags`.
1.3 `selectPhoto`: the D-31-1 retry chain between primary and scene fallback.
1.4 Decision markers `D-31-1` / `D-31-2` at the code they govern.
1.5 Tests (`backend/tests/locationIntegration.test.js`, "stop photo selection" block): zero-result primary → 4-word retry wins; 4-word miss → 3-word retry → scene fallback with exact queries and call counts; ≤3-word query never retries; results-that-fail-gate do not retry; description is read when alt is present; substring no longer passes (`Din Tai Fung` vs "building"); plural tolerance. Existing W2 tests stay green unchanged.

**Acceptance:** backend suite green; replaying the review's cached Unsplash payloads through the real `selectPhoto` reproduces ≈5/50 fallbacks for the Haiku 5.5 queries; a live temp-DB `createStop` run on the W2 end-to-end stops shows place photos where the review predicts them.

## 3. Status

- **W1 — COMPLETE (2026-10-18), not deployed.** `selectPhoto` now walks primary → (zero results only) 4-word then 3-word retry → scene fallback → none, via a shared `firstQualifying` helper; `passesGate` matches whole words, plural-tolerant, over `alt_description` + `description` + tags (`mapPhoto` adds `altDescription` and `description`; `alt` unchanged for the swap strip). Markers `D-31-1` / `D-31-2` in `backend/src/services/unsplash.js`; Plan 10 D2's tier count recorded as superseded in `docs/DECISIONS.md`. Seven new tests in `backend/tests/locationIntegration.test.js` ("Plan 31 retry + whole-word gate"); the existing Plan 10 W2 tests pass unchanged.
  - **Cached replay** (the review's stored Unsplash payloads through the real new `selectPhoto`, 1 uncached call): fallbacks **15 → 5 / 50** (Haiku 5.5 queries) and **21 → 8 / 50** (Haiku 4.5) — exactly the review's projection.
  - **Live end-to-end** (throwaway script, temp DB, real `createStop` with live Haiku 5.5 descriptor, Nominatim and Unsplash; download tracking stubbed; 14 searches; script and DB deleted). Eight stops, one trip each: 清水寺, Borough Market, Golden Gai — primary hit, as before. **Tapas crawl in El Born** — now a photo captioned "El Born, Barcelona" (W2 got a cocktail fallback), via the description read. **광장시장** — zero results, recovered by the 4-word retry ("A korean restaurant and market with many foods"). **Kabuki-za** — recovered by retry, but the photo is a kabuki costume at the Edo-Tokyo Museum: the accepted related-but-wrong case. **Cooking class (Hanoi)** — primary had 9 results, none passed, so no retry by design → scene fallback. **Thip Samai Pad Thai** — all three queries returned zero → scene fallback.
  - **Tests:** `npm test` (backend) 45 files passed, 1 skipped; 1,049 passed, 6 skipped, 0 failed.
  - **Observed, not changed:** in the temp-DB run the scene fallback query was `"food drink"` with no country, because the throwaway trips carried no resolved day country; real trips resolve it through the day-geography ladder. Not investigated further — outside W1.
  - **Not verified:** production behaviour; discovery-added stops (same gate, different query source) were not run live. No UI change, so no browser pass.
