# Implementation Plan 10 — Stop Card Image System (Descriptor-Driven Imagery)

**Status: Wave 4 COMPLETE — PLAN COMPLETE (2026-07-11).**

**Origin:** independent review of the activity-card image system, 2026-07-11 (this plan
encodes its findings and the owner-approved design decisions from that session).
Problem: stop-card images repeat within a city and are frequently semantically wrong
(temple for a market, cityscape for a nature stop). Root cause is the assignment
mechanic, not Unsplash itself.

**Goal:** every photo-eligible stop gets an image that is culturally and semantically
appropriate, unique within its trip, and stable across reorganization — via one
pipeline: *good descriptor → relevance-ordered gated pick with trip-level dedup →
country-scoped scene fallback → deliberately styled no-image card* — plus Unsplash
attribution compliance and a user swap affordance. No new paid APIs, no new caches,
no backfill of existing trips.

---

## 0. Verified facts this plan is built on (traced 2026-07-11)

Confirmed in current `main`; implementation sessions must not re-derive them.

1. **The picker randomizes rank position by design.** `pickPhoto`
   (`backend/src/services/unsplash.js:64-79`) searches once (10 landscape results,
   `content_filter=high`) and selects index `(dayIndex × 7 + titleHash) % n` — an
   anti-repetition measure that draws ~half of all photos from the low-relevance tail
   and still collides when two stops share a result pool. This is the primary cause of
   both wrongness and repeats.
2. **Queries are built from the mangled raw title, never the resolved place name.**
   `cleanTitle` strips parentheticals and everything after " at " ; `buildPhotoQuery`
   appends type/city heuristics (`backend/src/services/stops.js:42-66`). "Lunch at Din
   Tai Fung" → `"Lunch food"`. The same stop row already carries `resolved_name` from
   Nominatim/Google Places — unused by the photo path.
3. **Only the bare URL is persisted.** `resolvePhotoUrl` returns `photo.url` alone
   (`stops.js:318-339`); the photo id, photographer name/links, and referral URLs that
   `mapPhoto` (`unsplash.js:12-21`) already builds are discarded. `stops` has a single
   `unsplash_photo_url` column (migration 004). Consequences: no dedup is possible
   (no id), and **Unsplash API terms are currently violated** — no visible
   attribution anywhere, no download-tracking call (`links.download_location` is not
   even mapped).
4. **Photos re-roll on day moves.** `updateStop` sets `shouldRefreshPhoto` when
   `isMoving` (`stops.js:431`), and `dayIndex` is part of the selection formula, so
   dragging a stop to another day usually swaps its image.
5. **Discovery places carry no imagery.** The `discovery_places` insert has no photo
   columns (`backend/src/db/discoveryCatalogue.js:79-84`); the DiscoveryPanel add
   payload sends no photo fields (`frontend/src/components/discovery/DiscoveryPanel.jsx:430-443`);
   grep of frontend/backend confirms `unsplashPhotoUrl` appears only in StopCard,
   ShareViewPage, and the stops serializers. **Plan 9 §0 fact 7's parenthetical
   ("Discovery-added stops … carry catalogue photo URLs") is stale/incorrect** —
   all stops go through the same title-search path at `createStop`.
6. **Discovery generation schema** is the NDJSON `DISCOVER_SYSTEM` prompt
   (`backend/src/services/claude.js:166-186`): items carry `name, description,
   whyItFits, estimatedDuration, openingHours, lat, lng, localName, aliases` under a
   `category` (8 canonical categories, `claude.js:11`). Catalogue TTL is 7 days, so
   schema additions need **no backfill** — old rows age out.
7. **Existing photo surfaces:** Timeline `StopCard.jsx:100-104` (full-bleed `<img>` +
   `trip-card-overlay`; fallback is a flat `linear-gradient(135deg, #3d3021, #101010)`),
   `ShareViewPage.jsx:25-28` (background-image with baked-in gradient). The expanded
   StopCard already has a mono action row (`Remove` / `Move to →`) with an `action`
   state machine (`StopCard.jsx:200-272`) — the swap affordance's home.
8. **Existing endpoints reusable as-is or nearly:** `GET /api/lookups/photos`
   (search proxy; `unsplashService.search` exists frontend-side and is currently
   unused by any component) and `POST /api/trips/:tripId/refresh-photos`
   (`backfillTripPhotos`, `stops.js:607-631`, fills NULL-photo stops only).
9. **Unsplash key is demo tier (50 req/hr)** — owner-confirmed 2026-07-11 and deemed
   sufficient for the fetch-once model (worst burst: AI import, already serialized —
   `importer.js:364-366`). Attribution compliance (W1) is independent of tier.
