# Trippy Product and Architecture Risk Review

**Status:** Investigation brief — no implementation decisions approved

**Parent context:** [Implementation Plan 4 — UX Sweep Fixes](../plans/Implementation%20Plan%204%20UX%20Sweep%20Fixes.md)

**Purpose:** Coordinate the follow-up reviews created from Plan 4's Product Decisions Q1–Q3 and the broader fresh-eye product/architecture review.

This is the parent document for a linked review set. It is the only place where findings
should be ranked against one another. The focused reports establish facts, options, and
dependencies; this document records cross-cutting decisions and eventual sequencing.

## Review family

| Workstream | Focused report | Primary question | Provisional priority |
|---|---|---|---|
| Q1 | [Booking Classification and Correction](2026-07-06-q1-booking-classification-and-correction.md) | Can an incorrect booking type be safely corrected before and after import? | Critical for extraction review |
| Q2 | [Trip Geography and Map Architecture](2026-07-06-q2-trip-geography-and-map-architecture.md) | What is the authoritative model for destinations, countries, days, movement, and map providers? | Critical exploration |
| Q3 | [Discovery Personalization and Shared Cache](2026-07-06-q3-discovery-personalization-and-shared-cache.md) | How should a shared destination catalogue become useful for a specific trip? | High |
| Trust | [Trust, Reliability, and Operational Risk](2026-07-06-trust-reliability-and-operational-risk.md) | What can cause lost data, retained private data, partial changes, or an app users cannot rely on? | Critical hardening |

Each focused report must link back here and identify any conclusion that depends on another
report. Agents should not turn a focused report directly into an implementation plan.

## Why these reviews are linked

The issues are not four unrelated backlogs:

```text
Imported booking
    ├── classification (Q1)
    │      ├── linked itinerary stop
    │      ├── Today classification/status
    │      └── inferred city/country movement
    │
    └── trip geography (Q2)
           ├── destination and day identity
           ├── country-specific geocoding
           ├── map provider and coordinate system
           └── destination used by discovery (Q3)
                         ├── global candidate catalogue
                         └── trip-specific interests, pace and travellers

Every write path above
    └── trust/reliability review
           ├── atomicity
           ├── offline privacy
           ├── recovery
           └── tests/observability
```

The most important dependency is Q2. A weak geography model can make later destination
editing, booking-derived movement, discovery personalization, and mixed-country map behavior
internally inconsistent.

## Nuance: mixed-country map behavior

The current map configuration is selected once for the entire trip:

- If any destination country is `CN`, the trip uses AMap and a GCJ-02 map configuration.
- Otherwise, if any destination country is `KR`, the trip uses Naver deep links.
- Otherwise, it uses Google deep links with MapTiler or OpenStreetMap tiles.

The coordinate conversion code has an outside-China guard, so this does **not** prove that
Malaysia or Singapore coordinates will automatically receive the classic China offset.
The trust problem is broader and still material: non-China days inherit the wrong tile/deep-link
provider, and a China + Korea trip always selects the China branch. The abstraction is
trip-wide when the decision is inherently day-, place-, or stop-specific.

This distinction must be preserved in agent reports: verify actual coordinate behavior rather
than claiming every non-China pin is offset, while still treating provider selection as a
fundamental modeling concern.

## Provisional findings register

These are investigation leads, not approved fixes.

