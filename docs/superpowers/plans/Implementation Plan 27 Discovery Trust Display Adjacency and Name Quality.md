# Implementation Plan 27 — Discovery Trust Display, Near-Match Adjacency, Name Quality and Coincident Map Pins

**Status:** 2026-07-29 — **W1 COMPLETE (not deployed). W2, W3, W4 NOT STARTED.** Four waves, **no migration in the entire plan** (see F-27-1). All four owner decisions are taken (D-27-1…D-27-4); no wave is blocked on a product question. Investigation was read-only: no product code was written in the session that produced this document.

**Origin:** the three items [Plan 26](Implementation%20Plan%2026%20Discovery%20Catalogue%20Trust%20and%20Lifecycle.md) carried forward when it closed on 2026-07-28 (F-26-42, D-26-5, Q-26-3), plus the coincident-marker item folded forward from [Plan 24](Implementation%20Plan%2024%20Google%20Maps%20Deep%20Link%20Place%20Identity.md). Evidence base: the [2026-07-26 discovery catalogue quality assessment](../reviews/2026-07-26-discovery-catalogue-quality-assessment.md), Plan 26's W3.4 measurements and Appendix F, and a fresh read-only production census taken 2026-07-28 for this plan.

**Scope in one sentence:** stop the Discovery card claiming a verdict it does not have, arrange near-duplicate suggestions so they read as one place instead of three, stop the generation prompt writing captions where names belong, and make two stops at one coordinate both tappable.

**What this plan deliberately does NOT do.** It does not add a `search_name` column, does not rewrite any stored `discovery_places.name`, does not touch `deriveDayGeo` precedence, does not change the category cap, does not reopen Plan 24's resolver ordering, and does not change ranking scores. Every one of those was considered and declined on measured evidence recorded below.

---

## Validated facts — established 2026-07-28, do not re-derive

Code facts were read at `1138f51`. Production figures come from a read-only census taken for this plan on 2026-07-28 via `ssh chee@100.94.82.35` → `docker exec -i -w /app/backend trippy-trippy-1 node` (heredoc on stdin, `{readonly:true}` on `/app/data/trippy.db`). `printenv` was never run.

**F-27-1 — No migration is needed anywhere in this plan, and this changes Plan 26's forecast.** Plan 26 carried Q-26-3 forward on the assumption it would need migration 033. D-27-2 declines the column, so the highest applied migration stays **032** (`_migrations` id 32, `run_at` `2026-07-27 04:07:54`, unchanged since W3). Every wave here is presentation, ordering, or prompt text. **Consequence for release planning:** Plan 26's rule that "Q-26-3 carries a migration and should not share a release with anything else" no longer applies.

**F-27-2 — Production trust split, 2026-07-28, and it has NOT moved since Plan 26 W5.** 2,227 `discovery_places` across 10 destinations, all country-coded. Active: **167 pending / 622 unverified / 880 verified**. Archived: 191 unverified / 365 verified. Suppressed: 2 verified. This is byte-identical to the post-W5 read, which means **none of W5.2's 116 requeued rows has been checked yet** — nobody has browsed those destinations since the repair. The 167 pending is therefore a live, currently-visible population, not a transient that has already drained. Destinations: kualalumpur (MY), ChengDu (CN), Chong Qing (CN), Denpasar (ID), Bali (ID), Taipei (TW), Kaohsiung (TW), Shanghai (CN), Hangzhou (CN), Chiangmai (TH).

**F-27-3 — F-26-11's fourth display-only state is RETIRED, and this makes F-26-42 far smaller than Plan 26 scoped it.** Plan 26 recorded that a true catalogue miss streams raw Claude items with no DB row, no id and no `provenance`, so trust "cannot be implemented as a filter on stored reads alone". **W1.4 closed that.** `runCatalogueGeneration` now inserts, caps and enqueues per category *before* invoking `onCategory`, so every streamed item is a persisted row (`routes/discovery.js:325-378`, with the W1.4 comment stating exactly this at `:330-336`). Every `type:'category'` chunk on every path — true miss, append, stale refresh — is built by `groupPlaceRowsByCategory` → `serializePlaceRow`, which always sets `provenance: row.provenance` (`routes/discovery.js:49`). Verified by reading all five `write({type:'category'…})` sites (`:235`, `:319`, `:347`, `:373`, `:409`). **There are exactly three states, all stored, all present on the wire.**

**F-27-4 — The browse-card half of D-26-1 never shipped either, and Plan 26's carried-forward note is wrong about why.** That note credits W1.4 with shipping "the browse-card half". It did not. The trust label has only ever existed inside the opened Details panel (`SuggestionCard.jsx:250`, inside the `detailsOpen &&` gate at `:228`); the always-visible `discovery-card-summary` block (`:132-226`) renders no provenance-derived text at all. The component's own test suite pins this: `SuggestionCard.test.jsx:203` asserts the label is **absent** before Details is opened, and `:212` asserts it appears only `within(details)`. W1.4 was Q-26-2 (progressive reveal); it never touched the card's trust surface.

**F-27-5 — `fitLine` already encodes trust as absence of praise, and only in Details.** `buildFitLine` (`discoveryRank.js:139-167`) appends the literal `verified place` only when `row.provenance === 'verified'` (`:162-164`) and appends nothing for `unverified` or `pending`. It renders at `SuggestionCard.jsx:248` — also inside Details. This is F-26-15's finding, still live.

**F-27-6 — Every frontend read of `provenance`.** Three sites, all in Discovery: `SuggestionCard.jsx:33,36` (the trust label), `DiscoveryPanel.jsx:488` (`isVerifiedWithCoordinates` — gates the trusted-coordinate fast path when adding a suggestion to a day), and `DiscoveryPanel.jsx:523,541` (forwards `provenance` onto the new stop payload on both add branches). No hook, util or other component reads it. The `provenance` matches in `bookingForm.test.js` are an unrelated booking-draft field.

