# Co-pilot Foundation and Integration Review

**Status:** OPEN — review input for further orchestrator investigation and product discussion.

**Review date:** 2026-07-11

**Scope:** Product and architecture review only. This document records the current co-pilot,
its practical capabilities and limitations, candidate improvement directions, and decisions
that should be investigated before an implementation plan is written. No source code,
migration, or UI implementation is part of this review.

**Related context:**

- [Trippy Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)
- [Trust, Reliability, and Operational Risk Review](2026-07-06-trust-reliability-and-operational-risk.md)
- [Q3 — Discovery Personalization and Shared Cache](2026-07-06-q3-discovery-personalization-and-shared-cache.md)
- [Destination Scope and Hotel Geography Review](2026-07-08-destination-scope-and-hotel-geography-review.md)

## Executive assessment

The co-pilot has a useful technical seed but is not yet an integrated product capability.
Today it is a trip-aware chat interface that receives Trippy's complete structured trip detail, streams conversational answers, and can propose four stop operations for user approval. That is materially better than a generic travel chatbot.

The current experience still feels optional and detached because the user must discover the
floating button, invent a useful question, and trust answers that are not connected to Trippy's verified Discovery catalogue, map relationships, current screen context, or live conditions. Its editing protocol also relies on model-written fenced JSON rather than a strong action contract, and multi-operation application can partially succeed.

The strongest direction to investigate is not simply "better chat." It is whether the co-pilot should become a safe reasoning and action layer over the trip data Trippy already owns: bookings, flexible day plans, place identity, geography, Discovery recommendations, preferences, and map order.

One product principle must survive that investigation:

> Trippy's day itinerary is deliberately flexible. Most activities are ordered intentions, not calendar appointments. The co-pilot must protect genuinely timed commitments without inventing a strict schedule for untimed activities.

The recommendations in this report are review inputs, not settled architecture or an approved implementation sequence. The next investigation should validate them, reject weak assumptions, and surface better alternatives where available.

## 1. Product contract: flexible days, selective time anchors

Most activities added from Discovery have no specific start time. Manually created activities may have a time, while logistics bookings normally carry real dates and times. Optional duration or `bestTime` metadata is guidance, not a promise that the traveller will follow an hourly schedule.

The co-pilot therefore needs to distinguish at least these meanings:

| Itinerary information | Example | Appropriate interpretation |
|---|---|---|
| Booking-linked timed commitment | Flight at 14:20; reserved dinner at 19:00 | Hard anchor to protect and plan around |
| Explicitly timed manual stop | Museum entered at 10:00 | Intentional time, unless the user asks to change it |
| Untimed ordered stop | Temple → market → café | Flexible sequence; do not fabricate a time |
| Duration or best-time hint | `1–2 hours`; `early morning` | Soft planning evidence, not a fixed slot |

This changes what "helpful" means.

For a question such as "How does our evening look?", a grounded answer may be:

> Dinner is fixed at 7pm. The market and riverside walk appear before it, but neither has a set time, so I cannot determine an exact evening schedule. They are geographically compatible; if you want a lighter day, the walk is the easiest optional stop.

It should not create a 4:00–5:30 market visit and a 5:45–6:30 walk unless the user asked for a timed schedule and enough evidence exists to build one.

For an untimed day, useful reasoning can still consider:

- Stop order and geographic spread.
- Backtracking and clustering.
- Number and rough effort of activities relative to the trip's pace.
- The first/last stop relative to the active hotel.
- Fixed bookings that reduce the day's flexibility.
- Which stops are easiest to move, replace, or treat as optional.
- Indoor/outdoor or thematic balance when the underlying place data supports it.

The answer should be framed as density, coherence, or flexibility—not false timetable precision.

## 2. Current implementation, end to end

### 2.1 Entry point and interface

`frontend/src/pages/TripPage.jsx` mounts `useCopilot(tripId)` for every private trip page. A
floating button opens `CopilotPanel` as a full-screen mobile panel.

The panel provides:

- Per-trip message history.
- Streaming assistant text and a Stop control.
- A single text input.
- A proposed-changes card with Apply and Reject.
- Conversation clearing.

