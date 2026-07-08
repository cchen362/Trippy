# Destination Scope and Hotel Geography Review

**Status: OPEN - recommendation ready; implementation not started.**

**Parent / prior context:**
[Region Destinations and Day-City Extraction](2026-07-08-region-destinations-and-day-city-extraction.md),
[Q2 - Trip Geography and Map Architecture Review](2026-07-06-q2-trip-geography-and-map-architecture.md),
[Q3 - Discovery Personalization and Shared Cache](2026-07-06-q3-discovery-personalization-and-shared-cache.md)

**Review date:** 2026-07-08

**Scope:** Product and architecture review only. No source code, migration, or UI
implementation is part of this report.

## Executive recommendation

Trippy should introduce first-class **destination scopes** and stop treating every
trip/day geography value as a city string.

The root issue is not "region support" alone. It is that Trippy currently uses
one string-shaped field for four different jobs:

1. The traveler-facing trip/day identity.
2. The Discovery catalogue destination.
3. The geocoding/search bias for specific stops.
4. The exact provider/place identity of bookings and stops.

Hotel-driven day movement should remain. It is a good product behavior. A
Chongqing hotel booking on 9-13 June in a Chengdu-Chongqing trip should move
those days to Chongqing and make Discovery use Chongqing.

The failure is narrower: Trippy lets a hotel's raw extracted `city` value become
the day display identity and Discovery key. That makes provider/admin fragments
such as `Kabupaten Badung` or `Sinsing District` leak into day headers,
Discovery catalogues, trip summaries, importer context, and sometimes hotel
names.

The recommended model is:

- `destination_scope`: what the traveler thinks they are visiting, for example
  `Bali`, `Kaohsiung`, `Chengdu`, `Chongqing`, `Amalfi Coast`.
- `display_scope`: what the UI should show in trip/day headers.
- `discovery_scope`: the broad destination used to generate recommendations.
  In the minimum model, this should normally equal `display_scope`.
- `resolution_anchor`: narrower locality/context used for POI lookup and
  geocoding, for example `Seminyak`, `Badung`, `Sinsing District`.
- `place_identity`: provider-backed identity and coordinates for a hotel/stop,
  for example Google place ID, lat/lng, address components, country.

In short: **hotels may move days between destination scopes, but hotel address
components must not directly rename destination scopes.**

## Production symptoms

### Bali

Owner created a Bali trip, but the new-trip destination picker could not select
`Bali`; it returned city/subdivision-style results instead. Owner selected
`Denpasar` as a workaround.

After adding `W Bali - Seminyak`, the Plan day headers for the hotel nights
showed `Kabupaten Badung`. This was not merely ugly copy. That same value could
become the app's resolved day geography, trip destination summary, and Discovery
default.

### Kaohsiung

Owner created a Kaohsiung trip and added Hotel Indigo Kaohsiung. The hotel city
populated as `Sinsing District`, and the day header became `Sinsing District`
instead of `Kaohsiung`.

This is the same failure pattern as Bali at a different geographic level:
district/locality evidence was promoted to day display identity.

### Hotel display names

Hotel suggestions can produce awkward traveler-facing names:

- `W Taipei Xinyi District` instead of `W Taipei`
- `W Bali - Seminyak Badung Regency` instead of `W Bali - Seminyak`
- `Regent Bali Canggu Badung Regency` instead of `Regent Bali Canggu`

This is the hotel-name version of the same architecture issue. Provider
disambiguation/location context is being promoted into human-facing display
copy. Map placement should depend on place ID and coordinates, not on stuffing
district/regency text into the visible hotel name.

## Current code evidence

### Destination picker is city-shaped

`backend/src/services/lookups.js` has `lookupCityPredictions()` request Google
Autocomplete with:

```js
includedPrimaryTypes: ['locality', 'administrative_area_level_2']
```

Evidence: `backend/src/services/lookups.js:185-220`.

