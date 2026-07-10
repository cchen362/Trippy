# Implementation Plan 10 — Stop Card Image System (Descriptor-Driven Imagery)

**Status: Wave 1 COMPLETE (2026-07-11).**

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
- Unsplash production-tier application (revisit only if demo-tier 50/hr is ever hit;
  W1 compliance work is a prerequisite for that application anyway).
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
- **W2 — NOT STARTED** (depends on W1 columns — ready to start; dev Unsplash key
  confirmed working as of 2026-07-11).
- **W3 — NOT STARTED** (3.1/3.2 can run parallel to W2; 3.3 depends on W2's
  `resolvePhotoUrl` shape)
- **W4 — NOT STARTED** (depends on W1–W3)

Test baseline at plan writing: Plan 9 closed at backend 387 / frontend 66 all green
(2026-07-11); re-verified before W1 at backend 442/443 (1 pre-existing flake) /
frontend 90/90 green.
