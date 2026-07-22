# Implementation Plan 22 — Trips Home Route Covers & Sweep

**Status:** WRITTEN 2026-07-22 — not started. Owner has approved the design direction (route-hero covers) and every default in the design notes: humane countdown scale, silent past card, drop the status pill. Design is workshopped and locked in the mockup; this plan is the build.

**Written:** 2026-07-22, from a UI sweep of Trips Home. Design was iterated live against a mockup — **[docs/superpowers/mockups/trip-cover-route-study.html](../mockups/trip-cover-route-study.html)** — which is the visual source of truth for this plan (open it; the Route hero ↔ Typographic and Desktop ↔ Mobile toggles are live). Every code fact below was verified against live code on 2026-07-22 at commit `5b5c5ea`. Do not re-derive these facts; trust them unless the code has visibly moved.

**Schema impact: NONE.** No migration. The route geometry is assembled from data that already exists — `trip_scopes.bounds_json` (a persisted lat/lng box per user-selected scope) and stop/day coordinates. The only backend change is **additive**: `GET /api/trips` gains a `destinationsGeo` field per trip. No column, no table, no existing field changes shape.

**User-visible impact: the entire Trips Home is redesigned.** This is the opposite asymmetry from Plan 21 — almost everything here is a rendered change. The trip card stops being a repeated stock photo and becomes a per-trip route diagram in the Trippy palette; status pills become a bare status line with a live-trip pulse and an upcoming countdown; past trips subordinate; section counts move inline; the disabled bottom-nav tabs disappear; a first-run empty state and a promoted New Trip CTA appear.

---

## Model recommendation per wave

| Wave | Recommendation | Why |
| --- | --- | --- |
| W1 — Backend geo | Opus orchestrator + one Sonnet coder | Pure data assembly with a real correctness trap: coordinates must be *sampled from the live DB*, not trusted from a green test. A scope with no `bounds_json` and a day-derived city with no coordinate must both resolve to `null` cleanly, and mainland-China scopes may be GCJ-02 (coordinate-system provenance matters). |
| W2 — Route cover | Opus orchestrator + one Sonnet coder, **Opus owns design QA** | This is where AI-slop risk lives. The SVG must match the mockup's restraint (faint graticule, single gold route, no tiles) and degrade gracefully for 0/1/many nodes. A Sonnet coder can build the renderer; Opus must eyeball every trip shape against the mockup at 375px and desktop. |
| W3 — Home refit | Opus orchestrator + one Sonnet coder | Mechanical but broad: height fix, status line, inline counts, past subordination, nav omission, empty state, CTA. Low individual risk, high surface area — easy to leave one token or breakpoint wrong. |
| W4 — QA, convention, deploy | Opus orchestrator, no coder | Full bar, 375px regression, `CLAUDE.md` convention capture, single deploy, owner click-script. |

Waves are sequential. W2 consumes W1's `destinationsGeo`; W3 sits on top of W2's card. W2 and W3 also share `TripsHomePage.jsx`/`TripCard.jsx`, so they must not run in parallel — never split a wave across two subagents here, the file overlap is total.

QA every wave: automated tests locally, then exercise the real flow in a browser, then (after deploy) hand the owner a phone-width click-script per [owner-runs-production-browser-passes].

---

## The two root causes, stated once

**Root cause A — the card never fills its own height, so the layout the code intends never happens.** [TripCard.jsx:31-34](../../../frontend/src/components/trips/TripCard.jsx):

```jsx
<div className="relative min-h-[220px] sm:min-h-[260px]">   {/* parent: min-height only, no height */}
  <img ... />
  <div className="absolute inset-0 trip-card-overlay" />
  <div className="relative h-full p-5 ... flex flex-col justify-between">  {/* h-full = height:100% */}
```

`height: 100%` resolves against the parent's *computed* height. The parent sets only `min-height`, so its height is `auto`, the percentage collapses to `auto`, and the flex column shrinks to its content. With no free space, `justify-between` distributes nothing — badge and title stack at the top and `min-height` pads empty photo below. This one bug produces three of the reported symptoms: top-heavy cards, the wasted photo footer visible in the sweep screenshot, and the status pill crowding the destination line. It is fixed structurally (content layer fills the card), never by nudging margins.

**Root cause B — the trip cover has nothing trip-specific to show, so it repeats.** [TripCard.jsx:20](../../../frontend/src/components/trips/TripCard.jsx) hardcodes one Unsplash URL for every trip. The uniformity was a deliberate answer to a real problem (no correct single image for a multi-city or multi-country trip), but its cost is a Trips Home where every card is the same desert road. The fix is to stop sourcing a photo and instead render the one thing that *is* per-trip and already computed server-side: the destinations and their geography. The blocker is that the geography is discarded before it reaches the client (Finding F9).