That excludes common travel destinations whose provider identity is not a
`locality` or `administrative_area_level_2`. Bali is the production example:
it behaves like a province/island/region destination, not a city-only value.

### Hotel address extraction is promoted into day geography

`extractCityFromAddressComponents()` currently falls back:

```js
locality -> administrative_area_level_2 -> administrative_area_level_1
```

Evidence: `backend/src/services/lookups.js:164-172`.

That fallback can be reasonable as raw locality evidence, but it is not safe as
display identity. In Indonesia, `administrative_area_level_2` can produce
`Kabupaten Badung`. In Taiwan, a hotel may return district-level locality such
as `Sinsing District`. In other countries, different administrative levels can
mean different things.

### Active hotel has high precedence in day derivation

`deriveDayGeo()` resolves each day with this priority:

1. Manual city override.
2. Active hotel booking that night.
3. Last same-day transit arrival.
4. Previous day's resolved geography.
5. Seeded day city/country.

Evidence: `backend/src/services/trips.js:170-224`.

This priority is useful and should not be removed. It is exactly what makes a
Chengdu-Chongqing trip intuitive: adding a Chongqing hotel for 9-13 June moves
those days to Chongqing automatically.

The bug is that layer 2 currently contributes a single `city` string with no
role distinction. That string is sometimes a destination-level city
(`Chongqing`) and sometimes an address fragment (`Sinsing District`,
`Kabupaten Badung`). The derivation cannot tell the difference.

### Trip summaries are derived from resolved day geography

`deriveTripDestinationPairsFromDays()` de-duplicates each day's resolved city
and country to build the trip's returned `destinations` /
`destinationCountries`.

Evidence: `backend/src/services/trips.js:226-255`,
`backend/src/services/trips.js:642-653`.

This means a bad hotel city does not only affect the Plan day header; it can
pollute the trip summary and any downstream surface that trusts the trip's
derived destinations.

### Discovery uses resolved city as its default

`DiscoveryPanel` picks its default destination from active day resolved
geography:

```js
activeDay?.resolvedCity ?? activeDay?.city ...
activeDay?.resolvedCountry ...
```

Evidence: `frontend/src/components/discovery/DiscoveryPanel.jsx:308-309`.

The hook cache key is `norm(destination)|countryCode`.

Evidence: `frontend/src/hooks/useDiscovery.js:40-59`.

The backend persists catalogue rows as `city_key + country_code`.

Evidence: `backend/src/db/discoveryCatalogue.js:17-36`,
`backend/src/routes/discovery.js:137-199`.

So if `Kabupaten Badung` or `Sinsing District` becomes resolved day geography,
Discovery can create or select the wrong catalogue. For Bali and Kaohsiung, the
minimum correct behavior is:

- Day header: `Bali` / `Kaohsiung`
- Discovery key: `bali|ID` / `kaohsiung|TW`
- Stop geocoding/search bias: may include `Seminyak`, `Badung`, or
  `Sinsing District` as locality context.

### Stop/place lookup should use narrower context, but Discovery should not

Stop creation/update uses derived day geography as resolution bias:

Evidence: `backend/src/services/stops.js:160-166`.

The resolver cache key also includes `queryText`, `city`, and `country`.

Evidence: `backend/src/services/placeResolver.js:145-147`,
`backend/src/services/placeResolver.js:582-589`.

This is the right place for a narrower `resolution_anchor`. If the user adds an
ambiguous cafe or repairs a hotel pin while based at Indigo Kaohsiung, including
`Sinsing District, Kaohsiung, TW` can improve lookup precision.

But that same narrow anchor should not become the Discovery destination. Staying
at W Bali in Seminyak does not mean the user only wants Seminyak suggestions;
they likely still want island-wide Bali recommendations. Staying in Xinyi or
Sinsing does not mean the user only wants district-level discovery.

### Add Booking city field is overloaded

