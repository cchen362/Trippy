# Discovery Catalogue Quality Review — unverified suggestions, dedupe blind spot, and country capture

**Status:** FINDINGS ONLY — 2026-07-26. Nothing implemented, nothing decided. Investigation triggered by the Plan 24 owner production QA pass (see [Plan 24](../plans/Implementation%20Plan%2024%20Google%20Maps%20Deep%20Link%20Place%20Identity.md) Appendix B), where a Discovery-added stop opened coordinate-only and the owner recognised odd naming and apparent duplicates in Discovery suggestions.

**Scope boundary.** This reviews the **Discovery catalogue's data quality** — what gets generated, what gets verified, what gets served. It is **not** a Discovery redesign, and it does **not** revisit deep links: the owner decided 2026-07-26 that **precision beats polish**, so the Nominatim-first resolver ordering stays and Plan 24's behaviour is final. See "Explicitly out of scope" below.

**All figures measured read-only against production on 2026-07-25/26** (`docker exec trippy-trippy-1`, `/app/data/trippy.db`). They are inputs to any plan that follows — do not re-derive them.

---

## Production baseline

2,014 `discovery_places` across 11 `discovery_destinations` (~183/city), all generated in 2026-07.

| status | provenance | n |
|---|---|---|
| active | verified | 881 |
| active | **unverified** | **706** |
| active | pending | 11 |
| archived | verified | 336 |
| archived | unverified | 78 |
| suppressed | verified | 2 |

**User-visible (`status='active'`) = 1,598, of which 706 (44%) were never confirmed to exist.**

| destination | cc | active | verified | **unverified** |
|---|---|---|---|---|
| Taipei | TW | 298 | 158 | **140** |
| Shanghai | CN | 259 | 110 | **149** |
| kualalumpur | MY | 214 | 119 | **95** |
| Denpasar | ID | 148 | 128 | 20 |
| ChengDu | CN | 143 | 94 | **49** |
| Hangzhou | CN | 121 | 68 | **53** |
| Kaohsiung | TW | 96 | 68 | 28 |
| 南疆 | *(empty)* | 92 | **0** | **92** |
| Chong Qing | CN | 79 | 68 | 11 |
| Bali | ID | 78 | 68 | 10 |
| 北京 | *(empty)* | 70 | **0** | **70** |

---

## Findings

### F1 — Unverified suggestions are served to users with no signal (severity: HIGH)

`backend/src/db/discoveryCatalogue.js:82` selects on `status = 'active'` **with no `provenance` filter**. Verified and unverified rows are returned identically; the client has no way to distinguish them.

An unverified row means the resolver never confirmed the place exists: `provider_place_id`, `lat`, and `lng` are all NULL. **44% of what a user browses has never been checked against any geocoder.**

This is the trust question the owner raised. A suggestion that doesn't exist is a worse failure than a pin without a name — and it is the same trust argument that decided the Plan 24 precision-over-polish call.

**Not a bug, exactly** — it is an unstated product default. It needs an explicit decision (D1).

### F2 — Dedupe is identity-based, so it structurally cannot see the 44% (severity: HIGH)

The category-cap logic (`discoveryCatalogue.js:222-238`) archives the unverified tier before the verified tier, and among rows that *have* an identity it works perfectly: **881 active rows with a `provider_place_id` → 881 distinct places, zero duplicate slots.**

But identity is exactly what unverified rows lack. They cannot be grouped by `provider_place_id`, so **duplicate real-world places among the 706 are undetectable by the current mechanism.**

Confirmed live. Three *active* rows for the same Kaohsiung lake, all unverified, none deduplicated:

- `Lotus Pond`
- `Dragon and Tiger Pagodas (Lotus Pond)`
- `Zuoying Scenic Area (Lotus Pond Watershed) – Ecology Overview`

(The verified sibling `Zuoying Scenic Area (Lotus Pond Watershed)` carries `google:ChIJa9QbdXUFbjQRH2EPZEFWJKs`.)

This validates the owner's observation of "seemingly duplicated suggestions for the same place." An earlier measurement in the QA session reported zero duplication; that measurement only covered identified rows and understated the problem. **Any dedupe that runs pre-verification must key on normalized/fuzzy name, not `provider_place_id`.**

### F3 — The display name is also the geocoder query (severity: HIGH — likely root cause of much of F1)

`backend/src/services/discoveryVerify.js:184` calls `budgetedResolve({ queryText: row.name, … })`, falling back to `row.local_name` at L188. **`name` does double duty: card headline and geocoder input.**

