# Co-pilot Context, Memory, and Model Architecture — Independent Investigation

**Status:** COMPLETE (2026-07-15). Investigation and recommendation only. No source, configuration,
data, or deployment changes were made. This report answers the brief in
[2026-07-13-copilot-context-memory-and-model-architecture-review.md](2026-07-13-copilot-context-memory-and-model-architecture-review.md)
§9 and is the input to a future implementation plan; it does not authorize one.

**Reconciled with live code:** `main` at `235b568` (post Plan 14 closure).

**Method:** direct code reconciliation of `backend/src/routes/copilot.js`,
`backend/src/services/claude.js`, `backend/src/services/copilotTools.js`, migrations, and the
Plan 11–13 documents; read-only measurement of a scratchpad copy of the dev database via a
throwaway script (deleted after use); independent fresh-context verification of this report's
factual claims by a Sonnet reviewer.

---

## 1. Reconciliation: the prior review vs. the repository

The 2026-07-13 review's architecture description is **accurate** against current `main`. Verified
point by point:

| Claim in prior review | Verified state at `235b568` |
|---|---|
| Plans 11–13 complete and deployed | Confirmed — all three plan docs carry CLOSED status headers with production commits (`7d6c904`, `d72eb2d`, `a1d6270`/`a09a368`) |
| 20-message window, chronological reorder | Confirmed — `copilot.js:178-185` |
| Plan 13 context validated, persisted in `context_json`, injected as `[Viewing: …]` lines in user turns only | Confirmed — `copilot.js:27-98,187-193`; migration `029` present |
| `copilotTripContext()` minimized (drops coords/photos/docs, keeps confirmationRef + bookingLinked) | Confirmed — `copilotTools.js:162-199` |
| Co-pilot `max_tokens: 4096` per loop iteration, Sonnet 4.6 literal | Confirmed — `claude.js:504-505` |
| Model ids not centrally managed | Confirmed — extraction and photo models are exported constants; co-pilot (`claude.js:504`) and discovery (`claude.js:245`) are inline literals |
| Console-only telemetry; no cache tokens, stop reasons, or durable storage | Confirmed — `claude.js:629-631` logs aggregate input/output tokens, contextChars, proposal flag, iterations, queryCalls, ttfd; nothing persisted; `cache_read_input_tokens` / `cache_creation_input_tokens` never read |
| Migration 030 is the next free sequence | Confirmed — latest is `029_copilot_message_context.sql` |

**Corrections to record elsewhere (stale documents, not the review):**

- The project `CLAUDE.md` still says "Plan 13 currently has Waves 1–2 implemented … remain future
  work." That is stale: Plan 13 is CLOSED in production, and Plan 14 (Discovery register redesign)
  has since shipped as well. `CLAUDE.md` should be refreshed in a normal docs pass.
- The prior review said the last-reconciled head was `cd35e74`; five Plan 14 commits have landed
  since. None touch the co-pilot surface — spot-checked `git log` and the copilot files' history.

**One architecture fact the prior review under-stated:** the cached system block is a *single*
`cache_control: ephemeral` block containing both the static instructions and the full
pretty-printed trip JSON (`claude.js:419-459,506`). Consequences:

- Any itinerary change — including applying a co-pilot proposal — changes the block and forces a
  full cache re-write on the next turn.
- Conversation growth does **not** invalidate it (messages, including `[Viewing:]` lines, are
  outside the block). Plan 13 placed volatile context correctly.
- The ephemeral TTL is 5 minutes; a reflective user who replies slowly pays cache-write price
  every turn. Nobody can currently see this because cache token fields are not logged.

## 2. Measured evidence

Read-only measurements against a copy of the dev database (5 trips; production DB was not
accessible this session — see §7). Token figures are chars/3.6 estimates, not tokenizer counts.

| Trip | Days | Stops | Bookings | Trip-JSON chars | ≈ tokens |
|---|---|---|---|---|---|
| Chengdu – Chongqing | 10 | 32 | 7 | 16,325 | ~4,500 |
| Ipoh – Kuala Lumpur | 4 | 18 | 4 | 9,530 | ~2,600 |
| Shanghai – Hangzhou (QA trip) | 7 | 5 | 3 | 3,753 | ~1,000 |
| Taipei – Kaohsiung | 7 | 1 | 3 | 2,870 | ~800 |
| Bali | 4 | 1 | 3 | 2,337 | ~650 |

Static overhead per turn: instruction prose ≈ 3.6k chars (~1k tokens) plus three tool schemas
(~1.2–1.5k tokens). Worst measured total input per turn ≈ **7–8k tokens**, the overwhelming
majority cache-readable between turns of an active conversation.

Conversation reality: the busiest trip has **14 total messages**; no real conversation has ever
exceeded the 20-message window. User messages average 54 chars; assistant messages average 783
chars (max 2,277 ≈ ~650 output tokens), far below the 4,096 ceiling in observed use.