---

## Findings (severity, with the evidence)

**F1 — Trip cards collapse to top-heavy; title never anchors, pill crowds the city line. Live. HIGH.**
Root cause A. Directly visible in the sweep screenshot: on every upcoming card the badge/destinations/title/dates cluster in the top third and the bottom ~40% is empty photo. The prior mockup [trip-cover-baseline.html:14,21-23](../mockups/trip-cover-baseline.html) already proved the fix (a `grid-template-rows: auto 1fr auto` copy layer). Evidence: `TripCard.jsx:31-34`.

**F2 — Every card shows the identical hardcoded photo. MEDIUM.**
`TripCard.jsx:20`. Uniform by intent, but the effect is a templated, non-personal index that reads as AI-slop against the project's own design rules. Superseded by the route cover (D1).

**F3 — The status pill repeats the section header. MEDIUM.**
`TripsHomePage.jsx:127-137` renders a `{section}` heading (`ACTIVE` / `UPCOMING` / `PAST`) with a count, and `TripCard.jsx:36-45` renders the same status word as a pill inside every card. The card's status slot says nothing the header doesn't — except on the active card, where `Active now` (`:46-50`) genuinely adds liveness. Owner-approved resolution: bare status line, liveness for active, countdown for upcoming, silence for past (D6).

**F4 — Section counts are flung to the page edge. LOW.**
`TripsHomePage.jsx:130` wraps the heading in `justify-between`, so the count sits against the far right margin (the lonely `1`/`3` in the screenshot). Logistics already has the wanted pattern: `LogisticsTab.jsx:274-277` renders `HOTELS<span> · 2</span>` inline. (D8)

**F5 — Disabled bottom-nav tabs are double-dimmed to ~12% opacity. MEDIUM.**
`BottomNav.jsx:6` stacks two dimming sources on one element: `color: var(--cream-mute)` (post-reconciliation `index.css:17` = `rgba(240,234,216,0.34)`) **and** `opacity: 0.45`. Effective label opacity = `0.34 × 0.45 ≈ 0.153` — about 4.3× fainter than a normal inactive tab (`--cream-dim` = 0.66, `BottomNav.jsx:17`). (Pre-`5fa1e9a` these were 0.28/0.126/4.8×/0.60; the double-dim conclusion is unchanged.) On Trips Home, `<BottomNav />` mounts with no props → `inTrip = false` → Plan/Logistics/Map all disabled (`:43-45`), so the page shows one legible tab beside three ghost labels that read as broken. Owner decision: **omit** them entirely rather than restyle (D9).

**F6 — No empty state. MEDIUM.**
`TripsHomePage.jsx:127-147` maps over the groups; when all three are empty it renders nothing, leaving only the header and a lone New Trip button. A first-run user (or one whose only trip just ended) sees a half-rendered page. (D11)

**F7 — The primary action is the hardest thing to reach. LOW-MEDIUM.**
`TripsHomePage.jsx:149-156` places New Trip after every section, so on an account with several trips it lives below the fold. (D11)

**F8 — Past trips render identically to upcoming. MEDIUM.**
`TripCard.jsx` branches only on `trip.status === 'active'` (`:27,39-41,46`); `past` and `upcoming` share the same else-path — same brightness, size, photo, full-`--cream` title. Nothing subordinates a completed trip beyond the section heading. Falls out for free once the cover is a route (D7): past desaturates the route to muted cream and dims the card.

**F9 — The list response discards recoverable per-destination geography. This is the enabling gap for the whole redesign.**
`GET /api/trips` → `listTripsForUser` (`services/trips.js:762-783`) computes ordered destinations per trip via `mergeDestinationsWithScopes` (`:662-684`), which **receives** scope `boundsJson` (a `{low,high}` lat/lng box, `:173`) and day-derived pairs but **returns only** `{ destinations: [names], destinationCountries: [codes] }` (`:680-683`). `mapTrip` (`:27-44`) then carries no coordinate. The geography exists and is already loaded in that function — it is thrown away one line before the client could use it. (D2)

---

## Binding decisions

**D1. The trip cover is a route diagram, not a photo.** Replace the hardcoded Unsplash image in `TripCard.jsx` with an inline-SVG route rendered in the production palette: a faint atlas graticule, one gold route line, city nodes with DM Mono labels. No map tiles, no raster, no external request, no API cost. Photography stays reserved for place/experience cards (discovery, stops) per the design spec — trip index cards are typographic/cartographic. Mockup is the reference.