10. **All existing trips are owner test data** (standing owner statement, 2026-07-10);
    no photo backfill obligation.

---

## 1. Design decisions (owner-approved 2026-07-11 — encode, don't re-open)

- **D1 — Unsplash stays the sole source.** Google Place Photos rejected: mediocre UGC
  aesthetics off-brand for the design language, new billing, and Google's no-long-term-
  storage/expiring-URL policy structurally conflicts with Trippy's fetch-once-store-
  forever model and the API-cost-discipline rule.
- **D2 — One pipeline, not a resolver-style cascade.** Descriptor → search →
  relevance-ordered pick with (a) trip-level photo-id exclusion and (b) a token-overlap
  relevance gate → country-scoped scene fallback query → styled no-image card. The
  hash-picker, `dayIndex` arithmetic, and title-mangling regexes are **deleted**. Tier
  count equals today's (primary → fallback → none); only the inputs improve.
- **D3 — Descriptors are authored by Claude.** Discovery places get `photoQuery` +
  `sceneType` for free inside the existing generation call. Manual stops get one
  Haiku descriptor call at creation (cost ≈ fractions of a cent, latency lands on a
  path that already blocks on geocoding + Unsplash — owner-approved). Descriptors are
  **stored on the stop**, so swaps/re-rolls never re-pay the call.
- **D4 — No backfill.** Existing trips are test data. New logic applies to new stops
  and to edits that already trigger a photo refresh; the `refresh-photos` endpoint
  remains for manual re-runs.
- **D5 — No scene-pool caching initially.** Demo tier + fetch-once volume doesn't
  justify it; add a `(country, sceneType)` cache only if rate limits are actually hit.
- **D6 — Photo stability.** A photo persists until the *title or type* changes or the
  user explicitly swaps it. Moving a stop between days never re-rolls the image
  (`isMoving` leaves `shouldRefreshPhoto`).
- **D7 — Collapsed card is sacred: zero new elements.** All new UI lives in the
  expanded state or share page, in existing idioms:
  - *Attribution:* one micro-line in the expanded section — DM Mono, 9px,
    `letter-spacing 0.2em`, uppercase, `rgba(240,234,216,0.35)` (same weight as the
    Remove/Move buttons): `PHOTO — {PHOTOGRAPHER} / UNSPLASH`, photographer name
    linking to `photographerUrl`, "UNSPLASH" to `unsplashUrl` (both already carry
    UTM referral params via `buildReferralUrl`). Share page: same micro-caption,
    bottom-right corner inside the existing dark gradient. Nothing on the collapsed
    card.
  - *Swap photo:* a third button in the existing expanded action row
    (`Remove · Move to → · Photo →`), reusing the `action` state machine: `action ===
    'photo'` swaps the row for a horizontally scrollable strip of small thumbnails
    (from `GET /api/lookups/photos` seeded with the stored `photo_query`) + Cancel —
    exactly the move-to-day-chips pattern. No modal, no new component idiom.
  - *No-image state:* keep the flat gradient but make it deliberate — per-type tint
    (e.g. warm umber for food, deep green-black for nature, slate for culture; exact
    values proposed at W2 implementation for owner approval, derived from the fixed
    palette — gold stays accent-only, never a fill). The existing DM Mono type badge
    carries the visual weight. No "missing image" text.
- **D8 — Scene-type vocabulary** (closed enum, used by descriptor generation and the
  fallback query): `temple_shrine, market, street_neighborhood, nature_outdoors,
  museum_gallery, landmark_architecture, food_drink, nightlife, beach_water,
  viewpoint, wellness, hotel_stay, entertainment, generic`. Fallback query shape:
  `"{scene type words} {country}"` (e.g. `"street market Vietnam"`); `generic` falls
  back to `"{city} travel"`.

---

## 2. Waves

### Wave 1 — Schema, persistence, and Unsplash compliance (backend + light UI)

1.1 Migration 025: add to `stops` — `unsplash_photo_id TEXT`, `photo_attribution_json
    TEXT` (photographer name, photographerUrl, unsplashUrl), `photo_query TEXT`,
    `scene_type TEXT`. (Attribution as one JSON column keeps the row tidy; it is
    read-only display data.)
1.2 `unsplash.js`: map `links.download_location` in `mapPhoto`; add
    `trackDownload(photo)` firing the Unsplash download endpoint (async,
    non-blocking, failure logged not thrown) invoked whenever a photo is *selected*
    (auto-assign and manual swap).
1.3 Persist id + attribution + descriptor everywhere the URL is written today:
    `createStop`, `updateStop`, `backfillTripPhotos`; serialize in `formatStop`,
    trips detail, and `share.js`.
1.4 Attribution UI per D7: expanded StopCard micro-line; ShareViewPage corner
    micro-caption. Collapsed card untouched (assert in test).
