# Co-pilot Context, Memory, and Model Architecture Review

**Status:** OPEN — investigation brief for the app orchestrator and independent QA/review
before an implementation plan is written.

**Review date:** 2026-07-13

**Scope:** Review and investigation only. This document records the current LLM architecture,
the Sonnet 4.6 versus Sonnet 5 decision context, and the co-pilot context limitations exposed by
that review. It does not approve an implementation, prescribe a final architecture, or authorize
source-code, configuration, migration, or deployment changes.

**Primary context:**

- [Co-pilot Foundation and Integration Review](2026-07-11-copilot-foundation-and-integration-review.md)
- [Implementation Plan 11 — Co-pilot Trust Foundation](../plans/Implementation%20Plan%2011%20Copilot%20Trust%20Foundation.md)
- [Implementation Plan 12 — Co-pilot Grounding](../plans/Implementation%20Plan%2012%20Copilot%20Grounding.md)
- [Implementation Plan 13 — Co-pilot Integration](../plans/Implementation%20Plan%2013%20Copilot%20Integration.md)
- [Trippy design specification](../specs/2026-04-23-trippy-design.md)

## Executive assessment

Trippy does not currently have a general reason to replace Claude Sonnet 4.6 with Sonnet 5.
The two Sonnet workloads are booking extraction and the co-pilot. The current requirements are
bounded, Sonnet 4.6 is already capable, and Trippy has not established workload-specific
evaluation data that would justify a global model upgrade. Destination catalogue generation and
photo descriptors already use Haiku 4.5 and are not part of that replacement decision.

The model review did expose a more important architecture question: the co-pilot gives the model
the whole minimized trip on every turn, but only the latest 20 messages. Its 4,096-token
`max_tokens` value limits one generated response; it does not limit the input context. Raising
that ceiling may be sensible protection for requests that fill several empty days, but it does
not address long planning conversations, lost decisions, irrelevant full-trip payload, or
ambiguous references such as "this day" and "this stop."

This is not a case for rewriting Plans 11–13. The revised architecture should build on them:

- Plan 11 owns the validated, persisted, atomic proposal boundary.
- Plan 12 owns the agentic query-tool loop and grounding mechanisms.
- Plan 13 owns contextual entry points, visible turn context, and the bottom-sheet integration.
- A later plan may add durable conversation memory, token-aware context assembly, selective trip
  serialization, and—only if evidence supports it—additional read-only retrieval tools.

That direction is a review hypothesis, not a settled solution. The orchestrator and QA reviewer
should independently verify the facts, challenge whether each additional layer is necessary,
and recommend the smallest architecture that remains correct for long and collaborative trips.

One product principle remains non-negotiable throughout the investigation:

> Trippy itineraries are flexible by default. Untimed activities are ordered intentions, not
> calendar appointments. Context or memory improvements must not cause the co-pilot to invent
> schedules or treat every stop as a timed event.

## 1. Current LLM workload map

The design specification is no longer the complete source of truth for model allocation. The
current implementation is concentrated in `backend/src/services/claude.js`.

| Workload | Current model | Call shape | Architectural role |
|---|---|---|---|
| Booking extraction | `claude-sonnet-4-6` | One non-streaming multimodal call, `max_tokens: 8192` | Extract structured bookings from text, images, and PDFs |
| Co-pilot | `claude-sonnet-4-6` | Streaming agent loop, `max_tokens: 4096` per model iteration | Explain the trip, call query tools, and propose itinerary operations |
| Destination catalogue | `claude-haiku-4-5-20251001` | Streaming NDJSON, `max_tokens: 64000` | Generate the cached shared discovery catalogue |
| Photo descriptor | `claude-haiku-4-5-20251001` | One small non-streaming call, `max_tokens: 256` | Produce a stock-photo query and scene type |

Relevant implementation:

- `backend/src/services/claude.js`
- `backend/src/services/importer.js`
- `backend/src/services/discoveryGeneration.js`
- `backend/src/services/stops.js`
- `backend/src/routes/copilot.js`

The model identifiers are not centrally managed: booking extraction uses an exported constant,
while the co-pilot and destination generation contain model literals. Current usage telemetry is
primarily console logging rather than durable, queryable data.

