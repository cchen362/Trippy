# Implementation Plan 15 — Co-pilot Observability and Output Safety (Truncation Handling, Durable Telemetry, Window Alignment)

**Status: NOT STARTED.** All owner decisions are resolved (2026-07-15); waves may begin in order.

**Origin:** The
[Co-pilot Context, Memory, and Model Architecture Investigation](../reviews/2026-07-15-copilot-context-investigation.md)
(2026-07-15), which reconciled the
[2026-07-13 architecture review](../reviews/2026-07-13-copilot-context-memory-and-model-architecture-review.md)
against `main` at `235b568`, plus the owner decision session of 2026-07-15. All product
decisions below are owner-approved; implementation sessions must not re-open them.

**Goal:** make the co-pilot's failure modes visible and its memory contract honest — at the
current capability scope, with no new capabilities. Four deliverables: (1) `max_tokens`
truncation is detected, logged, and surfaced honestly to the traveller instead of silently
dropping prose or a proposal, with the per-iteration ceiling raised to 8,192; (2) durable
per-turn telemetry in SQLite (migration 030) so token use, cache behavior, latency, stop
reasons, and proposal sizes become measurable facts; (3) model ids centralized as exported
constants; (4) the model's conversation window expanded from 20 to 50 messages, exactly
matching the history endpoint's display limit, so the panel never shows an exchange the
model has forgotten.

**Explicitly NOT in this plan** (investigation §6 — rejected or gated, do not sneak in):
durable conversation memory (Direction B), tiered trip serialization (Direction C),
read-only retrieval tools (Direction D), any Sonnet 5 migration or canary, a proposal-size
cap, splitting the cached system block, any external analytics platform, any UI redesign,
and any new co-pilot capabilities or tools. Plans 11–13 contracts remain untouched:
proposal boundary (11), grounding rules and query-tool budget (12), context contract and
migration 029 (13). Flexible-itinerary timing rules are preserved verbatim.

---

## 0. Verified facts this plan is built on (traced 2026-07-15, `main` at `ecec062`)

Confirmed by the investigation and an independent fresh-context reviewer; implementation
sessions must not re-derive them.

1. **No `stop_reason` handling exists.** `streamCopilotResponse`
   (`backend/src/services/claude.js`) never reads `finalMessage.stop_reason` — zero
   references in `backend/src`. A `max_tokens` cut mid-prose trails off silently; a cut
   mid-`tool_use` yields no usable `operations`, so the turn persists the prose and creates
   no proposal, indistinguishable from an intentional non-proposing reply.
2. **Co-pilot model and ceiling are inline.** `claude.js:504-505`: literal
   `'claude-sonnet-4-6'`, `max_tokens: 4096`. Discovery generation is also a literal
   (`claude.js:245`); extraction and photo-descriptor models are already exported constants
   (`claude.js:14,16`).
3. **Telemetry is console-only.** One log line per turn (`claude.js:629-631`) with
   aggregate input/output tokens, contextChars, proposal flag, iterations, queryCalls, plus
   a ttfd line. Nothing durable; `cache_read_input_tokens` / `cache_creation_input_tokens`
   are never read. Container stdout is effectively ephemeral.
4. **The cached block is one ephemeral system entry** containing static instructions plus
   the pretty-printed trip JSON (`claude.js:419-459,506`). Conversation messages, including
   `[Viewing: …]` context lines, live outside it — window changes do not touch the cache.
5. **Window vs display mismatch.** Model window: newest 20 messages
   (`backend/src/routes/copilot.js:178-185`). History endpoint: newest 50
   (`copilot.js:114`). The frontend `useCopilot` ignores unknown SSE event types (Plan 12
   fact 11), so a new event type is backward-safe to ship backend-first.
6. **Migration 030 is the next free sequence.** Latest is
   `029_copilot_message_context.sql`. Migrations are additive-only.
7. **Measured baselines (dev DB, 2026-07-15):** largest real trip serializes to ~16.3k
   chars (~4.5k tokens); busiest conversation is 14 messages; assistant replies average
   ~220 tokens (max ~650), user messages ~15 tokens. A 50-message window costs roughly
   6–7k input tokens per turn worst case — negligible for this app.
