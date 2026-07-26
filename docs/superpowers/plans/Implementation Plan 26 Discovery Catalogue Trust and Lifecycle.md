# Implementation Plan 26 — Discovery Catalogue Trust and Lifecycle

**Status:** 2026-07-26 — **WRITTEN, NOT STARTED.** No code, no migration, nothing deployed. Six owner decisions taken (D-26-1…D-26-6); three questions deliberately left open and scheduled to be answered by measurement in W3, not by guesswork now.

**Origin:** [2026-07-26 Discovery catalogue quality assessment](../reviews/2026-07-26-discovery-catalogue-quality-assessment.md) (`ca37222`), which consolidates three review passes over the [original review](../reviews/2026-07-26-discovery-catalogue-quality-review.md) (`3f9db9e`, deepened at `6b4c179`). Triggered by Plan 24 owner production QA, where a Discovery-added stop opened coordinate-only and the owner recognised odd naming and apparent duplicates.

**Scope in one sentence:** make the shared Discovery catalogue's trust states honest, stop the lifecycle from discarding candidates before they can prove themselves, and stop background catalogue work from degrading interactive use — without redesigning Discovery and without reopening Plan 24.

**Plan 24 stays closed.** Its Nominatim-first deep-link ordering and the owner's 2026-07-26 "precision over polish" call are preserved. Exactly one item in this plan (W2.3) touches adjacent code, and it is scoped so it cannot alter stop or booking resolution — see the compatibility gate in W2.

---

## Validated facts — established 2026-07-26, do not re-derive

Production figures come from the assessment doc's read-only census (2026-07-25/26, `trippy-trippy-1`, `/app/data/trippy.db`). **Do not re-measure them.** Code facts below were verified by direct read at `ca37222`; two were verified by execution.

**F-26-1 — The category cap runs before verification, and this is NOT a deviation from Plan 7.** `discoveryGeneration.js:59` calls `enforceCategoryCap`, `:64` calls `enqueueForVerification`. Plan 7 §2.3 (line 349) says the cap applies "after insert+verification", but Plan 7 §2.1 (line 282) says verification is "enqueued fire-and-forget from the route right after `insertPlaces`/`enforceCategoryCap` — never awaited". **The plan contradicts itself**; the implementation followed the operative, mechanically achievable half. An earlier draft of the assessment called this an implementation deviation; that claim is withdrawn. There is no ordering that satisfies both halves, so W1.2 is a design change, not a reordering.

**F-26-2 — New rows are archived first deterministically, not probabilistically.** `enforceCategoryCap` ranks victims with `NEUTRAL_PREFS` (`discoveryCatalogue.js:179`), under which `score()`'s interest-match and pace terms are always 0, and the quality term is always 0 because rating enrichment is off. The formula (`discoveryRank.js:110`) therefore reduces to exactly `−0.75 × batch`. Highest batch (newest) is **always** the lowest scorer in the unverified tier the cap consumes worst-first.

**F-26-3 — Rows archived before checking can never recover, and they are identifiable exactly.** `verifyOne` returns early for any row whose `status !== 'active'` (`discoveryVerify.js:169`). A row archived by the cap before the worker reaches it is therefore permanently unverified **and** archived — precisely the **archived + unverified** population, which production reports as **78 rows** across all 11 destinations. They retain name, description, category, aliases and local name. **Recovering them costs zero AI calls and zero provider calls** (W5.2).

**F-26-4 — The "never suggest again" list is capped, but effectively total at current scale.** `listExclusionNames` (`discoveryCatalogue.js:166`) returns the 400 most recent names across `active`/`archived`/`suppressed`. Production averages ~183 places per destination, so every stored name currently falls inside the window. Exclusion self-heals only for a destination that grows past 400 rows; this is a property of current scale, not a designed recovery path.

**F-26-5 — One 1-req/s gate is shared between background verification and interactive work.** `nextNominatimRequestAt` (`placeResolver.js:15`) is module-global. Interactive callers behind it: `stops.js:189` (add stop), `stops.js:831` (booking-linked resolution), `trips.js:1269` (day-override country inference — **awaited inside the PUT**, so the user watches a spinner). `searchNominatim` (`:426`) issues one sequential HTTP request per variant from `resolverQueryTexts` until one returns; `verifyOne` may run the whole chain twice (`row.name`, then `row.local_name`, `discoveryVerify.js:184`/`:188`).