The empty state says only "Ask me anything about your trip...". It does not offer trip-specific jobs, and the co-pilot is not told which tab, day, stop, booking, or map area the user was viewing when it was opened. Because the panel covers the full screen, the plan being discussed is no longer visible beside the conversation.

Relevant files:

- `frontend/src/pages/TripPage.jsx`
- `frontend/src/hooks/useCopilot.js`
- `frontend/src/services/copilotApi.js`
- `frontend/src/components/copilot/CopilotFab.jsx`
- `frontend/src/components/copilot/CopilotPanel.jsx`
- `frontend/src/components/copilot/CopilotMessage.jsx`
- `frontend/src/components/copilot/MutationPreview.jsx`

### 2.2 Context supplied to the model

`backend/src/routes/copilot.js` calls `getTripDetail(tripId, userId)` for each message. The model therefore receives:

- Trip title, dates, destinations/scopes, traveller type, interest tags, pace, and status.
- Every day, including seeded and resolved geography.
- Every stop, including optional time, booking link, location metadata, duration, cost, notes, image metadata, and ordering.
- Every booking, including timing, origin/destination, confirmation reference, details, and resolved document metadata.
- The most recent 20 conversation messages.

The context is a full JSON serialization embedded in the system prompt. It is refreshed for
each user message, so the model sees trip edits made outside the chat on the next turn.

The request does not explicitly include:

- Active tab, selected day, selected stop, or selected booking.
- A current-day/current-time marker as a first-class co-pilot input.
- Current user location.
- Weather, traffic, transit, live flight status, or live disruption data.
- Route duration or distance between itinerary stops.
- Results from the normalized Discovery catalogue.
- An explicit distinction between fixed, preferred, flexible, or optional activities.

### 2.3 Conversation persistence

`copilot_messages` stores role, content, trip, user for user messages, and creation time.
Assistant messages use a null `user_id`.

The server sends the newest 20 messages to the model, but the history endpoint orders ascending and then applies `LIMIT 50`, which returns the oldest 50 messages rather than the most recent 50 once a conversation grows past that boundary.

History is shared at trip level. The UI does not display which collaborator wrote a user
message. Any authenticated trip collaborator can clear the trip's entire conversation.

### 2.4 Model response and proposed actions

`backend/src/services/claude.js` streams from `claude-sonnet-4-6`. The system prompt instructs the model to respond conversationally and, when changing the itinerary, append a fenced JSON block.

The supported operation shapes are:

- `add_stop`
- `remove_stop`
- `move_stop`
- `update_stop`

The service extracts the final fenced JSON block using a regular expression and emits it as an SSE mutation event. The browser keeps only one pending mutation and shows it after streaming finishes.

This is a text convention, not a typed tool/action protocol. Malformed JSON produces no usable proposal, and there is no complete server-side schema validation of action names and fields before execution.

The current prompt example shows `time: "HH:MM"` for an added stop even though stop time is
nullable. That creates pressure for the model to fabricate times and conflicts with the flexible itinerary contract.

### 2.5 Applying changes

`backend/src/routes/copilot.js` validates that referenced days/stops are accessible to the user, then applies:

- Remove and move operations synchronously inside a SQLite transaction.
- Add and update operations concurrently, outside that transaction.

Consequences:

1. A multi-operation proposal can partially apply.
2. Validation checks whether the user can access a referenced day/stop, but does not assert that every referenced record belongs to the trip named in the request. A user with access to two trips could submit cross-trip identifiers.
3. Unknown action names are not explicitly rejected by the validation loop and are excluded by the known-action execution filters.
4. There is no idempotency key or trip revision check to protect against duplicate application or a proposal becoming stale after another edit.

New co-pilot stops are handled more carefully than the action protocol itself. `createStop()` receives a default location query, model coordinates are tagged as co-pilot-generated, and the place resolver verifies or discards them rather than blindly trusting generated coordinates. The normal stop photo pipeline also runs.

### 2.6 After application

The page refreshes after a successful apply, but:

