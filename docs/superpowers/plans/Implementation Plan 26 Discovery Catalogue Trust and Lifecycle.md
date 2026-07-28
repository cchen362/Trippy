# Implementation Plan 26 — Discovery Catalogue Trust and Lifecycle

**Status:** 2026-07-28 — **PLAN COMPLETE. ALL FIVE WAVES DEPLOYED AND VERIFIED IN PRODUCTION.** W1, W2, W3 and the F-26-23 follow-on (`4921dd2`) and W4 (`f0aeabe`) were production-QA'd earlier; **W5 (`ab48512`) was applied to production on 2026-07-28** — 3 empty-country destinations and their 224 places deleted, 116 never-checked rows returned to the queue, zero verified rows lost, re-run reports both items as no-ops. Results and F-26-39…F-26-42 in **Appendix F**. Appendix D PASSED with no defects and no QA debt (W4 results and F-26-36…F-26-38 in **Appendix E**, including the receipt showing W4 stopped a real `乌镇|JP` catalogue). The W1–W3 QA passed sections A–D after two defects in the W3.3 operator script were found by section D and fixed — full results, and four new facts (F-26-24…F-26-26), in **Appendix C**. W4 closed the creation path that F-26-26 caught live: the post-deploy invariant is that production still holds **exactly three** empty-country destinations, and a fourth would mean W4.5 has a hole.

**Deploy record — 2026-07-27, `31f806a` → `c69c806`.** Pre-migration backup taken to the chee-owned `~/Trippy/backups/trippy-pre-plan26-20260726-220714.db`, `PRAGMA integrity_check` = `ok`, 2,014 places / 5 trips. Migration **032 applied cleanly and alone** (31 → 32 migrations); post-deploy row counts unchanged at 2,014 / 5. Health 200, frontend 200, no errors in startup logs. Infra-verified in the running image, not just locally: `cityMatchesAddress` present, `resolvePlace`'s `onAttempt`/`refreshCache` opt-ins present, and **the Plan 24 guard re-proven against the deployed code** — `stops.js` and `bookings.js` each mention `escalateWeakHit`/`onAttempt`/`refreshCache` zero times. `scripts/discoveryReverify.js --dry-run` runs correctly in production and reports 706 terminal-unverified rows across 11 destinations, matching F-26-16 exactly. **Kuala Lumpur is `destination_id=3`** — the id Appendix B step 13 needs. A second deploy (`4921dd2`) followed, carrying no migration, to fix the two script defects section D exposed.

**Deploy record — W4, 2026-07-28, `4921dd2` → `f0aeabe`.** Two commits (`6ea440a` W4 country capture, `f0aeabe` the W4.5/F-26-33 correction), both local-only until this session; pushed to `origin/main` first. **No migration, and this was verified three ways** — no file past `032_discovery_verification_attempts.sql` in the pulled tree, zero `Migration applied:` lines in startup, and `_migrations` unchanged at 32 rows with `id=32`'s `run_at` still `2026-07-27 04:07:54` (an unchanged timestamp, not merely an unchanged count, is what rules out a re-run). Backup taken anyway to the chee-owned `~/Trippy/backups/pre-plan26w4-20260728-050719.db` via `sqlite3 .backup` (8.1 MB). Pre-deploy corpus 2,295 places / 5 trips / 12 destinations; **unchanged post-deploy**. Re-run locally at `f0aeabe` immediately before pushing: backend **784/784** (33 files), frontend **293/293** (43 files), `npm run build` clean; no Windows teardown segfault this time (exit 0). The server's PWA build reported **33 precache entries / 1165.91 KiB**, byte-identical to the local build — a cheap proof the image was built from this tree rather than a cached layer. Health 200, frontend 200, clean startup (`Trippy backend running on :3001 [production]`), container `trippy-trippy-1` recreated.

**Deploy record — W5, 2026-07-28, `f0aeabe` → `ab48512`.** One commit, backend-only, adding `scripts/discoveryLegacyRepair.js` and its tests. **No migration**, proven three ways: no file past `032_discovery_verification_attempts.sql` in the pulled tree, zero `Migration applied:` lines in startup, and `_migrations` id=32's `run_at` still `2026-07-27 04:07:54` — an unchanged timestamp, not merely an unchanged count. The build reported the frontend layer **CACHED** and re-ran only `COPY backend/`, which is a free proof the commit touched no frontend code. Health 200, frontend 200, clean startup (`Trippy backend running on :3001 [production]`). The deploy itself is a runtime no-op: nothing imports the script, so the running app is byte-identical in behaviour — the risk in this release is entirely in the data operation that followed it, which is why the script ships first and runs second. Local at `ab48512`: backend **798/798** (34 files; baseline 784, +14 new), frontend **293/293** (43 files), `npm run build` clean, no teardown segfault.

**Backup — taken BEFORE the pull, not before the delete.** `~/Trippy/backups/pre-plan26w5-20260728-061401.db` (8.8 MB) via host `sqlite3 .backup`, `PRAGMA integrity_check` = `ok`, contents 13 destinations / 2,451 places / 5 trips — matching the live read, which is what proves the backup captured the 4.4 MB WAL rather than a stale main file. **`sqlite3` is NOT installed inside `trippy-trippy-1`** (the first attempt failed on `exec: "sqlite3": executable file not found`); the host binary at `/usr/bin/sqlite3` can read the root-owned `~/Trippy/data/trippy.db` because it is world-readable, and writes the copy into the chee-owned backups directory. Record that pairing — it is the working combination.

**W4 infra-verified in the running image, not just locally.** The two resolver policies F-26-33 requires to stay separate are both present as distinct exports with different gates: `resolveCountryForCityText` (`services/trips.js:1350`) carries W4.3's strict `resolution?.locationStatus !== 'resolved' → null` at `:1353`, and the lenient pre-fill `suggestCountryForDestinationText` (`:1372`) is a separate function that never gates. **W4.5's ordering was proven by line position in the deployed file, not by string presence**: the `country_required` decline returns at `routes/discovery.js:210`, and `getOrCreateDestination` is first reached at `:220` — so a decline provably cannot reach a Claude generation. `findDestination` (the read-only existence check) is at `:153`. `GET /api/lookups/countries` is mounted (`routes/lookups.js:21`); note it answers **401 unauthenticated, and so does a nonexistent `/api/lookups/*` path**, so status code alone cannot prove mounting — read the router. W4's frontend shipped in the `TripPage` and `PlanTab` chunks (`country_required`) and the `dayGeo` chunk (W4.2's helper).

**Post-deploy invariant HELD.** `SELECT id, city_key, display_name FROM discovery_destinations WHERE country_code = ''` returns **exactly three rows — 北京 (id 4), 南疆 (id 5), Suzhou (id 18)** — identical to the pre-deploy read and to F-26-30. No fourth row. This is the check to repeat after Appendix D (its step 8).

**Naming drift worth knowing when reading this plan against the code.** The plan calls W4.3's target `resolveOverrideCountry`; **no such identifier exists** in the codebase — it is `resolveCountryForCityText`. The shipped code also refers to `Plan 26 W4.7` and `W4.8` in comments where this document numbers the same work W4.5 plus the F-26-32/F-26-33 correction. Same work, two numbering schemes; the code's comments are the more detailed account. Not a defect, but grepping the plan's names against the source returns nothing.

**Decisions and open questions.** Six owner decisions taken (D-26-1…D-26-6). Q-26-2 was resolved in W1. **Q-26-1 and Q-26-3 now have measured answers and recommendations awaiting an owner call — see W3.4.**

**Deploy boundary, owner-approved 2026-07-27: W1 + W2 + W3 + F-26-23 ship as one release, before W4.** W4 touches `deriveDayGeo` — the Plan 6/7/8 geography model, test-pinned and load-bearing across day headers, map, share and geocoding bias — and W5 is a data operation; neither should share a release with three waves that have never run in production. W3's own runtime delta is small (its opt-ins are off by default and re-verification runs only from a script), so the risk in this bundle is concentrated in W1's lifecycle changes and W2.1's global name check. Owner click-script: **Appendix B**.

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

**Status:** 2026-07-26 — **COMPLETE. DEPLOYED 2026-07-27 and owner production-QA'd (Appendix C: A3/A4/A5 pass).** No migration, no new external call, no change to any `resolvePlace` caller outside `discoveryVerify`. Backend 726/726 and frontend 280/280 pass; `npm run build` clean. Verified in a real browser at 375px and desktop against the dev DB, including two live generations (Kaohsiung stale-refresh, Osaka append). **Production QA passed** — progressive reveal, interactive pre-emption (a stop resolved in seconds while a Taipei generation ran), and the W1.2 invariant confirmed live (`archived + pending` = 0). A4 read as a failure during QA but was correct behaviour; Appendix B's wording was at fault and is corrected.

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

**Status:** 2026-07-27 — **COMPLETE. DEPLOYED and owner production-QA'd (Appendix C: B6–B9 pass).** No migration, backend-only, no UI surface. Backend 737/737 (32/32 files; baseline was 726, +11 net new) and frontend 43/43 files green; `npm run build` clean. Verified beyond the suite by a throwaway integration harness driving the REAL resolver through the REAL verification worker against a temp DB with `fetch` stubbed (zero provider traffic, zero cost) and inspecting the PERSISTED rows — see "Measured" below. **Production QA passed:** trust labels render, and both a Discovery-added and a manually-added stop resolved correctly under W2.1's now-global name check.

**Measured (persisted-row outcomes, not return values).** The unit suites cannot show this: `discoveryVerify.test.js` mocks `placeResolver` out entirely and `placeResolver.test.js` never touches catalogue rows, so nothing pinned the two halves together. Four scenarios, each ending in a `SELECT` against `discovery_places` and `place_resolution_cache`:

| Scenario | Persisted result | Provider requests |
| --- | --- | --- |
| Weak Nominatim hit → escalation → strong Google | `verified`, `provider_place_id=google:…`, coordinates stored; **shared cache still holds the Nominatim row** (`confidence 0.55`) | nominatim 1, google 1 |
| Same, escalation sub-budget = 0 | `unverified`, no id, no coordinates; exhaustion logged once | nominatim 1, **google 0** |
| Nominatim miss → **unrelated** Google result (W2.1) | `unverified`, no id, no coordinates | nominatim 1, google 1 |
| Empty-country destination, otherwise-strong hit (W2.2) | `unverified`, resolved country recorded in the log line | nominatim 1, google 1 |

