# Implementation Plan 23 — Trips Home Route-Node Geography Correctness (+ bundle-split follow-up)

**Status:** WRITTEN 2026-07-22 — **investigation-first, not started.** Surfaced during Plan 22 W4/owner prod QA: the route-diagram covers render faithfully, but some **nodes sit in the wrong place** because the *source geography they render is wrong*. This plan is scoped as investigation → owner-approved findings → fix. **Do not implement the fix track until the owner approves the approach** (there is a real product decision in Track A — see D-A1). Track B is independent, low-risk build hygiene.

**Origin:** Plan 22 made per-destination geography visible for the first time (`destinationsGeo` → route cover). That visibility exposed two pre-existing data problems that were previously invisible. **Plan 22's render is correct; the underlying stored/derived coordinates are not.** Nothing here is a Plan 22 regression — Plan 22 is CLOSED and stays closed.

**Schema impact: NONE expected** (this is a derivation/data-hygiene fix, not a model change). Confirm during investigation; if a fix genuinely needs persistence, that becomes a new decision, not an assumption.

---

## Track A — Route nodes render at geographically wrong coordinates (PRIMARY)

### Evidence (sampled from the live dev DB 2026-07-22, `backend/data/trippy.db`)

`GET /api/trips` `destinationsGeo` returned these wrong nodes:

| Trip | Node | Returned coord | Should be ~ | Actually is |
| --- | --- | --- | --- | --- |
| Ipoh – Kuala Lumpur | **Singapore** | `4.55, 101.11` (wgs84) | `1.29, 103.85` | a point near **Ipoh, Malaysia** |
| Chengdu – Chongqing | **Chongqing** | `30.71, 104.15` (wgs84) | `29.56, 106.55` | a point in **Chengdu** |

### Root cause (traced, not guessed)

Both suspect scopes have **`bounds_json = NULL`** — so priority (a) (scope-bounds centroid) never fires. The coordinates come entirely from **W1 priority (b): the day/stop coordinate fallback** (`buildDestinationsGeo` + `stopCoordByCityKey` in `backend/src/services/trips.js`). That fallback is picking coordinates from stops that are geographically wrong for the destination they're keyed to. Two distinct mechanisms, both confirmed in the stop table:

1. **Transit stops carry origin-end coordinates but destination-name titles.** The Chongqing node traces to the stop `G8613 Chengdu East → Chongqing North` (`30.705, 104.151`, `status=estimated`) — a train whose title contains "Chongqing" but which is physically located at the **Chengdu** departure end. Every genuinely-Chongqing stop (`Regent Chongqing` `29.57,106.57`, `Luohan Temple`, `Hongya Cave`…) sits on a day whose `city="Chengdu"` (the whole trip is one day, `city=Chengdu`), so they never key to a Chongqing node.
2. **Flight/transit codes geocode to arbitrary points.** `SQ 103` → `4.55,101.11` (near Ipoh, feeds the bad **Singapore** node); `SQ 843` → `40.0,116.4` (**Beijing**); `SQ 842`, `TR 486`, `EG9049`, `G3360` similar. These are airline/train codes resolved to a coordinate with `status=estimated` (not `unresolved`), so they carry a plausible-looking but meaningless pin.

**Why W1's existing guard misses them:** W1 skips stops whose `coordinate_system` is `unknown`/`null` (the honest "no coordinate" case). But these bad stops are `coordinate_system='wgs84'` with `location_status='estimated'` — they pass the current filter. The filter gates on *coordinate-system provenance*, not on *resolution confidence* or *stop type*.

### What still needs tracing before a fix is written (the investigation)
- **The exact matching key** in `buildDestinationsGeo`/`stopCoordByCityKey` — how a stop is assigned to a destination (day resolved-city key vs stop title vs country). The Chongqing case suggests a title/name path is involved; confirm it. Read the actual W1 code, don't infer from this doc.
- **Whether transit-type stops should ever be a coordinate source.** A `type='transit'`/flight/train stop's pin is the *route*, not a *place* — it is arguably never a valid destination centroid. Confirm stop `type` values in play.
- **Whether `location_status IN ('estimated')` and/or `location_confidence < threshold` should be excluded** from the fallback, and what that does to legitimate nodes (many real place stops are also `estimated` — e.g. `Petronas Twin Towers` `estimated` but *correct*). A blunt "exclude all estimated" would strip good nodes; the transit-type signal is likely the cleaner discriminator. **This is the crux to get right — measure both filters against the full trip set before choosing.**
- **Re-sample against production**, not just dev — the prod DB may have a different mix; confirm the same two mechanisms and count how many trips are affected.

### Binding product decision needed (do NOT pre-decide)
**D-A1 — When a destination has no *trustworthy* coordinate, what renders?** Options, in Plan 22's own degradation language:
- (i) node resolves to `null` → the cover degrades per D5 (fewer located nodes, possibly the single-node or typographic branch). Honest, consistent with "a `null` coordinate is a valid handled value" (invariant 3). **Recommended** — it never draws a *wrong* pin, only *fewer* pins.
- (ii) keep a rough coordinate (e.g. the day's city centroid from a place lookup) so the node still appears roughly right.
- (iii) add a real geocode for un-bounded scopes (new resolver work / API cost — likely out of proportion for a schematic cover).

Owner picks the philosophy before any code. The likely-correct, cheapest answer is **(i) + exclude transit-type stops from the fallback**, but confirm the good-node collateral first.

### Track A definition of done
1. A findings write-up: exact match path, the filter chosen (with the good-vs-bad node counts that justify it), and D-A1 resolved.
2. Fix in `buildDestinationsGeo`'s coordinate fallback (root cause, no bandaid): a stop only contributes a destination coordinate when it is a real place (not a transit/flight/train code) **and** its resolution is trustworthy for a centroid. Preserve W1's coordinate-system/provenance handling and the ordering-parity + `null`-is-valid invariants (Plan 22 invariants 3 & 6).
3. Backend test with a fixture reproducing both mechanisms (a transit stop titled for the destination but located at the origin; a flight-code stop). Assert the affected nodes resolve to `null` (or the chosen D-A1 outcome), and that legitimate place-derived nodes are unaffected.
4. Re-sample the live endpoint for the two known-bad trips and confirm the nodes are corrected. Per CLAUDE.md, sample the actual response — no green-mock-only closure.
5. Browser: the Ipoh and Chengdu covers no longer draw a node in the wrong country/city. No deploy of its own — batch with the next deploy unless the owner wants it shipped standalone.

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