- The conversation does not record that the proposal was applied or rejected.
- There is no persisted action/audit record.
- There is no undo.
- An older assistant proposal cannot be reopened and applied from history.
- Refreshing the page loses the pending proposal even though its JSON remains inside the stored assistant text.
- The preview does not show field-level before/after values, route impact, detected conflicts, place provenance, or whether a booking-linked stop will be affected.

## 3. What the co-pilot can reliably do today

### 3.1 Trip-aware questions

It can answer questions grounded in the serialized trip, for example:

- Which hotel is active on a given date?
- What is the flight confirmation reference?
- Which stops are planned on Thursday?
- Which day contains a named activity?
- What traveller profile and interests are stored for the trip?

Accuracy still depends on the model correctly reading a potentially large JSON context. There is no deterministic query layer separating factual lookup from model reasoning.

### 3.2 Basic stop changes

With user confirmation it can add, remove, move, or update itinerary stops. It cannot directly:

- Create, edit, or delete bookings.
- Change trip dates, destinations, travellers, interests, or pace.
- Change a day's city override or other day metadata.
- Select a Discovery catalogue record as the source of a recommendation.
- Calculate or apply an actual route optimization.
- Create notifications or react to live external events.

### 3.3 Conversational continuity

The last 20 stored messages allow follow-up questions. This is chat continuity, not durable
planning state: proposals, decisions, reasons, and outcomes are not stored as structured events.

## 4. Data and capabilities Trippy already owns but the co-pilot does not harness

### 4.1 Grounded Discovery catalogue

The normalized `discovery_destinations` and `discovery_places` catalogue already contains place names, categories, descriptions, rough duration/opening-hour text, canonical provider identity, verified coordinates when available, provenance, ratings where captured, and generation state. Discovery ranking already consumes trip interest tags, pace, and traveller type.

The co-pilot currently sees none of those candidate records. A request such as "find dinner near our hotel" therefore invites the model to answer from general training knowledge even though Trippy owns a more grounded candidate set.

### 4.2 Place identity and map order

Stops contain resolved names, addresses, coordinates, coordinate systems, provenance/status,
and day order. The Map tab already draws the ordered relationship between stops. This is enough to support coarse geographic reasoning and future distance/route tools, but no route matrix or travel-time result is supplied to the co-pilot today.

### 4.3 Derived day geography and hotels

The trip service already derives day geography from explicit override, active hotel, transit
arrival, prior-day continuity, and seeded day geography. The co-pilot sees the resulting fields, which gives it useful context for day-level place reasoning.

It should not independently reinterpret raw provider locality strings as destination identity; the destination-scope model remains the authority.

### 4.4 Timed-anchor logic in Today

`frontend/src/utils/todayModel.js` already treats timed bookings/stops as anchors and leaves
untimed activities outside the clock-driven hero/upcoming model. This existing product logic is important evidence for the flexible-itinerary contract and may be reusable conceptually.

### 4.5 Booking and importer data

Bookings provide real constraints: arrivals, departures, hotel stays, transport legs, and
confirmation details. This gives Trippy a stronger basis for trip-specific help than a generic destination assistant.

The co-pilot currently receives all booking records but has no deterministic booking-conflict or trip-health analysis. It also receives more booking/document context than many questions need, which raises context-size and data-minimization questions.

## 5. Why the feature feels "just there"

### Finding C1 — no discoverable job

The floating button exposes a capability, not a user job. The empty state provides no examples grounded in the active trip or screen. Users must know what the co-pilot can do and translate their need into a prompt.

### Finding C2 — detached from the working surface

The panel replaces the timeline/map/logistics view and receives no selected-object context. The user cannot naturally say "fit this into Saturday" from a Discovery suggestion or "find an alternative to this" from a stop card.

### Finding C3 — itinerary-aware but not application-grounded

The model sees the itinerary snapshot but not the systems that make Trippy trustworthy:
verified Discovery places, place resolution, map relationships, or deterministic booking/day
logic exposed as bounded capabilities.

### Finding C4 — language implies broader capability than the action layer supports

