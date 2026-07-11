# Implementation Plan 12 — Co-pilot Grounding (Catalogue Search Tool, Empty-Catalogue Policy, Trip-Health Checks)

**Status: READY FOR IMPLEMENTATION (finalized 2026-07-12). No waves started.**

**Origin:** Stage 2 of the owner-approved co-pilot sequencing (decision session
2026-07-12, following the
[Co-pilot Foundation and Integration Review](../reviews/2026-07-11-copilot-foundation-and-integration-review.md)).
Stage 1 (trust foundation) shipped as
[Implementation Plan 11](Implementation%20Plan%2011%20Copilot%20Trust%20Foundation.md),
CLOSED in production at `7d6c904`. Scope confirmed by owner 2026-07-12: catalogue
search tool AND the full deterministic trip-health check set in this plan.

**Goal:** ground the co-pilot in data Trippy already owns. Two new read-only model
tools: `search_discovery_catalogue` (so "add from Discovery" recommendations come
from the verified shared catalogue, never from training knowledge) and
`check_trip_health` (deterministic gap/contradiction detection computed in app
logic, with the model explaining and prioritizing — review Direction C + F). Plus
the owner-settled empty-catalogue policy: never block a chat turn on generation;
answer with what exists, kick generation off in the background, invite a follow-up.

**Explicitly NOT in this plan:** bottom sheet, contextual entry points, seed
prompts (Stage 3); route/distance matrix tools; live/proactive data (review
Direction G); any new persistent UI chrome; undo.

---

## 0. Verified facts this plan is built on (traced 2026-07-12)

Confirmed in current `main` (`7d6c904`); implementation sessions must not re-derive them.

1. **The co-pilot stream has no tool-result loop.** `streamCopilotResponse`
   (`backend/src/services/claude.js:392-518`) makes ONE `client.messages.stream`
   call with the single terminal tool `PROPOSE_ITINERARY_CHANGES_TOOL`; prose
   streams via `on('text')`, the tool_use block is read from `finalMessage()`, and
   the turn ends. A query tool (search, health check) requires an agentic loop:
   when `stop_reason === 'tool_use'` for a query tool, execute it server-side,
   append the assistant turn + `tool_result` to `messages`, and open a new stream —
   repeating until a terminal stop. The system prompt carries
   `cache_control: { type: 'ephemeral' }` (`claude.js:445`), so loop continuations
   within a turn re-read it warm.
2. **Model is `claude-sonnet-4-6`**, `max_tokens: 4096`, via `@anthropic-ai/sdk`
   streaming (`claude.js:442-448`). Turn usage + context size already logged
   (`claude.js:501-503`; Plan 11 W1.6 measured tiny-trip context ≈676 chars,
   TTFD ≈1-2s).
3. **The catalogue is directly queryable and shared (global, not per-trip).**
   `discovery_destinations` rows are keyed `city_key` (= `canonicalGeoKey`) +
   `country_code`; `discovery_places` rows carry `name, category, description,
   why_go, estimated_duration, opening_hours, local_name, aliases_json,
   photo_query, scene_type, lat/lng, provenance, batch, provider_place_id,
   status`. Accessors live in `backend/src/db/discoveryCatalogue.js`
   (`getOrCreateDestination:21`, `listCountryCodedRows:45`, `listActivePlaces:53`,
   `insertPlaces:74`, `listExclusionNames:139`, `enforceCategoryCap:174`,
   `getDailyGenerationCount:222`, `incrementDailyGenerationCount:229`).
4. **Ranking is trip-aware and reusable.** `rankPlaces`, `orderCategories`,
   `parseDurationHours`, `TAG_TO_CATEGORY` (`backend/src/services/discoveryRank.js`)
   consume `{ interestTags, pace, travellers }` built from the trip row
   (`routes/discovery.js:161-165`). `serializePlaceRow`
   (`routes/discovery.js:92-113`) surfaces `lat/lng` ONLY for
   `provenance === 'verified'` rows and composes the honesty-gated `fitLine`.
