# Plan 23 Track B — W4 Measurement + Gate Decisions (post-split)

**Captured:** 2026-07-24, after W2 route-split (`ba5d719`) and the W4 vendor split.
**Method:** production build (`cd frontend; npm run build`) served via `vite preview` (:4173)
with `/api` proxied to the test backend (:3002, `NODE_ENV=test`, non-secure cookies so
auth works over http). Per-route foreground sets measured with
`performance.getEntriesByType('resource')` on a cold load (SW + caches cleared each route),
cross-checked against the built chunk graph. Compared against the
[W1 baseline](2026-07-24-plan-23-track-b-w1-baseline.md) (single 753.95 kB / gzip 225.14 chunk).

## Per-route foreground JS (delivered gzip) — before vs after

| Route | W1 before (gzip) | W4 after (gzip) | Δ | MapTab/Leaflet |
| --- | ---: | ---: | ---: | --- |
| `/share/:token` | 225.14 | **96.09** | **−57%** | not loaded |
| `/trips` | 225.14 | **110.61** | **−51%** | not loaded |
| `/trips/:id/plan` (deep-link) | 225.14 | **140.89** | **−37%** | not loaded |
| `/trips/:id/map` | 225.14 | 140.89 + **51.35 on-demand** | — | loaded only when Map opens |

Runtime-confirmed decoded (parse/execute) bytes: `/share` ≈ 286 KiB, `/trips` 328.5 KiB,
`/trips/:id/plan` 428.3 KiB — each matching its static import closure exactly. The single
225 kB gzip everything-chunk is gone; every entry route now delivers 37–57% less foreground
JS, and Leaflet's 51 kB gzip is entirely off the critical path until the Map tab is opened.

Per-route request sets (cold, SW cleared):
- `/share`: `index`(entry) + `ShareViewPage` + `tripsApi` + `dayGeo` + CSS. No trip shell, no Leaflet.
- `/trips`: `index` + `TripsHomePage` + `tripStatus` + `bookingPayload` + `coordinates` + `tripsApi`. No Leaflet, no tabs.
- `/trips/:id/plan`: `index` + `TripPage` + `PlanTab` + `tripStatus` + `tripsApi` + `DayTabs` + `plus` + `dayGeo`. **`mapTabLoaded: false`.**
- `/trips/:id/map`: adds `MapTab` (Leaflet) on demand; `.leaflet-container` renders full-size with CSS already applied — no flash.

## Gate 1 — Vendor `manualChunks` split → **IMPLEMENTED** (owner-approved 2026-07-24)

Measurement that decided it: the post-route-split entry chunk was **288.11 kB / gzip 94.06**,
of which ~99% is stable third-party code:

| Chunk | Raw | Gzip |
| --- | ---: | ---: |
| `vendor-react` (react, react-dom, react-router-dom, scheduler) | 165.24 kB | **53.77** |
| `vendor-motion` (framer-motion + motion-* deps) | 117.58 kB | **39.10** |
| app-shell entry after split | 10.92 kB | **4.16** |

Concrete residual problem (the plan's gate criterion): without the split, **every app-only
redeploy** changes the single entry's content hash and forces returning clients to re-download
all ~94 kB gzip of unchanged React+framer. Isolating vendor into its own content-hashed chunks
(`vendor-react` 53.77 + `vendor-motion` 39.10 = 92.87 kB gzip) makes it cache-stable across app
deploys — an app-only change now re-downloads only the ~4 kB gzip shell + the touched route
chunk. It also **shrinks the SW precache re-fetch surface on upgrade** (vendor entries survive
across app deploys), which strictly helps the W3 upgrade race.

First-load total bytes are unchanged (vendor was already inside the old entry; HTTP/2/same-origin
multiplexes the extra files). The cost is +2 chunk files and a small `manualChunks` block.
Implemented in [`frontend/vite.config.js`](../../../frontend/vite.config.js) `build.rollupOptions.output.manualChunks`.

## Gate 2 — Co-pilot panel split → **SKIPPED** (owner-approved 2026-07-24)

Measurement that closed it: forcing `components/copilot/*` into its own chunk produced
**`chunk-copilot` 28.20 kB / gzip 9.03** (CopilotPanel + CopilotMessage + MutationPreview +
copilotSeeds), dropping `TripPage` from 23.43 → 15.03 kB gzip. framer-motion is already shared
(`vendor-motion`), so the 9.03 kB is the panel's own code.

Decision: **skip.** The saving is ~9 kB gzip *deferred* (not eliminated) — the panel opens on the
first FAB tap for most trip sessions, so it loads anyway, just behind a Suspense spinner on the
core co-pilot interaction. The `useCopilot` history request fires on mount regardless (fact 5),
so splitting the panel defers only parse, not the network round-trip. Adding a lazy boundary +
failure surface for ~9 kB is the "pure maintenance cost" the plan warned against. Hook lifecycle
untouched. `CopilotPanel` stays statically imported by `TripPage`.

## W3 runtime verification (production build, not dev server)

| Check | Result |
| --- | --- |
| Precache manifest | All 26 lazy JS chunks + CSS + 2 webp in `dist/sw.js`; Cache Storage after SW activation holds all 10 route chunks (`routeChunksMissing: []`, 30 entries). |
| Per-route delivery | `/share`, `/trips`, deep-link load only their own + shared chunks — no unrelated route-exclusive code. |
| Heavy boundary | `MapTab`/Leaflet fetched only on Map open; absent from all three entry routes (`mapTabLoaded: false`). |
| Upgrade race (fact 7/8) | Pruned-chunk 404 caught by `ChunkErrorBoundary` at **both** altitudes: outlet-level preserves the trip shell + BottomNav with an inline "Couldn't load / Reload"; app-level shows the full-screen reload state. Corroborated by the natural post-rebuild hash change — every stale-chunk fetch was caught by the boundary and recovered on reload; never a dead screen. |
| Leaflet CSS | Stays **global** (decided by observation): it's in the eager `index-*.css` loaded on every route, so the lazy map paints with correct layout on first frame. Moving it into the lazy map boundary would introduce the flash it currently avoids. |
| Mobile 375px | Plan→Logistics tab switch keeps the **same** BottomNav DOM node (`navPersistedSameNode: true`, `navMoved: false`) — nested Suspense suspends only the outlet; shell and nav never remount or shift. |
| Regression | Frontend **219 tests pass** (35 files); `npm run build` green. |

## Owner-owed PWA checks (deployed container only — cannot be verified locally)

As with Track C, two checks depend on a real installed PWA across a real deploy and are the
owner's to confirm after deploy:
- An installed PWA from the prior build cold-starts **fully offline** after a completed precache.
- The **cross-deploy upgrade race** on the container: an already-open prior-build client
  navigating to a previously-unopened lazy route after the new SW activates reaches its chunk,
  or fails gracefully to the `ChunkErrorBoundary` reload path (proven locally via simulated
  chunk pruning; the deployed confirmation is the owner's).