"Ask me anything" suggests current destination knowledge, disruption handling, live nearby
search, and broad trip management. Actual writes are limited to four stop operations, and
external/current-world questions are not grounded.

### Finding C5 — flexible itinerary semantics are implicit

The data has nullable time and ordered stops, but the co-pilot prompt does not define the
difference between a booking anchor, an intentional manual time, an untimed activity, and a
soft duration/best-time hint. The add-stop example encourages unnecessary time assignment.

### Finding C6 — mutation trust is below the bar for expansion

Fenced JSON extraction, incomplete validation, cross-trip identity gaps, non-atomic application, no stale-plan protection, and no undo make broader mutation authority unsafe.

### Finding C7 — proposals are opaque

The preview names operations but does not explain exact field changes or consequences. Users
cannot selectively apply changes or see which claims are verified versus estimated.

### Finding C8 — conversation and action state are conflated

Assistant prose stores embedded mutation JSON, while pending/apply/reject state exists only in the browser. Chat history is not a reliable action history or collaborative planning record.

### Finding C9 — context is broad rather than task-shaped

Every request sends the full trip JSON, including fields irrelevant to many questions. This is simple but can increase tokens, expose unnecessary booking metadata to the model, and make factual retrieval less predictable as trips grow.

## 6. Practical scenarios to ground further investigation

These are not a committed feature list. They illustrate where integration could create real
value and what evidence each scenario would require.

### 6.1 Explain the trip as it exists

**User:** "What fixed commitments do we have tomorrow?"

The co-pilot identifies bookings and explicitly timed stops, then distinguishes the rest as a flexible ordered plan. This is close to current capability but should use deterministic facts and clearer timing semantics.

### 6.2 Improve a flexible day

**User:** "Make Thursday less scattered without assigning times."

The co-pilot uses stop coordinates, hotel geography, order, and fixed anchors. It proposes an improved sequence or moves one stop to another day, while leaving flexible stops untimed.

### 6.3 Add a grounded Discovery candidate

**User:** "Which food suggestion best complements Saturday?"

The co-pilot searches Trippy's catalogue, considers trip preferences, existing stops, location, and day density, explains the trade-off, and proposes adding the selected catalogue place with its verified identity/provenance.

### 6.4 Plan around an anchor

**User:** "Arrange the flexible stops around our 7pm dinner."

The co-pilot protects dinner, groups the other stops into a sensible before/after order, and
does not fabricate hourly slots. If route-time evidence is absent, it states that limitation.

### 6.5 Reduce day density

**User:** "We're travelling at a relaxed pace. Which stop should be optional?"

The co-pilot considers count, rough duration, geography, interests, and uniqueness. This would be stronger if Trippy eventually has an explicit optional/must-do signal, but it can already offer a recommendation without pretending to prove timetable feasibility.

### 6.6 Check trip logistics

**User:** "Audit the trip for obvious gaps or contradictions."

Candidate deterministic checks include activities before arrival, conflicting timed anchors,
hotel-night gaps, unresolved locations, and booking-linked stops whose displayed time differs from the booking. The model explains issues and possible remedies rather than being solely responsible for detecting them.

### 6.7 Recover from a user-reported change

**User:** "Our flight is three hours late. What does that affect?"

Even without live flight integration, the co-pilot could reason from a user-supplied disruption, identify affected anchors/flexible stops, and propose the smallest reversible repair. Live status automation is a later, separate capability with cost and dependency implications.

### 6.8 On-trip "what now?"

**User:** "We finished early. What flexible stop is nearby?"

This becomes strong only when current time/location, grounded place candidates, opening status, and travel time are available. Until then, the assistant must state what it does not know.

## 7. Recommendation directions to investigate

### Direction A — establish a trustworthy action foundation

Before broadening mutation authority, investigate a typed and validated action contract with:

- Explicit supported actions and field schemas.
- Trip-scoped record validation.
- Whole-proposal validation before mutation.
- Atomic or otherwise explicitly recoverable application semantics.
- Idempotency/stale-trip protection.
- A persisted applied/rejected action record.
- A credible undo or restore contract.
- Clear protection for booking-linked anchors.