| ID | Finding | User impact | Related reports |
|---|---|---|---|
| Q1-01 | Booking type is locked while reviewing an AI-extracted draft | A misclassified booking cannot be corrected before confirmation | Q1, Trust |
| Q1-02 | Bus/ferry/other classifications behave differently across forms, cards and Today | Users see inconsistent meaning for the same booking | Q1 |
| Q2-01 | Destinations and country codes are independent arrays rather than paired geographic records | City/country association can be incomplete or ambiguous | Q2 |
| Q2-02 | Map provider and coordinate system are selected for the whole trip | Mixed-country trips inherit a provider chosen for another country | Q2 |
| Q2-03 | Trip destinations, day cities, booking-derived cities and manual overrides can disagree | Editing one surface may not update the others | Q2, Q1 |
| Q3-01 | Interests, pace and traveller type are collected but do not personalize discovery | Collected preference data has no visible discovery payoff | Q3 |
| Q3-02 | “Show more” globally merges increasingly marginal AI suggestions | One user's request changes the catalogue for everyone | Q3, Trust |
| Q3-03 | Shared discovery cache growth is unbounded | Payload, prompt size, cost and visual noise grow over time | Q3, Trust |
| TR-01 | Offline document caches can outlive logout or revoked server access | Sensitive tickets may remain available on a device | Trust |
| TR-02 | Multi-booking imports and co-pilot mutations can partially apply | Users may see duplicate or half-applied changes | Trust, Q1 |
| TR-03 | Backup/restore, external-call timeouts and operational visibility are incomplete | A failure may cause data loss or an app that silently stalls | Trust |

## Questions that must be answered across reports

1. **What is authoritative?**

   For booking type, destination, country, day city, and map provider, identify the canonical
   source rather than allowing several fields to compete.

2. **What happens when data changes?**

   Define the consequences of changing type, destination, country, trip dates, or a booking's
   movement after stops and documents already exist.

3. **What is global versus trip-specific?**

   Shared discovery data may be global; ranking and “why this fits” should be trip-specific.
   Map tiles may be provider-specific; the selection should follow the relevant geography.

4. **How does the system fail?**

   Every proposed workflow must cover partial failures, retries, offline state, collaboration,
   and recovery.

5. **What evidence would justify building it?**

   Reports should distinguish a code-level defect from a product hypothesis requiring field
   data.

## Agent review contract

Every focused review should return the same sections:

1. Current behavior, with code and data-model evidence.
2. Real user scenarios that succeed, degrade, or fail.
3. Severity and likely frequency.
4. Authoritative-data recommendation.
5. Two or three viable design options.
6. Recommended option and rejected alternatives.
7. Dependencies on other reports.
8. Migration and backward-compatibility risks.
9. Verification strategy, including edge cases.
10. Open product questions requiring owner input.

Agents must:

- investigate before recommending;
- avoid implementation or schema changes during the review;
- preserve the mixed-country coordinate nuance above;
- flag conclusions that cannot be made without another report;
- use the finding IDs in this parent register;
- add newly discovered cross-cutting findings here before prioritization.

## Decision gates

Implementation planning should not begin until these gates are satisfied:

### Gate A — geography model

Q2 identifies the authority for city/country/day geography and resolves whether provider
selection is per trip, day, segment, or stop.

### Gate B — booking conversion contract

Q1 distinguishes correction of an unconfirmed extraction draft from conversion of an already
persisted booking, then defines how linked stops, documents and type-specific fields behave.

### Gate C — discovery product contract

Q3 defines the boundary between a global reusable catalogue and trip-personalized filtering,
ranking, and explanation.

### Gate D — trust baseline

The Trust report defines the minimum atomicity, privacy, backup, timeout, test and observability
requirements that all implementation plans must satisfy.

## Provisional sequencing

This ordering is deliberately tentative:

1. Complete Q2 geography/map investigation.
2. Correct the Q1 extraction-review dead end once its bounded behavior is confirmed.
3. Establish the critical Trust baseline for offline privacy, atomic writes and recovery.
4. Design Q3 catalogue personalization and cache bounds using the Q2 geography model.
5. Decide whether persisted booking-type conversion is valuable enough to build.

Q1 extraction-draft correction may be pulled forward because it is narrower than persisted
conversion and directly protects the app's primary ingestion promise.

## Final output of this review family

After all focused reports are reviewed, update this document with:

- confirmed findings and dismissed leads;
- a severity × frequency × effort matrix;
- approved product decisions;
- dependencies and work packages;
- explicit deferrals;
- the implementation-plan order.

Until then, this set is an investigation framework, not an instruction to modify the product.