8. **`persistTurn` and the turn-completion path live in the route**
   (`copilot.js:199-231`); `claude.js` stays DB-free by design. Telemetry persistence must
   follow the same pattern: `claude.js` reports, the route writes.

## 1. Owner decisions (approved 2026-07-15 — encode, don't re-open)

- **D1 — Scope approved:** truncation safety + 8,192 ceiling, SQLite telemetry, model-id
  constants, window 20 → 50.
- **D2 — Telemetry retention:** 90 days; prune opportunistically on write (no cron, no
  external scheduler). No message text is ever stored in telemetry.
- **D3 — No proposal-size cap.** Revisit only with telemetry evidence
  (`proposal_ops` column exists for exactly this).
- **D4 — Window honesty resolved by alignment:** model window = history display limit = 50.
  No divider, no display change. The contract: what the panel shows is what the model
  remembers.
- **D5 — Truncation is surfaced honestly, not hidden.** A cut reply shows an inline notice;
  the model is never silently re-run and the partial text is never discarded.

---

## Wave 1 — Output safety: stop_reason handling, 8,192 ceiling, model-id constants

**Status: COMPLETE (2026-07-15).** `COPILOT_MODEL`/`DISCOVERY_MODEL` exported constants added beside `EXTRACTION_MODEL`/`PHOTO_DESCRIPTOR_MODEL` in `claude.js`, replacing the two inline literals; co-pilot `max_tokens` raised 4096 → 8192; `finalMessage.stop_reason` is now read each iteration and a `max_tokens` result breaks the loop before the terminal-tool check (so a partially-parsed `propose_itinerary_changes` block never becomes a proposal — D5), emits SSE `{ type: 'notice', notice: 'truncated' }`, and still runs `persistTurn` so the partial prose is saved; console telemetry line gained a `stopReason=` field. Frontend (`useCopilot.js` + `CopilotPanel.jsx`) renders the notice inline under the affected assistant message in the established muted DM Mono style, no new chrome. Verified: backend 609/609 and frontend 141/141 tests green (3 new backend cases — truncated-prose, truncated-tool_use, end_turn regression guard — plus 2 new frontend hook tests and 2 new panel tests); production build clean; live local browser exercise on the "Shanghai - Hangzhou (W3 verify)" trip confirmed a normal turn unaffected, then a real `max_tokens: 12` truncation (temporarily forced, reverted immediately, never committed) produced the exact notice at both desktop and 375px mobile widths.

**Model recommendation: Sonnet medium solo.**

Backend-heavy with one small frontend rendering task; no design ambiguity.

1. **Model-id constants** (`backend/src/services/claude.js`): add exported
   `COPILOT_MODEL = 'claude-sonnet-4-6'` and `DISCOVERY_MODEL = 'claude-haiku-4-5-20251001'`
   beside `EXTRACTION_MODEL`; replace the two inline literals. No behavior change.
2. **Ceiling:** raise the co-pilot stream's `max_tokens` from 4096 to 8192 (co-pilot call
   only — extraction, discovery, and photo-descriptor budgets are untouched).
3. **stop_reason detection:** after each `stream.finalMessage()`, read
   `finalMessage.stop_reason`. On `'max_tokens'`:
   - record it (fed to Wave 2's telemetry via the turn summary; until Wave 2 lands, the
     existing console line gains a `stopReason=` field),
   - emit a new SSE event `{ type: 'notice', notice: 'truncated' }`,
   - end the turn (do not open another iteration on a truncated response), and
   - **never create a proposal from a truncated response**, even if a `tool_use` block
     parsed: a cut operations list may be an incomplete plan. `persistTurn` still runs so
     the partial prose is saved.
   Non-truncated iterations behave exactly as today (`end_turn` / `tool_use` flow
   unchanged).
