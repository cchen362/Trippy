# Implementation Plan 23 — Trips Home Route-Node Geography Correctness (+ bundle-split follow-up)

**Status:** OPEN 2026-07-22 — **Track A COMPLETE (deployed + owner prod QA passed, `c53ad82`); Track C COMPLETE (deployed `d13a33a`); Track B W1–W4 COMPLETE + DEPLOYED 2026-07-24 (`be69f97`, container `trippy-trippy-1` :6768, no migration) — infra-verified, owner PWA QA pending.** Plan stays open only for the two owner-owed post-deploy PWA checks (installed-PWA offline cold start; cross-deploy upgrade race). All Track B implementation + local QA is done: route split (`ba5d719`) + vendor `manualChunks` split (W4 Gate 1) shipped; co-pilot split (W4 Gate 2) measured and skipped; W3 offline/precache/upgrade-race/mobile runtime QA passed against the production build. Deploy infra-verified: startup clean (`:3001 [production]`), health `{status:ok, db:connected}`, prod `sw.js` precaches `vendor-react`/`vendor-motion`/`MapTab`/all route chunks (33 entries), prod serves the new 4.16 kB-gzip `index-BbJ0678k.js` entry; pre-deploy backup `~/Trippy/backups/trippy.pre-trackb.20260724-002507.db` (6.3M). See the Track B status + [W4 measurement doc](../reviews/2026-07-24-plan-23-track-b-w4-measurement.md). Surfaced during Plan 22 W4/owner prod QA: some route-cover **nodes sit in the wrong place**. **Investigation update 2026-07-22 (root cause CONFIRMED — see Track A):** this is a **legacy-data artifact, not a live bug.** Trips created before the current scope picker captured a `bounds_json` viewport per destination have scopes with `bounds_json = NULL`; those nodes fall to a transit-stop coordinate fallback that can be poisoned. A trip created today (both destinations as bounds-carrying scopes) renders correctly. The live pipeline is healthy. This downgrades Track A from "bug fix" to "optional legacy hardening/cleanup." **Owner approved D-A1(b) 2026-07-22 — DEPLOYED standalone at `c53ad82` (see Track A status).** Track B is independent, low-risk build hygiene, not started — to be built and deployed on its own (opposite risk profile; no reason to batch).

**Origin:** Plan 22 made per-destination geography visible for the first time (`destinationsGeo` → route cover). That visibility exposed two pre-existing data problems that were previously invisible. **Plan 22's render is correct; the underlying stored/derived coordinates are not.** Nothing here is a Plan 22 regression — Plan 22 is CLOSED and stays closed.

**Schema impact: NONE expected** (this is a derivation/data-hygiene fix, not a model change). Confirm during investigation; if a fix genuinely needs persistence, that becomes a new decision, not an assumption.

---

## Track A — Route nodes render at geographically wrong coordinates (PRIMARY)

**Status: D-A1(b) COMPLETE 2026-07-22 (owner-approved + owner prod QA passed).** Shipped standalone at `c53ad82` (container `trippy-trippy-1`, `:6768`, no migration; transit filter confirmed live in the running container at `trips.js:858`). Deployed independently of Track B by design (see status line). Owner verified corrected legacy covers in prod. **Track A closed; residual Singapore day-label quirk explicitly not pursued.** `buildDestinationsGeo`'s coordinate source now excludes `type='transit'` stops (flights/trains) — one `continue` added to the `stopCoordByCityKey` loop in `listTripsForUser` ([trips.js](../../../backend/src/services/trips.js), lines ~849-861), plus a regression test in `backend/tests/trips.test.js` (the transit stop sorts first but the real place stop wins; a transit-only day → `null`). Backend 676 pass. **Verified against the live endpoint** (dev DB, real legacy trips): old Chengdu–Chongqing now resolves **Chongqing `29.57,106.57`** (from `Regent Chongqing`, was the `G8613` train's Chengdu-end pin `30.71,104.15`) and **Chengdu `30.58,104.07`** (from Waldorf Astoria, was the `SQ 842` *flight* `30.30,104.45`) — both nodes corrected; cover renders Chongqing SE of Chengdu. **Scope boundary honored:** the change is a read-only filter in the cover's coordinate-borrowing step only; `listDaysForTrip`/day-header derivation is untouched (owner's hard constraint). **Known residual (out of scope, different mechanism):** the Ipoh trip's `Singapore` node improved from a near-Ipoh flight pin to a KL-area coordinate but is still not Singapore — that day is *labeled* Singapore while carrying KL stops (a legacy day-labeling quirk, not transit poisoning); option (b) correctly stopped using the flight pin. Not worth chasing on one legacy trip.

### Evidence (sampled from the live dev DB 2026-07-22, `backend/data/trippy.db`)

`GET /api/trips` `destinationsGeo` returned these wrong nodes:

| Trip | Node | Returned coord | Should be ~ | Actually is |
| --- | --- | --- | --- | --- |
| Ipoh – Kuala Lumpur | **Singapore** | `4.55, 101.11` (wgs84) | `1.29, 103.85` | a point near **Ipoh, Malaysia** |
| Chengdu – Chongqing | **Chongqing** | `30.71, 104.15` (wgs84) | `29.56, 106.55` | a point in **Chengdu** |

### Root cause (CONFIRMED 2026-07-22 by old-vs-new trip comparison in the prod DB)

The trigger is **missing scope `bounds_json` on legacy trips**, not a derivation bug. Direct comparison of two Chengdu–Chongqing trips in prod:

| | Old (created **2026-04-29**) | New (created **2026-07-22**) |
| --- | --- | --- |
| Scopes | **only `Chengdu`**, `bounds_json = NULL` | **`Chengdu` + `Chongqing`, both `bounds_json = PRESENT`** |
| Chongqing node source | falls to day/stop fallback (priority b) | scope-bounds centroid (priority a) |
| Result | picks `G8613 …→ Chongqing North` (a train physically at the **Chengdu** end) → wrong | correct, renders SE of Chengdu |

