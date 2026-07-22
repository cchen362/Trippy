# Implementation Plan 23 — Trips Home Route-Node Geography Correctness (+ bundle-split follow-up)

**Status:** WRITTEN 2026-07-22 — **investigation-first, not started.** Surfaced during Plan 22 W4/owner prod QA: some route-cover **nodes sit in the wrong place**. **Investigation update 2026-07-22 (root cause CONFIRMED — see Track A):** this is a **legacy-data artifact, not a live bug.** Trips created before the current scope picker captured a `bounds_json` viewport per destination have scopes with `bounds_json = NULL`; those nodes fall to a transit-stop coordinate fallback that can be poisoned. A trip created today (both destinations as bounds-carrying scopes) renders correctly. The live pipeline is healthy. This downgrades Track A from "bug fix" to "optional legacy hardening/cleanup." **Owner approved D-A1(b) 2026-07-22 — IMPLEMENTED (see Track A status), pending deploy.** Track B is independent, low-risk build hygiene, not started.

**Origin:** Plan 22 made per-destination geography visible for the first time (`destinationsGeo` → route cover). That visibility exposed two pre-existing data problems that were previously invisible. **Plan 22's render is correct; the underlying stored/derived coordinates are not.** Nothing here is a Plan 22 regression — Plan 22 is CLOSED and stays closed.

**Schema impact: NONE expected** (this is a derivation/data-hygiene fix, not a model change). Confirm during investigation; if a fix genuinely needs persistence, that becomes a new decision, not an assumption.

---

## Track A — Route nodes render at geographically wrong coordinates (PRIMARY)

**Status: D-A1(b) IMPLEMENTED 2026-07-22 (owner-approved), not yet deployed.** `buildDestinationsGeo`'s coordinate source now excludes `type='transit'` stops (flights/trains) — one `continue` added to the `stopCoordByCityKey` loop in `listTripsForUser` ([trips.js](../../../backend/src/services/trips.js), lines ~849-861), plus a regression test in `backend/tests/trips.test.js` (the transit stop sorts first but the real place stop wins; a transit-only day → `null`). Backend 676 pass. **Verified against the live endpoint** (dev DB, real legacy trips): old Chengdu–Chongqing now resolves **Chongqing `29.57,106.57`** (from `Regent Chongqing`, was the `G8613` train's Chengdu-end pin `30.71,104.15`) and **Chengdu `30.58,104.07`** (from Waldorf Astoria, was the `SQ 842` *flight* `30.30,104.45`) — both nodes corrected; cover renders Chongqing SE of Chengdu. **Scope boundary honored:** the change is a read-only filter in the cover's coordinate-borrowing step only; `listDaysForTrip`/day-header derivation is untouched (owner's hard constraint). **Known residual (out of scope, different mechanism):** the Ipoh trip's `Singapore` node improved from a near-Ipoh flight pin to a KL-area coordinate but is still not Singapore — that day is *labeled* Singapore while carrying KL stops (a legacy day-labeling quirk, not transit poisoning); option (b) correctly stopped using the flight pin. Not worth chasing on one legacy trip.

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

**Evidence:** `cd frontend; npm run build` warns `index-*.js  753.94 kB │ gzip: 225.14 kB` and "Some chunks are larger than 500 kB". Pre-existing, unrelated to Plan 22 — the whole app ships as one chunk.

**Not urgent:** gzip is 225 kB and the PWA precaches it, so repeat loads are cache-served. This is a first-load / code-hygiene improvement, not a correctness issue.

**Scope when picked up:** introduce route-level `React.lazy` splitting and/or `build.rollupOptions.output.manualChunks` to separate vendor (React/Router/Leaflet) from app code and lazy-load heavy leaves (Map/Leaflet, co-pilot). Verify no regression in the PWA precache manifest and that lazy routes still work offline. Measure before/after chunk sizes. Low risk, no product decision.

---

## Notes
- Track A is investigation-first per the house workflow: produce findings + the D-A1 decision, get owner approval, then implement. Track B needs no product decision and can proceed on its own whenever.
- Both tracks were surfaced by the Plan 22 owner prod QA pass (2026-07-22); recorded so they are not lost. Neither reopens Plan 22.
- Relevant code: `backend/src/services/trips.js` — `buildDestinationsGeo`, `boundsCentroid`, `mergeDestinationPairs`, the per-trip stops query added in Plan 22 W1, and `listTripsForUser`. Stop `type`/`location_status`/`location_confidence`/`coordinate_system` columns are the discriminators for Track A.
