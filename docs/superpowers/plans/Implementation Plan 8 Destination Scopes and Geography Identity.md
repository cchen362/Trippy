# Implementation Plan 8 — Destination Scopes and Geography Identity

**Status: DRAFT (2026-07-08) — awaiting owner approval. No implementation started.**

**Origin:**
[Destination Scope and Hotel Geography Review](../reviews/2026-07-08-destination-scope-and-hotel-geography-review.md)
(parent: [Region Destinations and Day-City Extraction](../reviews/2026-07-08-region-destinations-and-day-city-extraction.md),
[Q2 Geography](../reviews/2026-07-06-q2-trip-geography-and-map-architecture.md),
[Q3 Discovery](../reviews/2026-07-06-q3-discovery-personalization-and-shared-cache.md)).

**Goal:** separate the four jobs currently crammed into one city string — traveler-facing
destination identity, Discovery catalogue key, geocoding bias, and provider place identity —
while preserving hotel-driven day movement. Solves Bali, Kaohsiung, Chengdu-Chongqing,
Discovery pollution, stop-lookup bias, hotel naming, and canonical geography identity as one
model.

---

## 0. Verified facts this plan is built on (2026-07-08 code audit)

These were confirmed directly in source this session; later waves must not re-derive them.

1. **Trip destinations are derived, not stored.** `trips.destinations`/`destination_countries`
   columns were dropped in migration 015. `getTripDetail`/`listTripsForUser`/`share.js` compute
   them at read time from resolved day geography via `deriveTripDestinationsFromDays`
   (`backend/src/services/trips.js:250-256`). **Consequence: a read-time fix to day derivation
   heals day headers, trip summaries, Discovery defaults, and importer context retroactively,
   for existing production data, with no schema migration.**
2. **`deriveDayGeo` precedence** (`trips.js:185-224`): override → active hotel → last same-day
   transit → previous day → seed. City and country are picked **independently per layer**
   (`trips.js:220-223`) — e.g. override city "Melaka" + hotel country "MY" is intentional and
   must be preserved.
3. **Hotel geo lives only in `bookings.details_json`** (`city`, `countryCode`). There is no
   hotel-city column; the `days.hotel` column is unrelated free text. The hotel layer reads
   `detailsJson.city` through `canonicalCity` (`trips.js:150-152`).
4. **The Places hotel picker never stores a country code.** `lookupHotelDetails` returns
   `{placeId, name, address, city, tz, lat, lng}` — no `countryCode`, no components
   (`backend/src/services/lookups.js:152-161`) — yet `extractGeoFromBooking` reads
   `detailsJson.countryCode` (`trips.js:152`). Picker-created hotels currently contribute a
   city but **no country** to day derivation. Latent bug, fixed in Wave 3.
5. **The destination picker is hard-filtered to city types.**
   `includedPrimaryTypes: ['locality', 'administrative_area_level_2']` (`lookups.js:203`), and
   returns **display strings only** — no place ID, no ISO code (`lookups.js:217-220`). Bali
   (AAL1) can never appear. Trip chips then submit `countryCode: c.country`, where `country`
   is Google's secondaryText — a country **name**, not a code
   (`frontend/src/components/trips/DestinationChipPicker.jsx:11`,
   `NewTripModal.jsx:166`). Latent name-vs-code inconsistency, fixed in Wave 4.
6. **City-string canonicalization exists in four uncoordinated copies:** `CITY_ALIASES`
   (`backend/src/utils/airports.js:177-180`), `canonicalizeCity` — chengdu/chongqing only
   (`backend/src/services/placeResolver.js:427-433`), `normalizeText` twice
   (`placeResolver.js:134-143`, `stops.js:80-89`), and the Discovery route's own key folding
   (`backend/src/routes/discovery.js:162-166` — lowercase, NFD diacritic strip, remove
   spaces/apostrophes/hyphens/periods; **does not strip commas**, which is how
   `"Kabupaten Badung, Bali"` becomes a valid catalogue key). The frontend mirrors the folding
   in `useDiscovery.js:28-32`.
7. **Discovery catalogue**: `discovery_destinations` unique on `(city_key, country_code)`;
   `country_code` defaults to `''` so bare-city and country-qualified rows are distinct rows.
   TTL is **7 days** (`discovery.js:24`), not the 48 h CLAUDE.md still claims; the
   `discovery_cache` table from migration 005 is **dead** (zero readers/writers, never
   dropped). Migration 016's backfill wrote **raw un-normalized** `city_key`s
   (`016_discovery_catalogue.js:63-64`) — a second pollution source besides hotel fragments.
   No per-user state references catalogue rows (report/suppress is global), so key merges
   orphan nothing user-owned.