When selecting a hotel suggestion, `AddBookingModal` writes `place?.city` into
both `hotelCity` and `detailsJson.city`.

Evidence: `frontend/src/components/logistics/AddBookingModal.jsx:229-269`.

`normalizeForm()` then treats `detailsJson.city || hotelCity` as the hotel
city.

Evidence: `frontend/src/components/logistics/bookingForm.js:82-94`.

The visible label says `City`, but the provider value is often a narrower area,
district, regency, or other address component. That field is currently used as
if it means "base city/destination for this hotel stay"; in reality it often
means "local address component near this hotel."

### Hotel visible name is derived from provider/suggestion text

`handleHotelSuggestionSelect()` chooses a title from the details response or
the suggestion text, then stores provider metadata separately.

Evidence: `frontend/src/components/logistics/AddBookingModal.jsx:229-269`.

This is already close to the right shape because it stores `placeId`, provider
payload, formatted address, coordinates, and display fields. The missing rule is
that provider/suggestion disambiguators should not be blindly accepted as the
traveler-facing hotel name when a cleaner official name is available.

## External evidence

### Google Autocomplete supports city and region collections

Google Places Autocomplete supports `includedPrimaryTypes`, including special
collections `(cities)` and `(regions)`. Google documents `(regions)` as areas or
divisions such as neighborhoods/postal codes, and `(cities)` as places Google
identifies as a city. Google also rejects requests that mix `(cities)` or
`(regions)` with other types.

Source: <https://developers.google.com/maps/documentation/places/web-service/place-autocomplete>

Implication: Trippy should not solve this by simply adding more raw types to the
existing city picker. It needs a destination-scope picker that can deliberately
query, group, rank, and filter broad scopes versus local/admin fragments.

### Google types include many non-city geographic levels

Google's place/address type docs include:

- `administrative_area_level_1`
- `administrative_area_level_2`
- `administrative_area_level_3+`
- `archipelago`
- `colloquial_area`
- `locality`
- `sublocality`
- `sublocality_level_*`
- `neighborhood`

Source: <https://developers.google.com/maps/documentation/places/web-service/place-types>

Implication: a single `city` field cannot safely represent provider geography.
Provider components need to be classified into scope/display/resolution roles.

### Google warns address components are unstable

Google's Geocoding docs warn that address components may contain more or fewer
components than expected, may omit political entities, may change order/type,
and may be missing in later responses.

Source: <https://developers.google.com/maps/documentation/geocoding/requests-geocoding>

Implication: a universal fallback order such as
`locality -> administrative_area_level_2 -> administrative_area_level_1` is too
brittle to drive user-facing display labels.

### Public travel products model Bali as a broad destination

Tripadvisor has a first-class Bali page that recommends hotels, things to do,
restaurants, and island-wide attractions/areas such as Seminyak, Nusa Dua,
Uluwatu, Tanah Lot, Ubud, and Kuta under the broad `Bali, Indonesia` destination.

Source: <https://www.tripadvisor.com/Tourism-g294226-Bali-Vacations.html>

Wikivoyage models Bali with `Regions`, `Cities`, and `Other destinations`.
South Bali contains Kuta, Canggu, Denpasar, Jimbaran, Nusa Dua, Sanur,
Seminyak, and Tanah Lot; the page separately lists cities and other
destinations.

Source: <https://en.wikivoyage.org/wiki/Bali>

Public evidence: mature travel products do not treat destination as city-only.

Inference for Trippy: broad destination scopes and child/local planning areas
are the reusable product model.

## Findings

### Finding 1 - The root issue is scope separation, not "regions" alone

`Bali` is a region/island-style destination, but `Kaohsiung -> Sinsing District`
proves the problem is broader. The failure occurs whenever a narrower provider
component is promoted to display identity.

The model needs role separation:

- What should the traveler see?
- What should Discovery generate for?
- What should geocoding use as nearby context?
- What exact provider place was selected?