Generation emits descriptive qualifiers into `name`. Real active-unverified samples:

```
Chuan Wei Small Eat (Xinyi)
Jianguo Jade and Flower Market (weekends only)
M50 Creative Park (Textile factory typology)
Pomegranate and Mulberry Seasonal Wellness (summer-autumn)
Muddy's Cafe Quiet Morning Work Space
```

These are **real places wrapped in editorial framing**, not hallucinations — the sample also contains plainly real entries (`Jing'an Temple`, `Nanxiang Steamed Bun Restaurant`, `Jade Buddha Temple Art Museum`) that simply were not verified. The qualifier that makes a card readable is the same string that makes geocoding fail.

**Hypothesis to test in the dive** (not yet proven): stripping parenthetical/qualifier text, or splitting `name` (display) from a `search_name` (query), would convert a large share of the 706 into verified rows at **no additional per-call cost** — the resolver call already happens, it just currently asks a bad question.

### F4 — Free-text destination search yields an empty `country_code`, permanently (severity: MEDIUM)

Confirmed mechanism, answering the owner's question directly: **it is the free-text path, not the language.**

`frontend/src/components/discovery/DiscoveryPanel.jsx:376-378` — the manual "Go" search box has no country field, so a manually committed search **always clears** the committed country ("free-text search shouldn't force a country match"). `backend/src/routes/discovery.js:87` then sets `normalizedCountryCode = ''`.

There is a recovery path (D6, Plan 9 W5.1) at `discovery.js:112-125`: an empty-`countryCode` request adopts the country of existing rows **only if exactly one country-coded row already exists**. For a brand-new destination there is nothing to adopt, so the destination is created with `country_code = ''` and keeps it.

Non-English names are *correlated* but not causal — you reach for the free-text box when the picker has no entry for 北京 or 南疆. Language matters separately and downstream: geocoding a CJK name with no region bias is harder, and `searchGooglePlaces` only sets `body.regionCode` when the code matches `/^[A-Z]{2}$/` (`placeResolver.js:480`), so an empty country also strips region biasing from the provider call.

### F5 — 北京 and 南疆 are 162 permanently unverifiable active suggestions (severity: MEDIUM)

Both have `country_code = ''`, `generation_count = 1`, `last_generated_at = 2026-07-05` — the two oldest destinations, and the only two with an empty country. **0 of 162 active suggestions verified.**

`discoveryCatalogue.js:74` looks destinations up with `country_code != ''`, so these rows are likely unreachable by the normal lookup path while still occupying 10% of the served catalogue.

The owner's read — "generated way back, cleanup necessary" — is consistent with the dates. Whether they are stale-by-age, blocked by F4, or predate the verification pipeline entirely is **not yet determined** and should be settled before choosing between cleanup, backfill, and regeneration.

### F6 — The resolver budget is not the constraint (severity: LOW — rules out a tempting explanation)

`DISCOVERY_RESOLVER_DAILY_BUDGET` defaults to 500 (`config.js:55`). Peak observed daily verification was **421** (2026-07-07); every other day was 39–143. **The cap was never hit on any observed day**, so "budget exhaustion" does not explain the 44%.

Do not assume the budget is the cause. The drain loop's actual firing behaviour is unexamined.

---

## Independent follow-up review — 2026-07-26

This follow-up traces the initial production findings through the current generation,
verification, capping, serving, frontend, trip-scope, and day-override paths. It is
review-only. Where it conflicts with F1-F6 above, this section is the more complete
current assessment; the original findings remain as the record of the first production
investigation.

### Pipeline and dependency map

1. `POST /api/trips/:tripId/discover` resolves a `(canonical destination, country_code)`
   catalogue row. Fresh reads return every active row, regardless of provenance.
2. On a true miss, stale refresh, or Show more, Haiku generates candidates across eight
   categories. The true-miss path streams raw model candidates before they have a DB id
   or settled provenance.
3. Generated candidates are inserted as `unverified`, deduped only by exact
   `normalized_name` within the destination.
4. The 45-row category cap runs immediately after insert and before verification.
5. Active survivors enter an asynchronous per-destination queue. The worker calls the
   shared place resolver with `name`, aliases, destination display name, and country when
   present. It tries `local_name` only after a non-confident first result.
6. The shared resolver checks cache/curated evidence, queries Nominatim variants, and
   calls Google Places Text Search only if Nominatim returns no result. Provider identity
   dedupe occurs only after a row becomes verified.
7. Stored active rows feed both the Discovery UI and co-pilot catalogue search. The
   frontend uses trusted coordinates only for verified rows; other adds go through stop
   resolution again.