**F-26-6 — Measured cost of one generation, and the budget consequence.** The prompt asks for 30 items across 8 categories (`claude.js:209`) ≈ 240 candidates. Variant counts verified by execution against real catalogue names: parenthesised names → **3** variants (`Chuan Wei Small Eat (Xinyi)`, `M50 Creative Park (Textile factory typology)`), un-bracketed names → **1** (`Muddy's Cafe Quiet Morning Work Space`), plus one per alias. Successes cost 1–2 requests, failures cost every variant. At the observed ~55% success rate this is **≈700–800 requests ≈ 12 minutes** of continuously occupied gate — Plan 7 §2.1's own "~240 items ≈ 4 min" estimate is ~3× low.

More consequentially: the daily budget is 500 **lookups**, not requests (`config.js:55`, `discoveryVerify.js:52`). With the `local_name` fallback, 240 candidates can consume ~480 of them. **A single "Show more" on one destination can exhaust the entire day's checking budget**, leaving every other destination's rows stuck at `pending`. The observed production peak of 421/day is consistent with exactly this. The original review's F6 ("budget is not the constraint; peak 421 of 500") is wrong in both unit and conclusion.

**F-26-7 — An `estimated` result can never be labelled verified, but it does block the better provider.** `isConfidentHit` (`discoveryVerify.js:84`) requires `locationStatus === 'resolved'` exactly, so the original review's A1 first half is false. However `resolvePlace` returns any Nominatim result immediately (`placeResolver.js:618`), and Google is consulted only when Nominatim returned nothing on **every** variant (`:627`). A weak `estimated` hit therefore suppresses a stronger provider attempt — a confirmed false-negative source.

**F-26-8 — `verified` is not an identity guarantee on the Google path.** `searchGooglePlaces` hardcodes `locationStatus:'resolved', confidence:0.9` on the first result with **no returned-name similarity check** (`placeResolver.js:548`), while the Nominatim path performs exactly that check (`classifyNominatimResult:343`). Combined with `isConfidentHit` accepting any resolved country when the destination country is empty (`discoveryVerify.js:87`, pinned as intended by `discoveryVerify.test.js:174`), a vague or editorial query can attach to an unrelated real place and receive the product's strongest trust label.

**F-26-9 — The catalogue's dedupe key destroys CJK names.** `normalizeName` (`claude.js:180`, mirrored verbatim at `DiscoveryPanel.jsx:39`) uses `[^\w\s]` with **no `/u` flag**; `\w` is ASCII-only. Verified by execution: `北京烤鸭`, `故宫博物院`, `喀什老城` all fold to `""`. Consequences: (a) the first pure-CJK-named item in a destination claims `normalized_name = ''` and every subsequent one is silently skipped as a duplicate (`insertPlaces:120`); (b) on the frontend one CJK stop title makes every CJK-named suggestion falsely match "In trip" and drop out of `pickSurprise`. Impact is currently limited because the prompt asks for romanized names in `name` (`claude.js:201`) — a convention, not an invariant. `canonicalGeoKey` (`utils/geoIdentity.js`) handles this correctly with `\p{L}` and `/u` and is the fix template.

**F-26-10 — Day country can be inherited from the previous day, and two fixes interact.** `deriveDayGeo` (`trips.js:504-509`) selects `city` and `countryCode` **independently** across `[override, hotel, transit, previous, seed]`. A free-text override with a null `city_override_country` therefore takes its country from the previous day's carry — a free-text 冲绳 day after a Shanghai/CN day resolves to `{ city: 冲绳, countryCode: 'CN' }`. Documented at `trips.js:440-443`, pinned by `tests/trips.test.js:220`.

Frequency is low because `resolveOverrideCountry` (`trips.js:1263-1274`) accepts **any** returned country regardless of confidence, so nulls are uncommon. **That missing confidence gate is itself a defect, and fixing it alone would produce more nulls and make the inheritance fire more often.** W4 must ship both halves together; neither may ship alone.

**F-26-11 — A true catalogue miss is published before verification.** `discovery.js:241-262` streams raw Claude items during generation for the true-miss path only; both merge paths (`isAppend`, `isStaleRefresh`) suppress it via `if (isMerge) return` (`:256`). Streamed items have no DB id, no `provenance`, and no `batch` — they cannot be reported by id and follow the untrusted add path (`DiscoveryPanel.jsx:469`). Any "show only checked suggestions" behaviour therefore **cannot** be implemented as a filter on stored reads alone.