8. **Stop lookup bias** uses derived day geo (`stops.js:162-166`); the resolver cache key is
   `queryText|city|country` (`placeResolver.js:145-147`), so geography changes orphan cache
   rows harmlessly (they re-resolve). Photo queries still use the raw seed `day.city`, not
   resolved geo (`stops.js:355,426,776`).
9. **Divergences to reconcile while we're in here:** `mapData.js:49` segment labels use
   `city_override || city`, bypassing the 5-layer derivation; `extractGeoFromBooking` skips
   `ferry` entirely so ferries never move a day; every frontend surface inlines its own
   fallback chain, two with quirks (`AddPlaceModal.jsx:178` reverses to `city || resolvedCity`;
   `MapTab.jsx:35` redundantly prepends `cityOverride`).
10. **The IATA→city map** (`airports.js:4`, "extend freely") already maps `DPS: 'Bali'` and
    covers Chongqing/Chengdu/Taipei; it lacks `KHH: 'Kaohsiung'`.

---

## 1. Target model and data/API contract

### No new tables. The model is derived-first, matching the architecture the code already has.

The review sketched a `destination_scope` table with parent relations and bounds. The audit
shows we don't need it to solve any of the seven named problems: trip scopes already live as
day seeds (`days.city` + `city_country`), day identity is already derived per request, and
resolution anchors can be derived from booking evidence the same way. Persisting scopes would
add a second source of truth to keep in sync with day seeds — complexity with no consumer.
If a future feature needs bounds/parent scopes (e.g. "near here" Discovery), a table can be
introduced then without unwinding anything in this plan.

### The four roles and where each lives

| Role | Meaning | Where it lives |
|---|---|---|
| **Display scope** | What the traveler sees — day header, trip summary, importer context | Derived: `resolvedCity`/`resolvedCountry` (existing field names, now guaranteed scope-grade) |
| **Discovery scope** | Catalogue key for recommendations | Same value as display scope (minimum model), folded by one shared `canonicalGeoKey` |
| **Resolution anchor** | Narrow locality biasing POI/geocoding lookup | Derived: new `day.resolutionAnchor` from the active hotel's stored locality evidence |
| **Place identity** | Exact provider place of a hotel/stop | Existing `detailsJson.placeId`/`lat`/`lng`/`formattedAddress` (+ new `countryCode`, locality fields) |

### The promotion rule (the heart of the fix)

The hotel layer of `deriveDayGeo` may only contribute a **display city** when the candidate is
scope-grade. Ladder, evaluated at read time against the trip's own scopes:

1. **Trip match** — the hotel's city/scope evidence canonically matches one of the trip's
   destination scopes (distinct day seeds + overrides), after suffix folding ("Kaohsiung City"
   ≡ "Kaohsiung"). → promote to that scope. *Covers Bali (AAL1 "Bali" matches the trip chip)
   and Kaohsiung (trip chip matches even though the hotel says "Sinsing District" — no match,
   see rule 4) and Chengdu-Chongqing (Chongqing is a trip chip).*
2. **Locality** — the evidence is a Google `locality` (a real city). → promote, creating the
   scope on the trip if new. *Preserves auto-movement to cities not yet on the trip.*
3. **Known city** — no locality, but the AAL2/AAL1 value matches the curated known-city set
   (values of `IATA_CITY` + `CITY_ALIASES`). → promote. *Preserves China behavior (Chongqing
   via AAL2) even when the city isn't a trip chip.*
4. **Otherwise** — contribute **no display city**; the day falls through to transit/previous/
   seed layers (which hold the trip scope). The fragment is emitted as the day's
   **resolution anchor** instead. *`Kabupaten Badung` and `Sinsing District` land here.*

The hotel layer **always** contributes its `countryCode` when present (fact 2's independent
per-field selection is preserved), and **always** emits its locality evidence as the anchor —
promotion and anchor are not mutually exclusive.

Legacy bookings (only `detailsJson.city`, no components) run the same ladder using that string:
a polluted value fails rules 1–3 and demotes to anchor — **existing Bali/Kaohsiung trips heal
with no data rewrite**.

