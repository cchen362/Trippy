# Q2 — Trip Geography and Map Architecture Review

**Status:** Investigation brief

**Parent:** [Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)

**Origin:** [Plan 4 Product Decision Q2](../plans/Implementation%20Plan%204%20UX%20Sweep%20Fixes.md#product-decisions-answered-by-owner-2026-07-05)

**Required companions:** [Q1 — Booking Classification](2026-07-06-q1-booking-classification-and-correction.md), [Q3 — Discovery](2026-07-06-q3-discovery-personalization-and-shared-cache.md)

**Related trust review:** [Trust, Reliability, and Operational Risk](2026-07-06-trust-reliability-and-operational-risk.md)

## Review question

What should be Trippy's authoritative representation of a trip's geography, and at what level
should country-specific map, coordinate, navigation, discovery and geocoding decisions be made?

This is not simply a request to add destination chips to Edit Trip. Destination editing exposes
an existing ambiguity among trip destinations, country arrays, day cities, booking-derived
movement and manual day overrides.

## Current competing sources

The agent should trace and compare:

1. `trips.destinations`
2. `trips.destination_countries`
3. seeded `days.city`
4. `days.city_override`
5. derived day city from hotel and transit bookings
6. stop location metadata and coordinates
7. discovery's currently selected destination

The review must establish which source is authoritative for:

- trip summary;
- each calendar day;
- geocoding country bias;
- map tile provider;
- coordinate conversion;
- external navigation provider;
- discovery catalogue key;
- AI import context.

## Provisional finding Q2-01 — unpaired city and country data

Destinations and countries are stored as separate arrays. Capture-derived trip creation can
produce a city without a country and then filter null countries from the country array.
Consequently, the arrays are not a reliable positional mapping.

Investigate whether the durable model should use structured geography such as:

```json
{
  "city": "Shanghai",
  "countryCode": "CN"
}
```

Do not assume that a trip-level destination list alone can represent when the traveller is in
each location.

## Provisional finding Q2-02 — trip-wide map configuration

Current precedence is:

1. any `CN` country → AMap, GCJ-02 configuration and AMap deep links;
2. otherwise any `KR` country → Naver deep links;
3. otherwise Google deep links with MapTiler/OSM tiles.

### Required mixed-country scenarios

- Malaysia → Singapore → China → Malaysia
- China → Korea
- Korea → China
- China airport transit without an overnight stay
- A non-China trip with one incorrectly inferred `CN` code
- A China trip whose imported hotel lacks a country

### Important nuance

The WGS-84 → GCJ-02 conversion includes an outside-China guard. The investigation must not
claim that every Malaysia/Singapore coordinate is necessarily shifted. It must separately test:

- coordinate storage;
- display-coordinate conversion;
- map tile alignment;
- route/marker rendering;
- deep-link provider selection;
- the destination app's treatment of coordinates outside its primary market.

Even if raw coordinate accuracy survives, using AMap links for Malaysian days or choosing AMap
instead of Naver for Korean days is a product/modeling failure.

## Provisional finding Q2-03 — unclear edit semantics

Real trips change after creation. Investigate expected behavior when a user:

- adds a destination;
- removes a destination that still owns days/stops/bookings;
- reorders destinations;
- changes country but not city;
- extends the trip at the start or end;
- inserts a destination between existing days;
- imports a booking that implies a new city;
- manually overrides a day's city;
- removes the booking that previously drove the derived city.

A destination editor without explicit semantics could leave the trip summary, day plan,
discovery and map disagreeing.

## Options to investigate

### Option A — per-day structured geography

Each day owns a canonical city/country pair. Trip destinations become a derived summary.
Bookings may propose day geography, while manual overrides remain explicit.

### Option B — dated trip segments

A trip contains ordered geographic segments with start/end dates and city/country identity.
Days inherit from segments; transit bookings connect segments.

### Option C — stop/place-level provider selection

Retain the current trip/day model but choose map/deep-link behavior from each resolved place's
country. This may fix map-provider selection but does not by itself resolve destination editing.

The final recommendation may combine B for trip structure with C for provider selection.

## Cross-report dependencies

### Q1

Booking type changes can add or remove inferred movement. Q2 must define whether bookings are
authoritative geography, suggestions, or merely evidence used to derive day state.

### Q3

Discovery requires a stable destination identity. Personalized discovery should not be designed
against free-form city strings if Q2 intends to introduce structured location identity.

### Trust

Any migration or bulk reconciliation of days, bookings, stops and map metadata must be atomic,
recoverable and tested against existing trips.

## Required design outputs

The completed review should provide:

1. A canonical geography model.
2. Authority and precedence rules.
3. Mixed-country provider-selection rules.
4. Destination/date editing semantics.
5. Booking-to-geography reconciliation rules.
6. Migration strategy for existing trips and unpaired country arrays.
7. A compatibility strategy for public shares and cached PWA data.
8. Test matrices for China, Korea, mixed-country and missing-country trips.

Confirmed conclusions must be fed into the
[parent review](2026-07-06-product-architecture-risk-review.md) before Q1 persisted conversion
or Q3 personalization becomes an implementation plan.