4. **Frontend notice rendering** (`frontend/src/hooks/useCopilot.js` +
   `frontend/src/components/copilot/CopilotPanel.jsx`): handle `type: 'notice'`; render an
   inline line under the affected assistant message in the established muted DM Mono
   style: `Reply cut short — ask me to continue.` No new chrome, no gold, no motion.
5. **Tests:** backend unit tests for the truncated-prose and truncated-tool_use paths
   (mock stream with `stop_reason: 'max_tokens'`), asserting the notice event, the absent
   proposal, and the persisted partial text; frontend test for notice rendering; assert
   unknown-event tolerance is preserved.

**Verification:** full backend + frontend suites green; local dev exercise of a normal
turn, a proposal turn, and a simulated truncation (temporarily forced low ceiling in a
throwaway local run, not committed) at 375px and desktop.

## Wave 2 — Durable per-turn telemetry (migration 030 + write path + retention)

**Status: COMPLETE (2026-07-15).** Migration `030_copilot_turn_metrics.sql` (additive, re-verified as the next free sequence) adds `copilot_turn_metrics` with an index on `(trip_id, created_at DESC)` and one on `created_at` for the retention prune. `claude.js`'s `totalUsage` now also sums `cache_creation_input_tokens`/`cache_read_input_tokens`; `ttfdMs` is captured at the first text delta; `streamCopilotResponse` gained an optional 7th param `reportTurnMetrics`, called (try/catch-wrapped, non-throwing, same pattern as `persistTurn`) on both the success path (`error: 0`, real `proposalOps`) and the stream-error catch path (`error: 1`), and deliberately skipped on the two aborted-connection early returns (same as `persistTurn`). The route (`copilot.js`) owns the write: one INSERT plus an opportunistic `DELETE … WHERE created_at < datetime('now','-90 days')` per turn (D2 — no cron), passed as the 7th arg to `streamCopilotResponse`. Verified: backend 618/618 tests green (9 new: 7 in `claude.test.js` covering cross-iteration cache-token summation, proposalOps counting, truncated stop_reason, the error path with the turn still completing, `reportTurnMetrics` rejection not breaking the turn, and abort-path exclusion; 2 in `copilot.test.js` covering the write path and the 90-day retention prune; `migrations.test.js` migration-count bump 29→30 plus a new table/columns assertion); migration 030 proven by copying the real dev DB to a scratch path and running `runMigrations()` against the copy (only 030 applied, table + both indexes present via `PRAGMA table_info`, scratch copy deleted after — 001–029 untouched). Live local verification: signed into the dev app (owner-driven login, per safety rules the agent never types credentials) on the "Shanghai - Hangzhou (W3 verify)" trip, sent a real co-pilot turn ("what city is day 1 in?") through the actual co-pilot panel, and confirmed a new `copilot_turn_metrics` row landed with sane real values (`model=claude-sonnet-4-6`, `input_tokens=2101`, `output_tokens=13`, `cache_write_tokens=4189`, `cache_read_tokens=0`, `stop_reason=end_turn`, `proposal_ops=0`, `error=0`) — consistent by construction with the console log line since both read the same `totalUsage`/`iterations`/`executedQueryCalls`/`lastStopReason` variables computed once per turn.

**Model recommendation: Sonnet medium solo.**

1. **Migration `030_copilot_turn_metrics.sql`** (additive, next free sequence — re-verify at
   implementation time): table `copilot_turn_metrics` with `id`, `trip_id` (FK, ON DELETE
   CASCADE), `created_at`, `model`, `input_tokens`, `output_tokens`,
   `cache_write_tokens`, `cache_read_tokens`, `ttfd_ms`, `total_ms`, `iterations`,
   `query_calls`, `stop_reason`, `proposal_ops` (integer, 0 = no proposal), `error`
   (integer flag). No message text, no user id, no prompt content.
2. **Usage accumulation** (`claude.js`): extend the existing `totalUsage` accumulation to
   also sum `cache_creation_input_tokens` and `cache_read_input_tokens` across iterations;
   capture ttfd, total turn duration, final stop_reason, and error outcome in a turn
   summary object.
