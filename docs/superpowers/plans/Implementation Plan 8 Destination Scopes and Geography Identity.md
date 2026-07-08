# Implementation Plan 8 — Destination Scopes and Geography Identity

**Status: IN PROGRESS (2026-07-08) — W1 complete; W2 next.**
Owner has accepted risk #1's default (guarded demotion) contingent on the Wave 2 demotion
log confirming low real-world frequency. All six waves, **including W6 cleanup, are mandatory
for plan completion** — W6's gate is sequencing only, not a maybe.

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

These were confirmed directly in source this session; implementation sessions must not
re-derive them.

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
   (`frontend/src/components/trips/DestinationChipPicker.jsx:11`, `NewTripModal.jsx:166`).
   Latent name-vs-code inconsistency, fixed in Wave 4.
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
11. **`discovery.reset()` does not exist.** `TripPage.jsx:93` calls it after every
    trip-settings save, but `useDiscovery` exports only
    `{discover, showMore, getDestination, isAnyLoading}` (`useDiscovery.js:152`). The
    TypeError is thrown inside the try block, so **every settings save shows a false
    "Could not save trip settings." error** even though the PATCH succeeded. Fixed in W1.
12. **Migration 014 imports `deriveDayGeo`.** Its signature change must be
    backward-compatible (optional trailing param) — migrations are never edited (CLAUDE.md),
    and 014 must still run correctly on a fresh database.

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
   ≡ "Kaohsiung"). → promote to that scope's label. *Covers Bali (AAL1 "Bali" matches the trip
   chip) and Chengdu-Chongqing (Chongqing is a trip chip).*
2. **Locality** — the evidence is a Google `locality` (a real city). → promote. *Preserves
   auto-movement to cities not yet on the trip.*
3. **Known city** — no locality, but the AAL2/AAL1 value matches the curated known-city set
   (values of `IATA_CITY` + `CITY_ALIASES`). → promote. *Preserves China behavior (Chongqing
   via AAL2) even when the city isn't a trip chip.*
4. **Otherwise** — contribute **no display city**; the day falls through to transit/previous/
   seed layers (which hold the trip scope). The fragment is emitted as the day's
   **resolution anchor** instead, and the demotion is **logged loudly** (see 2.3) so real
   frequency is measured in production, not guessed. *`Kabupaten Badung` and
   `Sinsing District` land here.*

The hotel layer **always** contributes its `countryCode` when present (fact 2's independent
per-field selection is preserved), and **always** emits its locality evidence as the anchor —
promotion and anchor are not mutually exclusive.

Legacy bookings (only `detailsJson.city`, no components) run the same ladder using that string
(rule 2 unavailable — no component types): a polluted value fails rules 1/3 and demotes to
anchor — **existing Bali/Kaohsiung trips heal with no data rewrite**.