## 2. Sonnet 4.6 versus Sonnet 5

### 2.1 Verified vendor facts as of the review date

Anthropic describes Sonnet 5 as a drop-in capability upgrade whose largest gains are in agentic
reasoning, tool use, coding, and long-running work. The API model ID is `claude-sonnet-5`.

Its introductory price through 2026-08-31 is $2 per million input tokens and $10 per million
output tokens. Standard pricing from 2026-09-01 is $3/$15, matching Sonnet 4.6's per-token list
price. Sonnet 5 uses a new tokenizer that produces approximately 30% more tokens for the same
text, depending on workload. Equivalent requests can therefore cost more after the introductory
period even though list prices match.

Sonnet 5 also changes behavior relevant to Trippy:

- Adaptive thinking is on by default; Sonnet 4.6 requests without a `thinking` field run without
  thinking.
- Thinking and visible response text share the `max_tokens` allowance.
- A 4,096-token limit tuned for Sonnet 4.6 may truncate a Sonnet 5 response.
- Sonnet 5 does not accept non-default sampling parameters or manual thinking budgets. Trippy
  currently sets neither, so these API changes are not immediate blockers.
- Priority Tier is not available for Sonnet 5 at launch.

Primary sources:

- [What's new in Claude Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)
- [Migrating to Claude Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Effort controls](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Anthropic Sonnet 5 announcement](https://www.anthropic.com/news/claude-sonnet-5)

These are vendor claims and general benchmarks, not evidence of improved Trippy outcomes.

### 2.2 Current working conclusion to challenge

A global upgrade is not justified merely because Sonnet 5 is newer.

- The co-pilot is the strongest candidate for a future Sonnet 5 canary because it uses multiple
  tools and must follow nuanced itinerary constraints.
- Booking extraction is a bounded structured-extraction workload. Agentic benchmark gains do not
  establish better booking-field accuracy.
- Haiku workloads should remain outside the Sonnet decision unless a separate evaluation exposes
  a quality problem.
- Any comparison should use post-introductory pricing and the new tokenizer, not only the launch
  discount.

Before changing either Sonnet workload, Trippy needs workload-specific evaluations and durable
measurements for accuracy, tool behavior, latency, token use, truncation, and cost. The reviewer
should also consider whether staying on Sonnet 4.6 creates a material lifecycle or availability
risk that is not visible in the current repository.

## 3. What the 4,096-token ceiling does—and does not do

The co-pilot's `max_tokens: 4096` applies to each model response in the Plan 12 loop. It is not
the size of the input context and does not reserve or bill 4,096 tokens in advance.

A request such as "fill these two empty days" can produce explanatory prose plus a terminal
`propose_itinerary_changes` tool call containing many operations. Four thousand tokens may be
enough in ordinary cases, but it leaves limited safety margin for larger multi-day proposals,
additional tool iterations, or a future thinking-enabled model. An 8,192 ceiling is a reasonable
candidate to evaluate because unused capacity is not billed.

The investigation must not treat a higher ceiling as the main scaling solution:

- Very large proposal cards may be technically valid but unusable on mobile.
- A proposal with dozens of operations increases review burden and stale-plan risk.
- A better product boundary may be to propose one or two days at a time or impose an explicit
  maximum operation count.
- Output limits do not solve input relevance or forgotten conversation history.

QA should establish realistic upper-bound scenarios rather than infer safety from token capacity
alone.

## 4. Current co-pilot context assembly

For each user turn, `backend/src/routes/copilot.js`:

1. Loads the authoritative current trip through `getTripDetail()`.
2. Stores the user's message.
3. Selects the newest 20 stored messages and reorders them chronologically.
4. Converts the trip through `copilotTripContext()`.
5. Starts the streaming Sonnet 4.6 tool loop.

`copilotTripContext()` is already intentionally minimized. It retains trip identity and
preferences, every day and stop, booking linkage, confirmation references, and core booking
timings. It drops coordinates, photos, document metadata, raw booking details, and location-
resolution noise. This is a sound foundation and should not be discarded casually.

The remaining limitations are structural:

### C1 — Fixed message count is not durable planning memory

Only the latest 20 messages—roughly ten user/assistant exchanges—reach the model. Older messages
remain in the database but silently leave the model context. This can erase decisions and
constraints such as:

- "Keep Friday evening free."
- "Do not add Osaka."
- "One traveller cannot walk far."
- "We prefer late starts."
- A previously rejected proposal and the reason it was rejected.

This is recency, not memory. Simply increasing the message count delays the same failure and
makes cost depend on prose length.

### C2 — Full-trip injection is simple but not task-shaped

Every co-pilot request receives every minimized day, stop, and booking. A seven-day trip is
unlikely to threaten Sonnet 4.6's context window, but long trips increase cost and dilute
relevance. A question about this afternoon does not need all details from a three-week trip.

The problem should not be exaggerated: full-trip injection guarantees that broad requests have
the necessary facts and avoids extra tool round trips. Any selective replacement must prove that
it preserves correctness for cross-day comparisons, audits, and broad replanning.

### C3 — Volatile UI context is being addressed by Plan 13

Plan 13 Wave 3 specifies `{ tab, dayId?, stopId? }`, server-side validation, user-turn injection,
message persistence, and a visible context chip. That is the correct layer for "this day" and
"this stop" references and must not be duplicated by a later context system.

At the time of this review, Plan 13 records Wave 2 as complete and Waves 3–5 as not started. The
reviewer must verify actual branch state before relying on those status lines.

### C4 — Conversation, UI context, and trip truth have different authority

A future context architecture must keep these layers distinct:

- The database is authoritative for current days, stops, bookings, and proposal state.
- Plan 13 turn context is a validated statement of what the user is viewing now.
- Recent messages preserve the immediate conversational thread.
- Any durable memory is a compact record of preferences, decisions, rejections, and unresolved
  questions—not a competing copy of the itinerary.

If a memory says a museum is on Tuesday but the database now puts it on Wednesday, Wednesday must
win. A design that cannot explain invalidation and reconciliation is not ready for planning.

## 5. Candidate architecture directions for investigation

These are options to evaluate, not approved requirements.

### Direction A — Safety ceiling and measurable budgets

Evaluate raising the co-pilot ceiling to 8,192 and introducing durable per-turn metrics:

- Model and effort configuration.
- Input, output, cache-write, and cache-read tokens across all loop iterations.
- First-token and total latency.
- Iteration and query-tool counts.
- Stop reason, truncation, refusal, abort, proposal size, and error outcome.
- Cost per completed user job rather than cost per raw request.

The reviewer should determine whether telemetry belongs in structured application logs, SQLite,
an external platform, or some combination. Avoid building an analytics subsystem beyond current
operational needs.

### Direction B — Durable summary plus recent raw turns

Investigate a per-trip conversation memory that captures only durable conversational facts:

- Traveller-specific or group preferences, with attribution where relevant.
- Explicit constraints.
- Accepted decisions not already represented by current trip state.
- Explicit rejections and reasons when they remain relevant.
- Open questions or unresolved planning choices.

Recent raw turns should still accompany the summary. Summarization could occur when messages are
about to age out rather than on every turn. The investigation must address:

- Who authors and updates the summary.
- Model cost and cache implications.
- Failure behavior without blocking the main response.
- Collaboration and author attribution.
- Removal or correction of stale memory.
- Clear-history semantics.
- Prompt-injection and data-authority boundaries.
- Whether deterministic extraction is sufficient for some memory categories.

Do not assume that an LLM-written free-form summary is automatically trustworthy.

### Direction C — Tiered trip serialization

Investigate splitting `copilotTripContext()` into tiers such as:

- A compact trip overview always included.
- Full detail for the active or explicitly referenced day.
- Relevant booking anchors.
- Full-trip context for audits, whole-trip restructuring, or ambiguous requests.

The reviewer should compare this against retaining the current minimized full trip. Classification
must not add an unnecessary model call or silently omit required facts. Conservative fallback to
full context may be preferable when scope is unclear.

### Direction D — Additional read-only retrieval tools

If measured trip size or cost justifies it, Plan 12 can support tools such as day or booking
retrieval. This would extend the existing query-tool loop; it would not replace it.

The investigation must account for:

- Extra model iterations and latency.
- Tool-call reliability when the model initially sees incomplete context.
- Authorization and trip-membership validation.
- Compact bounded results.
- Whether selective injection alone already solves the practical problem.

Do not introduce retrieval tools solely because they are architecturally fashionable.

## 6. Relationship to Plans 11–13

The next implementation plan should treat the deployed and in-progress co-pilot work as the
foundation.

| Existing plan | Ownership that should remain intact | Possible later extension |
|---|---|---|
| Plan 11 | Native proposal schema, server validation, persistence, fingerprinting, atomic apply/reject | Proposal-size policy and QA scenarios only if evidence warrants |
| Plan 12 | Agentic loop, query-tool execution, grounding, health checks, tool budget | Additional read-only retrieval tools if justified |
| Plan 13 | Bottom sheet, contextual entry points, seed prompts, visible/persisted turn context | Use validated context when selecting relevant trip detail |

Coordination constraints:

- Do not independently invent another active-day or active-stop request format while Plan 13 Wave
  3 owns that contract.
- Do not put volatile screen context or conversation memory into the cached stable-trip block
  without measuring cache invalidation.
- Do not modify Plan 13's migration `029_copilot_message_context.sql`; any later schema change
  requires a new migration number after checking current repository state.
- Do not weaken the Plan 11 proposal boundary to make large multi-day generation easier.
- Do not regress the Plan 12 rule that concrete place recommendations are grounded in Trippy's
  catalogue.

## 7. Investigation scenarios and evidence

The orchestrator and QA reviewer should test the architecture against concrete jobs, including:

1. Fill one empty day with a balanced set of flexible activities.
2. Fill two or more empty days in one request without inventing clock times.
3. Produce a large proposal and assess token use, validation, reviewability, and stale-plan risk.
4. Continue a planning conversation after more than 20 messages and verify whether an older
   explicit constraint survives.
5. Change a previously summarized itinerary fact outside chat and verify that database truth wins.
6. Ask a selected-day question through Plan 13 context without naming the day in prose.
7. Ask a whole-trip audit question that genuinely requires all days and bookings.
8. Ask a narrow on-trip question in a long itinerary and measure irrelevant payload.
9. Exercise shared-trip conversation with different authors and conflicting preferences.
10. Clear conversation history and verify that no invisible memory continues influencing answers.
11. Trigger catalogue and trip-health tools in the same long conversation.
12. Compare Sonnet 4.6 against Sonnet 5 only on representative co-pilot and extraction datasets,
    using standard post-promotion pricing.

Where live model calls are used, record prompts, model configuration, token usage, latency, tool
events, stop reasons, and the human evaluation rubric. Do not treat one successful demo as an
evaluation.

## 8. Questions the implementation plan must resolve

1. Is 4,096 currently causing real truncation, or is 8,192 only prudent headroom?
2. What is the maximum useful proposal size on a 375px review surface?
3. Which conversational facts deserve durable memory, and which should remain raw history?
4. How are memory entries attributed, corrected, expired, and cleared?
5. What exact trip summary is sufficient for every turn?
6. When is full-trip context mandatory, and how is that decision made without another LLM call?
7. Does selective serialization reduce real cost or latency enough to justify added complexity?
8. Are retrieval tools necessary after Plan 13 context and tiered serialization are measured?
9. Where should operational LLM telemetry live, and what retention is appropriate?
10. What evaluation threshold would justify Sonnet 5 for either Sonnet workload?
11. What rollback or compatibility posture is needed if model behavior changes?
12. Which changes belong in one plan, and which should remain separately deployable?

## 9. Expected orchestrator and QA output

The next review should produce an evidence-backed recommendation, not code. It should:

- Reconcile this document with the actual post-Plan-12 and current Plan-13 repository state.
- Correct any stale or inaccurate facts.
- Measure representative payload and conversation sizes where possible.
- Distinguish demonstrated problems from future scaling concerns.
- Compare the candidate directions and reject unnecessary complexity.
- Identify data, security, collaboration, caching, and failure-mode implications.
- Recommend the smallest coherent architecture and sequencing for a later implementation plan.
- Define acceptance criteria and an evaluation strategy, including model-comparison gates.
- Surface owner decisions and unresolved questions explicitly.

The reviewer should not implement fixes, create migrations, alter model configuration, or begin
the implementation plan until the investigation report is complete and owner decisions are
resolved.