Row 3 is the headline user-visible fix: before W2.1 that row became `verified` and stored an unrelated real place's provider id and coordinates — the strongest trust label on the wrong place.

**W2.1 is deliberately GLOBAL, not opt-in — and this is the one place W2 touches interactive behaviour.** The plan's wording is unconditional ("a result failing the check must not be labelled `resolved`"), and a mislabelled `resolved` is the same defect for a user's stop pin as for a Discovery card. Plan 24's closed decision is about provider *ordering*, not about labelling, so this does not reopen it. Concretely: a Google Text Search hit whose returned name/address does not match the query now yields `estimated`/0.55 instead of `resolved`/0.9, for every caller, and the shared `place_resolution_cache` row records 0.55 so a later cache read reproduces `estimated` (`readCache`'s `< 0.7` rule) rather than a false `resolved`. The strong-match path is byte-identical (`resolved`/0.9).

**The check itself was not re-invented.** `classifyNominatimResult`'s inline strong-name/city test was extracted into one shared `classifyNameMatch` used by both provider paths, so there is one definition of "is this actually the thing we asked for" rather than two. Nominatim behaviour is unchanged (same 0.78/0.55 thresholds, same inputs).

**W2.3's escalation is budgeted by callback, not by flag.** `escalateWeakHit` is `null` by default and is a zero-arg function `resolvePlace` invokes *at the moment it is about to issue the Google request* — so the sub-budget counts real paid requests rather than intentions (a boolean would have to be decided before anyone knows whether Nominatim will come back weak). `config.discoveryEscalationDailyBudget` (`DISCOVERY_ESCALATION_DAILY_BUDGET`, default **50**) is a wholly separate counter from the 500-lookup budget, with its own once-per-UTC-day exhaustion log, per D-26-4.

**Cache rule, load-bearing: the escalated Google result is never written to `place_resolution_cache`.** That cache is shared with interactive stop/booking resolution and keyed on (queryText, city, country). Writing a discovery-only escalation result there would silently re-route a later stop lookup onto a Google-named row — a Plan 24 regression through *data* rather than code, which a behaviour-identical-code proof would never catch. The Nominatim row is still written exactly as today; cost is unaffected because each catalogue row is verified once.

**Plan 24 compatibility gate — discharged three ways, not by a green suite.** (1) Argument-level: `escalateWeakHit` defaults to `null`, and none of `stops.js` (:189/:199/:210/:831/:833/:836/:839), `bookings.js` (which has no direct `resolvePlace` call at all — it resolves through `stops.js`) or `trips.js:1269` passes it, so the escalation branch is unreachable from them. (2) Behavioural test: a call made with the exact argument shape `stops.js:189`/`:831` use, against a weak Nominatim hit with a Google key configured, issues **zero** requests to `places.googleapis.com` (asserted on the fetch mock, which throws if Google is touched). (3) Structural pin: a test reads `stops.js` and `bookings.js` from disk and asserts neither mentions `escalateWeakHit`, so a future edit opting them in fails loudly.

**W2.2's narrowing is uniform in both directions, on purpose.** An empty-country destination now fails the country check whether the resolution reports a mismatching country *or none at all* — a hit reporting no country is weaker evidence than one reporting a wrong country, so passing the former while failing the latter would be exactly backwards. There is no schema surface to persist the resolved country this wave (`discovery_places` has no country column; `discovery_destinations.country_code` is half the identity key), so "record" is a structured log line — the evidence W3.1's attempt columns will later persist properly. **Production cost is nil:** the only empty-country destinations are 北京 and 南疆, holding 162 active rows and **zero** verified rows today (D-26-3), deleted in W5.1; W4.5 then stops the path being reachable.

**Two tests were changed deliberately, neither weakened.** `discoveryVerify.test.js:174` pinned the old behaviour on purpose and is rewritten to assert `unverified` + the recording log, with a comment recording why it is narrowed. `discovery.test.js`'s verification-worker failure-isolation fixture used a `''`-country destination; under W2.2 it would still have *passed* while silently measuring nothing (both rows unverified), so its destination is now country-coded and its stubbed resolution reports a matching country — it goes back to testing the isolation it is named for.

**One unreproduced flake, reported not hidden:** a single full-suite run showed `collaboration.test.js > keeps the existing share payload fields byte-identical…` failing. It passed in isolation and in three subsequent full runs, and the W2 diff touches neither share nor day-geo code. Not reproduced; not explained.

**Line numbers cited in the F-facts above were read at `ca37222`, before W1. W1 shifted the ones W2 needs — use these:**

**Line numbers cited in the F-facts above were read at `ca37222`, before W1. W1 shifted the ones W2 needs — use these:**

| What | Fact cites | Now |
| --- | --- | --- |
| `searchGooglePlaces` signature | `placeResolver.js:470` | `:536` |
| Google's hardcoded `locationStatus:'resolved'`/`confidence:0.9` (F-26-8) | `:548` | `:613-614` |
| `classifyNominatimResult` — the name check the Nominatim path already does | `:343` | `:409` |
| `placeNameMatches` — existing name-comparison helper, reuse it | — | `:225` |
| `resolvePlace` signature | `:572` | `:642` |
| Nominatim result returned immediately (F-26-7) | `:618` | `:690` |
| Google consulted only when every variant missed (F-26-7) | `:627` | `:697` |
| `isConfidentHit` (F-26-7, F-26-8) | `discoveryVerify.js:84` | `:83` |
| `isConfidentHit`'s empty-country pass (W2.2) | `:87` | `:87` (unchanged) |
| `verifyOne`'s `baseArgs` opt-ins | `:180` | `:180` (unchanged) |
| W2.2's pinned test expectation | `discoveryVerify.test.js:174` | `:174` (unchanged) |

**W1 added a second precedent for the W2.3 opt-in pattern.** `resolvePlace` now takes `priority = 'interactive'` alongside `includeRatingFields = false` (`:642`), threaded down to `waitForNominatimSlot`, with `discoveryVerify.js:186` the only caller opting into `'background'`. Follow that shape for W2.3's escalation flag — two working examples now exist in the same function.

**W2.1 — Name-similarity check on the Google path**, matching what the Nominatim path already does (F-26-8). A result failing the check must not be labelled `resolved`.

**W2.2 — Empty-country destinations record the resolved country** rather than accepting any country silently (F-26-8). This changes `discoveryVerify.test.js:174`'s pinned expectation; update the test deliberately, with a comment recording that the old behaviour was intentional and is being narrowed.

**W2.3 — Google escalation past a weak Nominatim hit (D-26-4).**

> **Plan 24 compatibility gate — mandatory.** Implement as a **per-call opt-in** on `resolvePlace`, exactly as `includeRatingFields` is scoped (`placeResolver.js:470`, set only by `discoveryVerify.js:180`). `discoveryVerify` is the only permitted caller. Changing `resolvePlace`'s shared default ordering would alter stop and booking resolution and would regress the closed Plan 24 decision. **Acceptance requires proving `stops.js` and `bookings.js` behaviour is byte-identical before and after** — a passing suite alone is not sufficient evidence.

Escalation draws on its own daily sub-budget, logged separately.

## W3 — Observability, then measurement

**Status:** 2026-07-27 — **COMPLETE. DEPLOYED and owner production-QA'd at `4921dd2` (Appendix C).** Shipped together with W1 (`347e8f6`) and W2 (`6428213`) in one release. **Section D initially FAILED**, exposing two defects in the W3.3 operator script (silent CLI exit on an `unref()`'d pacing timer; an ISO-vs-SQLite timestamp mismatch that emptied every run summary) — both fixed and redeployed; see Appendix C. Migration **032** (`032_discovery_verification_attempts.sql`) is additive — one new table, no change to any existing table — and was proven applying in order (030 → 031 → 032) on a disposable copy of a real database, preserving all 655 existing `discovery_places` rows, with a re-run confirmed to be a no-op. Backend **760/760** (33/33 files; baseline was 737, +23 net new), frontend 43/43 files / 280 tests, `npm run build` clean. Verified beyond the suite by a bounded LIVE measurement against the real production corpus — see W3.4 below. Backend is **768/768** after the Appendix C fixes. **Production QA passed on re-run:** attempt telemetry persists, both budget counters surface per drain, and the bounded re-verification path rescued 6 of 12 Kuala Lumpur rows.

**Two production facts checked read-only this wave, both of which retire open plan text.** (1) Production sets *neither* `DISCOVERY_RESOLVER_DAILY_BUDGET` nor `DISCOVERY_ESCALATION_DAILY_BUDGET` — both run on code defaults, which is what made W3.2's config rename safe rather than a silent meaning-change on a deployed variable. (2) `NOMINATIM_USER_AGENT` in production is `Trippy travel planner (contact: ccl_1006@yahoo.com)` — a real identifying contact. **The usage-policy concern recorded at the end of this plan applies only to the local default in `config.js`, not to production.** Checked one variable at a time; `printenv` was never run unfiltered.

**Attempt telemetry is a side channel and is not allowed to break a drain — but it is not blanket-rescued either.** `persistAttempts` handles by name the one *expected* write failure (the place row deleted between enqueue and write, since destination-scoped deletes cascade — migrations 020/021/024 do this today and W5.1 will do it next), and logs anything else as `UNEXPECTED`. A plain try/catch around the whole write would have hidden exactly the schema and reason-vocabulary bugs this table exists to expose.

**Line numbers after W2 — use these, not the F-fact citations above (which were read at `ca37222`, two waves ago):**