So: **the current scope picker captures a Google-Places `bounds_json` viewport per selected destination.** When both destinations are bounds-carrying scopes, W1 priority (a) fires and the transit-stop fallback is never reached. The old trip predates that — it had a single `Chengdu` scope with `NULL` bounds (early scope-picker / migration-023 backfill from `destinations`, no viewport), so its `Chongqing` node had nothing but the poisoned fallback. **New trips are correct; the wrong nodes are stale legacy data.**

The fallback *is* poisonable (this is the secondary, still-true hardening target — it only ever bites a `NULL`-bounds node):
1. **Transit stops carry origin-end coordinates but destination-name titles** — `G8613 Chengdu East → Chongqing North` sits at the Chengdu end (`status=estimated`) yet its title names Chongqing.
2. **Flight/train codes geocode to arbitrary points** — `SQ 103` → near Ipoh (the bad **Singapore** node), `SQ 843` → Beijing, `SQ 842`/`TR 486`/`G3360` similar; all `wgs84` + `status=estimated`, so they pass W1's provenance-only guard (which skips only `coordinate_system` `unknown`/`null`).

### Binding decision — is any of this worth doing? (owner call; do NOT pre-decide)
Because new trips are already correct, Track A is now **optional**. Three independent, non-exclusive options:

- **D-A1(a) — Do nothing.** Accept that a handful of pre-July trips show an off node. Cheapest; the covers are schematic and the affected trips are mostly `past`. Zero code, zero risk.
- **D-A1(b) — Harden the fallback (defensive, no API cost).** In `buildDestinationsGeo`, exclude `type='transit'` stops (and possibly `status='estimated'` — but measure: legit place stops like `Petronas Twin Towers` are also `estimated` and *correct*, so `type=transit` is the cleaner discriminator) from the coordinate fallback; when nothing trustworthy remains, resolve the node to `null` (Plan 22 invariant 3 — never a wrong pin, just fewer pins). Helps legacy trips *and* any future `NULL`-bounds edge case. ~1 backend change + a fixture test.
- **D-A1(c) — Backfill `bounds_json` for legacy `NULL`-bounds scopes.** A one-off migration/script that re-resolves a viewport for old scopes (Google Places / geocoder — real API cost + a migration). Fully fixes legacy covers but is the heaviest option and probably out of proportion for a schematic index card.

Recommendation: **(b) alone** if the owner wants any hardening (it makes the pipeline robust regardless of bounds and costs nothing), otherwise **(a)**. **(c)** only if legacy covers matter enough to pay for geocoding.

### Track A definition of done — **only if the owner picks D-A1(b)** (skip entirely for (a))
1. Confirm the exact match path in `buildDestinationsGeo`/`stopCoordByCityKey` (day resolved-city key vs stop title vs country) and confirm `type='transit'` is the clean discriminator by counting good-vs-bad nodes across the prod trip set before choosing the filter.
2. Fix in `buildDestinationsGeo`'s coordinate fallback (root cause, no bandaid): a stop only contributes a destination coordinate when it is a real place (not a transit/flight/train code) **and** its resolution is trustworthy for a centroid; when nothing trustworthy remains, the node is `null`. Preserve W1's coordinate-system/provenance handling and the ordering-parity + `null`-is-valid invariants (Plan 22 invariants 3 & 6).
3. Backend test with a fixture reproducing both mechanisms (a transit stop titled for the destination but located at the origin; a flight-code stop). Assert the affected nodes resolve to `null`, and that legitimate place-derived nodes are unaffected.
4. Re-sample the live endpoint for the two known-bad legacy trips and confirm the nodes are corrected/nulled. Per CLAUDE.md, sample the actual response — no green-mock-only closure.
5. Browser: the Ipoh and old-Chengdu covers no longer draw a node in the wrong country/city. Batch with the next deploy unless shipped standalone.

---

## Track B — Frontend bundle is a single 754 kB chunk (SECONDARY, independent)

**Status: W1+W2+W3+W4 COMPLETE + DEPLOYED 2026-07-24 (`be69f97`, container `trippy-trippy-1` :6768, no migration; standalone deploy, infra-verified — owner PWA QA pending).** W1 baseline captured (see [W1 baseline doc](../reviews/2026-07-24-plan-23-track-b-w1-baseline.md)); W2 route-split boundary shipped at `ba5d719`; W3 (PWA/offline/upgrade runtime QA) + W4 (measure + two gate decisions) completed this session. **W4 measurement + gate decisions: see [W4 measurement doc](../reviews/2026-07-24-plan-23-track-b-w4-measurement.md).** Per-route foreground JS (delivered gzip) vs the single 225.14 kB baseline chunk: **`/share` 96.09 (−57%), `/trips` 110.61 (−51%), `/trips/:id/plan` 140.89 (−37%)**, and Leaflet's 51.35 kB gzip is entirely off the critical path until Map opens (verified on-demand). **W4 Gate 1 — vendor `manualChunks` split: IMPLEMENTED (owner-approved).** The post-route-split entry was ~99% stable vendor (`vendor-react` 53.77 + `vendor-motion` 39.10 = 92.87 kB gzip); splitting it out drops the app-shell entry to **4.16 kB gzip** and makes vendor cache-stable across app-only redeploys (and shrinks the SW upgrade re-fetch surface). **W4 Gate 2 — co-pilot panel split: SKIPPED (owner-approved).** Measured `chunk-copilot` = 9.03 kB gzip; the `useCopilot` history request fires on mount regardless and the panel opens on first FAB tap anyway, so deferring ~9 kB behind a spinner is pure maintenance cost. **W3 runtime QA (production build via `vite preview` + test backend, not the dev server):** precache manifest holds all 26 lazy chunks (Cache Storage confirms all 10 route chunks after SW activation, `routeChunksMissing: []`); `MapTab`/Leaflet absent from all three entry routes, loaded only on Map open; **chunk-load failure caught by `ChunkErrorBoundary` at both altitudes** (outlet-level preserves shell+nav with inline "Couldn't load / Reload"; app-level full-screen) — proven by simulated chunk pruning AND corroborated by the natural post-rebuild hash change recovering cleanly, never a dead screen; **Leaflet CSS stays global** (decided by observation — it's in the eager `index-*.css`, map paints correct on first frame, moving it would introduce the flash); mobile 375px tab switch keeps the same BottomNav node (`navPersistedSameNode: true`, no relayout). Frontend **219 tests pass** + `npm run build` green. Route-split code (W2): `React.lazy` + `Suspense` for the `App.jsx` route graph, two fallback altitudes (`LoadingScreen` top-level; shell-preserving `TabLoadingFallback` for the outlet), two-altitude `ChunkErrorBoundary` with honest `window.location.reload()` recovery, no retry framework; `useTripContext`/tab coupling left as-is. **Owner-owed post-deploy PWA checks (like Track C, cannot be verified locally): installed-PWA fully-offline cold start, and the cross-deploy upgrade race on the container.** Original validation: [2026-07-22 review](../reviews/2026-07-22-plan-23-track-b-frontend-bundle-splitting-review.md); 2026-07-24 re-review cut W2 to the route split only (co-pilot split → W4, now decided: skip). Ships on its own; do not batch with Track A (deployed) or Track C (deployed).