The investigation should decide whether actions should be model tool calls, validated proposal objects, commands produced by a separate planner layer, or another design. This review does not preselect that architecture.

### Direction B — make timing semantics explicit

At minimum, co-pilot behavior should derive:

- Booking-linked timed commitment.
- Explicitly timed manual stop.
- Untimed flexible stop.
- Soft duration/best-time guidance.

It should preserve `time: null` by default and ask for timing only when timing is essential to the user's request.

Further investigation should determine whether this can remain derived or whether users need a small explicit flexibility vocabulary such as fixed, preferred, flexible, or optional. Adding new state is not automatically justified; its UX and source of truth need validation.

### Direction C — expose bounded Trippy data capabilities

Investigate whether the co-pilot should query small, task-shaped data sets instead of receiving only one full JSON dump. Candidate capabilities include:

- Retrieve a day and its anchors/flexible stops.
- Search/rank existing Discovery places for a trip/day.
- Retrieve a booking or booking constraints.
- Compare stop geography or calculate a route/distance matrix.
- Run deterministic trip-health checks.
- Retrieve current conditions only through explicit, sourced integrations.

The goal is grounded reasoning with clear provenance and controlled cost—not unrestricted web browsing or another copy of Discovery generation.

### Direction D — integrate assistance into existing surfaces

Investigate contextual entry points rather than relying exclusively on the global FAB:

- Day header: review or improve this day.
- Map: reduce backtracking or compare locations.
- Stop: find an alternative, move it, or plan around it.
- Discovery suggestion: fit this into the trip.
- Booking/logistics: explain what this affects.
- Trip overview: audit the trip.

The context passed from each entry point should be visible to the user and model. The right
mobile presentation—full screen, sheet, inline result, or another pattern—remains open.

### Direction E — improve proposal comprehension

Potential preview information includes:

- Before/after values.
- Fixed versus flexible status.
- "No time assigned" for untimed additions.
- Place verification/provenance.
- Booking impact.
- Route/density trade-offs where evidence exists.
- Selective application where operations are independent.
- Applied state and undo.

The preview should not display unsupported precision merely to look complete.

### Direction F — separate deterministic detection from model explanation

Obvious conflicts and integrity checks should be computed in ordinary application logic where possible. The model can prioritize, explain trade-offs, and propose repairs. This avoids paying a model to rediscover simple rules and improves repeatability.

### Direction G — defer live/proactive behavior until prerequisites exist

Weather adaptation, current-location help, live flight disruption, traffic-aware departure
advice, and proactive notifications could be valuable. They also introduce permissions, cost, data freshness, external dependency, privacy, and notification-quality risks.

They should not be implied by the current interface or used to justify premature architecture until the grounded data/action foundation is reliable.

## 8. Approaches to avoid or challenge

- Treating the problem as a prompt-copy/personality upgrade.
- Making every stop require a start time or fixed duration.
- Auto-scheduling untimed Discovery activities into fabricated hourly slots.
- Giving the model unrestricted mutation access before validation, atomicity, and undo are  resolved.
- Sending increasingly large trip/catalogue payloads on every turn without a context contract.
- Re-generating place recommendations when the grounded Discovery catalogue already has useful candidates.
- Adding broad web browsing as a substitute for trustworthy place identity and provenance.
- Auto-applying changes without explicit user approval.
- Building proactive notifications before Trippy can reliably identify what is fixed, flexible, current, and actionable.
- Copying competitor chat surfaces without examining their underlying place, routing, booking, and live-data foundations.

## 9. External product patterns worth pressure-testing

These examples are directional evidence, not instructions to copy their feature sets.