| What | Now |
| --- | --- |
| `resolvePlace` signature (all four per-call opt-ins) | `placeResolver.js:683` |
| `readCache` | `:339` |
| Cache short-circuit — the W3.3 trap below | `:706-715` |
| `NEGATIVE_CACHE_TTL_MS` (1 hour) | `:13` |
| `classifyNameMatch` — shared name check, both providers (W2.1) | `:417` |
| `searchGooglePlaces` | `:554` |
| The W2.3 escalation branch (`escalateWeakHit()` call site) | `:743` |
| `hasResolverBudget` / `consumeResolverBudget` — the 500 LOOKUP budget | `discoveryVerify.js:50` |
| `tryConsumeEscalationBudget` — the W2.3 sub-budget (exists already) | `:103` |
| `isConfidentHit` — outcome decision + the empty-country recording log | `:149` |
| `verifyOne`'s `baseArgs` opt-ins | `:255-265` |

**W3.1** Record per attempt: timestamp, provider attempted, outcome, query variant used, match score, returned candidate name. **Two W2 outcomes are currently console-only and are this item's first customers:** the empty-country recording line (`discoveryVerify.js:149` — W2.2 records the resolved country in a log precisely because no schema surface exists yet) and the escalation line (`placeResolver.js:743`, which logs whether Google won). Both should become rows, not greps.

**W3.2** Re-express the resolver budget in **provider requests**, not lookups (F-26-6). **The W2.3 sub-budget counter already exists** — `config.discoveryEscalationDailyBudget` (`DISCOVERY_ESCALATION_DAILY_BUDGET`, default 50) with its own daily counter and its own once-per-day exhaustion log in `discoveryVerify.js`. W3.2's job is re-expressing the *main* budget and surfacing both counters, not inventing the sub-budget.

**W3.3** Add a bounded re-verification path reaching terminal `unverified` rows (F-26-12), throttled so it can never consume a day's budget in one destination.

> **F-26-12 needs a correction, and it is load-bearing for W3.3.** The fact says a re-check "genuinely re-tries over the network rather than replaying a cached failure" because the negative cache expires after an hour. **That is only true for rows cached as `unresolved`.** `resolvePlace`'s staleness test requires `cached.locationStatus === 'unresolved'` (`placeResolver.js:706`); anything else returns the cached row immediately (`:714`, since discovery does not pass `preferNominatim`). The two largest failure classes in the 706-row corpus — a weak `estimated` hit, and a `resolved` hit whose country mismatched — are both cached as non-`unresolved`, so **a naive re-verification would replay the cache forever: no network call, no new outcome, and W2.3's escalation would never fire either** (the escalation branch sits after the cache short-circuit, on the live Nominatim path). W3.3 must therefore include a scoped way to bypass or refresh the cache entry for a re-verification — implement it as another per-call opt-in on `resolvePlace`, defaulting off, exactly as `includeRatingFields`, `priority` and `escalateWeakHit` are scoped, and prove the same way that `stops.js`/`bookings.js` cannot reach it. Measure the true re-verify cost before running it at corpus scale.

**W3.4 — Measure, then answer Q-26-1 and Q-26-3.** Only after real attempt data exists: is the 44% mostly editorial-name failure, provider coverage, country context, or worker execution? Estimate the true provider cost of repairing the corpus before committing to it.

### W3.4 findings — measured 2026-07-27. Reported, not acted on.

Two independent measurements: a read-only retrospective census of all 706 production unverified rows, and a bounded LIVE re-verification of 47 of them driven through the real W3.3 path.

**F-26-17 — The repairable corpus is 544 rows, not 706.** 162 of the 706 belong to 北京 and 南疆, which D-26-3 deletes outright in W5.1. Any repair costing is against 544.

**F-26-18 — Retrospective classification of all 706, from `place_resolution_cache` fossils.** A verification that actually ran always wrote a cache row (the Nominatim result, or the `unresolved()` fallback), keyed on `normalizeText(name)|city|country`, and nothing in the codebase ever deletes from that table — so the presence and shape of a cache row records whether and how each row was checked, even though pre-W1 `provenance` collapsed "never checked" into "checked and failed".

| Class | Rows | Meaning |
| --- | ---: | --- |
| Weak `estimated` hit | **426 (60%)** | Nominatim found a place; `classifyNameMatch` scored it 0.55 |
| Never looked up at all | **257 (36%)** | No cache row exists |
| Genuine provider miss | 16 (2.3%) | Nominatim returned nothing |
| `resolved`, country mismatched | 7 (1%) | Right-shaped place, wrong country |

Known confound, measured not assumed: 63 of 881 `verified` rows (7.1%) also lack a cache row under their name key, so "no cache row" over-counts by roughly that background rate. It does not explain destinations sitting at 97–100%.

**F-26-19 — The 257 never-checked rows have a single identifiable cause, and it is not the worker dying.** They are `batch = 0` rows concentrated in 南疆 (92/92), kualalumpur (92/95) and 北京 (70/70). `batch 0` is what migration 016's `backfillFromGlobalCache` created: it calls `insertPlaces` but **never calls `enqueueForVerification`**, so every backfilled row was stamped unverified at insert and no worker was ever dispatched. This is a *dispatch* gap, not a checking failure — 95 such rows survive W5.1 (kualalumpur 92, Chongqing 3) and have never cost a provider request.

**F-26-20 — Answering the W3.4 question directly: the 44% is dominated by name-match scoring, not provider coverage, not country context, not worker execution.** Provider coverage accounts for 2.3% and country mismatch for 1%. Worker execution (F-26-19) accounts for 36% but only 95 rows post-W5.1. The remaining 60% are places the providers *found* and the name check refused.

**F-26-21 — Live measurement, 47 real production rows through the real re-verification path.** Fresh cache (equivalent to what `refreshCache` buys, since without it all 47 would have replayed cached `estimated` rows and produced zero new outcomes): 140 provider requests, **2.98 requests per place**, 105 s wall clock. Outcome: **5 verified, 42 still `weak_match`**. All 5 rescues came from the W2.3 Google escalation, at 25 escalation requests — a **20% escalation rescue rate**. The escalation sub-budget exhausted mid-run exactly as designed and the remaining destinations proceeded unescalated, so D-26-4's structural ceiling was observed working under load.

**F-26-22 — True cost of repairing the corpus, and its honest yield.** Extrapolating 544 rows at the measured rates: **≈1,630 Nominatim requests** (≈27 minutes of the 1 req/s gate, at `'background'` priority so W1 keeps interactive work ahead of it) plus **≈485 Google escalation requests**, which at ~10 escalations/day under the current sub-budget is ~7 weeks of elapsed time, or one deliberate temporary raise. Expected yield: **roughly 100 of 544 rows (≈18%) move to Verified; ≈444 stay Unverified.** Re-verification is therefore a partial recovery, not a fix for the 44% — worth doing, but it does not retire the problem, and the plan should not be read as though it does.

**F-26-23 — NEW DEFECT found by the measurement, not previously in this plan: `cityMatch` is unsatisfiable for destinations whose `display_name` lost its word spacing.** `classifyNameMatch` (`placeResolver.js:417`) requires the normalized destination `display_name` to appear as a substring of the provider's returned address. `normalizeText('kualalumpur')` is `kualalumpur`, which can never occur inside `kuala lumpur, malaysia` — so a KL row fails the city half **even when the provider returns a byte-identical name**. Observed live: `Islamic Arts Museum Malaysia` and `Thean Hou Temple` both came back exact from Google and were still scored 0.55. Of eleven production destinations, `kualalumpur` and `Chong Qing` (vs. `chongqing`) are structurally affected — **95 + 11 = 106 rows that cannot verify regardless of budget spent on them.** Measured incidence in the live sample: 8 of 100 scored attempts returned an exact name match yet scored weak, 5 of them kualalumpur.

> **FIXED 2026-07-27 as a W3 follow-on, owner-approved, shipping in the same deploy.** The city half of `classifyNameMatch` now folds separators, because the geography-identity layer already treats `Kuala Lumpur` and `kualalumpur` as one place (`canonicalGeoKey` — which is why production has one `kualalumpur` destination row, not two). The check disagreeing with the identity layer was the bug.
>
> **The first attempt at this fix was wrong and the error is worth recording.** Folding separators out of the whole address string — `canonicalGeoKey(address).includes(canonicalGeoKey(city))` — creates a *new* false-positive class by matching across unrelated address components: `canonicalGeoKey("Xi'an, Shanxi, China")` contains `anshan`, so the real city **Anshan** would earn `resolved`/0.9 against an address 1,500 km away. That is exactly the wrongly-`Verified` failure W2.1 closed on the Google path, reintroduced through the city half. The claim "substring matching already lets `york` match `new york`, so folding separators adds no new false-positive class" was asserted during review and is **false** — it holds for matches inside one token, not for matches straddling two.
>
> The shipped fix is boundary-aware: the city must be the prefix of a single address token (`chengdu` against a `chengdushi` component, `york` against `new york`) **or** exactly equal a run of consecutive tokens (`kualalumpur` == `kuala` + `lumpur`). `anshan` is neither, so it correctly fails. Both directions are pinned by test.
>
> **This does not retroactively verify anything.** The 106 rows are terminal `unverified`; the fix makes them *eligible*, and they only flip when W3.3's re-verification is deliberately run — Appendix B step 13.