**F-27-7 — Unverified and pending rows carry no coordinates, so the two states have the same practical consequence today.** `serializePlaceRow` nulls `lat`/`lng` unless `provenance === 'verified'` (`routes/discovery.js:45-46`). Adding either kind of card to a day therefore takes the untrusted path and re-geocodes from the title. **This is the product reason D-27-1 is defensible:** the user-visible difference between "checked and failed" and "not checked yet" is currently zero, so spending a word on it buys the traveller nothing.

**F-27-8 — Ranking is applied exactly once, server-side, and the sort is stable.** `rankPlaces` (`discoveryRank.js:119-124`) sorts by `score` descending using `Array.prototype.sort`, which is stable in Node, so score ties preserve input order — and the input order is deliberately generation order (`ORDER BY id`, called out as load-bearing at `routes/discovery.js:358-361`). Ranking runs inside `groupPlaceRowsByCategory` (`routes/discovery.js:76`), between the per-category split and serialization. Stability is directly test-pinned (`discoveryRank.test.js:201-208`, "is stable on ties"). **No client-side re-sort exists** — `useDiscovery.js`'s `showMore` merge appends without reordering, and `DiscoveryPanel.jsx` only flattens categories for display.

**F-27-9 — Near-match scale, measured on the live corpus, and the rule shape matters enormously.** Against all 1,669 active places grouped by `(destination_id, category)`:

| Candidate rule | Pairs | Rows involved | Verdict |
| --- | ---: | ---: | --- |
| Token **overlap** (≥2 shared content tokens) | 3,591 | 1,282 of 1,669 (77%) | **Unusable.** Groups `Kuala Lumpur War Cemetery` with `Kuala Lumpur Railway Station`, and `National Planetarium` with `National Mosque`. |
| Token-set **containment** (shorter name's tokens ⊆ longer's) | **270** | **443 of 1,669 (27%)** | **Usable.** Examples are overwhelmingly the same real place. |