The main external dependencies are Anthropic generation, SQLite catalogue and resolution
caches, the public Nominatim endpoint, Google Places Text Search/Autocomplete/Details,
trip-scope geography, day-derived geography, and the stop-resolution pipeline.

### Corrections to the initial findings

#### C1 — `unverified` does not mean no lookup was attempted

The terminal `unverified` state is written after a non-confident resolver result or a
thrown lookup. `pending` is the state used when the worker did not complete an attempt
because its in-memory daily budget was exhausted. The 706 rows were not confirmed, but
the DB cannot show which provider/query variants were attempted or why each failed.

The API does send `provenance`, and the current card Details view renders `Verified` or
`Unverified`. The collapsed browsing surface gives no provenance signal, so the product
trust concern remains, but "the client has no way to distinguish them" is no longer an
accurate description of the live UI.

#### C2 — Fuzzy pre-verification dedupe is not a safe default

F2 correctly identifies the provider-identity blind spot. However, similar names can
represent distinct attractions, complexes, entrances, districts, or experiences. Fuzzy
matching is useful for suspect clustering or review, not automatic global suppression.
Exact canonical names/aliases can prevent obvious repeats; automatic archival should
prefer provider identity or strong multi-signal evidence.

#### C3 — `name` is a contributor, not yet the proven root cause

The resolver already expands aliases and strips bracketed/parenthetical variants. A
separate canonical query identity is still directionally sound, because editorial copy
does not belong in the place name, but a single `search_name` column should not be treated
as sufficient until resolver outcomes are measured by query variant and provider. Existing
rows would also require new re-verification calls, so "no additional per-call cost" applies
only to the future path, not cleanup of the current corpus.

#### C4 — Empty-country rows are fork-prone, not necessarily unreachable

An exact free-text request can still select an existing `country_code=''` row. A
country-qualified request for the same canonical label instead selects or creates a
separate row. The practical failure is split identity and weak provider context, not proof
that the old row can never be served.

#### C5 — The production snapshot cannot rule out the resolver budget

The 500/day counter tracks `budgetedResolve()` invocations in memory, not provider HTTP
requests. One invocation can issue multiple Nominatim variants; `local_name` fallback can
consume another budget unit; unverified failures have no attempt timestamp; and a process
restart resets the counter. Daily verified-row counts therefore cannot prove that the cap
was never reached or that provider request volume stayed below it.

### Additional high-severity findings

#### A1 — `verified` is not yet a strong enough identity guarantee

A Nominatim result is returned even when its own classifier labels it `estimated`; because
Google fallback runs only when Nominatim returns no result, a weak Nominatim candidate can
block a stronger provider attempt and produce a false negative.

The inverse risk is more serious: the first Google Text Search result is labelled resolved
without a returned-name similarity check. Discovery verification then checks resolved
status and country, but an empty-country destination accepts any resolved country. A vague,
editorial, or fabricated query can therefore attach to an unrelated real place and receive
the product's strongest trust label.

Google documents Text Search results as candidate matches ordered by perceived relevance.
`regionCode` can bias results, but it is not a hard identity or country guarantee:
https://developers.google.com/maps/documentation/places/web-service/text-search

This integrity question should be settled before provenance is promoted more strongly in
the UI. It is worse to call the wrong identity verified than to admit that a plausible
candidate is unconfirmed.

#### A2 — Cap-before-verification can prevent catalogue improvement

The live order is `insert -> enforceCategoryCap -> enqueueForVerification`. At a full
category, new rows enter as unverified and carry a later-batch ranking penalty. They are
therefore likely to be archived before the worker sees them. Verification skips archived
rows, while archived names remain in the future generation exclusion list.

Show more or stale refresh can consequently spend model output on candidates that are
never allowed to establish identity or displace weaker incumbents. Existing active
unverified rows can become structurally entrenched. The current test suites cover capping
and verification independently but do not cover this combined lifecycle.

#### A3 — A true catalogue miss is published before verification

The true-miss SSE path streams raw Claude category items during generation and does not
re-stream their post-insert/post-verification state. First-view cards have no catalogue id
and no settled provenance, cannot be reported by id, and follow the unverified add-to-stop
path. Therefore D1 cannot be implemented by adding a provenance filter to stored catalogue
reads alone. The real product decision is whether new candidates are published before
verification, after verification, or progressively as verification completes.

#### A4 — Terminal unverified rows cannot explain or heal themselves