### Finding 2 - Hotel-driven day movement is correct and should be preserved

Removing hotel influence would regress the original intended UX. The
Chengdu-Chongqing example is the model's success case:

- Trip starts as Chengdu-Chongqing, 8-17 June.
- Chongqing hotel is added for 9-13 June.
- The affected days should automatically show `Chongqing`.
- Discovery should default to `Chongqing`.
- User should not manually edit each day.

The corrected rule is not "hotels cannot rename days." The corrected rule is:

> Hotels can move days to a known or confidently matched destination scope.
> Hotels cannot directly promote raw provider address components to day display.

### Finding 3 - Discovery should key on broad day/trip scope, not hotel locality

Discovery is a broad exploration product surface. It should default to what the
trip/day is about, not where the hotel happens to sit.

For Bali:

- Display scope: `Bali`
- Discovery scope: `Bali`
- Resolution anchor: `Seminyak` / `Badung` when resolving specific stops

For Kaohsiung:

- Display scope: `Kaohsiung`
- Discovery scope: `Kaohsiung`
- Resolution anchor: `Sinsing District` when resolving specific stops

For Chengdu-Chongqing:

- Display scope: `Chongqing` on Chongqing hotel nights
- Discovery scope: `Chongqing`
- Resolution anchor: possibly the hotel district, but not required for the
  Discovery default

An optional future "near hotel" or "near this area" Discovery mode could use
resolution anchors, but it should not be part of the minimum fix.

### Finding 4 - Hotel display names need the same identity/display split

Hotel names should display the official/traveler-facing property name. District
or regency text should live in address/context fields.

Recommended behavior:

- Preserve `provider_place_id`, coordinates, formatted address, address
  components, and provider payload.
- Display a clean official name.
- Strip trailing administrative/locality disambiguators only when they also
  appear in address components or secondary suggestion text.
- Keep cleanup conservative so property names are not damaged.

Examples:

| Provider/suggestion text | Preferred display | Context kept separately |
|---|---|---|
| `W Taipei Xinyi District` | `W Taipei` | `Xinyi District`, `Taipei`, `TW` |
| `W Bali - Seminyak Badung Regency` | `W Bali - Seminyak` | `Seminyak`, `Badung Regency`, `Bali`, `ID` |
| `Regent Bali Canggu Badung Regency` | `Regent Bali Canggu` | `Canggu`, `Badung Regency`, `Bali`, `ID` |

### Finding 5 - Manual override should stay minimal, but must canonicalize

The owner preference is to keep manual override simple for now. That is
reasonable.

However, raw string identity is already too fragile. Variants like:

- `ChengDu`
- `Chengdu`
- `Cheng Du`
- `Cheng du`

should not fork Trippy's understanding of the place. Canonical identity keys
should drive destination matching, dedupe, Discovery cache identity, and
hotel-driven movement. Display casing should be separate polish.

The minimum override UX can remain one visible "day header" edit, but the
backend should normalize it into canonical geography identity.

### Finding 6 - Existing polluted data should be flagged, not bundled into the first fix

Known bad or suspicious values include:

- `Kabupaten Badung` as a day header / Discovery destination.
- `Sinsing District` as a Kaohsiung day header.
- Hotel names with trailing district/regency disambiguators.
- Possible duplicate Discovery/geography keys caused by casing/spacing variants.

The first priority should be preventing new pollution. A cleanup/migration audit
should be a follow-up decision, not a blocker for the architecture fix.

## Recommended data contract

### `destination_scope`

Represents what the traveler thinks they are visiting.

Minimum fields:

- `id`
- `trip_id`
- `label`
- `canonical_key`
- `scope_kind`
- `country_code`
- `provider_place_id`
- `center_lat`
- `center_lng`
- `bounds_json`
- `parent_scope_id`
- `source`
- `created_at`
- `updated_at`