5. **Generation is route-coupled today.** The whole generate/merge pipeline —
   exclusions → `discoverDestination` → `insertPlaces` → `enforceCategoryCap` →
   `enqueueForVerification` → `last_generated_at`/`generation_count` update →
   `incrementDailyGenerationCount` — lives inline in `POST /discover`
   (`routes/discovery.js:296-393`), interleaved with SSE `write(...)` calls and a
   keep-alive ping. `discoverDestination(destination, existingStopTitles,
   onCategory)` itself (`claude.js:233`) is already route-independent
   (callback-based, no res). Verification is fire-and-forget by design
   (`discoveryVerify.js:243`, queue drains after the request).
6. **Cost guards:** 7-day TTL (`routes/discovery.js:26`), max 3 generations per
   destination per UTC day (`MAX_GENERATIONS_PER_DESTINATION_PER_DAY`,
   `routes/discovery.js:24,247-259`, backed by daily table from migration 017).
   Generation is NOT automatic at trip creation; it fires on Discovery open when
   the catalogue is missing/stale (owner-verified fact, 2026-07-12).
7. **Destination scope is the authority and is resolvable server-side.**
   `listTripScopes(tripId)` (`services/trips.js:525`) returns the persisted
   position-ordered scope rows; `buildTripScopes(days, storedScopes)`
   (`trips.js:164`) folds in day-derived seeds; each scope has
   `{ label, canonicalKey, boundsJson }`. `canonicalGeoKey` + `scopesMatch` live in
   `utils/geoIdentity.js`. A scope's `canonicalKey` equals the catalogue row's
   `city_key`, so scope → catalogue-destination resolution is a key match plus the
   country-fallback idiom already written at `routes/discovery.js:185-194`.
8. **The co-pilot context already names the destinations.** `copilotTripContext`
   (`services/copilotTools.js:100-137`) includes `trip.destinations` /
   `destinationCountries` and per-day `city`, plus `bookingLinked` flags and
   minimized bookings (`type, title, confirmationRef, startDatetime, endDatetime,
   origin, destination`).
9. **Proposal pipeline is settled and stays untouched in shape.**
   `propose_itinerary_changes` schema (`copilotTools.js:5-93`) →
   `createProposal`/`applyProposal` (`services/copilotProposals.js`) with
   validation, fingerprint staleness, D5 loss warnings, atomic apply. `add_stop`
   accepts optional `lat`/`lng` which are distrusted (`coordinateSource:
   'copilot'`) and re-verified by the resolver (Plan 11 fact 14).
10. **Health-check raw material exists on the trip detail.** Stops carry `time`
    (nullable), `bookingId`, `location_status`
    (`user_confirmed|estimated|unresolved|...`, `services/stops.js:34,158,274`);
    days carry `date` and derived geography; bookings carry typed
    `startDatetime`/`endDatetime`. Booking-linked stops are materialized rows with
    `booking_id` (+ `booking_required`, see `services/bookings.js:156-157`).
    *Not yet traced:* the exact field mapping between a materialized stop's `time`
    and its booking's datetime — Wave 3 must trace it in `bookings.js` before
    implementing the drift check.
11. **Frontend co-pilot surface:** `useCopilot.js` consumes SSE event types
    `text | proposal | done | error`; `CopilotPanel`/`MutationPreview` render
    proposals with status-aware product-voice copy (Plan 11 Wave 3). Unknown SSE
    event types are currently unhandled — new event types are additive.
12. **Test baseline:** full backend suite green at `7d6c904` — 512 tests, 27 files
    (Plan 11 close). Frontend `npm run build` clean.

---

## 1. Design decisions (owner-approved 2026-07-12 — encode, don't re-open)

- **G1 — The catalogue is the only source of new-place recommendations.** When the
  user asks for place suggestions for an in-scope destination, the model MUST call
  `search_discovery_catalogue` before naming specific places, and recommendations
  must come from returned records (cited by `placeId`). No web browsing, no
  training-knowledge place invention. General destination color in prose is fine;
  concrete "add this place" suggestions must be grounded.