**Q-26-3 (split `name` into display vs. search name?) — the evidence now supports splitting, and quantifies why.** Of the 544 repairable names, **307 contain brackets and 182 run to six or more words**; only 185 are plain. Some `name` values are prose, not place names — `Michelin Bib Gourmand: Ay-Chung Flour-Shaping (listed above, but worth the emphasis)` is a display string being handed to a geocoder as a search query. `strongName` requires either exact normalized equality with the returned name or the returned address containing the query, and neither can hold for a six-word editorial phrase. Derived variants (`nominatimQueryTexts`' bracket-stripping) already carry 35 of the 64 `estimated`-grade Nominatim hits, i.e. the stripped forms are already outperforming the stored name — which is the upside the original claim asserted and F-26-6 doubted. **Recommendation: split, so the geocoder query is a place name and `name` stays the card's display string.** Owner decision; not implemented here.

**Q-26-1 (does 45 stay the cap?) — recommend leaving 45 unchanged, and closing the question on evidence rather than deferring it again.** The cap's defect was never the number: W1.2 made "archived before it was ever checked" structurally impossible, and F-26-19 shows the population that looked like cap damage was actually never-dispatched backfill. No destination in the live sample was cap-bound. Changing 45 now would be tuning a mechanism whose observed failure mode has been removed.

## W4 — Country capture across surfaces

**Status:** 2026-07-28 — **COMPLETE, DEPLOYED (`f0aeabe`, no migration — see the W4 deploy record at the top) and PRODUCTION-QA'd. Appendix D passed with no defects; results in Appendix E. WAVE CLOSED.** All five items (W4.1–W4.5) plus the W4.5 decision-table correction forced by QA (F-26-32/F-26-33). No migration. Backend **784/784** (33 files; baseline was 768) and frontend **293/293** (43 files; baseline was 280); `npm run build` clean. Appendix A's second opinion was run before any code was written and cleared the core risk.

**Browser QA results (375px and desktop, dev DB, real resolver).** The suite did **not** catch three of these; two were found only by driving real trip data.
- **F-26-10 reproduced live and then fixed live.** A 冲绳 override on a Shanghai/CN day resolved to `{city: 冲绳, countryCode: CN, countryEvidenceCity: 'Shanghai'}`. Discovery declined `CN`, the confirmation resolved to `JP`, and that day now serves **73 Okinawan places** — Shuri Castle (首里城), Okinawa World, Gyokusendo. Before W4 the same day asked Claude for places in *"冲绳, China (CN)"*.
- **W4.3 held:** `city_override_country` stored `null` rather than a guess; 1135 ms round-trip confirms the call kept `'interactive'` priority (W1.1).
- **W4.5 creation path closed:** confirming a country created `冲绳|JP`, **not** an empty-country row.
- **No-nag guarantee (F-26-33 case 2) proven by latency:** a repeat Kaohsiung request served 8 categories / 56 items in **14 ms**, twice. A geocoder call costs ~700–1000 ms, so the timing itself proves none was made.
- **Equinix regression closed:** `qwxzptlkvv` declines with `SG` as pre-fill only, creating **zero** rows and spending **zero** Claude/Google calls.
- **Case 1 verified incidentally:** a request against the existing `hanoi|''` row served and refreshed it without a decline and created nothing new.
- **Design floor:** confirmation block verified at 375px (stacked, 44px targets) and desktop (row at the 640px breakpoint), `--gold` resolved to `rgb(201,168,76)` = `#c9a84c` exactly, no horizontal overflow.
- **Cost incurred:** proving the creation path end to end spent one real Claude generation on the dev DB (new `冲绳|JP`, destination id 20). Dev-only.
- **Left in the dev DB deliberately:** the 冲绳 override on the "Shanghai - Hangzhou (W3 verify)" trip's 2026-07-28 day, and destination id 20. Remove them if a later session needs a clean fixture.

Owner production QA click-script: **Appendix D**.

**Appendix A was run first and returned three results worth keeping.** (1) **No conflict with Plans 6/8/9.** Plan 8 and Plan 6 Wave 2 both already document independent city/country selection as *intentional*, and `deriveDayGeo`'s own docstring states it — W4.1 formalises a fact those plans assert, rather than introducing one. (2) **Exactly two consumers treat cross-layer city/country as load-bearing rather than incidental**: the trip destination-chip/scope pairing (`deriveTripDestinationPairsFromDays`) and `stops.js`'s geocoding-bias resolution anchor (`stops.js:152-153`), the latter being the entire point of Plan 8's resolution-anchor design. Generalising Discovery's decline rule to either would regress documented, test-pinned behaviour. This is why D-26-2 scopes the rule to Discovery alone, and W4 honours it. (3) **W4.3's extra nulls break nothing** — `getMapConfigForCountry(null)`, the deep-link provider, share's `.filter(Boolean)` and `resolvePlace`'s country bias are all already null-tolerant and already exercised by the KL trip. The real cost is a *visible downgrade*, recorded as F-26-29 below.

**F-26-27 — W4.2's rule had to be a CITY comparison, not a LAYER comparison, and the plan's literal wording was wrong.** W4.2 was written as "Discovery declines a country whose layer differs from the city's layer." Implemented literally, that also declines two correct, deliberate cases: (a) the pinned Melaka case (`tests/trips.test.js:220`) — override city "Melaka" with no country plus a same-night hotel reporting `{Melaka, MY}` — where city and country come from different layers *and name the same place*; and (b) `extractGeoFromBooking`'s Rule 4 demote path (`trips.js:382-398`), which deliberately keeps a hotel's country when its city nulls out. Owner-approved refinement, taken 2026-07-27: **decline the country only when the layer that supplied it also named a city that is a different place** (by `canonicalGeoKey`) from the winning city. 冲绳-after-Shanghai declines (previous layer names Shanghai); Melaka does not (hotel layer names Melaka); hotel-demote does not (that layer named no city, so nothing contradicts the day's city). This is a strict subset of the literal rule, still Discovery-only, still additive — D-26-2 is untouched.

**F-26-28 — the same defect existed one level up, in the UI, and W4.2 nearly shipped on top of it.** `DiscoveryPanel.jsx` and `TripPage.jsx` each resolved the Discovery destination and its country through two *independent* `??` chains (`activeDay → days[0] → trip.destinations[0]` and the country equivalent). Two consequences: (a) the panel could pair one day's city with a **different day's** country — F-26-10's own defect at panel scope; and (b) once `discoveryCountryForDay` correctly rejected a country, `??` fell straight through to the next candidate, which for a Shanghai trip is *the Shanghai day's `CN`*, and failing that `trip.destinationCountries[0]`, which is **also `CN`**. The rule fired, was correct, and was then undone twice by the chain it sat in. Root cause: `null` acquired a second meaning ("rejected") in a chain built when it only meant "absent". Fixed by resolving the geography **source day once** and reading both city and country off it; the trip-level fallback now applies only when there is no geo day at all. Pinned by regression tests in both files that assert `discover` is called with `null` even when `days[0]` and `destinationCountries` both hold the rejected country.

**F-26-29 — W4.3's accepted cost: predicted, and NOT observed in QA. Stated as prediction, not as measurement.** A day whose override text previously resolved to a *correct but low-confidence* country now gets `null` in `city_override_country`. Nothing crashes — every consumer is null-tolerant — but where the override was the day's **only** country source, that day's map tiles and deep-link provider downgrade from Amap/Naver to the generic OSM/Google default. **This did not occur in local QA**, because the dev trip used to reproduce F-26-10 has a hotel booking supplying `CN` at layer 2, so the day's resolved country was never null despite `city_override_country` being correctly nulled. It is recorded here as a predicted consequence with no observed instance; the owner QA script should watch for it rather than assume it is impossible.

**F-26-30a — the deliberate, and initially surprising, consequence of D-26-2: only Discovery changes.** Verified live on the 冲绳 day. `city_override_country` is `null` (W4.3 held), Discovery correctly declines `CN` and serves an **Okinawa** catalogue — but the day header still reads its resolved country and `/map-config` still returns **Amap / GCJ-02 / `deepLinkProvider: amap`** for that day, because the hotel layer still supplies `CN` and precedence is unchanged. So an Okinawa day continues to render Chinese map tiles and Amap deep links. **This is not a W4 regression** — it is exactly what D-26-2 mandates, and it is unchanged from before the wave. It is recorded because it *looks* like a bug in QA and will be reported as one otherwise. Whether the day header and map should also stop trusting a cross-layer country is a **precedence** question the owner has ruled out for this plan; reopening it would need a separate decision.

**F-26-30 — production census re-derived 2026-07-27 (read-only), superseding D-26-3's list.** Twelve `discovery_destinations` rows. Empty-country: **北京 (id 4, 70 places), 南疆 (id 5, 92 places), Suzhou (id 18, 62 places, 0 verified)** — three, not two, confirming F-26-26 and fixing W5.1's delete list. Second finding: **no production `city_key` currently has both a country-coded row and an empty-country row**, so W4.4's retirement of the D6 adoption is a **no-op for the entire live corpus** — it changes future behaviour only. (The *dev* database does have the collision, `chongqing` at both `''` and `CN`, which is what made the "existing empty row keeps serving" branch verifiable locally.)

**F-26-32 — `locationStatus` cannot gate country inference, in EITHER direction, and browser QA proved both halves.** W4.5 originally declined to the user whenever the day's evidence gave no country. Measured against the owner's five real dev trips, **five days decline and four are false** — every one an ordinary city-change day where the new city came from a hotel/transit booking carrying no country, so the country fell through to the previous day's carry whose city differs. Worse, nothing persists a confirmation (`committedCountry` is component state), so **the prompt recurs on every panel open**. The fix attempted was to infer the country server-side, gated as W4.3 gates `resolveOverrideCountry`. Both bars then failed, measured live against the real resolver:

| Destination | `locationStatus` | conf | country returned | correct? |
| --- | --- | ---: | --- | --- |
| Kuala Lumpur | `resolved` | 0.78 | MY | yes |
| Singapore | `resolved` | 0.78 | SG | yes |
| Kaohsiung | `estimated` | 0.55 | TW | yes |
| Chongqing | `estimated` | 0.55 | CN | yes |
| Suzhou | `estimated` | 0.55 | CN | yes |
| Chengdu | `estimated` | 0.55 | CN | yes |
| 冲绳 | `estimated` | 0.55 | JP | yes |
| Georgetown | `resolved` | 0.78 | US | **ambiguous homonym** |
| `qwxzptlkvv` (gibberish) | `estimated` | 0.55 | SG | **"Equinix Singapore", a data centre** |

**Strict is too strict:** five real cities score `estimated` purely because the returned name is CJK or suffixed (高雄市, "Chengdu City") and `classifyNameMatch` cannot match the romanised query — the *country* was right every time. **Lenient is unsafe:** `qwxzptlkvv` missed on Nominatim, fell through to Google Places, matched a data centre, and — before this was caught — **created a junk `qwxzptlkvv|SG` destination and spent a paid Google call plus a Claude generation**, the exact failure class W4.5 exists to prevent. And the strict gate buys no homonym protection: `Georgetown` passes at 0.78 and confidently returns US. **`locationStatus` measures place *identity*, not *country*; no threshold on it is both safe and useful.**

**F-26-33 — resolution (owner decision, 2026-07-27): a shared-catalogue destination is never CREATED without a human confirming its country.** The geocoder became a *pre-fill*, never an authority. For a request with no country: (1) an existing `(cacheKey, '')` row serves unchanged; (2) **exactly one** country-coded row for the key is adopted silently — the destination already exists, and re-asking was the nag; (3) **zero, or more than one**, always declines with `country_required`, pre-filled from `countryCodeFromName` then the geocoder's returned country *regardless of `locationStatus`*. Case 2 is deliberately narrower than the D6 rule W4.4 removed: D6 also fired on the **creation** path, where a `canonicalGeoKey`-folded homonym could mint a wrong-country catalogue; case 2 only ever reuses a row that already exists, and >1 row — the London-Ontario / Georgetown case — is never guessed. The Equinix result is now harmless: it can only pre-select an entry in a dropdown the user must actively confirm, and cannot create a row or spend a Claude call, because the decline returns before both. Two resolver policies now exist deliberately and must not be merged: **strict** (`resolved` only) guards `updateDayCityOverride`, which writes durable day geography; **lenient** only pre-fills a control the user confirms.

**F-26-34 — the free-text destination chip in create/edit trip is the same gap, on a surface W4 does not touch.** Picking an autocomplete suggestion captures a country (`DestinationChipPicker.jsx:36`), but committing free text produces `{ countryCode: null, kind: 'freetext' }` (`CityInput.jsx:46`, `DestinationChipPicker.jsx:58`) — visibly tagged `FREETEXT` in the chip, with nothing asking for a country. That null reaches day geography, so besides Discovery it silently downgrades the day's map provider per F-26-29, with **no prompt anywhere to catch a London-Ontario-vs-London-UK mistake**. **Deliberately out of W4** (owner call, 2026-07-27): the chip editor is a different surface with its own modal/scope-reconcile QA, and W4 is already the wave adjacent to the test-pinned geography model. Proposed as a standalone follow-on applying F-26-33's pre-filled confirmation at chip-commit time.

**F-26-35 — the pre-fill is often wrong for exactly the destinations the owner worried about, and that is now harmless by construction.** Observed live at desktop width: typing **Penang** pre-selects **Indonesia (ID)**; Penang is in Malaysia. `Georgetown` resolves confidently to **US**. These are the London-Ontario class. Under the rejected lenient rule each would have silently created a wrong-country catalogue — `penang|ID` generating Indonesian suggestions for a Malaysian island, every row unverifiable. As a **pre-fill** the same wrong guess costs one dropdown change. This is the measured justification for F-26-33: the guess did not get better, its **blast radius** did. Improving pre-fill accuracy is a separate, optional optimisation and is **not** a correctness dependency.

**F-26-31 — a fourth AI-facing surface exists and is NOT guarded by W4.** `importer.js:238-256` (`runExtraction`'s `tripContext.destinations`) builds the same per-day `{city, countryCode}` pairs, deduped by city in day order, and feeds them straight into the Claude **booking-extraction** prompt. It is structurally identical to the Discovery problem — a wrong cross-layer country composed into an LLM prompt as ambient trip context, where it can steer how an extracted booking's addresses and dates are interpreted. Found by the Appendix A second opinion. **Deliberately out of W4** (owner call, 2026-07-27): W4 is already the riskiest wave, and booking extraction is a separate risk surface needing its own verification pass. Proposed as a standalone follow-on; the guard is the same `discoveryCountryForDay`-shaped rule at one more call site.

**No migration.** Every item is additive or a narrowing of an existing inference, exactly as forecast.

**W4.5 is now the highest-priority item in the whole plan, and its justification changed during W3 QA.** It was written to explain 北京 and 南疆 — the owner's old CJK free-text tests, dismissible as not-real-demand. Then Appendix C's F-26-26 recorded a **new** empty-country destination, **Suzhou**, created through ordinary use on 2026-07-27, holding 11 places that can never verify. The creation path is live, not historical. Consider leading the wave with W4.5.

**Additive only, per D-26-2. W4.1/W4.2/W4.3 ship as ONE unit — see F-26-10. This is a hard sequencing constraint, not a preference:** W4.3 alone increases the rate of null countries, which makes the previous-day inheritance in W4.1/W4.2 fire *more* often. Shipping W4.3 first makes the bug it is meant to help worse.

**Line numbers after W3 — the F-fact citations above were read at `ca37222`, three waves ago. Use these:**

| What | Fact cites | Now |
| --- | --- | --- |
| `deriveDayGeo` signature | `trips.js:504-509` | `services/trips.js:452` |
| The layers array (precedence order — **do not reorder**, D-26-2) | — | `:504` |
| **F-26-10's mechanism**: `city` and `countryCode` each selected by an INDEPENDENT `.find(Boolean)` over `layers` | `:504-509` | `:505-509` |
| Documented precedence comment | `:440-443` | `:430-450` |
| `resolveOverrideCountry` — W4.3's target | `:1263-1274` | `:1263` (unchanged) |
| `updateDayCityOverride` — the awaited caller inside the PUT | `:1269` | `:1276` |
| Discovery's D6 single-row country adoption (W4.4, F-26-14) | `discovery.js:122-131` | `routes/discovery.js:115-131` |
| Where the adopted country enters `getOrCreateDestination` (W4.2/W4.5) | `discovery.js:141` | `routes/discovery.js:164` |
| `deriveDayGeo`'s pinned test suite | `tests/trips.test.js:220` | `tests/trips.test.js:183` (describe block) |

**W4.3's gate is precisely identifiable.** `resolveOverrideCountry` returns `resolution?.countryCode || null` with **no reference to `locationStatus` or `confidence`** — it accepts any country from any hit. W2.1 did not change this, because W2.1 narrowed the *labelling* and this function ignores the label. The gate is to require `locationStatus === 'resolved'`. Note this call does not pass `priority`, so it correctly defaults to `'interactive'` (W1.1) — do not change that.

**W4.1 — DONE.** `deriveDayGeo` additionally returns `citySource`, `countrySource` (`'override'|'hotel'|'transit'|'previous'|'seed'|null`) and `countryEvidenceCity` — the city named by the country-winning layer, or `null` when that layer named no city. Precedence and the three existing return fields are byte-identical for every input; the layers array is tagged explicitly rather than by spreading `previousGeo`, which is the previous day's full return object and would otherwise leak its stale source keys into this day's layer. Surfaced on `listDaysForTrip` and `getDayGeo` as `resolvedCitySource` / `resolvedCountrySource` / `resolvedCountryEvidenceCity`. **`share.js` and `mapData.js` deliberately untouched** — the public share payload is intentionally reduced and the map does not need the signal.

**W4.2 — DONE**, per the F-26-27 refinement. One shared frontend helper, `discoveryCountryForDay` (`frontend/src/utils/dayGeo.js:30`), used at both call sites so there is a single definition of the rule. See F-26-28 for the `??`-chain defect fixed alongside it.

**W4.3 — DONE.** `resolveOverrideCountry` requires `locationStatus === 'resolved'`. W2.1 narrowed the *labelling* of weak matches to `estimated`; this function never read the label, so it was still accepting a guess as a fact. The call deliberately keeps `resolvePlace`'s default `'interactive'` priority (W1.1) — it is awaited inside the PUT while the user watches a spinner. Shipped in the same commit as W4.1/W4.2, as required.

**W4.4 — DONE.** The D6 single-row country adoption is retired (F-26-14): `canonicalGeoKey` folds homonyms, so "one prior row shares this key" was never identity evidence about a newly typed label. The single-row case survives **only as a pre-filled suggestion** the user can accept or override. No-op for the live corpus (F-26-30).

**W4.5 — DONE.** `POST /discover` refuses to **create** an empty-country destination and streams a `country_required` decline instead; `useDiscovery` routes it to the calm `notice` channel (the W1.5 pattern), and the Discovery panel renders an inline country confirmation, pre-filled with `suggestedCountryCode`. Scoped to creation only: an empty-country row that **already exists keeps serving its places**, because W5.1 is what deletes the three that exist and blocking reads here would break them first. `findDestination` (the read-only counterpart of `getOrCreateDestination`) is what makes the existence check safe — it cannot mint the row it is checking for. The decline fires before `getOrCreateDestination`, before the daily-generation counter, and before any Claude call. New endpoint `GET /api/lookups/countries` serves the picker from the existing `REGION_CODES`/`Intl.DisplayNames` table, so the list cannot drift from `countryCodeFromName`.

## W5 — Legacy repair

**Line numbers after W4 — every table above this point predates it. Use these:**

| What | Now |
| --- | --- |
| `deriveDayGeo` signature | `services/trips.js:471` |
| The tagged layers array (precedence — **do not reorder**, D-26-2) | `:527` |
| `listDaysForTrip` — where `resolved*Source` are stamped | `:1145` |
| `getDayGeo` | `:1199` |
| `resolveOverrideCountry` + its W4.3 gate | `:1316` |
| `updateDayCityOverride` (the awaited caller) | `:1338` |
| `deriveTripDestinationPairsFromDays` (cross-layer country is LOAD-BEARING here — never apply W4.2's rule) | `:558` |
| W4.5's `country_required` decline | `routes/discovery.js:163-184` |
| `findDestination` existence check (creation-only scoping) | `routes/discovery.js:164` |
| `catalogue_full` decline (the W1.5 precedent) | `routes/discovery.js:272` |
| `GET /api/lookups/countries` | `routes/lookups.js:20` |
| `listCountries` | `utils/countries.js:94` |
| `discoveryCountryForDay` — the single definition of W4.2's rule | `frontend/src/utils/dayGeo.js:30` |
| `DECLINE_CODES` (now includes `country_required`) | `frontend/src/hooks/useDiscovery.js:19` |
| `geoDay` same-source resolution (F-26-28) | `frontend/src/components/discovery/DiscoveryPanel.jsx:271` |
| The country-confirmation render gate | `frontend/src/components/discovery/DiscoveryPanel.jsx:620` |

**W5.1 — DONE.** Delete the empty-country destinations and their places (D-26-3). **Re-derive the list at execution time — it is now THREE, not two:** 北京 (id 4), 南疆 (id 5) and **Suzhou (id 18)**, per F-26-30. Ids are from the 2026-07-27 census and must be re-confirmed against production before any delete runs. W4.5 has closed the path that creates new ones, so the list should not grow again — verify that it has not before deleting. *Applied 2026-07-28: the live set matched exactly, and the script refuses to run at all unless it does.*

**W5.2 — DONE.** Un-archive the rows archived before they were ever checked (F-26-3) and let the queue pick them up. Sequenced strictly after W1.2, or they will simply be re-archived. **That gate is now SATISFIED — W1 shipped and was production-QA'd on 2026-07-27 (`4921dd2`), with the `archived + pending = 0` invariant confirmed live — so W5.2 is unblocked.** Zero API cost. Re-count the 78 against production before acting; the figure is from the 2026-07-26 census and W1/W2/W3 have run in production since. *Re-counted 2026-07-28: **the 78 was wrong in both size and membership**, and both errors trace to F-26-3's identifying rule rather than to drift. See F-26-39/F-26-40. The repaired population was 116.*

**The tool:** `backend/scripts/discoveryLegacyRepair.js` (`ab48512`), report-only by default, `--apply` to write, `--expect-destinations` mandatory for the delete. It is not wired into any request path and makes no provider call. Both operations are idempotent — re-running after the fact reports zero work, which is the cheapest proof the repair is complete.

**W5 status: 2026-07-28 — COMPLETE, APPLIED IN PRODUCTION and verified. WAVE CLOSED, PLAN CLOSED.** Both items ran against production behind the mandatory backup, and re-running the script now reports both as no-ops (idempotent). Results, and four new facts (F-26-39…F-26-42), in **Appendix F**. The delete list was re-derived live and had **not** grown — the W4.5 invariant held.

**W5.2's scope was widened by owner decision, taken 2026-07-28 during the re-derivation.** The plan's wording covers only the *archived* never-checked rows. The same defect (F-26-39) also strands rows that are still `active` but were never dispatched for a check — F-26-19's migration-016 backfill population, which `enqueueForVerification` can never re-collect because they sit at terminal `unverified`. They are the cap's next victims. Owner approved repairing both in one pass: same defect, same zero-AI-cost fix, one bounded day of Nominatim budget.

**W5.1 must not try to geocode its way to a country for 北京 or 南疆 — F-26-38 is a direct warning, not background.** Both are CJK strings with no country, which is precisely the class that resolved 乌镇 to a road in Osaka (F-26-37) once the country bias was absent. A brand-new or country-less destination has no bias by construction. D-26-3 says **delete, do not regenerate**, and F-26-38 is the mechanical reason that decision is also the safe one: any "recover the country first" alternative would be running the exact lookup W4 exists to distrust. Suzhou (id 18) is covered by the same reasoning — it holds 62 places and **zero** verified rows, so there is nothing to preserve.

**Ops:** take a `sqlite3 .backup` into the chee-owned `~/Trippy/backups/` first — prod `~/Trippy/data` is root-owned with no passwordless sudo. The delete is the first genuinely destructive data operation in this plan: every prior wave was additive or a narrowing. Treat the backup as mandatory, not optional, and get owner sign-off on the re-derived delete list before it runs.

---

## Verification

- `cd backend; npm test` — note the known Windows teardown segfault *after* results print; it is not a failure.
- `cd frontend; npm test` and `npm run build`.
- New coverage required: cap-then-check lifecycle (W1.2), CJK folding (W1.3), Google name-similarity rejection (W2.1), layer-source reporting (W4.1), and a W2.3 no-change proof for `stops.js`/`bookings.js`.
- Migration (W3): prove ordered application on a disposable copy; never modify an existing migration file.
- UI (W1.4, D-26-1, D-26-5): verify at 375px first, then desktop.
- **Never call this complete from a green suite.** Behaviour, a paid provider, and a data operation are all involved.

## Production QA

Owner click-script, per standing convention — the agent verifies locally, the owner verifies production. **Written: see [Appendix B](#appendix-b--owner-production-qa-click-script-w1--w2--w3--the-f-26-23-fix)**, covering the combined W1+W2+W3+F-26-23 deploy.

One item from this section's original outline is deliberately **not** in Appendix B: the free-text CJK destination on a day following a known-country day. That is F-26-10's previous-day country inheritance, which W4 fixes and which W4.3 must ship alongside W4.1/W4.2 — it belongs in W4's own QA pass, not this deploy's.

## Cost

W1 **reduces** spend — AI output is currently bought and discarded before checking (F-26-2). W1–W3 add no paid calls. W5.2 costs zero. The only increase is W2.3, bounded by its own sub-budget; Plan 7 §2.2 noted usage sits inside Google's monthly free allowance and the sub-budget keeps that true.

**Operational question — now answered by W3 measurement.** Real Nominatim volume is **2.98 requests per place** (F-26-21), so the old 500-*lookup* budget was permitting roughly 1,500 requests while reporting 500. W3.2 re-expressed it as `DISCOVERY_RESOLVER_DAILY_REQUEST_BUDGET` (default 1000 **requests**), which is the first time the number has meant what it says. A full corpus repair is ≈1,630 requests (F-26-22) — a one-off spread across days at `'background'` priority, not sustained bulk volume, so **neither a paid endpoint nor self-hosting is justified on these numbers.** Revisit only if routine generation volume rises.

`NOMINATIM_USER_AGENT` **is** set correctly in production (checked read-only 2026-07-27: a real identifying contact). Only the local default in `config.js` carries the placeholder. **When checking, check that single variable only — never run `printenv` unfiltered, it prints `GOOGLE_PLACES_API_KEY` in cleartext.**

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

---

## Appendix C — Production QA results, 2026-07-27

Owner ran Appendix B sections A and B; the agent ran C and D. **Sections A, B and C pass. Section D failed and exposed two real defects in shipped code**, both fixed at `4921dd2` and redeployed.

### Two defects in `scripts/discoveryReverify.js`, found only by running section D

Both were invisible to `--dry-run`, because the dry run never drains — **it skips the only asynchronous path in the feature.** A smoke test that avoids the thing being tested proves nothing, and this plan treated a passing dry run as evidence the operator path worked.

**D-1 — the process exited mid-drain, cleanly.** `placeResolver`'s Nominatim pacing timer is `unref()`'d (W1.1) so the shared gate can never hold the Express server or a test run open. That is correct in the server and fatal in a short-lived CLI: between two paced lookups nothing refs the event loop, so Node exits with **code 0** — partial work written, no summary, no error. In a deploy log it is indistinguishable from success. Fixed by having the job runner hold a ref'd handle for exactly as long as it has outstanding work; the `unref()` in the resolver is correct and unchanged.

**D-2 — the run summary always reported zero.** The script marked its start with `new Date().toISOString()` and passed it as `since`, but `attempted_at` is written by `datetime('now')` as `YYYY-MM-DD HH:MM:SS` and the filter compares TEXT, where `' '` (0x20) sorts before `'T'` (0x54) — so the marker excluded **every row the run had just written**. Fixed by reading the marker from SQLite itself, so there is no format to convert between. This is the same SQLite-format trap `placeResolver.js`'s `cacheTimestampToEpochMs` already exists to handle. Pinned by regression test.

The script now fails loudly instead of silently: candidates available plus zero attempt rows written is a non-zero exit that states whether the budget was the cause. **That guard is what surfaced D-2 immediately after D-1 was fixed** — without it, D-2 would have shipped as a permanently empty summary.

### F-26-24 — Measured production cost is ~4.1 requests per place, not 2.98

Real generation traffic on 2026-07-27: **253 places, 1,001 provider requests, 4.14 per place** (Taipei alone: 180 places / 751 requests). W3.4's sample measured 2.98 on a fresh cache, so **F-26-22's cost estimate is ~38% low**; a full 544-row repair is ≈2,230 requests, not ≈1,630.

**The re-expressed budget is honest but tight: 1,000 requests is about two generations.** One Taipei "Show more" plus one new destination exhausted the day, leaving 51 rows at `pending` (Taipei 40, Denpasar 11). Those are not lost — W1's pending re-collection picks them up on the next browse — but the owner should expect a same-day second generation to leave rows unchecked until tomorrow. Whether 1,000 is the right ceiling is now an evidence-backed owner decision rather than a guess.

### F-26-25 — Re-verification rescues far more than F-26-22 projected, for the city-bug subset

Kuala Lumpur, 12 places attempted, 55 requests: **6 verified (50%)**, including `Islamic Arts Museum Malaysia` and `Thean Hou Temple` — the exact two rows W3.4 identified as blocked by F-26-23. All six wins came through W2.3's Google escalation being allowed to pass classification once the city check was fixed. F-26-22's ~18% projection was measured *before* the F-26-23 fix existed and on a sample dominated by destinations that were never city-bug-affected; **it remains the right expectation for Shanghai/Taipei/Hangzhou and is far too pessimistic for the kualalumpur/Chong Qing subset.** Note also 39 Nominatim variant misses against 16 Google hits here — for KL specifically, OSM coverage genuinely is weak and Google is doing the work.

### F-26-26 — W4.5 is now urgent: a NEW empty-country destination was created during QA

Section A3 created **Suzhou with `country_code = ''`** — a 12th empty-country destination, joining 北京 and 南疆. Eleven of its places already recorded `empty_destination_country` and **can never verify**. D-26-3 deletes the two known ones in W5.1, but Suzhou proves the *path that creates them is still open*: this is exactly what W4.5 ("block shared-catalogue creation for unknown-country destinations") exists to close, and it is now demonstrably reachable through ordinary use, not just through the owner's old CJK free-text tests. **W5.1's delete list must be re-derived at execution time, not copied from D-26-3.**

### Confirmed working in production

- **W1's core invariant holds:** `archived + pending` = **0**. No never-checked row was archived by the cap. The `reason=category_cap provenance=unverified` archives in the logs are correct — those rows were checked and failed, which the cap is allowed to archive.
- **W1.4 progressive reveal** (A3), **W1.1 interactive pre-emption** (A5 — a stop resolved in seconds while a Taipei generation ran), **trust labels** (B6), **Discovery-added and manually-added stops** (B7/B8/B9) all pass.
- **D-26-4's structural budget separation proved itself:** the main resolver budget was fully exhausted (1001/1000) while re-verification still ran, because its counter is genuinely independent.
- **A4 was correct behaviour, not a bug — Appendix B's wording was wrong.** W1.5's decline fires only when **no** category has headroom (see the W1.5 scope note); Taipei had a few full categories and headroom elsewhere, so a normal generation ran and no notice was due. Appendix B step 4 has been corrected.

---

## Appendix D — Owner production QA click-script (W4)

Standing convention: the agent verifies locally, the owner verifies production. **No migration in this deploy** — a backup is still wise, but there is no schema change to confirm.

**What actually changes for you.** Almost all of W4 is invisible. Three things are not:
- **Discovery stops trusting a country that came from somewhere else.** If a day's country was inherited from a *different city* (yesterday's carry, a booking for another place), Discovery ignores it rather than asking Claude for places in the wrong country.
- **A brand-new destination now asks you which country it is**, once, pre-filled. This replaces silently creating a catalogue that could never verify — the Suzhou defect.
- **Typing a day's city by hand no longer guesses its country** from a weak match. It leaves it blank instead.

**Two things that look like bugs and are not — do not report these:**
1. **An overridden day still shows its old country in the day header and still uses that country's map tiles.** W4 gives *Discovery alone* permission to decline a cross-layer country (owner decision D-26-2); day headers, the Map tab and deep links deliberately keep reading exactly what they read before. Verified: a 冲绳 day still returns Amap/GCJ-02 tiles because a Shanghai hotel supplies `CN`. This is unchanged pre-existing behaviour, not a W4 regression (F-26-30a).
2. **The pre-filled country in the confirmation is sometimes wrong** — Penang pre-fills Indonesia, Georgetown pre-fills the US (F-26-35). It is a suggestion, not a decision; change it in the dropdown. It can no longer create anything on its own.

### A — The country confirmation (W4.5, the Suzhou fix)

1. Open a trip → **Plan** → **Discover** → **Change** → type a city the catalogue has **never seen** (production currently knows kualalumpur, 北京, 南疆, chengdu, chongqing, denpasar, bali, taipei, kaohsiung, shanghai, hangzhou, suzhou — pick anything else) → **Go**.
   **Expect** a calm boxed question, *not* a red error: *"We don't know which country X is in — confirm it and we'll start its catalogue."* with a **Country** dropdown and a **Confirm** button.
   **Check the pre-fill is sane but do not trust it** — correct it if wrong, then Confirm. **Expect** the catalogue to generate normally afterwards.
2. **The regression that matters most.** Reopen Discovery on that same destination. **Expect NO second prompt** — it must serve the catalogue directly. A prompt that returns on every open is the defect W4 was corrected for; report it immediately.
3. Open Discovery on a destination that already exists in production (Taipei, Shanghai). **Expect no prompt at all, ever.**

### B — Cross-layer country decline (W4.1/W4.2)

4. On a multi-city trip, open Discovery on a day in the **second** city (one reached by a hotel or flight booking). **Expect** suggestions for that city, correct country, and — per step 3 — no prompt, because that destination already exists.
   **Report if:** you get suggestions for the *wrong city*, or a prompt for a destination that clearly already exists.
5. **The headline case.** On a day, set a free-text city override to somewhere in a **different country from the day before** (e.g. a Japanese city on a China trip). Open Discovery on that day.
   **Expect** either a country confirmation (if that destination is new) or a correct-country catalogue — **never** suggestions from the previous day's country. This is F-26-10, the bug the wave exists for.
   **Remember point 1 above:** that day's header and map tiles will still show the old country. That is intended.

### C — The day-override country gate (W4.3)

6. Set a day override to something obscure or non-English. **Expect** it to save in about a second and simply show the name. It may now show **no** country where it previously guessed one — that is the fix, not a failure.
7. **Watch for the one predicted side effect (F-26-29, not observed locally):** if a day's country becomes blank *and nothing else supplies one*, that day's map tiles may fall back from Amap/Naver to generic OSM. Report it if you see it, with the day and the text you typed — it is expected-but-unconfirmed, and a real instance is worth recording.

### D — Nothing unverifiable is being created (the invariant)

8. After doing A–C, confirm no new empty-country destination exists:
   `docker exec -w /app/backend trippy-trippy-1 node -e "const D=require('better-sqlite3');const db=new D('/app/data/trippy.db',{readonly:true});console.log(db.prepare(\"SELECT id, city_key, display_name FROM discovery_destinations WHERE country_code = ''\").all())"`
   **Expect exactly three rows — 北京, 南疆, Suzhou** (the pre-existing ones W5.1 deletes). **Any fourth row means W4.5 has a hole; report it.**

---

## Appendix E — W4 production QA results, 2026-07-28

**Verdict: PASSED. No defects. No QA debt.** Owner ran sections A–C in the browser; the agent ran section D and the supporting read-only queries. Steps **A1–A3 PASS** and **B4–B5 PASS** as written.

**D — the invariant HELD, and the stronger result is an absence.** `country_code = ''` still returns **exactly three rows** (北京 id 4, 南疆 id 5, Suzhou id 18); no fourth. Beyond that, **`乌镇` has no `discovery_destinations` row at all** — not empty-country, not country-coded. The owner opened the C6 confirmation and deliberately did not confirm, and the system created nothing and spent no Claude or Google call. That absence is a cleaner proof of W4.5 than the row count is. The converse path is proven too: step A1 created **`chiangmai | TH` (id 19, `last_generated_at 2026-07-28 11:19:57`, `generation_count 1`)** — confirm → create → generate, end to end in production.

**F-26-36 — C6 is F-26-10's full chain firing in production, and the stored row proves each link.** Day `2026-08-22` on trip `f4d53cbf…` ("Shanghai - Hangzhou (W4 Test)") after a 乌镇 override: `city_override = '乌镇'`, **`city_override_country = NULL`** (W4.3 held — no guess written), `city_country = 'CN'` (untouched seed). The day's country then resolves from the **hotel** layer — Park Hyatt Hangzhou, 2026-08-20→23 — giving `countryCode: CN` with `countryEvidenceCity: 'Hangzhou'`. Hangzhou ≠ 乌镇 by `canonicalGeoKey`, so W4.2 declines `CN` for Discovery; the destination is new and now has no country; W4.5 declines with `country_required`. Every link observed on real data.

**F-26-37 — W4 prevented a real wrong-country catalogue on real owner data, and `place_resolution_cache` holds the receipt.** The C6 prompt pre-filled **Japan**, not China. The stored resolver row is unambiguous:

| `query_key` | `provider` | `name` | `address` | `resolved_country` | `confidence` | `created_at` |
| --- | --- | --- | --- | --- | ---: | --- |
| `乌镇\|乌镇` | `nominatim` | **木屋門真線** | 木屋門真線, 上島町, 門真市, 大阪府, 572-0826, **日本** | **JP** | 0.55 | `2026-07-28 11:23:18` |

`乌镇` — a water town in Zhejiang — resolved to **a road in Kadoma, Osaka**. Pre-W4, `resolveCountryForCityText` was ungated and would have taken that same 0.55 hit and written **`city_override_country = 'JP'`**; Discovery would then have created **`乌镇|JP`** and generated a Japanese catalogue for a Chinese town, every row unverifiable, while that day's map tiles and deep links flipped from Amap to the Japan provider. This is the `qwxzptlkvv`→"Equinix Singapore" failure class (F-26-32) reproduced **on a legitimate place name the owner actually wanted**, which makes it a far stronger justification for the wave than the synthetic gibberish case was. Post-W4 the strict gate rejected 0.55 → `NULL`, and the lenient wrapper could only *offer* JP in a dropdown the owner had to confirm — the F-26-35 "pre-fill is often wrong, and that is now harmless" prediction, confirmed in production.

**F-26-38 — one cached resolver row served both wrappers with opposite authority, and the country bias is the whole difference between the two outcomes.** `resolveCityTextCountryHit` calls `resolvePlace({ queryText: cityText, city: cityText })` with **no country bias**, so both wrappers share cache key `乌镇|乌镇`; the 11:23:18 override save (strict → rejected) and the Discovery open moments later (lenient → pre-filled JP) consumed the *same row*, with no second geocoder call. Contrast the **biased** lookups written at 11:20:24/26 during the Hangzhou catalogue run — `乌镇|hangzhou|cn` returned 昌化镇: wrong town, **right country**. Bias kept the query in China; stripping it, as a brand-new destination inherently must, let Nominatim jump continents on a CJK string sharing no characters with its match. **This is the structural reason the creation path was the dangerous one**, and why W4.5 had to sit there rather than anywhere else. Anyone tempted to "improve the pre-fill" should start here: the leverage is bias, not thresholds.

**F-26-29 remains PREDICTED and NEVER OBSERVED — now with a production reason, not just a local one.** C7 produced no instance, and could not have on that trip: every day carries `city_country = 'CN'` from seeding, and 2026-08-22 additionally has an active Hangzhou hotel, so the override was never that day's only country source. The day still resolves `CN` and still serves Amap/GCJ-02 tiles. Triggering F-26-29 requires a day with **no hotel, no same-day transit, and no seeded `city_country`** — i.e. a trip whose only geography is free text, which is also the surface F-26-34 covers. Deliberately not manufactured; the fact stays open.

**F-26-30a confirmed in production, not merely locally.** The 2026-08-22 day header reads 乌镇 with country `CN` and the Map tab serves Amap/GCJ-02, while Discovery declines that same `CN`. This is D-26-2 working as mandated. Do not report it as a regression.

## Appendix F — W5 production results, 2026-07-28

**Verdict: APPLIED AND VERIFIED. No verified rows lost. Idempotent on re-run.**

**W5.1 — the delete.** The live empty-country set was re-derived and matched F-26-30 exactly: 北京 (id 4, 70 places), 南疆 (id 5, 92), Suzhou (id 18, 62), all at zero verified. **It had not grown, so the W4.5 invariant held.** Deleted in one transaction in explicit dependency order: 224 places, 252 verification-attempt rows (all Suzhou's — 北京 and 南疆 predate the W3 attempts table and had none), 1 `discovery_generation_daily` row, 3 destinations. Totals `13 → 10` destinations, `2,451 → 2,227` places. Every surviving destination now carries a country code.

**W5.2 — the repair.** 116 rows returned to the queue (`provenance='pending', status='active'`): Taipei 38 and Shanghai 7 un-archived, kualalumpur 70 and Chongqing 1 re-stamped in place. Independently verified afterwards, not read from the script's own output: `pending` 51 → **167** (+116), `archived + unverified` 236 → **191** (−45), `active + unverified` 917 → **622**, and **`active + verified` unchanged at 880** — the number that proves no paid provider work was destroyed. `PRAGMA integrity_check` = `ok`, `foreign_key_check` empty, zero orphaned places or attempts, migrations still at 32.

**F-26-39 — W1.2 fixed the defect only for rows inserted after it deployed, and the legacy corpus kept bleeding.** W1.2 changed what `insertPlaces` stamps; it did not restamp anything already in the table. Rows written before that deploy still carry a legacy `'unverified'` whether or not a check ever ran, so `enforceCategoryCap` reads them as tier-1 "checked and failed" victims and archives them unchecked — F-26-3 reproducing itself against data that predates its fix. The arithmetic is the proof: the 2026-07-26 census counted 78 archived+unverified rows, yet 148 rows generated on or before 2026-07-22 were in that state by 2026-07-28, so at least 70 were archived *after* W1 shipped. **This is why the population read 236 rather than 78, and it was still growing.** The repair closes it by restamping to `'pending'`, which the cap is structurally forbidden to archive.

**F-26-40 — F-26-3's identifying rule was already invalid when it was written, and `local_name` is why the count moved twice.** `status='archived' AND provenance='unverified'` cannot identify never-checked rows post-W1, because the cap legitimately archives checked-and-failed rows into that same bucket. The working discriminator is an **absence of evidence** in both `discovery_verification_attempts` and `place_resolution_cache`. It must be tested under **two** query keys — `name` and `local_name` — because `verifyOne` falls back to the second. Testing only the name key over-reports never-checked by **37 rows** (measured: an orchestrator census using the name key alone said 153; the shipped two-key classification said 116, and the difference is exactly the `cache_local_name` exclusion count). Of the 236 rows, 88 carried attempt rows and 78 carried fossils written 1–3 minutes after their own generation, ~3 s apart under the 1 req/s gate, returning real Taipei places at 0.55 — unmistakably the verification worker. **The plan's "78" and the true recoverable set are disjoint populations that happen to share a number.**

**F-26-41 — W1.2's pending exemption was observed protecting the repaired rows, live.** A stale-refresh generation during local verification ran the cap against a just-repaired catalogue and logged `category=food destination=9 still 16 over cap=45 after archiving checked rows — 61 pending rows exempted`, having first consumed its checked-unverified tier and then archived *verified* nightlife rows. It archived a verified incumbent rather than touch a pending row. That ordering is the whole mechanism W5.2 depends on, and it is now observed rather than assumed.

**F-26-42 — `pending` still renders as "Unverified", so D-26-1's three-state separation is not complete on the card.** `SuggestionCard.jsx:36` derives `isVerified = provenance === 'verified'` and `:250` renders a binary `Verified`/`Unverified`, so a never-checked row and a checked-and-failed row are indistinguishable to the user. This is **pre-existing and not a W5 regression** — W5 only moved rows between those states — but it means the 45 newly-visible suggestions read as "we checked and failed" when the truth is "not checked yet". D-26-1 explicitly called for these to be separated. Recorded as an open follow-on; not fixed here.

**Browser verification (375px and desktop, dev-DB copy carrying the same repair).** Discovery rendered the over-cap state correctly — Shanghai's tab strip read `FOOD 62`, `NATURE 62`, `NIGHTLIFE 47` against a cap of 45 with no layout break, no horizontal overflow at 375px (`scrollWidth === innerWidth === 375`), and no console errors. Desktop showed the multi-column grid and detail drawer intact. **Cost incurred:** the stale dev catalogue triggered real Claude refresh generations during this pass — dev-only, on a disposable copy, but unintended: setting `DISCOVERY_RESOLVER_DAILY_REQUEST_BUDGET=0` blocks *provider* calls, not *generation*. Anyone repeating this should stale-proof the fixture instead.

**Left for the queue, deliberately.** The 116 repaired rows are `pending` and will be checked the next time anyone browses their destination, at `'background'` priority behind interactive work, ≈460 Nominatim requests against a 1,000/day budget. Categories sit knowingly over cap until then and the cap logs it. Per F-26-22 expect roughly 18% to reach `verified`; the rest return to terminal `unverified` and become archivable again, which is the correct outcome — the point of W5.2 was that they get their check, not that they pass it.

## Appendix B — Owner production QA click-script (W1 + W2 + W3 + the F-26-23 fix)

Standing convention: the agent verifies locally, the owner verifies production. This covers the **first deploy of Plan 26** — three waves plus one follow-on fix shipping together. Sequencing rationale: W4 touches `deriveDayGeo` (the Plan 6/7/8 geography model, test-pinned, load-bearing across day headers, map, share and geocoding bias) and W5 is a data operation, so both belong in later, separately-verifiable deploys.

**What is actually changing for a user.** Most of this bundle is invisible plumbing. Three things are not:
- **Interactive lookups no longer queue behind background checking** (W1.1). Measured locally at ~1.0 s versus ~60.6 s under a loaded queue.
- **A place whose name does not match what the provider returned no longer earns "Verified"** (W2.1). This is the one change that reaches non-Discovery surfaces — it affects the pin and confidence of any stop you add.
- **Discovery declines honestly instead of erroring** when every category is full (W1.5).

### Pre-deploy ops

1. **Back up first — this deploy carries migration 032.** Prod `~/Trippy/data` is root-owned with no passwordless sudo, so take the backup into the chee-owned `~/Trippy/backups/` via `sqlite3 .backup`, not a file copy.
2. After the container comes up, confirm the migration applied and nothing else did:
   `docker exec -w /app/backend trippy-trippy-1 node -e "const D=require('better-sqlite3');const db=new D('/app/data/trippy.db',{readonly:true});console.log(db.prepare('SELECT filename FROM _migrations ORDER BY id DESC LIMIT 3').all())"`
   Expect `032_discovery_verification_attempts.sql` at the top.

### A — Discovery lifecycle (W1)

3. Open a trip → **Plan** → Discovery on a destination that has never been generated (a fresh city). **Expect:** categories fill in **one at a time as each completes**, not all at once after a long blank wait. This is W1.4's progressive reveal.
4. On a heavily-used destination (Taipei is the most saturated in production), press **Show more**.
   **Precondition, and it is strict:** the decline fires only when **NO** category has headroom, not when the category you happen to be viewing is full (W1.5 scope note). If a few categories sit at 45 but others do not, a normal generation runs and takes a minute or two — **that is correct, not a failure of this step.** Only when every one of the eight categories is full should you **expect a calm grey notice**, not a red error, reading: *"Every category here is already full. There's nothing new to surface right now — try again once some of these places have had time to prove themselves."*
   **Regression to watch for:** the notice must appear *below/alongside the existing results*. If the grid of suggestions vanishes and is replaced by a red line, that is the W1.5 bug returning — report it.
5. While a generation is still streaming, switch to a day and **add a stop by name**. **Expect it to resolve in a few seconds**, not to hang until the generation finishes. This is the single most user-visible W1 improvement.

### B — Trust labelling (W2) — the highest-risk part of this deploy

6. Open any suggestion's **Details** panel and confirm it still reads **Verified** or **Unverified** (wording unchanged by design, D-26-1).
7. **Add a stop from a Discovery card** that shows *Verified*. Open it on the **Map** tab. **Expect** the pin to sit on the actual place.
8. **Add a stop manually** (type a place name yourself, not from Discovery). This exercises the same global name check. **Expect** normal behaviour — a recognisable pin and name.
   **What would be a real regression:** a stop you add manually that previously landed correctly now landing with a vaguer pin or losing its name. W2.1 deliberately downgrades a provider result whose returned name does not match what was asked for, so a *wrong* place becoming vague is the fix working; a *correct* place becoming vague is a bug. Report any instance with the exact text you typed.
9. Check a couple of previously-added stops still render as before. W2.1 does not rewrite stored rows, so nothing should have moved.

### C — Observability is actually recording (W3)

10. After doing A and B, confirm attempt rows exist:
    `docker exec -w /app/backend trippy-trippy-1 node -e "const D=require('better-sqlite3');const db=new D('/app/data/trippy.db',{readonly:true});console.log(db.prepare('SELECT reason, COUNT(*) c FROM discovery_verification_attempts GROUP BY reason').all())"`
    **Expect** a non-empty result. Empty after a fresh generation means the telemetry is not wired in production — report it.
11. Confirm the budget line appears in the container logs once per drain: `docker logs --tail 200 trippy-trippy-1 | grep "budget status"`. Expect `resolverRequests=…/1000 escalationRequests=…/50 reverifyRequests=…/150`.

### D — The F-26-23 city fix (needs one deliberate ops step)

The 106 affected rows (kualalumpur, Chong Qing) are terminal `unverified`; the fix makes them *eligible* to verify but does not retroactively re-check them. Re-verification never runs from a request path — it is invoked deliberately:

12. Dry run first, which touches no provider and writes nothing:
    `docker exec -w /app/backend trippy-trippy-1 node scripts/discoveryReverify.js --dry-run`
13. Then a bounded live run against Kuala Lumpur only (`--destination=<id>` from the dry-run output, `--limit=10`). **Expect** some rows to flip to `verified` where previously none could. Per F-26-22 the overall rescue rate is ~18–20%, so a handful out of ten is the *expected* result, not a disappointment.

### Known-and-accepted, do not report as bugs

- Rows still showing **Unverified** after re-verification. Expected: ~80% stay unverified (F-26-22), and the underlying cause is Q-26-3's display-name-as-search-query problem, which is not fixed in this deploy.
- 北京 and 南疆 still present with zero verified rows — they are deleted in W5.1 (D-26-3).
- Duplicate-looking entries such as the three Kaohsiung Lotus Pond rows — D-26-5 keeps these deliberately; the arrangement fix is not in this deploy.