3. **Write path in the route** (fact 8): `streamCopilotResponse` reports the turn summary
   through a route-owned callback (same pattern as `persistTurn`); the route inserts the
   metrics row after the turn completes. The write is wrapped so a telemetry failure logs
   loudly but never breaks the user's turn — deliberate graceful-in-production isolation,
   not error suppression: the turn's user-facing work is already complete when the write
   runs.
4. **Retention (D2):** on each insert, delete rows older than 90 days for that table
   (single indexed `DELETE … WHERE created_at < datetime('now','-90 days')`). Cheap at this
   scale; no scheduler.
5. **Tests:** migration applies on a disposable copy DB; a completed turn writes one
   accurate row (including cache token fields and `stop_reason`); telemetry write failure
   does not fail the turn; retention prune removes only >90-day rows.

**Verification:** suites green; migration proven on a disposable copy of the dev DB
(existing rule: never modify migrations 001–029); a real local co-pilot turn produces a
row whose token fields match the console line.

## Wave 3 — Conversation window 20 → 50 (D4)

**Status: NOT STARTED.**

**Model recommendation: Sonnet low solo.**

Deliberately tiny and separately deployable so any cost/latency surprise is attributable.

1. Change the model-context query `LIMIT 20` to `LIMIT 50`
   (`backend/src/routes/copilot.js:178-185`). The history endpoint's `LIMIT 50` is already
   correct and must not change — the two limits are now a single contract; add a shared
   constant so they cannot drift apart silently.
2. Tests: a >50-message conversation feeds exactly the newest 50 to the model in
   chronological order, with stored `[Viewing: …]` context lines still injected only on
   user turns.

**Verification:** suites green; local dev turn on the "Shanghai - Hangzhou (W3 verify)" QA
trip confirms unchanged behavior on a short thread. After deployment, Wave 2's telemetry
is the watch instrument: input-token growth per turn should remain within the §0 fact 7
envelope.

## Wave 4 — QA, deploy, production verification

**Status: NOT STARTED.**

**Model recommendation: Opus medium solo (no coding subagents).**

1. Full regression at 375px and desktop against the Plan 12/13 baselines: grounded
   recommendation, verified-badge add, out-of-scope decline, trip audit, contextual entry
   points, seed prompts, proposal apply/reject, clear history (owner-only).
2. Confirm no cache regression: with telemetry live, verify consecutive turns in one
   conversation show `cache_read_tokens > 0` and that an itinerary edit mid-conversation
   shows the expected one-turn cache re-write (investigation §1 consequence — first time
   this becomes observable).
3. Deploy via `/deploy`; post-deploy health checks; owner click-script for production
   verification (per standing practice, the owner runs the production browser pass): one
   normal turn, one proposal turn, history restore, and a glance that no truncation notice
   appears on ordinary replies.
4. Sample the production `copilot_turn_metrics` table (read via node in-container — the
   host cannot write the root-owned prod DB, and reads should follow the same path) to
   confirm rows land with sane values.
5. Update this plan's status lines and the investigation report's status; commit.

**Verification:** production turn metrics visible and sane; owner click-script passed;
plan doc updated.

---

## Open items deliberately NOT in this plan

Gated behind telemetry evidence (investigation §8):

- **Direction B (durable conversation memory):** revisit only if real conversations exceed
  the 50-message window with constraint-bearing early turns, or a concrete
  forgotten-constraint incident occurs.
- **Directions C/D (tiered serialization, retrieval tools):** revisit only if telemetry
  shows sustained trip-context cost or latency a user can feel (~>20k-token trip JSON).
- **Sonnet 5 canary:** requires a Sonnet 4.6 telemetry baseline over the 2026-07-13
  review's §7 scenarios, then a side-by-side at standard post-2026-09-01 pricing, judged on
  grounding compliance, timing-rule compliance, proposal validity, latency, and cost per
  completed job.
- **Cached-block split (instructions vs trip JSON):** evaluate with Wave 2's cache-token
  data; only worthwhile if mid-conversation trip edits are shown to be frequent.