### Day response contract (additive)

```js
{
  ...day,                      // city, cityOverride, cityCountry — unchanged
  resolvedCity,                // unchanged name; now always scope-grade
  resolvedCountry,             // unchanged
  resolutionAnchor: {          // NEW, nullable
    label,                     // "Sinsing District", "Seminyak"
    countryCode,               // "TW"
    source                     // "hotel" (only source in minimum model)
  }
}
```

Both `GET /api/trips/:id/detail` and `GET /api/share/:token` carry it. Trip-level
`destinations`/`destinationCountries` keep their exact legacy shapes (see §5).

### Hotel booking `details_json` contract (additive)

```js
{
  // existing, unchanged: placeId, place, placeText, suggestionName, displayName,
  //                      formattedAddress, city, tz, lat, lng
  countryCode,                 // NEW — ISO alpha-2 from address components (fixes fact 4)
  locality,                    // NEW — Google locality longText, or null
  sublocality,                 // NEW — most specific sublocality/district, or null
  adminAreas: { aal1, aal2 },  // NEW — for the promotion ladder + anchor
}
```

`detailsJson.city` keeps being written (same extraction) for backward compatibility; the
derivation prefers the structured fields when present.

### Canonical identity

One backend module, `backend/src/utils/geoIdentity.js`:

- `canonicalGeoKey(label)` — extraction of the Discovery route's folding (fact 6), hardened to
  strip **all** non-alphanumeric characters (Unicode-aware: CJK preserved). Folds `ChengDu`,
  `Cheng Du`, `Cheng du` → `chengdu`. Used by the Discovery route, scope matching, and the
  frontend mirror.
- `scopesMatch(a, b)` — canonical-key equality after folding a conservative suffix list:
  `city`, `municipality`, `special municipality`, `metropolitan city`, `prefecture`. Nothing
  fuzzier (no substring matching — "Bali" must not match "Balikpapan").
- `knownCityLabel(label)` — membership in the set built from `IATA_CITY` values +
  `CITY_ALIASES` values. Extend the map with `KHH: 'Kaohsiung'` (and any other gaps found in
  testing) as part of Wave 1.
- Absorbs `placeResolver.canonicalizeCity` (its chengdu/chongqing special case becomes a
  trivial consequence of `canonicalGeoKey`).

The frontend keeps its mirrored `norm()` (`useDiscovery.js`) updated to the identical folding,
with a lockstep unit test on both sides sharing the same fixture list (no shared package
exists; mirrored fixtures are the honest minimum).

---

## 2. Phased sequence

Ordered so **new pollution stops in the first shipped wave**; everything after is enrichment.

| Wave | Contents | Ships alone? |
|---|---|---|
| **W1** | `geoIdentity.js` + IATA map extension + Discovery-route/`useDiscovery` folding swap | Yes (pure refactor + tests) |
| **W2** | Guarded promotion + `resolutionAnchor` in `deriveDayGeo`; propagate through detail/share/importer/mapData; ferry fix | Yes — **this is the pollution stopper and retroactive healer** |
| **W3** | Booking write path: hotel details return `countryCode` + components; clean hotel display names; "City" field → "Area / locality" | Yes |
| **W4** | Destination-scope picker (Bali selectable) + ISO-code chips | Yes |
| **W5** | Consumer alignment: stop-lookup anchor bias, Discovery add-stop country fix, shared frontend `dayDisplayLabel`, photo-query resolved city | Yes |
| **W6** | **Gated on separate owner decision:** polluted-data cleanup migration + dead-table drop + CLAUDE.md correction | After W1–W2 verified in production |

W1→W2 is the mandatory order (W2 consumes the helpers). W3–W5 are independent of each other
and can be re-sequenced; W4 is the most user-visible and closes the original "can't pick Bali"
symptom.

---

## 3. Backend changes by module

### `backend/src/utils/geoIdentity.js` (new) + `utils/airports.js` — W1
As specified in §1. `airports.js` gains `KHH: 'Kaohsiung'`; `canonicalCity` stays (alias
resolution is a different job from key folding) but its output feeds `scopesMatch`.

### `backend/src/routes/discovery.js` — W1
Replace the inline `cacheKey` computation (lines 162-166) with `canonicalGeoKey`. Behavior
identical for clean keys; polluted comma-bearing inputs now fold differently, which is fine
because W2 stops them from arriving at all (and W6 reconciles old rows).