**F-26-12 — Failed checks never retry, and leave no evidence.** `enqueueForVerification` re-collects only `provenance = 'pending'` rows (`discoveryVerify.js:244-246`); terminal `unverified` is never revisited, and stale refresh excludes stored names. The schema records no attempt timestamp, provider, failure reason, returned candidate, match score, or query variant. The negative-result cache expires after 1 hour (`placeResolver.js:13`), so a re-check genuinely re-tries over the network rather than replaying a cached failure — **the corpus is repairable**.

**F-26-13 — Dedupe is structurally blind to the unverified population.** `dedupeByProviderId` (`discoveryVerify.js:95`) is called only from `applyVerified` (`:159`), so it runs only after a row becomes verified. Unverified rows have no `provider_place_id` by definition. Among identified rows dedupe is perfect (881 active rows with a provider id → 881 distinct places): **a place-id-based duplication measure reports zero and is misleading.** Live proof: three active, un-deduplicated rows for one Kaohsiung lake (`Lotus Pond`, `Dragon and Tiger Pagodas (Lotus Pond)`, `Zuoying Scenic Area (Lotus Pond Watershed) – Ecology Overview`).

**F-26-14 — Country is adopted from catalogue coincidence.** `discovery.js:122-131` (the Plan 9 W5.1 "D6" guard) adopts a country when exactly one country-coded row shares the `city_key`. Since `canonicalGeoKey` folds homonyms, the existence of one prior row is not identity evidence about a newly typed label.

**F-26-15 — Trust state is rendered, but buried.** `SuggestionCard.jsx:250` renders `Verified`/`Unverified`, but only inside an opened Details panel; `buildFitLine` (`discoveryRank.js:162`) appends `verified place` and never a negative. The original review's F1 ("the client has no way to distinguish them") is false; the accurate finding is that the browse surface encodes trust as absence of praise.

**F-26-16 — Production trust distribution.** 2,014 `discovery_places` across 11 destinations. User-visible (`active`) = 1,598, of which **706 (44%)** are unverified and 11 pending. Archived: 336 verified, 78 unverified (F-26-3). Suppressed: 2. Ceiling per destination is 45 × 8 = 360; Taipei sits at 298 active (avg 37/category), so several categories are already at the cap.

---

## Owner decisions taken — 2026-07-26

**D-26-1 — Trust wording stays "Unverified"; the signal moves.** Renaming to "unconfirmed" is word-swapping and changes nothing for the user. The fix is (a) surfacing the state on the **browse card**, not only in Details (F-26-15), and (b) separating three internally-distinct states that are currently collapsed: checked-and-failed, not-yet-checked, and shown-before-any-check (F-26-11).

**D-26-2 — `deriveDayGeo`'s layer precedence is NOT to be changed.** It is the Plan 6/7/8 geography model, load-bearing across day headers, map data, share, and geocoding bias, and is test-pinned. W4 adds a *layer-source* signal alongside the existing output and gives **Discovery alone** permission to decline a country that came from a different layer than the city. No precedence change; no existing consumer's behaviour changes.

**D-26-3 — Delete 北京 and 南疆 outright; do not regenerate.** They were the owner's own CJK free-text test destinations, not real catalogue demand. 162 active rows, 0 verified, both `country_code = ''`.

**D-26-4 — Google escalation is approved, provided cost is bounded by construction.** It gets its own small daily sub-budget separate from the existing 500, so the ceiling is structural rather than assumed.

**D-26-5 — No moderation queue; near-matches are an arrangement problem, not a deletion problem.** There is no reviewer in a single-owner app, so "flag for review" was withdrawn as a non-answer. Exact-name duplicates may be removed. Genuinely different things at one place (the three Lotus Pond entries) are kept **adjacent within their category**: ranking unchanged, group position set by its strongest member. A sorting rule only — no new grouping model, no visual redesign, and nothing auto-deleted for looking similar.

**D-26-6 — No wholesale catalogue rebuild.** Rebuilding would destroy 881 verified rows (paid provider work already done) to recover 78 (F-26-3), regenerate with the same prompt and pipeline that produced the current problems, and cost roughly one full day of checking budget **per destination** (F-26-6). The targeted repair in W5.2 recovers exactly the affected rows at zero API cost.

## Questions deliberately left open

Each is scheduled, not deferred indefinitely. None blocks W1.