Recommended initial `scope_kind` values:

- `city`
- `region`
- `island`
- `neighborhood`
- `route`
- `custom`

Do not overfit the enum. It is mostly for ranking, grouping, and UX labels, not
for business logic that assumes every country uses the same administrative
model.

### Day geography

Each day should be able to answer three questions:

1. What should the header show?
2. What should Discovery use?
3. What should stop/place lookup resolve near?

Minimum fields or derived response shape:

```js
{
  displayScopeId,
  displayLabel,
  discoveryScopeId,
  discoveryLabel,
  resolutionAnchor: {
    label,
    countryCode,
    providerPlaceId,
    lat,
    lng,
    source
  }
}
```

In the minimum model, `discoveryScopeId` can equal `displayScopeId`. The point
is to keep the contract explicit so `resolutionAnchor` does not accidentally
drive Discovery.

### Booking place identity

Hotel and stop records should distinguish display from provider identity:

```js
{
  displayName,
  providerPlaceId,
  provider,
  formattedAddress,
  addressComponents,
  localityLabel,
  adminAreaLabel,
  countryCode,
  lat,
  lng,
  rawSuggestionText,
  rawProviderName
}
```

`displayName` is user-facing. `rawSuggestionText`, `formattedAddress`, and
components are evidence/context. `providerPlaceId` and coordinates drive maps.

## Recommended behavior by surface

### Destination picker

Replace city-only thinking with scope selection.

Behavior:

- Query city-like and region-like results intentionally.
- Group results by kind: city, region/island, neighborhood/local area.
- Prefer traveler-recognized scopes over small admin fragments.
- Suppress or demote postal codes and tiny neighborhoods unless the query is
  exact.
- Store provider place ID, country, center, and bounds when available.

Do not simply append more Google primary types to `lookupCityPredictions()`.
Google's `(regions)` collection intentionally includes broad and narrow things.
The product must rank and label them.

### Hotel selection and Add Booking

When a user selects a hotel:

- Store exact provider identity and coordinates.
- Display a clean official hotel name.
- Populate locality/admin evidence separately.
- Use locality/admin evidence for `resolution_anchor`.
- Attempt to match or promote a destination scope for the affected hotel nights.

Rename or reinterpret the visible hotel `City` field. It currently behaves more
like `Area / locality` than `Destination city`.

### Hotel-driven day movement

Keep automatic movement.

Promotion rule:

1. If hotel place data confidently matches an existing destination scope, move
   the active hotel nights to that scope.
2. If hotel place data confidently identifies a major city/destination scope
   not yet in the trip, create or add that scope automatically.
3. If hotel place data only yields a district/regency/sublocality/admin
   fragment, keep or infer the broader destination scope and store the fragment
   as resolution anchor only.
4. If confidence is ambiguous, keep current display scope and optionally surface
   a lightweight correction affordance later.

Examples:

| Scenario | Day display | Discovery | Stop lookup bias |
|---|---|---|---|
| Chengdu trip, Chongqing hotel 9-13 Jun | `Chongqing` | `chongqing|CN` | `Chongqing`, optionally hotel district |
| Bali trip, W Bali - Seminyak | `Bali` | `bali|ID` | `Seminyak / Badung, Bali, ID` |
| Kaohsiung trip, Hotel Indigo in Sinsing | `Kaohsiung` | `kaohsiung|TW` | `Sinsing District, Kaohsiung, TW` |
| Taipei trip, W Taipei in Xinyi | `Taipei` | `taipei|TW` | `Xinyi District, Taipei, TW` |

### Plan day header

Render `displayLabel`, not raw hotel `detailsJson.city`.

The header edit can remain minimal. It should update display scope / label, and
the backend should canonicalize identity so casing and spacing variants do not
fork downstream behavior.

### Today header

Use the same `displayLabel` contract as Plan. Today should not have its own
geography fallback logic that can diverge from Plan.

### Discovery