### `backend/src/services/trips.js` — W2 (core)
- `extractGeoFromBooking` hotel branch: run the promotion ladder (§1). Needs the trip's scope
  labels — extend the signature to accept a precomputed `tripScopes` array (distinct seed
  cities + overrides, canonical-keyed). Callers `listDaysForTrip`, `getDayGeo`, and `share.js`
  build it once per trip. Also: add `ferry` to the transit branch (fact 9).
- `deriveDayGeo`: unchanged precedence; returns `{city, countryCode, resolutionAnchor}`.
  Anchor comes from the active hotel's `sublocality || locality || detailsJson.city` evidence
  (whichever is narrower than the promoted scope, else null).
- `listDaysForTrip` (line 607): stamp `resolutionAnchor` alongside `resolvedCity`.
- `deriveTripDestinationPairsFromDays` / `deriveTripDestinationsFromDays`: **no changes** —
  they consume healed resolved values.

### `backend/src/services/share.js` — W2
Same stamping as `listDaysForTrip` (it recomputes `deriveDayGeo` itself, lines 43-55).

### `backend/src/services/mapData.js` — W2
Segment labels (line 49) switch from `city_override || city` to the resolved geography that
`computeDayGeographies` (lines 131-148) already computes in the same file.

### `backend/src/services/importer.js` — no change needed
It already builds trip context from `resolvedCity`/`resolvedCountry` (lines 242-256), so W2
heals importer context automatically. Verify with a fixture, don't touch.

### `backend/src/services/lookups.js` — W3 + W4
- W3 `lookupHotelDetails`: request `addressComponents` classification and return
  `countryCode`, `locality`, `sublocality`, `adminAreas` alongside the existing fields.
  `extractCityFromAddressComponents` stays for the legacy `city` field.
- W4 new `lookupDestinationPredictions(input)`: two parallel Autocomplete calls — the existing
  city types, plus `['administrative_area_level_1']` (Google rejects mixing its special
  collections with other types, so two requests is the deliberate design, not a workaround).
  Merge: dedupe by `canonicalGeoKey`, rank exact/prefix label matches first, cities above
  regions at equal rank. Return `{label, countryCode, kind: 'city'|'region'}` with
  `countryCode` parsed from secondaryText via the existing `countryCodeFromName`
  (`utils/countries.js:66`). New route `GET /api/lookups/destinations`; keep `/cities`
  untouched until the frontend migrates, then retire it in the same wave.

### `backend/src/services/stops.js` — W5
`resolveLocationForStop` bias ladder becomes: explicit caller value → **day
`resolutionAnchor.label`** → `dayGeo.city` → seed (lines 162-166). Photo queries (lines
355/426/776) switch from raw `day.city` to resolved city. Resolver cache keys change for
anchor-biased lookups → old rows orphan and re-resolve; acceptable, bounded cost.

### `backend/src/services/bookings.js` — W3
No structural change; `normalizeDetailsJson` already passes new fields through verbatim.
Confirm with a test that the W3 fields round-trip.

---

## 4. Frontend changes by surface

### Add Booking modal — W3
(`components/logistics/AddBookingModal.jsx`, `bookingForm.js`)
- `handleHotelSuggestionSelect`: store the new detailsJson fields; **display name** prefers
  the Places details `place.name` (official property name) and only falls back to suggestion
  text when details are missing. Delete the append-city heuristic and its hardcoded city
  regex (`AddBookingModal.jsx:64`). Conservative suffix strip: remove a trailing token from
  the display name only when that token exactly matches a stored address component
  (`Xinyi District`, `Badung Regency`) — never otherwise, so brand names survive.
- The visible **"City"** field is relabeled **"Area / locality"** (DM Mono label, per design
  spec) and keeps writing `hotelCity`/`detailsJson.city` — it is now honest about being
  anchor evidence. Day movement is governed by the derivation, not this field.

### Destination picker — W4
(`components/logistics/CityInput.jsx`, `components/trips/DestinationChipPicker.jsx`,
`NewTripModal.jsx`, `EditTripModal.jsx`)
- Point at `/api/lookups/destinations`; render the `kind` as a small mono badge on region
  rows (`REGION`) so Bali-the-island is distinguishable from a city with the same name.