- **G2 — Query tools vs terminal tool.** `search_discovery_catalogue` and
  `check_trip_health` are read-only query tools with a `tool_result` round-trip
  (agentic loop, fact 1). `propose_itinerary_changes` remains terminal — it never
  gets a tool_result. Loop budget: hard cap of 5 query-tool calls per user turn;
  on hitting the cap the server injects a tool_result telling the model to answer
  with what it has.
- **G3 — Empty/stale-catalogue policy (owner-settled).** In-scope destination,
  catalogue empty or past TTL: the search tool returns whatever exists (possibly
  nothing) plus a `catalogueState` the model must relay honestly — and the server
  kicks generation off in the background (fire-and-forget, never blocking the SSE
  turn), telling the user to ask again shortly (~1 min). Inherits the existing
  3-per-destination-per-UTC-day cap: when capped, no generation fires and the
  state says so. Stale catalogues still return their stored breadth immediately.
- **G4 — Out-of-scope destinations get a polite decline.** The destination-scope
  model stays the authority and the cost boundary: a search for a destination that
  matches no trip scope returns `out_of_scope` (no generation, no catalogue read);
  the model declines and suggests adding the destination to the trip. Example from
  the decision session: Suzhou on a Shanghai-only trip.
- **G5 — Grounded adds carry catalogue identity, server-resolved.** `add_stop`
  gains an optional `placeId`. Validation confirms the place is an active row of an
  in-scope destination's catalogue; the SERVER copies the verified row's
  coordinates/photo descriptor into the stop at apply time (trusted, because they
  came from our own resolver pipeline — reuse the existing Discovery→trip add
  semantics, traced in Wave 2). Model-supplied `lat`/`lng` remain distrusted
  exactly as today. The proposal preview shows provenance ("verified place") only
  when the underlying row is `provenance === 'verified'` — never overstate
  (review §8).
- **G6 — Trip-health checks are deterministic app logic; the model explains.**
  (Review Direction F, scenario 6.6.) v1 check set, owner-confirmed:
  1. activity stops dated before trip arrival / after departure (vs first/last
     transit anchors when present, else trip dates);
  2. overlapping timed anchors (two timed commitments that collide on the same day);
  3. hotel-night gaps (trip nights not covered by any hotel booking span);
  4. unresolved stop locations (`location_status = 'unresolved'`);
  5. booking-linked stops whose displayed `time` drifts from their booking's
     datetime.
  Checks are pure functions over the trip detail — no LLM in detection, no new
  state. Exposed ONLY as the `check_trip_health` tool (invoked in conversation);
  no proactive badge or UI surface in this plan (Stage 3 may add entry points).
  Each finding carries ids/dates so the model can explain and, where fixable via
  the four operations, propose a repair through the normal proposal path.
- **G7 — Zero new persistent chrome.** Frontend changes are confined to the
  existing panel: a transient tool-activity line while the loop runs (DM Mono,
  product voice — e.g. "Searching your Discovery picks…"), and the G5 provenance
  badge in `MutationPreview`. Gold stays accent-only; design spec §8 applies;
  verify at 375px.
- **G8 — Context stays bounded.** Search results are compact (id, name, category,
  one-line description, whyGo, duration, openingHours, provenance, fitLine) and
  capped at 8 items per call (model can refine and re-query within the G2 budget).
  Health-check results return findings only (no per-stop dumps). Keep logging
  per-turn token usage (fact 2) so Stage 3 has real numbers.

---

## Wave 1 — Agentic tool loop + catalogue search tool (backend)

**Status: NOT STARTED.**

1. Restructure `streamCopilotResponse` into a streaming agent loop (fact 1):
   accumulate assistant content blocks per iteration; on `stop_reason ===
   'tool_use'` for a query tool, execute it, append `tool_result`, continue; text
   deltas from every iteration stream to the same SSE channel; terminal behaviors
   (`propose_itinerary_changes` handling, `persistTurn`, usage logging) unchanged.
   Emit a new SSE event `{ type: 'tool', tool, state: 'started'|'done' }` around
   each query-tool execution. Enforce the G2 loop cap. The route passes tool
   executors in (claude.js stays DB-free, same pattern as `persistTurn`).