1.5 Tests: migration, serialization round-trip, download-tracking called on select,
    attribution renders only when photo present.

**Acceptance:** new stop rows carry id/attribution/descriptor columns; expanded card
shows credit; collapsed card DOM unchanged vs. baseline snapshot; Unsplash download
endpoint hit once per selection.

### Wave 2 — Selection engine rework (backend)

2.1 Replace `pickPhoto` with `selectPhoto({ query, sceneType, country, city,
    excludeIds })`: results in Unsplash relevance order; skip ids in `excludeIds`
    (all `unsplash_photo_id`s in the trip); apply relevance gate — ≥1 significant
    query token (stopwords/city/country stripped) present in `alt_description` /
    `description` / `tags` (map `tags` in `mapPhoto`). First result passing both
    wins.
2.2 Fallback tier: if nothing passes, search `"{sceneType words} {country}"` (D8),
    dedup still applied, gate off (query is generic by construction). If that also
    yields nothing → NULL (styled card).
2.3 Delete `titleHash`, `dayIndex` arithmetic, `cleanTitle`, `buildPhotoQuery`,
    `buildFallbackQuery`. Query precedence in `resolvePhotoUrl`:
    stored/incoming `photoQuery` → `resolved_name + city` → `title + city`.
2.4 D6 stability: remove `isMoving` from `shouldRefreshPhoto`; title/type edits
    re-run the pipeline reusing the stored descriptor (regenerate descriptor only if
    the *title* changed).
2.5 Update `backfillTripPhotos` to the new pipeline. Styled per-type no-image
    gradient in StopCard (tint map proposed to owner before merge, per D7).
2.6 Tests: dedup across a trip, gate rejects non-overlapping results, fallback
    engages on gate failure, move does not change photo, transit still excluded.

**Acceptance:** two same-city stops never share a photo id within a trip; a
gate-failing primary query lands on a country-scene image, not a random tail result;
moving a stop preserves its image.

### Wave 3 — Descriptors (Claude integration, both entry paths)

3.1 Discovery: extend `DISCOVER_SYSTEM` item schema with `photoQuery` (culturally
    specific English search string for stock-photo search, ≤8 words) and `sceneType`
    (D8 enum; instruct the model to choose the closest, `generic` if unsure).
    Tolerate absence (older cached catalogues, model omissions) — precedence chain
    from 2.3 covers it.
3.2 Migration 026: `discovery_places` + `photo_query`, `scene_type` columns;
    populate on insert; serialize through `serializePlaceRow` and the discovery wire
    format; thread through the DiscoveryPanel add payload (both the verified fast
    path and the standard path) into `createStop` input.
3.3 Manual stops: `generatePhotoDescriptor({ title, resolvedName, city, country,
    type })` in `claude.js` — single cheap Haiku call (follow existing model-config
    pattern in `claude.js`), returns `{ photoQuery, sceneType }`; strict output
    validation, on any failure fall through to `resolved_name + city` (never block
    stop creation on descriptor failure). Called from `resolvePhotoUrl` only when no
    descriptor was supplied and type is photo-eligible.
3.4 Copilot-created stops: verify they flow through `createStop`/`updateStop`
    services (expected) and therefore inherit the pipeline; add a regression test.
3.5 Tests: schema tolerance (items without new fields), descriptor threading
    discovery→stop row, Haiku failure fallback, sceneType enum validation.

**Acceptance:** a discovery add stores the catalogue-authored descriptor on the stop
with no extra API call; a manual add stores a Haiku-authored descriptor; a Haiku
outage still creates the stop with a resolved-name query.

### Wave 4 — Swap-photo UI + end-to-end verification (frontend-heavy)

4.1 `Photo →` action in the expanded StopCard row per D7: `action === 'photo'`
    renders a horizontal thumbnail strip (≈64px tall, `overflow-x: auto`, 6–10
    candidates from `GET /api/lookups/photos?q={stored photo_query}`, excluding the
    current photo id) + Cancel. Tap applies via `updateStop` carrying the full photo
    object (url, id, attribution) — extend the stops PATCH contract accordingly;
    user-chosen photos are never auto-re-rolled (explicit choice wins over title
    edits until the user swaps again).
4.2 Attribution updates live on swap; download tracking fires on swap (W1.2).
4.3 Mobile-first verification at 375px: strip scrolls, action row doesn't wrap
    awkwardly, credit line doesn't collide with the note textarea.
4.4 Full browser QA pass (local): create manual stop (descriptor + relevant photo +
    credit), discovery add (catalogue descriptor), same-city dedup visually
    confirmed, move stop (photo stable), swap photo (strip, apply, persist across
    reload), transit unaffected, no-image styled card via a forced miss.
