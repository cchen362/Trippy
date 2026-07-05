# Q3 — Discovery Personalization and Shared Cache Review

**Status:** Investigation brief

**Parent:** [Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)

**Origin:** [Plan 4 Product Decision Q3](../plans/Implementation%20Plan%204%20UX%20Sweep%20Fixes.md#product-decisions-answered-by-owner-2026-07-05)

**Required companion:** [Q2 — Trip Geography and Map Architecture](2026-07-06-q2-trip-geography-and-map-architecture.md)

**Related trust review:** [Trust, Reliability, and Operational Risk](2026-07-06-trust-reliability-and-operational-risk.md)

## Review question

How should Trippy retain a fast, cost-efficient shared destination catalogue while making
discovery genuinely useful for this trip's interests, pace, travellers, dates and existing plan?

The central distinction is:

- **Global catalogue:** reusable candidate places for a destination.
- **Trip experience:** filtering, ranking and explanation for a specific traveller and itinerary.

Q3 should not force one layer to do both jobs.

## Provisional finding Q3-01 — collected preferences are not used

Trip creation collects:

- interest tags;
- pace;
- traveller composition;
- destinations and dates.

The discovery client accepts an `interestTags` argument, but the current hook supplies an empty
array and the backend discovery route does not use the preference fields. The same global
catalogue is therefore shown to everyone.

This weakens both sides of the product:

- users answer questions without receiving a visible payoff;
- discovery's `whyItFits` language implies personalization that is not actually grounded in
  the trip.

The review must decide whether every collected preference is justified. Either use it in a
clear way or stop collecting it during the critical onboarding path.

## Provisional finding Q3-02 — shared breadth is not shared quality

“Show more” adds AI-generated suggestions to the global cache. That crowdsources demand, not
validation. One user's search for novelty can make increasingly marginal results visible to
all users.

Investigate:

- incorrect, duplicate, closed or fabricated places;
- generic normalized-name collisions;
- city aliases and ambiguous destinations;
- a way to hide/report a bad suggestion;
- whether globally merged items need a confidence or provenance signal;
- whether “why it fits” belongs in the global record at all.

## Provisional finding Q3-03 — unbounded catalogue growth

Every merge can increase:

- SQLite JSON size;
- API response size;
- frontend render work;
- exclusion-list prompt size;
- generation cost and latency;
- visual noise.

The review must propose bounds, such as:

- maximum items per destination/category;
- ranking with replacement of weak items;
- age/quality decay;
- archival rather than indefinite accumulation;
- a separate canonical place identity for deduplication.

## Provisional finding Q3-04 — hero count includes categories the user never sees (live observation 2026-07-06)

Live production use (Chengdu trip, post-deploy) surfaced a concrete instance of Q3-03's
"unbounded catalogue growth" concern: the destination hero's "N curated places" count
(`DiscoveryPanel.jsx:393`, `totalCount = Object.values(partialResults).flat().length`) sums
**every** category key present in `partialResults`, while the visible category tabs
(`DiscoveryPanel.jsx:43-51`) are only `essentials` plus whichever categories map from the
trip's declared `interestTags`. Any other category the backend/global cache returns into
state (e.g. via "Show more") inflates the hero total without ever getting a tab the user can
open — so the number climbs (96 → 183 observed) while the sum of visible per-tab counts stays
far lower (18 + 17 + 34 = 69 observed), with no way for the user to see or reach the
uncounted-for-them remainder. Whatever Q3 lands on for the global/trip-specific boundary and
category selection (Options A/B/C) must make the hero count and the tabs agree — either scope
the count to categories actually rendered for this trip, or surface the hidden categories
somewhere reachable.

## Provisional finding Q3-05 — "Show more" has no loading affordance (live observation 2026-07-06)

The Show More button (`DiscoveryPanel.jsx:779-797`) only communicates its `loading` state via
a dimmed `disabled` style — label text stays "Show more", no spinner, no in-panel progress
indicator. Observed live: a 15s+ fetch (AI generation + merge) with the button simply greyed
out reads as frozen/broken rather than working, and it stays dimmed for a beat even after the
new suggestions have rendered. Any Q3 implementation should carry a visible in-progress state
(e.g. animated ellipsis / "Finding more places…" label swap) regardless of which
personalization option is chosen — this is a UX gap independent of the ranking/caching
architecture decision.

## Options to investigate

### Option A — global catalogue, local deterministic ranking

Cache a broad catalogue globally, then rank/filter it using trip preferences and itinerary
state without another model call.

Benefits: predictable cost and fast responses.

Risk: ranking quality depends on the metadata available in the global record.

### Option B — global catalogue, trip-specific AI reranking

Use the cached catalogue as bounded context for a smaller trip-specific model call that returns
ranked IDs and explanations.

Benefits: richer personalization.

Risk: additional latency, cost and another failure mode.

### Option C — curated category filters only

Use interest tags to select/reorder categories and avoid claiming deeper personalization.

Benefits: honest and inexpensive.

Risk: may not create enough differentiated value to justify collecting pace/traveller data.

The report should compare these options against actual expected usage, not AI novelty.

## Dependency on Q2

Discovery keys and “already in trip” matching currently depend heavily on normalized city
strings. If Q2 introduces structured city/country or dated geographic segments, Q3 should use
that identity rather than build another string-based layer.

Mixed-country trips also require discovery to know which destination/day the recommendation
belongs to. Q3 should not finalize storage or matching before Q2 establishes that model.

## Dependency on Trust

The shared catalogue needs:

- bounded cost and request controls;
- failure timeouts;
- cache observability;
- a way to recover from globally bad data;
- tests proving one trip cannot pollute another's results.

These requirements belong to the Trust baseline as well as the discovery design.

## Required scenarios

1. Solo fast-paced food trip versus slow-paced family trip in the same city.
2. User asks for “show more” repeatedly.
3. Cached suggestion is closed or factually wrong.
4. Two cities normalize to an ambiguous key.
5. Same place appears under English, romanized and local names.
6. Multi-country trip browses discovery for several destinations.
7. Destination or day city changes after suggestions were loaded.
8. The AI provider is unavailable but the global catalogue exists.

## Expected report outcome

The completed report should recommend:

- which onboarding fields discovery will actually use;
- the global-versus-trip-specific data boundary;
- a ranking/personalization approach;
- cache size and lifecycle limits;
- quality/removal/provenance behavior;
- stable place/destination identity requirements from Q2;
- metrics that prove discovery adds places users keep rather than merely browse.

It must update the [parent review](2026-07-06-product-architecture-risk-review.md) before any
personalization implementation plan is approved.