- Chips store `{label, countryCode, kind}`; submit payload keeps the `{city, countryCode}`
  wire shape but `countryCode` becomes a genuine ISO code (fixes fact 5's name-vs-code drift).
  `EditTripModal.deriveInitialChips` unchanged (already zips from resolved values).

### Day headers and geography readers — W5
- New `frontend/src/utils/dayGeo.js` with `dayDisplayLabel(day)` (`resolvedCity ?? city`) —
  adopted by `DayHeader.jsx:17`, `TodayTab.jsx:30`, `ShareViewPage.jsx:117`, `MapTab.jsx:35`
  (dropping its redundant `cityOverride` prefix — resolvedCity already reflects overrides),
  and `AddPlaceModal.jsx:32/178` (fixing the reversed chain at 178).
- Manual override UI unchanged (single field). The backend keeps auto-resolving the override's
  country; canonical matching makes casing/spacing variants converge downstream.

### Discovery — W2 (free) + W5
- Default destination heals automatically in W2 (it reads `resolvedCity`).
- W5: `handleAddToDay` uses `committedCountry` when the committed destination differs from the
  active day's scope (today it stamps `activeDay.resolvedCountry` onto stops added from a
  free-text search of a different city — `DiscoveryPanel.jsx:431,447`).
- `useDiscovery.norm` updated in lockstep with `canonicalGeoKey` (W1, mirrored fixtures).
- `SuggestionCard.jsx:80` "In trip" matching switches to the mirrored folding.

### Importer/capture UI — no change
Sends no geography today (verified); prefill derives from booking details and benefits from
W3's cleaner fields automatically.

---

## 5. Migration and compatibility

**Waves 1–5 require zero schema migrations.** All new booking fields live in `details_json`
(schemaless); all new day fields are derived response fields. Existing bookings heal at read
time via the legacy branch of the promotion ladder.

**Legacy response fields — preserved exactly:**
- Trip `destinations` (string[]) and `destinationCountries` (string[]) keep their shapes,
  including the known quirk that `destinationCountries` is `.filter(Boolean)`-ed and therefore
  not index-aligned with `destinations` when a city lacks a country (`trips.js:254`).
  Consumers zip them positionally (`EditTripModal.jsx:24-26`), so **do not change the quirk in
  this plan** — note it for a future contract version.
- Day `resolvedCity`/`resolvedCountry` keep their names; `resolutionAnchor` is additive and
  nullable. Share endpoint mirrors both.
- `POST /trips/:id/discover` request shape unchanged (`{destination, countryCode, more}`).

**W6 — data cleanup (separate gate, modeled on migration 020):**
- Merge/delete polluted `discovery_destinations`: the `kabupatenbadung|ID`-style hotel-fragment
  rows, raw un-normalized keys from the 016 backfill, and empty-country twins of resolved-country
  rows. Merging re-points `discovery_places.destination_id` and `discovery_generation_daily`,
  honoring the `(destination_id, normalized_name)` unique index (skip-dup, like `insertPlaces`)
  and summing daily counters on PK collision.
- Drop the dead `discovery_cache` table (005 legacy, zero references).
- Correct CLAUDE.md's "discovery_cache table (48h TTL)" line to describe the real catalogue
  (7-day TTL, `discovery_destinations`/`discovery_places`).
- Run only after W1–W2 have been verified in production (pollution stopped) — a cleanup before
  that would re-pollute.

**Deploy sequencing:** standard `/deploy` flow per wave; pre-migration DB backup only needed
for W6. W2 changes production-visible day headers on existing trips — that is the *point*, but
the owner should verify the Bali and Kaohsiung trips read correctly immediately post-deploy.

---

## 6. Verification plan

Baseline: backend 329 tests / frontend 36 tests, all green before each wave.

### Backend unit fixtures (W1–W2, the load-bearing set)

