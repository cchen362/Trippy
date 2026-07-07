# Implementation Plan 7 — Q3 Discovery Grounded Catalogue and Trip Ranking (Gate C)

**Status: DEPLOYED TO PRODUCTION (2026-07-07, commit `0cfce27`).** All four waves shipped,
merged to local `main`, and now live. Gate C CLOSED 2026-07-06; owner accepted all five
decisions as this plan's written defaults
([decision record](../reviews/2026-07-06-product-architecture-risk-review.md#gate-c-closed--owner-decisions-2026-07-06)).
Implementation was gated on **Plan 6 Wave 3** landing (frontend day-pair wiring); Wave 4
additionally required Plan 6 Wave 4 — both preconditions were verified met before Wave 4
started. Production deploy followed the deploy skill exactly: pre-flight (backend 316/316,
frontend 36/36, build clean, working tree clean, secret-scan clean), pushed `0cfce27` to
origin/main, a fresh pre-migration backup taken on the server via `sqlite3 .backup`
(`~/backups/trippy-pre-plan7-20260707-1210.db`, 942 KB, WAL-consistent — supplements the
existing nightly cron backup), `git pull` (server was 4 commits behind at `ce92734`),
`docker-compose up -d --build`, migrations 016/017/018 applied cleanly and fully logged
(016's backfill ran per-destination: chongqing 76, chengdu 183, kualalumpur 93, 北京 70,
南疆 92 items — matching the design's per-destination `last_generated_at` preservation),
container came up clean (`Trippy backend running on :3001 [production]`, zero errors in
startup logs). Owner did a manual production pass covering Plan/Map/Today tabs, the Discover
panel on both a cached destination (Kuala Lumpur — served instantly from the stored
catalogue) and a brand-new destination (Bali/Denpasar — confirmed production's
`ANTHROPIC_API_KEY` is valid and live generation succeeds, closing the one risk flagged
going into this deploy), add-to-day, the report-flag icon, and the 375px mobile viewport.

**Findings from the production verification pass (real bugs, not fixed the deploy session —
owner decided to close Plan 7 and track these separately, since none are clearly scoped to
this plan alone). Status after the 2026-07-08 investigation/fix session:**
- **#2 FIXED** (`99e3455`, migration 019): root cause was NOT a lost fix — `searchGooglePlaces`
  had always labeled Google's mainland-China GCJ-02 coordinates as `wgs84`; Plan 7's
  verification pipeline (Google-heavy) + Wave 4 trusted-add path were the first to persist
  them into stops, where the map's wgs84→gcj02 display conversion double-shifted the pin
  ~450 m. Fixed at both ingest points (resolver + `lookupHotelDetails`), gated on address
  country component `=== 'CN'` (HK/MO/TW report true WGS84). Migration 019 repairs stored
  rows — production dry-run: 140 discovery_places, 140 place_resolution_cache, 3 stops.
- **#4 FIXED** (`6daf588`, migration 020): the "Bali" generation returned only the last
  category (`wellness`, 10 items) because the model wrapped its NDJSON in a pretty-printed
  array — every trailing-comma line failed `JSON.parse` and was silently dropped; the
  remnant was committed as a fresh 7-day catalogue. Also: `max_tokens` 16000 truncated every
  generation's tail (healthy generations only returned 6–7 of 8 categories). Fixed: parser
  tolerates array-wrapping and logs drops, category names validated against the canonical 8,
  `max_tokens` → 64000 (owner-approved), generations under 4 categories-with-items throw and
  are never committed. Migration 020 resets the corrupted Bali catalogue.
- **#3 DEFERRED** (needs product discussion — tracked in
  [2026-07-08 region-destinations review](../reviews/2026-07-08-region-destinations-and-day-city-extraction.md)):
  two separate surfaces of the "destinations are cities" model. (a) The destination autocomplete requests only
  `locality`/`administrative_area_level_2` types, so provinces like Bali never match.
  (b) "Kabupaten Badung" on day headers came from the W Bali **hotel add**, not the picker:
  hotel city extraction falls back locality→AAL2→AAL1 and Seminyak addresses have no
  locality; the day-geo resolver's hotel layer then stamps the regency on every night of the
  stay (confirmed: day city priority is override → active hotel → same-day transit arrival →
  previous day → seed). Fixing the picker alone won't fix the header.
- **#1 FIXED** (`0be6022`): cards sat inside a `motion.div` grid-item wrapper that stretched
  to row height while the inner card sized to its own content; wrapper is now flex and the
  card fills it. Frontend 36/36; visual equal-height check pending the deploy session's
  manual pass (not verifiable locally — Discover sits behind auth + seeded data).
1. **Suggestion card heights are inconsistent** in the Discover grid (`SuggestionCard.jsx`/
   `DiscoveryPanel.jsx`) — cards size to their own content (name length, notes, hours badge)
   rather than stretching to a common row height. Cosmetic only.
2. **China map pin placement regression.** A Chengdu trip's day-3 stop ("Great Hall of the
   People") rendered several hundred meters from its correct location on the Map tab — classic
   symptom of a WGS84/GCJ-02 ("Mars Coordinates") datum mismatch between the resolved
   coordinate and the map tile layer. Owner confirms this was previously fixed and has now
   reappeared — likely a regression somewhere in the geography/coordinate-resolution chain
   (Plan 6 and/or this plan's Wave 4 trusted-coordinate add path are candidates), not a fresh
   bug — needs a deep dive to find where the earlier fix was lost.
3. **Destination autocomplete doesn't resolve informal region names.** Searching "Bali" in
   the new-trip destination picker returns no match — only formally-named subdivisions
   (Denpasar, Balikpapan, etc.). The owner had to select "Denpasar" as a workaround, and the
   trip's day-level location then displayed as "Kabupaten Badung" (the regency) rather than
   "Bali," requiring a manual per-day correction — impractical for longer trips.
4. **New-destination generation under-produced and mis-categorized results.** Generating
   Bali/Denpasar from scratch (no existing catalogue rows) returned only 10 places total, all
   landing in the "More" tab with Essentials/Nature/Culture/Food/Hidden Gems all showing zero
   — confirmed as the fully-settled final state, not a mid-stream snapshot. This exercises
   this plan's own Wave 2 verification pipeline and Wave 3 category-ordering logic directly,
   so it's the finding most likely to be a Plan 7 regression specifically.
**Design source:** [Completed Q3 review](../reviews/2026-07-06-q3-discovery-personalization-and-shared-cache.md) — all §-references below point there unless stated otherwise.
**Model guidance:** Fable orchestrates and QAs; coding delegated to Sonnet subagents wave by wave.

## What this builds

The discovery contract approved at Gate C: **the global catalogue owns place facts; the trip
owns fit.** AI-generated suggestions are verified against the existing place resolver and
stored as normalized, bounded, provenance-carrying rows keyed by the Q2 `(city, countryCode)`
day pair. Trip preferences (interest tags, pace, travellers) drive deterministic, zero-model-call
ranking, category ordering and honest fit lines. Option A + C composite (review §6); Option B
rejected for browse, reserved for the co-pilot.

Industry pattern this follows (review §2): ground the catalogue in real-places data (Mindtrip,
Wanderlog), make provenance visible (Wanderlog citations, TripAdvisor stats), rank
deterministically over metadata (TripAdvisor quality×quantity×recency) — never per-browse
model calls.

## Owner decisions that shape this plan (Gate C CLOSED 2026-07-06 — all five accepted)

| # | Decision | Accepted answer | Where it lands |
|---|---|---|---|
| 1 | Unverified items | Show with "Unverified" badge, rank-penalized | Waves 3–4 |
| 2 | Rating enrichment | Approved, behind `DISCOVERY_RATING_ENRICHMENT` env flag (off by default) | Wave 2 |
| 3 | Report semantics | Report ⇒ immediate global suppress + audit log | Wave 2 (API), Wave 4 (UI) |
| 4 | Bounds | 45 active/category · 3 generations/destination/day · 400-name exclusion cap | Wave 2 |
| 5 | Q3-04/Q3-05 fixes | Ship inside Wave 4 (not cherry-picked earlier) | Wave 4 |

## Out of scope (do not drift)

Co-pilot feature work (consumes this catalogue later — parent decision 6), per-trip AI
reranking (Option B, rejected), seasonal/date-based fit, multi-user report/review-queue
workflows, analytics tables (metrics are structured logs at this scale), any change to the
place-resolution chain beyond the field-mask addition in 2.2.

## Preconditions

1. **Plan 6 Wave 3 merged:** `listDaysForTrip` already exposes `resolvedCountry` (Wave 2,
   `2a60547`); Wave 3 makes the frontend consume it and pass `locationCountry` on discovery
   add-stop (Plan 6 §3.4). This plan's Wave 4 builds directly on that wiring.
2. **Plan 6 Wave 4 merged before this plan's Wave 4:** it removes `trips.destinations`, which
   `DiscoveryPanel.jsx:248` still uses as a last-resort default — this plan's Wave 4 replaces
   that fallback with the derived trip summary field (same response name, derived, per Plan 6).
3. ~~Gate C closed with owner answers to the five decisions above.~~ **DONE 2026-07-06** —
   all five accepted as written.
4. Production baseline current (nightly backup cron live per Plan 6 preconditions).

---

## Wave 1 — Normalized catalogue schema, keyed by the day pair

**Status: COMPLETE (2026-07-07).** Migration `016_discovery_catalogue.js` (JS migration, following
the 014 pattern) creates `discovery_destinations`/`discovery_places` and backfills every
`global_discovery_cache` row into them (item-count parity, `whyItFits`→`why_go`,
`country_code` via `countryCodeFromName`, model lat/lng never carried over, and — a fix made
during orchestrator review — the old row's `fetched_at` is preserved as `last_generated_at` so a
destination cached moments before the migration isn't immediately treated as stale and forced
through an unwanted extra Claude call). New `backend/src/db/discoveryCatalogue.js`
(`getOrCreateDestination`/`listActivePlaces`/`insertPlaces`/`listExclusionNames`, all
parameterised, all take `db` explicitly). `routes/discovery.js` rewritten to read/write the new
tables instead of the blob; `mergeDiscoveryCategories` retired; SSE event shapes unchanged for
old clients (`whyItFits` etc. still the wire field names — the `whyGo` dual-key change is Wave
3+); the generation-failure-serves-stored-catalogue behavior (scenario 8) is live. Prompt
(`claude.js` `DISCOVER_SYSTEM`) rewritten to destination-voice editorial (no traveller/group/
preference framing) — wire field name `whyItFits` unchanged per spec. `global_discovery_cache`
is NOT dropped (Wave 4 retires it). Tests: backend 231 → **248/248 green** (17 files);
`discoveryMerge.test.js` deleted (function retired) and its coverage replaced/exceeded by
`discoveryCatalogue.test.js` (new) plus expanded `discovery.test.js` (migration idempotence,
backfill parity, golden-fixture parity, `(city,'')` vs `(city,'MY')` distinctness, generation-
failure-with-catalogue, and the backfill-freshness fix). Frontend untouched (0 diff, still
29/29). Delegated to a Sonnet subagent (first pass mistakenly tried to delegate further instead
of writing code — caught and corrected mid-session); orchestrator reviewed every file against
this plan and the schema/route/prompt diffs line-by-line before commit, and made one fix
directly (the `last_generated_at` backfill gap above) rather than a further agent round.

**Goal:** the blob becomes rows; the key gains a country; generation gains country context and
destination-voice editorial. No verification/ranking yet — behavior-preserving otherwise.

### 1.1 Migration `016_discovery_catalogue.sql`

```sql
CREATE TABLE IF NOT EXISTS discovery_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_key TEXT NOT NULL,                 -- normalized city (same rules as today: routes/discovery.js:94-97)
  country_code TEXT NOT NULL DEFAULT '',  -- ISO alpha-2 from the day pair; '' when unknown
  display_name TEXT NOT NULL,             -- human-readable, used in prompts and hero
  last_generated_at TEXT,
  generation_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (city_key, country_code)
);

CREATE TABLE IF NOT EXISTS discovery_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id INTEGER NOT NULL REFERENCES discovery_destinations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,          -- via claude.js normalizeName
  local_name TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL,
  why_go TEXT,                            -- destination-voice editorial (was whyItFits)
  estimated_duration TEXT,
  opening_hours TEXT,
  provider_place_id TEXT,                 -- 'google:<placeId>' | 'osm:<type>/<id>' when verified (Wave 2)
  lat REAL, lng REAL,                     -- resolver-sourced only; model coords are never stored
  business_status TEXT,
  rating REAL, rating_count INTEGER,      -- only under DISCOVERY_RATING_ENRICHMENT (decision 2)
  provenance TEXT NOT NULL DEFAULT 'unverified',  -- 'pending' | 'verified' | 'unverified'
  status TEXT NOT NULL DEFAULT 'active',          -- 'active' | 'suppressed' | 'archived'
  batch INTEGER NOT NULL DEFAULT 0,       -- 0 = first generation; increments per merge
  generated_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discovery_places_dest
  ON discovery_places(destination_id, status, category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_places_name
  ON discovery_places(destination_id, normalized_name);
```

New migration file only; never modify 001–015 (CLAUDE.md). `016` follows Plan 6's 013–015.

### 1.2 Backfill (inside the migration runner's transaction, Plan 6 Wave 4 pattern)

Parse each `global_discovery_cache` row into the new tables: `city_key` from the existing
primary key; `display_name` = the key (best available); `country_code` via
`countryCodeFromName(display_name)` else `''`; items get `provenance='unverified'`, `batch=0`,
`generated_at` from the item's stamp else the row's `fetched_at`. Log per-destination item
counts. Do **not** drop the old table here (4.4 retires it after readers are gone). Production
holds a handful of rows — this is a one-shot cleanup, not a compatibility program.

### 1.3 Catalogue service `backend/src/db/discoveryCatalogue.js`

New module (DB access lives in `db/`, not `services/` — CLAUDE.md conventions):
`getOrCreateDestination({cityKey, countryCode, displayName})`, `listActivePlaces(destinationId)`,
`insertPlaces(destinationId, items, batch)` (dedup against `normalized_name` unique index;
place-id dedup added in Wave 2), `listExclusionNames(destinationId, cap)` (active+archived,
most recent first). All parameterised statements.

### 1.4 Route reads/writes rows instead of the blob

`routes/discovery.js`: body gains optional `countryCode` (validated `/^[A-Z]{2}$/` or absent).
Cache lookup becomes `(cacheKey, countryCode ?? '')`. Fresh-cache serve, stale-merge, and
show-more paths keep their SSE event shapes but source items from `listActivePlaces` and write
via `insertPlaces`. `mergeDiscoveryCategories` retires (the unique index + insert dedup replace
it); the stale-refresh replay dance (`discovery.js:158-166`) simplifies to: stream stored
categories, generate delta, insert, stream merged from DB. **Failure-mode change (scenario 8):
if generation throws and stored places exist, stream them with
`{ type: 'done', cached: true, generationFailed: true }` instead of an error event.** Only an
empty catalogue surfaces `type: 'error'`.

### 1.5 Prompt changes (`claude.js` discovery prompt, ~line 160)

- Destination context includes the country when known ("Chengdu, China (CN)") — disambiguates
  homonym cities (scenario 4) and anchors generation.
- `whyItFits` renamed `whyGo`, instruction rewritten to destination voice: explain what makes
  the place distinctive; **never reference the traveller, their group, or their preferences**
  (review §2.4 — this text is global and shown to every trip).

**Wave 1 tests:** migration idempotence + backfill parity (blob item count == row count per
destination) on empty DB and production-snapshot copy; route serves identical category/item
sets before/after for a seeded blob (golden fixture, `whyGo` aliased); `(city, '')` and
`(city, 'MY')` are distinct catalogues; generation-failure-with-catalogue streams stored items.
Baselines: backend ≥ 219, frontend ≥ 28.

---

## Wave 2 — Verification pipeline, provenance, bounds, suppression

**Status: COMPLETE (2026-07-07).** New `backend/src/services/discoveryVerify.js`: an
in-process, serial per-destination queue, enqueued fire-and-forget from the route right
after `insertPlaces`/`enforceCategoryCap` — never awaited, so a stuck or throwing lookup
can never block or fail the SSE response. Confident hit = resolver `locationStatus ===
'resolved'` with matching country when both known → `provenance='verified'` +
`provider_place_id`/`lat`/`lng`/`verified_at`; `businessStatus === 'CLOSED_PERMANENTLY'`
(new unconditional field-mask addition in `placeResolver.js`) → additionally
`status='suppressed'`, logged loudly. No confident hit → `provenance='unverified'`
(terminal). Place-id dedup archives the newcomer and union-merges aliases into the
earlier row. Nominatim's existing 1 req/s throttle (already in `placeResolver.js`) is
reused as-is, not duplicated. Daily resolver-call budget (`DISCOVERY_RESOLVER_DAILY_BUDGET`,
default 500, in-memory UTC-day counter): once exhausted, remaining queued items are marked
`provenance='pending'` and retried the next time anyone browses that destination (pending
rows are folded back into the queue on the next `enqueueForVerification` call — no separate
startup scan). `DISCOVERY_RATING_ENRICHMENT` gains a per-call opt-in (`includeRatingFields`
threaded through `resolvePlace`/`searchGooglePlaces`, set only by `discoveryVerify.js`) so
the pricier rating field-mask tier is requested for discovery verification only, never for
booking/stop resolution even when the flag is globally on — a gap in the first-pass
implementation caught and fixed during orchestrator review. Bounds: `enforceCategoryCap`
(new, `discoveryCatalogue.js`) archives category surplus over 45, unverified/pending before
verified, oldest batch first within a tier; generation limit is a new durable per-UTC-day
counter (`discovery_generation_daily` table, migration `017_discovery_generation_daily.sql`
— `generation_count` is lifetime, not daily, per the Wave 1 handoff) capped at 3/day/
destination, surfaced as SSE `{type:'error', code:'generation_limit'}`; `listExclusionNames`
now also excludes `suppressed` rows. New `POST /api/discovery/places/:placeId/report`
(mounted separately since `tripId` arrives in the body, not the URL) suppresses + logs.
Tests: backend 248 → **277/277 green** (18 files); new `discoveryVerify.test.js` plus
extensions to `discovery.test.js`/`discoveryCatalogue.test.js` covering the pipeline
fixtures, category-cap archival ordering, generation-limit across UTC-day boundaries, the
report endpoint, worker failure isolation, the resolver budget cap, and the mandatory
two-trips-same-city pollution invariant (global tables byte-identical regardless of
generation order). Delegated to a Sonnet subagent; orchestrator reviewed every changed file
against the plan and fixed the rating-flag scoping gap directly rather than a further agent
round.

**Goal:** the catalogue becomes trustworthy and bounded. Everything here is backend-only.

### 2.1 Verification worker `backend/src/services/discoveryVerify.js`

In-process queue (no new infra): after `insertPlaces`, enqueue the new row ids with the
destination pair. Worker drains serially, throttled to 1 lookup/s (Nominatim policy; ~240
items ≈ 4 min background). Per item:

1. Resolve `name` (+ `local_name` fallback) through the existing resolver chain
   (`placeResolver.js`), biased by the destination's city + country — reusing
   `place_resolution_cache`, so repeat destinations are near-free.
2. Confident hit with matching country (when both known) → `provenance='verified'`,
   store `provider_place_id`, resolver `lat/lng`, `verified_at`; if Google reported
   `businessStatus` and it is `CLOSED_PERMANENTLY` → `status='suppressed'` + audit log.
3. No confident hit → `provenance='unverified'` (terminal; badge + rank penalty downstream).
4. **Place-id dedup:** if another active row in the destination already holds this
   `provider_place_id`, keep the earlier row, merge aliases, archive the newcomer (scenario 5).

Queue failures are isolated: a thrown lookup marks the item `unverified`, logs loudly
(`console.error` minimum — CLAUDE.md), and never affects serving. Items awaiting the worker
hold `provenance='pending'` (rendered as unverified until resolved).

### 2.2 Resolver field mask + rating flag (decision 2)

`placeResolver.js` Google Text Search field mask gains `places.businessStatus` (Plan 6 §1.3
already adds `places.addressComponents`). Under `DISCOVERY_RATING_ENRICHMENT=1` also request
`places.rating,places.userRatingCount` and persist onto the discovery row — **flag applies to
discovery verification calls only**, not booking/stop resolution. Note in code why: field
tiers price by mask; at current volume all usage sits within monthly free caps, and the flag
keeps that reviewable.

### 2.3 Bounds (decision 4)

- **Category cap:** after insert+verification, if a category's active count > 45, archive
  lowest-ranked surplus using the Wave 3 scorer with neutral trip prefs — never archiving
  verified over unverified (`status='archived'`; still excluded from regeneration).
- **Generation limit:** `generation_count`-based check — max 3 generations per destination per
  UTC day → SSE `{ type: 'error', code: 'generation_limit', message: … }` (friendly copy in
  Wave 4).
- **Exclusion cap:** `listExclusionNames(destinationId, 400)`.

### 2.4 Report/suppress endpoint (decision 3)

`POST /api/discovery/places/:placeId/report` (requireAuth + trip access via body `tripId`):
sets `status='suppressed'`, logs `[discovery] suppressed place=<id> name=… by user=… trip=…`.
Suppressed rows stay excluded from regeneration (they don't come back) and never stream.

**Wave 2 tests:** the review §9 pipeline fixtures — real place → verified with id+coords;
fabricated → unverified; closed → suppressed at ingest; local-name duplicate → place-id
dedup/merge. Cap archives correct victims; generation limit enforced across two mock trips
(shared destination); report endpoint suppresses + logs; worker failure isolation (lookup
throws → item unverified, serving unaffected). Pollution invariant: two trips, same city,
different prefs → global tables byte-identical after both browse.

---

## Wave 3 — Trip ranking layer (deterministic, zero model calls)

**Status: COMPLETE (2026-07-07).** New `backend/src/services/discoveryRank.js`: pure
`score(item, prefs)` (verified boost, batch penalty, category-interest boost, pace/duration
fit via a new `parseDurationHours` free-text parser, optional quality term gated on `rating`
presence), `rankPlaces` (stable sort, descending score, ties keep generation order),
`orderCategories` (essentials first, then interest-tag order, then the rest, family demotes
nightlife last). Server-side `TAG_TO_CATEGORY` copied verbatim from `DiscoveryPanel.jsx`
(frontend untouched — Wave 4 consumes). `routes/discovery.js` builds `prefs` once per request
from `req.trip` (raw row: `interest_tags` JSON-parsed, `pace`, `travellers`) and threads it
through all DB-row-shape streaming paths (fresh-cache-hit, stale-refresh pre-stream and
post-merge stream, append/show-more stream, and the generation-failure fallback path — a
fourth call site not named in the original brief but sharing the same row shape, caught and
included during implementation); the live mid-generation `onCategory` callback is deliberately
left in raw Claude order (documented inline) since those items predate DB insertion and have no
provenance/batch to rank on yet. `serializePlaceRow` gains additive fields only: `whyGo`
(dual-keyed with `whyItFits`), `provenance`, `batch`, `placeRef` (`provider_place_id`), verified-
only `lat`/`lng` (unverified/pending stay null — no `sanitizeDiscoveryCategory` function existed
to retire; already gone), and a deterministic, honesty-gated `fitLine` (only claims an interest,
pace fit, or verified status the trip actually declared/matches; empty string otherwise).
`enforceCategoryCap` (`discoveryCatalogue.js`) now archives surplus using `rankPlaces`'s
`score()` with neutral prefs, tier-partitioned (unverified/pending ranked worst-first and fully
consumed before the verified tier is touched at all) — the verified-never-archived-before-
unverified invariant is unchanged and re-tested; two existing archival-ordering tests were
updated (not weakened) since the real scorer's `−0.75·batch` term flips which batches score
worst versus the old neutral SQL ordering (highest batch now archived first, not lowest).
Tests: backend 277 → **313/313 green** (19 files); new `discoveryRank.test.js` (34 tests,
every scoring term isolated, duration parsing, category ordering, rank stability); extended
`discovery.test.js` with the required scenario-1 test (same catalogue, solo/fast/food vs.
family/relaxed/no-interests → different category order, different item order via pace-fit,
identical underlying row set) and an explicit fitLine-honesty test (a trip declaring only
`history` never gets a "Matches food" claim even browsing a strong food item); golden-fixture
parity test extended with the new additive fields rather than replaced. Delegated to a Sonnet
subagent; orchestrator reviewed every changed/added file line-by-line against the plan and
review doc before commit — no additional fixes needed beyond the subagent's own work.

**Goal:** preferences finally do something. Pure functions, computed per request in the route.

### 3.1 `backend/src/services/discoveryRank.js`

```
score(item, prefs) =
    3.0 · verified                        // provenance ('pending' counts as unverified)
  − 0.75 · batch                          // later "show more" batches rank lower (Q3-02)
  + 1.5 · categoryMatchesInterest         // TAG_TO_CATEGORY mapping moves server-side, shared
  + 0.5 · paceFit                         // parse estimatedDuration → hours; fast: ≤2h, relaxed: ≥3h, moderate: neutral
  + quality (flag only): (rating − 3.5) · log10(1 + rating_count)
```

Ties keep generation order (Claude's editorial order is a real prior — review §6.3).
`orderCategories(prefs)`: `essentials` first, then interest-mapped categories in tag order,
then the rest; `travellers === 'family'` moves `nightlife` last. Both functions pure and
unit-tested in isolation.

### 3.2 Route integration

The discover route loads the trip row (already access-checked) and streams categories in
`orderCategories` order, items pre-sorted by `score`. Item payload gains additive fields:
`provenance`, `batch`, `placeRef` (= `provider_place_id`), `lat/lng` (verified only — replaces
the blanket null from `sanitizeDiscoveryCategory`, which retires), and `fitLine` — composed
deterministically, e.g. `"Matches food · ~2h · verified place"`; empty when nothing honest to
say. `whyGo` streams under both `whyGo` and legacy `whyItFits` keys until Wave 4 lands.

**Wave 3 tests:** scenario 1 as a service test (same city, solo-fast-food vs slow-family →
different category order, item order, fit lines; identical row sets); each scoring term
isolated; fit line never claims an interest the trip didn't declare; payload additive-shape
golden file (old client fields untouched).

---

## Wave 4 — Frontend: honest UI, pair-keyed cache, trusted adds

**Status: COMPLETE (2026-07-07).** `useDiscovery.js` cache is now pair-keyed
(`norm(city)|CC`); `discover`/`showMore`/`getDestination` take `(destination, countryCode)`;
`discoveryApi.discover` sends `countryCode` when known and the manual "Go" search
deliberately clears it (free-text search shouldn't force a country match).
`DiscoveryPanel.jsx` derives the default city+country from the active day's
`resolvedCity`/`resolvedCountry`, falling back through `days[0]` to the trip's derived
`destinations`/`destinationCountries` (same field names, Plan 6 Wave 4 — no frontend
change needed there beyond wiring country through). `buildTabs` now returns a terminal
**"More"** tab grouping every streamed category not otherwise tabbed, rendered as labeled
sub-sections; hero `totalCount` is summed structurally across the tab list (not
independently, so the Q3-04 invariant holds by construction). "Show more" swaps its label
to `Finding more places…` with an animated ellipsis (reusing the existing `pulse` keyframe)
while a show-more is in flight, reverting the instant `done` lands. `SuggestionCard` gained
a `VERIFIED`/`UNVERIFIED` DM Mono tag (cream, low emphasis — gold stays reserved for the
duration/"In trip" badges) and renders the honesty-gated `fitLine` in muted Cormorant
italic. `handleAddToDay` takes the trusted `coordinateSource:'places'` fast path (same shape
`handleAddPlaceResult` already used) for verified items with coordinates, skipping a
redundant geocode; both branches tag `source:'discovery'`/`provenance`, and `createStop`
logs `[discovery] add trip=… place=… provenance=…` on those adds (the keep-vs-browse
metric). `serializePlaceRow` gained one additive field, `id`, needed by the client to call
the report endpoint. Migration numbered **018**, not 017 as originally drafted — 017 was
already taken by Wave 2's `017_discovery_generation_daily.sql` by the time this wave
landed; grep confirmed the only reference to `global_discovery_cache` left was migration
016's one-time historical backfill, so `018_retire_global_discovery_cache.sql` drops it
clean. Tests: backend 313 → **316/316** (19 files); frontend 29 → **36/36** (5 files,
new `DiscoveryPanel.test.jsx`). Delegated to a Sonnet subagent; orchestrator reviewed every
changed file line-by-line and made one fix directly — the report-failure handler in
`SuggestionCard.jsx` silently swallowed errors on a failed report, which the subagent's own
brief should have caught given the project's no-silent-failure rule; added a `console.error`.

**Report UX iteration (same session, post-implementation):** the literal `"Report — not
real / closed?"` sentence button specified in §4.3 below shipped first, then was replaced
after live review — a full sentence repeated on every card across every tab read as
visual noise, not a deliberate design choice. Redesigned to a bare `Flag` icon (lucide-react,
matching the icon set used everywhere else in the app) at low emphasis in the bottom-right
of the card's action row; tapping it reveals a two-choice confirm (`Not real` / `Closed`,
both calling the same suppress endpoint — decision 3 has no reason taxonomy, the choice
exists to make the tap deliberate) plus a cancel, dismissed by either choice or an
outside click (same pattern `DayPicker` already used). This is a deliberate, reviewed
deviation from the literal wording in §4.3, not a miss — the plan's *intent* (a low-friction,
reversible way to flag a bad place) is what shipped; the exact copy in §4.3 is superseded.
Frontend tests: 35 → **36/36** (added a two-step-not-one-tap assertion).

**Manual 375px pass, live against the real dev DB and a real trip (Chengdu-Chongqing):**
verified pair-keying (country-aware destination row created distinct from the old
country-less backfilled row), honest hero count (5→4 after a live report, tab counts
matched), the report round-trip (card animated out, DB row flipped to `suppressed`),
the trusted-add fast path (added a real verified place — stop landed with the exact
seeded `lat`/`lng`, `coordinate_source='places'`, `location_status='resolved'`, no resolver
call fired), and the keep-vs-browse log line. The dev Claude API key was invalid all
session (401 on every generation attempt) — this incidentally proved Wave 1 scenario 8's
graceful-degrade path for real: every request against a destination with existing places
served/fell back silently, only a genuinely empty destination surfaced an error. All
seeded test rows and the one real stop created during live testing were cleaned up
afterward; the trip's real data was left exactly as found. **Not separately verified:** the
Map tab's visual pin rendering for a trusted-coordinate add (the DB row's lat/lng/status
fields were confirmed correct via direct query, which is what drives the pin, but the Map
tab itself wasn't opened and screenshotted in this session).

### 4.1 Pair-keyed discovery (builds on Plan 6 Wave 3)

`useDiscovery.js`: cache key becomes `norm(city)|CC`; `discover`/`showMore` accept
`{ destination, countryCode }`; `discoveryApi.discover` sends `countryCode`.
`DiscoveryPanel.jsx`: default destination uses the active day's `resolvedCity` +
`resolvedCountry` (exposed since Plan 6 Wave 2, consumed per Wave 3); the
`trip.destinations?.[0]` fallback (`DiscoveryPanel.jsx:248`) switches to the derived
destinations summary field (same API field name after Plan 6 Wave 4).

### 4.2 Honest tabs and hero count (Q3-04, decision 5)

`buildTabs` gains a terminal **"More"** tab grouping every returned category not already
tabbed (rendered as sub-sections with category headers). Hero `totalCount` sums active items
across *reachable* tabs — which, with "More", is everything streamed. Count and reachability
agree by construction.

### 4.3 Show-more affordance (Q3-05) + provenance UI

- Show More while loading: label swaps to `Finding more places…` with animated ellipsis
  (DM Mono, per design language); button un-dims the moment `done` arrives.
- Verified badge: small DM Mono `VERIFIED` tag on cards (gold is already spent on the type
  badge per component — use cream at reduced opacity, per CLAUDE.md gold discipline);
  unverified items render an `UNVERIFIED` tag at lower emphasis. `fitLine` renders under the
  description in Cormorant italic.
- Card overflow action **"Report — not real / closed?"** → report endpoint → card animates out.

### 4.4 Trusted add-to-trip + metrics + retirement

- `handleAddToDay` (`DiscoveryPanel.jsx:321-332`): when the item is verified, pass
  `lat/lng/coordinateSystem:'wgs84'/coordinateSource:'places'/providerId: placeRef/locationStatus:'resolved'`
  — the same trusted fast path `handleAddPlaceResult` already uses (`DiscoveryPanel.jsx:350-365`) —
  skipping a redundant server-side geocode per add. Unverified items keep today's free-text
  resolution path, now with `locationCountry` from the day pair (Plan 6 §3.4).
- Backend logs `[discovery] add trip=… place=… provenance=…` on discovery-sourced stop creates
  (route passes a `source: 'discovery'` hint) — the review §9 keep-vs-browse metric.
- **Migration `017_retire_global_discovery_cache.sql`:** `DROP TABLE global_discovery_cache;`
  Prerequisite grep: zero remaining readers (`routes/discovery.js` is today's only one).

**Wave 4 tests:** component tests — tabs include "More" and hero count equals reachable sum;
show-more label swap; verified add sends trusted-coordinate payload, unverified doesn't;
report removes card. **Manual 375px pass (CLAUDE.md mobile-first):** live destination browse —
count honest, badges legible on `--ink-mid` cards, show-more progress visible, report flow,
verified add lands a correctly-pinned stop on the Map tab.

---

## Trust criteria (Gate D applied to this plan)

- Migrations 016–017 atomic; 016's backfill inside the runner's transaction; production deploy
  order: fresh manual backup → deploy → migrate → verify the two real trips' discovery,
  Logistics, Map and share link.
- Verification worker fully isolated from serving; every suppression/archival/budget-hit is
  loudly logged; no swallowed errors (CLAUDE.md).
- Resolver-call budget: hard daily cap on discovery-verification lookups (default 500/day)
  with a loud log when hit; Nominatim throttle ≤ 1 req/s.
- Pollution invariant pinned by test (Wave 2): one trip's browsing cannot alter another trip's
  global rows.
- Baselines only grow: backend ≥ 219, frontend ≥ 28 before each wave merges.

## Sessions and sequencing

Wave 1 and Wave 2 are each a backend-focused session; Wave 3 is a short backend session
(pure functions + route wiring); Wave 4 one frontend-focused session after Plan 6 Wave 4 is
merged. Each session: Sonnet subagent implements, Fable reviews against the Q3 review's
evidence, tests green before commit.

## Session handoff prompts (paste-ready)

One wave per session; paste the wave's prompt as the session's first message. Each is
self-contained — the plan and review carry the detail, the prompt carries the pointers,
guardrails, and definition of done.

### Wave 1

```text
Implement Wave 1 of "docs/superpowers/plans/Implementation Plan 7 Q3 Discovery Grounded
Catalogue.md". Before coding, read the whole plan plus §5–6 of its design source
(docs/superpowers/reviews/2026-07-06-q3-discovery-personalization-and-shared-cache.md),
and verify the plan's preconditions hold (Plan 6 Wave 3 merged) — if not, stop and tell me.
Delegate implementation to a Sonnet subagent and review its output yourself against the plan.
Hard rules: new migration 016 only, never touch 001–015; SSE event shapes stay backward
compatible (old client must work against the new server); nothing trip-specific written to
the new global tables; test baselines at session start may only grow, all green before commit.
When done, report: test counts, files changed, any deviation from the plan (get my approval
on deviations before committing), and anything Wave 2 needs to know.
```

### Wave 2

```text
Implement Wave 2 of "docs/superpowers/plans/Implementation Plan 7 Q3 Discovery Grounded
Catalogue.md" (Wave 1 must already be merged — verify, else stop). Read the plan and review
§6.2–6.4 first. Delegate coding to a Sonnet subagent; review yourself against the plan.
Hard rules: the verification worker must never block or fail the SSE serving path; Nominatim
lookups throttled to 1/sec with the daily budget cap from the Trust criteria; rating fields
only under DISCOVERY_RATING_ENRICHMENT; every suppression/archival/budget-hit loudly logged;
the two-trips-same-city pollution-invariant test is mandatory; baselines only grow, all green
before commit. Report as in Wave 1.
```

### Wave 3

```text
Implement Wave 3 of "docs/superpowers/plans/Implementation Plan 7 Q3 Discovery Grounded
Catalogue.md" (Waves 1–2 merged — verify, else stop). Read the plan §3 and review §6.3/§2.3
first. Delegate coding to a Sonnet subagent; review yourself. Hard rules: ranking and
category ordering are pure functions with zero model calls; item payload changes are
additive (golden-file test for the old shape); fit lines may only claim preferences the trip
actually declared; baselines only grow, all green before commit. Report as in Wave 1,
including the scenario-1 test output (same city, two preference profiles, different order).
```

### Wave 4

```text
Implement Wave 4 of "docs/superpowers/plans/Implementation Plan 7 Q3 Discovery Grounded
Catalogue.md" (Plan 7 Waves 1–3 AND Plan 6 Wave 4 merged — verify, else stop). Read the plan
§4 and the design rules in CLAUDE.md (gold-accent discipline, three fonts, mobile-first).
Delegate coding to a Sonnet subagent; review yourself. Hard rules: migration 017 only after
a grep proves zero remaining global_discovery_cache readers; hero count must equal the sum
of reachable tab counts; verified adds use the trusted-coordinates path; finish with the
manual 375px pass from the plan and show me screenshots/evidence. Report as in Wave 1, plus
the exit-criteria checklist from the plan with each line marked met/not-met.
```

## Exit criteria

- All eight review §3 scenarios green as tests; pipeline fixtures (verified/fabricated/closed/
  duplicate) green.
- Q3-01 closed: all three preference fields visibly shape output; Q3-02 closed: provenance +
  suppression + batch penalty live; Q3-03 closed: caps/archival/limits enforced; Q3-04/Q3-05
  closed on a 375px device.
- Blob table dropped; SSE protocol changes additive throughout; discovery answers from the
  stored catalogue when the AI provider is down.
- Adds-per-generation derivable from logs (the "places users keep" metric).