**D2. Expose per-destination geography additively on the list response.** `GET /api/trips` gains, per trip, `destinationsGeo: [{ name, countryCode, lat, lng, coordinateSystem }]`, ordered to match `destinations`. Coordinate source, in priority order: (a) centroid of the scope's `bounds_json` when present; (b) a representative day/stop coordinate for a day-derived city; (c) `null` when neither exists. `lat/lng` may be `null` for any node — the frontend must handle it (D5). Preserve `coordinateSystem` provenance (GCJ-02 vs WGS-84) and pass display coordinates through the existing coordinate utilities — the route is schematic, but a mainland-China centroid must not be silently mixed with a WGS-84 one. **Verify the day/stop fallback path against live code in W1** — scope-bounds centroid is confirmed available; the day-derived coordinate source (`listDaysForTrip` :1024, `resolvedCity` :1062) must be traced before relying on it, and if a day carries no usable coordinate, (c) `null` is the honest answer.

**D3. Render a schematic, not a literal projection.** Take the real relative arrangement of the nodes (so compass sense and shape are recognizable — Okinawa reads NE of Taipei) and **normalize/fit** it into the card's right-hand region with generous padding and a minimum node separation, then run a label de-collision pass. This preserves geographic truth while guaranteeing the airy spacing the mockup gets from hand-placed points; it prevents a tight 3-city cluster (Shanghai·Suzhou·Hangzhou) from rendering cramped. The route occupies the light side of the existing `100deg` overlay gradient; text stays on the dense left.

**D4. Air vs ground is inferred from country clustering.** Group ordered nodes by `countryCode`; a hop *between* two country clusters draws as a dashed lofted arc (air), a hop *within* a cluster draws as a solid ground curve. Derived entirely frontend from `destinationsGeo[].countryCode` — no backend flag. This is a heuristic, not a claim about the actual transport mode; it is the honest, data-available signal and it reads correctly for the common cases.

**D5. Degrade gracefully; never render a broken map.** `≥2` located nodes → route. Exactly `1` located node → a single node with its label (no line). `0` located nodes (brand-new trip, no scopes, no resolved days) → a **typographic cover**: title + gold hairline + the DM Mono route-label text, no SVG. The typographic fallback is the same treatment the mockup's Typographic toggle shows, so it is a designed state, not an error state.

**D6. Status pill → bare status line.** No bordered pill anywhere. Active: `● Active now` (gold pulse dot + cream text; pulse respects `prefers-reduced-motion`). Upcoming: a humane countdown — `Tomorrow` → `In N days` (<14) → `In N weeks` (<8wk) → `In N months`, recomputed each render from `trip.startDate` via the existing local-date helpers (no new data; `startDate` is already on the list response). Past: **nothing** — the dim card under the Past header carries it. Owner-approved, including the humane scale and the silent past.

**D7. Past subordination is cartographic.** A past card dims the whole card and renders its route in muted cream (loses gold) — it fades off the map. No grayscale photo hacks needed because there is no photo. This is the one visual language carrying both "which trip" and "how alive."

**D8. Inline section counts, matching Logistics.** `ACTIVE · 1` inline in `--cream-dim`, not pushed to the page edge. Drop the `justify-between` header row.

**D9. Omit trip-scoped tabs on Trips Home.** When `!inTrip`, `BottomNav` renders only the Trips slot — Plan/Logistics/Map are not rendered at all (not rendered-and-disabled). Inside a trip, behaviour is unchanged. This deletes the disabled `NavItem` code path's *use* on Home; keep the disabled branch only if another caller needs it (grep first — if nothing else disables a tab, remove the dead branch per the no-dead-code rule).

**D10. Fix the card collapse structurally.** The content layer fills the card (e.g. `grid-template-rows: auto 1fr auto` on an inset-filling copy layer, per the baseline mockup), so the title anchors to the bottom and the status line floats top. No manual spacing patches.

**D11. Promote the CTA and add an empty state.** New Trip moves into the header row (reachable regardless of scroll). A first-run/all-empty state renders a designed block ("No journeys yet — where does it begin?") with a centered New Trip CTA, in the product voice.

**D12. Out of scope.** No user-uploaded/selected cover photos (a plausible future, explicitly deferred — the route cover removes its urgency). No static-map tiles or map provider calls. No new fonts or palette tokens. No migration. No change to trip status semantics, routing, or the Today-mode handoff. `destinationsGeo` is read-only derived output; it is not persisted.

---

## Verified code map

**Frontend — the files this plan changes**
- `frontend/src/pages/TripsHomePage.jsx` — `groupTrips` `:15-21`; section render loop `:127-147`; count via `justify-between` `:130-136`; New Trip button `:149-156`; `<BottomNav />` (no props) `:159`; no empty-state branch. W3 owns this file.
- `frontend/src/components/trips/TripCard.jsx` — hardcoded photo `:20`; `Link` + `tripIsLive` routing `:23-24`; collapse bug `:31-34`; status branch `:36-50`; destinations `:54-55`; title `:57`; dates `:60-61`. W2 replaces the cover here; W3 adjusts status line + subordination.
- `frontend/src/components/nav/BottomNav.jsx` — disabled `NavItem` (double-dim) `:4-11`; enabled inactive `--cream-dim` `:17`; render `:30-49`; disabled trip tabs `:43-45`. W3.
- **New:** `frontend/src/components/trips/TripRouteCover.jsx` — the SVG route renderer (W2). One primary export; lives under the trips domain folder per file conventions.