**Why the exposed surface is small** (owner asked; reasoned 2026-07-08): losing auto-movement
requires simultaneously (a) no same-day transit booking — flights/trains stamp the city via
layer 3 regardless of the hotel; (b) no Google `locality` on the hotel — true mainly for
Indonesian regencies, some Chinese prefecture addresses, rural/resort areas; (c) city not a
trip chip; (d) city not in the known-city set. The surviving profile is an overland,
unplanned side-trip to an un-chipped, no-airport city in a no-locality geography. Failure
mode: day keeps the previous scope until one manual override — versus today's failure mode of
a raw fragment polluting five surfaces. The W2 demotion log turns this from estimate into
measurement.

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
  sublocality,                 // NEW — most specific sublocality/district longText, or null
  adminAreas: { aal1, aal2 },  // NEW — longText values, for the ladder + anchor
}
```

`detailsJson.city` keeps being written (same extraction) for backward compatibility; the
derivation prefers the structured fields when present.

### Canonical identity — `backend/src/utils/geoIdentity.js` (specified fully in 1.1 below)

---

## 2. Orchestration model (how this plan is executed)

Per global working rules: **Fable/Opus orchestrates; Sonnet implements.**

- The orchestrator (Fable or Opus) runs each wave via `/implement-milestone`: reads this plan,
  writes precise task prompts, delegates to **Sonnet subagents**, reviews every diff, runs the
  browser QA itself, updates this plan's status lines, and commits. **Never spawn a Fable
  subagent.**
- **Max 2 Sonnet agents in flight**, always split so they cannot collide on files. The split
  per wave is prescribed in each wave's *Delegation* line below (typically backend-only vs
  frontend-only).
- Sonnet agents get: the wave's section of this plan verbatim, the §0 facts, and the fixture
  table. They do not re-derive design decisions; ambiguity comes back to the orchestrator,
  not into code.
- The orchestrator personally verifies in a real browser at 375 px before any wave is called
  done (repo rule: subagent self-reports and green tests do not count as verified).
- One commit per wave minimum; commit before the session ends, always.

Wave order: **W1 → W2 are strictly sequential** (W2 consumes W1's helpers, and W2 is the
pollution stopper). W3, W4, W5 are mutually independent and may ship in any order after W2.
W6 runs last, after W1–W2 are verified in production.

---

## Wave 1 — Canonical identity + Discovery folding + `useDiscovery.reset` (DONE 2026-07-08)

> **Completion notes (2026-07-08):** All four backend tasks + both frontend tasks shipped.
> Backend 329→352 tests, frontend 36→43, all green; build clean. Browser-verified at 375 px:
> settings save shows no false error and Discovery auto-refetches via `reset()`; a
> `POST /discover` for the spelling variant "Cheng Du" served a full catalogue cache hit
> (`cached: true`, 164 places) under the new folding. Deviations: (a) `knownCityLabel`'s set
> also includes `CITY_ALIASES` *keys* (e.g. "Saigon", "HCMC") — required so alias labels
> count as known cities; coherent with W2 rule 3, which displays `canonicalCity(evidence)`
> and resolves those same keys. (b) 1.2's production-city sweep is pending — production DB
> access wasn't available this session; only `KHH: 'Kaohsiung'` added (local dev cities
> Chengdu/Ipoh already covered). Run the sweep before or during W2.
> W6 inventory lead: local dev `discovery_destinations` shows the 016 backfill also left
> `last_generated_at = NULL` on all backfilled rows, and place rows hang off the
> empty-country twins (e.g. `chengdu|""` holds 164 places, `chengdu|CN` holds 0) — expect
> the same shape in production for 6.1.

**Goal:** one shared definition of "same place, same key" on both backend and frontend, and
the false-error bug on trip-settings save fixed. Pure refactor + additive helpers; no behavior
change for clean inputs.

### 1.1 `backend/src/utils/geoIdentity.js` (new)

```js
canonicalGeoKey(label)   // → string key
scopesMatch(a, b)        // → boolean
knownCityLabel(label)    // → boolean
```

- `canonicalGeoKey`: trim → lowercase → `normalize('NFD')` + strip combining marks (same as
  `discovery.js:163-165` today) → **strip all characters not `\p{L}`/`\p{N}`** (Unicode
  property escapes, `u` flag — CJK letters are `\p{L}` and survive; commas, parens, and all
  punctuation now fold, closing the `"kabupaten badung, bali"` gap). Folds `ChengDu`,
  `Cheng Du`, `Cheng du` → `chengdu`.
- `scopesMatch(a, b)`: true when `canonicalGeoKey` values are equal **after** removing one
  trailing suffix from this exact list (applied to each side independently, once):
  `city`, `municipality`, `special municipality`, `metropolitan city`, `prefecture`, `shi`.
  Suffix removal operates on the whitespace-tokenized label *before* folding (so
  "Kaohsiung City" → "Kaohsiung", but "Ho Chi Minh City" → **also folds to "Ho Chi Minh"** —
  acceptable: both sides fold identically, so matching still works; the suffix-stripped form
  is never displayed). **No substring or prefix matching** — "Bali" must not match
  "Balikpapan".
- `knownCityLabel(label)`: `canonicalGeoKey(label)` membership in a Set built at module load
  from `Object.values(IATA_CITY)` + `Object.values(CITY_ALIASES)` (import from
  `utils/airports.js`).
- Unit-test file carries the **shared fixture list** (F8 in §6) that the frontend mirror test
  (1.5) duplicates verbatim — the two lists are kept in lockstep by convention and code
  review; a comment in each points at the other.

### 1.2 `backend/src/utils/airports.js`

Add `KHH: 'Kaohsiung'`. Sonnet task: sweep the owner's production trips' cities (ask the
orchestrator for the list — do not guess) and propose any other missing majors; additions are
one-line map entries.

### 1.3 `backend/src/routes/discovery.js`

Replace the inline `cacheKey` computation (lines 162-166) with `canonicalGeoKey(destination)`.
`claudeDestinationBase`/`claudeDestination` composition unchanged. Identical output for clean
keys; comma-bearing polluted inputs now fold differently — W2 stops them arriving, W6
reconciles old rows.

### 1.4 `backend/src/services/placeResolver.js`

Delete `canonicalizeCity` (lines 427-433); its two call sites (400-401, 482-483) keep passing
the raw `city` into the query text — the chengdu/chongqing spacing fix is display-cosmetic
for geocoder queries and both spellings geocode identically (verify with the existing resolver
tests). If any test proves spacing matters to Nominatim hit-rate, keep a thin wrapper that
title-cases `canonicalGeoKey` output instead — decide from test evidence, not preference.

### 1.5 `frontend/src/hooks/useDiscovery.js` — folding mirror

Update `norm` (lines 28-32) to the exact 1.1 algorithm (Unicode property escapes are supported
in the Vite/browser baseline). Add the mirrored fixture test to the frontend suite.

### 1.6 `frontend/src/hooks/useDiscovery.js` — implement `reset()` (fact 11)

New `reset` callback: abort every in-flight controller in `abortRefs.current` (and clear the
map), clear `cacheRef.current` to `{}`, bump the existing re-render reducer. Export it in the
return object. `TripPage.jsx:93`'s existing call then works as intended (clear stale
category tabs after interest-tag edits). Test: saving trip settings no longer surfaces
"Could not save trip settings." and Discovery refetches with new tags.

**Wave 1 tests:** F8 fixture list both sides; discovery route key parity for clean inputs
(snapshot of `cacheKey` for a dozen real destinations, before vs after — must be identical);
`reset()` unit test (in-flight abort + cache clear).

**Delegation:** two Sonnet agents — backend (1.1–1.4) and frontend (1.5–1.6). No shared files.

**Verification (orchestrator):** run the app, save trip settings (no false error), open
Discovery on an existing destination (cache hit still instant — key unchanged).

---

## Wave 2 — Guarded promotion + resolution anchors (NOT STARTED)

**Goal:** the pollution stopper and retroactive healer. Backend-only. After this wave, no
provider fragment can become a day header, trip summary entry, Discovery default, or importer
context — and existing polluted trips heal at read time.

### 2.1 Trip scopes input

`deriveDayGeo` gains an optional 4th param: `deriveDayGeo(day, bookings, previousResolvedGeo,
tripScopes = [])` — optional so migration 014's existing import stays valid (fact 12).
`tripScopes` is an array of `{label, canonicalKey}` built once per trip from the distinct
day seeds (`days.city`) + overrides (`days.city_override`), keyed via `canonicalGeoKey`.
Build it in a small exported helper `buildTripScopes(days)` in `trips.js`, called by:

- `listDaysForTrip` (`trips.js:576-609`) — already loads all days first.
- `getDayGeo` (`trips.js:617-640`) — loads the trip's days for the replay; add scope build.
- `share.js` (`buildPublicTripDetail`, lines 43-55).
- `mapData.js` `computeDayGeographies` (lines 131-148).

### 2.2 `extractGeoFromBooking` hotel branch (`trips.js:150-152`)

Evidence selection: prefer structured fields when present —
`d.locality ?? d.adminAreas?.aal2 ?? d.adminAreas?.aal1`, tagging which type matched; legacy
fallback is `d.city` with type `unknown`. Then the ladder:

```
if evidence matches a tripScope (scopesMatch)        → city = that scope's label   (rule 1)
else if evidence type is 'locality'                  → city = evidence             (rule 2)
else if knownCityLabel(evidence)                     → city = canonicalCity(evidence) (rule 3)
else                                                 → city = null; log demotion   (rule 4)
```

Always: `countryCode = d.countryCode || null` (unchanged). Always: emit
`anchor = { label: d.sublocality ?? d.locality ?? d.city, countryCode }` when that label
exists **and** differs (by `canonicalGeoKey`) from the promoted city; else `anchor = null`.

Also in this function: add `ferry` to the train/bus branch (fact 9) — `destinationCity` +
`destinationCountryCode`, identical handling.

### 2.3 Demotion log (risk #1 measurement)

On rule 4: `console.warn('[geo] hotel city demoted to anchor', { tripId, bookingId,
demoted: evidence, tripScopes: labels })`. Production logs are the impact dataset for the
known-city map extension decision. (Fail loudly in dev, gracefully in prod — a warn, never a
throw.)

### 2.4 `deriveDayGeo` + stamping

Return `{ city, countryCode, resolutionAnchor }`. Layer precedence and per-field independence
untouched (fact 2) — the anchor comes only from the active-hotel layer regardless of which
layer wins the city. `listDaysForTrip` (line 607) and `share.js` (lines 43-55) stamp
`resolutionAnchor` next to `resolvedCity`/`resolvedCountry`. `getDayGeo` returns it for
stops.js (consumed in W5; additive until then).

### 2.5 `mapData.js` segment labels

`buildSegments`' `currentCity` (line 49) switches from `city_override || city` to the resolved
geography `computeDayGeographies` already produces in the same file (fact 9).

### 2.6 Explicitly not touched

`deriveTripDestinationPairsFromDays` / `deriveTripDestinationsFromDays` (they consume healed
resolved values — verify with F10, don't edit); `importer.js` (already reads resolved geo,
lines 242-256); Claude extraction prompt.

**Wave 2 tests:** fixtures F1–F8, F10 (§6). Plus: demotion warn fires on F4/F5; anchor is
null when it equals the promoted scope; ferry fixture F7.

**Delegation:** **one** backend Sonnet agent (this wave's files interlock; splitting invites
collisions). The orchestrator reviews the ladder implementation line-by-line — this is the
single riskiest diff in the plan.

**Verification (orchestrator):** local DB seeded with production-shaped Bali + Kaohsiung +
Chengdu-Chongqing trips: headers read `Bali`/`Kaohsiung`/`Chongqing` with zero data edits;
trip cards and share links show healed summaries; importer context string says `Bali (ID)`;
demotion warn appears exactly for the fragment bookings. 375 px pass on Plan/Today/Share.

---

## Wave 3 — Booking write path: components, country, clean hotel names (NOT STARTED)

**Goal:** new hotel bookings store scope-grade evidence (fixing fact 4's missing country),
and hotel display names stop absorbing district/regency text.

### 3.1 `backend/src/services/lookups.js` — `lookupHotelDetails`

Field mask already includes `addressComponents` (line 123). Extend the return object:
`countryCode` (reuse `extractCountryCodeFromAddressComponents`, line 179), `locality`
(longText of `locality` component), `sublocality` (most specific of
`sublocality_level_1` → `sublocality` → `neighborhood`, first present), `adminAreas:
{aal1, aal2}` (longText). Keep the legacy `city` field and its extractor untouched.

### 3.2 `frontend/src/components/logistics/AddBookingModal.jsx`

- `handleHotelSuggestionSelect` (lines 229-285): write the new `detailsJson` fields
  (`countryCode`, `locality`, `sublocality`, `adminAreas`) from the details response.
- **Display name rule:** `displayName = place.name` (official property name) whenever details
  succeed; suggestion text only as fallback when details are missing. **Delete**
  `hotelSuggestionName`'s append-city behavior and the hardcoded city regex (lines 62-70,
  incl. line 64) and the `isGenericHotelName` prefix heuristic (lines 72-77) — `place.name`
  makes both obsolete.
- **Conservative suffix strip** (only for the fallback path where suggestion text is used):
  if the name's trailing tokens exactly equal (case-insensitive) the longText of any stored
  address component (`Xinyi District`, `Badung Regency`), strip that one suffix; otherwise
  leave the name alone. Never strip on partial matches.
- Relabel the visible **"City"** field (lines 377-389) to **"Area / locality"** (DM Mono
  label per design spec — this is a label string change, no new styling). It keeps writing
  `hotelCity` + `detailsJson.city` in tandem; it is now honest about being anchor evidence.

### 3.3 `frontend/src/components/logistics/bookingForm.js`

`normalizeForm` hotel branch (lines 82-94) and `hydrateFormFromBooking` (lines 187-195): carry
`countryCode`/`locality`/`sublocality`/`adminAreas` through `detailsJson` untouched (spread
already does; add a test proving round-trip). No backend `bookings.js` change needed —
`normalizeDetailsJson` passes fields verbatim (verified); add the round-trip test anyway.

**Wave 3 tests:** details lookup returns the new fields (mocked Places payload incl. an
Indonesian no-locality address); modal stores them; display name = `place.name` for the
W Taipei / W Bali / Regent Canggu trio (review table); suffix strip fires only on exact
component match; round-trip through create → hydrate.

**Delegation:** two Sonnet agents — backend (3.1) and frontend (3.2–3.3). No shared files.

**Verification (orchestrator):** add W Bali – Seminyak and Hotel Indigo Kaohsiung via the real
modal (375 px): names read `W Bali - Seminyak` / `Hotel Indigo Kaohsiung...` clean, Area/
locality field shows the fragment, day headers unaffected (W2 guards), `details_json` in the
DB contains `countryCode` + components.

---

## Wave 4 — Destination-scope picker (NOT STARTED)

**Goal:** "Bali" is selectable at trip creation; chips carry real ISO codes.

### 4.1 `backend/src/services/lookups.js` — `lookupDestinationPredictions(input)`

Two parallel Autocomplete calls (Google rejects mixing its special collections with other
types — two requests is the design, not a workaround):

- Call A: existing `['locality', 'administrative_area_level_2']`.
- Call B: `['administrative_area_level_1']`.

Merge: dedupe by `canonicalGeoKey(label)` (call-A winner on tie); rank exact/prefix matches
on the query first, then call-A results above call-B at equal rank; cap at 8. Each result:
`{ label: mainText, countryCode, kind: 'city' | 'region' }` where `countryCode` is parsed
from secondaryText via the existing `countryCodeFromName` (`utils/countries.js:66`), null
when unparseable. Reuse one session-token pair per keystroke session if the current
autocomplete plumbing supports it (API cost rule) — check how hotel autocomplete does it and
match.

### 4.2 Route

`GET /api/lookups/destinations?q=` beside `/cities`. The frontend migrates in this same wave,
then **delete `/cities` and `lookupCityPredictions`** (clean build — no orphan endpoint).
Check for other `/cities` consumers first: audit found only `CityInput`, which is also used
for transit from/to fields — those move to `/destinations` too (city-kind results rank first,
so transit UX is unchanged).

### 4.3 Frontend picker

- `CityInput.jsx`: consume `{label, countryCode, kind}`; render `kind === 'region'` with a
  small `REGION` tag — DM Mono, cream at reduced opacity, **not gold** (gold stays reserved
  per accent discipline).
- `DestinationChipPicker.jsx:11`: store `{label, countryCode, kind}`;
- `NewTripModal.jsx:166` / `EditTripModal.jsx:53`: submit `{city: label, countryCode}` — same
  wire shape, `countryCode` now a genuine ISO code (fixes fact 5). Verify `createTrip`'s
  input normalization (`trips.js:372-380`) accepts it cleanly; if production `city_country`
  rows currently hold country *names* from the old path, note the finding in this plan for
  W6's inventory rather than patching ad hoc.

**Wave 4 tests:** merge/rank/dedupe unit tests (mocked Google payloads: "Bali" query returns
region-kind Bali ID; "Chengdu" returns city-kind; homonyms dedupe); chip submit shape; picker
renders REGION tag.

**Delegation:** two Sonnet agents — backend (4.1–4.2) and frontend (4.3). Coordinate the
response shape from this doc, not from each other's code.

**Verification (orchestrator):** at 375 px, create a trip typing "Bali" — selectable with
REGION tag, chip stores `ID`; create "Kaohsiung" — city result; transit from/to fields still
autocomplete cities normally.

---

## Wave 5 — Consumer alignment (NOT STARTED)

**Goal:** every consumer reads the role it should: anchors bias lookup, scopes drive
Discovery and display, and the frontend has one fallback chain instead of nine.

### 5.1 `backend/src/services/stops.js`

- `resolveLocationForStop` (lines 157-166): bias ladder becomes explicit caller value →
  **`dayGeo.resolutionAnchor.label`** → `dayGeo.city` → seed `day.city`; country similarly
  (caller → anchor country → `dayGeo.countryCode`). `getDayGeo` already returns the anchor
  (W2).
- Photo queries (lines 355, 426, 776 + backfill 610): switch raw `day.city` → resolved city
  (the anchor is deliberately *not* used for photos — broad scope imagery is wanted).
- Resolver-cache orphaning from changed bias keys: accepted, re-resolves once (fact 8).

### 5.2 `frontend/src/components/discovery/DiscoveryPanel.jsx`

`handleAddToDay` (lines 410-454): stop stamping `activeDay?.resolvedCountry` unconditionally
(lines 431, 447). Rule: if `committedDestination` differs (by mirrored folding) from the
active day's scope, use `committedCountry`; else keep `activeDay.resolvedCountry`. Fixes the
audit's cross-city country-mismatch flag.

### 5.3 `frontend/src/utils/dayGeo.js` (new) — `dayDisplayLabel(day)`

`day.resolvedCity ?? day.city ?? ''`. Adopt in: `DayHeader.jsx:17`, `TodayTab.jsx:30`,
`ShareViewPage.jsx:117`, `MapTab.jsx:35` (drop the redundant `cityOverride` prefix —
`resolvedCity` already reflects overrides), `AddPlaceModal.jsx:32` and `:178` (fixing the
reversed chain), `EditTripModal.jsx:16`. Keep each surface's own *empty-state* suffix
(`'Open day'`, `theme`, etc.) local — the helper standardizes the geo part only.

### 5.4 `frontend/src/components/discovery/SuggestionCard.jsx:80`

"In trip" matching uses the mirrored folding from 1.5 instead of its local normalization.

**Wave 5 tests:** stop-resolution fixture F9 (anchor reaches the resolver); add-to-day country
matrix (same-city vs searched-other-city); `dayDisplayLabel` unit tests incl. the two fixed
quirks; SuggestionCard match on casing variants.

**Delegation:** two Sonnet agents — backend (5.1) and frontend (5.2–5.4). No shared files.

**Verification (orchestrator):** on the Kaohsiung trip, add a stop on a hotel night and
confirm the logged resolver params include `Sinsing District`; Discovery a different city via
free-text and add a stop — country follows the searched city; Plan/Today/Share/Map headers
consistent at 375 px.

---

## Wave 6 — Data cleanup + doc debt (NOT STARTED — runs last, after W1–W2 verified in production)

**Mandatory for plan completion.** Gate is sequencing (cleanup before prevention would
re-pollute) plus one owner touchpoint: reviewing the inventory before destructive changes.

### 6.1 Inventory first (read-only, this session's output shown to owner)

Script (not a migration): dump `discovery_destinations` with place counts, flagging rows
where `city_key !== canonicalGeoKey(display_name)` (raw 016-backfill keys), fragment-shaped
keys (`kabupatenbadung|ID` etc.), and empty-country twins of resolved-country rows. Also
sample `days.city_country` for country *names* (W4 finding). Owner reviews the dump; the
default disposition below applies unless owner overrides per row.

### 6.2 Migration `021_canonicalize_discovery_keys.js` (modeled on 020)

Default dispositions:

- **Fragment-keyed rows** (hotel-address pollution): **delete** destination + cascading
  places/daily rows. The catalogue regenerates on demand for pennies; merging fragments into
  the proper scope would import unverified fragment-context places into a clean catalogue.
- **Raw un-normalized keys** (016 backfill): re-key to `canonicalGeoKey(display_name)`. On
  collision with an existing row: merge — re-point `discovery_places.destination_id` honoring
  the `(destination_id, normalized_name)` unique index (skip duplicates, keeping the
  lower-id row, same semantics as `insertPlaces`); sum `discovery_generation_daily` counters
  on PK collision; keep `MAX(last_generated_at)`; sum `generation_count`; delete the emptied
  row.
- **Empty-country twins**: merge into the resolved-country row, same merge rules.

### 6.3 Migration `022_drop_dead_discovery_cache.sql`

`DROP TABLE discovery_cache;` (005 legacy, zero readers — fact 7).

### 6.4 Docs

Correct CLAUDE.md's "cache discovery results in `discovery_cache` table (48h TTL)" to describe
`discovery_destinations`/`discovery_places` with the 7-day TTL. Update this plan and the
origin review's status lines to CLOSED.

**Wave 6 tests:** migration unit-tested against a fixture DB seeded with all three pollution
shapes + a collision case; idempotence (re-run is a no-op).

**Delegation:** one backend Sonnet agent for 6.1's script + 6.2/6.3 after the owner reviews
the inventory. Orchestrator runs the production deploy per the deploy skill, **with a fresh
pre-migration backup** (W6 is this plan's only destructive-migration deploy).

**Verification:** post-deploy `discovery_destinations` contains only canonical keys; Bali and
Kaohsiung catalogues serve; Discovery on a previously-merged destination is a cache hit.

---

## 5. Migration and compatibility

**Waves 1–5 require zero schema migrations.** All new booking fields live in `details_json`
(schemaless); all new day fields are derived response fields. Existing bookings heal at read
time via the legacy branch of the promotion ladder. W6 carries the plan's only migrations
(021/022), both cleanup-only.

**Legacy response fields — preserved exactly:**
- Trip `destinations` (string[]) and `destinationCountries` (string[]) keep their shapes,
  including the known quirk that `destinationCountries` is `.filter(Boolean)`-ed and therefore
  not index-aligned with `destinations` when a city lacks a country (`trips.js:254`).
  Consumers zip them positionally (`EditTripModal.jsx:24-26`), so **do not change the quirk in
  this plan** — note it for a future contract version.
- Day `resolvedCity`/`resolvedCountry` keep their names; `resolutionAnchor` is additive and
  nullable. Share endpoint mirrors both.
- `POST /trips/:id/discover` request shape unchanged (`{destination, countryCode, more}`).
- `deriveDayGeo`'s new `tripScopes` param is optional (fact 12 — migration 014 compatibility).

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
| F2 | Chengdu-only trip, Chongqing hotel, no locality component (AAL2 only) | Nights display `Chongqing` (rule 3, known-city) |
| F3 | Bali trip (chip `Bali\|ID`), W Bali – Seminyak: no locality, AAL2 `Kabupaten Badung`, AAL1 `Bali` | Display `Bali` (rule 1); anchor `{Kabupaten Badung, ID}`; Discovery `bali\|ID` |
| F4 | Kaohsiung trip, Hotel Indigo: evidence `Sinsing District` only | Display `Kaohsiung` (fall-through to seed); anchor `{Sinsing District, TW}`; demotion warn fired |
| F5 | **Legacy booking** — only `detailsJson.city: "Kabupaten Badung"`, no components, trip seeded `Denpasar` | Display `Denpasar` (heals); anchor `Kabupaten Badung`; warn fired |
| F6 | Override city `Melaka` (no country) + hotel country `MY` | `{Melaka, MY}` — independent per-field selection preserved |
| F7 | Ferry with `destinationCity` | Contributes transit geo (new) |
| F8 | `ChengDu` / `Cheng Du` / `Cheng du` / `chengdu` | One `canonicalGeoKey`; `scopesMatch("Kaohsiung City","Kaohsiung")` true; `scopesMatch("Bali","Balikpapan")` false; `"kabupaten badung, bali"` folds comma-free |
| F9 | Stop resolution on an F4 day (W5) | Resolver receives anchor `Sinsing District`, country `TW`; Discovery still keyed `kaohsiung\|TW` |
| F10 | Importer context on the F3 trip | `Bali (ID)`, not `Kabupaten Badung (ID)` |

### Frontend tests
Per-wave lists above; headline set: `dayDisplayLabel` adoption, Discovery default = broad
scope, add-stop country matrix, clean hotel names (review's three-name table), picker returns
Bali with REGION tag + ISO code, mirrored folding fixtures, `reset()` behavior.

### Manual browser verification (per repo rule: tests ≠ done; orchestrator runs this)
At 375 px, on real production-shaped data: create a trip typing "Bali"; add W Bali – Seminyak
(headers stay Bali, hotel name clean, Discovery generates for `bali|ID`); open the Kaohsiung
trip (headers healed with **no data edit**); regression-walk Chengdu-Chongqing (movement
intact); add a stop on a Kaohsiung day and confirm resolver params include the anchor;
exercise a share link; save trip settings (no false error); check backend logs for demotion
warns matching expectations; spot-check `discovery_destinations` after each session for any
new fragment-shaped key.

---

## 7. Risks and decisions

1. **Guarded demotion trade-off — ACCEPTED by owner 2026-07-08, with measurement.** An
   AAL2-only hotel city that is neither a trip chip nor a known city no longer moves the day.
   Exposure analysis (§1) says this needs an overland, unplanned side-trip to an un-chipped
   no-airport city in a no-locality geography — rare. The W2 demotion log measures real
   frequency; if production shows legitimate demotions, extend the IATA/known-city map
   (one-line entries), which is the intended tuning knob.
2. **Auto-create scopes from hotel evidence**: yes, via rules 2–3 only — locality or
   known-city, never raw admin fragments.
3. **Hotel-name cleanup aggressiveness**: conservative — prefer Places `place.name`; strip a
   trailing token only on exact address-component match.
4. **Local/near-hotel Discovery**: deferred. Anchors are plumbed but never drive Discovery in
   this plan.
5. **Override UX**: keep the single day-header field; canonicalize underneath.
6. **W6 cleanup**: mandatory, last, with one owner touchpoint (inventory review). Default
   dispositions specified in 6.2 so the decision is confirm/override, not open-ended.
7. **Key-folding change** hardens `canonicalGeoKey` to strip all punctuation — only
   pollution-shaped existing keys fold differently; W6 reconciles. Frontend/backend drift is
   guarded by mirrored fixture tests (no shared package — accepted duplication).
8. **Places API cost:** the scope picker doubles autocomplete calls per keystroke. Mitigate
   with the existing debounce + session tokens; picker is used at trip creation/edit only.
9. **Resolver-cache orphaning** when bias switches to anchors: harmless one-time
   re-resolutions, self-healing.

---

## Audit debt ledger — every defect found in the 2026-07-08 audits, and where it's fixed

| Defect (evidence) | Wave |
|---|---|
| `discovery.reset()` undefined → false error on every settings save (`TripPage.jsx:93`, `useDiscovery.js:152`) | W1 (1.6) |
| Four uncoordinated city normalizers (fact 6) | W1 (1.1–1.4) |
| Hotel picker stores no `countryCode` — hotel layer contributes no country (fact 4) | W3 (3.1–3.2) |
| Hardcoded city-name regex in hotel naming (`AddBookingModal.jsx:64`) | W3 (3.2) |
| Hotel names absorb district/regency text | W3 (3.2) |
| Picker can't return Bali; chips carry country *names* in `countryCode` (fact 5) | W4 |
| `mapData.js:49` segment labels bypass derivation | W2 (2.5) |
| Ferry never contributes day geo (`extractGeoFromBooking`) | W2 (2.2) |
| Discovery add-stop stamps wrong country after cross-city search (`DiscoveryPanel.jsx:431,447`) | W5 (5.2) |
| `AddPlaceModal.jsx:178` reversed fallback; `MapTab.jsx:35` redundant `cityOverride` | W5 (5.3) |
| Photo queries use raw seed `day.city` (`stops.js:355,426,776`) | W5 (5.1) |
| Polluted catalogue rows: fragments, raw 016 keys, empty-country twins (fact 7) | W6 (6.2) |
| Dead `discovery_cache` table (005) | W6 (6.3) |
| CLAUDE.md stale "discovery_cache 48h TTL" claim | W6 (6.4) |
| Possible country *names* stored in `days.city_country` (W4 finding, unconfirmed) | W6 (6.1 inventory) |
| `destinations`/`destinationCountries` positional misalignment (`trips.js:254`) | **Deliberately preserved** (§5) — future contract version |

---

## Wave status

- W1 canonical identity + folding + `reset()`: **DONE 2026-07-08** (352/43 tests green, browser-verified; see Wave 1 completion notes for two documented deviations)
- W2 guarded promotion + anchors + demotion log: **not started**
- W3 booking write path + hotel names: **not started**
- W4 destination-scope picker: **not started**
- W5 consumer alignment: **not started**
- W6 data cleanup + doc debt (mandatory, runs last): **not started**