- **Q-26-1 — Does 45 stay the cap?** Answer after W1 lands. A correctly enforced cap behaves differently enough that choosing a number now is guesswork.
- **Q-26-2 — Restore progressive reveal on "Show more"?** Plan 7 §1.4 deliberately traded it for consistency: mid-generation items have no DB row, id, or status, and some are about to be dropped as duplicates, so streaming them would display places that were never saved. Recommended resolution in W1.4.
- **Q-26-3 — Split `name` into display vs. search name?** Answer from W3 measurement. Both the original claim and its first correction were partly wrong (F-26-6 variant counts): bracket-stripping helps only parenthesised names, and Google is reached only after every variant already failed on Nominatim, so the upside is unproven in both directions.

---

## W1 — Lifecycle fairness and interactive pacing

**Status:** 2026-07-26 — **COMPLETE, verified locally, NOT deployed.** No migration, no new external call, no change to any `resolvePlace` caller outside `discoveryVerify`. Backend 726/726 and frontend 280/280 pass; `npm run build` clean. Verified in a real browser at 375px and desktop against the dev DB, including two live generations (Kaohsiung stale-refresh, Osaka append). Owner production QA still owed — see Appendix B.

**W1.2 decision taken: option (a), exempt never-checked rows.** Option (b) (re-cap after the queue drains) still archives unchecked rows in exactly the production failure mode F-26-6 describes — one generation can exhaust the day's lookup budget, `drainQueue` exits early leaving the remainder `pending`, and a post-drain cap run would then archive them unchecked, reproducing F-26-3 rather than fixing it. Option (a) makes "archived before it was ever checked" structurally impossible.