**Frontend — reference, not changed by logic**
- `frontend/src/utils/tripStatus.js:6-10` — `tripIsLive` (pure local-date compare). Countdown (D6) uses the same `localIso`/date helpers in `utils/date.js`; do not couple countdown to the server `status`.
- `frontend/src/index.css` — tokens (reconciled values as of `5fa1e9a`): `--cream-dim` 0.66, `--cream-mute` 0.34, `--ink-border` rgba(240,234,216,0.09), `--gold` #c9a84c, `--gold-soft` 0.10, `--gold-line` 0.34; W2 also added `--ink-border-strong`, `--ink-satin`, `--shadow-deep`, `--radius-l`. `.trip-card-overlay` `100deg` gradient still exists (used by `StopCard`, no longer by `TripCard`). Line numbers shifted since this plan was written (W1/W2/tokens edits) — read the file, don't trust `:NN` anchors here. Reuse tokens via `var()`; never bake literals.
- `frontend/src/pages/LogisticsTab.jsx:274-277` — the `LABEL · N` inline-count pattern to match (D8).
- `frontend/src/services/tripsApi.js:4` — `list(today)` → `/api/trips?today=…`. No client change needed beyond reading the new field.

**Backend — the files W1 changes**
- `backend/src/services/trips.js` — `mapTrip` `:27-44` (add `destinationsGeo`); `mergeDestinationsWithScopes` `:662-684` (currently drops geography — extend or add a sibling that also returns coordinates); `listTripsForUser` `:762-783` (already loads scopes + days per trip, so the geography is in scope here); scope `boundsJson` presence `:173`; `deriveTripDestinationPairsFromDays` `:499`; `listDaysForTrip` `:1024`, day `resolvedCity` `:1062`. Coordinate-system/utility helpers are imported at `:6` (`geoIdentity.js`) — confirm which util does bounds→centroid and GCJ handling before writing.
- `backend/src/routes/trips.js:12-19` — `GET '/'` handler; no change needed (it returns whatever `listTripsForUser` maps).

**Tests**
- Backend: extend the `listTripsForUser` / trip-mapping tests to assert `destinationsGeo` shape, ordering parity with `destinations`, and `null` coordinates for un-bounded/un-resolved nodes.
- Frontend: `TripRouteCover` unit tests for the three degradation branches (0/1/≥2 nodes) and air-vs-ground selection; a `TripCard` test that a past trip renders muted; a countdown-scale test (`Tomorrow`/days/weeks/months boundaries). Verify existing `TripsHomePage`/`TripCard` tests (if any) still pass; grep before assuming their shape.

**Gotchas carried from prior plans**
- Dev servers via `.claude/launch.json` (frontend :5174, backend :3002); start them yourself, usually not running. Backend runs `NODE_ENV=test` → `AUTH_RATE_LIMIT` 5/15min; on "Too many requests", bump `backend/src/index.js` mtime to restart `node --watch` and reset the limiter [plan20-w4-complete].
- Browser QA uses the **Claude in Chrome extension** against an already-logged-in `localhost:5174` tab, not the in-app Browser pane (cookie-mint 401s; `document.hidden` freezes framer at frame 0) [trippy-browser-qa-use-chrome-extension].
- Chrome on Windows floors window width at ~500px; verify 375px by clamping `#root` to 375px and measuring `scrollWidth - clientWidth` for overflow [plan21-trip-context-channels-written].
- The in-app Browser pane renders `file://` mockups as **static snapshots** — toggles won't fire; force state via `javascript_tool` when screenshotting the mockup.
- Prod: container `trippy-trippy-1`, port 6768; owner runs prod browser passes [trippy-production-server-facts], [owner-runs-production-browser-passes].

---

## Wave 1 — Backend: expose `destinationsGeo`