## 3. Demonstrated today vs. hypothetical scaling concerns

**Demonstrated (code-level, present now):**

1. **Silent truncation.** `streamCopilotResponse` never inspects `stop_reason` (no reference
   anywhere in `backend/src`). If a turn hits `max_tokens` mid-prose, the reply just trails off;
   if it hits mid-`tool_use`, the operations are absent/unusable, so the code persists the prose
   and silently creates **no proposal** — no user-facing signal, no log line. No occurrence has
   been observed (assistant outputs measured so far are ~6× under the ceiling), but the failure
   mode is invisible by construction, which is exactly why it can't be ruled out.
2. **Telemetry blindness.** Cache read/write tokens, stop reasons, and per-turn cost are not
   captured anywhere durable. Every open question in the prior review's §8 (real truncation rate,
   real cost per job, cache hit behavior, Sonnet 5 comparison baseline) is unanswerable until this
   exists. Console lines inside the Docker container are effectively ephemeral.
3. **UX/memory mismatch.** History endpoint returns 50 messages (`copilot.js:114`); the model sees
   20. Once a conversation passes 20, the panel will display exchanges the co-pilot no longer
   remembers, with no visual cue. Not yet triggered by any real conversation, but the mismatch is
   shipped behavior, not a projection.
4. **Model-id hygiene.** Co-pilot and discovery model ids are inline literals; a future model
   change requires hunting call sites. Trivial, but it blocks clean canarying.