Containment examples, all real production rows: `Lotus Pond` ⊂ `Dragon and Tiger Pagodas (Lotus Pond)` (D-26-5's own case), `Jamek Mosque` ⊂ `Jamek Mosque (Masjid Jamek)`, `Selangor Club` ⊂ `Selangor Club Bar & Billiards Room`, `House of Matahari` ⊂ `House of Matahari Batik Workshops`, `Petronas Philharmonic Hall` ⊂ `Petronas Philharmonic Hall Learning Centre`. **W2 must use containment, not overlap** — this is the single most load-bearing fact in that wave.

**F-27-10 — Exact normalized duplicates are rare and separately identifiable.** Five groups / ten active rows across the whole corpus share an identical `normalizeName(name)` within one destination — e.g. `Broken Bridge (断桥)` twice in Hangzhou essentials, `Grandma's Home (外婆家)` twice in Hangzhou food. D-26-5 permits removing exact-name duplicates; the population is ten rows, not a programme of work.

**F-27-11 — `dedupeByProviderId` cannot see any of this.** It runs only from `applyVerified` (`discoveryVerify.js`), i.e. only on rows that already became verified, and unverified rows have no `provider_place_id` by definition. Plan 26's F-26-13 stands: **a provider-id-based duplication measure reports a misleading zero.** F-27-9's counts come from names, which is the only signal present on all three provenance states.

**F-27-12 — What raw material exists for W2, and what does not.** Present on every row regardless of provenance: `name`, `local_name`, `aliases_json`, `category`, `destination_id`, `batch`, `score`. Present only on verified rows: `provider_place_id`, `lat`, `lng` (the latter two nulled on the wire by F-27-7). No similarity, fuzzy-match or dedupe helper exists anywhere in `frontend/src/utils/` or in `discoveryRank.js` — the only sameness comparison in the codebase is exact-equality-after-normalization (`SuggestionCard.jsx:108`, `useDiscovery.js:111-117`). Nothing strips or indexes parenthetical content for comparison purposes.

**F-27-13 — There are THREE copies of `normalizeName` on the frontend, not the two Plan 26 W1.3 left behind.** W1.3 merged `DiscoveryPanel.jsx`'s and `useDiscovery.js`'s copies into the shared `frontend/src/utils/placeNames.js`. It missed a fourth site: `SuggestionCard.jsx:12-19` still carries its own inline, non-imported copy, byte-identical to the shared one. Current shared regex (post-W1.3): `.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ')` then a generic-suffix strip then whitespace collapse (`placeNames.js:15-22`). The backend mirror is `claude.js:196-203`. **W2 should collapse the `SuggestionCard` copy onto the shared helper rather than add a fifth.**

**F-27-14 — Bracket-stripping is already implemented, already tried, and already failing.** `nominatimQueryTexts` (`placeResolver.js:515-542`) derives, for any query string: the original, every bracketed inner phrase (four regexes covering `()`, `（）`, `[]`, `【】`, `:518-529`), and one variant with all brackets stripped (`:531-539`). `resolverQueryTexts` (`:544-549`) flat-maps that over the name *and* every alias. `searchNominatim` (`:579-643`) tries each candidate in order, one HTTP request each, first hit wins. Measured against the live `discovery_verification_attempts` table: of weak-match attempts on bracketed names, **683 used a derived variant (≠ the stored name) and still scored weak**, versus 347 that used the raw name. **The lever Q-26-3 proposed to pull is already pulled.**

**F-27-15 — Q-26-3's supporting statistics do not survive a base-rate check, and one of them is an artifact.** Plan 26 W3.4 cited "of 544 repairable names, 307 contain brackets and 182 run to six or more words" as evidence for splitting. Measured against *both* populations on 2026-07-28:

| Name shape | verified (880) | active-unverified (622) | Reading |
| --- | ---: | ---: | --- |
| contains a bracket | 45.6% (401) | 60.3% (375) | Real signal — brackets are enriched among failures |
| ≥6 words | 46.8% (412) | 42.1% (262) | **Anti-correlated.** Long names are *slightly more common among verified rows.* The "182 six-plus-word" figure was a base-rate artifact. |
| avg `match_score` | — | 0.556 bracketed vs 0.576 plain | Brackets barely move the score |

**F-27-16 — The lookup wins that did come from a different string came from ALIASES, not from stripping.** Every verified attempt whose winning `query_variant` differed from the stored `name` was an alias or local-name form, sampled live: `Islamic Arts Museum Malaysia` won on `IAMM`; `Sultan Abdul Samad Building` on `Bangunan Sultan Abdul Samad`; `Merdeka 118` on `Merdeka Tower`; `National Textiles Museum` on `Museum Teks Negara`; `Thean Hou Temple` on `Thean Hou Chinese Temple`. Counted by source field, verified attempts split 31 on `name` and 8 on `local_name`. **Aliases are the working search-name channel, and it already exists.** Reinforcing evidence: **202 of 622 active-unverified rows carry no alias at all** (152 with a local name, 50 with neither).

**F-27-17 — Genuine editorial prose is a real but small minority.** 52 of 622 active-unverified rows (8.4%) carry a colon or a spaced dash clause. The canonical example is live: `Michelin Bib Gourmand: Ay-Chung Flour-Shaping (listed above, but worth the emphasis)`. Others: `Chengdu TCM (Traditional Chinese Medicine) Teaching Hospital – Wellness Consultation`, `Sichuan University Campus – Architectural Vernacular & Student Life`. **No existing transform removes an editorial prefix** — `nominatimQueryTexts` only touches brackets, so the Michelin row's best derived variant is still `Michelin Bib Gourmand: Ay-Chung Flour-Shaping`.

**F-27-18 — A deterministic cleanup of existing names is not safe, measured not assumed.** A naive "strip colon prefix, strip dash clause, strip trailing bracket" transform run read-only against production over the 172 active rows matching those patterns produced: **36 collisions (21%)** against an existing `normalized_name` in the same destination, and repeated **structural mangling** — `Chen Mapo Tofu (Original Location - Xuanhuang Street)` → `Chen Mapo Tofu (Original Location` (unbalanced parenthesis, because the dash rule fired inside a bracket); six of the first eighteen broke this way. Worse, the candidate set is not separable: `Long Chaoshou (Wonton House) - Chunxi Road Location` and `Soto Ayam Kedewatan - Eka Sari` carry **legitimate disambiguators a traveller needs**, and stripping them makes the name both worse and less findable. **The 172 are a mix of prose and correct qualification, and no deterministic rule tells them apart.**

**F-27-19 — Cleaning existing names would not validate the prompt fix anyway.** The two are different mechanisms: W4 changes what Claude *generates next*; a cleanup rewrites prose that already exists. A deterministic cleanup tests a string transform; a Claude-driven cleanup tests a *rewrite* prompt, not the generation prompt that ships. **The validation the owner wants is available more cheaply and more directly — see W4's A/B gate.**

**F-27-20 — Prose names will never self-heal.** A stale refresh *merges*: `insertPlaces` skips any candidate whose `normalizeName` already exists for that destination (`discoveryCatalogue.js:103`, `:131`), so an existing row's `name` is never rewritten by a later generation. The 172 persist indefinitely unless deliberately touched.

**F-27-21 — Drift risk from a future name cleanup is negligible.** Exactly **one** production stop carries a title matching one of the 172 candidate names (`Amusement Parks - Tuntex Sky Dream`). Adding a suggestion to a day copies the name into `stops.title`, so a catalogue rename would desync the copy — at n=1 that is a footnote, not a blocker, and it is recorded here so a later cleanup does not have to re-measure it.

**F-27-22 — `name` serves FOUR roles, and two of them are geocoder queries.** Display: `serializePlaceRow` (`routes/discovery.js:36`) and `toCompactPlace` (`copilotGrounding.js:91`, what the co-pilot model sees). Dedupe: `normalized_name` via `normalizeName(item.name)` (`discoveryCatalogue.js:131`), enforced by the unique index from migration 016. Prompt text: `listExclusionNames` (`discoveryCatalogue.js:178-186`) feeds raw names into the next generation's "don't re-suggest these" line (`claude.js:258-259`). Geocoder query: `discoveryVerify.js:476` (background verification) **and — not previously flagged anywhere — `copilotProposals.js:416`** (`locationQuery: place.name`), which feeds a co-pilot grounded add-stop into `resolveLocationForStop` → an **interactive** `resolvePlace` call. Any future name work must account for all four.

**F-27-23 — Google gets no bracket-stripping at all.** `searchGooglePlaces` (`placeResolver.js:653`) is called with the raw `queryText` (`:886`, `:935`); only the Nominatim path runs through `nominatimQueryTexts`. A prose-heavy name reaching Google via escalation or the no-Nominatim-result fallback is sent verbatim. Recorded as context for W4, not as a wave item.

**F-27-24 — What the generation prompt actually says about `name`, and what it fails to say.** `DISCOVER_SYSTEM` (`claude.js:205-227`) instructs only that for non-English places the *"traveler-friendly English or romanized name"* goes in `name`, the local-script name in `localName`, and *"useful alternate spellings/official names"* in `aliases` (`claude.js:217`). **Nothing constrains `name` to be a name.** The curation rules (`:221-226`) are editorial — "earn its place", "specific whyItFits" — so the model is optimising `name` as a caption, which is exactly what it produces. By contrast `photoQuery` **is** length-capped in both the prompt (*"at most 8 words"*, `:218`) and in code (`.slice(0,8)`, `claude.js:143`) — the precedent for constraining a field already exists in this same prompt.

**F-27-25 — No field is already a clean search name.** `localName` is the local-*script* form (often the wrong script for the providers' English index) and is absent on many rows; `aliases` is an unbounded list, not a designated short form; `photoQuery` may reference cuisine or activity rather than the place. Checked directly — there is no cheaper existing slot than `name` itself.

**F-27-26 — Coincident markers: n=1 same-day, confirmed by direct measurement, and six near-misses that never co-render.** Production holds **seven** coordinate-identical stop pairs, but `TripMap` renders one day at a time, so only same-day pairs can ever stack. Grouped by `(day_id, lat, lng)` there is **exactly one**: `Qinghefang Night Market & Street Food` and `Qinghefang Antique Street`, both `type='experience'`, both on day `c046c2a28efe92a549818aa69c53b797` (2026-07-29), at `30.241967610961915, 120.17081569055176`. A ≤25 m proximity sweep across every day returns the same single pair and nothing else — so there is no near-coincident population hiding just under the exact-match threshold. The other six pairs are cross-day: `Lingyin Temple`×2, `West Lake`×2, `Park Hyatt Hangzhou`×2, `Jing'an Temple`×2, `The Bund` / `The Bund (evening walk)`, and — notably — `Dragon and Tiger Pagodas (Lotus Pond)` / `Lotus Pond`, which is **D-26-5's own example manifesting as a map collision on a different day**. 103 production stops carry coordinates.

**F-27-27 — The map's marker layer, and why the nudge is cheap.** `TripMap.jsx:135` computes `pinnedStops = stops.filter(hasDisplayCoordinates)` and `:201-209` maps it straight to `<StopMarker key={stop.id}>`, one `<Marker>` per stop, with **no coincidence awareness anywhere**. `StopMarker.jsx:54` renders `<Marker position={[lat, lng]}>` reading `stop.displayLat ?? stop.lat` (`:48-49`). Two identical positions stack in DOM order and only the top one is hit-testable. Also on the layer: paired under/over `Polyline`s per connector (`TripMap.jsx:164-197`) and one `ArrowMarker` per connector (`:198-200`). No booking markers, no user-location marker. `react-leaflet` is used directly, not wrapped. Versions: `leaflet ^1.9.4`, `react-leaflet ^4.2.1` (`frontend/package.json:13,18`).

**F-27-28 — No clustering or spiderfy library is a dependency.** `frontend/package.json` contains no `leaflet.markercluster`, no `leaflet-oms`, no equivalent. Adding one would be a new dependency plus, in practice, a React binding package on top — for a population of one pair.

**F-27-29 — There is no Leaflet CSS in `index.css` and no map-related reduced-motion rule.** Zero `.leaflet-*` selectors exist in `frontend/src/index.css`. Three `prefers-reduced-motion` blocks exist (`:174`, `:949`, `:1031`), none targeting the map. **Consequence for W3:** a *static* offset needs no reduced-motion handling at all; an animated spiderfy would have to introduce the first map motion guard in the codebase. This is a direct argument for the static treatment.

**F-27-30 — Two stops sharing a `provider_place_id` is the resolver working, not a defect.** Both Qinghefang stops ran independently through `resolveLocationForStop` → `resolvePlace` with their own titles, and the providers returned the same real place (`google:ChIJIyHi70OdTDQRmQAg6H8E-WU`) because they genuinely describe one location. `stops.js` performs no cross-stop coincidence check on create or update. The duplication originates at the geocoding-identity layer. **Plan 24 stays closed — W3 does not touch the resolver.**

**F-27-31 — Test baselines at `1138f51`.** Backend **798/798** (34 files), frontend **293/293** (43 files), `npm run build` clean. The backend suite sometimes ends in a Windows teardown segfault (exit 139) *after* results print; that is not a failure.

---

## Owner decisions taken — 2026-07-28

**D-27-1 — Show "Verified" when it can be proven; show nothing otherwise.** Not three labels, not two. The Details panel renders a trust line **only** for `provenance === 'verified'`; both `unverified` and `pending` render no line at all. Owner rationale, recorded verbatim in intent: verified suggestions are largely popular or major landmarks, so the positive claim is self-evidently meaningful; and it is common, sound practice to state what you can prove and to withhold a display that reads as negative or invites questions the product cannot usefully answer ("what is the difference?", "should I be worried this is not a real place?"). **This supersedes D-26-1's framing.** D-26-1 asked for the three internally-distinct states to be *separated and surfaced*; the owner's call is that separating them in the **UI** is the wrong move, because per F-27-7 the two non-verified states have identical user-facing consequences. The states remain fully distinct in the data and in operator tooling — where the distinction is real — and the word "Unverified" leaves the interface entirely. This also fixes F-26-42's actual harm at the root: 167 rows currently say "Unverified" when nothing has checked them, and after this they say nothing.

**D-27-2 — No `search_name` column, no migration, no rewrite of existing names. Fix the generation prompt instead, and validate it against real existing data before it ships.** Q-26-3 is answered **no** as scoped and **yes** as reframed. The measured basis: bracket-stripping is already implemented and already failing at scale (F-27-14), the six-plus-word statistic was a base-rate artifact (F-27-15), the real lookup wins come through aliases (F-27-16), genuine prose is 8.4% of the failing corpus (F-27-17), and a deterministic cleanup of existing names collides 21% of the time and mangles legitimate qualifiers (F-27-18). Q-26-3 was really two problems in one coat — bad card copy, which the user sees, and an unlookable query string, which the user feels as a bad pin — and the prompt fix addresses the first directly and the second as a side effect. **Validation is an A/B diff, not a data operation** (F-27-19): regenerate a destination production already holds, on the dev DB, and compare the names produced against the names stored.

**D-27-3 — The trust line stays inside Details; nothing is added to the browse card.** Mobile-first reasoning, owner's call: the browse card is already dense at 375px and its job is invitation. Anyone deciding to actually add a place opens Details. D-26-1's browse-card half (which F-27-4 shows never shipped) is **closed, not deferred** — it is superseded by D-27-1, since with only a positive label left there is no lie to surface while browsing.

**D-27-4 — Ship the coincident-marker fix as a deterministic static nudge.** Approved despite n=1 (F-27-26). Chosen against clustering (a new dependency plus a React binding, with a blast radius across every nearby-but-distinct pin — F-27-28) and against a merged marker (which breaks `buildStopIcon`'s single `routeNumber` glyph and the one-marker-one-stop assumption in the move-pin correction flow). Static, not animated, so F-27-29's missing map reduced-motion layer is never needed.

**D-26-5 carries forward unchanged and is NOT reopened.** Genuinely different things at one place stay adjacent within their category; ranking is unchanged; group position is set by the group's strongest member. A sorting rule only — no grouping model, no visual redesign, nothing auto-deleted for looking similar, no moderation queue. This plan adds only the *mechanism* (F-27-9) the decision always lacked.

**Inherited and not to be reopened:** D-26-2 (`deriveDayGeo` precedence, and the Discovery-only reach of the W4.2 decline rule), D-26-6 (no wholesale rebuild), Q-26-1 (the cap stays at 45), Plan 24's "precision over polish" and its Nominatim-first ordering, and the closed Unsplash production-tier item.

## Questions deliberately left open

- **Q-27-1 — Do the 172 prose-carrying names ever get cleaned?** Deliberately not scoped here (F-27-18, F-27-19, F-27-20). It needs a Claude-driven rewrite rather than a string transform, a human review pass over 172 diffs, a collision rule for the 36, `normalized_name` rewritten in lockstep, and a backup with sign-off — a Plan 26 W5 risk profile in its own release. **Revisit after W4's A/B diff**, when there is a concrete picture of what a good name looks like and therefore which of the 172 are genuinely bad. Drift cost is already measured at one stop (F-27-21).
- **Q-27-2 — Does the exclusion list need to become identity-aware?** `listExclusionNames` tells Claude not to re-suggest by display name (F-27-22). It cannot stop the model proposing the same real place under a different phrasing — which is precisely the population W2 arranges. W2 makes the symptom legible; whether the generator should stop producing it is a separate question. Do not fold it into W2.
- **Q-27-3 — Should `copilotProposals.js:416` stop sending a display name to the interactive geocoder?** Found during this investigation and not previously recorded anywhere (F-27-22). It is the same display-name-as-query defect as `discoveryVerify.js:476`, but on an **interactive** path where the user is watching. Out of scope here because W4 improves the input rather than the call site, and changing a co-pilot resolution path deserves its own verification pass.
- **Q-27-4 — Are the ten exact normalized duplicates (F-27-10) removed?** D-26-5 permits it. Ten rows is not a wave. Fold into Q-27-1's operator pass if that ever runs.

---

## W1 — Trust display honesty

**Status:** 2026-07-29 — **COMPLETE, not deployed.** Presentation-only, frontend-only, no migration, no new external call, no server change. Shipped exactly as scoped: one JSX line in `SuggestionCard.jsx:250` (`{isVerified && <span>Verified</span>}`) plus two new test cases. W1.2 and W1.3 confirmed as non-items and left untouched; `DiscoveryPanel.jsx:488/:523/:541` untouched. Frontend **295/295** (43 files, baseline 293 + 2 new), `npm run build` clean. Backend not run — no backend file changed. Browser-verified locally at 375px and 1280px against the real Kaohsiung catalogue (dev destination id 15, `last_generated_at` 2026-07-26 → fresh, so **no paid generation was triggered**): `Fo Guang Shan Buddha Museum` (verified) renders 3 metadata children with `Verified` first; `Pier-2 Art Center` (unverified) renders **2** children with duration at the row's left edge — no gap, no placeholder, no stray separator, identical left alignment at both widths. `/unverified/i` matches nowhere in the rendered page. `fitLine` still reads `verified place` on the verified card only (F-27-5 intact). No console errors. Not screenshot-verified — the in-app Browser pane cannot composite frames for screenshots; evidence is DOM geometry (child counts and per-child bounding rects) instead.

**The user-visible symptom this fixes.** A traveller opens a Discovery suggestion's Details panel and reads **"Unverified"** next to the duration. It reads as *we checked this and it looks dubious*. For **167 production suggestions right now** (F-27-2) the truth is *we have not looked at it yet* — many of them ordinary, good Taipei and Kuala Lumpur places sitting in a background queue that has not run since W5.2 requeued them. The app is quietly disparaging its own suggestions.

**W1.1 — Render the trust line only when it can be proven.** `SuggestionCard.jsx:250` currently renders `{isVerified ? 'Verified' : 'Unverified'}`. It must render the `Verified` span when `provenance === 'verified'` and render **nothing** — no span, no placeholder, no empty flex child — otherwise (D-27-1). The surrounding `.discovery-card-metadata` row must still lay out correctly with its first child absent; duration and opening hours keep their positions and separators.

**W1.2 — Leave `buildFitLine` alone.** It already appends `verified place` only on the positive case and nothing otherwise (F-27-5), which is exactly D-27-1's rule. No change. This is recorded as an explicit non-item so a later reader does not "fix" it into symmetry with W1.1.

**W1.3 — Do not touch the browse card** (D-27-3). Recorded as an explicit non-item for the same reason.

**Scope boundary, load-bearing:** `DiscoveryPanel.jsx:488`'s `isVerifiedWithCoordinates` gate and the `provenance` pass-through at `:523`/`:541` (F-27-6) are **behavioural**, not display. W1 must not touch them — a suggestion's add path is unchanged by this wave.

**Acceptance.** `SuggestionCard.test.jsx:212` currently asserts the `Verified` string appears within Details; that assertion stays. New coverage is required for the two cases the file has **none** for today (F-27-4 notes the fixture `DETAILED_SUGGESTION` is hardcoded `provenance: 'verified'`): a `pending` row and an `unverified` row must each assert the trust line is absent, and must assert duration/hours still render. `:203`'s pre-open absence assertion is unaffected. Verify at 375px and desktop that the metadata row does not collapse or reflow oddly with its first child missing.

## W2 — Near-match adjacency

**Status:** 2026-07-28 — **NOT STARTED.** Backend-only, no migration, no new external call, no score change. Ships with W1 and W3 (see Releases).

**The user-visible symptom this fixes.** Browsing Kaohsiung's attractions, a traveller scrolls past `Lotus Pond`, then four unrelated places, then `Dragon and Tiger Pagodas (Lotus Pond)`, then more, then `Zuoying Scenic Area (Lotus Pond Watershed) – Ecology Overview`. Three cards, one lake, scattered — so it reads as a catalogue that does not know what it is recommending. Kuala Lumpur has the same shape: `Jamek Mosque` and `Jamek Mosque (Masjid Jamek)`; `House of Matahari`, `House of Matahari Crafts` and `House of Matahari Batik Workshops`.

**W2.1 — Group by token-set containment within `(destination, category)`, and by nothing looser.** F-27-9 is the whole basis of this item: a token *overlap* rule pulls in 77% of the corpus and cheerfully groups a war cemetery with a railway station, while a *containment* rule (the shorter name's content tokens are a subset of the longer's) yields 270 pairs over 443 rows and is right almost every time. **Implement containment. Do not implement overlap, edit distance, or a similarity threshold.** Normalize with the shared helper, not a new one (F-27-13).

**W2.2 — Reorder, never rescore.** The group's position in the category is the position its **strongest-scoring member** already earned; members follow it in their existing relative order. `rankPlaces` (`discoveryRank.js:119`) must be left byte-identical — the adjacency pass runs **after** it, at `routes/discovery.js:76`, between `rankPlaces(...)` and `.map(serializePlaceRow)`. At that point rows still carry `category`, `name`, `local_name`, `aliases_json` (still a raw JSON string — not yet parsed, that happens at `:42`), `provider_place_id` and their rank position as array order. Because the pass sits outside `rankPlaces`, `discoveryRank.test.js:192-219`'s score-order and tie-stability pins are untouched by construction.

**W2.3 — Collapse the fourth `normalizeName` copy** (F-27-13). `SuggestionCard.jsx:12-19` imports from `frontend/src/utils/placeNames.js` instead of redefining. Small, but this wave is the one that makes name normalization load-bearing in a second place, and leaving a divergent copy behind is how the CJK folding bug (F-26-9) survived three mirrors.

**Explicit non-goals, from D-26-5:** nothing is deleted, suppressed, merged, hidden, badged, or visually grouped. A user should notice only that related cards now sit together. The ten exact duplicates (F-27-10) are **not** removed here — that is Q-27-4.

**Acceptance.** New tests for the containment rule must pin **both directions**: `Lotus Pond` ⊂ `Dragon and Tiger Pagodas (Lotus Pond)` groups, and `Kuala Lumpur War Cemetery` vs `Kuala Lumpur Railway Station` does **not** — the negative case is the one that matters, because it is the failure mode F-27-9 measured. Pin that a group's position equals its strongest member's position, and that within-group relative order is preserved. Assert no score changes. Verify in a browser against a real catalogue at 375px and desktop that category tab counts are unchanged and no card is lost.

## W3 — Coincident map pins

**Status:** 2026-07-28 — **NOT STARTED.** Frontend-only, one file, no new dependency, no migration, no animation. Ships with W1 and W2.

**The user-visible symptom this fixes.** On day 2026-07-29 of the Hangzhou trip, `Qinghefang Antique Street` and `Qinghefang Night Market & Street Food` sit at the identical coordinate. The map draws two numbered gold pins exactly on top of each other; only the upper one can be tapped, so one stop's popup, its "Open in maps" link and its "Move pin" action are unreachable from the map (F-27-26, F-27-27).

**Honest sizing, stated up front.** This is **n=1 same-day** in the entire production corpus of 103 coordinate-bearing stops, and a ≤25 m sweep finds no near-miss population beneath it. Both stops remain fully reachable from Plan and Logistics. This ships because it is genuinely cheap (D-27-4), not because it is urgent — and it should not be allowed to grow in scope on the way in.

**W3.1 — One grouping pass, one static offset.** Group `pinnedStops` (`TripMap.jsx:135`) by rounded coordinate before the `.map()` at `:201`. For any group of more than one, fan its members apart by a small fixed offset — computed in **pixels at the current zoom**, not in fixed degrees, so the separation does not change size as the user zooms. Pass offset positions to `StopMarker` via cloned stop objects; `StopMarker.jsx` reads `stop.displayLat ?? stop.lat` (`:48-49`) and needs **no change at all**. A single stop is untouched, so the common path is byte-identical.

**W3.2 — Static only.** No spiderfy, no expand-on-click, no transition. F-27-29: there is no `.leaflet-*` CSS and no map reduced-motion guard in `index.css`, so a static offset needs no motion work and an animated one would have to introduce the first such guard in the codebase for a one-pair problem.

**Explicit non-goals.** No clustering dependency (F-27-28). No merged marker — `buildStopIcon` bakes a single `routeNumber` into the SVG glyph (`StopMarker.jsx:12-30`) and the correction flow assumes one marker per stop (`MapTab.jsx:79-90`, `:225`). **No resolver change** — two stops sharing a `provider_place_id` is correct behaviour and Plan 24 is closed (F-27-30).

**Acceptance.** A test asserting that two stops at one coordinate produce two distinct rendered positions, and that a lone stop's position is unchanged. Browser verification at 375px is mandatory and specific: on the Hangzhou 2026-07-29 day, **both** Qinghefang pins must be individually tappable and each popup must show its own title, and the route polyline must not visibly detach from either pin. Note the standing hazard from prior sessions — the in-app Browser pane freezes Leaflet on poll loops and screenshots; use the Chrome extension against a logged-in localhost tab.

## W4 — Generation name quality

**Status:** 2026-07-28 — **NOT STARTED. Gated on the A/B diff below; ships in its own release, after W1–W3.** Prompt text and validation only. No migration, no schema change, no rewrite of any stored row.

**The user-visible symptom this fixes.** Discovery currently offers a place called `Michelin Bib Gourmand: Ay-Chung Flour-Shaping (listed above, but worth the emphasis)`, and another called `Sichuan University Campus – Architectural Vernacular & Student Life`. That is an AI writing a caption where a name belongs — the "no AI slop, microcopy in the product's voice" line in CLAUDE.md, visible on the card. The same string is then typed into the map lookup, where no provider has an entry for "listed above, but worth the emphasis", so the place never earns coordinates and its pin is a guess (F-27-17, F-27-22).

**W4.1 — Constrain `name` in `DISCOVER_SYSTEM`.** `claude.js:205-227` currently tells the model only that `name` should be traveller-friendly and romanized where relevant; nothing tells it that `name` must be a *name* (F-27-24). Add that constraint. **The precedent to follow is in the same prompt:** `photoQuery` is capped at eight words in the instruction *and* enforced with `.slice(0,8)` in code (`claude.js:143`, `:218`) — prefer a constraint that is stated and then structurally enforced over one that is merely requested. Editorial framing belongs in `description` and `whyItFits`, which already exist for it.

**W4.2 — Strengthen the `aliases` instruction.** This is the item with the best measured evidence in the wave and it is easy to overlook next to W4.1. Every lookup win that came from a string other than `name` came through an alias — `IAMM`, `Merdeka Tower`, `Bangunan Sultan Abdul Samad`, `Museum Teks Negara` (F-27-16) — while **202 of 622 active-unverified rows carry no alias at all**. The current instruction is a single clause asking for *"useful alternate spellings/official names"* (`claude.js:217`). Aliases already flow into `resolverQueryTexts` (`placeResolver.js:544-549`) and already get bracket treatment, so more and better aliases improve verification **through machinery that already exists** — no code path changes.

**W4.3 — The A/B diff gate. This is a wave item, not a verification step, and W4 does not ship without it.** Pick a destination production already holds a mature catalogue for — **Taipei (id 11, 9 generations)** or **ChengDu (id 6, 4 generations)** — and run the revised prompt against it on the **dev** DB. Diff the names it produces against the names currently stored for that destination and present the diff to the owner. Real known data, zero production writes, one Haiku generation. Per F-27-19 this is the *only* form of validation that tests the artifact that actually ships; cleaning existing rows would test a different mechanism entirely.

> **Cost trap, and it has bitten this project twice.** `DISCOVERY_RESOLVER_DAILY_REQUEST_BUDGET=0` blocks **provider** calls but **not** Claude generation. A dev catalogue past the seven-day freshness window triggers a real paid stale-refresh generation the moment the Discovery panel opens. **Stale-proof the fixture — bump `last_generated_at` — before any browser work in this wave**, and budget the A/B run as one deliberate paid generation rather than discovering it as an accident.

**W4.4 — Do not touch existing rows.** No backfill, no rename, no operator script. F-27-18 measured a deterministic cleanup at 21% collisions with structural mangling of legitimate qualifiers; F-27-20 confirms the 172 will not self-heal, which is why they are recorded as **Q-27-1** with their evidence rather than quietly dropped.

**Acceptance.** Prompt-shape tests for whatever W4.1 enforces structurally. The A/B diff reviewed and signed off by the owner **before** the wave is called complete. No assertion about production verification rates may be made from this wave — the effect is forward-only and appears as destinations regenerate.

---

## Releases and sequencing

**Release 1 — W1 + W2 + W3.** All three are presentation or ordering, none adds an external call, none carries a migration, and their surfaces do not overlap (Details panel / server-side category ordering / map marker layer). W1 is the lowest-risk item in the plan and the one that fixes a live inaccuracy, so it leads.

**Release 2 — W4, alone, after the A/B diff is signed off.** It changes what a paid model generates, its effect is forward-only and irreversible in the sense that generated rows persist (F-27-20), and its correctness is a judgement call about copy rather than an assertion a test can make. It should not be entangled with a release whose regressions would be visible immediately.

**F-27-1 retires Plan 26's "migration must ship alone" constraint for this plan** — there is no migration.

## Verification

- `cd backend; npm test` — baseline 798/798 (34 files). The Windows teardown segfault *after* results print is not a failure (F-27-31).
- `cd frontend; npm test` and `npm run build` — baseline 293/293 (43 files), build clean.
- New coverage required: W1's absent-trust-line cases for `pending` and `unverified`; W2's containment rule in **both** directions plus group-position and no-score-change pins; W3's two-distinct-positions and lone-stop-unchanged cases.
- UI: verify at 375px first, then desktop, for W1 (metadata row with a missing first child), W2 (category counts unchanged, no card lost) and W3 (both Qinghefang pins tappable). Use the Chrome extension against a logged-in localhost tab — the in-app Browser pane freezes Leaflet.
- **Never call this complete from a green suite.** W4 involves a paid provider and a copy judgement; W2 changes what the user sees while browsing.

## Production QA

Standing convention: the agent verifies locally, the owner verifies production. Click-script for Release 1: **Appendix A**. W4's owner gate is the A/B diff itself (W4.3), reviewed before deploy rather than after.

## Cost

**W1, W2, W3 add no paid calls of any kind** and no migration. W2 adds a bounded in-memory pass over one category's rows per request, inside a handler that already ranks and serializes them.

**W4 adds no paid call at runtime either** — it changes prompt text, not call volume, and the generation budget (`MAX_GENERATIONS_PER_DESTINATION_PER_DAY = 3`, `discoveryCatalogue.js:317`) is untouched. Its one deliberate cost is the A/B run: **one Haiku 4.5 generation on the dev DB** (`DISCOVERY_MODEL`, `claude.js:20`), plus whatever the stale-refresh trap costs if the fixture is not stale-proofed first — which is the reason that warning sits inside W4.3 rather than in a footnote.

**Second-order effect worth naming, in the right direction.** Better aliases (W4.2) mean more `resolverQueryTexts` variants per place, so a *successful* verification may cost one or two more Nominatim requests — against a budget of 1,000 requests/day, and offset by fewer places failing every variant and then escalating to paid Google. Not modelled; watch it in the drain's budget line rather than predicting it.

---

## Appendix A — Owner production QA click-script (Release 1: W1 + W2 + W3)

**No migration in this release.** A backup is still cheap insurance, but there is no schema change to confirm and nothing to roll back at the data layer.

**What actually changes for you — three things, all visible:**
- **Suggestions stop calling themselves "Unverified."** You will now see a **Verified** line only on places we could prove; everything else simply says nothing about trust. The word "Unverified" is gone from the app.
- **Related suggestions sit together.** The three Lotus Pond entries, the two Jamek Mosque entries, the House of Matahari cluster — same cards, same ranking, just no longer scattered.
- **Two stops at one spot are both tappable on the map.**

**One thing that looks like a bug and is not — do not report it:** a suggestion whose Details panel shows **no** trust line at all. That is the intended behaviour for anything not yet proven (D-27-1), not a rendering failure.

### A — Trust display (W1)

1. Open a trip → **Plan** → **Discover** → open any suggestion's **Details**.
   **Expect:** either a **Verified** line, or **no trust line at all**. The metadata row must still show duration and hours cleanly, with no gap, stray separator or shifted layout where the label used to be.
   **Report if:** you see the word "Unverified" anywhere, or the metadata row looks broken with the label absent.
2. Do this on **Kuala Lumpur** and **Taipei** specifically — they hold the largest never-checked populations (70 and 38 rows respectively were requeued by Plan 26 W5.2 and have not been checked since). Most cards there should show **no** trust line.
3. Check at **375px on your phone** and on desktop.

### B — Adjacency (W2)

4. Open Discovery on **Kaohsiung** → the attractions category. **Expect** `Lotus Pond`, `Dragon and Tiger Pagodas (Lotus Pond)` and `Zuoying Scenic Area (Lotus Pond Watershed)` to appear **next to each other**, not scattered.
5. Open **Kuala Lumpur**. **Expect** `Jamek Mosque` and `Jamek Mosque (Masjid Jamek)` adjacent, and the three `House of Matahari` entries adjacent.
6. **The regression that matters most.** Scan for a group that has pulled together things that are *not* the same place — the failure mode would look like `Kuala Lumpur War Cemetery` sitting next to `Kuala Lumpur Railway Station` purely because both say "Kuala Lumpur". If you see unrelated places grouped, report it with both names — that means the rule shipped looser than containment.
7. Confirm the **category tab counts are unchanged** and no suggestion has disappeared. W2 reorders only; nothing should be removed.

### C — Coincident map pins (W3)

8. Open the **Hangzhou** trip → the **2026-07-29** day → **Map**.
   **Expect** to see **two** separate numbered pins near Qinghefang, slightly offset from each other, and to be able to tap **each** one and get its own popup — `Qinghefang Antique Street` and `Qinghefang Night Market & Street Food`. Before this release only one was tappable.
   **Check** the route line still connects sensibly and does not visibly detach from either pin.
9. On any other day with normal, well-separated stops: **expect nothing to have changed at all.** A single stop's pin must sit exactly where it always did. If ordinary pins have shifted, the offset is being applied when it should not be — report it.
10. Check step 8 at **375px** as well as desktop.

### Known-and-accepted, do not report as bugs

- Discovery suggestions with **no trust line**. Intended (D-27-1) — that is a place we have not proven, and per F-27-2 there are currently 167 such rows plus 622 that were checked and did not pass.
- **Prose-shaped suggestion names** such as `Michelin Bib Gourmand: Ay-Chung Flour-Shaping (listed above, but worth the emphasis)`. W4 stops new ones being generated; the 172 that already exist are deliberately left alone (Q-27-1) and will not self-heal (F-27-20).
- The other six coordinate-identical stop pairs in production (`Lingyin Temple`, `West Lake`, `Park Hyatt Hangzhou`, `Jing'an Temple`, `The Bund`, `Lotus Pond`). They are on **different days** and never render on the same map, so nothing about them changes (F-27-26).