| # | Fixture | Expected |
|---|---|---|
| F1 | Chengdu-Chongqing trip (both chips), Chongqing hotel 9–13 Jun, `detailsJson.city: "Chongqing"` | Nights display `Chongqing` (rule 1); Discovery key `chongqing\|CN` |
| F2 | Chengdu-only trip, Chongqing hotel, no locality component (AAL2 only) | Nights display `Chongqing` (rule 3, known-city); scope auto-added |
| F3 | Bali trip (chip `Bali\|ID`), W Bali – Seminyak: no locality, AAL2 `Kabupaten Badung`, AAL1 `Bali` | Display `Bali` (rule 1); anchor `{Kabupaten Badung, ID}`; Discovery `bali\|ID` |
| F4 | Kaohsiung trip, Hotel Indigo: evidence `Sinsing District` only | Display `Kaohsiung` (fall-through to seed); anchor `{Sinsing District, TW}` |
| F5 | **Legacy booking** — only `detailsJson.city: "Kabupaten Badung"`, no components, trip seeded `Denpasar` | Display `Denpasar` (heals); anchor `Kabupaten Badung` |
| F6 | Override city `Melaka` (no country) + hotel country `MY` | `{Melaka, MY}` — independent per-field selection preserved |
| F7 | Ferry with `destinationCity` | Contributes transit geo (new) |
| F8 | `ChengDu` / `Cheng Du` / `Cheng du` / `chengdu` | One `canonicalGeoKey`; `scopesMatch("Kaohsiung City","Kaohsiung")` true; `scopesMatch("Bali","Balikpapan")` false |
| F9 | Stop resolution on an F4 day | Resolver receives anchor `Sinsing District`, country `TW`; Discovery still keyed `kaohsiung\|TW` |
| F10 | Importer context on the F3 trip | `Bali (ID)`, not `Kabupaten Badung (ID)` |

### Frontend tests
Plan/Today/Share headers render `dayDisplayLabel`; Discovery default = broad scope; add-stop
country follows committed destination; Add Booking shows clean hotel name with placeId intact;
picker shows Bali with a `REGION` badge and stores ISO code; folding fixtures mirrored with
backend.

### Manual browser verification (per repo rule: tests ≠ done)
At 375 px, on real production-shaped data: create a trip typing "Bali" (picker returns it),
add W Bali – Seminyak (headers stay Bali, hotel name clean, Discovery generates for
`bali|ID`), open the Kaohsiung trip (headers healed to Kaohsiung with **no data edit**),
regression-walk the Chengdu-Chongqing trip (movement intact), add a stop on a Kaohsiung day
and confirm the logged resolver params include the anchor, exercise a share link, and spot-check
`discovery_destinations` after each session for any new fragment-shaped key.

---

## 7. Risks and open decisions (recommended defaults)

1. **Behavioral trade-off (the one real regression risk):** an AAL2-only hotel city that is
   neither a trip chip nor in the known-city set will no longer move the day (it becomes
   anchor-only). Today it moves. **Recommend: accept.** The failure mode changes from "wrong
   label pollutes five surfaces" to "day keeps the trip scope, one manual override fixes it";
   the known-city set is trivially extendable when a real case appears. — *Decision: accept
   default unless owner objects.*
2. **Auto-create scopes from hotel evidence** (review decision #1): **yes**, via rules 2–3
   only — locality or known-city, never raw admin fragments.
3. **Hotel-name cleanup aggressiveness** (review decision #2): **conservative** — prefer
   Places `place.name`; strip a trailing token only on exact address-component match.
4. **Local/near-hotel Discovery** (review decision #3): **defer.** Anchors are plumbed but
   never drive Discovery in this plan.
5. **Override UX** (review decision #4): **keep the single day-header field**; canonicalize
   underneath. No "show as / resolve near" split until real usage demands it.
6. **Clean existing polluted data now?** (review decision #5): **flag now, W6 later.** Known
   set: `kabupatenbadung|ID` catalogue, `Sinsing District` day headers (heal via W2), raw 016
   backfill keys, empty-country twin rows, hotel names with admin suffixes (heal on next edit
   or W6 sweep).
7. **Key-folding change** hardens `canonicalGeoKey` to strip all punctuation — only
   pollution-shaped existing keys fold differently; W6 reconciles. Frontend/backend drift is
   guarded by mirrored fixture tests (no shared package — accepted duplication).
8. **Places API cost:** the scope picker doubles autocomplete calls per keystroke (two type
   filters). Mitigate with the existing debounce + session tokens (CLAUDE.md cost rule).
   Estimated impact is small (picker is used at trip creation only).
9. **Resolver-cache orphaning** when bias switches to anchors: harmless re-resolutions,
   one-time cost per stop, self-healing.

---

## Wave status

- W1 canonical identity: **not started**
- W2 guarded promotion + anchors: **not started**
- W3 booking write path + hotel names: **not started**
- W4 destination-scope picker: **not started**
- W5 consumer alignment: **not started**
- W6 data cleanup (gated): **not started — requires separate owner go-ahead after W1–W2 verify**