- Wanderlog connects AI suggestions directly to the trip plan rather than leaving them as chat text: <https://wanderlog.com/trip-plan-assistant>
- Wanderlog's route optimization is a bounded itinerary operation with a visible revert path: <https://help.wanderlog.com/hc/en-us/articles/13545624787867-Optimize-route>
- TripIt's Nearby Places begins from a concrete itinerary object such as a hotel or activity: <https://help.tripit.com/en/support/solutions/articles/103000063343-nearby-places>
- TripIt's Go Now demonstrates the usefulness—and data/permission burden—of current-location, traffic, and flight-status grounding: <https://help.tripit.com/en/support/solutions/articles/103000063349-go-now>
- Google Ask Maps combines conversational requests with current place data, maps, and actions: <https://blog.google/products-and-platforms/products/maps/ask-maps-immersive-navigation/>
- Mindtrip explicitly positions structured maps, photos, reviews, itinerary, and bookings as the difference between an actionable travel product and plain-text chat: <https://mindtrip.ai/about>

The common pattern is not "add AI chat." It is to combine conversation with structured state, grounded real-world information, and a clear path from recommendation to action.

## 10. Investigation questions and decision gates

The next orchestrator review should answer or sharpen these questions before implementation
planning.

### Product role

1. Which recurring user jobs should define the co-pilot's first useful scope?
2. Should it primarily explain, improve, audit, recover, discover, or combine a deliberately limited subset of those roles?
3. Which jobs belong in contextual UI without requiring chat?

### Flexible itinerary semantics

4. Can fixed/flexible meaning be derived safely from current booking/time fields?
5. Does Trippy need explicit preferred/optional/must-do state, and who controls it?
6. What claims may the co-pilot make when duration, opening hours, or travel time are unknown?

### Data and grounding

7. What is the smallest useful context contract for common tasks?
8. How should the co-pilot consume Discovery without duplicating generation, leaking global catalogue concerns into trip state, or overstating unverified candidates?
9. Which geographic/route calculations are needed for useful ordering versus precise scheduling?
10. Which booking/document fields should be withheld unless a question requires them?

### Actions and trust

11. What action protocol provides strict validation without overengineering the first scope?
12. What are the required atomicity, idempotency, stale-state, audit, and undo semantics?
13. Can proposals be partially selected safely, or must each proposal remain one coherent unit?
14. How are booking-linked stops protected and reconciled with their source booking?

### Experience and collaboration

15. Where should contextual assistance appear, and what source context should remain visible?
16. Is co-pilot history personal, shared, or a mixture of private conversation and shared applied decisions?
17. How should users distinguish verified facts, estimates, and model recommendations?

### Cost, privacy, and operations

18. What data is sent to the model for each job, how is it minimized, and how is that disclosed?
19. Which operations require external calls, and which should remain deterministic or cached?
20. What telemetry can demonstrate actual utility without collecting excessive conversation content?

## 11. Evidence and verification completed for this review

Code paths inspected:

- `backend/src/routes/copilot.js`
- `backend/src/services/claude.js`
- `backend/src/services/trips.js`
- `backend/src/services/stops.js`
- `backend/src/routes/discovery.js`
- `backend/src/db/migrations/005_ai.sql`
- `backend/src/db/migrations/016_discovery_catalogue.js`
- `frontend/src/pages/TripPage.jsx`
- `frontend/src/pages/TodayTab.jsx`
- `frontend/src/utils/todayModel.js`
- `frontend/src/hooks/useCopilot.js`
- `frontend/src/services/copilotApi.js`
- `frontend/src/components/copilot/*`

Focused verification run on 2026-07-11:

```text
cd backend
npm test -- copilot.test.js claude.test.js

2 test files passed
37 tests passed
```

The passing suite verifies core history persistence, message streaming, mutation extraction,
basic add/remove application, coordinate-source tagging, and streaming error behavior. It does not establish product usefulness or cover the full trust contract described above. In
particular, it does not currently prove atomic mixed-operation application, cross-trip record rejection, unknown-action rejection, stale proposal handling, undo, or flexible-time behavior.

## 12. Expected outcome of the next review

The next investigation should produce an independent recommendation grounded in current code, product intent, and practical scenarios. It should identify what is already sound, what needs strengthening before expansion, which proposed directions should be rejected or reframed, and which product/architecture decisions require owner input.

It should stop at a decision-ready review. A concrete implementation plan should be written only after the owner and orchestrator have discussed and accepted that recommendation.