**Status:** COMPLETE 2026-07-22 (Opus orchestrator + Sonnet coder). `GET /api/trips` now carries per-trip `destinationsGeo: [{ name, countryCode, lat, lng, coordinateSystem }]`, ordered identically to `destinations`. All backend-only, additive, no migration. Verified: `cd backend; npm test` (674 pass; the sole failure, `geographyBackfill.test.js` real-DB-snapshot gcj02 count 7≠9, is **pre-existing on clean `main`** — confirmed by stash — a stale fixture, not this change) + an independent live-sample against a temp DB (real migrations + real `listTripsForUser`) confirming: antimeridian-box centroid math, coordinate ladder priority a>b (bounded scope beats its own day's stop), free-text scope falling to a stop coord, `gcj02` provenance carried un-converted, and ordering parity.

**Deviations from the design notes (all minor, all improvements):**
- Ordering parity is made *structural*, not just tested: both `mergeDestinationsWithScopes` and the new `buildDestinationsGeo` fold over one shared internal `mergeDestinationPairs(storedScopes, dayDerivedPairs)` ordered list — they cannot drift by construction.
- **Traced the D2(b) fallback (as W1 instructed):** days carry **no** coordinate (`resolvedCity` is a name only). The representative coordinate therefore comes from **stops** (which do carry `lat/lng/coordinate_system`), matched to a destination by the day's canonical resolved-city key. One added stops query per trip in `listTripsForUser` (mirrors `mapData.js`'s JOIN pattern; consistent with the existing per-trip `bookings`/`days` loads). Stops with non-finite coords or `coordinate_system` `'unknown'`/`null` are skipped (an unknown-system point is not render-trustworthy per `coordinates.js`'s own `toDisplayCoordinates` rule) → node resolves to `null` (D5, honest).
- New exported helpers in `backend/src/services/trips.js`: `boundsCentroid(boundsJson)` (reuses `parseScopeBounds` hygiene; handles antimeridian wrap) and `buildDestinationsGeo(storedScopes, dayDerivedPairs, stopCoordByCityKey)`. `mapTrip` gained a defaulted 5th param `destinationsGeo = []`; the single-trip by-id path is unchanged (gets `[]`, doesn't need the field).
- Scope-bounds centroids are stamped `coordinateSystem: 'wgs84'` (Google Places viewports are WGS-84); no coordinate conversion is performed anywhere in W1 — the route is schematic and W2 owns any normalization.

**Follow-up (resolved in a parallel session, folded in here):** `geographyBackfill.test.js` was red on `main` — its "pin relabel safety net" froze a dev-DB snapshot count (7 gcj02 stops on one titled trip), which legitimately grew when a second CN trip ("Shanghai - Hangzhou (W3 verify)") was added. Root-caused and fixed by replacing the frozen count/title assertion with the durable invariant the migration safety net actually protects: **every gcj02 stop stays confined to a China-derived trip** (`destinationCountries.includes('CN')`), which survives legitimate CN-content growth. `geographyBackfill.test.js` now 6/6 green; full backend suite is clean.

1. Add a coordinate resolver used by `listTripsForUser`: for each ordered destination, resolve a coordinate from (a) scope `bounds_json` centroid, (b) a day/stop coordinate fallback, (c) `null`. Preserve `coordinateSystem`. **First trace the day/stop fallback** (`listDaysForTrip`/stop coords) and confirm whether a day exposes a usable coordinate; if not, (c) `null` stands and the frontend degrades per D5. Do not invent a coordinate from a trip title or the first destination (spec rule).
2. Extend `mergeDestinationsWithScopes` (or add `mergeDestinationsGeoWithScopes` beside it to avoid disturbing the four existing callers of the current function — grep them first) so the assembled per-destination objects carry `{ name, countryCode, lat, lng, coordinateSystem }`.
3. `mapTrip:27-44` gains `destinationsGeo`, ordered identically to `destinations`.
4. Tests + **live sampling**: hit `GET /api/trips` for a real disposable trip (one scope-bounded city, one day-derived city, one un-resolved) and confirm each node's coordinate is present/null as expected and ordering matches `destinations`. Per CLAUDE.md, sample the actual response — do not trust a green unit test that mocks the DB.

**W1 verification.** `cd backend; npm test` + sample the live endpoint as above. No frontend change ships in W1; the field is inert until W2 reads it.

---

## Wave 2 — Route cover component

**Status:** COMPLETE 2026-07-22 (Opus orchestrator + design QA, Sonnet coder). New `frontend/src/components/trips/TripRouteCover.jsx` (inline-SVG route: unified-coordinate projection, per-segment air/ground, faint graticule + centroid glow, DM Mono de-collided labels, 0/1/≥2 degradation, `muted` past) swapped into `TripCard.jsx` (photo removed; card-shell collapse fixed structurally with an `auto 1fr auto` grid; status zone reserved empty for W3). 4 files: `TripRouteCover.jsx` (new), `TripRouteCover.test.jsx` (new, 7 tests), `TripCard.jsx`, `index.css` (+2 additive tokens). Verified: `cd frontend; npm test` (198 pass, incl. 7 new) + `npm run build` clean + **Opus browser QA of all five shapes at 375px AND desktop** via a throwaway Vite harness (real component, controlled fixtures) — screenshots eyeballed against the mockup; zero page-level horizontal overflow at 375px (scrollWidth === clientWidth).

**Design-QA findings fixed during the wave (each caught by eyeballing, not by tests):**
- **Token scope (owner steer):** owner approved using the revamped design system's tokens (`docs/superpowers/mockups/trippy-revamped-system.css`), but the running app only loads `index.css`. W2 added **only** the four new tokens it consumes — `--ink-border-strong`, `--ink-satin`, `--shadow-deep`, `--radius-l` — additively, and did **not** flip shared token values (that was deferred to a focused session). Dropped `--ink-raised` (unused this wave). **The deferred reconciliation has since shipped as `5fa1e9a`** (flipped the five shared alphas — `--cream-dim` 0.60→0.66, `--cream-mute` 0.28→0.34, `--ink-border` white→cream 0.09, `--gold-soft` 0.12→0.10, `--gold-line` 0.28→0.34 — repointed hardcoded old-literal token-trackers to `var()`, and rewrote CLAUDE.md's palette to make `index.css` the single source of truth). **W3/W4 build on this reconciled palette;** the token values cited elsewhere in this plan were written pre-flip — trust `index.css` (and the values in this bullet), not older citations.
- **Zero-geo fallback z-order:** the typographic fallback originally rendered inside `TripRouteCover` **beneath** the legibility overlay → washed out invisible. Moved the designed cue (gold hairline) into `TripCard`'s copy layer **above** the overlay; `TripRouteCover` returns `null` for 0 nodes and exports `hasLocatedGeo` so the card owns the fallback. (Satisfies D5 / invariant 1.)
- **Projection region → top hero-band:** the initial full-height region (`y[52..252]`) dropped southern nodes onto the bottom-anchored title (label/title collision on every N-S trip). Confined the route to a top-right band (`y[36..146]`, `x[250..500]`) that clears the title at **both** 264px (desktop) and 236px (mobile) card heights — mobile is the binding constraint.
- **Inward labels + global de-collision:** eastern labels clipped the card's right edge at 375px (mobile `slice` crops the viewBox to ~`x[96..503]`); fixed by anchoring labels **inward** from the region centre. That surfaced a second bug — inward labels on same-latitude cluster nodes (Shanghai/Suzhou) point toward each other and overlap **across** anchor sides, which the original per-side de-collision missed. Replaced with a **global** vertical de-collision (estimate each label's monospace x-extent, sort by y, push down on any x-overlap within one line-height).