4.5 Deploy via `/deploy` skill; production spot-check per the owner click-script
    convention (owner runs the browser pass; agent verifies DB rows + logs via ssh).

**Acceptance:** all QA-pass items green locally; production spot-check confirms new
columns populated and credit rendering on a real stop.

---

## 3. Explicitly out of scope

- Backfilling or re-rolling photos on existing (test-data) trips beyond the existing
  `refresh-photos` endpoint.
- `(country, sceneType)` scene-pool caching (D5 — only on demonstrated rate-limit
  pressure).
- Trip cover imagery (`TripCard`) — it derives from stop photos and inherits quality
  improvements automatically; any dedicated cover-selection logic is a separate idea.
- Unsplash production-tier application. **COMPLETE (2026-07-17):** after the demo-tier
  50/hr ceiling was hit during W4 production QA, the owner applied with the W1
  compliance evidence and Unsplash approved the existing key for 1,000 requests/hour.
  The live response header confirmed the new ceiling; no application-code or key change
  was required.
- Google Place Photos in any role (D1).

## 4. Open items to confirm during implementation (not blockers)

- Exact per-type fallback tint values (W2.5) — proposed by the implementer from the
  fixed palette, owner-approved before merge (design-spec §8 discipline: gold never a
  fill).
- Haiku model id per the existing `claude.js` config pattern at implementation time.
- Whether `share.js`'s public payload should include attribution (it must if the
  share page shows photos — assumed yes, verify the share serializer covers it).

## 5. Wave status

- **W1 — COMPLETE (2026-07-11).** Migration 025 added `unsplash_photo_id`,
  `photo_attribution_json`, `photo_query`, `scene_type` to `stops`. `unsplash.js`
  maps `links.download_location` and exports `trackDownload()` (fired, non-blocking,
  whenever `resolvePhotoUrl` selects a fresh photo). `resolvePhotoUrl` now returns
  `{ url, photoId, attribution, photoQuery, sceneType }` instead of a bare URL string;
  every write path that used to touch `unsplash_photo_url` alone now persists all four
  new columns — `createStop`, `updateStop` (both the refresh and passthrough branches),
  `backfillTripPhotos`, and `syncStopWithBooking` (2 UPDATE branches + 1 INSERT branch;
  this fourth write path wasn't called out in the plan's explore findings but was
  found and updated during implementation). Serialization threaded through all three
  independent row mappers: `stops.js formatStop`, `trips.js mapStop` (full internal
  fields), `share.js mapStop` (attribution only — no id/query/sceneType leaked
  publicly). Attribution UI landed exactly per D7: StopCard micro-line in the expanded
  state only (`stopPropagation` on both credit links so they don't collapse the card
  on tap), ShareViewPage bottom-right corner caption inside the existing gradient;
  collapsed card DOM verified unchanged (image renders, no credit). Backend
  442→446 tests green (7 new), frontend 90→94 green (4 new); one pre-existing
  `auth.test.js` rate-limit timing flake confirmed unrelated (fails in isolation on
  clean `main` too). Browser-verified end-to-end against the live local dev app
  (Bali trip, real trip data), including a genuine live Unsplash search (not just
  a synthetic seed): a real created stop ("Tanah Lot Temple") round-tripped a real
  photo id, photographer, and referral-tagged URLs from Unsplash through
  `createStop` → DB → API response; the credit line rendered correctly in the
  StopCard expanded state (with working referral links) and was absent when
  collapsed. (An earlier verification pass in this session read the *root*
  `Trippy/.env` — config.js's fallback file — while the already-running dev
  backend was loading `backend/.env`'s placeholder key; that produced a false
  "invalid Unsplash key" reading, corrected once the owner updated
  `backend/.env` and the backend was restarted.) Test/synthetic data cleaned up
  after verification — no residual rows in the owner's trip data.