Default to `discoveryLabel` / `discoveryScopeId`, which should normally be the
broad display scope.

Do not default Discovery to `resolution_anchor`.

Optional later mode:

- `Explore nearby`
- `Near hotel`
- `Near Seminyak`
- `Near Xinyi`

That mode should be explicitly user-invoked, not automatic.

### Stop geocoding / place search

Use the narrowest safe context:

1. Exact selected provider place ID / coordinates when available.
2. Stop-level country if already resolved.
3. Day resolution anchor.
4. Day display/discovery scope bounds.
5. Country filter.
6. Free-text fallback.

This lets `Sinsing District` help place lookup without becoming the Discovery
destination.

### Map provider / deep links

Map provider and coordinate behavior should remain country/place driven, not
city-name driven.

The prior Q2 review already moved toward per-day and per-place country
selection. Destination scopes should preserve that direction:

- Day map provider: day/display scope country when available.
- Stop deep link provider: stop resolved country, else day country.
- Hotel pin: exact coordinates/provider identity.

### Importer / capture context

Claude/import context should receive broad destination scopes, not polluted
hotel locality/admin strings.

If the current trip is `Bali`, importer context should say `Bali (ID)`, not
`Kabupaten Badung (ID)`.

If a hotel booking extraction includes `Sinsing District`, that can be retained
as locality evidence, but the trip context should remain `Kaohsiung (TW)`.

## Rejected alternatives

### Country-aware address-component preference

Rejected as the primary fix.

It may fix one country at a time, but it creates a maintained table of
country-specific extraction rules and still depends on provider address
components that Google says can be missing or change over time.

Example:

- Prefer AAL1 over AAL2 in Indonesia to get `Bali` instead of `Badung`.
- Prefer AAL2 in China because prefecture-level cities are often useful.
- But Taiwan district behavior, Japan wards, Seoul districts, US counties, UK
  postal towns, and many others will keep adding exceptions.

This is brittle and does not solve Discovery scope, hotel display names,
canonical identity, or provider-label leakage.

### Display alias only

Rejected.

Renaming `Kabupaten Badung` to something prettier at render time would hide the
symptom while leaving the wrong value in:

- trip destination summary
- Discovery catalogue key
- importer context
- geocoding cache key
- manual override identity

This is a masking layer, not a model fix.

### Disable hotel-driven day movement

Rejected.

It would avoid the Badung/Sinsing symptom by removing one of Trippy's best
automation behaviors. The Chengdu-Chongqing case is exactly the UX Trippy should
preserve.

The fix is guarded promotion to destination scope, not removal of hotel
evidence.

### Make Discovery locality-first

Rejected for the minimum model.

Staying in Seminyak, Xinyi, or Sinsing does not mean the user wants only
nearby/local recommendations. Discovery should stay broad by default. Locality
should bias POI lookup and can power future explicit "near here" exploration.

## Minimum implementation outline

This is not an implementation plan, but if the recommendation is accepted, the
minimum sequence should be:

1. Define canonical geography identity helpers:
   - `canonical_key`
   - display label normalization
   - country-aware keying
   - casing/spacing folding for values like `ChengDu`, `Chengdu`, `Cheng Du`
2. Add destination scope persistence:
   - trip-level scope records
   - provider identity / bounds / center when available
   - parent scope relation optional but included for future use
3. Replace city picker semantics:
   - scope lookup endpoint
   - grouped/ranked city/region results
   - store place ID/country/bounds/center
4. Split hotel place data:
   - official/clean display name
   - provider place ID and coordinates
   - address/locality/admin evidence
   - country
5. Update day derivation:
   - preserve existing precedence
   - hotel layer emits `display_scope` only when matched/promoted confidently
   - hotel layer always may emit `resolution_anchor`
6. Update consumers:
   - Plan/Today/share headers use display label
   - Discovery uses discovery scope
   - stop geocoding uses resolution anchor
   - trip summary derives from display scopes
   - importer context uses broad scopes