**What W3 (+W4) must still prove before this can deploy (nothing here was verified in W1/W2):**
- **PWA precache manifest:** every generated *lazy* JS/CSS asset (`ShareViewPage-*`, `TripsHomePage-*`, `TripPage-*`, `MapTab-*`, each tab chunk, shared chunks) is present in the built `dist/sw.js` Workbox manifest (fact 6 says the glob auto-captures them — confirm, don't assume).
- **Offline:** installed-PWA cold start works offline after a completed precache; direct-loading each route online works; offline deep-link refresh works.
- **Upgrade race (the real risk, fact 7):** a running prior build navigating to a previously-unopened lazy route across a new SW deploy (`autoUpdate` + `cleanupOutdatedCaches`) still reaches its chunk — or fails gracefully via the `ChunkErrorBoundary` reload path, never a dead screen.
- **Leaflet CSS decision:** confirm by observation whether Vite loads `leaflet.css` before the lazy map renders with no marker-layout flash; only then consider moving it into the map boundary (else it stays global — the current state).
- **Mobile 375px:** affected transitions, slow-load `TabLoadingFallback` appearance, and touch tab-nav show no shell flash/relayout.
- **W4 measurement:** re-run the build; record *actual* per-route request sets (now that routes differ) and compare **foreground initial-route transfer + parse/execute per entry route** against the W1 baseline doc (delivered/parsed bytes, not largest-chunk size, not warning presence). Then decide the two gates: co-pilot panel split (only if the measured TripPage-shell chunk shows the panel meaningful after framer-motion is excluded) and `manualChunks` (only if a concrete residual problem, e.g. a large shared vendor chunk re-downloaded on app-only releases).

**Evidence (reproduced 2026-07-23, identical to the review):** `cd frontend; npm run build` → single `index-*.js 753.94 kB │ gzip: 225.14 kB`, warns "Some chunks are larger than 500 kB". Same content hash as the review build (`index-C-FW6pVU.js`) — the tree has not changed. PWA precache `9 entries (5628.51 KiB)`, of which **4.95 MB is two eager login PNGs** (`illustration-login.png` 2,543,549 B + `mobile-vignette.png` 2,407,446 B), not JavaScript.

### Validated facts (do not re-derive)
1. **The graph is fully eager.** `main.jsx` → `App.jsx` (lines 5–13) statically import every page, including `/share/:token`. The public share route therefore ships the entire authenticated app; `/trips` ships every trip tab, Leaflet, and all modals. This is the whole reason there is one chunk.
2. **`manualChunks` alone does not reduce foreground startup.** With a static graph, splitting into more files leaves every file an immediate dependency. Only dynamic `import()` / `React.lazy` boundaries remove code from the initial route's fetch + parse + execute path. **Eliminating the 500 kB warning is not an objective.**
3. **Leaflet is the one clean heavy boundary.** `L` and `react-leaflet` are imported only by `components/map/TripMap.jsx` and `components/map/StopMarker.jsx`, reached only through `MapTab`. Its CSS is global in `main.jsx:3` and must be considered together with the JS (see W2).
4. **framer-motion is NOT deferrable.** It is imported by `LoadingScreen`, `TripsHomePage`, and `ShareViewPage` (eager critical-path surfaces). A vendor split of it saves zero foreground work — do not target it.
5. **Co-pilot UI and co-pilot data are separable — but the UI split is not free of cost/benefit questions.** `TripPage.jsx:42` calls `useCopilot(tripId)`, whose mount effect (`hooks/useCopilot.js:34–42`) fires the history request regardless of whether `CopilotPanel` is rendered. Deferring the panel component does **not** defer that request; changing the hook lifecycle is explicitly out of scope either way. However, `CopilotPanel.jsx` is ~21 KB of *source* and its heavy dependency (framer-motion) is eager elsewhere (fact 4), so the marginal chunk saved by lazy-loading the panel is unmeasured and plausibly small. **The co-pilot split is therefore a W4 decision gated on measurement, not a W2 requirement** (re-review 2026-07-24).
6. **Lazy chunks auto-precache.** Workbox glob `**/*.{js,css,html,ico,svg,woff2}` already captures every generated `assets/*.js`/`*.css`, so lazy chunks enter the precache manifest automatically. Correctness then depends on all of them being present and reachable offline and across SW upgrades.
7. **The upgrade/offline chunk race is real and newly introduced.** Today one chunk loads at startup, so no lazy fetch can 404 after a deploy. With `registerType: 'autoUpdate'` + `cleanupOutdatedCaches: true`, an already-open old client navigating to a not-yet-loaded lazy route after the new SW activates and prunes old caches can miss the old hashed chunk. A chunk-load-error boundary with recovery is mandatory, not optional.
8. **`React.lazy` caches a rejected import promise** — once a chunk load fails, re-rendering the same lazy component re-throws the cached rejection. A genuine in-place retry needs a re-created lazy wrapper or a cache-busting import. **Do not build that machinery.** The honest, smallest recovery is an error boundary offering a page reload (which re-runs the module graph against the new manifest). Only escalate beyond reload if W3 QA observes reload failing to recover.
9. **No route-graph tests exist today.** All 21 frontend test files exercise components/hooks (`TripMap`, `CopilotPanel`, `PlanTab`, …); nothing renders `App.jsx`'s route graph, fallback altitudes, or chunk-failure paths. W2 introduces exactly the behavior those missing tests would cover, so focused tests are part of W2's deliverable, not optional polish.

### Non-goals (explicit scope fence)
- **No `manualChunks` in the first pass.** Let Rollup derive shared chunks from the dynamic boundaries; add explicit vendor chunking only if the measured post-split graph shows a concrete remaining problem (W4 decides).
- **No login-image optimization.** The 4.95 MB PNGs dominate precache weight but are a separate concern; touching them is not JS startup work. Flag to owner as an adjacent follow-up only.
- **No co-pilot state/history lifecycle change** (see fact 5), and **no co-pilot UI split in W2** — it is a W4 decision made from measured chunk sizes.
- **No "every chunk < 500 kB" target.** The warning is not a requirement.
- **No retry/cache-busting framework for chunk failures** (see fact 8). Reload-based recovery unless W3 disproves it.
- **No "route loads only its own code" purism.** Shared chunks (React, router, common components, framer-motion) legitimately load everywhere. The invariant is: *unrelated route-exclusive modules are absent, and Leaflet is absent until Map is opened* — not that each route's request set is minimal.
- **No service-worker policy change** (`registerType`, glob, fallbacks stay as-is) unless W3 QA proves an upgrade race that only a policy change can fix — and that would be re-scoped as its own decision.

### Sequencing (bounded; each wave gated by the prior)
- **W1 — Baseline capture (representative, not exhaustive).** Record current raw/gzip initial JS, the cold-load JS/CSS request set for three representative entries — `/share/:token`, `/trips`, and one trip deep-link (e.g. `/trips/:id/plan`) — and the full Workbox precache manifest. Today the graph is fully eager, so every route's request set is identical (fact 1); per-tab before-measurements would record the same number five times. Full per-route measurement happens *after* the split (W4), where routes actually differ. No code.
- **W2 — Route-split boundary (the one mandatory architectural change).** Introduce `React.lazy` + `Suspense` for the route graph in `App.jsx`: lazy `ShareViewPage`, `LoginPage`/`SetupPage`, `TripsHomePage`, and the `TripPage` shell + its child tabs (`Today/Plan/Logistics/Map/Expenses`). This is one boundary decision (routes are lazy) even though it is several `import()` statements. It removes the authenticated app from `/share` and — because `MapTab` is a lazy child route whose subtree is the only importer of Leaflet (fact 3) — Leaflet leaving the initial path is an **expected outcome of this split, verified in acceptance**, not a separate boundary to engineer.
  - **Leaflet CSS:** `leaflet/dist/leaflet.css` is global in `main.jsx:3`. Move it into the map boundary **only if** observation shows Vite loads it before the lazy map renders with no marker-layout flash; otherwise leave it global (it is small) and split only the JS. Decide by observation, not assumption.
  - **Fallback altitude is a design requirement, not an afterthought:** top-level route loads may use the full `LoadingScreen`; nested trip-tab loads must preserve the trip shell/header/`BottomNav` and suspend only the outlet content (no whole-screen replacement, no nav movement — CLAUDE.md's no-uninitiated-motion rule).
  - **Chunk-failure recovery at exactly two altitudes** (fact 8): an application-level boundary around the top-level routes, and an outlet-level boundary inside `TripPage` that preserves the shell. Both show an honest failure message with a reload action, never a blank screen. No retry framework.
  - **Focused tests are part of this wave** (fact 9): route graph renders the right page per path, nested Suspense preserves the shell, and a simulated chunk-load rejection reaches the correct boundary. Component tests do not cover this.
- **W2 verification note:** Leaflet absence before Map, and share-route isolation, are *acceptance checks* on the built graph (Network panel + built chunk inspection), since Rollup — not hand-placed boundaries — decides the final chunking.
- **W3 — PWA / offline / upgrade QA (the real gate).** Prove, with observed behavior (not assumption):
  - Every generated lazy JS/CSS asset appears in the built Workbox precache manifest.
  - Installed-PWA cold start works offline after a complete precache; direct-loading each route online works; offline deep-link refresh works.
  - **Upgrade race:** a running prior build navigating to a previously unopened lazy route across a new SW deployment still reaches its chunk (or fails gracefully via the error boundary + reload, never a dead screen).
  - Mobile at 375px: affected transitions, slow-load fallback appearance, touch navigation between tabs shows no shell flash/relayout.
- **W4 — Measure, then decide the optional extras.** Re-run the build; record the *actual* per-route request sets (now that routes differ) and compare **foreground initial-route transfer + parse/execute per entry route** (not largest-chunk size, not warning presence) against W1. Then make two gated decisions, each justified with the numbers or closed as not-worth-it:
  - **Co-pilot panel split (decision gate):** lazy-load `CopilotPanel` in `TripPage` only if the measured `TripPage`-shell chunk shows the panel contributing meaningful weight after shared deps (framer-motion) are excluded. If the marginal chunk is small, skip — a lazy boundary that saves a few KB is pure maintenance cost. Hook lifecycle stays untouched either way (fact 5).
  - **`manualChunks` (decision gate):** only if the measured graph shows a concrete residual problem (e.g. a large shared vendor chunk re-downloaded on unrelated app-only releases). Otherwise close without it.

### Acceptance evidence (Track B cannot close without all of these)
| Area | Required proof | Status |
| --- | --- | --- |
| Baseline | W1 numbers recorded (raw/gzip initial JS, representative-route request sets, precache manifest). | ✅ [W1 doc](../reviews/2026-07-24-plan-23-track-b-w1-baseline.md) |
| Per-route delivery | Cold-load request sets show **no unrelated route-exclusive chunk** loads on `/share/:token`, `/trips`, or a trip deep-link. Shared chunks (React, router, common UI, framer-motion) are expected and allowed. | ✅ W4: `/share`,`/trips`,deep-link each load only own+shared chunks |
| Heavy boundary | Leaflet/react-leaflet are **not** fetched or executed before Map is opened (Network + no map-layout error on non-map routes). | ✅ `mapTabLoaded:false` on all 3 entry routes; loads on Map open, no flash |
| Co-pilot | Hook/history lifecycle demonstrably unchanged. If the W4 gate chose the panel split: panel loads on first open with no behavior change; if it didn't, record the measured numbers that closed the gate. | ✅ Gate 2 **skipped**; `chunk-copilot` = 9.03 kB gzip recorded; hook untouched, panel stays static-imported |
| Fallbacks | Nested tab loads preserve the trip shell; chunk-load failure at either altitude yields the honest reload-recovery state, not a blank screen. | ✅ Both altitudes proven (outlet preserves shell+nav; app full-screen) |
| Tests | Focused route-graph, fallback-altitude, and chunk-failure tests added and green (fact 9). | ✅ 219 tests pass (incl. `App.routes.test.jsx`, `TripPage.test.jsx`) |
| PWA manifest | Every required lazy JS/CSS asset present in the generated precache manifest. | ✅ All 26 lazy chunks + vendor in `dist/sw.js`; Cache Storage `routeChunksMissing:[]` |
| Offline | Installed-PWA start, route navigation, and deep-link refresh work after a completed precache. | ✅ Local: all 10 route chunks cached post-activation. ✅ **Owner post-deploy 2026-07-24: installed-PWA offline cold start served the app shell + already-browsed trip `/detail` from precache.** Only wart was the cosmetic raw `Load failed` on the uncached trips *list* → folded into F-1 (presentation, not a Track B defect). |
| Upgrade | Prior build → previously-unopened route across a new SW deploy never loses chunk access (reaches it or fails gracefully). | ✅ Local: simulated chunk pruning → boundary reload path; natural post-rebuild hash change recovered cleanly. **Cross-deploy container race = owner post-deploy check** |
| Mobile | 375px transitions, slow-load fallback, and touch tab-nav verified. | ✅ Tab switch keeps same BottomNav node, no relayout (`navMoved:false`) |
| Regression | `cd frontend; npm test` and `npm run build` green; focused route/map/co-pilot behavior unchanged. | ✅ 219 tests pass; build green |
| Outcome | W4 before/after foreground per-route cost compared — improvement stated in delivered/parsed bytes, not warning output. | ✅ −57%/−51%/−37% delivered gzip; see [W4 doc](../reviews/2026-07-24-plan-23-track-b-w4-measurement.md) |

### Owner note (informational, non-blocking)
The two login PNGs are 88% of the precache. Optimizing them would cut PWA install weight far more than any JS split — but it is unrelated to the single-chunk problem and out of Track B scope. Raise as a separate optional follow-up; do not fold in.

---

## Track C — Login image weight (STANDALONE, independent of Track B)

**Status: COMPLETE + DEPLOYED 2026-07-24 (`d13a33a`, container `trippy-trippy-1`, `:6768`, no migration).** Standalone deploy verified at the infra level: startup clean, health `{status:ok, db:connected}`; prod serves `mobile-vignette-v2.webp` (200, 103,194 B) and `illustration-login-v2.webp` (200, 263,150 B); old PNG URLs now hit the SPA HTML fallback (`text/html`, unreferenced — harmless); prod `dist/sw.js` precache lists **both new `.webp` and neither old PNG**; container-build printed `precache 9 entries (1151.32 KiB)`. Fresh pre-deploy DB backup taken (`~/Trippy/backups/trippy.pre-trackc.*.db`, 6.5 MB). **Owner prod QA still owes the two PWA-only checks** (can't be verified programmatically): an installed-PWA-from-prior-build picks up the new images after SW upgrade, and offline login still renders. WebP-only per D-C1. Both login images re-encoded to versioned WebP under new filenames, `LoginPage.jsx` references updated, precache glob swapped to `assets/*.webp`, old PNGs deleted. Results: `mobile-vignette-v2.webp` 103,194 B (900×900, q86; was 2,407,446 B) + `illustration-login-v2.webp` 263,150 B (1672×941 unchanged dims, q88 lossy; was 2,543,549 B) = **358 KB combined, down from 4.95 MB (−93%)**. Build precache dropped **5628.51 KiB → 1151.32 KiB (−4.5 MB)**; generated `dist/sw.js` lists both new `.webp` (`revision:null`) and **neither** old PNG — the filename change is what makes the `revision:null` upgrade reach installed PWAs (new URL = new manifest entry; `cleanupOutdatedCaches` prunes the vanished PNG entries). Browser-verified at 375px (vignette crisp) and desktop (full-cover illustration, no visible banding); both WebP 200 OK, no 404 for old PNGs, no console errors. Frontend 209 tests pass + `npm run build` green. `maximumFileSizeToCacheInBytes: 3 * 1024 * 1024` left as-is (item 5 — a follow-up, not scope). **Owner prod QA to confirm: installed-PWA-from-prior-build picks up new images after upgrade, and offline login still renders.** Item-4 note: at the mobile viewport in the browser-pane tooling, *both* WebP were requested (the sketch predicted vignette-only) — a resize-then-navigate layout re-eval artifact, immaterial since combined weight is 358 KB and the precache/install-weight win is unconditional. Surfaced 2026-07-23 while validating Track B; adversarial re-review 2026-07-24 corrected two flawed assumptions in the original sketch (in-place file replacement can never update installed PWAs; blanket "resize to rendered size" is wrong for the desktop illustration). It is **not** part of Track B and must not be folded into it (different work, different risk profile).

**Evidence (reproduced 2026-07-23):** the PWA precache is `5.63 MiB`, and **~4.95 MB (88%) is two eager login images**, not JavaScript:

| Asset | Raw size | Where it loads |
| --- | ---: | --- |
| `frontend/public/assets/illustration-login.png` | 2,543,549 B | `LoginPage.jsx:308` — full-screen `background-image` |
| `frontend/public/assets/mobile-vignette.png` | 2,407,446 B | `LoginPage.jsx:223` — medallion `<img>` |

Both are on the **eager login path**, so a cold first login downloads ~5 MB of images to draw the login screen, and every PWA install precaches them. This dwarfs the entire JS bundle (754 kB raw / 225 kB gzip). **Track B's JS splitting cannot touch this** — total install/transfer weight is dominated by these two files, and only image optimization reduces it.

**Why it is separate from Track B:** Track B is a *foreground JS startup / code-hygiene* change with real runtime risk (SW-upgrade chunk race, offline correctness). Track C is a *static-asset weight* change with near-zero runtime risk (compress/resize/re-encode two files, no code-path change, no service-worker behavior change). They fix different numbers (see Track B fact 6 and the review's F6). Shipping them together would blur the measurement and pointlessly couple a low-risk asset swap to a higher-risk architectural change.

**Re-review corrections (2026-07-24 — verified against the current code and the generated `dist/sw.js`; these supersede the earlier sketch):**

1. **In-place replacement under the same filename will never reach installed PWAs.** The generated service worker lists both files as `{url: "assets/mobile-vignette.png", revision: null}` / `{url: "assets/illustration-login.png", revision: null}` — `vite-plugin-pwa` assumes everything in `dist/assets/` is content-hashed, but these are copied verbatim from `public/`. With `revision: null` and an unchanged URL, Workbox sees an identical manifest entry and keeps the stale cached bytes forever. **New filenames are mandatory** (either a manual version suffix on the `public/` files, or importing them from `src/` so Vite content-hashes them — the medallion `<img>` can take an import; the desktop `background-image` lives in an inline `<style>` string in `LoginPage.jsx` and would need the imported URL interpolated). Smallest defensible: manual version-suffixed filenames, two reference updates.
2. **A `<picture>` WebP + PNG-fallback strategy is internally contradictory with the current precache.** The glob precaches only `assets/*.png`; a WebP-capable browser (all of them) would select the unprecached WebP source and lose the image offline. Precaching *both* formats fixes offline but roughly halves the claimed install-weight saving by shipping every install two encodings it will never both use. **Resolution: ship a single format per asset and precache exactly that.** WebP has universal support in every browser this private PWA can realistically meet; a fallback defends nothing. Extend the glob to `assets/*.{png,webp}` (or swap outright once no PNGs remain in `public/assets/`).
   - **D-C1 — RESOLVED 2026-07-24: owner approved WebP-only, no PNG fallback.** Ship single WebP files per asset; extend the glob to cover `.webp`; remove the retired PNGs from `public/assets/` so no stale format lingers in the precache.
3. **The two assets need different treatments — "resize to rendered size" is only half right.**
   - `mobile-vignette.png` (1254×1254, 2.40 MB) renders at ≤320 CSS px (`min(80vw, 320px)`). Clearly oversized: resize to ~640–960 px square (2–3× DPR) **and** re-encode. Budget: ≤150 kB.
   - `illustration-login.png` (1672×941, 2.54 MB) is a full-viewport `background-size: cover` on ≥800 px desktops — it is already ~1× for a 1440-wide window and *undersized* on high-DPR desktops. **Do not downscale it.** Its weight problem is PNG encoding of illustrative content; re-encode at current (or modestly larger, if a better source exists) dimensions as lossy WebP. Budget: ≤400 kB. Upscaling for DPR is out of scope — no better source is assumed to exist.
4. **Measure actual cold-login requests at both viewports before/after; source references are not request evidence.** Expected (verify, don't assume): mobile (<800 px) fetches only the vignette — the desktop `background-image` sits on a `display: none` subtree and unrendered background images are not fetched; desktop fetches **both** — the mobile `<img src>` is fetched by the preload scanner even inside a hidden subtree. If measurement contradicts this, record what actually loads and size the win accordingly. (Regardless of per-viewport requests, every PWA install precaches both files — the install-weight saving is real for all users.)
5. **`maximumFileSizeToCacheInBytes: 3 * 1024 * 1024`** exists to admit these two PNGs. After optimization, note (don't silently change) that it could return to the Workbox default; leave it as-is unless the owner wants it tightened — a follow-up line item, not scope.

**Scope when picked up (bounded, no architecture change):** re-encode per item 3 under new filenames per item 1, update the two `LoginPage.jsx` references, extend the precache glob per item 2, and run the item-4 measurements. Realistic target: ~4.95 MB → ≤550 kB combined.

**Acceptance evidence:** before/after precache total and per-asset size; generated `sw.js` shows the new filenames present and the old ones absent; an *installed* PWA from the prior build picks up the new images after upgrade (this is exactly what item 1 protects); cold-login request set measured at 375px and desktop; login screen visually unchanged at both viewports (vignette crispness at 2–3× DPR, illustration with no visible banding at cover scale); offline login still renders. Standalone deploy.

**Explicitly not in scope:** any other image on the site, the JS bundle (that is Track B), service-worker policy beyond the one glob extension, or sourcing higher-resolution artwork.

---

## Follow-up F-1 — Raw/unfriendly offline & error copy (auth + Trips home) (surfaced during Track C/B prod QA 2026-07-24)

**Status: READY TO IMPLEMENT — investigated + owner-decided 2026-07-24 (this session). Not started. Independent of Tracks A/B/C; do not fold into Track B.** Presentation-only across the board: no migration, no backend logic change, no SW caching change, no offline-data/write architecture.

**Not a bug and not a Track C regression** — surfaced incidentally while the owner exercised offline login, tripped the auth rate limiter, and cold-started the installed PWA offline. All three behaviors are *correct*; only the user-facing copy is unpolished. Three raw strings reach an error line via the same class of mechanism:

1. **Offline auth submit.** `fetch` rejects with a native `TypeError` that `request()` rethrows verbatim ([api.js:33-37](../../../frontend/src/services/api.js) — the `catch` only special-cases `AbortError`). The message is **browser-dependent** (Chrome `Failed to fetch`, Firefox `NetworkError when attempting to fetch resource`, Safari `Load failed`) — string matching is the wrong detector. `AuthContext`'s three flows ([AuthContext.jsx:72-98](../../../frontend/src/context/AuthContext.jsx)) do `setError(err.message)`, so the raw string lands in the login line ([LoginPage.jsx:173-180](../../../frontend/src/pages/LoginPage.jsx), DM Mono **uppercase**, `#e08a7a`).
2. **Rate-limited (HTTP 429).** Server string `Too many requests, please try again later` ([rateLimit.js:12](../../../backend/src/middleware/rateLimit.js)), stamped `status: 429` ([api.js:29](../../../frontend/src/services/api.js)), passed straight through. `router.use(authLimiter)` ([auth.js:9](../../../backend/src/routes/auth.js)) throttles the **whole auth router** (login/register/setup/logout/me), so copy must be **action-neutral**. Prod: 20 requests / 15-min window per IP; test: 5.
3. **`Load failed` on Trips Home offline.** `loadTrips` does `setError(err.message)` ([TripsHomePage.jsx:42-44](../../../frontend/src/pages/TripsHomePage.jsx)); `GET /api/trips` (the trip *list*) has **no** SW runtime-cache rule (only `/detail`, `/share`, `/map-config`, artifacts, attachments — [vite.config.js:62-141](../../../frontend/vite.config.js)), so offline the list fetch fails with the same transport mechanism as item 1. **Owner decided against caching the list** (the app is online-first; the one real offline case — glancing at an already-loaded itinerary — is already served by the `/detail` cache). Fix is presentation-only.

### Classification contract (1 — transport vs. presentation ownership)

**The api client owns transport facts; a pure presentation mapper owns wording.** Do not match browser message text anywhere.

- **`request()` in [api.js](../../../frontend/src/services/api.js) — stamp a machine-readable `code` on transport failures, nothing more.** Restructure so an **inner** `try/catch` wraps *only* the `fetch()` call. If `fetch()` rejects (and it is not an `AbortError`), stamp `code: 'NETWORK_ERROR'` on the rethrown error. Keep the existing outer handling for `AbortError` → `{ status: 408, timeout: true, code: 'TIMEOUT' }`. Leave the HTTP-error branch stamping `status` as today. **Do not** wrap `res.json()` (the success-body parse) in the network catch — a malformed 2xx body must fall through with **neither `code` nor `status`** so it is classified "unexpected", never "offline". This is the correction to the original "missing `.status`" detector: the precise signal is *"`fetch()` itself rejected before any Response existed,"* which is narrower than "no status."
  - Sketch: `let res; try { res = await fetch(...) } catch (err) { if (err.name === 'AbortError') throw err; throw Object.assign(new Error(err.message || 'Network request failed'), { code: 'NETWORK_ERROR' }); }` then the existing 401/`res.ok`/`res.json()` logic, wrapped by the current outer `try…catch(AbortError→408)…finally(clearTimeout)`.
  - **Do not** thread response headers through the happy-path return (owner chose static 429, D-F1a below). The `RateLimit-Reset` header stays unread.
- **New pure helper `frontend/src/utils/apiError.js` exporting `friendlyError(err, context)`** — the only place wording lives. `context` is `'auth' | 'trips'`. Precedence: network/timeout → context copy; `status === 429` → cooldown copy; any other `status` → **pass the server `err.message` through** (preserves Invalid credentials / Invalid invite code / Username already taken / Missing fields); else (no code, no status) → neutral generic. No growing global switch — one small context-aware function.
- **`navigator.onLine` is not used.** The `code` signal is reliable; never gate submit on `onLine`. React after the failed request only.
- **Preserve the original error.** Call sites map copy into state and **rethrow the original** so `code`/`status` survive. AuthContext's offline-bootstrap fallback ([AuthContext.jsx:44-57](../../../frontend/src/context/AuthContext.jsx)) keys on `err.status === 401` and is unaffected.

### Call sites & files in scope (2)

- **`frontend/src/services/api.js`** — add `code` stamping in `request()` as above. (`requestStream` untouched — see non-goals.)
- **`frontend/src/utils/apiError.js`** — new `friendlyError(err, context)` helper.
- **`frontend/src/context/AuthContext.jsx`** — in `setup`/`login`/`register`, change `setError(err.message)` → `setError(friendlyError(err, 'auth'))`; keep `throw err`.
- **`frontend/src/pages/TripsHomePage.jsx`** — `loadTrips` catch → `setError(friendlyError(err, 'trips'))`; render a **complete recoverable error state** (D-F1d): when `error` is set, show the friendly copy + a **Try again** button (re-runs `loadTrips`) in place of the trip sections, and suppress the header's `+ New Trip` button while errored (guard becomes `!isEmpty && !error`). The empty-state gate `isEmpty = !error && trips.length === 0` is already correct and stays — network error keeps `isEmpty=false`, so `EmptyTripsState` never shows on failure.
- **No changes to** `LoginPage.jsx`/`SetupPage.jsx` markup — they already render `error`. Casing note: login/register uppercase, Setup/Trips do not; final copy below reads well in both. No color/restyle changes.

### Final copy (3)

- **Auth network/timeout:** `Can't reach Trippy right now. Check your connection and try again.`
- **Trips Home network/timeout:** `We can't load your trips right now. Check your connection and try again.` *(adjusted from the owner's "…while offline" hypothesis — the transport code also fires on server-unreachable/DNS, so "check your connection" is accurate without asserting the user is offline.)*
- **429 (both contexts, static — D-F1a):** `Too many attempts. Please wait before trying again.`
- **Unexpected (no code, no status — malformed body / runtime):** `Something went wrong. Please try again.`
- **Existing HTTP validation (any other `status`):** unchanged, server message passed through — Invalid credentials, Invalid invite code, Username already taken, Missing fields.

All read correctly uppercased (login/register) and in sentence case (Setup, Trips).

### Owner decisions (resolved 2026-07-24)

- **D-F1a — 429 copy → STATIC.** No header threading; no happy-path api change. (If ever revisited, attach `retryAfterSeconds` from `RateLimit-Reset` **only** inside the 429 `!res.ok` branch — zero blast radius — but not now.)
- **D-F1b — Offline copy scope → ALL THREE auth flows**, centralized in AuthContext. React-after-failure; `navigator.onLine` **not** used.
- **D-F1c — 429 string → FRONTEND mapping.** Backend limiter message/behavior unchanged (server messages are for logs/API clients; UI owns UI copy).
- **D-F1d — Trips Home retry → YES.** Full recoverable error state (copy + Try again button, hide New Trip while errored). Presentation-only; no caching.

### Retry metadata (4)

None threaded through the api client. Static 429 copy needs no header. Trips Home retry is a local `loadTrips()` re-invocation button — no new client plumbing.

### Focused automated coverage (5)

New `frontend/src/services/api.test.js` (`// @vitest-environment jsdom`, `vi.stubGlobal('fetch', …)`), `frontend/src/utils/apiError.test.js` (node), plus additions to AuthContext/TripsHome tests (jsdom, `@testing-library/react`, matching existing `vi.mock` conventions in e.g. [TripPage.test.jsx](../../../frontend/src/pages/TripPage.test.jsx)):

1. **fetch rejection → `code:'NETWORK_ERROR'`, no `status`** (mock `fetch` rejecting with a `TypeError`).
2. **Browser text is irrelevant** — reject with both `TypeError('Failed to fetch')` and `TypeError('Load failed')`; both yield `code:'NETWORK_ERROR'`.
3. **Malformed 2xx body is NOT mislabeled offline** — `fetch` resolves `ok` but `res.json()` rejects → error has **neither** `code` nor `status`; `friendlyError` → generic, not the network copy.
4. **HTTP 429 mapping** — `status:429` → `friendlyError(err,'auth')` and `(…, 'trips')` both return the static cooldown copy.
5. **Existing HTTP validation preserved** — 401 `{error:'Invalid credentials'}` / 400 `{error:'Missing fields'}` keep `status` and pass the server message through `friendlyError`.
6. **Happy path unchanged** — 2xx returns parsed JSON; no `code`.
7. **Auth consistency + original-error rethrow** — mock `authApi` rejecting `NETWORK_ERROR`; `login`, `register`, `setup` each set `error` to the auth network copy **and** reject with the *original* error (`code` still present). Same assertion for a 429.
8. **Trips Home network error ≠ empty state** — `tripsApi.list` rejecting `NETWORK_ERROR` renders the offline copy + Try again button and **not** `EmptyTripsState`; a separate happy-path with `trips:[]` renders `EmptyTripsState` and no error copy; Try again re-invokes `loadTrips`.

### Browser QA (6)

At 375px and desktop, exercise the error states with the network throttled to offline:
- Login submit offline → friendly auth copy (uppercased).
- Register submit offline → same copy, same treatment.
- Setup submit offline → same copy in sentence case (Setup does not uppercase).
- Trips Home cold load offline → recoverable error block + working Try again (reconnect, tap → list loads).
- Trip 429: not force-tripped in QA (would burn the limiter); covered by tests. Spot-check the static string renders if convenient.

### Non-goals (7)

No migration. No backend limiter message/behavior change (D-F1c). No SW caching rule added or widened (owner decision — the trips list stays uncached; this is the whole reason the fix is presentation-only). No offline-data or offline-write support. `requestStream` (co-pilot SSE) raw-rethrow is **not** touched — out of scope, noted for a future consistency pass. No color/typography restyle of the existing error lines (the off-token `#e08a7a`/`#e05a5a` literals are a separate cleanup). No adjacent Plan 23 Track A/B/C work.

**Acceptance:** all three raw strings are gone — auth (login/register/setup) shows the human network copy offline and the static cooldown copy when rate-limited, consistent across the three flows; Trips Home shows the recoverable offline block with a working Try again and never the empty state on failure; malformed/unexpected failures show the neutral generic, never the offline copy; existing HTTP validation messages and all happy paths are unchanged; new + existing frontend and backend tests green; verified at 375px and desktop.

---

## Notes
- Track A is investigation-first per the house workflow: produce findings + the D-A1 decision, get owner approval, then implement. Track B needs no product decision and can proceed on its own whenever.
- Both tracks were surfaced by the Plan 22 owner prod QA pass (2026-07-22); recorded so they are not lost. Neither reopens Plan 22.
- Relevant code: `backend/src/services/trips.js` — `buildDestinationsGeo`, `boundsCentroid`, `mergeDestinationPairs`, the per-trip stops query added in Plan 22 W1, and `listTripsForUser`. Stop `type`/`location_status`/`location_confidence`/`coordinate_system` columns are the discriminators for Track A.