The schema records no attempt timestamp, provider attempted, failure reason, returned
candidate, match score, or query variant. Stale refresh excludes stored names and retries
only `pending`, not terminal `unverified`, rows. The current 706 will not naturally recover
after query, resolver, or provider improvements without an explicit re-verification path.

#### A5 — Public Nominatim needs an explicit operational decision

The public Nominatim policy permits an absolute maximum of one request per second, but
discourages periodic bulk geocoding and requires caching, attribution, and an identifying
User-Agent. A Discovery generation can produce roughly 240 candidates and verifies them
in the background. That may be acceptable for a very small private installation, but it
is not a dependency to scale implicitly. The orchestrator should assess continued public
endpoint use versus a commercial or self-hosted alternative and verify attribution/User-
Agent compliance:
https://operations.osmfoundation.org/policies/nominatim/

### Country capture is a cross-surface identity problem

Free text is a necessary escape hatch, especially for informal regions, non-English
labels, and destinations providers do not index well. Today it behaves differently across
three entry points:

- **Create/edit trip:** committing free text creates a trip-scope chip with the label but
  `countryCode: null`, `kind: 'freetext'`, no provider id, and no bounds.
- **Plan day header:** a typed override attempts to infer country from an explicit trailing
  country or the shared resolver, then stores `city_override_country`; inference may fail.
- **Discovery destination header:** committing typed text deliberately clears the country
  and sends `null`, even if the previous day/scope had a known country.

Asking every user to fill a permanent Country field would expose storage mechanics and add
friction to the common picker path. Silently borrowing country from the trip is also unsafe.
The owner supplied the decisive counterexample: a trip already contains picker-selected
Shanghai (`CN`), then the user adds `冲绳` (Okinawa) through free text because the picker does
not find it. Inheriting the trip's only known country would confidently stamp the Japanese
destination as China.

Country therefore must be destination-level evidence, never a trip-level default. Matching
an existing trip scope is safe only when the typed label itself canonically or explicitly
matches that scope; "the trip currently has one country" is not identity evidence.

Recommended interaction principle:

> Country is required for durable destination identity, but requested from the user only
> when Trippy cannot resolve it confidently.

A future design should independently assess this evidence ladder:

1. Parse an explicit input such as `南疆, China`, storing display label and country
   separately rather than keeping the whole string as the label.
2. Reuse an existing scope only on destination-label/provider identity match, never merely
   because it is the trip's sole or current country.
3. Use provider/geocoder evidence for the typed destination itself, preserving returned
   candidates and confidence rather than collapsing immediately to a country code.
4. When unresolved or ambiguous, ask a compact inline follow-up such as `Which country is
   this in?`, optionally offering a suggested country but requiring confirmation.
5. Permit an unknown-country draft as a last resort for itinerary display, but decide
   separately whether it may create or refresh a durable shared Discovery catalogue.

Language or writing system alone is not adequate inference: Chinese text can refer to
mainland China, Taiwan, Hong Kong, Macau, Singapore, Japan, or elsewhere. Booking evidence
and other trip context can suggest a country, but must not silently become identity for a
different free-text destination.

The durable contract should remain one structured destination reference across trip chips,
day display/discovery scope, and Discovery search: display label, country code, scope kind,
provider identity, bounds/center when available, source, and confidence. The UI can retain
one primary destination field and reveal country confirmation only when needed.

## Initial decisions raised by the production pass

- **D1 — Should unverified suggestions be served at all?** (a) hide them entirely; (b) serve with a visible "unconfirmed" affordance; (c) keep as-is. Everything else depends on this. Note (a) removes 44% of the catalogue overnight, including plainly real places, so it is not obviously the safe option.
- **D2 — Split `name` into display vs. search?** Additive schema change. Highest suspected yield per unit of work (F3), and it costs no extra API calls.
- **D3 — Add pre-verification dedupe on normalized name?** Directly addresses F2 and the owner's original observation.
- **D4 — What happens to 北京 / 南疆?** Delete, regenerate with a proper country, or leave dormant — decide only after F5's cause is established.
- **D5 — Should free-text search attempt country inference?** Backfilling a country for a typed destination conflicts with the deliberate "don't force a country match" behaviour at `DiscoveryPanel.jsx:376`. Any change must not regress that intent.

## Revised recommendation for planning

Do not implement D1-D5 as independent patches. The recommended sequence for an eventual
plan is:

1. **Define the verification contract first.** Specify the name, destination-scope,
   country, provider, and confidence evidence required before a row may be called verified.
   Separate Discovery verification semantics from the closed Plan 24 deep-link behaviour;
   this review does not reopen the owner's Nominatim-first deep-link decision.