7. Add compatibility projection:
   - keep legacy `destinations` / `destinationCountries` response fields while
     clients migrate
8. Add data-quality follow-up:
   - flag existing `Kabupaten Badung`, `Sinsing District`, casing duplicates,
     and hotel names with admin suffixes
   - decide separately whether to auto-clean or review manually

## Verification strategy

### Backend unit tests

- `deriveDayGeo` preserves Chengdu-Chongqing hotel-driven movement.
- Bali hotel with locality/admin evidence keeps display scope `Bali` and stores
  `Seminyak/Badung` as resolution anchor.
- Kaohsiung hotel with district evidence keeps display scope `Kaohsiung` and
  stores `Sinsing District` as resolution anchor.
- Discovery key uses display/discovery scope, not resolution anchor.
- Stop resolver receives resolution anchor when available.
- Canonical identity folds `ChengDu`, `Chengdu`, `Cheng Du`, `Cheng du`.

### Frontend tests

- Plan day header renders display label.
- Today header renders same display label.
- Discovery panel defaults to broad scope.
- Add Booking displays clean hotel name while preserving provider place ID.
- Editing day header does not create duplicate identities for casing/spacing
  variants.

### Regression fixtures

| Fixture | Expected result |
|---|---|
| Chengdu-Chongqing hotel stay | Hotel nights display `Chongqing`; Discovery uses `Chongqing`. |
| Bali + W Bali - Seminyak | Header `Bali`; Discovery `bali|ID`; stop lookup can use Seminyak/Badung. |
| Kaohsiung + Hotel Indigo | Header `Kaohsiung`; Discovery `kaohsiung|TW`; stop lookup can use Sinsing. |
| Taipei + W Taipei | Header `Taipei`; hotel display `W Taipei`; Xinyi kept as locality context. |
| Existing polluted catalogue row | Prevent new writes; migration/cleanup decision deferred. |

## Product decisions still needed

1. Should Trippy auto-create a new destination scope from hotel evidence when it
   is a high-confidence city/destination not already on the trip?

   Recommendation: yes. This preserves the intuitive hotel-driven movement
   behavior. The guardrail is to promote only major/traveler-recognized scopes,
   not raw district/regency/admin fragments.

2. How conservative should hotel-name cleanup be?

   Recommendation: conservative. Strip trailing location/admin suffixes only
   when they also appear in address components or secondary suggestion text.
   Keep brand/property names intact.

3. Should local Discovery exist?

   Recommendation: not in the minimum fix. Broad destination Discovery should
   remain default. Add an explicit "near hotel / near this area" mode later only
   if user behavior proves it useful.

4. Should manual override expose "show as" and "resolve near" separately?

   Recommendation: not yet. Keep one visible day-header edit. Store/canonicalize
   structured identity underneath. Add advanced controls only if the simple
   model fails real usage.

5. Should existing polluted data be cleaned now?

   Recommendation: flag now, decide later. Preventing new pollution is higher
   priority than one-time cleanup, but the report should track the known values
   so they are not forgotten.

## Final recommendation

Proceed with destination scopes.

Modify the earlier "region destination" idea into a broader **destination scope
vs resolution anchor** architecture:

- Keep hotel-driven day movement.
- Promote hotel evidence to display only when it matches or confidently creates
  a destination scope.
- Treat hotel districts/regencies/sublocalities as resolution anchors.
- Keep Discovery broad by default.
- Split hotel official display name from provider location context.
- Canonicalize geography identity so display casing and spacing do not fork
  cache keys or destination matching.
- Defer cleanup of existing polluted data until after the prevention model is
  accepted.

This solves the Bali, Kaohsiung, Chengdu-Chongqing, Discovery, stop-geocoding,
hotel-name, and canonical-identity issues as one coherent product model instead
of patching each surface separately.