**Coordinate-frame handling (invariant 6):** if any node is `gcj02`, all `wgs84`/null nodes are pushed through `wgs84ToGcj02` (no-op outside China) so the whole set shares one frame before projecting — uses the only transform available (forward; no inverse needed at schematic scale). Scope-bounds centroids are already `wgs84` from W1.

Build `TripRouteCover.jsx` and swap it into `TripCard`. The mockup is the pixel reference; match its restraint.

1. **Projection/fit (D3):** normalize `destinationsGeo` nodes with `lat/lng` into the card's right-region viewBox with padding and a minimum node separation; if all nodes coincide or only one is located, fall to the D5 single-node/typographic branches.
2. **Route (D4):** cluster by `countryCode`; solid curve within a cluster, dashed lofted arc between clusters. One gold accent (route + nodes); past renders muted cream.
3. **Graticule + glow:** faint curved meridians (~0.05 cream) and a soft centroid glow, exactly as the mockup — texture, not decoration.
4. **Labels:** DM Mono, cream-dim, de-collided; anchor left/right by node x so labels never overlap the route or each other.
5. **Degradation (D5):** 0 → typographic cover, 1 → single node, ≥2 → route. Unit-test all three.
6. **Card shell (D10):** fix the collapse — content layer fills the card, title anchors bottom, status line floats top.
7. Remove the hardcoded photo, overlay `img`, and unused photo styling from `TripCard`.

**W2 verification.** `cd frontend; npm test` + `npm run build`. Browser (Chrome extension, logged-in `localhost:5174`): render a 2-city ground trip, a 3-city cluster, a multi-country air trip, a past trip (muted), and a zero-geo trip (typographic fallback). Confirm no label overlap, no horizontal overflow, and the route reads as elegant — not a broken map — at **both** 375px and desktop. Opus reviews each shape against the mockup; a Sonnet self-report does not close this wave.

---

## Wave 3 — Trips Home refit

**Status:** COMPLETE 2026-07-22 (Opus orchestrator + design QA, Sonnet coder). Trips Home refit shipped: bare status line (live pulse dot / humane countdown / silent past), card-level past dimming, inline `LABEL · N` counts, promoted header CTA, first-run empty state, and single-slot nav on Home. 7 files: `utils/date.js` (+`formatCountdown`), `utils/date.test.js` (+8 boundary tests), `TripCard.jsx` (status zone + `opacity:0.72` past dim), `TripCard.test.jsx` (new, 3 tests), `index.css` (+`.trip-live-dot` + reduced-motion override), `TripsHomePage.jsx` (D8 inline counts + D11 CTA/empty state), `BottomNav.jsx` (D9 disabled branch removed). Not deployed (single deploy held for W4).

