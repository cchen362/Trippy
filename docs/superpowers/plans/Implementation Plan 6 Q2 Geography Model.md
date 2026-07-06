# Implementation Plan 6 — Q2 Geography Model (Gate A)

**Status:** Wave 1 COMPLETE (2026-07-06) — schema, extraction, resolver, and paired-seed changes shipped and tested (backend 204/204, frontend 28/28). Wave 2 COMPLETE (2026-07-06) — `deriveDayGeo`, per-day `mapConfigByDay`, stop-level deep-link override, and derived-geography geocoding bias shipped and tested (backend 219/219, frontend unchanged at 28/28). Wave 3 COMPLETE (2026-07-07) — Map/Today tab per-day consumers, destination editor (`EditTripModal` + conservative seed-layer edit semantics), day-override country resolution, and importer/share/discovery consumers shipped and tested (backend 223/223, frontend 29/29). Also fixed a Wave-2 regression found during browser verification: `routes/map.js` called `getTripMapData` without importing it, so `GET /map-data` 500'd — the Map tab was broken end-to-end until this session's fix. Wave 4 COMPLETE (2026-07-07, local main only — NOT deployed) — migration runner extended to support `.js` migrations alongside `.sql`; `014_geography_backfill.js` (day-seed country backfill + gcj02 pin-relabel safety net, both logged) and `015_retire_trip_destination_arrays.sql` (drops `trips.destinations`/`destination_countries`) shipped; every reader of the dropped columns (`trips.js`, `mapData.js`, `share.js`, `seed.js`/`chengdu-chongqing.json`) now derives the same fields from `days` instead. Tested: backend 231/231 (from 223), frontend unchanged at 29/29. Key design decision made in-session (not pre-specified by the plan): `trip.destinations`/`destinationCountries` echo the caller's own input verbatim on `createTrip`/`updateTrip` (preserving every existing Wave 1–3 test assertion unchanged), and derive fresh from each day's **resolved** (override/booking-aware) geo — not the raw seed columns — on plain reads (`listTripsForUser`, `getTripDetail`, share payload, map-data). A dedicated snapshot-based integration test (`backend/tests/geographyBackfill.test.js`) runs the full migration suite against a copy of the real dev DB and asserts trip detail/share/map-data outputs are semantically identical (or a strict superset — see below) before/after for the two real trips; it caught a real bug before merge: an early seed-only derivation silently dropped "Chongqing" from the Chengdu–Chongqing trip's destinations, because that trip's Chongqing identity comes entirely from an active hotel-booking override (`deriveDayGeo` layer 2), not the raw day seed (every day's raw seed is literally `city='Chengdu'`). Fixed by switching all read-path derivation to resolved geo. Separately (expected, not a bug): the real "Ipoh - Kuala Lumpur" trip's derived destinations now additionally include "Singapore" (a real return-flight leg, `SQ 103` KL→SIN, that the old creation-time-frozen `destinations` column never captured) — the days-derived value is a superset of the stale stored value, which is the intended effect of days owning geographic identity. Verified: full backend + frontend suites green; the real running dev server (`node --watch`) auto-applied 014/015 to the local dev DB as a side effect of the file edits (expected dev behavior, data verified intact — 2 trips, 0 unresolved `city_country` days, gcj02 relabel correctly inert for both real trips); confirmed via a direct HTTP call to the live `GET /api/share/:token` endpoint that the real request path returns the corrected values. **Not verified:** an authenticated browser session clicking through Trip Detail/Map/Today (no login credentials available for the real user account in this session, and the preview browser tool couldn't attach to this repo's dev server — its project root is scoped to the stale OneDrive-synced stub, not `C:\Users\cchen362\Desktop\Trippy`). **Not yet done:** the production deploy step (deploy main, confirm server access, run migrations against production, verify the two real trips render) — out of scope for this session per the plan's deployment-preconditions section; local main is now several commits ahead of un-pushed origin/main.
**Decision record:** [Gate A CLOSED, owner decisions 2026-07-06](../reviews/2026-07-06-product-architecture-risk-review.md#gate-a-closed--owner-decisions-2026-07-06)
**Design source:** [Completed Q2 review](../reviews/2026-07-06-q2-trip-geography-and-map-architecture.md) — all §-references below point there unless stated otherwise.
**Model guidance:** Fable orchestrates and QAs; coding delegated to Sonnet subagents wave by wave.

## What this builds

The canonical geography model approved at Gate A: **the day owns geographic identity as a
derived `{city, countryCode}` pair** via the existing five-layer `deriveDayCity` precedence
(kept intact), with trip destinations derived from days and every country-sensitive decision
(tiles, coordinate conversion target, deep links, geocoding bias) selected from day — or, for
deep links, stop — country. Option A upgraded + Option C for links; Option B rejected (review
§5–6). Legacy `trips.destinations` / `destination_countries` columns are retired (owner
decision 5); the API keeps serving those *fields*, derived from days, so no response shape
breaks.

Owner-approved simplifications that bound this plan:

- Production has 2 trips / 35 stops / 1 user / 1 share link; backfill is a one-shot cleanup,
  not a compatibility program. No phased write-through release; columns drop in this plan.
- Poisoned-pin cohort in production is **zero** (the single `gcj02` stop is on the China
  trip); the relabel step (owner decision 4) is a one-statement safety net, not a project.
- Mixed-country provider-*switching UI* is not needed; per-day selection must simply work
  when such a trip exists (owner constraint: clean model, phased UI acceptable).

## Out of scope (do not drift)

Persisted booking-type conversion, Q3 discovery personalization (unblocks *after* this ships —
its cache key gains `(city, countryCode)` identity from here), co-pilot feature work,
notifications. Discovery's global cache key stays a city string in this plan; only the
*inputs* discovery receives (day pair, `locationCountry` on add-stop) improve.

## Deployment preconditions (ops, before Wave 4 lands on the server)

Server access is restored (`ssh chee@100.94.82.35`, project at `~/Trippy`, DB volume
`~/Trippy/data/trippy.db`, container `trippy_trippy_1`). Production runs `e870b6e` — four
weeks behind main.

1. **DONE 2026-07-05** — Deployed current main (`00cc959`, Plans 3-M3/4/5 content) and
   verified: migrations 011/012 applied cleanly, container stable, share link still resolves.
   Production baseline is now current main; this plan's schema changes are no longer
   entangled with a month of undeployed work.
2. **DONE 2026-07-05** — Backup taken before the deploy:
   `~/backups/trippy-pre-h1-2026-07-05.db` (385KB, verified restorable). The **H2 backup
   cron** (Plan 3 leftover) is also now live: `~/trippy-backup.sh` on the host, `0 3 * * *`
   cron, ran once manually and verified (`~/backups/trippy-2026-07-05.db`, 430KB, opens and
   `SELECT COUNT(*) FROM trips` returns 2). Gate D's backup-first requirement for the Plan 6
   migration is satisfied by this nightly cron plus a fresh manual backup immediately before
   Wave 1's `013_day_stop_geography.sql` runs.

---

## Wave 1 — Schema additions and data inputs (COMPLETE 2026-07-06)

**Goal:** every ingredient the derivation needs exists in the database and in new extractions.
Additive only; nothing reads the new columns yet, so this wave is independently shippable.

### 1.1 Migration `013_day_stop_geography.sql`

```sql
ALTER TABLE days ADD COLUMN city_country TEXT;            -- ISO alpha-2 for the seeded city
ALTER TABLE days ADD COLUMN city_override_country TEXT;   -- ISO alpha-2 for the override, nullable
ALTER TABLE stops ADD COLUMN country_code TEXT;           -- resolver-reported place country
```

New migration file only — never modify 001–012 (CLAUDE.md). No index needed at this volume.

### 1.2 Extraction prompt: hotel/other country (owner decision 3)

In `backend/src/services/claude.js` extraction schema (~line 40), hotel/other `details` gains
`"countryCode": "ISO 3166-1 alpha-2" | null` beside `city`, with the same instruction style as
the existing transit `originCountryCode`/`destinationCountryCode` (line 39). Multilingual rule
(line 58) already covers city naming; countryCode needs no exonym handling.

### 1.3 Resolver country capture

- **Nominatim** already requests `addressdetails: '1'` (`placeResolver.js:390`): surface
  `place.address.country_code` (lowercase from OSM → uppercase) on the resolution object.
- **Google Places Text Search:** add `places.addressComponents` to the field mask
  (`placeResolver.js:476`) and extract the `country` component's `shortText`.
- Persist through: `formatResolution` gains `countryCode`; `writeCache`/`readCache` reuse the
  existing `place_resolution_cache.country` column for the *resolved* country when the row is
  written by a resolver (today it stores only the request bias — document the dual meaning in
  a comment, or add a `resolved_country` column if the subagent finds the overload confusing;
  either is acceptable, decide in-session).
- `applyResolutionFields` / stop INSERT+UPDATE statements in `stops.js` write
  `stops.country_code`. Booking-driven stops (`bookingPlaceLocation`,
  `syncStopWithBooking`) take country from booking `detailsJson`
  (`destinationCountryCode`/`countryCode`) when the resolver reports none.

### 1.4 Paired seeds at trip creation

- `POST /trips` accepts `destinations: [{ city, countryCode? }]` (keep accepting the legacy
  string-array shape during Waves 1–3; normalize internally to pairs).
- `createTrip` writes `days.city_country` from the first destination's country; date
  extensions in `updateTrip` seed from the **adjacent day's pair** (start-extension: first
  day's; end-extension: last day's) — this fixes the review's end-extension defect
  (`trips.js:403` seeding `destinations[0]`).
- `NewTripModal.handleSubmit` stops flattening chips (`NewTripModal.jsx:168-169`) and sends
  the pairs it already builds. Hotel-only captures now get chip countries too once 1.2 ships.

**Wave 1 tests:** migration idempotence; extraction fixture with a hotel email asserting
`countryCode` lands in `detailsJson`; resolver tests asserting `countryCode` on Nominatim and
Google paths (mocked payloads); createTrip pair persistence; extension seeding from adjacent
day.

---

## Wave 2 — Derivation and backend consumers (COMPLETE 2026-07-06)

**Goal:** one function answers "where is the traveller on this day", and every backend
country-sensitive decision consults it.

### 2.1 `deriveDayGeo`

Extend `deriveDayCity` (`trips.js:147`) to return `{ city, countryCode }`, layers unchanged:

1. Override → `city_override` + `city_override_country`.
2. Active hotel → `detailsJson.city` + `detailsJson.countryCode` (new).
3. Last same-day transit arrival → `destinationCity` + `destinationCountryCode` (already
   extracted today, currently discarded).
4. Previous day → carries the full pair.
5. Seed → `days.city` + `days.city_country`.

A layer that yields a city but no country still wins on city; country then falls through to
the next layer that has one (document this in the function comment — city and country may
come from different layers, which is correct: "override says Melaka, hotel says MY").
`listDaysForTrip` exposes `resolvedCity` (unchanged name) and `resolvedCountry`.
**Consistency fix:** `GET /trips/:tripId/days` (`routes/days.js:12`) must load bookings before
calling `listDaysForTrip`, ending the two-meanings-of-`resolvedCity` split (review §1.1).

### 2.2 Provider selection

- `mapConfig.js`: refactor to `getMapConfigForCountry(countryCode, options)` — the existing
  CN/KR/default branches, minus the array scan. Keep a thin
  `getMapConfig(countries)` wrapper (CN > KR > default across the set) as the trip-level
  fallback used where no day context exists.
- `getTripMapData` (`mapData.js`): compute day geo (bookings are already loaded there),
  return per-day config — recommended shape, additive to the current one:

  ```json
  {
    "mapConfig": { ...trip-level fallback, unchanged shape... },
    "mapConfigByDay": { "<dayId>": { ...same shape... } },
    "segments": [...],
    "stops": [...]
  }
  ```

  Each stop's display conversion (`toDisplayCoordinates`) uses **its own day's** config.
  Each stop gains `deepLinkProvider`: from `stops.country_code` if set, else its day's
  country (Option C over A).
- `GET /map-config` (`routes/map.js`): same additive shape — top-level `mapConfig` key must
  keep its exact current shape because the PWA caches this route StaleWhileRevalidate for 7
  days (`vite.config.js:70-86`) and `useMapConfig.js:13` reads `data.mapConfig`. Do not
  rename the endpoint (review §8.6).

### 2.3 Geocoding bias

New helper `getDayGeo(dayId)` (loads day + trip bookings, runs derivation — cheap at this
scale) used by `resolveLocationForStop` callers so city bias = derived city and country bias =
derived country, replacing seeded `day.city` and `destination_countries[0]`
(`stops.js:90-97,166`). `repairTripStopLocations` gets the same treatment. Keep
`input.locationCity`/`input.locationCountry` as explicit-caller overrides (discovery passes
them).

**Wave 2 tests:** the review §9 fixture matrix is the spec — CN-only regression anchor
(identical behavior before/after), KR-only, CN+KR (Seoul day: wgs84 target + Naver links +
unshifted pins; Chengdu day: gcj02 + AMap + shifted), MY→SG→CN→MY (Penang pin NOT shifted on
its MY day; per-day geocode bias), missing-country trip (null-country day falls through;
later transit import upgrades the day). Bbox unit tests: KL/Singapore/Tokyo outside; Penang/
Seoul inside.

---

## Wave 3 — Frontend consumers and the destination editor

### 3.1 Map tab (already day-scoped — review §2.3)

`useMapData` surfaces `mapConfigByDay`; `MapTab` selects `mapConfigByDay[activeDayId] ??
mapConfig`. `TripMap` must remount its `TileLayer` when `tileProvider` changes across a
day-switch (key the layer or container by provider). Pin correction (`MapTab.jsx:104`) stores
`coordinateSystem` from the **active day's** config — closes Q2-06 at the source. Stop
markers use the per-stop `deepLinkProvider` from the payload instead of the trip-wide one
(`TripMap.jsx:204`).

### 3.2 Today tab

`TodayTab` resolves the active date's day config from the map-config/map-data payload and
passes it down; `NavigateIcon` keeps its API. **Update
`frontend/src/utils/coordinates.js` in the same commit as any backend conversion change** —
its header comment mandates the twin files move together (review §8.6). Its
`toDisplayCoordinates` needs no formula change, only the per-day `mapConfig` being passed in.

### 3.3 Destination editor (owner decision 1 — same phase)

- `EditTripModal` gains the `DestinationChipPicker` used by `NewTripModal` (reuse, don't
  fork — CLAUDE.md "check before you assume"), pre-filled from the derived trip summary.
- `updateTrip` accepts destination pairs. **Edit semantics (from review §2.2):** editing the
  chip list rewrites the *seed layer only* — for each day without an override whose seed
  `city` matched a removed/renamed chip, update `city`/`city_country`; days with overrides
  and all derivation layers above the seed are untouched. Reordering chips changes which pair
  seeds date extensions and the derived summary order; it never rewrites existing day seeds.
  This is deliberately conservative: the editor corrects identity (the S5 wrong-CN recovery
  path), it does not re-plan days.
- Day override UI (wherever `patchDayCityOverride` is invoked) gains a country: resolve via
  `countryCodeFromName` on the typed text's trailing segment, else a place lookup; PATCH body
  gains `cityOverrideCountry`.

### 3.4 Remaining consumers

- Discovery add-stop passes `locationCountry` from the active day's pair
  (`DiscoveryPanel.jsx:327` currently sends city only).
- AI import context (`importer.js:236-241`) includes country codes:
  "Trip destinations: Chengdu (CN), Chongqing (CN)."
- Share payload (`share.js`): `trip.destinations`/`destinationCountries` become derived from
  days (same field names/shapes); `mapDay` additionally exposes the resolved pair, and
  `ShareViewPage.jsx:117` prefers it — fixing the share view's seeded-city staleness
  additively.

**Wave 3 tests (as shipped, 2026-07-07):** editor semantics — rename retargets matching
non-override days only, reorder alone touches nothing, removal-with-no-replacement nulls the
seed country and keeps the city text (backend `trips.test.js`, 3 new cases); TileLayer remount
on provider switch (frontend `TripMap.test.jsx`) — asserts on the actual bug reading
react-leaflet's source surfaced (a stale `subdomains` array gets spliced into the new
provider's tile URL, e.g. AMap's numeric template getting OSM's `a/b/c` letter), not the
attribution staleness originally hypothesized, since attribution/url are already reactive in
react-leaflet regardless of key; share payload golden file — old fields byte-identical for a
single-country (Chengdu/CN) trip, `resolvedCity`/`resolvedCountry` additive
(`collaboration.test.js`). Baselines grew as required: backend 219→223, frontend 28→29.

**Manual browser pass (2026-07-07, production repo at `C:\Users\cchen362\Desktop\Trippy` —
not the stale OneDrive-synced copy):** verified against the real Chengdu–Chongqing trip (CN
regression anchor; no CN+KR fixture exists in this dev DB, so the mixed-country day-switch
path is unit-tested but not manually re-verified this session). Map tab loads, day-switch
(Chengdu → Chongqing) re-centers and re-tiles without console/server errors; Edit Trip opens
with `CHENGDU`/`CHONG QING` chips pre-filled from resolved per-day geography, and removing a
chip updates the picker live. Found and fixed in-session: Wave 2 had left `routes/map.js`
calling `getTripMapData` without importing it, 500-ing `GET /map-data` — the Map tab was
broken end-to-end on main until this fix (one-line import, `mapData.js` still exported the
function). Not manually verified: Today tab (trip is in the past relative to today's date, so
there's no "today" row to exercise), and the CN+KR/S5/S6 fixtures from the review's §9 matrix
(no such trip exists locally; covered by Wave 2's existing unit tests only).

---

## Wave 4 — Backfill, relabel, and legacy retirement

Two migrations, run in order, after Waves 1–3 are the deployed code:

### 4.1 `014_geography_backfill.sql` + companion script

SQL alone can't geocode; backfill runs as a migration-adjacent one-shot in the migration
runner's transaction:

1. **Day seed countries:** if a trip's legacy `destination_countries` has exactly one entry,
   stamp it on all that trip's days (`city_country`). Covers the Chengdu/Chongqing trip
   (`["CN"]`). If empty or multiple: resolve the seed city via `countryCodeFromName`, then
   the place-resolution cache, then leave NULL (precedence tolerates it). The KL trip
   (`[]`) resolves via lookup or ships NULL — either is acceptable; the editor (3.3) is the
   recovery path.
2. **Pin relabel (owner decision 4):** `UPDATE stops SET coordinate_system='wgs84' WHERE
   coordinate_system='gcj02'` **scoped to** stops whose day's resolved country ≠ 'CN'.
   Production cohort verified zero; statement stays as the safety net for any pre-migration
   local DBs.

### 4.2 `015_retire_trip_destination_arrays.sql` (owner decision 5)

`ALTER TABLE trips DROP COLUMN destinations; ALTER TABLE trips DROP COLUMN
destination_countries;` — supported (production SQLite 3.45.3 ≥ 3.35). Prerequisite grep:
zero remaining readers (`trips.js`, `share.js`, `stops.js`, `mapData.js`, `routes/map.js`,
`seed.js`, `importer.js` are today's list — review §1.1). Update `seed.js` /
`chengdu-chongqing.json` to seed paired day data instead. API responses keep serving
`destinations`/`destinationCountries` as derived fields — external shape is unchanged, which
is what makes single-release retirement debt-free at this user count.

**Wave 4 tests:** migration suite runs 001→015 on (a) an empty DB, (b) a copy of the
production DB snapshot — asserting trip detail, share payload, and map-data outputs are
semantically identical before/after for the two real trips. Gate D: the whole
backfill+relabel runs in one transaction; deploy step restores from `trippy-pre-plan6.db` on
any failure.

---

## Trust criteria (Gate D applied to this plan)

- Migrations 013–015 each atomic; 014's script work inside the runner's transaction.
- Production deploy order: backup → deploy → migrate → verify the two real trips render
  (Logistics, Map, Today, share link `share_links` token still resolves).
- No swallowed errors: backfill logs every trip/day it stamps and every stop it relabels.
- Baselines may only grow: backend ≥ 197, frontend ≥ 28 before merge of each wave.

## Sessions and sequencing

Waves 1+2 are one backend-focused session; Wave 3 one frontend-focused session; Wave 4 a
short closing session gated on 1–3 being merged. Each session: Sonnet subagent implements,
Fable reviews against the review doc's evidence, tests green before commit. Ops preconditions
(deploy main, backup cron) are a separate operational task and can proceed immediately —
they block only Wave 4's production rollout, not development.

## Exit criteria

- All §9 review-matrix fixtures green; CN-only behavior bit-identical (regression anchor).
- S5 (wrong country) and S6 (missing country) are recoverable in the UI end-to-end.
- Legacy columns dropped; API shapes unchanged; PWA/share verified against cached clients.
- Q3 unblock delivered: day identity available as `(city, countryCode)` for the discovery
  redesign to key on.
