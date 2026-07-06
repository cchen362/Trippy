# Q3 — Discovery Personalization and Shared Cache Review

**Status:** Completed review (2026-07-06) — **Gate C CLOSED same day; owner accepted all five
§10 recommendations as stated** (decision record in the
[parent doc](2026-07-06-product-architecture-risk-review.md#gate-c-closed--owner-decisions-2026-07-06)).
Implementation plan: [Implementation Plan 7](../plans/Implementation%20Plan%207%20Q3%20Discovery%20Grounded%20Catalogue.md)
(approved; implementation gated on Plan 6 Waves 3–4).

**Parent:** [Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)

**Origin:** [Plan 4 Product Decision Q3](../plans/Implementation%20Plan%204%20UX%20Sweep%20Fixes.md#product-decisions-answered-by-owner-2026-07-05)

**Required companion:** [Q2 — Trip Geography and Map Architecture](2026-07-06-q2-trip-geography-and-map-architecture.md) (completed; Gate A closed; model shipping via Plan 6)

**Related trust review:** [Trust, Reliability, and Operational Risk](2026-07-06-trust-reliability-and-operational-risk.md)

## Review question

How should Trippy retain a fast, cost-efficient shared destination catalogue while making
discovery genuinely useful for this trip's interests, pace, travellers, dates and existing plan?

**Answer in one paragraph:** keep the two layers the brief separates and give each the job the
industry has already validated. The **global catalogue** becomes a set of *grounded place
records* — AI-generated candidates verified against the real-places resolver Trippy already
owns (`placeResolver.js`), carrying provenance, a canonical place identity, and hard size
bounds, keyed by the `(city, countryCode)` pair Q2 established. The **trip experience** becomes
*deterministic, zero-model-call* ranking and framing computed from the preferences the trip
already collects (interest tags, pace, travellers) — Option A for ranking plus Option C for
honest category curation. Option B (per-trip AI reranking) is rejected for the browse surface
and explicitly reserved for the co-pilot, which the parent review already names as the payoff
surface for deep personalization (parent decision 6). This is the pattern every studied
competitor follows: a real-places database under the AI, deterministic ranking over metadata,
and personalization expressed as interest-weighted ordering — never per-browse model calls.

---

## 1. Current behavior, with code and data-model evidence

### 1.1 The pipeline, traced

| Stage | Code | Behavior |
|---|---|---|
| Cache store | `007_global_discovery_cache.sql` | One row per destination: `destination TEXT PRIMARY KEY, result_json TEXT, fetched_at`. The entire catalogue for a city is a single JSON blob. |
| Cache key | `routes/discovery.js:94-97`, mirrored `useDiscovery.js:28-32` | Normalized city *string* (diacritics/punctuation stripped). No country. "Georgetown" (MY) and "Georgetown" (GY) are one row. |
| Generation | `claude.js:185` `discoverDestination` | One Claude call streams 8 fixed categories (~30 items each) as NDJSON. Items carry `name/description/whyItFits/estimatedDuration/openingHours/localName/aliases/lat/lng`. |
| Coordinate hygiene | `routes/discovery.js:27-36` `sanitizeDiscoveryCategory` | Model-emitted `lat/lng` are **nulled before caching and streaming** — a correct instinct (model coordinates are unreliable) that currently leaves items with no location at all. |
| Merge / "show more" | `routes/discovery.js:49-82` `mergeDiscoveryCategories` | Appends new items into the blob, deduped by `normalizeName`, stamped `generatedAt`. Exclusion list for regeneration = every cached item name (`discovery.js:172-174`). Growth is unbounded. |
| TTL | `routes/discovery.js:9` | 7 days on the whole row; stale refresh *merges* rather than replaces (`discovery.js:146-166`), so breadth accumulates forever. |
| Trip personalization | `useDiscovery.js:51,97` | The hook passes a literal empty array where interest tags would go; the route never reads `interest_tags`, `pace`, or `travellers` (parent register Q3-01, confirmed). |
| Client-side "personalization" | `DiscoveryPanel.jsx:42-61` `buildTabs` | Tabs = `essentials` + categories mapped from `interestTags` via `TAG_TO_CATEGORY`. Purely a display filter over the same global data. |
| "In trip" matching | `DiscoveryPanel.jsx:63-72`, `useDiscovery.js:9-16` | Normalized-title string matching between suggestions and stop titles. |
| Add-to-trip | `DiscoveryPanel.jsx:321-332` | Sends `title/locationCity/aliases`; the stop is then geocoded server-side from scratch. Contrast `handleAddPlaceResult` (`DiscoveryPanel.jsx:337-374`), which passes trusted coordinates and `providerId: 'google:<placeId>'` — **a stop-level place identity already exists in the data model** and discovery adds don't use it. |

### 1.2 Confirmed findings

**Q3-01 — collected preferences are not used.** Trip creation collects interest tags, pace,
traveller composition, destinations and dates (`002_trips.sql:9-11`, `trips.js:338-360`). None
reach discovery generation or ranking. Users answer onboarding questions with no visible
payoff, and `whyItFits` implies a personalization that is not grounded in the trip.

**Q3-02 — shared breadth is not shared quality.** "Show more" merges AI output into the global
blob with no validation. That crowdsources *demand*, not *quality*: one user's hunt for novelty
makes increasingly marginal — possibly fabricated, closed, or duplicated — items visible to
every user, indistinguishable from first-batch picks. There is no provenance signal, no
confidence, no way to hide or report a bad suggestion, and dedup is by normalized name only
(English/romanized/local variants of one place survive as separate items; distinct places with
generic names collide).

**Q3-03 — unbounded catalogue growth.** Every merge grows the JSON blob, the API payload, the
render set, the exclusion list fed back into the prompt (token cost per regeneration grows with
catalogue size), and visual noise. Nothing is ever ranked down, archived, or replaced.

**Q3-04 — hero count includes categories the user never sees (live, Chengdu trip).** The hero's
"N curated places" (`DiscoveryPanel.jsx:393`, `totalCount = Object.values(partialResults).flat().length`)
sums every category in state, while tabs (`buildTabs`) render only `essentials` + interest-mapped
categories. Observed live: hero climbed 96 → 183 while visible tab counts summed to 69. The
uncounted remainder is unreachable.

**Q3-05 — "Show more" has no loading affordance (live).** `DiscoveryPanel.jsx:779-797` only dims
the disabled button during a 15s+ generation; it reads as frozen, and stays dimmed briefly even
after new items render.

### 1.3 What already works and must be preserved

- **The global/trip pollution boundary is already respected in one place:** exclusions for
  "show more" are deliberately *not* built from the requesting trip's stops
  (`discovery.js:139-145`) — trip-owned filtering happens at display time. This review keeps
  that principle and extends it: *nothing trip-specific may enter the global record.*
- SSE streaming with per-category chunks, the client-side merge protocol, and the abort
  handling in `useDiscovery.js` are sound plumbing; the redesign is additive to the protocol.
- The Places escape hatch ("On the map" search with session tokens, `DiscoveryPanel.jsx:293-311`)
  and the trusted-coordinates fast path are exactly the mechanisms the grounded catalogue needs,
  already written.
- Model coordinates are already distrusted (`sanitizeDiscoveryCategory`) — the resolver becomes
  the *source* of coordinates instead of nulling them.

---

## 2. How established products do this (external research, 2026-07-06)

Researched per owner direction: study how recognized travel products source, validate, and
personalize recommendations rather than reinventing the wheel.

### 2.1 Pattern — the catalogue is grounded in a real-places database; AI only narrates

- **Mindtrip** (the current AI-native reference) is built on a proprietary database of **11M+
  points of interest** plus 40k+ local guides; the conversational AI is grounded in that POI
  database, which is its stated defense against hallucination, and every recommendation is
  "vetted through multiple sources." ([mindtrip.ai](https://mindtrip.ai/),
  [comparison review](https://monkeytravel.app/blog/best-ai-trip-planners-2026-compared))
- **Wanderlog** builds its "places to visit" lists on Google-places data enriched with
  citations from published travel guides and blogs, and asks onboarding questions (activity
  level, attraction interests) to weight what it surfaces.
  ([wanderlog.com](https://wanderlog.com/), [MakeUseOf review](https://www.makeuseof.com/wanderlog-trip-planner-app/))
- The negative evidence is equally clear: studies of *ungrounded* AI itineraries found ~9 in 10
  contain at least one factual error, roughly 1 in 4 recommend permanently or temporarily
  closed venues, and over half suggest visits outside operating hours
  ([Copyleaks study](https://copyleaks.com/blog/the-dangers-of-using-ai-travel-planner),
  [WebProNews](https://www.webpronews.com/ai-hallucinations-in-travel-apps-lead-to-fake-landmarks-and-dangers/)).
  This is precisely finding Q3-02 measured at industry scale.

**Trippy translation:** verify generated items against `placeResolver.js` (Nominatim first —
free; Google Places Text Search fallback — already integrated, already cached in
`place_resolution_cache`). A verified item gains a canonical `provider_place_id`, resolver
coordinates, and Google's `businessStatus` (catches `CLOSED_PERMANENTLY` at ingest). Trippy
does not need to license an 11M-POI database — it needs to *check its AI against the places
APIs it already pays for*.

### 2.2 Pattern — provenance and confidence are visible, not implied

Wanderlog shows *why an item is on the list* ("mentioned in N travel guides"); TripAdvisor
shows review volume and recency. Confidence is a user-facing signal, not an internal score.

**Trippy translation:** per-item provenance (`verified` / `unverified`) rendered as a badge,
with unverified items ranked below verified ones. Trippy has no review corpus and should not
fake one — the honest signals available are *resolver verification* and *batch provenance*
(first-generation editorial picks vs. later "show more" batches).

### 2.3 Pattern — ranking is deterministic over metadata; personalization is interest weighting

TripAdvisor's Popularity Ranking — the most consequential ranking in travel — is a daily
recomputed deterministic function of review **quality × quantity × recency**
([TripAdvisor insights](https://www.tripadvisor.com/business/insights/resources/tripadvisor-popularity-ranking)).
Wanderlog and Mindtrip both express personalization as *declared-interest weighting* over the
grounded catalogue (onboarding quiz → profile → filtering/ordering). None of the studied
products makes a per-browse model call to rank a catalogue page.

**Trippy translation:** Option A is the industry norm. Rank with a small deterministic scoring
function over metadata the catalogue already carries; express `interestTags`/`pace`/`travellers`
as weights in that function and as category ordering (Option C). Reserve model-call
personalization for the conversational co-pilot, where a model call is already the medium
(parent decision 6).

### 2.4 What Trippy deliberately does differently

- **No review corpus, no fake social proof.** TripAdvisor's quality signal cannot be copied at
  Trippy's user count (production: 1 user). The substitute quality prior is verification +
  Claude's editorial curation rules (`claude.js:175-181`, already strong) + batch recency.
- **Editorial voice stays.** Competitors' weakness is the generic front page; Trippy's
  `whyItFits` prose is a differentiator — but it must be reframed as *destination-voice
  editorial* ("why this place is special"), because it is generated once globally and shown to
  every trip. Trip-fit framing ("matches your food interest · fits a relaxed afternoon") is
  composed deterministically at the trip layer, where it can be honestly claimed.

---

## 3. Real user scenarios (the brief's required eight)

| # | Scenario | Today | Under recommendation |
|---|---|---|---|
| 1 | Solo fast-paced food trip vs. slow family trip, same city | Identical output, identical order | Same global rows; different category order (food first vs. nightlife demoted), different item order (duration-fit), different fit lines. Zero extra generation cost. |
| 2 | "Show more" repeatedly | Unbounded blob growth; marginal items indistinguishable | Batch index recorded per item and penalized in ranking; per-category cap with archival of weakest unverified items; per-destination daily generation limit (Trust). |
| 3 | Cached suggestion closed or factually wrong | Served for the cache lifetime to everyone; no recourse | `businessStatus` check at verification suppresses `CLOSED_PERMANENTLY` at ingest; report action suppresses post-hoc; unverified items are badged. |
| 4 | Two cities normalize to an ambiguous key | One shared row ("Georgetown" collision) | Catalogue keyed `(city_key, country_code)` from the Q2 day pair — Georgetown MY ≠ Georgetown GY. |
| 5 | Same place under English/romanized/local names | Name-normalization dedup only; variants survive as duplicates | Canonical `provider_place_id` dedups verified items exactly; name/alias matching remains the fallback for unverified ones. |
| 6 | Multi-country trip browses several destinations | Works by city string; wrong-key risk on homonyms; no country context in generation | Panel derives `(city, country)` from the active day (Plan 6 Wave 3 exposes `resolvedCountry`); generation prompt receives the country; each destination is a distinct catalogue row. |
| 7 | Destination/day city changes after load | Frontend cache keyed by old string; new search needed | Same, but keys are day-pair-derived so a corrected day re-keys naturally; old rows stay valid for other trips. "In trip" matching gains exact `provider_place_id` ↔ `stops.provider_id` matching for discovery-added stops. |
| 8 | AI provider down, catalogue exists | Fresh cache: served fine. Stale cache: regeneration attempted, error event, user sees failure despite having data | Serve the stored catalogue whenever it exists, regardless of TTL, with generation marked unavailable; only an empty catalogue surfaces an error. |

## 4. Severity and likely frequency

| Finding | Severity | Frequency | Note |
|---|---|---|---|
| Q3-01 preferences unused | High (product promise) | Every trip | The onboarding questions are currently pure friction. |
| Q3-02 unvalidated shared merges | High (trust) | Every "show more" | Industry data (§2.1) says ~25% closed-venue rate is the *expected* failure rate for ungrounded output. |
| Q3-03 unbounded growth | Medium now, High over time | Cumulative | Cost/latency/noise compound; exclusion-list tokens grow per regeneration. |
| Q3-04 hero count vs. tabs | Medium (honesty of UI) | Live now | Observed 183 counted vs. 69 reachable. |
| Q3-05 show-more affordance | Low–Medium | Every use | 15s+ silent wait reads as broken. |

## 5. Authoritative-data recommendation

One rule, mirroring Q2's: **the global catalogue owns place facts; the trip owns fit.**

- **Global (shared, preference-free):** destination identity `(city_key, country_code)`;
  per-place records with canonical identity (`provider_place_id` when verified), resolver
  coordinates, `businessStatus`, provenance, batch, editorial prose (`why_go`, destination
  voice), category, duration/hours estimates, lifecycle status (`active/suppressed/archived`).
  Nothing derived from any trip's preferences or itinerary may be written here (extends the
  principle already encoded at `discovery.js:139-145`).
- **Trip (computed per request, never stored globally):** category selection and order, item
  ranking, fit lines, "in trip" matching, hidden/reported state effects on *this* view.
- **Place identity:** `provider_place_id` (e.g. `google:ChIJ…`) is authoritative when present;
  `normalized_name` is the fallback identity. This is the same identity family stops already
  use (`stops.provider_id` via the trusted-coordinates path).
- **Preference fields verdict (the brief's "justify or stop collecting"):** keep all three.
  `interestTags` → category selection/order + ranking boost; `pace` → duration-fit scoring;
  `travellers` → category-order adjustment (e.g. nightlife demoted for `family`). Dates remain
  collected for itinerary purposes but are *not* claimed by discovery yet (seasonal fit is
  deferred — no honest data source).

## 6. Design options and verdict

### Option A — global catalogue, local deterministic ranking — **RECOMMENDED (upgraded)**

As briefed, plus the grounding layer research showed is load-bearing: ranking quality "depends
on the metadata available in the global record" (the brief's stated risk), so the design's job
is to *put that metadata there* — verification provenance, batch index, canonical identity,
resolver coordinates, optional rating enrichment (§10 decision 2). Scoring is a pure function
`score(item, tripPrefs)`; zero model calls, zero marginal cost per browse, works offline-ish
(scenario 8).

### Option B — global catalogue, trip-specific AI reranking — **REJECTED for browse; reserved for co-pilot**

Adds latency, cost and a failure mode to every browse for explanations that deterministic
composition can honestly produce from declared preferences. No studied competitor does this on
a catalogue surface. The co-pilot (parked, parent decision 6) is where model-mediated
personalization belongs — it can consume the same grounded catalogue as bounded context when
that work is reactivated.

### Option C — curated category filters only — **ADOPTED as a component, insufficient alone**

Category selection/ordering from interest tags is the honest core of the trip layer and ships
inside the recommendation. Alone it would leave Q3-02/Q3-03 (quality, growth) unsolved and
justify collecting neither pace nor travellers.

### The recommended composite, concretely

1. **Schema:** normalize the blob into `discovery_destinations` (keyed `city_key +
   country_code`) and `discovery_places` (one row per item, with the §5 fields). The JSON blob
   and its whole-row TTL retire; per-item `generated_at`/`batch` replace them.
2. **Verification pipeline:** post-generation, items are resolved via the existing
   `placeResolver` chain (Nominatim → Google Text Search, biased by the destination pair),
   **asynchronously and throttled** (Nominatim is 1 req/s; ~240 items ≈ 4 min background work —
   never block the SSE stream on it). Field mask gains `places.businessStatus`. Outcomes:
   `verified` (identity + coordinates + status captured), `unverified` (no confident match —
   badged and rank-penalized), suppressed at ingest when `CLOSED_PERMANENTLY`. Google calls at
   this scale stay within the Places API monthly free allowances (usage well under the
   Essentials/Pro free caps; see [pricing](https://developers.google.com/maps/billing-and-pricing/pricing)).
3. **Deterministic ranking:** verified boost, batch penalty, interest-category boost,
   pace/duration fit, optional TripAdvisor-inspired quality term `(rating − 3.5) ×
   log10(1 + rating_count)` if enrichment is approved. Ties keep generation order (Claude's
   editorial order is a real prior).
4. **Bounds:** per-category active cap (proposed 45) with archival of lowest-ranked unverified
   items on overflow; exclusion list built from active+archived names, most-recent-first,
   token-capped; per-destination generation limit per day.
5. **Honest explanation:** global `why_go` rewritten in destination voice (prompt change);
   trip-fit line composed deterministically ("Matches food · ~2h · verified place").
6. **Recovery:** report action (single-user trust model: report ⇒ global suppress + log);
   stale-catalogue-serving when generation fails (scenario 8).
7. **UI honesty:** tabs = essentials + interest categories + a "More" group making every
   cached category reachable; hero count = reachable items only (Q3-04); show-more gets a live
   progress affordance (Q3-05).

## 7. Dependencies on other reports

- **Q2 / Plan 6:** the catalogue key consumes the day's derived `(city, countryCode)` pair.
  Backend derivation shipped (Plan 6 Wave 2, commit `2a60547`); the *frontend* wiring that
  puts `resolvedCountry` in the panel's hands and passes `locationCountry` on add-stop is
  Plan 6 Wave 3 (§3.4 there). **Q3 planning is unblocked now; Q3 implementation starts after
  Plan 6 Wave 3 lands** (Wave 4's column retirement also removes `trip.destinations` from the
  panel's fallback chain, `DiscoveryPanel.jsx:248`).
- **Q1:** none beyond what Q2 already mediates (bookings→day identity).
- **Trust (Gate D):** generation limits, resolver-call budget guard, verification-queue
  failure isolation (a stuck queue must not affect serving), suppression audit logging,
  migration atomicity with backup-first, and the existing "one trip cannot pollute another's
  results" invariant pinned by tests.

## 8. Migration and backward-compatibility risks

- **Data migration:** production `global_discovery_cache` holds a handful of rows (Chengdu-trip
  era). Backfill parses each blob into the new tables: `country_code` via
  `countryCodeFromName(display_name)` else `''`; all items `provenance='unverified'`,
  `batch=0`, `generated_at` from item stamps where present. Old table drops in a later
  migration once the route no longer reads it (never edit existing migrations — CLAUDE.md).
- **API/protocol:** SSE event shape is extended additively (items gain `provenance`,
  `fitLine`, etc.); `POST /:tripId/discover` body gains optional `countryCode`. The discovery
  route is not PWA-cached (unlike map-config), so no stale-client shape constraint applies —
  but the old client must keep working against the new server during rollout.
- **Unknown-country destinations:** `country_code=''` rows are legal (Q2 tolerates null-country
  days); when a day later gains a country, a new catalogue row generates and the `''` row ages
  out via the bounds/archival lifecycle. Accepted duplication at this scale.
- **Cost regression risk:** verification adds external calls where none existed. Mitigations:
  Nominatim-first (free), `place_resolution_cache` reuse, per-destination one-shot
  verification, and a hard daily resolver-call budget with a loud log when hit.

## 9. Verification strategy

- **Unit:** scoring function (each term isolated; tie preserves generation order); category
  ordering per traveller/pace combinations; exclusion-list token cap; cap-and-archive
  replacement choice (never archives verified over unverified).
- **Pipeline fixtures:** generated batch containing a real place (resolves → verified with
  place id + coords), a fabricated place (no resolver hit → unverified), a closed place
  (mocked `businessStatus: CLOSED_PERMANENTLY` → suppressed), and a local-name duplicate of a
  verified item (place-id dedup collapses it).
- **Scenario tests:** the eight §3 scenarios as service-level tests — notably scenario 1
  (two trips, same city, different prefs → same rows, different order/fit lines, byte-identical
  global tables afterwards: the pollution invariant) and scenario 8 (Claude client mocked to
  fail → stored catalogue still streams).
- **Migration:** 001→latest on empty DB and on a production snapshot copy; blob backfill
  produces item-count parity per destination.
- **Manual 375px pass:** hero count equals the sum of reachable tab counts (Q3-04 closed);
  show-more shows live progress and new items are visibly badged/appended (Q3-05 closed);
  report action removes an item and survives reload.
- **Metric (the brief's "adds users keep, not browse"):** structured log line per
  discovery-sourced add (`[discovery] add trip=… place=… provenance=…`) plus
  `generation_count` per destination; adds-per-generation is derivable from logs at this
  scale without an analytics table.

## 10. Open product questions requiring owner input (Gate C)

1. **Unverified items: show-with-badge (recommended) or hide entirely?** Showing preserves
   breadth and lets the resolver's blind spots (small local venues Nominatim misses) still
   surface, ranked lower and honestly labeled; hiding is stricter but shrinks the catalogue's
   long tail.
2. **Rating enrichment:** also capture Google `rating`/`rating_count` at verification to power
   the quality term (§6.3)? Costlier field tier, still within free monthly caps at current
   volume. Recommended: approve, flag-guarded, so the ranking term can be evaluated live.
3. **Report semantics at current user count:** report ⇒ immediate global suppression + audit
   log (recommended for a 1-user production), or trip-scoped hide with a review queue
   (multi-user posture, more machinery)?
4. **Bounds values:** 45 active items per category, max 3 generations per destination per day,
   400-name exclusion cap — accept, or adjust?
5. **Sequencing of the UI honesty fixes (Q3-04/Q3-05):** ship inside Plan 7's frontend wave
   (recommended — they touch the same component the wave rewrites), or cherry-pick to
   production sooner as a standalone micro-fix?

---

## Cross-cutting findings fed back to the parent register

**Q3-04** (hero count counts unreachable categories — live observation) and **Q3-05** ("show
more" lacks a loading affordance — live observation) registered in the parent doc. Both are
independent of the option choice and are closed by Plan 7's frontend wave regardless of the
Gate C decisions.