**Mechanism, and why it needed no migration:** `insertPlaces` stamped `provenance = 'unverified'`, the same terminal value `verifyOne` writes on a failed check — so "never checked" and "checked and failed" were indistinguishable, which is *why* the cap could archive a row the worker had not reached. Inserts now stamp `'pending'`, a value that already meant "awaiting a check" everywhere else (`markPending`, and `enqueueForVerification`'s pending re-collection). Second latent bug this fixes: a row orphaned by a restart mid-drain used to sit at terminal `'unverified'` forever and was never retried; it now self-heals on the next enqueue for its destination. `enforceCategoryCap` gained a third, never-archivable tier for `'pending'`, and logs when the pending exemption leaves a category temporarily above cap rather than doing it silently. Cap value untouched — **Q-26-1 stays open** by design.

**F-26-9 undercounts the mirrors: there were THREE copies of `normalizeName`, not two** — `claude.js:180`, `DiscoveryPanel.jsx:39`, and `useDiscovery.js:10`. The third drives the "show more" client-side merge, so CJK names collapsed to `""` there too and every CJK item after the first was dropped from the appended grid. The two frontend copies are now one shared `frontend/src/utils/placeNames.js`, reducing the mirrors to two.

**Q-26-2 resolved as recommended** (per-category insert + stream). One consequence accepted deliberately: `discoverDestination` throws *after* the stream when a generation yields fewer than `MIN_CATEGORIES_WITH_ITEMS` categories, so partial rows now persist where previously nothing did. The incident that guard exists for was a truncated generation being stored *as a fresh 7-day catalogue* — and `last_generated_at` is still only bumped after generation resolves, so that cannot happen. Pinned by test.

**W1.5 scope note:** the decline fires when **no** category has headroom, not when the viewed one is full. A generation still adds real value to the categories that are not full, and a per-category decline needs the client to send which category it is viewing — deferred alongside Q-26-1. The decline also fixed a live defect it sat next to: `useDiscovery` turned *any* `type:'error'` chunk into the red "Couldn't load places right now" line, which **replaced the whole catalogue on screen** and discarded the server's specific message — that is what the existing `generation_limit` decline did to users. Declines now route to a separate `notice`, leaving `error` for genuine failures.

**Measured (W1.1 — the plan states this cannot be asserted from unit tests).** Gate-scheduler harness, `fetch` stubbed so zero provider traffic occurred; measures grant latency, not network RTT. 60 background lookups flooding the gate, then 5 interactive calls: **~1.0 s each** (`[998, 993, 996, 998, 994]` ms) with priority, versus **~60.6 s each** (`[60620, 60618, 60619, 60625, 60621]` ms) when everything shares one FIFO — the pre-change behaviour. Real generations issue ~700–800 requests (F-26-6), so the FIFO figure scales to minutes. Confirmed against the running app: a real add-stop resolved in **2.99 s while 8 background verifications were still queued**.

**No migration. No new external calls. Highest value-to-risk ratio in the plan.**

**W1.1 — Interactive lookups pre-empt background checking.** Introduce a priority notion at the `waitForNominatimSlot` boundary (`placeResolver.js:334`) so discovery verification yields to interactive callers (F-26-5). Background work must not be starved indefinitely — it may be delayed, never cancelled.

**W1.2 — The cap must not discard never-checked rows.** Given F-26-1 (no ordering satisfies both plan halves), choose one: exempt rows with no completed check attempt from `enforceCategoryCap` until they have had one, or re-run the cap after the destination's queue drains. The invariant to preserve from Plan 7 decision 4 is unchanged: **a verified row is never archived while an unverified row in the same category is still active.** New invariant to add: a *checked* new row may displace a weaker incumbent.

**W1.3 — Fix CJK name folding, forward-only.** Bring `normalizeName` to `\p{L}\p{N}` with `/u` in both copies (F-26-9), keeping the two mirrors in sync as their comments require. **Do not backfill `normalized_name`** in this wave — existing values stay until W3 has evidence about what a rewrite would merge.

**W1.4 — Resolve Q-26-2.** Recommended: insert and stream **per category as each completes**, rather than one flat insert after all eight (`discoveryGeneration.js:51`). This restores progressive reveal on the merge paths *and* removes the desync risk Plan 7 §1.4 was avoiding, because every streamed card is then a persisted row with a real id and status — strictly better than the pre-Plan-7 behaviour, since those cards can be reported and added on the trusted path.

**W1.5 — "Show more" declines honestly at a full category** instead of spending a daily generation to insert rows that are archived immediately (F-26-2, F-26-16).

**Acceptance:** new tests for the cap-then-check lifecycle (no coverage exists today — the suites cover capping and checking independently) and for CJK folding. Pacing cannot be asserted from unit tests: it requires a measured local drain showing interactive latency stays bounded while a background queue runs.

## W2 — Verifier integrity

**No migration.**

**W2.1 — Name-similarity check on the Google path**, matching what the Nominatim path already does (F-26-8). A result failing the check must not be labelled `resolved`.

**W2.2 — Empty-country destinations record the resolved country** rather than accepting any country silently (F-26-8). This changes `discoveryVerify.test.js:174`'s pinned expectation; update the test deliberately, with a comment recording that the old behaviour was intentional and is being narrowed.

**W2.3 — Google escalation past a weak Nominatim hit (D-26-4).**

> **Plan 24 compatibility gate — mandatory.** Implement as a **per-call opt-in** on `resolvePlace`, exactly as `includeRatingFields` is scoped (`placeResolver.js:470`, set only by `discoveryVerify.js:180`). `discoveryVerify` is the only permitted caller. Changing `resolvePlace`'s shared default ordering would alter stop and booking resolution and would regress the closed Plan 24 decision. **Acceptance requires proving `stops.js` and `bookings.js` behaviour is byte-identical before and after** — a passing suite alone is not sufficient evidence.

Escalation draws on its own daily sub-budget, logged separately.

## W3 — Observability, then measurement

**Additive migration — next free sequence number, nullable columns only.**

**W3.1** Record per attempt: timestamp, provider attempted, outcome, query variant used, match score, returned candidate name.

**W3.2** Re-express the resolver budget in **provider requests**, not lookups (F-26-6), and add the W2.3 sub-budget counter.

**W3.3** Add a bounded re-verification path reaching terminal `unverified` rows (F-26-12), throttled so it can never consume a day's budget in one destination.

**W3.4 — Measure, then answer Q-26-1 and Q-26-3.** Only after real attempt data exists: is the 44% mostly editorial-name failure, provider coverage, country context, or worker execution? Estimate the true provider cost of repairing the corpus before committing to it.

## W4 — Country capture across surfaces

**Additive only, per D-26-2. Ships as one unit — see F-26-10.**

**W4.1** `deriveDayGeo` additionally reports which layer supplied `city` and which supplied `countryCode`. Existing return fields and precedence are untouched; every current consumer keeps reading exactly what it reads today.

**W4.2** Discovery declines a country whose layer differs from the city's layer, falling back to the empty-country path rather than composing a wrong country into the prompt (`discovery.js:141`).

**W4.3** Add a confidence gate to `resolveOverrideCountry` (F-26-10). **Must ship in the same wave as W4.1/W4.2**, never alone.

**W4.4** Retire the D6 single-row country adoption (F-26-14).

**W4.5** Inline country confirmation when the country cannot be determined confidently, and block shared-catalogue creation for unknown-country destinations — this is what produced 北京 and 南疆.

## W5 — Legacy repair

**W5.1** Delete the 北京 and 南疆 destinations and their places (D-26-3).

**W5.2** Un-archive the 78 rows archived before they were ever checked (F-26-3) and let the queue pick them up. Sequenced strictly after W1.2, or they will simply be re-archived. Zero API cost.

**Ops:** take a `sqlite3 .backup` into the chee-owned `~/Trippy/backups/` first — prod `~/Trippy/data` is root-owned with no passwordless sudo.

---

## Verification

- `cd backend; npm test` — note the known Windows teardown segfault *after* results print; it is not a failure.
- `cd frontend; npm test` and `npm run build`.
- New coverage required: cap-then-check lifecycle (W1.2), CJK folding (W1.3), Google name-similarity rejection (W2.1), layer-source reporting (W4.1), and a W2.3 no-change proof for `stops.js`/`bookings.js`.
- Migration (W3): prove ordered application on a disposable copy; never modify an existing migration file.
- UI (W1.4, D-26-1, D-26-5): verify at 375px first, then desktop.
- **Never call this complete from a green suite.** Behaviour, a paid provider, and a data operation are all involved.

## Production QA

Owner click-script, per standing convention — the agent verifies locally, the owner verifies production. To be written as Appendix B when W1 is ready, covering: a Show-more on a full category, a fresh destination's progressive reveal, a free-text CJK destination on a day following a known-country day, and the trust signal on a browse card.

## Cost

W1 **reduces** spend — AI output is currently bought and discarded before checking (F-26-2). W1–W3 add no paid calls. W5.2 costs zero. The only increase is W2.3, bounded by its own sub-budget; Plan 7 §2.2 noted usage sits inside Google's monthly free allowance and the sub-budget keeps that true.

**Unresolved operational question:** real Nominatim request volume is unmeasured and materially higher than the lookup counter implies (F-26-6). If W3 shows sustained bulk volume, the choice between a paid endpoint and self-hosting becomes real — decide on measured numbers. Separately, verify `NOMINATIM_USER_AGENT` is set in production; the default (`config.js:47`) carries a placeholder contact that does not meet the usage policy's identifying-contact requirement. **Check that single variable only — never run `printenv` unfiltered, it prints `GOOGLE_PLACES_API_KEY` in cleartext.**

---

## Appendix A — Optional architectural second opinion on W4

W4 is the only wave adjacent to the Plan 6/7/8 geography model. It is written to be additive precisely so that it cannot contradict design rationale that did not survive into the plan docs. If a second opinion is wanted before implementing it, this is the self-contained prompt — it needs no context from the session that wrote this plan:

> Read `docs/superpowers/plans/Implementation Plan 6 Q2 Geography Model.md`, `Implementation Plan 8 Destination Scopes and Geography Identity.md`, and `Implementation Plan 9 Language-Robust Scopes and Client State Integrity.md`, then `backend/src/services/trips.js` `deriveDayGeo` (~452-510) and `tests/trips.test.js:220`.
>
> Plan 26 W4 proposes: (1) `deriveDayGeo` additionally reports which layer supplied `city` and which supplied `countryCode`, with precedence and all existing return fields unchanged; (2) Discovery alone declines a country whose layer differs from the city's layer; (3) a confidence gate on `resolveOverrideCountry`, shipping in the same wave because fixing it alone increases the rate of null countries and therefore makes the previous-day country inheritance fire more often.
>
> The problem: a free-text day override whose country cannot be inferred inherits the previous day's country, so a 冲绳 day after a Shanghai/CN day resolves to `{ city: 冲绳, countryCode: 'CN' }`. The owner has ruled out changing the layer precedence.
>
> Questions: does the additive layer-source signal conflict with any design intent in Plans 6/8/9? Is there a consumer of `deriveDayGeo` for which "country came from a different layer than city" is *load-bearing* rather than incidental — i.e. where Discovery's rule would be wrong if generalised? Is there a fourth surface beyond trip chips, day overrides, and Discovery that needs the same guard? Answer with file:line evidence; propose no code.
