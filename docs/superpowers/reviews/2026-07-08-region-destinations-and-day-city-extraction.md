# Region Destinations and Day-City Extraction (Production Finding #3)

**Status: OPEN — needs product discussion before any implementation.**
Origin: Plan 7 production verification pass (2026-07-07), finding #3. Root cause
investigated and confirmed 2026-07-08; deliberately NOT fixed alongside findings
#1/#2/#4 because the right fix is a product-model question, not a bug patch.

## Observed symptoms (owner, production, Bali trip)

1. Typing "Bali" in the new-trip destination picker returns no match — only
   formally-named subdivisions (Denpasar, Balikpapan…). Owner had to pick
   "Denpasar" as a workaround.
2. After adding the "W Bali – Seminyak" hotel, the Plan-tab day headers for the
   stay showed **"Kabupaten Badung"** (the regency), requiring a manual per-day
   city override — impractical for longer trips.

## Confirmed root causes — two separate surfaces, one shared assumption

The geography model (Q2, Plan 6) assumes **a destination is a city**. Bali is a
province (and colloquially an island/region), and Indonesian addresses often
carry no city-level component at all. That single assumption leaks out in two
independent places:

### A. Destination picker can never return "Bali"
`backend/src/services/lookups.js` → `lookupCityPredictions()` requests Google
autocomplete with `includedPrimaryTypes: ['locality', 'administrative_area_level_2']`.
Bali is `administrative_area_level_1` (province), so Google filters it out
before we ever see it. This is a hard type filter, not a ranking issue.

### B. Day-header city comes from hotel address extraction, not the picker
Confirmed derivation chain (verified in code 2026-07-08):

- Day city priority (`backend/src/services/trips.js` → `deriveDayGeo`, ~line 185):
  **manual override → hotel active that night → last same-day transit arrival →
  previous day's resolved city → seeded day city.** (Owner's mental model was
  correct: a Chongqing hotel on 9–13 June makes those days' header Chongqing.)
- The hotel's "city" is set at booking-add time by
  `backend/src/services/lookups.js` → `extractCityFromAddressComponents()`:
  fallback order **locality → administrative_area_level_2 → administrative_area_level_1**.
- W Bali – Seminyak's Google address has **no `locality`** component (Seminyak is
  a sublocality-level name), so the extractor fell through to AAL2 =
  "Kabupaten Badung", and the hotel layer stamped that on every night.

**Implication:** fixing the picker (A) alone does NOT fix the day headers (B) —
the moment a Badung-regency hotel is added, layer 2 overwrites the day city with
whatever the extractor produced. Any fix must address both surfaces coherently.

## Why this is a product decision, not just a code fix

The obvious per-surface patches pull in opposite directions by country:

- Preferring AAL1 over AAL2 when no locality exists would show "Bali" (good for
  Indonesia) but would show a whole **province** ("Sichuan") for a Chinese hotel
  with a missing locality (bad — China's AAL2 is the prefecture-level city we
  actually want, and `extractCityFromAddressComponents` already relies on AAL2
  for Chongqing/Chengdu).
- Adding AAL1 (+ possibly sublocality) to the picker types makes regions
  selectable, but then the day pair `(city, countryCode)` — which keys the
  shared discovery catalogue, map config, and stop resolution bias — starts
  holding region-scale values. Discovery generation for "Bali" works fine
  (verified in production: Claude handles region-level curation well); place
  RESOLUTION biased by "city=Bali" is weaker than "city=Seminyak" for a
  street-level POI lookup.

## Candidate directions to discuss (not decided)

1. **Country-aware extraction preference** — extraction hierarchy varies by
   country code (e.g. ID: locality → AAL1 → AAL2; CN: locality → AAL2 → AAL1).
   Smallest change; fixes the display without touching the data model; needs a
   maintained per-country table and a clear default.
2. **First-class "region destination"** — the day pair gains an optional
   region/area concept distinct from resolution-city: display shows "Bali",
   resolution/bias keeps the most specific available locality (Seminyak/Kuta),
   discovery keys on the region. Cleanest semantics, largest change (touches
   Q2 day-pair keying, discovery cache keys, map config selection).
3. **Display-name only** — keep the data model as-is, add a display alias layer
   (e.g. "Kabupaten Badung" renders as "Badung, Bali" or user-editable label).
   Cheapest; doesn't fix the picker, doesn't help discovery keying.

Open questions for the discussion:
- Should the destination picker offer regions at all, or is "pick the main city,
  the trip derives the rest" the intended model?
- What should the shared discovery catalogue key on when a trip is region-based —
  the region pair (`bali|ID`) or the per-day resolved cities? (Production already
  has both: denpasar|ID, kabupatenbadung|ID, and bali|ID catalogues.)
- Is a per-day manual override acceptable as the escape hatch if extraction gets
  a smarter default, or must overrides never be needed for a normal trip?

## Related facts worth keeping in frame

- Hotel city extraction also feeds `deriveTripDestinationPairsFromDays` → the
  trip's derived `destinations`/`destinationCountries` (Plan 6 Wave 4), so a
  regency-named hotel pollutes the trip summary too, not just day headers.
- The discovery panel's default destination uses the day's `resolvedCity` — so
  the same "Kabupaten Badung" value became a discovery catalogue key
  (destination id 9 in production) with its own generated content.
- Findings #1/#2/#4 from the same verification pass were fixed 2026-07-08
  (commits `99e3455`, `6daf588`, `0be6022`); this doc is the tracked remainder.