**Hypothetical at current scale (the prior review's C1/C2):**

- **C1 (lost decisions past the window):** real conversations top out at 14 messages. The failure
  is real *in principle* (constraints like "keep Friday free" silently age out) but has never
  happened to a real trip. Building durable memory now would be speculative engineering.
- **C2 (full-trip payload):** the worst real trip costs ~4.5k tokens of trip JSON — roughly $0.01
  of cache-read input per turn at Sonnet 4.6 list price. Full-trip injection buys guaranteed
  correctness for cross-day questions and audit requests at negligible measured cost. There is no
  demonstrated relevance or cost problem to solve.

## 4. Trade-off assessment of the candidate directions

**Direction A — ceiling + telemetry: justified now, with one reframe.** Raising `max_tokens` to
8,192 is cheap headroom (unused output is unbilled), but the ceiling is not the fix — *observability
of truncation is*. Handle `stop_reason === 'max_tokens'` explicitly: log it, and surface an honest
notice on the thread ("this reply was cut short") instead of a silently missing proposal. For
telemetry, a small SQLite table (per-turn row: model, input/output/cache-write/cache-read tokens,
ttfd, total latency, iterations, query calls, stop reason, proposal op count, error flag) fits the
stack better than structured log files: the app is SQLite-first, the container's stdout is not
durable, and no external analytics platform is warranted for a private app. Retention can be a
simple periodic prune. This is deliberately operational, not an analytics subsystem.

**Direction B — durable conversation memory: defer.** No real conversation has aged anything out.
It also carries the hardest correctness problems on the table (authorship/attribution in shared
trips, stale-memory invalidation against DB truth, clear-history semantics, prompt-injection via
remembered text). Building it before telemetry demonstrates window overruns would be complexity
without evidence. Gate: revisit when telemetry shows real conversations exceeding the window with
constraint-bearing early messages, or the owner reports a concrete forgotten-decision incident.

**Direction C — tiered trip serialization: reject for now.** Measured payloads are small, the
minimized serializer already exists and is correct, and any narrowing scheme must solve request
classification ("opened from Day 3 but asked a whole-trip question") without a model call or a
correctness hole. The conservative fallback would be full trip anyway — i.e., the current
behavior. Revisit only if telemetry shows trips whose serialized context materially moves cost or
latency (roughly: sustained >20k-token trip JSON, e.g. month-long dense itineraries).

**Direction D — retrieval tools: reject.** The full minimized trip is already in context, so a
day/booking retrieval tool adds an iteration and latency to fetch what the model already has. Only
coherent as a companion to Direction C, which is itself rejected at current scale.

**Sonnet 4.6 vs Sonnet 5: no change; define the gate.** Nothing in this investigation shifts the
prior review's conclusion. The tokenizer (~30% more tokens), default adaptive thinking sharing the
`max_tokens` budget, and the absence of workload evals all argue against a casual swap. The right
sequencing is: telemetry first (to get a Sonnet 4.6 baseline), then a co-pilot-only canary
compared on the §7 scenario set at post-introductory pricing. Booking extraction stays on 4.6
absent an accuracy complaint. Centralizing the model ids is the only Sonnet-5-adjacent work worth
doing now.

**Cross-cutting checks performed:** Plan 13 context validation (tab whitelist, trip-membership
checks, Discovery-name length/control-character sanitization) is sound as an injection boundary;
the flexible-itinerary timing rules live in the system prompt and the proposal schema
(`time: null` unless explicitly requested) and none of the recommended work touches them;
clear-history (owner-only DELETE) currently deletes all state that could influence future turns —
Direction B would break that invariant, one more reason to defer it.

## 5. Smallest coherent architecture worth planning

One small plan (working title: **co-pilot observability and output safety**), fully on the
Plan 11–13 foundation, independently deployable waves:

1. **Truncation safety.** Read `stop_reason` per iteration; on `max_tokens`, log it, emit an SSE
   notice the panel renders honestly, and never silently drop a proposal. Raise the co-pilot
   ceiling to 8,192 in the same change.
2. **Durable per-turn telemetry.** Migration 030: one `copilot_turn_metrics` table (columns as in
   §4.A, trip-id keyed, no message text). Written once per turn in the route's completion path;
   write failure must never break the user turn.
3. **Model-id centralization.** `COPILOT_MODEL` / `DISCOVERY_MODEL` exported constants beside
   `EXTRACTION_MODEL`. No behavior change.
4. **Window honesty (owner decision required).** Either a subtle divider in the history view where
   the model's 20-message window begins, or alignment of the display limit — decide before
   implementation; both are small.

Everything else (memory, tiering, retrieval, Sonnet 5) sits behind explicit evaluation gates fed
by item 2.

## 6. Rejected or deferred alternatives

| Alternative | Verdict | Why |
|---|---|---|
| Durable conversation memory (B) | **Deferred** behind a telemetry gate | No demonstrated window overrun; hardest invalidation/attribution/injection problems; breaks current clear-history invariant |
| Tiered trip serialization (C) | **Rejected at current scale** | Worst real payload ~4.5k tokens; classification risk exceeds measured benefit; conservative fallback ≡ status quo |
| Read-only retrieval tools (D) | **Rejected** | Duplicates data already in context; adds iterations and latency; only meaningful after C |
| Global Sonnet 5 upgrade | **Rejected** | No workload evals; tokenizer and thinking-budget changes are regressions risks; canary only after baseline telemetry |
| Raising the 20-message window as a "memory" fix | **Rejected** | Recency, not memory; cost scales with prose; postpones the same failure |
| External telemetry/analytics platform | **Rejected** | Operational overkill for a private single-server app; SQLite suffices |
| Splitting instructions and trip JSON into separate cache blocks | **Deferred** | Plausible cache-write saving when the trip changes mid-conversation, but unmeasurable until cache tokens are logged; evaluate with telemetry data |

## 7. Evidence gaps and limitations

- **No production measurements.** SSH log reads were blocked by this session's permission policy,
  so real production token usage, latency, and cache behavior remain unmeasured — reinforcing,
  not undermining, the telemetry-first recommendation. A future session with production-read
  approval could grep `[copilot] turn usage` lines for an interim signal.
- Token figures are character-based estimates, not tokenizer counts (±20% plausible).
- Dev-database conversations are owner QA traffic; production conversations may be longer. This
  affects the *urgency* of Direction B, not the conclusion that it is currently unevidenced.
- No live model calls were made; truncation behavior at 4,096 was assessed from code paths, not
  reproduced.

## 8. Owner decisions, gates, and implementation-plan prerequisites

**Owner decisions required before the plan is written:**

1. Approve the §5 scope (truncation safety + 8,192, SQLite telemetry, model-id constants).
2. Window honesty: divider at the memory boundary, aligned display limit, or explicitly do nothing.
3. Telemetry retention policy (suggest: prune rows older than ~90 days; no message text stored).
4. Whether a proposal-size cap is wanted now. Evidence shows no oversized proposals; recommendation
   is **no cap**, revisit with telemetry's proposal-op-count column.

**Evaluation gates for the deferred directions:**

- *Direction B:* real conversations exceeding 20 messages with early constraint-bearing turns, or
  an owner-reported forgotten-constraint incident.
- *Direction C/D:* telemetry showing sustained trip-context cost or latency that a user can feel
  (guideline: >20k-token trip JSON or turn input costs an order of magnitude above today's).
- *Sonnet 5 canary:* a Sonnet 4.6 telemetry baseline over the prior review's §7 scenarios, then a
  side-by-side on the same scenarios at standard (post-2026-09-01) pricing, judged on grounding
  compliance, timing-rule compliance, proposal validity rate, latency, and cost per completed job.

**Implementation-plan prerequisites:** migration 030 is free (re-verify at plan time); Plan 13's
context contract and migration 029 untouched; Plan 11 proposal boundary and Plan 12 grounding
rules unchanged; flexible-itinerary timing rules preserved verbatim; `CLAUDE.md` Plan 13 status
line corrected in the same docs pass.