2. Implement `search_discovery_catalogue` (schema in `copilotTools.js`, executor
   in a new `services/copilotGrounding.js`): input `{ destination, query?,
   category? }`. Resolve `destination` against the trip's scopes
   (`buildTripScopes(days, listTripScopes(tripId))` + `canonicalGeoKey`/
   `scopesMatch` — fact 7, including the country-fallback idiom); out-of-scope →
   `{ catalogueState: 'out_of_scope' }` (G4). In-scope → look up the catalogue
   destination row, `listActivePlaces`, rank with `rankPlaces` + trip prefs,
   filter by `query`/`category` (name/alias/description match), return top 8 in
   the G8 compact shape plus `catalogueState: 'fresh' | 'stale' | 'empty' |
   'generating' | 'generation_capped'`. (This wave returns stored data only;
   the background-generation kick is Wave 2 — until then `stale`/`empty` states
   simply say the catalogue is thin.)
3. System-prompt additions: G1 grounding mandate (search before recommending;
   cite catalogue records; never invent places for in-scope destinations), G4
   decline behavior, honest relay of `catalogueState` ("I've started refreshing
   suggestions — ask me again in a minute"). Keep all Plan 11 D6/D7 rules intact.
4. Tests: loop mechanics (multi-iteration turn, cap enforcement, tool SSE events,
   terminal tool still ends the turn), scope resolution (in-scope match incl.
   country fallback, out-of-scope decline), ranking/filter/compact-shape, and a
   claude.test.js protocol update. Live smoke against the real API (per Plan 11
   Wave 1 convention): a "find dinner in <in-scope city>" turn that searches then
   answers from results; an out-of-scope request that declines without a search.

Acceptance: recommendations for in-scope destinations name only catalogue places;
out-of-scope requests decline politely with the add-destination suggestion; a
turn with no grounding need makes zero tool calls; prose streaming latency
unchanged within noise.

## Wave 2 — Background generation + grounded adds (backend)

**Status: NOT STARTED.**

1. Extract the generation pipeline (fact 5) from `routes/discovery.js` into
   `services/discoveryGeneration.js`: one function owning exclusions →
   `discoverDestination` → `insertPlaces` → `enforceCategoryCap` →
   `enqueueForVerification` → timestamps/counters, parameterized by an optional
   per-category callback so the Discovery route keeps its exact SSE streaming
   behavior (true cache-miss live deltas, merge semantics, error fallbacks —
   behavior-identical, existing discovery tests must stay green unmodified in
   intent).
2. Wire the G3 policy into the search executor: on `empty`/`stale` for an
   in-scope destination, check the daily cap; if capped →
   `generation_capped`; else fire the extracted generation service
   fire-and-forget (own error logging, never awaited by the turn) and return
   `generating`. Guard against duplicate concurrent kicks for the same
   destination (in-process in-flight set is sufficient — single-process server).
3. G5 grounded adds: extend `add_stop` with optional `placeId`
   (`copilotTools.js` schema + `copilotProposals.js` validation: active place,
   in-scope destination catalogue, else proposal invalid with reason). At apply,
   resolve stop data from the catalogue row — verified rows contribute
   coordinates + photo descriptor server-side; unverified rows fall back to the
   normal resolver path. **First trace the existing Discovery→trip "add to trip"
   flow** (frontend add of a discovery item → stops route) and reuse its
   semantics/fields rather than inventing a second mapping.
4. Tests: generation-service extraction parity (route behavior unchanged),
   cap-respecting background kick + single-flight guard, `placeId` validation
   matrix (unknown/archived/out-of-scope place), verified-row apply carrying
   coordinates/photo descriptor, unverified fallback. Live smoke on a temp DB
   (per `trippy-local-photo-verification` conventions): empty-catalogue search →
   `generating` → catalogue populated ~1 min later → re-ask returns grounded
   results; grounded add applies with verified coordinates.

Acceptance: an empty-catalogue in-scope search answers immediately and the
catalogue fills in the background within the daily cap; a capped destination
reports it honestly and fires nothing; a grounded `add_stop` lands with the
catalogue row's verified identity without any client/model-supplied coordinates.

## Wave 3 — Deterministic trip-health checks (backend)

**Status: NOT STARTED.**

1. First trace fact 10's open item: how materialized booking stops get their
   `time` (in `services/bookings.js`) — the drift check compares that mapping.
2. New `services/tripHealth.js`: `runTripHealthChecks(tripDetail)` → array of
   findings `{ check, severity: 'warning'|'info', message, dayId?, stopId?,
   bookingId?, date? }` implementing the five G6 checks as pure functions. Encode
   honest boundaries: no timed-anchor overlap guessing without both times; no
   duration inference; findings say what was checked, not speculation.
3. Expose as `check_trip_health` query tool (no input, or optional `dayId`
   filter) through the Wave 1 loop; system-prompt guidance: run it when the user
   asks for an audit/gaps/contradictions; explain findings in product voice;
   offer repairs only via the normal proposal path; booking-related findings
   redirect to Logistics (D6 stays law).
4. Tests: fixture trips exercising each check (positive + clean-negative),
   boundary cases (no bookings at all, single-day trip, all-untimed days →
   zero false positives), tool round-trip through the loop.

Acceptance: "audit my trip for gaps" on a seeded fixture surfaces exactly the
planted issues and nothing else; a healthy trip yields a clean bill; repairs
arrive as ordinary proposals; booking findings point to Logistics.

## Wave 4 — Panel surfacing (frontend)

**Status: NOT STARTED.**

Within the existing panel only (G7):

1. Handle the `tool` SSE event in `useCopilot.js`; render a transient activity
   line in the thread while a query tool runs (DM Mono label idiom; product
   voice per tool: searching picks / checking the trip), removed on `done`.
2. `MutationPreview`: G5 provenance badge on grounded `add_stop` operations —
   "VERIFIED PLACE" (DM Mono badge idiom) only when the proposal payload marks
   the place verified; no badge otherwise. Server includes the flag in the
   proposal operations payload (small Wave 2 hook if not already emitted).
3. Verify at 375px; frontend `npm run build` clean.

Acceptance (real browser, dev servers per `trippy-copilot-local-qa`): a grounded
recommendation turn shows the activity line then cites real catalogue places; a
grounded add's preview shows the verified badge; nothing new renders outside the
panel.

## Wave 5 — QA, verification, deploy

**Status: NOT STARTED.**

1. Full backend suite + frontend build green; discovery route regression suite
   confirms Wave 2 extraction changed nothing observable.
2. Agent local browser pass over the Wave 1-4 acceptance flows on the dedicated
   QA trip ("Shanghai - Hangzhou" per `trippy-copilot-local-qa`), including one
   real empty-catalogue → background-generation → re-ask cycle against a temp
   catalogue destination.
3. Owner click-script for the production pass (standing preference — agent does
   not drive mutating prod browser sessions): grounded recommendation, grounded
   add + verified badge, out-of-scope decline, empty-catalogue ask-again flow,
   trip audit on a real trip.
4. `/deploy` per the deploy skill; post-deploy: health check, one grounded
   search turn on the prod test trip, confirm no generation fired for a fresh
   catalogue, confirm daily-cap counters untouched by read-only searches.
5. Update this plan's status lines; wrap-up commit.

---

## Open items deliberately NOT in this plan

- Bottom sheet, contextual entry points, context-aware seed prompts — Stage 3
  (design brief deferred by owner until after Plan 11; no code dependency, can
  start any time).
- Route/distance matrix or geography-comparison tools (review Direction C
  candidates) — future, needs its own cost/provider decision.
- Proactive surfacing of health findings (badges, notifications) — Stage 3+ at
  the earliest; Direction G prerequisites apply.
- Unsplash production-tier application — separate open follow-up
  (Plan 10 close-out).
- Booking-linked stop protection on the regular stops routes — separate product
  decision (carried from Plan 11).