**Verified: `cd frontend; npm test` (209 pass, incl. 11 new) + `npm run build` clean + Opus browser QA at 375px AND desktop** via a throwaway Vite harness that intercepted `fetch` to render the REAL `TripsHomePage` (wrapped in `MemoryRouter` + real `AuthProvider`) across every state deterministically. Confirmed live: nav renders only `Trips`; counts inline `active · 1 / upcoming · 4 / past · 1`; countdown scale exact — `Tomorrow` (+1d), `In 5 days` (+5d), `In 3 weeks` (+21d), `In 3 months` (+90d); past card `opacity` 0.72 with muted (no-gold) route; active card gold pulse dot + `Active now`; zero-geo card shows the gold-hairline typographic fallback + countdown; empty state renders `No journeys yet / Where does it begin?` with centered CTA; **page-level `scrollWidth === clientWidth` (zero horizontal overflow) at 375px**. Harness + screenshots deleted; `.playwright-mcp/` restored (no churn committed).

**Decisions honored / notes:**
- **D9 dead-code removal confirmed by grep:** the disabled `NavItem` branch had exactly one consumer (Home's `!inTrip` Plan/Logistics/Map slots) — every other `disabled=` in the tree is on a `<button>`. In-trip tabs are always enabled, so the branch was provably dead once Home renders only Trips; it was deleted, not restyled.
- **Countdown derives from `startDate` only** (invariant 5) via the new `formatCountdown(startDate, now)` in `utils/date.js`, reusing `localIso`; parses both dates as local-midnight (never UTC). Scale: `Tomorrow` → `In N days` (<14) → `In N weeks` (<56d) → `In N months`. Returns `''` for non-positive diffs (defensive; only called for upcoming trips).
- **Live dot** reuses the existing `trippyPulse` keyframe via a `.trip-live-dot` class; a matching `animation:none` entry was added to the existing `prefers-reduced-motion` block. Dot is the only added gold; text is cream — invariant 2 holds.
- No new tokens added (D12); `--ink-raised`/`--radius-s`/`--radius-m` remain unconsumed — no dead tokens introduced.

**Empty-state refinement (owner review, same day).** Owner flagged the first pass as awkward: two `+ New Trip` CTAs (header + centered block) and a centered block whose rhythm read as disconnected from the left-aligned header hero. Also surfaced a real bug — the empty state fired on `trips.length === 0`, which is *also* true after a failed fetch, so a `GET /api/trips` 500 rendered "No journeys yet" instead of the error. Resolved:
- New `frontend/src/components/trips/EmptyTripsState.jsx` — the empty space is now drawn in Trippy's cartographic language: a faint atlas graticule panel with the trip's life as a gold itinerary-rail (Bookings → Itinerary → On the ground) terminating in the single New Trip CTA as its destination. Left-aligned, coherent with the header. Owner-approved copy: eyebrow `No route yet`, statement headline `Your first line on the map.` (deliberately a *statement* so it doesn't stack a second question under the `Where next?` masthead).
- The header CTA is suppressed when empty (EmptyTripsState owns the sole CTA); it still renders when trips exist or when the load errored (so a failed load can still start a trip).
- **Bug fix:** empty state now gated on `isEmpty = !error && trips.length === 0` — a failed load surfaces its error, never the empty state. Browser-verified via the harness `?error=1` path (500 → error shown, empty state absent, header CTA present).
- Verified: `npm test` (209 pass) + `npm run build` clean + Opus browser QA of the new empty + error states at 375px and desktop; single CTA, zero horizontal overflow.

1. **Status line (D6):** active `● Active now` + reduced-motion-safe pulse; upcoming humane countdown from `startDate`; past silent. Bare DM Mono, no bordered pill. Add the countdown helper (with boundary tests) in `utils/date.js` or a small local util — grep for an existing countdown/relative-date helper first.
2. **Past subordination (D7):** dim card + muted route (the route muting lives in W2's component via a `status`/`muted` prop; W3 wires it).
3. **Inline counts (D8):** `LABEL · N`, matching `LogisticsTab.jsx:274-277`; drop `justify-between`.
4. **Nav omission (D9):** `BottomNav` renders only Trips when `!inTrip`; grep for any other disabled-tab caller before deleting the disabled branch.
5. **CTA + empty state (D11):** promote New Trip to the header row; add the designed empty state for the all-empty case.

**W3 verification.** `npm test` + `npm run build`. Browser at 375px and desktop: counts inline; only the Trips tab on Home; countdown shows sane values (`Tomorrow`/`In N days`/weeks/months across trips with different start offsets); past card visibly subordinated; empty state renders (temporarily filter all trips out, or point at a fresh account). Confirm zero page-level horizontal overflow at 375px via the clamp-and-measure method.

---

## Wave 4 — QA, convention capture, deploy

**Status:** COMPLETE 2026-07-22 (Opus orchestrator, no coder). Full bar green: `backend` 675 pass / `frontend` 209 pass / `npm run build` clean (the backend teardown segfault is a post-report better-sqlite3 exit quirk on Windows, not a test failure). Convention captured in `CLAUDE.md` › Current Architecture › Frontend (merged *alongside* the `5fa1e9a` palette edits, not over them). Browser QA (Claude-in-Chrome, logged-in `localhost:5174`) confirmed all 8 cross-wave invariants live at 375px + desktop and against real data — see verification below. Deploy + owner prod QA is the final gate.

**W4 verification (live, not self-reported):**
- **Full bar:** backend 675 pass (31 suites; the prior `geographyBackfill` red is fixed and green), frontend 209 pass (33 suites), build clean.
- **`destinationsGeo` sampled from the live endpoint** (`GET /api/trips`, 5 real trips): ordering parity with `destinations` holds; `null` coordinates present and handled (Denpasar, Taipei both `null,null/null`); GCJ-02 provenance carried un-converted (Chengdu `gcj02` beside a `wgs84` node) — invariants 3 & 6.
- **375px:** `#root` clamped to 375px → `scrollWidth === clientWidth === 375` (zero horizontal overflow); 5 inline-SVG covers, **zero `<img>` tiles** in cards — invariant 4.
- **All three status/degradation states eyeballed:** active card = single gold node (Taipei `null` → D5 single-node branch) + `● Active now`; upcoming (Shanghai–Hangzhou) = full-gold 2-node ground route + `In 4 days` humane countdown; past (Ipoh–KL) = dimmed card + muted (no-gold) route + silent status — invariants 1, 2, 5, 7 (no migration).
- **In-trip unaffected (invariant 8):** clicking a card lands in `/trips/:id/plan` with the full four-slot nav (Trips · Plan · Logistics · Map, all enabled) restored; Trips Home shows only the Trips slot.

1. Full bar: `backend` + `frontend` tests green, `npm run build` clean, 375px regression pass on Trips Home (and a spot-check that in-trip tabs/routing are unaffected).
2. Capture the convention in `CLAUDE.md` → Current Architecture › Frontend: **trip covers are route diagrams (no photo), rendered from `destinationsGeo`; status is a bare line (live pulse / countdown / silent past), never a pill; past subordinates cartographically; Trips Home shows only the Trips nav slot.** Note `destinationsGeo` as additive derived output on `GET /api/trips`. **MERGE, do not clobber:** the token-reconciliation session (`5fa1e9a`) already rewrote CLAUDE.md's Design & Aesthetic Rules / palette section (index.css = single token source of truth; trippy-revamped-system.css = design input). Add the route-cover conventions *alongside* those palette edits — do not overwrite them. (Recorded in memory.)
3. Deploy once via `/deploy` (git pull + Docker rebuild, container `trippy-trippy-1`, port 6768; **no migration**). Owner runs the phone-width click-script; close the plan only after owner prod QA passes.

---

## Cross-wave invariants (assert in review + tests every wave)

1. No trip cover ever renders a broken or empty map — 0/1/≥2 nodes each have a designed state (D5).
2. The route is the single gold accent per card; past loses gold entirely (D7). No second gold fill sneaks in via the status line (only the live dot is gold).
3. `destinationsGeo` ordering always matches `destinations`; a `null` coordinate is a valid, handled value, never a render error (D2/D5).
4. No map tiles, no raster image, no external request, no new API cost on Trips Home.
5. Countdown derives from local date + `startDate`, never from the server `status` field (keeps parity with `tripIsLive`).
6. Coordinate-system provenance is preserved end to end; a GCJ-02 centroid is not silently mixed with WGS-84 (spec rule).
7. No migration, no schema change; the only backend delta is the additive `destinationsGeo` field.
8. In-trip behaviour (Today/Plan/Logistics/Map routing, the live-trip nav swap) is unchanged — this plan touches only the outside-a-trip surface plus the shared `TripCard`/`BottomNav`.

## Deployment

One deploy after W4 via `/deploy`. No migration step. The waves are interdependent (W2 needs W1's field; W3 sits on W2's card), so ship them together — deploying W1 alone would add an unused field, and W2 without W3 would leave the status pills and disabled nav in place. Hold the single deploy until W3 is browser-verified.
