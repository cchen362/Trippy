# Q2 — Trip Geography and Map Architecture Review

**Status:** Completed review (2026-07-06) — **Gate A CLOSED**; all five owner questions answered (see parent doc). Implemented by [Implementation Plan 6](../plans/Implementation%20Plan%206%20Q2%20Geography%20Model.md).

**Parent:** [Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)

**Origin:** [Plan 4 Product Decision Q2](../plans/Implementation%20Plan%204%20UX%20Sweep%20Fixes.md#product-decisions-answered-by-owner-2026-07-05)

**Investigation session:** per [Implementation Plan 5, Workstream A](../plans/Implementation%20Plan%205%20Q2%20Investigation%20and%20Q1%20Draft%20Fix.md). No source or schema changes were made; all findings are code-trace evidence.

**Required companions:** [Q1 — Booking Classification](2026-07-06-q1-booking-classification-and-correction.md), [Q3 — Discovery](2026-07-06-q3-discovery-personalization-and-shared-cache.md)

**Related trust review:** [Trust, Reliability, and Operational Risk](2026-07-06-trust-reliability-and-operational-risk.md)

## Review question

What should be Trippy's authoritative representation of a trip's geography, and at what level
should country-specific map, coordinate, navigation, discovery and geocoding decisions be made?

**Answer in one paragraph:** the day is the correct unit of geographic identity, and the
mechanism already exists — `deriveDayCity` (`backend/src/services/trips.js:147`) resolves a
per-day city through a five-layer precedence that is proven in production. It is incomplete in
exactly two ways: it emits a city *string* with no country, and nothing that makes a
country-sensitive decision (map tiles, coordinate conversion, deep links, geocoding bias)
consumes it. The recommendation (§6) is to upgrade this mechanism to a structured
`{city, countryCode}` day identity, derive the trip destination summary from days, and select
providers from day/place country — Option A upgraded, with Option C for deep links.

---

## 1. Current behavior, with code and data-model evidence

### 1.1 The seven competing sources, traced

| # | Source | Written by | Read by |
|---|---|---|---|
| 1 | `trips.destinations` (JSON array of city strings) | `createTrip` only (`trips.js:286,304`). **Never updated afterwards** — `updateTrip` (`trips.js:337-421`) writes title/travellers/tags/pace/dates only, and `EditTripModal.jsx` has no destination fields. | Seeded day city default (`destinations[0] \|\| title`, `trips.js:290`); day rows created by date extension (`trips.js:371,403`); AI import trip context (`importer.js:236-241`); discovery last-resort default (`DiscoveryPanel.jsx:248`); share payload (`share.js:19`). |
| 2 | `trips.destination_countries` (independent JSON array of ISO codes) | `createTrip` only, normalized via `countryCodeFromName` (`trips.js:287-288`). Never updated afterwards. | Trip-wide map config (`mapConfig.js:21-61` via `routes/map.js:13-14` and `mapData.js:119-120`); geocoding country bias — **always element `[0]`** (`stops.js:90-97`, `stops.js:625-629`). |
| 3 | Seeded `days.city` | Day insertion at trip create/extend, always `destinations[0] \|\| title` (`trips.js:318-327,371-380,403-411`). | `deriveDayCity` layer 5; geocoding city bias for stop create/update (`stops.js:166` — see §1.3); Unsplash photo queries (`stops.js:347-353`); map segment labels (`mapData.js:49`); **public share view** (`share.js:34`, rendered at `ShareViewPage.jsx:117`). |
| 4 | `days.city_override` | `PATCH /trips/:id/days/:date` (`routes/days.js:18-26`, `trips.js:504-513`). | `deriveDayCity` layer 1; map segment labels (`mapData.js:49`); location-repair city (`stops.js:622`). **Not** read by stop-create geocoding (§1.3) or the share view. |
| 5 | Derived day city — `deriveDayCity` (`trips.js:147-177`): override → active hotel → last same-day transit arrival → previous day's resolved city → seeded `day.city` | Computed, not stored; attached as `resolvedCity` in `listDaysForTrip` (`trips.js:450-452`). | Discovery default destination (`DiscoveryPanel.jsx:248`); Map-tab pin-correction search bias (`MapTab.jsx:35`); co-pilot context via `getTripDetail` (`routes/copilot.js:77`). **Ignored by** map config, coordinate conversion, deep links, and stop geocoding. |
| 6 | Stop location metadata (`stops.lat/lng`, `coordinate_system`, `coordinate_source`, `location_status`) | Geocode chain (`placeResolver.js`), Google Places details, curated table, or user pin correction (`MapTab.jsx:98-113`). | Map rendering after display conversion (`mapData.js:92-115`); Today-tab deep links (`NavigateIcon.jsx:11-17`); share payload raw lat/lng (`share.js:53-54`). |
| 7 | Booking `detailsJson` geography | AI extraction schema (`claude.js:33-40`) emits `city`, `originCity`/`destinationCity`, **and `originCountryCode`/`destinationCountryCode` (ISO alpha-2)** for transit. | City fields feed `extractCityFromBooking` (`trips.js:119-135`) and capture prefill chips. **The country codes are consumed nowhere** except `NewTripModal.deriveTripPrefill` — which builds `{city, country}` pairs and then flattens them (§1.2). |

Two structural facts fall out of the trace:

- **Structured pairing already exists at both boundaries and is destroyed in the middle.**
  Capture-derived trip creation builds chronological `{city, country}` chips
  (`NewTripModal.jsx:25-57`), then `handleSubmit` splits them into two arrays and filters null
  countries (`NewTripModal.jsx:168-169`) — this is the exact mechanism that produces the
  unpaired, position-shifted arrays of finding Q2-01. Hotel/other chips always carry
  `country: null` because the extraction schema has no country field for lodging
  (`claude.js:40`), so any trip whose first booking is a hotel starts with
  `destinations[0]` ≠ `destination_countries[0]`.
- **The same field name means two different things.** `GET /trips/:tripId/days`
  (`routes/days.js:12`) calls `listDaysForTrip` without bookings, so `resolvedCity` on that
  endpoint is computed with layers 2–3 disabled (override → previous → seeded only), while
  `getTripDetail` (`trips.js:461-469`) computes the full five-layer value. The frontend exposes
  both (`tripsApi.js:7` vs. trip detail).

### 1.2 Which source is authoritative for each decision (the brief's table, answered)

| Decision | Source actually used today | Evidence | Day-aware? |
|---|---|---|---|
| Trip summary | `trips.destinations`, frozen at creation | `trips.js:286`, `updateTrip` omits it | — |
| Each calendar day | `resolvedCity` from `deriveDayCity` — but only on surfaces that read trip detail | `trips.js:147-177,450` | ✔ (display only) |
| Geocoding country bias | `destination_countries[0]` for **every stop on every day** | `countryForDay`, `stops.js:90-97`; repair path `stops.js:625-629` | ✘ |
| Geocoding city bias | Seeded `day.city` (raw row; `resolvedCity` is undefined on raw rows and `city_override` is not read) | `stops.js:166` | ✘ (weakest layer) |
| Map tile provider | Trip-wide: any `CN` → AMap, else any `KR` → Naver-links+MapTiler, else Google/MapTiler | `mapConfig.js:25-60` | ✘ |
| Coordinate conversion target | `mapConfig.coordinateSystem`, trip-wide | `mapData.js:120,93`; frontend twin `utils/coordinates.js:63-74` | ✘ |
| External navigation (deep links) | `mapConfig.deepLinkProvider`, trip-wide, on Map tab and Today tab | `TripMap.jsx:204`, `TodayTab.jsx:49-72`, `NavigateIcon.jsx:17` | ✘ |
| Discovery catalogue key | Normalized city string, no country | `routes/discovery.js:94-97`, `useDiscovery.js:28-32`; default from `resolvedCity` (`DiscoveryPanel.jsx:248`) | ✔ (default only) |
| AI import context | `trips.destinations` + trip dates; no countries | `importer.js:236-241`, `claude.js:74-75` | ✘ |
| Public share view | Seeded `days.city` only — no override, no derived city, no map config, raw stop lat/lng | `share.js:28-62` | ✘ |
| PWA-cached map config | `GET /trips/:id/map-config`, StaleWhileRevalidate, 7-day expiry | `vite.config.js:70-86` | ✘ (caches the trip-wide answer) |

There is no single authority: five decisions follow the frozen trip-level arrays, three follow
the (day-aware) derived city, and one follows the seeded day string — and the two trip arrays
cannot be corrected after creation through any UI or API path.

### 1.3 A subtlety worth naming: the geocoder ignores the derivation it sits next to

`resolveLocationForStop` picks its city bias as
`input.locationCity ?? input.city ?? day.resolvedCity ?? day.city` (`stops.js:166`), but every
caller passes the **raw DB day row** (`assertDayAccess`, `syncStopWithBooking` at
`stops.js:723-729`), which has no `resolvedCity` property and whose `city_override` column is
never read. So a stop added to a day whose derived city is Shanghai — but whose seeded city is
"Kuala Lumpur" — geocodes as "…, Kuala Lumpur" with Nominatim `countrycodes=my`. The parent
doc's verified fact ("the map layer ignores deriveDayCity") extends further: **the geocoding
layer ignores it too.** Note also that Nominatim's `countrycodes` parameter is a hard filter,
not a bias — a wrong country produces zero results, not worse-ranked ones — after which the
Google Places fallback applies `regionCode` as a soft bias (`placeResolver.js:392-394,467-469`).

### 1.4 The outside-China guard, precisely characterized (parent-doc nuance)

`isInChina` (`coordinates.js:9-12`, mirrored at `frontend/src/utils/coordinates.js:15-18`) is a
**rectangular bounding box**: lat 3.86–53.55, lng 73.66–135.05. It is not a China polygon.
Consequences, verified against the box:

| Place | Coordinates | In box? | On a GCJ-02 (China-including) trip |
|---|---|---|---|
| Kuala Lumpur | 3.14°N, 101.7°E | **No** (lat below 3.86) | Pin NOT shifted — parent nuance holds |
| Singapore | 1.35°N, 103.8°E | **No** | Pin NOT shifted |
| Penang | 5.42°N, 100.3°E | **Yes** | Pin **spuriously shifted** by the China distortion formula |
| Seoul | 37.57°N, 126.98°E | **Yes** | Pin **spuriously shifted** (~hundreds of metres) |
| Bangkok, Hanoi, Taipei, western Japan | — | **Yes** | Same spurious shift |
| Tokyo | 35.7°N, 139.7°E | No (lng above 135.05) | Not shifted |

So the parent doc's caution was correct in both directions: it is wrong to claim every
non-China pin is offset (KL and Singapore are protected), and it is *also* wrong to assume the
guard protects non-China places generally — most of East and Southeast Asia is inside the box.
AMap tiles are only GCJ-02-offset within mainland China; outside it they align with WGS-84, so
an in-box, out-of-China pin that gets converted lands visibly wrong on the very tiles the
config selected. The conversion itself is applied read-time only (`toDisplayCoordinates`,
`mapData.js:93`, `NavigateIcon.jsx:11`); storage stays in the system the resolver reported —
which is the right architecture to build on.

### 1.5 Pin correction stores the trip-wide coordinate system

`saveCorrection` (`MapTab.jsx:98-113`) stores the panned map centre with
`coordinateSystem: mapConfig.coordinateSystem`. On a China trip this is correct (AMap centre is
GCJ-02). On the *non-China days* of a China-including trip it writes a value that is labeled
`gcj02` but is actually a WGS-84 map position (AMap tiles outside China are WGS-84-aligned) —
data that stays subtly wrong even after provider selection is fixed. See migration §8.3.

---

## 2. Real user scenarios (code-trace analyses)

### 2.1 Mixed-country scenarios (Q2-02)

**S1 — Malaysia → Singapore → China → Malaysia** (e.g. KL → Singapore → Shanghai → Penang → KL)

- `destination_countries` contains `CN` → the whole trip gets AMap zh_cn tiles, GCJ-02
  conversion target, and `amap` deep links (`mapConfig.js:25-33`).
- Geocoding: every stop, including Shanghai ones, is Nominatim-filtered to
  `countrycodes=my` (`stops.js:90-97` takes element 0) → hard miss → billed Google Places
  fallback with `regionCode=MY`, which may resolve correctly or mismatch.
- Coordinates: KL and Singapore pins are outside the bbox — **not shifted** (nuance preserved).
  Penang pins are inside the bbox — **spuriously shifted** onto WGS-84-aligned Malaysian AMap
  tiles. Shanghai pins are correctly shifted for AMap.
- Deep links: KL/Singapore/Penang stops open in AMap — a provider-selection failure independent
  of coordinate accuracy, exactly as the parent doc frames it.

**S2 / S3 — China → Korea and Korea → China** (order is irrelevant: `upper.includes('CN')`
wins regardless of array position, `mapConfig.js:25`)

- The Korea branch is unreachable; Naver is never offered. Korean days get AMap tiles and
  `amap` deep links.
- Seoul is inside the bbox → every Korean pin is run through the China distortion formula and
  lands offset on tiles that are not offset in Korea. This is a *worse* outcome than S1's
  KL/Singapore case and is the strongest coordinate-level (not just provider-level) failure.
- A user who "fixes" a drifted Seoul pin via pin correction stores it as `gcj02`
  (§1.5), permanently mislabeling good WGS-84 data.

**S4 — China airport transit without an overnight stay**

Whether one connecting flight through PVG flips the entire trip's map stack depends solely on
whether the extraction stamped `destinationCountryCode: "CN"` on that leg and the transit chip
survived into the trip (`NewTripModal.jsx:33-37`). If yes: whole-trip AMap for a trip that
touches China for two hours. If no: Google/MapTiler, and the airport stop renders fine
(WGS-84 storage on WGS-84 tiles). A trip-level boolean is the wrong altitude for this decision;
a day-level one answers it naturally.

**S5 — Non-China trip with one incorrectly inferred `CN` code**

Whole trip silently becomes AMap/GCJ-02: zh_cn tile labels, `amap` deep links, and spurious pin
shifts for any stop inside the bbox (most of East/Southeast Asia). There is **no recovery
path**: destinations and countries are not editable after creation (§1.1 source 1), so the only
fix is delete-and-recreate the trip, losing days, stops, bookings and documents. This converts
a one-token extraction error into an unrecoverable trip-level defect.

**S6 — China trip whose imported hotel lacks a country**

Hotel chips carry `country: null` (`NewTripModal.jsx:38`), so a hotels-only China capture
produces `destination_countries: []` → Google/MapTiler/WGS-84. Coordinates and tiles actually
*align* (WGS-84 pins on WGS-84 tiles) — the failure is provider intent: Google deep links and
MapTiler detail in mainland China, no AMap. And because the arrays are frozen, importing a
train booking later (which does carry `destinationCountryCode`) can never upgrade the trip.

### 2.2 Edit-semantics scenarios (Q2-03)

The headline finding: **most of the brief's scenarios cannot happen today** — not because they
are handled, but because destination editing does not exist. `updateTrip` (`trips.js:337-421`)
silently ignores any destination input, and `EditTripModal.jsx` offers no destination fields.
That is the dead end that motivated Plan 4's Q2 in the first place.

| Scenario | Current behavior | Assessment |
|---|---|---|
| Add / remove / reorder a destination | Impossible via UI or API. Order still matters silently: `destinations[0]` seeds every day's city; `destination_countries[0]` biases every geocode. | The editor cannot be built safely on the current arrays — adding a chip would not re-seed days, re-bias geocodes, or re-select providers. |
| Change country but not city | Impossible. S5 shows why this is the single most needed correction. | — |
| Extend trip at start | New days seeded `destinations[0]` (`trips.js:371-380`). Layer-4 carry cannot help (no previous day). | Acceptable for start; first destination is a fair guess. |
| Extend trip at end | New days seeded `destinations[0]` (`trips.js:403-411`) — the *first* city, even if the trip ends elsewhere. Display self-heals via layer 4 (previous-day carry), but seeded `city` remains wrong for geocoding bias, photos, segment labels, and the share view, which all read the seeded string. | Concrete disagreement between surfaces today. |
| Insert a destination between existing days | No concept; approximated by per-day `city_override`, which the geocoder then ignores (§1.3). | — |
| Import a booking that implies a new city | `deriveDayCity` layers 2–3 pick it up: `resolvedCity`, discovery default, co-pilot context all update. Trip summary, map provider, geocoding country do not. | Half the app follows the booking; the country-sensitive half doesn't. |
| Manually override a day's city | Wins layer 1 for display, discovery and repair; ignored by stop-create geocoding and the share view. A string with no country — overriding "Seoul" onto a China trip changes no provider decision. | Override needs country identity to mean what users think it means. |
| Remove the booking that drove the derived city | Derivation recomputes on next read (nothing is stored): falls to previous-day carry or seeded city. Stops geocoded while the booking existed keep their coordinates — which is correct; they were real places. | The compute-on-read design degrades gracefully here. Worth preserving. |

### 2.3 What already works and must not be broken

- Five-layer `deriveDayCity` precedence is sound and production-proven; bookings are treated as
  *evidence* for day state, not authority — the right contract (see §7 Q1).
- Read-time coordinate conversion with per-stop `coordinate_system` provenance is the correct
  storage architecture; only the *selection* of the target system is at the wrong altitude.
- The Map tab is already day-scoped: `DayTabs` plus `stops.filter(dayId === activeDayId)`
  (`MapTab.jsx:59,181`). Per-day provider selection therefore requires **no multi-provider map
  canvas** — the UI renders one day at a time already.
- Today-tab deep links already convert per-stop with the same guard as the backend
  (`NavigateIcon.jsx:11`, `utils/coordinates.js:63-74`).

---

## 3. Severity and likely frequency

| Finding | Severity | Frequency | Reasoning |
|---|---|---|---|
| Q2-02 provider selection trip-wide (S1–S4) | High | Medium | Owner travels in Asia (seed trip is Chengdu/Chongqing); CN+KR and MY/SG/CN combinations are the natural next trips even though mixed-country is "not near-term". When it hits, navigation — the app's core promise on the ground — is wrong for entire days. |
| Bbox distortion of in-box non-China pins (S2/S3, Penang in S1) | High | Low–Medium | Only on China-including mixed trips, but the failure is silent coordinate corruption on the display path, plus permanent data poisoning via pin correction (§1.5). |
| S5 wrong-CN inference with no recovery | High | Low | One extraction error bricks a trip's map stack irreversibly. Low probability × very high cost. |
| Q2-01 unpaired arrays / null-country filtering | Medium (structural) | High | Happens on effectively every capture-created trip with a hotel-first itinerary; is the root cause that makes every country decision above unreliable. |
| Q2-03 no destination editing; surfaces disagree after booking-driven movement | High | High | Every real trip changes after creation; the end-extension and imported-city cases occur in normal single-country use, not just mixed trips. |
| Geocoding uses `countries[0]` + seeded city for all stops | Medium | Medium | Hard Nominatim misses push traffic to billed Google fallback (cost) and can mis-resolve; mostly invisible until a pin is wrong. |

---

## 4. Authoritative-data recommendation

One rule, applied everywhere: **the day owns geographic identity as a structured
`{city, countryCode}` pair, derived (not stored) through the existing five-layer precedence;
everything else is derived from days or from a more specific resolved place.**

- **Trip summary** = derived, ordered, de-duplicated list of day pairs. `trips.destinations` /
  `destination_countries` stop being authorities and become a write-through legacy projection
  until removed (§8.4).
- **Bookings** remain *evidence* consumed by derivation layers 2–3 — never direct authority.
  This keeps Q1's contract clean: correcting a booking type changes evidence, and derivation
  recomputes (§7).
- **Manual overrides** remain the top layer but become structured (city + resolvable country).
- **Stops** are the most specific authority for their own point: where a resolution reports a
  country (Nominatim `addressdetails`, Google Places — both already return it and we discard
  it), the stop's country outranks the day's for that stop's deep link.
- **Provider decisions** read the narrowest available authority: deep link ← stop country, else
  day country; tiles/conversion target ← day country; geocoding bias ← day pair; discovery
  key and AI-import context ← day pairs.

## 5. Design options

### Option A (upgraded) — per-day structured geography via the existing derivation

Make `deriveDayCity` return `{city, countryCode}` (call it `deriveDayGeo`), keeping the
five-layer precedence intact. Country per layer:

1. **Override** — structured override, country resolved via `countryCodeFromName` /
   place lookup at write time.
2. **Active hotel** — `detailsJson.city` today has no country; extend the extraction prompt
   schema (`claude.js:40`) with `countryCode` for hotel/other (prompt change, not a DB
   migration), with Places-details country as fallback for autocomplete-created hotels.
3. **Transit arrival** — `destinationCountryCode` **already exists** in the schema
   (`claude.js:39`); it is collected today and simply dropped.
4. **Previous day** — carries the pair.
5. **Seeded** — trip creation stops flattening the capture chips (`NewTripModal.jsx:168-169`)
   and persists paired seed data.

Trip destinations become a derived summary; map config becomes `getMapConfig(dayCountry)`
computed per day (the Map tab is already day-scoped, §2.3); Today tab uses its single date's
day; geocoding uses the day pair.

*For:* smallest distance from working code; every needed ingredient already enters the system;
no new stored entity to keep consistent; compute-on-read degrades gracefully (§2.2 last row).
*Against:* derivation must stay cheap (it is: in-memory over already-loaded bookings); day-level
granularity cannot express two countries in one day — which is exactly what stop-level link
selection (Option C) covers.

### Option B — dated trip segments

A `trip_segments` table with start/end dates and city/country identity; days inherit.

*For:* makes movement first-class and queryable; natural home for a future "route editor" UI.
*Against:* introduces a **second stored representation of facts bookings already encode**,
recreating the disagreement class this review exists to eliminate (segment says Seoul, hotel
booking says Busan — who wins, and what reconciles them?). Requires schema, migration,
reconciliation rules and a new editing surface, while replacing a working mechanism.
`deriveDayCity`'s layers already produce exactly what segments would store, continuously and
without reconciliation. Per the orchestrator's provisional view, B needs stronger justification
than any evidence found here provides; nothing in the trace requires a stored segment to fix.

### Option C — stop/place-level provider selection

Choose deep-link behavior from each resolved place's country (persisted at resolution time).

*For:* deep links are genuinely per-place decisions (a day-trip across a border, an airport on
the frontier); resolvers already return the country. *Against (alone):* does nothing for tile
provider, conversion target, geocoding bias, destination editing, or day identity — it cannot
be the model, only the finest layer of it.

## 6. Recommended option and rejected alternatives

**Recommended: Option A upgraded, with Option C for deep links** — agreeing with the
orchestrator's provisional view, now backed by four pieces of evidence:

1. The Map tab already renders one day at a time (`MapTab.jsx:59`), so per-day tiles/conversion
   need no multi-provider canvas work.
2. Transit country codes are already extracted (`claude.js:39`) — layer 3 needs zero new data.
3. The capture UI already builds `{city, country}` pairs (`NewTripModal.jsx:25-57`) — layer 5
   needs un-flattening, not new collection.
4. The five-layer precedence already handles the hard edit-semantics cases correctly where it
   is consulted (§2.2) — the fix is to make everyone consult it.

This satisfies the owner constraint (parent doc, decision 3): day-level city/country identity
with provider selection derivable from it, no dominant-country shortcut in the data model.
Provider-*switching UI* (e.g. a per-day tile source indicator) can phase in later; the model
carries no debt because the trip-wide answer is just the degenerate case of the per-day one.

**Rejected:**

- **Option B** — replaces a working mechanism with a second source of truth requiring
  reconciliation; no traced failure needs it (full argument in §5).
- **Option C alone** — fixes one consumer out of nine (§1.2).
- **Dominant-country / "primary country" field** — explicitly rejected by owner decision 3; the
  trace confirms it would leave S1–S4 broken by construction.
- **Storing resolved day geography as columns** — rejected for now; compute-on-read is what
  makes booking removal degrade gracefully (§2.2). Revisit only if profiling ever shows the
  derivation on the hot path (it runs over already-loaded rows today).

## 7. Dependencies on other reports

- **Q1 (booking classification):** Q2 defines bookings as *evidence*, not authority (§4). Type
  correction (draft fix shipped per Plan 5 Workstream B) changes which derivation layer a
  booking feeds — e.g. hotel→other removes it from layer 2 — and derivation recomputes with no
  reconciliation needed. Persisted conversion stays deferred (owner decision 2); nothing here
  reopens it.
- **Q3 (discovery):** blocked on this model by design (owner decision 5). The day pair gives
  discovery a stable `(city, countryCode)` identity; today's country-less cache key collides
  homonyms (e.g. Georgetown MY vs. Georgetown GY) and cannot carry country context into
  generation. Q3 should key and prompt on the pair — this is the concrete Gate A input Q3 waits
  on. Discovery's *default* already follows `resolvedCity` (`DiscoveryPanel.jsx:248`), so the
  wiring point exists.
- **Trust:** the migration in §8 is a bulk reconciliation of trips/days/stops and must meet the
  Gate D baseline (atomic transaction, backup-first, tested against existing trips). The
  share/PWA compatibility constraints in §8.5–8.6 are Trust-adjacent commitments.

## 8. Migration and backward-compatibility risks

### 8.1 Existing trips with unpaired or empty country arrays

Backfill pairs at migration time: for each `destinations[i]`, resolve a country via
`countryCodeFromName`, existing booking `detailsJson` country codes, or a one-shot geocode of
the city name. Unresolvable cities keep `countryCode: null` — legal in the model (day falls
back through precedence; provider selection for a null-country day uses the trip's other days,
else the default provider). **Risk:** a wrong backfilled country reproduces S5 per-day; the
destination editor (which this model finally makes possible) is the recovery path, and should
land in the same phase as the migration.

### 8.2 Seeded days

`days.city` rows stay untouched (they remain layer 5). `city_override` strings remain valid;
their country resolves lazily. No day-table schema change is strictly required for the derived
model; a stop-level `country` column is the one worthwhile schema addition (owner question 2).

### 8.3 Coordinate provenance under provider re-selection

Stored `coordinate_system` values remain valid because conversion is read-time. Two poisoned
cohorts need a repair pass, not a bulk rewrite:

- Pins saved via correction on non-China days of China-including trips: labeled `gcj02` but
  actually WGS-84 map positions (§1.5). Detectable as `gcj02` stops whose day-country is not CN
  after migration; fix by relabeling to `wgs84` — safe because AMap tiles outside China are
  WGS-84-aligned, so the stored numbers *are* WGS-84.
- Stops a user "corrected" to compensate for the bbox shift (S2/S3): not automatically
  detectable; leave, and let re-correction on the now-properly-configured day fix them
  (volume is expected to be near zero — mixed trips haven't shipped to users yet).

### 8.4 Legacy columns

Keep `trips.destinations`/`destination_countries` as a write-through projection (updated
whenever days change) for one release cycle: the share payload, PWA-cached trip details, and
any stale clients keep reading coherent values. Drop via a later migration once nothing reads
them (new migration file; never edit existing ones, per CLAUDE.md).

### 8.5 Share links

The public payload exposes `trip.destinations`, `destinationCountries`, and seeded `day.city`
(`share.js:19,34`). Changes must be additive: keep those fields (fed by the projection), add
the resolved day pair. Note the share view currently shows the *seeded* city, so it already
disagrees with the owner's view on booking-moved days — the migration is an opportunity to fix
that, additively.

### 8.6 PWA-cached map config

`/api/trips/:id/map-config` is cached StaleWhileRevalidate for 7 days (`vite.config.js:70-86`).
Constraints: (a) the response must stay shape-compatible — keep the top-level `mapConfig`
object as the trip-level fallback and add a per-day structure alongside it; (b) after
migration, a client can serve week-old trip-wide config for up to one more request cycle —
acceptable because SWR refreshes in the background; do not rename the endpoint (that would
strand the old cache rather than revalidate it). The frontend coordinate twin
(`utils/coordinates.js`) must gain the same per-day target selection in the same change as the
backend, or Today-tab deep links and Map-tab pins will disagree — the exact bug class the twin
was built to prevent (its header comment says update both together).

## 9. Verification strategy

**Unit — bbox and conversion (the nuance, encoded as tests):**
- `isInChina`: KL (3.14, 101.68) false; Singapore (1.35, 103.82) false; Penang (5.42, 100.33)
  true; Seoul (37.57, 126.98) true; Tokyo (35.68, 139.69) false.
- `toDisplayCoordinates`: wgs84 stop + wgs84 target → untouched, for coordinates inside and
  outside the box; gcj02-stored stop never double-converted (both backend and frontend twins).

**Fixture matrix (backend service tests):**

| Fixture | Must assert |
|---|---|
| China-only (Chengdu/Chongqing seed) | AMap/GCJ-02 on every day; behavior identical before/after migration (regression anchor). |
| Korea-only | Naver deep links, MapTiler tiles, no conversion anywhere. |
| CN + KR | Seoul day: WGS-84 target, unshifted pins, Naver links. Chengdu day: GCJ-02, shifted pins, AMap links. Per-stop link override where stop country is known. |
| MY → SG → CN → MY | Penang day pins NOT shifted (post-fix); geocoding uses each day's country, not `countries[0]`; per-day tile provider. |
| Missing-country China hotel trip | Null-country day falls through precedence; later transit import with `destinationCountryCode` upgrades the day (S6 becomes recoverable). |
| Wrong-CN inference | Destination/country correction via the editor re-derives days and providers (S5 becomes recoverable). |

**Edit-semantics tests:** end-extension days derive from previous-day carry rather than
`destinations[0]`; override with structured country changes that day's provider; removing the
driving booking reverts derivation (already the behavior — pin it with a test).

**Compatibility tests:** share payload golden-file (old fields byte-stable, new fields
additive); map-config response consumed by the pre-change frontend hook shape
(`useMapConfig.js:13`); migration idempotence and atomicity against a copy of the production DB
(Trust baseline).

**Manual 375px pass:** CN+KR fixture on the Map tab — day-switch flips tile provider without
remount errors; Today tab on a Seoul date opens Naver; pin correction on a Seoul day stores
`wgs84`.

## 10. Open product questions requiring owner input

1. **Editor scope for Gate A sign-off:** ship the destination/country editor in the same phase
   as the model migration (it is the recovery path for backfill mistakes, §8.1 — recommended),
   or model-first with the editor as a fast follow?
2. **Stop-level country column:** persist resolver-reported country on stops (one additive
   migration; enables per-place deep links, Option C) — approve now or defer to a later phase?
3. **Extraction schema addition:** add `countryCode` to hotel/other details in the extraction
   prompt (`claude.js:40`) so layer 2 carries country — approve? (Prompt-only change; improves
   S6 and layer-2 quality; slight prompt-length cost.)
4. **Poisoned-pin repair (§8.3):** silently relabel detectable `gcj02`-mislabeled pins during
   migration, or surface a per-trip "re-check pins" action? (Trust review may want a say.)
5. **Legacy column retirement:** accept the write-through projection for one release then drop,
   or keep the arrays indefinitely for share/PWA conservatism?

---

## Cross-cutting findings fed back to the parent register

Registered in the parent doc alongside Q2-01…03: **Q2-04** (geocoding bias uses
`destination_countries[0]` for every stop and the seeded — not derived — day city),
**Q2-05** (the outside-China guard is a bounding box containing Korea and most of Southeast
Asia, so in-box non-China pins are spuriously shifted on GCJ-02 trips), and **Q2-06**
(pin correction stores the trip-wide coordinate system, mislabeling corrections made on
non-China days of China-including trips).