2. **Correct the catalogue lifecycle.** New candidates must have a fair opportunity to
   establish identity before the final active-set cap decides what remains. Verified new
   candidates should be able to displace weaker incumbents without allowing catalogue
   growth to become unbounded.
3. **Choose an honest publish policy.** Verified rows should be the primary catalogue.
   Plausible unverified candidates may remain as explicitly secondary ideas rather than
   disappearing overnight, but `pending`, attempted-and-failed, and never-attempted states
   should not be collapsed. Account explicitly for true-miss streaming.
4. **Separate canonical identity from editorial presentation.** Generate/store a clean
   canonical place-name candidate plus local name and aliases; keep descriptive framing in
   description/why-go. Treat fuzzy matching as a review signal, not an automatic delete.
5. **Add attempt-level observability and a bounded re-verification strategy.** Only then
   measure whether query quality, provider coverage, destination context, process restarts,
   or worker execution explains most failures and estimate the actual provider cost of
   repairing the corpus.
6. **Unify country capture across trip scopes, day overrides, and Discovery.** Keep free
   text, enrich it when destination-specific evidence is strong, and ask for country only
   when ambiguous. Never inherit country solely from existing trip context.
7. **Repair legacy empty-country catalogues after prevention is settled.** Rebuild Beijing
   and Southern Xinjiang under reviewed country-qualified identities, then remove obsolete
   buckets rather than leaving parallel catalogue truth.

The architecture has useful foundations — normalized shared storage, destination/country
keys, bounded generation, provider identity, deterministic ranking, reporting, and
user-confirmed itinerary mutation. It does not require a wholesale Discovery redesign.
The next plan should focus on verifier integrity, lifecycle ordering, explicit trust states,
and a coherent destination-identity interaction across entry points.

## Product intent and scope boundary — catalogue health, not community machinery

The relevant product goal is a **demand-grown shared catalogue**: user browsing and Show
more expand one reusable destination catalogue, while verification, bounded retention, and
feedback keep it trustworthy over time. The current work should make that existing model
healthy; it should not turn Discovery into a social contribution platform.

The following concerns are interdependent with this review and belong in the same
investigation and, where reasonably bounded, the same implementation plan:

- let new candidates establish identity before the final category cap decides whether they
  can remain active or displace weaker incumbents;
- define controlled retry/re-verification for terminal unverified rows;
- assess a small, provider-backed revalidation pass for existing verified places when a
  destination becomes stale, focused on identity and permanent closure rather than
  regenerating stable editorial copy or refreshing every place every seven days;
- record enough attempt, outcome, timestamp, and report-reason evidence to operate and
  audit catalogue cleanup;
- keep generation, revalidation, provider cost/policy, and active-set bounds explicit so
  catalogue health does not become an unbounded background process.

If existing-place revalidation proves materially larger because of provider cost, policy,
or schema implications, the orchestrator may split it into a clearly scoped follow-on
wave. It should still be assessed here because the stale-refresh and trust contracts cannot
be designed honestly without deciding what happens to older verified businesses.

The following are deliberately excluded as premature over-engineering:

- user-submitted catalogue entries or public contribution flows;
- votes, likes, saves, endorsements, or behavioral popularity ranking;
- contributor identity, reputation, ownership, or public attribution;
- multi-report thresholds, dispute handling, or moderation queues;
- social/community surfaces of any kind.

Those features deserve a separate product review only if Trippy's future audience and usage
create a demonstrated need. They must not block the narrower goal of making the current
shared catalogue trustworthy, bounded, and capable of improving over time.

## Explicitly out of scope

- **Deep-link naming / resolver ordering.** Closed by owner decision 2026-07-26: precision over polish. Nominatim-first stays.
- **Discovery panel UI/IA redesign.** The pipeline shape looks sound; this is a data-quality review.
- **Plan 24 Appendix A (booking sync overwrites a user pin).** Separate, already spun out.
- **Generation model or prompt-cache changes**, unless D2 forces a prompt change.

## Verification notes for whoever picks this up

Read production read-only by heredoc-ing a `.mjs` to `/tmp`, `docker cp`-ing it in, and running it — import dependencies with `createRequire('/app/backend/')`, since a script in `/tmp` cannot resolve `better-sqlite3` by bare specifier. Nested PowerShell→ssh→bash→`node -e` mangles SQL string literals into column identifiers.

**Never run `docker exec trippy-trippy-1 printenv` unfiltered** — it prints `GOOGLE_PLACES_API_KEY` in cleartext. Read `config.js` defaults or evaluate a boolean instead.