- **W2 — COMPLETE (2026-07-11).** Selection engine fully reworked. `unsplash.js`:
  `mapPhoto` now maps `tags` (from the raw `[{title}]` shape → flat lowercase array);
  `pickPhoto` (the `dayIndex×7 + titleHash` index-hasher — the root cause of both
  repeats and wrongness) **deleted** and replaced by `selectPhoto({ query, sceneType,
  country, city, excludeIds })` — walks `searchPhotos` results in native Unsplash
  relevance order and returns the first photo that is both un-excluded (trip-level
  dedup) and passes a token-overlap relevance gate (significant query tokens, with
  city/country/stopwords stripped, matched against `alt` + `tags`); on a full gate
  miss it falls back to a gate-free `"{scene words} {country}"` search (or `"{city}
  travel"` for null/`generic` scenes), dedup still applied; both tiers empty → NULL.
  `stops.js`: `resolvePhotoUrl` re-signatured to `{ title, type, city, countryCode,
  resolvedName, photoQuery, sceneType, excludeIds, existing }` with query precedence
  `stored/incoming photoQuery → resolvedName+city → title+city` (country name via the
  existing `countryNameFromCode` util); dead helpers `cleanTitle`, `cityInTitle`,
  `buildPhotoQuery`, `buildFallbackQuery`, `titleHash`, and `getDayIndex` all deleted
  (grep-confirmed zero references). New `getTripPhotoIds(tripId, excludeStopId)`
  supplies the dedup exclusion set; wired into all four write paths — `createStop`,
  `updateStop`, `backfillTripPhotos` (seeds the set once and pushes each newly-assigned
  id so backfilled stops don't collide with each other), and `syncStopWithBooking`
  (dedup only on the new-INSERT search path). **D6 stability landed:** `isMoving`
  removed from `updateStop`'s `shouldRefreshPhoto`, so a bare day-move never re-rolls
  the image; a title change invalidates the stored descriptor (falls through to
  resolvedName/title), a type-only change reuses it. `trackDownload` call site
  preserved. StopCard no-image card now uses the **owner-approved 8-family per-scene
  tint map** (keyed by `sceneType`, falling back to stop `type`, then `generic`; all
  fade to `--ink-deep` #0d0b09, gold never a fill): Culture #232227, Food #2a1d12,
  Market/Street #2b1a13, Nature/Beach/Viewpoint #14201a, Nightlife/Entertainment
  #241419, Wellness #1a201d, Hotel #201d18, Generic #241a12. (Note: `sceneType` is
  null for most stops until W3 authors descriptors, so the `type`-fallback/generic
  tints dominate today — owner accepted this as clean temporary-until-W3 infra.)
  **Deviation:** one pre-existing test in the "resolutionAnchor consumption (Plan 8
  Wave 5)" block ("uses the resolved city for photo queries") was rewritten — its
  assertion destructured a `fallbackQuery` param off the old `pickPhoto` call that
  `selectPhoto` no longer exposes; replaced with equivalent `query`/`city` assertions.
  **Tests:** backend 446→453 green (6 new Wave 2 cases: trip-level dedup, gate→fallback
  fallthrough, fallback-query shape for real vs. generic/null scene, D6 move-preserves,
  transit exclusion; the previously-flaky auth timing test also passed this run).
  Frontend 94/94 green (StopCard DOM tests still pass with the new fallback background).
  **Browser/live verification (not just green tests):** ran the real service stack
  (`createStop`/`updateStop` → `resolvePhotoUrl` → `selectPhoto`) against a fresh temp
  DB and the **live Unsplash API** — three same-city Hanoi stops returned three distinct
  real photo ids (dedup PASS); moving a stop day→day preserved its photo id (D6 PASS); a
  nonsense-title stop resolved via the `"Hanoi travel"` country/city fallback rather than
  a random tail result (gate PASS); transit excluded (PASS). In the live local app
  (Bali trip) the no-image hotel card ("W Bali - Seminyak") renders the exact approved
  Hotel tint `linear-gradient(135deg,#201d18,#0d0b09)`; frontend boots clean, no console
  or build errors. Not browser-verified in the owner's UI: two activity photos shown
  side-by-side (that distinct-render behavior was proven against live Unsplash in
  isolation and by W1's Bali render, so no owner-data stops were created/deleted here).
- **W3 — COMPLETE (2026-07-11).** Descriptor generation landed on both entry paths.
  `claude.js`: `DISCOVER_SYSTEM` extended with `photoQuery` (≤8-word culturally-specific
  search string) and `sceneType` (D8 enum) per item; new exports `SCENE_TYPES` (the
  closed 14-value enum), `coerceSceneType()` (validates-or-nulls any string against
  it), and `generatePhotoDescriptor({ title, resolvedName, city, country, type })` — a
  single non-streaming `claude-haiku-4-5-20251001` call (256 max_tokens, fenced-JSON
  system prompt) that never throws: missing/malformed output, an unparseable response,
  or an API error (bad key, network failure) are all caught internally and return
  `null`. Migration 026 (`discovery_place_photo_descriptor.sql`, next after 025) adds
  `photo_query`/`scene_type` to `discovery_places`; `discoveryCatalogue.js`'s
  `insertPlaces` persists them (`photoQuery` trimmed/capped at 8 words, `sceneType`
  run through `coerceSceneType` — an invalid enum from the model is stored as `null`,
  never as the bad string) and tolerates items that omit the fields entirely (older
  cached catalogues / model omissions — both columns land `null`, letting the Wave 2
  precedence chain in `resolvePhotoUrl` fall through as before). `discovery.js`'s
  `serializePlaceRow` surfaces `photoQuery`/`sceneType` on the wire.
  `DiscoveryPanel.jsx`'s `handleAddToDay` threads `suggestion.photoQuery` /
  `suggestion.sceneType` into **both** the verified-fast-path and standard `onAddStop`
  payloads into `createStop`. `stops.js`: `resolvePhotoUrl` now calls
  `generatePhotoDescriptor` (wrapped in a second, defense-in-depth try/catch at the
  call site) exactly when no `photoQuery` was supplied AND the stop is photo-eligible
  (the existing `isPhotoEligible`/`existing`-override early-returns already gate this
  for transit stops and explicit overrides) — a returned descriptor's `photoQuery`
  feeds the existing precedence chain and its `sceneType` fills in only when the
  caller didn't already pass one; a `null`/thrown result leaves the chain exactly as
  Wave 2 built it (falls through to `resolvedName+city` / `title+city`). Copilot-created
  stops (`routes/copilot.js`'s `add_stop` → `createStop`) inherit the pipeline
  automatically — no code change needed, verified by a new regression test.
  **Tests:** backend 453→472 green (19 new): `claude.test.js` unit-tests
  `generatePhotoDescriptor` (well-formed parse, invalid-enum coercion, 8-word cap,
  no-fence/malformed-JSON/missing-photoQuery/API-failure all → `null`) and
  `coerceSceneType`; `discoveryCatalogue.test.js` covers persistence, invalid-enum
  coercion, and schema tolerance for descriptor-less items; `migrations.test.js`
  checks the new columns and bumps the migration-count assertion to 26;
  `locationIntegration.test.js` adds a default `generatePhotoDescriptor` mock
  (`mockResolvedValue(null)`) to its `beforeEach` — preserves every pre-Wave-3
  query/city assertion unchanged — plus a new `photo descriptors (Plan 10 Wave 3)`
  block: discovery-supplied descriptor stored with zero extra Haiku calls,
  manual-add triggers exactly one Haiku call and stores its result, no call when a
  `photoQuery` is already supplied, a Haiku outage (`mockRejectedValue`) still
  creates the stop via the resolvedName/title+city fallback, transit stops never
  trigger a descriptor call, and the copilot-add regression test. `discovery.test.js`
  and `copilot.test.js`'s existing `vi.mock('../src/services/claude.js', ...)`
  factories needed `coerceSceneType` added (the former; the latter mocks
  `stops.js` wholesale so was unaffected) — without it, `insertPlaces` (imported
  transitively through the mocked module) threw on every discovery-route test.
  Frontend 94/94 unchanged (no UI surface changed this wave — `StopCard.jsx`'s
  tint map already consumed `sceneType`, wired in W2).
  **Live verification (not just green tests):** ran a throwaway script
  (`backend/verify-wave3.mjs`, deleted after use) against the real service stack and
  the **live Anthropic + Unsplash APIs** — `generatePhotoDescriptor` returned a real,
  culturally-specific Hanoi descriptor (`"Hanoi egg coffee cafe Vietnamese specialty"`,
  `food_drink`); a manual `createStop` with no descriptor fired exactly one live Haiku
  call and landed a real Unsplash photo id; a discovery-style `createStop` carrying a
  pre-supplied `photoQuery`/`sceneType` stored them verbatim with **no** Haiku call.
  Along the way this surfaced and fixed the same `backend/.env`-shadows-root-`.env`
  gotcha W1 hit for the Unsplash key (`backend/.env`'s `ANTHROPIC_API_KEY` was a
  placeholder; synced from the root `.env`'s real key) — with the placeholder key
  still in place, `generatePhotoDescriptor` correctly caught the 401 and returned
  `null`, and `createStop` still completed with the title+city fallback query, which
  incidentally doubled as a live "Haiku outage" proof before the key was fixed.
  **Browser-verified by the owner (2026-07-11)**, after killing the other session's
  stale dev servers and restarting both (backend now reads the corrected
  `ANTHROPIC_API_KEY`): a manual "Egg Coffee Cafe" add in the live Shanghai–Hangzhou
  trip rendered a topically Chinese food photo + credit line — correct, since the
  descriptor call is seeded with the trip's actual day city/country (Shanghai/
  Hangzhou, China), not anything inferred from the ambiguous Vietnamese title; a
  Discovery-panel add for a Hanoi suggestion rendered Vietnamese-lantern imagery +
  credit line via the catalogue's own descriptor (no extra Haiku call); a flight
  booking (transit) rendered with no photo/credit line, untouched. No console errors,
  no stuck states. The no-image styled-tint fallback path was not exercised in the UI
  (rare — both descriptor and fallback search would need to miss) but remains covered
  by the automated Wave 2/3 test suite.
- **W4 — COMPLETE (2026-07-11).** Swap-photo UI + the pin guarantee landed; plan
  complete. **Backend:** migration `027_stop_photo_source.sql` adds `photo_source TEXT`
  to `stops` (`'user'` = user-swapped/pinned, `'auto'` = search/descriptor-assigned,
  `NULL` = legacy/booking-sync/backfill — all treated as auto-reroll-eligible). This
  column exists solely to honor §4.1's *"user-chosen photos are never auto-re-rolled"*
  requirement — the one part of W4 that couldn't reuse W1's existing override path,
  because nothing previously distinguished a user-pinned photo from a search-derived
  one. `updateStop`'s `shouldRefreshPhoto` rewritten to
  `hasExplicitPhoto || ((title||type changed) && !isUserPinned)`: an explicit swap
  always wins and re-pins (`photo_source='user'`); a title/type edit re-rolls only when
  the current photo isn't user-pinned; a bare day-move still passes through untouched
  (D6). `photoSource` write mirrors it (`'user'` on swap, `'auto'` on a productive
  auto-reroll, `null` on a reroll that found nothing, existing preserved on
  passthrough). `createStop` sets `'user'` when an explicit `unsplashPhotoUrl` is
  supplied else `'auto'`/`null`. **Download-tracking on swap (§4.2):** the override
  branch of `resolvePhotoUrl` deliberately skips `selectPhoto`/`trackDownload`, so
  `updateStop` now fires `trackDownload({ downloadLocation: input.photoDownloadLocation })`
  (non-blocking) whenever a manual swap arrives — keeping Unsplash T&C compliance the
  swap would otherwise bypass. `photoDownloadLocation` is transient (used to fire the
  hit, never persisted). `formatStop` serializes `photoSource`. `syncStopWithBooking`
  and `backfillTripPhotos` intentionally untouched (NULL source = auto-eligible, the
  correct default). **Frontend (`StopCard.jsx`):** `'photo'` added to the `action`
  state machine; a `Photo →` trigger in the expanded action row (hidden for
  `type==='transit'`), opening a horizontally-scrollable (`overflowX:auto`,
  `flexShrink:0` thumbnails) `CHOOSE PHOTO` strip of ≤8 live candidates from
  `unsplashService.search(stop.photoQuery || stop.title)` (current photo id excluded),
  mirroring the move-chips idiom exactly — DM Mono labels, gold used once as the
  thumbnail hover ring, Cancel button. Tapping a thumbnail PATCHes via `onUpdate` with
  the wire contract `{ unsplashPhotoUrl, unsplashPhotoId, photoAttribution, photoQuery,
  photoDownloadLocation }`; the W1 attribution micro-line then re-renders from the
  refetched row. Collapsed card untouched. **The wire contract** (the one coupling
  between the two halves) — body keys `unsplashPhotoUrl, unsplashPhotoId,
  photoAttribution, photoQuery, photoDownloadLocation` — consumed by the existing
  `photoOverrideFromInput` override path (no new Unsplash search on a swap).
  **Tests:** backend 472→477 green (5 new W4 cases: swap pins + skips search,
  trackDownload fires with the supplied downloadLocation, pin survives a title edit,
  non-pinned still re-rolls, migration column + count 26→27); frontend 94→98 green
  (4 new StopCard cases: trigger visibility by type, fetch + query fallback +
  current-photo exclusion, exact `onUpdate` contract on tap, collapsed card clean).
  Build clean. **Browser-verified end-to-end (live local app, 375px mobile, real
  owner test-data trip):** expanded the booking-linked "Waldorf Astoria Chengdu" hotel
  → action row rendered `REMOVE  PHOTO →` (Move correctly absent — booking-linked);
  `PHOTO →` fired a real `GET /api/lookups/photos?q=Waldorf%20Astoria%20Chengdu → 200`
  (title fallback, since this pre-W1 stop had `photo_query=null`); the 2 live Unsplash
  candidates each carried id/url/downloadLocation/photographer/photographerUrl/
  unsplashUrl; tapping one swapped the image instantly and the credit micro-line
  updated live to `PHOTO — SHAWN LEE / UNSPLASH`; the DB row confirmed
  `photo_source='user'`, `unsplash_photo_id='spmJzUlhZqE'`, full attribution JSON with
  UTM referral URLs, and `photo_query='Waldorf Astoria Chengdu'`; the swap survived a
  full page reload; the transit stop (SQ 842) showed no photo/action UI; no `unsplash`
  failure logs (trackDownload fired silently). **Not exercised in the browser** (covered
  by the automated suite instead, acceptable gaps): the horizontal-scroll overflow with
  a full 8-candidate strip (this query returned only 2 — CSS `overflowX:auto` +
  `flexShrink:0` is component-rendered), the Cancel path, the no-image styled-tint
  fallback via a forced double-miss (rare; W2 tests cover it), and a title-edit
  re-roll-suppression in the UI (no inline title editor readily reachable; proven by
  backend test #3 + the confirmed `photo_source='user'`). **Deviation from §4.1 note:**
  the pin guarantee required a new migration (027) — the plan's explore findings assumed
  the swap might reuse W1's override path wholesale, but that path had no persisted
  pin marker; adding `photo_source` was the clean root-cause fix (no bandaid).
  **QA test data:** the Waldorf stop's photo was swapped as the live test and left in
  place — it previously carried no attribution (pre-W1, technically non-compliant), so
  the swap is a net compliance improvement; owner can re-swap. **Deploy:** via `/deploy`
  (see commit); owner runs the prod browser click-script, agent verifies DB rows + logs
  via ssh.
  **Production deploy + QA outcome (2026-07-11):** deployed commit `6760af2` to Debian
  (`trippy-trippy-1`, host port 6768). Because prod was still at Plan 9 (`1088f1e`),
  this shipped **all of Plan 10 (W1–W4)** as a unit; migrations 025/026/027 applied
  cleanly, schema verified (`stops` has photo_source/photo_query/unsplash_photo_id/
  scene_type/photo_attribution_json; `discovery_places` has photo_query/scene_type),
  data intact (86 stops / 4 trips at deploy). WAL-consistent DB backup taken first at
  `~/Trippy/backups/trippy.pre-plan10.20260711-034325.db{,-wal,-shm}`. **Owner browser
  pass (prod):** a live swap on "Yu Garden" wrote `photo_source='user'` +
  `unsplash_photo_id=C9wzlV_xfIk` + full attribution (photographer Alexey, referral
  URLs) + `photo_query='Yu Garden'`, credit line rendered, persisted across reload —
  W4 confirmed end-to-end in production. On a fresh owner trip ("Shanghai – Hangzhou
  (W4 Test)") every new stop received a rich, correct Haiku/discovery descriptor
  (e.g. "Jing'an Temple Shanghai Buddha worship incense" / `temple_shrine`; "Park Hyatt
  Hangzhou luxury hotel West Lake" / `hotel_stay`) — W2/W3 confirmed live.
  **Finding (not a defect): Unsplash demo-tier 50-req/hr ceiling hit under combined
  load.** Several new stops landed photoless while their swap strips (opened later) were
  full. Root cause proven from prod logs: 4× `[photo] unsplash lookup failed … 'Rate
  Limit Exceeded'`, **zero** gate/empty (`no unsplash result`) failures — so the
  descriptor + gate + dedup logic is sound; only the final Unsplash search was
  throttled. The descriptor is generated *before* the search, so the query is stored
  even when the image fetch 403s (→ NULL photo, non-blocking, recoverable). The 50/hr
  budget is a **single app-wide key** shared across all users, all auto-assigns, and
  (that day) the agent's ~20 diagnostic searches — hence the burst exhaustion. Per-action
  cost measured: Discovery browsing **0** requests (fact #5), add-a-stop **1–2** (2 only
  on a gate-miss fallback), open-a-swap-strip **1** (whole strip, not per thumbnail),
  apply-a-swap **1** (download ping). **Recovery:** ran `backfillTripPhotos` on the
  W4-Test trip (owner-approved) — 4 NULL-photo stops → 0, each filled from its stored
  query with distinct ids (dedup holding) + attribution; the existing `refresh-photos`
  path is the standing remedy for any future throttled misses. **Production-tier
  follow-up complete (2026-07-17):** Unsplash approved the existing access key for
  **1,000 req/hr (20× the demo-tier headroom)** after the owner submitted the W1
  compliance evidence. An in-container request returned HTTP 200 with
  `x-ratelimit-limit: 1000` and `x-ratelimit-remaining: 999`. Because approval upgraded
  the existing key account-side, no key replacement, container rebuild, or app-code
  change was required; only the server `.env` description was updated.
  Minor optional future optimization (non-blocking): a frequent relevance-gate miss
  doubles the request count via the country-scene fallback — production tier makes this
  moot; revisit only if 1,000/hr is ever pressured.

Test baseline at plan writing: Plan 9 closed at backend 387 / frontend 66 all green
(2026-07-11); re-verified before W1 at backend 442/443 (1 pre-existing flake) /
frontend 90/90 green. W3 closes at backend 472/472, frontend 94/94, both green. W4 (plan complete) closes
at backend 477/477, frontend 98/98, both green.
