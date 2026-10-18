# Implementation Plan 30 — Sonnet 5.5 / Haiku 5.5 Migration

**Status:** 2026-10-19 — **DEPLOY B is LIVE at `a2c47d5` (server pulled `a12f473` → `a2c47d5` at 18:57 UTC; migration 037 applied at container boot; pre-deploy backup `~/Trippy/backups/trippy-pre-plan30B-20261018-125653.db`, integrity ok). All four workloads now run their 5.5 model in production: extraction and the co-pilot on Sonnet 5.5 (co-pilot under D-30-9 with the "Drafting the change…" activity), descriptors and discovery on Haiku 5.5. Deploy B also carries Plan 32 M1+M2, Plan 33 M1+M2 and the flight-number fixes. Owner production pass pending (Deploy B record, §7); then W6 close-out, then Plan 34 W0. Previously: Deploy A was LIVE at `a12f473` (W1, D-30-8 with migration 036, W2, W3, Plan 31 W1); owner production QA passed 2026-10-18. W4 COMPLETE 2026-10-19 (extraction on Sonnet 5.5 `medium`, owner-accepted; not deployed). Rollout revised by owner ruling 2026-10-19: no calendar observation windows (§7). **W5 COMPLETE 2026-10-19** — E-COP-1 failed on Sonnet 5.5 `low` (4/10, control 10/10); the owner ruled D-30-9 (the co-pilot explains *after* the proposal call, as final text), under which both models read 10/10; `COPILOT_MODEL = 'claude-sonnet-5-5'` at effort `low`, 16,000; not deployed. Next: Plan 32 → Deploy B.** Previously: approved 2026-10-18 (defaults of Q-30-1 … Q-30-5 applied; Q-30-5 superseded, see §7). Written at `ad959a5` from the owner's stated intent to move all four Anthropic workloads to their 5.5 counterparts, after an independent verification of the [2026-10-18 upgrade assessment](../reviews/2026-10-18-sonnet-haiku-55-upgrade-assessment.md) against live code, the installed SDK, and official provider documentation (all fetched 2026-10-18). Every setting, threshold, budget and estimate below is **provisional** until the evaluation in W0–W1 produces numbers; the plan says which gate turns each one into a decision. Waves are implemented later via `/implement-milestone`; each wave updates its own status line and commits. The owner questions Q-30-1 … Q-30-5 carry a default each wave follows unless the owner says otherwise — none of them blocks W0.

**Origin.** The owner wants Sonnet 4.6 → Sonnet 5.5 (extraction, co-pilot) and Haiku 4.5 → Haiku 5.5 (discovery, photo descriptors). The companion [opportunity exploration brief](../reviews/2026-10-18-model-55-opportunity-exploration-brief.md) is a separate product-discovery track and is **not** an input to this plan: no new tool, capability, or product behaviour rides on this migration.

**Scope in one sentence:** change which model answers each of the four existing requests in `backend/src/services/claude.js`, set thinking/effort/output allowances that are measured rather than inherited, make each request path honest about the response shapes the new models produce (thinking blocks, refusals, truncation, silence), and ship each workload only after it passes its own paired evaluation — with a per-workload revert that restores the old model *with the old model's compatible parameters*.

**Not in scope.** No new tools, no model call on the hosted MCP path (a closed cost boundary — `docs/DECISIONS.md`), no change to proposal-apply semantics, catalogue lifecycle, resolver order, provider tiers, pin precedence or the geography ladder; no database migration (one owner-approved exception, added after approval: 036 for D-30-8, the W1 follow-up); no rewriting of historical `copilot_turn_metrics.model` values, `import_artifacts` provenance, or completed plan docs to say 5.5; no image downscaling dependency (measure first — F-30-14); no prompt redesign beyond what a measured regression requires; no Opus, Fable, batch, fast-mode, server-side fallback or task-budget features.

---

## 1. Assessment verification — what holds, what to correct, what was missing

The assessment's checkout facts (§2) and pricing table (§4) were re-derived and **hold**: the four constants and request shapes are as described; `@anthropic-ai/sdk` is `^0.91.0` / `0.91.1` installed; no request sends `thinking`, `effort`, `temperature`/`top_p`/`top_k`, `tool_choice`, or an assistant prefill; the hosted MCP makes no Anthropic call; the pricing rows match the official page on 2026-10-18 (the assessment omitted only the 1-hour cache-write column, which Trippy does not use). Its recommendation — one coordinated migration, four independent gates — is adopted.

Corrections and additions, each tied to a fact in §2:

| # | Assessment said | Verified position |
|---|---|---|
| **C-30-1** | SDK 0.91.1 "omits `between_tools`" — "an SDK compatibility investigation" | The *type* gap is irrelevant at runtime (plain JS, the SDK serialises whatever object it is given). The gap that matters is different: 0.91.1's stream accumulator copies `stop_reason` and `usage` from `message_delta` but **not `stop_details`** (added in SDK 0.99.0; F-30-5). On the two streamed paths (co-pilot, discovery) a refusal is detectable (`stop_reason: 'refusal'`) but its category is not. Also 0.134.0 added tolerance of unknown stream event types. An SDK bump is justified, optional, and independently revertable (D-30-2 / Q-30-2). |
| **C-30-2** | "Determine whether keep-alives or progress handling are required" for the co-pilot | **Required.** The co-pilot SSE writes nothing between `flushHeaders()` and the first text delta or tool event (F-30-7); discovery already pings `{type:'thinking'}` every 8 s. Adaptive thinking lengthens exactly that silent interval; Cloudflare's 100 s no-bytes timeout is a recorded production fact. The frontend parser ignores unknown `data:` events and comment lines, so a ping needs no frontend change (F-30-8). |
| **C-30-3** | Not raised | **Pre-tool prose may disappear.** On Sonnet 5.5, notes "longer than a sentence or two" that the model writes before a tool call come back as *progress-update `thinking` blocks* — empty under the default `display: "omitted"` (F-30-9). The co-pilot prompt says "First explain your reasoning in prose, then call the tool." If that explanation becomes a progress-update block, the user sees a proposal card with no explanation, and persisted history loses it too (only `text` blocks are saved). Whether the *first* note of a response is affected is not settled by the docs; it is the single most important thing the co-pilot evaluation must observe (E-COP-1). |
| **C-30-4** | Not raised | **A silent turn is possible.** A thinking-only reply (documented at `xhigh`, possible at lower effort), a refusal, or a `max_tokens` stop during thinking yields a `done` event with no text. `useCopilot` appends nothing in that case (F-30-8) — the panel just stops. Every such outcome needs a visible notice (D-30-4). |
| **C-30-5** | "Restore each old model with its compatible settings" | Made concrete: **`output_config.effort` errors on Haiku 4.5** (F-30-12). A rollback that reverts only the model string while keeping an effort value would 400. Settings must therefore be keyed by *model*, not by workload (D-30-1). |
| **C-30-6** | Sonnet "about 13% cheaper" on ordinary text | Understated risk. Sonnet 4.6 ran these two workloads with **no thinking**; Sonnet 5.5 thinks "briefly before almost every reply" from `medium` up and sometimes at `low`, billed as output at $10/MTok. The local co-pilot baseline averages **173 output tokens per turn** (F-30-15): 500 thinking tokens would triple output cost. The per-token discount is real; the per-task saving is unproven in either direction until measured. |
| **C-30-7** | Discovery: "64K may again cut late categories" | Agreed, and the constraint moved: the 64,000 comment names "Haiku 4.5's streaming output ceiling", which is 64K; Haiku 5.5's is 128K (F-30-11). The allowance is now a *budget choice*, not a ceiling. Candidate 96,000, measured in W3. |
| **C-30-8** | Not raised | **Haiku 4.5's retirement floor has passed.** The deprecations page lists `claude-haiku-4-5-20251001` as "not sooner than October 15, 2026" — three days before this plan (F-30-13). A deprecation notice can arrive any time, with ≥60 days before retirement. The Haiku rollback window is therefore finite; Haiku ships first (D-30-5). Sonnet 4.6's floor is 2027-02-17. |
| **C-30-9** | Image-token increase "one component, not universal" | Quantified for Trippy's real input, phone screenshots (F-30-14): roughly +160% image tokens, net image cost about +75%, under one cent per screenshot. No downscaling work in this migration. |
| **C-30-10** | Non-streaming extraction at 8,192 tokens | The SDK refuses a non-streaming request whose `max_tokens` implies more than 10 minutes at 128K-tokens-per-hour, i.e. **above 21,333** (F-30-6). Extraction can rise to 16,000 without switching to streaming; anything larger needs `.stream()` or an explicit per-request timeout. |
| **C-30-11** | "Rate limits" not mentioned | Sonnet 5.5 and Haiku 5.5 each have their **own rate-limit pool** (official migration guides). This repository cannot see the account tier; the owner checks the Console before Deploy A (Appendix A). |
| **C-30-12** | Preserved-thinking rules summarised | Confirmed non-issue for Trippy's shapes: the co-pilot replays complete assistant `content` (thinking blocks included) within a turn, system and tools are constant within a turn, and cross-turn history is text only (F-30-10). The repo's first commit is 2026-04-24 and the key was in use by July 2026, so the account predates the 2026-08-31 enforcement cut-over; the owner confirms the org creation date in the Console (Appendix A). Do not invent a history rewrite. |

---

## 2. Validated facts — established 2026-10-18 at `ad959a5`, do not re-derive

Code facts are from this checkout; provider facts are from the official pages named, fetched 2026-10-18. Re-check provider facts at each deploy.

**F-30-1 — Four requests, one file.** `backend/src/services/claude.js`: `EXTRACTION_MODEL` (line 17, `claude-sonnet-4-6`, non-streaming, `max_tokens: 8192`, text/image/PDF content, fenced-JSON output parsed from `text` blocks), `COPILOT_MODEL` (line 21, `claude-sonnet-4-6`, `messages.stream`, `max_tokens: 8192` per iteration, three tools, system block with `cache_control: ephemeral`, up to 5 executed query tools per turn), `DISCOVERY_MODEL` (line 23, `claude-haiku-4-5-20251001`, `messages.stream`, `max_tokens: 64000`, NDJSON parsed from `text` events), `PHOTO_DESCRIPTOR_MODEL` (line 19, `claude-haiku-4-5-20251001`, non-streaming, `max_tokens: 256`, fenced JSON). Model strings appear nowhere else in `backend/src` or `frontend/src`. Tests pin them at `backend/tests/claude.test.js:210` and `:1073` (constants) and use `claude-sonnet-4-6` as a *fixture value* in `backend/tests/copilot.test.js:543,567,591,597` and `backend/tests/importer.test.js:158,162` (old-record fixtures — may stay).

**F-30-2 — All four paths already read blocks by `type`.** Extraction and descriptors `.filter(b => b.type === 'text')`; discovery consumes `stream.on('text')` (text deltas only); the co-pilot's `on('text')` streams prose and `finalMessage().content` is replayed whole into `messages` for the next iteration. A leading `thinking` block therefore breaks no parser. What none of them does: branch on `stop_reason` other than the co-pilot's `max_tokens` check; discovery discards `finalMessage()` entirely (usage and stop reason unlogged); descriptors treat every non-parse as `null`.

**F-30-3 — Official breaking changes, applied to these four requests.** From the [Sonnet 5.5 migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide) ("from Sonnet 4.6") and the [Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide): `budget_tokens`, non-default sampling, assistant prefill, forced `tool_choice` (Sonnet 5.5), `thinking: disabled` (Sonnet 5.5), `computer_*` tools, advisor pairings — **none is sent today**. What *does* change silently: (a) omitting `thinking` now runs **adaptive thinking** on both models (4.6 and Haiku 4.5 ran thinking-off); (b) thinking counts toward `max_tokens` and is billed as output; (c) `display` defaults to `"omitted"` (empty `thinking` text); (d) the same text is ~30% more tokens; (e) refusals arrive as HTTP 200 with `stop_reason: "refusal"` (new for code coming from 4.6/4.5; Haiku 5.5 has **no** server-side fallback — never send `fallbacks` to it); (f) `temperature`/`top_p`/`top_k` would 400 if ever added.

**F-30-4 — Effort defaults and lowest-thinking settings.** [Effort page](https://platform.claude.com/docs/en/build-with-claude/effort): Sonnet 5.5 defaults to `high` ("for chat and other latency-sensitive work, start with `medium` or `low`"; "for … extraction … start at `low`" per the skill's summary of the same guidance — treat `low`/`medium` as the candidates, not `high`); its lowest setting is `thinking: {type: "between_tools"}` at effort ≤ `high`, no other field inside `thinking`, Sonnet 5.5 only (any other model 400s on it). Haiku 5.5 defaults to `medium`; `thinking: {type: "disabled"}` is accepted at ≤ `high`; "to get less thinking, lower the effort level — telling the model to answer directly didn't stop it from thinking." Changing the top-level effort between requests invalidates the prompt cache, so effort is fixed per workload.

**F-30-5 — Installed SDK 0.91.1: what it does and does not do.** `lib/MessageStream.js` accumulates `thinking_delta`/`signature_delta`, and on `message_delta` copies `stop_reason`, `stop_sequence` and `usage` (incl. cache fields) into the snapshot `finalMessage()` returns — **`stop_details` is never copied** (zero occurrences in the file; the changelog adds it at 0.99.0 and "applies all `message_delta` fields" at 0.117.0). Unknown delta types hit a no-op `checkNever`. `StopReason` already includes `'refusal'` and the non-streaming `Message` type carries `stop_details`. Latest published: **0.135.0** (2026-10-15), which also adds the `claude-sonnet-5-5`/`claude-haiku-5-5` constants, the `between_tools` type (0.129.0), unknown-event tolerance (0.134.0), and no Node-version change (Dockerfile is `node:20-alpine`; dev is Node 22). No entry between 0.91.1 and 0.135.0 is labelled breaking; 0.122.0 reshapes the beta Files/Skills namespaces, which Trippy does not use.

**F-30-6 — Non-streaming ceiling.** `client.calculateNonstreamingTimeout` throws `Streaming is required…` when `max_tokens × 3600 s / 128000 > 600 s`, i.e. `max_tokens > 21,333`, unless the model is in `MODEL_NONSTREAMING_TOKENS` (neither target is). Extraction and descriptors are non-streaming; 16,000 and 1,024 are inside the limit.

**F-30-7 — Co-pilot SSE has no keep-alive.** `streamCopilotResponse` calls `res.flushHeaders()` then writes only `text`, `tool`, `notice`, `proposal`, `error`, `done` events. The discovery route writes `{type:'thinking'}` every 8,000 ms during generation (`routes/discovery.js:330`). Production ingress is a Cloudflare Tunnel with a 100 s no-bytes origin timeout (`docs/DECISIONS.md` → Production server facts). Local baseline time-to-first-delta is 1.5 s average / 1.9 s max on Sonnet 4.6 (F-30-15); the margin that made a ping unnecessary disappears once a turn can begin with thinking plus a tool call plus a catalogue search.

**F-30-8 — Frontend tolerates new event types and comment lines.** `frontend/src/services/api.js` `requestStream` splits on blank lines and parses only lines starting with `data: `; `useCopilot` and `useDiscovery` branch on known `type` values and ignore the rest. Consequence: a `{type:'ping'}` data event (or an SSE `: keepalive` comment) is safe without a frontend change. Also: on `done`, `useCopilot` appends an assistant message **only** `if (fullText || proposalPayload)` — a text-less turn renders nothing.

**F-30-9 — Progress-update blocks (Sonnet 5.5).** [Thinking page § Progress updates](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates): "a note on what the model just found and what it's about to do next … comes back as its own `thinking` block … immediately before the `tool_use` block it introduces. At most one progress update precedes each tool call." Under `display: "omitted"` (default) its text is empty; under `"updates"` (beta header `thinking-display-updates-2026-08-18`) or with `between_tools` it carries summary text; under `"summarized"` it is indistinguishable from reasoning. [Prompting Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5): "Notes longer than a sentence or two come back as progress-update thinking blocks. Shorter remarks stay `text`." Whether the explanation that precedes the *first and terminal* `propose_itinerary_changes` call in a response is treated as such a note is **not stated** — it must be observed (E-COP-1). The co-pilot streams `text` deltas only and persists `fullText` (text blocks only), so an affected note vanishes from both the live stream and history.

**F-30-10 — Preserved thinking does not bite Trippy's shapes.** Within a turn the co-pilot appends `{role:'assistant', content}` (the complete block list, thinking included) and `{role:'user', content: toolResults}`; `system` and `tools` do not change between iterations. Across turns `routes/copilot.js` rebuilds history from `copilot_messages.content` (text), so no signed block is replayed after the system prompt changed. Extraction, discovery and descriptors are single-shot. History-editing enforcement is default-on only for organisations created on/after 2026-08-31 00:00 UTC; this repository's first commit is 2026-04-24 and extraction shipped 2026-07-03 against a live key.

**F-30-11 — Output ceilings and the discovery budget.** Haiku 4.5: 64K max output (the comment at `claude.js:350` is correct for 4.5). Haiku 5.5 and Sonnet 5.5: 128K. The discovery prompt asks for ~30 items × 8 categories; the comment estimates 40–50K tokens *in the old tokenizer*; +30% is 52–65K before any thinking. `MIN_CATEGORIES_WITH_ITEMS = 4` guards against a thin catalogue being stored as fresh but says nothing about 5–7 of 8; `runCatalogueGeneration` inserts per completed category and bumps freshness only after `discoverDestination` resolves (an interrupted generation leaves additive rows and stays stale — by design, Plan 26 W1.4).

**F-30-12 — `effort` on the old models.** Sonnet 4.6 accepts `output_config.effort` (`low`/`medium`/`high`/`max`) and adaptive thinking; **Haiku 4.5 rejects `effort`** and knows only `thinking: {type:'enabled', budget_tokens}`. A settings object sent to the wrong model is a 400.

**F-30-13 — Lifecycle.** [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), 2026-10-18: `claude-sonnet-4-6` Active, retirement not sooner than **2027-02-17**; `claude-haiku-4-5-20251001` Active, not sooner than **2026-10-15** (already passed); `claude-sonnet-5-5` not sooner than 2027-09-28; `claude-haiku-5-5` not sooner than 2027-10-07. Notice before retirement is ≥60 days.

**F-30-14 — Images in extraction.** Uploads are stored and sent at native size (`importer.js` caps image inputs at 5 MB; no resizing on either side — `CaptureInput.jsx` has no canvas path; no image library in `backend/package.json`). Both 5.5 models use the high-resolution tier (long edge 2,576 px / 4,784 tokens) where 4.6/4.5 capped at 1,568 px / 1,568 tokens. A 1170×2532 phone screenshot: ≈1,513 tokens on Sonnet 4.6 (downscaled) → ≈3,950 on Sonnet 5.5; at $3 vs $2 per MTok that is ≈$0.0045 → ≈$0.0079 per screenshot. Dev DB holds 8 import artifacts (1 PDF, 7 text) — extraction volume is tiny.

**F-30-15 — Local baseline (dev DB, read-only, 7 co-pilot turns on 2026-07-15).** `copilot_turn_metrics`: input 3,232 avg, output 173 avg, cache read 3,023 avg, cache write 3,055 avg, time-to-first-delta 1,544 ms avg / 1,862 max, total 5,577 ms avg / 11,366 max, 1.43 iterations avg, 0 truncations, 0 errors. Production keeps 90 days of the same table (Plan 15 D2) — the real baseline comes from there (W0). Dev catalogue: 13 destinations, 21 generations, 1,955 places (1,786 with a photo query).

**F-30-16 — Pricing, USD per MTok, [official page](https://platform.claude.com/docs/en/about-claude/pricing) 2026-10-18.** Sonnet 4.6: 3 / 15 (cache write 3.75, read 0.30). Sonnet 5.5: 2 / 10 (write 2.50, read **0.10** — 0.05× base; the bundled skill text's 0.20 is superseded by the official page). Haiku 4.5: 1 / 5 (write 1.25, read 0.10). Haiku 5.5 prompt ≤100K: 0.10 / 0.50 (write 0.125, read 0.01); prompt >100K: 0.50 / 2.50. Prompt length counts all input tokens including cache reads and writes; every Trippy prompt is far below 100K (discovery ≈ 2–6K with 400 exclusions). Thinking tokens are billed as output on every model. Minimum cacheable prompt: 512 tokens on both 5.5 models (1,024 on Sonnet 4.6, 4,096 on Haiku 4.5) — the co-pilot's ~3K system block cached before and still does.

**F-30-17 — Tests and harness precedents.** `backend/tests/claude.test.js` and `importer.test.js` mock the SDK. There is no live-API test. The reliable way to exercise the real model locally is a throwaway/driven harness inside `backend/` that imports the real services (co-pilot: fake SSE `res`, real tool executors, `NODE_ENV=test` so dotenv loads the real key; photos: temp DB + live provider) — recorded in Plans 10 and 12.

---

## 3. Decisions — PROVISIONAL until the named gate; stamp markers only when a wave lands

- **D-30-1 — Settings are keyed by model, never by workload alone.** One `MODEL_PROFILES` map in `claude.js` (`{ [modelId]: { thinking?, effort?, maxTokens } }` per workload use) plus four `*_MODEL` constants that select a profile. A request is built from `profileFor(workload)`; reverting a workload is a one-line constant change that automatically restores the old model's compatible parameters (no `effort` on Haiku 4.5; no `thinking` on Sonnet 4.6). *Gate:* lands in W1; it is behaviour-preserving for the live models. Marker: `D-30-1` above the map.
- **D-30-2 — SDK bump is a separate, revertable step, not a prerequisite.** Bump `@anthropic-ai/sdk` to the latest 0.1xx (0.135.0 at writing) in W1 behind a green backend suite, for `stop_details` on streamed paths and unknown-event tolerance. If any test or the live smoke breaks, revert the bump alone and continue; the migration does not depend on it. *Gate:* W1. Default per **Q-30-2:** yes.
- **D-30-3 — Every request path branches on `stop_reason` before trusting content.** `refusal` → a clean user-facing failure that names the cause (never "no JSON block"); `max_tokens` → failure for extraction/descriptors (a retry is the caller's choice, never silent), the existing `truncated` notice for the co-pilot, and a logged, non-fresh outcome for discovery; `model_context_window_exceeded` handled like `max_tokens`. Log the category when the SDK carries it. *Gate:* W1. Marker `D-30-3` on the shared helper.
- **D-30-4 — A co-pilot turn is never silent.** The route emits a keep-alive data event while a model iteration or tool executor is running (interval ≤ 10 s; the discovery route's 8 s is the precedent), and a turn that ends with no text and no proposal emits a `notice` the panel renders (`empty`, `refused`, `truncated`). *Gate:* W1 (model-agnostic; shipped before any Sonnet switch). Marker `D-30-4`.
- **D-30-5 — Order: Haiku first, Sonnet second, each workload gated independently.** Descriptors (W2) → discovery (W3) → extraction (W4) → co-pilot (W5). Rationale: F-30-13 (Haiku 4.5's retirement floor has passed) and blast radius (descriptors can only degrade a photo query; discovery writes to the shared catalogue; extraction and co-pilot are user-facing judgment). Default per **Q-30-5:** two deploys — Deploy A after W3, Deploy B after W5.
- **D-30-6 — Allowances are budgets chosen from measurement, with headroom, never the provider maximum by reflex.** Candidate starting points (to be confirmed or replaced by W2–W5 evidence): extraction 16,000 (non-streaming limit F-30-6); co-pilot 16,000 per iteration; discovery 96,000 (streamed; ceiling 128,000); descriptors 1,024. Each wave records the observed p50/max `output_tokens` (thinking included) and sets the allowance at roughly 2× the observed max, capped by the ceiling.
- **D-30-7 — Evaluation never touches owner data or the shared catalogue.** Harness runs call the services directly against a *copy* of the dev DB or none at all; no `insertPlaces`, no `enqueueForVerification`, no `copilot_messages`/`copilot_proposals` writes, no provider budget consumption beyond the Anthropic calls themselves. Proof is by side effect: row counts and `generation_count` unchanged after a run.
- **D-30-8 — Every co-pilot turn ends in exactly one persisted assistant row carrying its notice.** *(Owner, 2026-10-18; W1 follow-up. It is the plan's one database migration, 036.)*
  - A stopped turn keeps its partial text, labelled `stopped`. The model sees it as abandoned, not paused, and resumes only if the traveller asks.
  - A provider error mid-turn keeps its partial text, labelled `interrupted`.
  - An aborted or errored turn never becomes a proposal.
  - There is no backfill.
  - "Remove this exchange" is a follow-up, not part of this decision.
  - Marker `D-30-8` in `claude.js`, `routes/copilot.js`, `useCopilot.js` and `CopilotPanel.jsx`.
- **D-30-9 — The co-pilot explains a proposal *after* the tool call, as final text.** *(Owner, 2026-10-19; answers Q-30-3 after the W5 E-COP-1 measurement.)* Amends the Plan 11 Wave 1 terminal-tool rule: `propose_itinerary_changes` still ends tool execution and remains the only action channel, but it no longer ends the turn. The server appends the assistant content unchanged plus one `tool_result` for the proposal call (`{status:'received', operationCount}` — a neutral acknowledgement that promises nothing about validity or persistence), then runs exactly one more model step with `tool_choice: {type:'none'}` so the explanation arrives as ordinary `text`, streamed and persisted by the existing paths; the `proposal` SSE event still follows, so the panel order is unchanged. The `tools` list is identical on every iteration (prompt cache, preserved thinking). Adaptive thinking stays on at effort `low`. Remedies (a) `display: "updates"`, (b) `between_tools` and (b-lite) were rejected: they protect a display artefact by forwarding an API summary channel as the reply and couple the product to one model's thinking-display semantics. Marker `D-30-9` in `claude.js`; row in `docs/DECISIONS.md`.

**Owner questions (defaults in bold; none blocks W0):**

- **Q-30-1 — Env override per workload for rollback without a rebuild?** An `EXTRACTION_MODEL`-style env var would let `.env` + container restart flip a workload in seconds. Cost: a second source of truth that drifts (the repo already carries a `.env` precedence gotcha), and production `.env` is edited by hand. **Default: no** — constants in code, rollback is a one-line revert + `/deploy` (a few minutes).
- **Q-30-2 — Bump the SDK in W1?** **Default: yes**, gated and revertable (D-30-2).
- **Q-30-3 — If E-COP-1 shows the pre-proposal explanation vanishing, which remedy?** (a) `display: "updates"` (beta header) and forward non-empty progress-update text to the panel as a visibly *different* line (it is a model-written summary, not the prose); (b) `between_tools` at `medium` — same summary text, no beta header, no up-front thinking; (c) a protocol change so the model's explanation is written *after* the tool call (a Plan 11 contract change — out of this plan). **Default: decide at the W5 gate from the measurement; do not pre-commit.** *Answered 2026-10-19 by D-30-9: the owner chose (c), brought into this plan as a Plan 11 amendment, after W5 measured (a) at 8/10, (b) at 10/10-with-forwarding and a prompt-only rewording at no effect (§6 W5).*
- **Q-30-4 — Extraction fixtures.** Real confirmations are the only honest corpus. **Default:** the owner supplies 15–25 redacted real inputs (screenshots, PDFs, pasted emails) into the gitignored private fixtures directory; the plan adds 10–15 synthetic hard cases (DD/MM ambiguity, missing year, overnight flights, multi-leg, CJK local names, non-travel input) that are committed. Fewer real inputs lowers the confidence of the W4 gate; it does not change the method.
- **Q-30-5 — Deploy grouping.** **Default: two deploys** (Haiku after W3, Sonnet after W5). *Superseded 2026-10-19 by owner ruling:* two deploys stand, but each is followed by the owner's same-day production pass (Appendix A step 4) instead of a calendar observation window — see §7.

---

## 4. Workload profiles to compare (provisional)

"Control" is the current production configuration, re-run through the same harness so that model and settings are the only variables. "Primary" is the candidate expected to win on the published guidance; "alt" is the measured alternative. Thinking is adaptive unless stated.

| Workload | Control (today) | Primary candidate | Alternatives measured | Allowance candidate | What decides |
|---|---|---|---|---|---|
| Photo descriptors | Haiku 4.5, no thinking, 256 | Haiku 5.5, effort `low` | `thinking: disabled` at `low`; effort `medium` on a 15-item subset | 1,024 | Fallback rate (null results), scene-vocabulary validity, 8-word cap, median latency, `max_tokens` stops = 0 |
| Discovery | Haiku 4.5, no thinking, 64,000 | Haiku 5.5, effort `low` | effort `medium` (default); `thinking: disabled` at `low` | 96,000 (measure; ceiling 128,000) | 8/8 category completion, items per category, dropped-line rate, name-quality defect rate (Plan 27 metrics), real/located sample, time-to-first-category, cost per usable item |
| Extraction | Sonnet 4.6, no thinking, 8,192 | Sonnet 5.5, effort `medium` | effort `low`; effort `high` on the 10 hardest cases | 16,000 | Field accuracy vs labels (dates/times/refs/type/origin/destination/city/countryCode), critical errors, assumptions/confidence honesty, parse/`max_tokens`/`refusal` outcomes, latency, cost |
| Co-pilot | Sonnet 4.6, no thinking, 8,192/iter | Sonnet 5.5, effort `low` | effort `medium`; `between_tools` at `medium` (thinking-off control) | 16,000/iter | E-COP-1 (pre-tool prose survives), grounding, tool/ID correctness, proposal validity, TTFD p50/max, truncations, cache reads within turn, cost per turn |

Prompt text is **frozen** for the first pass (model-only difference). Only if a candidate fails a gate for a reason the official prompting guidance names (literal instruction following, pre-tool notes, JSON-with-reasoning at low effort) may a second pass change the prompt — recorded as its own comparison, never folded into the model switch.

---

## 5. Evaluation design

### 5.1 Harness (W0)

`backend/scripts/modelEval/` (tracked; run by hand, never by `npm test`):

- `profiles.mjs` — the candidate profile table above, by name.
- `extraction.mjs`, `descriptor.mjs`, `discovery.mjs`, `copilot.mjs` — each imports the real service, injects a profile (W0 adds an optional `profile` parameter to the four service functions, defaulting to the live profile so production code paths are byte-for-byte unchanged), runs every fixture, and writes one JSON line per call to `backend/data/model-eval/runs/<workload>/<profile>/<timestamp>.jsonl` with: fixture id, model, settings, `stop_reason`, `stop_details` (when present), `usage` (input, output, cache read/write), wall time, time-to-first-event, parsed output, and the raw text/blocks (redacted for extraction).
- `score.mjs` — per workload, compares a run to its labels/baseline and prints the metrics table in §5.3.
- Fixtures: `backend/scripts/modelEval/fixtures/` (committed, synthetic; discovery destination list; co-pilot scenario scripts with expected tool sequence and grounding expectations; descriptor place list); `backend/data/model-eval/private/` (gitignored; owner's real booking inputs with their hand-labelled expected JSON). W0 adds `backend/data/model-eval/` to `.gitignore`.
- Co-pilot scenarios run against a **copy** of the dev DB (`DB_PATH` pointed at the copy) with the real `searchDiscoveryCatalogue`/`runTripHealthChecks` executors, a fake SSE `res` that records every event with a timestamp, and **no** `persistTurn`. Scenarios target destinations whose catalogue is already fresh in the copy so no background generation kick fires; the script asserts `generation_count` and `discovery_places` counts are unchanged afterwards (D-30-7).
- Discovery runs call `discoverDestination` directly with an exclusion list captured once from the DB copy (so "show more" semantics are exercised) and never `runCatalogueGeneration`; nothing is inserted or enqueued.
- Extraction fixtures pass an explicit `tripContext` date range wherever year inference matters, so a run on a different day is not mistaken for a model difference; the no-context cases are labelled relative to the run date.

### 5.2 Corpus and budget (provisional; W0 confirms the per-call cost before any sweep)

| Workload | Corpus | Calls in the first pass | Rough spend |
|---|---|---|---|
| Descriptors | 50 places (CJK names, cuisines, ambiguous names, hotel/transit types) | 50 × (control + primary + 2 alts on a 15-item subset) ≈ 130 | < $0.50 |
| Discovery | 6 destinations (two CJK-script, one small town, one with sparse nightlife/wellness, two large capitals), first-generation and with-exclusions variants | 6 × 2 × (control + 3 candidates) = 48 generations | control ≈ 12 × 50K out × $5/M ≈ $3; candidates ≈ 36 × 65K × $0.5/M ≈ $1.2 + thinking |
| Extraction | 30 inputs (Q-30-4) | 30 × (control + primary + alt) + 10 × `high` ≈ 100 | ≈ $5–10 (images dominate) |
| Co-pilot | 20 scenarios: plain question, audit via `check_trip_health`, grounded add via catalogue search, booking-linked refusal, out-of-scope destination, multi-search near the 5-call cap, stale-apply handoff, abort mid-turn, a long thread (50-message window) | 20 × (control + primary + 2 alts) ≈ 80 turns, ~1.5 iterations each | ≈ $3–6 |

Total first pass ≈ **$15–25**, run from the developer machine with the dev key. Each wave re-estimates from measured per-call usage before its sweep and records actual spend in its status line.

### 5.3 Metrics and provisional acceptance criteria

Numbers are *provisional thresholds* to be confirmed against the W0 baseline; a wave may tighten them, and may loosen one only with the owner's explicit acceptance recorded in the status line. Report medians and worst cases with sample sizes; no percentile claims from n < 30.

**Descriptors (W2 gate).**
- Fallback (null) rate ≤ control's (expected ≈ 0/50); `stop_reason: max_tokens` = 0/50.
- `sceneType` in vocabulary 50/50 after coercion, and *pre-coercion* validity ≥ control's.
- Photo-query specificity: blind pairwise preference on 20 items ≥ 50% for the candidate (reviewer sees two queries, not the model).
- Median latency ≤ control + 500 ms.
- Cost per descriptor ≤ control (expected ≪).

**Discovery (W3 gate).**
- Categories with ≥1 item: 8/8 on every destination where control also reached 8/8; never fewer than control.
- Items per category: median within −20% of control (quality over volume — a smaller town may honestly yield fewer, but the *same* town must not shrink).
- Dropped unparseable lines: ≤ control's rate; `stop_reason` = `end_turn` on 6/6 primary runs.
- Name-quality defects (editorial prefix survivors, alias-identical-to-name, description-in-brackets — the Plan 27 W4 measures) ≤ control's rate.
- Reality/location spot check: 10 random items per destination, geocoded with the existing resolver pipeline against the DB copy *with budgets observed* (or hand-checked): verified share ≥ control's.
- Time-to-first-category ≤ control + 5 s; total ≤ control + 20%.
- Cost per usable item ≤ control (expected ≪).

**Extraction (W4 gate).**
- Zero new critical errors (wrong date, wrong time, swapped origin/destination, invented confirmation ref, invented booking, missed booking) on the labelled corpus; any control-baseline critical error is investigated, not excused.
- Field accuracy on critical fields ≥ control; `confidence`/`assumptions` honesty: no field marked `high` that is wrong.
- `isTravelRelated:false` on all non-travel fixtures; no fabricated booking.
- Parse failure + `max_tokens` + `refusal` = 0/30 at the chosen setting.
- Median latency ≤ 1.5× control (thinking adds time; the import flow already shows a working state).
- Cost per successful extraction reported against control (both directions acceptable; the owner decides if higher).

**Co-pilot (W5 gate).**
- **E-COP-1:** on every proposing scenario, the explanation the prompt asks for reaches the panel as text (or, under the Q-30-3 remedy, as the agreed visible line) — 100%, measured on the recorded SSE events.
- Grounding: 0 named-place recommendations outside catalogue results; `out_of_scope` declined warmly; `generating`/`generation_capped` relayed honestly.
- Tool/ID correctness: 100% real `dayId`/`stopId`; proposal validation passes on every proposing turn; booking-linked stops never targeted.
- Query cap respected; hard-stop path never triggers on well-formed scenarios.
- TTFD median ≤ 2.5 s and max ≤ 8 s (control 1.5 s / 1.9 s locally); keep-alive events present at ≤ 10 s spacing on every turn longer than that.
- Truncations 0/80; silent turns 0/80 (every text-less turn carries a notice).
- Within-turn cache reads ≥ control's on multi-iteration scenarios (same system block, same effort).
- Cost per turn reported against control.

**Cross-cutting.** Blind the qualitative judgments (randomised A/B labels); record every run's exact request body (minus secrets and image bytes) so a result can be re-run; keep real booking material out of git.

---

## 6. Waves

Each wave: read this plan, implement only that wave, run `cd backend; npm test` (and `cd frontend; npm test; npm run build` when the frontend is touched), update the wave's status line with evidence, commit. Decisions become markers when their wave lands.

### W0 — Baseline, harness, fixtures (no model change, no production change)

**Status:** 2026-10-18 — **COMPLETE.** Step 1 (production export) was run read-only over ssh the same day from a fresh backup copy (`~/Trippy/backups/trippy-plan30-baseline-20261018.db`, integrity ok) and the container log; it is recorded under **Production baseline** below. Production volume is small enough that the gates rest on the harness runs below, and the observation windows in §7 are low-signal confirmation, not the evidence. No model, prompt or production request shape changed: `claude.js` gains only `LIVE_PROFILES` and an optional trailing `profile` argument on the four service functions. The four default request bodies are pinned by sha256 in `backend/tests/claude.test.js`; the hashes were captured against the unmodified `4496a96`, and re-checked by running those tests against HEAD's `claude.js`, where they pass. Backend suite green: 45 files, 982 tests. Harness: `backend/scripts/modelEval/` (README there). Run files are in the gitignored `backend/data/model-eval/runs/<workload>/control/2026-10-18T12-*.jsonl`.

Baseline: control profile, 2026-10-18, harness on the dev machine, dev key.

| Workload (model, max_tokens) | n | Outcome | Latency median / max | Output tok median / max | Cost per call (median) | Run total |
|---|---|---|---|---|---|---|
| Descriptors (Haiku 4.5, 256): 50 places | 50 | 0/50 null; 0 `max_tokens`; sceneType valid before coercion 50/50; in the acceptable set 50/50; 0 queries over 8 words (median 6) | wall 897 / 1,207 ms | 39 / 45 | $0.0004 | $0.020 |
| Extraction (Sonnet 4.6, 8,192): 15 synthetic text fixtures, 0 private | 15 | 0 parse / `max_tokens` / refusal; booking count 15/15; critical fields 151/151; 0 critical errors; 0 high-confidence-but-wrong; `isTravelRelated` 14/15 (`non-travel-fare-promo` came back `true` with no bookings, where rule 6 says `false`) | wall 8.9 / 23.2 s | 668 / 1,921 | $0.0139 | $0.214 |
| Discovery (Haiku 4.5, 64,000): 6 destinations × first / with-exclusions | 12 | `end_turn` 12/12; 8/8 categories on all 12; items per category median 10.75, worst minimum 6; total items median 91 (first 76.5, exclusions 97.5), minimum 69; 0/96 lines dropped; per raw item: editorial prefix 0.4%, alias = name 2.1%, dash clause 1.3%, description-in-brackets (heuristic, F-27-33) 5.2%; on the exclusions variant, 27.6% of raw items repeat an excluded name (`insertPlaces` dedupes them) | first category 20.5 / 33.1 s; total 169 / 313 s | 17,857 / 32,509 | $0.091 ($0.00104 per usable item) | $1.168 |
| Co-pilot (Sonnet 4.6, 8,192/iter): 20 scenarios | 20 | tool sequence 20/20; proposes-as-expected 20/20; E-COP-1 10/10 on both measures; ids real 10/10; server validation 10/10; booking-linked targets 0; adds grounded with a `placeId` from that turn's results 10/10; `catalogueState` relayed 6/6; truncations 0/20; silent turns 0/20; query cap hit 1/20; cache read on iterations 2+ median 5,070 tokens | TTFD 962 / 4,347 ms; turn 6.7 / 30.0 s; iterations 1 / 2 | 190 / 1,699 | $0.0098 (mean $0.0124) | $0.247 |

E-COP-1's two measures are SSE text before the proposal and a text block before the `tool_use`.

**Spend.** Control pass $1.65, plus about $0.22 of smoke runs while building, so W0 cost ≈ **$1.87**. **§5.2 budget, revised from measured usage:** per-call cost is well under the estimates. Discovery control produces ~18K output tokens per generation ($0.09), not 40–50K ($0.25). Extraction is $0.014 per text fixture, the co-pilot $0.01 per turn, a descriptor $0.0004. The remaining W2–W5 first-pass candidate sweep projects to roughly **$3–6**, not $15–25. Extraction is the open term: it depends on how many owner images and PDFs Q-30-4 adds.

**D-30-7 proof.** Printed by `discovery.mjs` and `copilot.mjs` on the control runs, for the owner DB (start / end, opened read-only) and for the copy (before / after). All counts were unchanged:

| Count | Value |
|---|---|
| `discovery_places` | 1,955 |
| `discovery_destinations` | 13 |
| SUM(`generation_count`) | 21 |
| `discovery_generation_daily` | 21 |
| `discovery_verification_attempts` | 2,378 |
| `place_resolution_cache` | 817 |
| `copilot_messages` | 15 |
| `copilot_proposals` | 8 |
| `copilot_turn_metrics` | 7 |
| destinations digest | `d0e53d333682` |

In the co-pilot copy, `discovery_generation_daily` reads 24 both before and after. The extra 3 is the Kaohsiung cap written during setup, before the "before" count. `extraction.mjs` and `descriptor.mjs` import no database.

**Production baseline (read 2026-10-18; `copilot_turn_metrics` keeps 90 days, the container log starts 2026-09-17 06:12 UTC).**

| Workload | Production evidence |
|---|---|
| Co-pilot (Sonnet 4.6) | 8 turns in the table, all 2026-07-15 → 2026-07-21 (nothing since — the 90-day prune has not yet removed them). Input 1,602 avg / 3,062 max; output 172 avg / 494 max; cache read 3,730 avg (6/8 turns read 4,973), cache write 2,095 avg; TTFD 1,458 ms avg / 2,513 max; total 5,271 ms avg / 13,090 max (the one 2-iteration turn with a query call); stop reasons `tool_use` 5 / `end_turn` 3; truncations 0; errors 0. **Two of the five proposing turns have NULL TTFD** — the model called `propose_itinerary_changes` with no prose first, on Sonnet 4.6 — so the real-world E-COP-1 baseline is 3/5, not the 10/10 the scripted scenarios produced. W5 must compare like with like (same scenarios on both models), and a missing explanation is a pre-existing behaviour to measure, not automatically a 5.5 regression. |
| Discovery (Haiku 4.5) | One generation in the log window: ChengDu, CN, 2026-09-24, with 244 exclusion names; started 01:24:25, `[discover] ok` at 01:27:23 (178 s; local control median 169 s); 8/8 categories; `insertPlaces` skipped repeated names across categories (consistent with the 27.6% exclusion-repeat rate measured locally); resolver budget after the run 102/1000, escalation 9/50. Catalogue totals: 13 destinations, 44 generations, 3,014 places. 0 `dropped` / `insufficient yield` lines, 0 provider errors (`anthropic|rate_limit|overloaded|529|APIError`) in the window. |
| Extraction (Sonnet 4.6) | 0 `[import] extract` lines in the window; 3 artifacts ever (1 PDF of 350 KB, 2 pasted texts of ≤395 bytes). No image has ever been extracted in production — the W4 image/PDF evidence can only come from the Q-30-4 private fixtures. |
| Descriptors (Haiku 4.5) | 0 `descriptor generation failed` lines in the window. |

**Facts corrected or learned:**
- **§5.1 "`DB_PATH` pointed at the copy" cannot work.** `config.js` loads `backend/.env` with `override: true`. The harness calls `initDb(copy)` and asserts that `getDb().name` is the copy.
- **Every dev catalogue is past its 7-day freshness window.** The co-pilot harness marks shanghai, hangzhou and taipei fresh and caps kaohsiung, in the copy only, before counting. The `generating` state is not exercised: reaching it would fire a real generation.
- **F-30-11 / C-30-7: discovery output is about half the estimate** (above). The 96,000 candidate is 3× the control maximum; W3 sets the allowance from candidate measurements (D-30-6).
- **A client abort mid-turn is recorded as an error.** With the real SDK, `finalMessage()` rejects on abort. The co-pilot then takes its catch path: it logs a stack trace, writes `error` to the dead socket, and records `copilot_turn_metrics` `error = 1` with zero usage. The unit test covers only a mock that resolves. Production error counts therefore include client disconnects, and an aborted turn's tokens go unrecorded. This is input for W1, not fixed here.
- **The synthetic extraction corpus is at the ceiling for control** (151/151). The W4 gate's ability to tell candidates apart rests on the Q-30-4 private inputs, and no image or PDF path has been exercised yet.
- **Haiku 4.5 can lose a whole category to malformed JSON.** In one smoke generation (ipoh/first), the food line had a `)` where a `}` belonged. The full control run dropped 0/96 lines.

**Files.** `backend/scripts/modelEval/*` (new), `backend/scripts/modelEval/fixtures/*` (new), `.gitignore`, `backend/src/services/claude.js` (optional `profile` parameter on the four service functions — default = live behaviour), `backend/tests/claude.test.js` (prove the default path is unchanged: identical request bodies for all four calls).

**Steps.**
1. Owner exports the production baseline (Appendix A, step 1): `copilot_turn_metrics` for the last 90 days (model, tokens, cache, TTFD, total, iterations, stop reasons) and the discovery generation log lines (`[discover] ok categories=…`) from the container logs — numbers only, no message text. Record medians and maxima here.
2. Build the harness and fixtures (§5.1). Synthetic extraction cases, the 6 discovery destinations, the 50 descriptor places, and the 20 co-pilot scenario scripts are written and committed; the private directory is created and gitignored.
3. Run the **control** profile for all four workloads once; store runs; run `score.mjs`; paste the baseline table into this status line. This is the number every gate compares against.
4. Record per-call cost from `usage` and confirm the §5.2 budget; revise it here.

**Acceptance.** Backend suite green with no request-body change on the default path; one complete control run per workload stored; baseline table in this plan; D-30-7 side-effect proof (counts unchanged) printed by each script.

### W1 — Compatibility hardening (model-agnostic; shippable before any switch)

**Status:** 2026-10-18 — **COMPLETE; DEPLOYED in Deploy A at `a12f473` (2026-10-18).** Still on the old models: no `*_MODEL` constant, prompt or tool schema changed, and the four W0 sha256 request-body pins pass with their literals untouched. Markers `D-30-1`, `D-30-3` and `D-30-4` are stamped in `claude.js`; `D-30-4` is also stamped in `useCopilot.js` and `CopilotPanel.jsx`.

- **D-30-1.** `MODEL_PROFILES` is keyed by model id (Sonnet 4.6: extraction and co-pilot at 8,192; Haiku 4.5: descriptor 256, discovery 64,000). `profileFor(workload)` replaces W0's `LIVE_PROFILES` and throws on an unknown workload or a model with no profile for it. All four are resolved once at module load, so a bad constant fails at boot. Tests prove Haiku 4.5 profiles carry no `effort`/`thinking` and Sonnet 4.6 profiles carry no `thinking`. The harness's `assertControlIsLive` now compares against `profileFor`; all four controls still match.
- **D-30-3.** One `classifyStop(message)` → `{ outcome: complete | truncated | refused, stopReason, category }`. `model_context_window_exceeded` counts as truncated. Each path:
  - Extraction: 502 with traveller-readable copy for a refusal (category included when present) and for a cut-off. Never "no JSON block".
  - Descriptors: return `null` with a `console.warn` naming the reason, on every null path.
  - Discovery: always logs `[discover] end destination= stop_reason= category= output_tokens= categories= items= dropped=`. A truncated or refused generation throws before the freshness bump; `discoveryGeneration.js` is unchanged.
  - Co-pilot: `truncated` / `refused` / `empty` notices, at most one per turn.
- **D-30-4.** `{type:'ping'}` every `COPILOT_PING_INTERVAL_MS = 8000`. The timer is `unref`'d and cleared in a `finally` around the whole turn.
  - `useCopilot` turns a notice alone into an assistant row; unknown notice values are ignored.
  - `CopilotPanel` shows product-voice copy in the existing truncated-notice style, with no empty bubble above a notice-only row: "Reply cut short — ask me to continue." / "I can't help with that one — try asking another way." / "Nothing came through that time — try asking again."
- **W0 abort finding — fixed.** A client abort is now recorded as `stop_reason = 'client_abort'`, `error = 0`, carrying the usage spent so far, with one plain log line, no stack trace and no `error` event. No migration. This covers all three abort paths: `finalMessage()` rejecting, `finalMessage()` resolving after the drop, and a drop between iterations. **Limit:** for the aborted iteration, input and cache tokens are real (from `message_start`), but `output_tokens` is only what the stream had reported. The API sends the output count in `message_delta`, so a mid-reply abort records ≈1. Nothing is estimated.
- **SDK (D-30-2): landed at `0.135.0`** (from 0.91.1). `finalMessage()` now carries `stop_details` on streams (`MessageStream.js` copies it on `message_delta`), and `currentMessage` is still exposed. New transitive dependencies: `@opentelemetry/api`, `standardwebhooks`. `npm audit` lists no advisory for the SDK or its new dependencies; every finding predates this change. The W0 recorder still wraps `create` and `stream` on 0.135.0.

**Evidence.**
- Backend `npm test`: 46 files, 1,025 passed, 6 skipped (the opt-in live file), on SDK 0.135.0. HEAD was 45 files / 982. In two runs under parallel load, one 5 s timeout appeared in `collaboration.test.js`; it passes 14/14 alone and passed in a clean full re-run.
- Frontend `npm test`: 44 files, 316 tests green. `npm run build` is clean.
- `LIVE_ANTHROPIC=1` smoke (`backend/tests/live/anthropic.live.test.js`, 6 tests: extraction text+image raw and through `extractBookings`, descriptor raw and through `generatePhotoDescriptor`, co-pilot tools+stream, discovery NDJSON stream): green on 0.91.1 (17 s) and on 0.135.0 (19 s).
- Browser pass, Playwright, real 375×812 viewport and 1280×860, dedicated W3-verify trip, Sonnet 4.6. A tap on the co-pilot `fetch` recorded every SSE event:
  - Audit + catalogue-search turn: 12.5 s, one ping, reply unchanged.
  - Long walkthrough turn: 32.4 s, pings 8,002 / 8,004 / 8,004 ms apart, none after `done`.
  - Stop mid-turn: metrics row `client_abort`, `error 0`, input 2,475, cache read 4,372.
  - Notices: `empty` and `refused` rendered from a Playwright-scripted SSE response (no server call) at 375 px. DM Mono, no empty bubble, and the refused notice sits under the partial text.
- Spend ≈ $0.10: two smoke runs plus three real co-pilot turns.

**Facts corrected or learned:**
- The browser `fetch` behind the Vite dev proxy can resolve as late as the first body chunk. The client's first ping therefore landed ~7 s after `fetch` resolved, not 8 s. Spacing between pings is the meaningful measure.
- `useCopilot`'s Stop comment says the server keeps the partial text. It does not: the abort path returns before `persistTurn`, so a stopped reply vanishes on reload (seen in the dev DB). This predates W1. Fixed in the W1 follow-up below (D-30-8).
- The live smoke is skipped (not excluded) under `npm test`; it makes zero calls without `LIVE_ANTHROPIC=1`.

**Files.** `backend/src/services/claude.js`, `backend/src/routes/copilot.js` (only if the ping lives in the route rather than the service), `frontend/src/hooks/useCopilot.js`, `frontend/src/components/copilot/CopilotPanel.jsx` (render the new notices next to the existing `truncated` one), `backend/package.json` + lockfile (Q-30-2), `backend/tests/claude.test.js`, `backend/tests/copilot.test.js`, `frontend/src/hooks/useCopilot.test.js` or the panel test, `backend/tests/live/anthropic.live.test.js` (new, opt-in).

**Steps.**
1. **D-30-1 profiles.** Introduce `MODEL_PROFILES` and `profileFor(workload)`; the live profiles reproduce today's bodies exactly (Sonnet 4.6: no `thinking`, no `effort`, 8,192; Haiku 4.5: no `thinking`, no `effort`, 64,000 / 256). Tests assert byte-equality of the four request bodies before and after.
2. **D-30-3 stop-reason handling.** One helper (`classifyStop(message)`) used by all four paths: extraction throws a 502 with a *specific* message for `refusal` (include `stop_details.category` when present) and for `max_tokens` ("extraction output was cut off; try fewer pages or split the file") instead of the generic "no JSON block"; descriptors return `null` and `console.warn` the reason (so a later regression is visible in logs, not just in photo quality); discovery logs `stop_reason`, `usage.output_tokens`, dropped lines and categories at the end of every generation and treats `max_tokens`/`refusal` as a failed generation (throw before the freshness bump — same path the min-category guard uses); the co-pilot keeps `truncated` and adds `refused` and `empty`.
3. **D-30-4 keep-alive and never-silent.** In `streamCopilotResponse`, a `setInterval` writes `{type:'ping'}` every 8 s from `flushHeaders()` until `done`, cleared in `finally` (and `unref`'d so tests and shutdown are not held open — the Plan 26 unref lesson). On a turn that ends with no text and no proposal, write `{type:'notice', notice:'empty'|'refused'}`; `useCopilot` turns any notice into a rendered assistant row even with empty text; `CopilotPanel` shows copy in the product's voice for each notice (no "stop_reason" jargon).
4. **SDK bump (D-30-2, Q-30-2).** `npm i @anthropic-ai/sdk@<latest 0.1xx>`; full suite; the live smoke below; if anything fails, revert this step alone and note it.
5. **Live smoke (opt-in).** `backend/tests/live/anthropic.live.test.js`, skipped unless `LIVE_ANTHROPIC=1`: one tiny request per workload shape (text, image, tools+stream, NDJSON stream) against the *current* live profile, asserting `response.model` starts with the configured id, block types are read correctly, usage is present. Pennies per run; documented in the test header; never part of `npm test`.
6. **Tests.** Mocked fixtures gain a leading `thinking` block (empty text + signature) on every path; a `refusal` and a `max_tokens`-during-thinking fixture per path; the ping and notice events in the co-pilot protocol tests; frontend test for the new notice rendering.

**Acceptance.** All of the above with the *old* models still configured; backend and frontend suites green; `npm run build` clean; a local browser pass of the co-pilot shows ping events in the network tab and an unchanged conversation UX; this wave may be deployed on its own (recommended, so Deploy A carries one variable).

#### W1 follow-up — a stopped reply is kept (D-30-8)

**Status:** 2026-10-18 — **COMPLETE; DEPLOYED in Deploy A at `a12f473` (2026-10-18); migration 036 applied in production at 16:00:33 UTC.** Owner-approved after a findings note. Migration **036** (`copilot_messages.notice`) ships with the next deploy that carries this commit.

- **The bug.** When the traveller pressed Stop, the reply vanished on reload. The next turn's model context then held two user messages in a row, so the API merged the stopped question into the new one.
  - It regressed in Plan 11 W2 (`a661e25`). That change moved the assistant-row save into `persistTurn`, which runs on the success path only. The client comment that said otherwise was true when it was written (`44e3dc5`).
  - The same root cause dropped partial text on a provider error mid-turn, and it never stored a text-less turn or any notice.
- **The fix.** `streamCopilotResponse` saves exactly one assistant row per turn, on every exit path, through one guarded helper.
  - The notices it stores are `stopped`, `interrupted`, `truncated`, `refused` and `empty`.
  - An aborted or errored turn never passes operations, so it can never become a proposal.
  - The route inserts the row only while its question row still exists (`INSERT … WHERE EXISTS`), so a Stop or a turn that races Clear conversation leaves nothing behind.
  - The history endpoint and the context queries break same-second ties by `rowid`, and history returns `notice`.
  - The model sees a stopped row as abandoned: `[The traveller stopped this reply. Treat their next message as a new request; resume only if they ask.]`
  - A blank row that carries a notice is never sent to the model blank.
  - On the client, `useCopilot` stamps `stopped` and `interrupted` itself, because the server never sends them over SSE. `CopilotPanel` gains the copy *"This reply was stopped."* and *"This reply was interrupted — ask again."* The stopped copy is neutral by owner ruling: the server cannot tell Stop from a dropped connection, so a drop is saved as `stopped` too.
- **Unchanged on purpose.** The W1 `client_abort` metrics behaviour is untouched: one row, `error 0`, the same usage.
- **Verified.**
  - Backend: 45 files, 1,042 passed and 6 skipped. `collaboration.test.js` timed out once under load (the known flake) and passed 14/14 when run alone.
  - Frontend: 44 files, 327 tests, all passing. `npm run build` is clean.
  - Migration 036 was applied to a dev-DB copy and then to the dev DB. Existing rows read `NULL`.
  - Local browser pass at 375 px and 1280 px on the W3 verify trip:
    1. Stop mid-reply → the partial text plus the notice. The DB has a `stopped` row with 355 chars, and the metrics row is still `client_abort` / `error 0`.
    2. Reload → the same thread.
    3. "Keep going" → it resumed at Day 2.
    4. Stop before any text → a notice-only row with no empty bubble.
    5. An unrelated next question was answered on its own.
    6. DB rows alternate user/assistant.
- **Limits.**
  - The reloaded partial text can run a few characters past what the screen showed, because chunks already in flight reach the server but not the panel.
  - The `interrupted` path is unit-tested only. A live provider error was not forced.
  - A connection drop that is not a Stop is indistinguishable from Stop on the server, so it is saved as `stopped`.
  - The owner-requested "remove this exchange" control is a separate follow-up and is not built.

### W2 — Photo descriptors → Haiku 5.5

**Status:** 2026-10-18 — **COMPLETE; DEPLOYED in Deploy A at `a12f473` (2026-10-18).** `PHOTO_DESCRIPTOR_MODEL = 'claude-haiku-5-5'`, profile `{ maxTokens: 1024, effort: 'low' }` (the primary candidate won outright). Discovery, extraction and the co-pilot are untouched; the other three W0 sha256 request-body pins pass with their literals unchanged. Haiku 4.5's descriptor row (`{ maxTokens: 256 }`) stays in `MODEL_PROFILES`, and a test pins that it does.

**Sweep** (50-place fixture set, harness, sequential, dev key, 2026-10-18; control = W0 Haiku 4.5 run, now named `baseline-45` on disk):

| Metric | Control: Haiku 4.5, 256 | **Primary: Haiku 5.5, `low`, 1,024** | `thinking: disabled` + `low` | `medium` (first 15 only) |
|---|---|---|---|---|
| Null (fallback) results | 0/50 | **0/50** | 0/50 | 0/15 |
| `max_tokens` stops | 0 | **0** | 0 | 0 |
| `sceneType` valid before coercion | 50/50 | **50/50** | 50/50 | 15/15 |
| Query over 8 words (pre-truncation) | 0/50 | **0/50** | 0/50 | 1/15 (9 words) |
| Latency median / max | 897 / 1,207 ms | **863 / 1,208 ms** | 871 / 2,037 ms | 906 / 1,372 ms |
| Output tokens median / max (thinking included) | 39 / 45 | **52 / 62** | 52 / 62 | 52 / 198 |
| Input tokens median | 205 | 309 (+51%, new tokenizer) | 308 | 307 |
| Cost per call, median | $0.00040 | **$0.00006** | $0.00006 | $0.00006 |
| Run total | $0.0199 | **$0.0029** | $0.0029 | $0.0009 |
| Thinking blocks in the response | n/a | **0/50** | 0/50 | 1/15 |

**Gate (§5.3):** null rate 0 ≤ 0; 0 `max_tokens`; 50/50 valid scene types; median latency 863 ms ≤ 897 + 500; cost 7× lower — **all pass.** Blind pairwise, 20 randomly chosen places, labels shuffled with a seeded generator, key not opened until after voting: **candidate 10, control 2, no clear difference 8** (70% counting ties as half; 83% of decided pairs). Judged by one reviewer (this session's model), not the owner. The wins were mostly landmark-specific nouns (*longtail boats*, *Kaminarimon gate*, *steamer baskets*, *Moonlight Rainbow Fountain*); the two control wins were pairs where the candidate added an arbitrary season ("autumn" for Kiyomizu-dera) or an indoor/outdoor mismatch (Louvre "interior" vs the pyramid courtyard).

**Choice and allowance (D-30-6).** `low` is the winner: it is at parity with `thinking: disabled` on every measure (the same 43–62 output tokens — it did not think on any of 50), so disabling thinking buys nothing and adds one more field a future model change could reject. `medium` is not chosen: it thought once in 15 (198 output tokens, a 9-word query) for no gain. Allowance 1,024 is above the 2×-observed-max rule on purpose: the largest output at any effort was 198, so 1,024 is >5×; and `max_tokens` is a ceiling, not a spend. A cut-off still returns `null`, which the Plan 10 D3 never-block path turns into `resolvedName + city`; the Plan 10 D3 behaviour is untouched.

**End-to-end (Plan 10 pattern: throwaway script, temp DB, real `createStop`, live Unsplash and Nominatim; script deleted).** Five manual stops, one trip each, run twice (the model is non-deterministic, so queries differ slightly between runs). The photos were downloaded and looked at:

| Stop | Query (second run) | Photo |
|---|---|---|
| 清水寺, experience | Kiyomizu-dera temple wooden stage Kyoto autumn | **Right**: Kiyomizu-dera's red pagoda gate, visitors in kimono |
| Borough Market, food | Borough Market London food stalls crowd | **Right**: a stall under a "Borough Market" sign |
| Golden Gai, explore | Golden Gai Shinjuku narrow alley bars night | **Right**: a dim Shinjuku alley, Sapporo bottle in the foreground |
| Tapas crawl in El Born, food | tapas bar El Born Barcelona pintxos counter | **Generic**: three cocktails on a bar — the scene-type fallback, not the place |
| Cooking class, experience | Hanoi cooking class fresh spring rolls herbs | **Generic**: the *same* cocktail photo — the fallback again |

The two generic photos are not a Haiku 5.5 fault. `selectPhoto` (`unsplash.js`) only accepts a primary result if its alt text or tags contain a query token that is not the city or country; otherwise it falls back to a `food drink`-style scene search. To size it, the same 50 fixtures' queries from each model were pushed through `selectPhoto` live, three runs each (249 Unsplash calls): **fallback fired on 15 / 14 / 20 of 50 for Haiku 4.5 and 19 / 20 / 15 of 50 for Haiku 5.5.** The spread inside one model (14–20) is as large as the gap between them (means 16.3 vs 18), so there is no measurable regression — and roughly **one stop in three gets a generic scene photo on either model**.

**Spend.** ≈ **$0.06** in all: three 5.5 runs at $0.0029, the two alternates $0.0038, two extra Haiku 4.5 reruns $0.040, ten end-to-end descriptors under a cent. Live smoke `LIVE_ANTHROPIC=1` (6 tests) green against Haiku 5.5, ≈ $0.03.

**Evidence.** `cd backend; npm test`: 46 files, 1,025 passed, 6 skipped; the single failure in the full run was the known `collaboration.test.js` timeout under load, and it passes 14/14 alone. `claude.test.js` 127/127. The descriptor sha256 pin was re-captured deliberately (`dafd384a…78f4`) after asserting the body's structure by field first (`model`, `max_tokens: 1024`, `output_config: {effort:'low'}`, no `thinking`). The harness's `descriptor` control now equals the live profile (`assertControlIsLive` passes); the W0 Haiku 4.5 baseline is renamed `baseline-45` in `profiles.mjs` and on disk (gitignored `data/model-eval/runs/descriptor/`, so the W0 status line's `…/control/…` path is now `…/baseline-45/…`).

**Unresolved limitations.**
- **Generic-photo fallback rate (~30–38% of descriptor-path stops, both models).** Pre-existing, found here by inspecting photos; `selectPhoto`'s token gate plus a scene-type fallback is the cause, and the same fallback photo can be handed to two stops in different trips (the exclusion set is per trip). Out of Plan 30's scope; a candidate follow-up, not changed.
- The pairwise read is a single reviewer on 20 pairs; it supports "not worse", not "better".
- `docs/ENGINEERING.md` ("Discovery and Photos" still says descriptors use Haiku 4.5) is deliberately left for W6, which owns that edit.
- Deployed in Deploy A (2026-10-18). `[photo] descriptor not usable` warnings remain a standing log check; there is no calendar observation window (owner ruling 2026-10-19, §7).

**Rollback (one line):** `claude.js` → `PHOTO_DESCRIPTOR_MODEL = 'claude-haiku-4-5-20251001'`; the Haiku 4.5 row supplies `{ maxTokens: 256 }` with no `effort`, and the claude test pin for the descriptor body must be flipped back to the W0 literal `7cfb9688…2ea6`.

**Steps (as written).** Run the §5.2 descriptor sweep; score; pick the profile; set `PHOTO_DESCRIPTOR_MODEL = 'claude-haiku-5-5'` and its profile (candidate: effort `low`, 1,024); update `claude.test.js:1073`; local verification via the Plan 10 throwaway script pattern (temp DB, live Unsplash, 5 manual stops) to confirm the descriptor → Unsplash path still yields relevant photos — inspect the actual photos, not just a valid query. Record the sweep table, chosen profile, spend and unresolved limitations in this status line.

**Gate.** §5.3 descriptors. **Rollback:** revert the constant (profile follows automatically).

### W3 — Discovery → Haiku 5.5

**Status:** 2026-10-18 — **COMPLETE; DEPLOYED in Deploy A at `a12f473` (2026-10-18).** `DISCOVERY_MODEL = 'claude-haiku-5-5'`, with profile `{ maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' }` and Haiku 5.5's own prompt selection rules (variant A), keyed by model. The owner accepted the one §5.3 shortfall on 2026-10-18. Details are under *W3 switch* below; the first-pass and second-pass records follow unchanged. **First-pass record:** **BLOCKED AT THE GATE. No candidate passes §5.3. Nothing switched, nothing deployed.** **Second pass (§4 prompt comparison, same day, below):** the best candidate is prompt variant A on Haiku 5.5 with `thinking: disabled` + `low`. It passes every §5.3 criterion but one: alias-identical-to-name is 2.4% against control's 2.1%. Under the per-measure reading the first pass used, that is a fail, so nothing was switched. It needs one owner ruling (*W3 second pass → Needs the owner*). `DISCOVERY_MODEL` is still `claude-haiku-4-5-20251001`. `claude.js` and `claude.test.js` are untouched (the first pass left `profiles.mjs` untouched too; the second pass changed harness files only), so the W0 discovery sha256 pin still holds. Steps 4–5 (switch, allowance, route verification) were not run, because the brief says to stop rather than loosen the bar.

**Sweep** (6 destinations × first / with-exclusions, harness, `--concurrency 3`, dev key, prompt frozen; control = the W0 Haiku 4.5 run on disk). Every run's prompt is at most 8,704 tokens (input + cache), far under Haiku 5.5's 100K price threshold. D-30-7 counts were unchanged for the copy and the owner DB on all three candidate runs.

| Metric (n = 12 each) | Control: Haiku 4.5, 64,000 | Primary: 5.5 `low`, 96,000 | 5.5 `medium`, 96,000 | 5.5 `thinking: disabled` + `low` |
|---|---|---|---|---|
| `stop_reason` | `end_turn` 12/12 | `end_turn` 12/12 | `end_turn` 12/12 | `end_turn` 12/12 |
| Categories with items, worst / median | 8 / 8 | **6** / 8 (taipei/excl) | **3** / 8 (ipoh/excl: insufficient yield, generation thrown) | 8 / 8 |
| Items per category, median of medians / worst min | 10.75 / 6 | **2.5** / 0 | **2.25** / 0 | **5** / 3 |
| Total items median / min (first; excl) | 91 / 69 (76.5; 97.5) | 20 / 12 (24.5; 18) | 23 / 5 (32.5; 12.5) | 37 / 24 (37.5; 32) |
| Dropped unparseable lines | 0/96 | 0/96 | 0/96 | 0/96 |
| Editorial prefix (raw) | 0.4% | 0.0% | 0.0% | 0.0% |
| Alias identical to name (raw) | 2.1% | **3.6%** | 2.1% | **4.7%** |
| Dash clause (raw) | 1.3% | 0.0% | 0.0% | 0.0% |
| Description-in-brackets (heuristic, raw) | 5.2% | 0.0% | 0.4% | 0.9% |
| Exclusions variant: raw items repeating an excluded name | 27.6% | 0.0% | 0.0% | **54.0%** |
| Time to first category, median / max | 20.5 / 33.1 s | 20.5 / 28.0 s | **44.7 / 97.4 s** | 5.0 / 9.4 s |
| Total time, median / max | 169 / 313 s | 38 / 60 s | 71 / 120 s | 38 / 61 s |
| Output tokens median / max (thinking included) | 17,857 / 32,509 | 8,273 / 13,447 | 15,934 / 28,764 | 8,733 / 14,120 |
| Estimated thinking tokens, median / max (share) | 0 | ≈3,090 / 4,746 (≈38%) | ≈8,422 / 20,078 (≈68%) | 0 (no thinking blocks) |
| Cost per generation, median | $0.091 | $0.0047 | $0.0081 | $0.0046 |
| Cost per usable item, median | $0.00104 | $0.00021 | $0.00041 | $0.00013 |
| Run total | $1.168 | $0.0555 | $0.1007 | $0.0563 |

Thinking tokens are estimated as output minus text. The text's tokens are taken from the 0.429 tokens-per-character ratio of the no-thinking run, because thinking text is empty under the default `display: "omitted"`. Per-destination rows are in the run files, `data/model-eval/runs/discovery/<profile>/2026-10-18T14-3*.jsonl`.

**Reality/location spot check.** `backend/scripts/modelEval/discoverySpotCheck.mjs` (new) draws 10 seeded-random items per destination from each profile's run, pooled across both variants and deduped. It runs them through the real `insertPlaces` → `enqueueForVerification` path with live budgets, on scratch destinations inside one `BEGIN … ROLLBACK` on a DB copy. All D-30-7 counts were unchanged after, for the copy and the owner DB.

| Destination | Control | Primary `low` | `disabled` + `low` |
|---|---|---|---|
| Taipei | 0/10 | 4/10 | 3/10 |
| Kuala Lumpur | 2/10 | 7/10 | 5/10 |
| Chengdu | 0/10 | 0/10 | 1/10 |
| 冲绳 | 0/10 | 0/10 | 0/10 |
| Ipoh | 2/10 | 4/10 | 1/10 |
| Kaohsiung | 0/10 | 2/10 | 1/10 |
| **Verified** | **4/60 (7%)** | **17/60 (28%)** | **11/60 (18%)** |

Almost every non-verified item is `weak_match`: control 55, primary 43, disabled 48, plus one or two `no_result`. That spot-check process used 788 of the 1,000 resolver requests (Nominatim) and all 50 Google escalations, which come from that process's in-memory budget, not the dev server's. Escalation ran out partway, so items checked later got no Google second look. All three profiles drained concurrently, so the cut fell on each of them alike.

**Gate (§5.3) — fails on volume for every candidate:**

| Criterion | Primary | Medium | Disabled |
|---|---|---|---|
| 8/8 categories wherever control had 8/8 | fail (6/8) | fail (3/8, 7/8 ×3) | pass |
| Items per category median ≥ −20% of control (≥ 8.6) | **fail (2.5)** | **fail (2.25)** | **fail (5)** |
| Dropped lines ≤ control | pass | pass | pass |
| `end_turn` on all primary runs | pass | — | — |
| Name-quality defects ≤ control | fail (alias = name 3.6% vs 2.1%; the others are lower) | pass | fail (alias = name 4.7%) |
| Verified share ≥ control | pass (28% vs 7%) | not run | pass (18%) |
| First category ≤ control + 5 s; total ≤ control + 20% | pass | fail (44.7 s) | pass |
| Cost per usable item ≤ control | pass | pass | pass |

**What the evidence says, in product terms.** On Haiku 5.5 with today's prompt, a traveller opening a fresh destination would see about 20–37 places where they see about 90 today, and most categories would have 2–5 picks. A "show more" on a destination they have already browsed would add about 12–32. In the `disabled` profile, over half of those would be names already shown, which `insertPlaces` drops. The places that do come back are more often real and locatable: 28% against 7% verify on the first pass. They are also cleaner names, with no editorial prefixes, dash clauses or descriptive brackets. They cost about a fifth per usable item, and arrive four times faster end to end.

**Facts corrected or learned:**
- **The volume collapse is the finding the plan did not anticipate.** §4 and C-30-7 worried that the allowance would cut late categories. With every run at `end_turn` and the largest output at 28,764 tokens (22% of 128K), the 96,000 allowance is irrelevant. The model simply writes fewer items. The prompt says *"Aim for 30 items per category. Fewer sharp picks beats padding with mediocre ones — do not force 30 if the city cannot support it."* Haiku 4.5 reads that as ~10 per category. All three 5.5 settings read it as 2–5, and more thinking (`medium`) made it fewer, not more. This is a hypothesis about cause, not a measured one: no prompt variant has been run (§4 freezes the prompt for the first pass).
- `thinking: disabled` is accepted by Haiku 5.5 on this path (F-30-4 holds), streams its first category in ≈5 s, and is the only 5.5 setting that keeps 8/8 categories. But it ignores the exclusion list about twice as often as control (54% vs 27.6%).
- `medium` spends about 68% of its output on hidden thinking before the first line. First category arrives at 45 s median and 97 s worst. The route's 8 s `{type:'thinking'}` ping keeps the Cloudflare 100 s timer from firing, but the traveller waits.
- Input tokens rise about 39% on the new tokenizer (median 1,605 → 2,226). That is immaterial at $0.10/MTok.
- **The owner's dev catalogue moved between W0 and W3** (`discovery_places` 1,955 → 2,084, verification attempts 2,378 → 2,867, resolver cache 817 → 953). Something outside the harness wrote to the dev DB, most likely the dev server in use. Nothing in this wave did; the start and end counts are equal within every run. The comparison is unaffected because the exclusion lists are frozen in `data/model-eval/discovery-exclusions.json`. The W0 D-30-7 table's absolute values are not current.
- The low control verified share (7%, almost all `weak_match`) is a fact about the resolver on generated items, not about either model. Kuala Lumpur's dev row carries the bare key `kualalumpur` as its `display_name`, which is passed to the resolver as the city. It is noted here, not investigated: resolver order is closed (`docs/DECISIONS.md`).

**Spend.** Anthropic $0.213 for the three candidate sweeps. The spot check made no model call, issued 788 Nominatim requests, and used 50 Google escalations (bounded by the 50/day sub-budget).

**Open — needs an owner decision before W3 can continue.** Rerunning the sweep will not change the gate. The options are:
- A §4 second-pass prompt comparison, with the volume line rewritten for 5.5. The prompt is shared, so it either becomes model-keyed or is also re-measured on Haiku 4.5.
- Explicitly accepting fewer, more verifiable items. That loosens §5.3 and is the owner's call alone.
- Leaving discovery on Haiku 4.5 for now. F-30-13: its retirement floor has passed, so this window is finite.

Deploy A (Q-30-5) was "after W3". W1, the D-30-8 follow-up and W2 are ready on their own, and whether Deploy A goes without W3 is also the owner's call.

#### W3 second pass — prompt variants (§4)

**Status:** 2026-10-18 — **One criterion short of the gate. Nothing switched, nothing deployed.** `claude.js` and `claude.test.js` are untouched, so the W0 discovery sha256 pin still holds. The owner approved this pass with the gate unchanged. §4's precondition holds: the first pass failed on volume, and literal instruction-following and length calibration are named causes in the official prompting guidance.

**Method.** Variants are applied in the harness only. `scripts/modelEval/lib/discoveryPromptVariants.mjs` replaces the two volume/selection lines of `DISCOVER_SYSTEM` on the wire. The wrapper is installed after the recorder, so each run file stores the patched system prompt. It throws unless each original line appears exactly once. Every naming, alias, photoQuery, sceneType and other curation rule is byte-identical. Profiles carry a harness-only `promptVariant` key, which `toServiceProfile` strips. The scorer gained the thinking-token estimate the first pass computed by hand: output minus text × 0.429 tokens per character. Same 6 destinations × first/exclusions, same frozen exclusion lists, `--concurrency 3`, dev key. D-30-7 counts were unchanged for the copy and the owner DB on all five sweeps and the spot check.

**The two original lines:**
- quality: `- Each suggestion must earn its place. If you cannot write a specific, non-generic "whyItFits", do not include it.`
- volume: `- Aim for 30 items per category. Fewer sharp picks beats padding with mediocre ones — do not force 30 if the city cannot support it.`

**The three variants (exact replacement text; a line not listed is kept):**
- **A `floor-ranked`:**
  - quality → `- Each suggestion must earn its place: put the picks with the most specific "whyItFits" first in each category, and when a candidate would only get a generic "whyItFits", choose a different place instead.`
  - volume → `- Return 10–15 items per category. Include at least 8 in every category unless the destination genuinely cannot support that many; never pad with mediocre places, and say nothing about any shortfall.`
- **B `floor`:** volume as in A; the quality line is the original. This tells which line drives volume.
- **C `aim30-exit`:** volume → `- Aim for 30 items per category. Stop short of 30 only when the destination has genuinely run out of places that meet these rules.` The quality line is the original. This tests whether the "fewer sharp picks" sentence alone causes the collapse.

| Metric (n = 12 each) | Control: Haiku 4.5 (W0) | A, 5.5 `low` | B, 5.5 `low` | C, 5.5 `low` | **A, 5.5 `disabled` + `low`** | A on Haiku 4.5, 64,000 |
|---|---|---|---|---|---|---|
| `stop_reason` | `end_turn` 12/12 | `end_turn` 12/12 | `end_turn` 12/12 | `end_turn` 12/12 | `end_turn` 12/12 | `end_turn` 12/12 |
| Categories with items, worst / median | 8 / 8 | 8 / 8 | **7** / 8 | 8 / 8 | 8 / 8 | **7** / 8 |
| Items per category, median of medians / worst min | 10.75 / 6 | **7.5** / 3 | **7.5** / 0 | **4** / 1 | **11** / 2 | 10 / 0 |
| Total items median / min (first; excl) | 91 / 69 (76.5; 97.5) | 59 / 40 (60.5; 53) | 60 / 26 (61; 55.5) | 32.5 / 13 (34.5; 19.5) | 88.5 / 23 (91.5; 83) | 78 / 61 (70; 89.5) |
| Dropped unparseable lines | 0/96 | 0/96 | **2/97** | 0/97 | 0/96 | **14/110** |
| Editorial prefix (raw) | 0.4% | 0.0% | 0.0% | 0.0% | 0.0% | 1.0% |
| Alias identical to name (raw) | 2.1% | 1.6% | 0.8% | 1.0% | **2.4%** (24/995 vs 24/1119) | 1.0% |
| Dash clause (raw) | 1.3% | 0.0% | 0.0% | 0.0% | 0.0% | 5.4% |
| Description-in-brackets (heuristic, raw) | 5.2% | 0.0% | 0.0% | 0.0% | 0.1% | 9.6% |
| Exclusions variant: raw items repeating an excluded name | 27.6% | 0.0% | 0.0% | 0.0% | 31.0% | 33.0% |
| Time to first category, median / max | 20.5 / 33.1 s | **35.9** / 62.4 s | **40.8** / 58.9 s | 23.4 / 35.2 s | 11.6 / 15.1 s | 19.2 / 29.4 s |
| Total time, median / max | 169 / 313 s | 83 / 103 s | 85 / 113 s | 54 / 103 s | 77 / 93 s | 176 / 217 s |
| Output tokens median / max (thinking included) | 17,857 / 32,509 | 19,330 / 25,002 | 19,335 / 25,931 | 11,743 / 24,372 | 19,485 / 22,715 | 17,109 / 22,251 |
| Estimated thinking tokens, median / max (share) | 0 | 5,295 / 11,687 (35%) | 6,292 / 10,108 (34%) | 3,258 / 5,779 (30%) | 0 | 0 |
| Cost per generation, median | $0.091 | $0.0099 | $0.0103 | $0.0060 | $0.0100 | $0.087 |
| Cost per usable item, median | $0.00104 | $0.00017 | $0.00017 | $0.00020 | $0.00011 | $0.00109 |
| Run total | $1.168 | $0.1195 | $0.1210 | $0.0743 | $0.1126 | $1.0615 |

Run files: `data/model-eval/runs/discovery/<profile>/2026-10-18T15-*.jsonl`, profiles `v-floor-ranked-low`, `v-floor-low`, `v-aim30-exit-low`, `v-floor-ranked-disabled-low`, `45-floor-ranked`.

**Reality/location spot check** (`discoverySpotCheck.mjs --profile control,v-floor-ranked-disabled-low`, seed 30, 10 per destination, `BEGIN … ROLLBACK` on a DB copy). Taipei 0/10 vs 0/10, Kuala Lumpur 2 vs 4, Chengdu 0 vs 0, 冲绳 0 vs 0, Ipoh 2 vs 1, Kaohsiung 0 vs 3. **Verified: control 4/60 (7%), candidate 8/60 (13%).** Control reproduced its first-pass sample and its 4/60 exactly. Almost every remaining item is `weak_match` (control 55 plus 1 `no_result`; candidate 52). The process used 656 of 1,000 Nominatim requests and all 50 Google escalations, which ran out partway through. The budget is process-local, as in the first pass.

**Gate (§5.3), applied as the first pass applied it — each name measure against control separately, raw model output:**

| Criterion | A `low` | B `low` | C `low` | **A `disabled` + `low`** |
|---|---|---|---|---|
| 8/8 categories wherever control had 8/8 | pass | fail (7/8) | pass | pass (12/12) |
| Items per category median ≥ 8.6 | fail (7.5) | fail (7.5) | fail (4) | **pass (11)** |
| Dropped lines ≤ control (0) | pass | fail (2) | pass | pass |
| `end_turn` on every run | pass | pass | pass | pass |
| Name-quality defects ≤ control, each measure | pass | pass | pass | **fail: alias = name 2.4% vs 2.1%.** Prefix, dash and bracket are all lower. |
| Verified share ≥ control | not run | not run | not run | pass (13% vs 7%) |
| First category ≤ control + 5 s (25.5 s); total ≤ control + 20% (203 s) | fail (35.9 s) | fail (40.8 s) | pass | pass (11.6 s; 77 s) |
| Cost per usable item ≤ control | pass | pass | pass | pass ($0.00011) |

**What the evidence says, in product terms.** With variant A and thinking off, Haiku 5.5 fills a fresh destination about as fully as today: about 89 places against 91, 8 of 8 categories every time. The first category shows in about 12 s instead of 20 s, and the whole generation takes about 77 s instead of 169 s. The cost per usable place is about a tenth. Twice as many sampled places verify on the first pass (13% vs 7%). The gate's one remaining objection is that slightly more items (24 of 995 against 24 of 1,119) list their own name again as an alias. Production already strips every such alias before anything is stored (`sanitizeGeneratedAliases`), so a traveller can never see one or be affected by one.

**Facts corrected or learned:**
- **The cause is confirmed, and it is the volume contract, read literally.** An explicit floor is what restores volume. Variant C keeps "aim for 30" and only narrows the exit, and it still yields 4 per category. With adaptive thinking (`low`), the model treats "at least 8" as the target and ignores "10–15": median 7.5 for both A and B, so the quality line's gating wording is not the driver. With thinking off, the same wording lands inside the range (11).
- **For discovery, `thinking: disabled` is the right Haiku 5.5 setting once the prompt has a floor. §4's primary (`low`) was wrong for this workload.** At `low` the model spends about 35% of its output planning the whole list before the first line (first category 36–41 s). It also lands under the floor.
- **A shared prompt is not viable.** Variant A on Haiku 4.5 loses a category and drops 14 lines. 13 of those are one Ipoh "show more" that appended a markdown "Curator's Notes" essay after the JSON; the other is a malformed food line. Its dash-clause and description-in-brackets rates rise to 5.4% and 9.6%. If discovery switches, the prompt must be keyed by model through the D-30-1 profile, so a rollback restores the old prompt with the old model.
- **Haiku 5.5 can split one NDJSON object across two lines.** It happened in variant B (Kaohsiung essentials), and `processLine` dropped the whole category. It happened 1 time in 48 Haiku 5.5 generations this pass, and never in the candidate's 12.
- **One candidate run ignored the floor.** Kuala Lumpur "show more" (187 exclusions) returned 23 places, 2–3 per category, including generic entries such as "Sauna and Steam Facility (Bukit Bintang)"; control returned 84 there. The gate is on medians, so this does not fail it. But it is the one place in the sweep where the same town shrinks.
- **The candidate's near-zero bracket rate overstates its name-quality gain (F-27-33).** Read row by row, the wellness category pads with generic non-places in both control and the candidate. The candidate writes them without brackets ("Chengdu Yoga Studio in Taikoo Li", "Ipoh Old Town Shade Benches", "Naminoue Shrine Sea Breeze Sit"), so the heuristic does not flag them. The Q-27-6 padding defect is still there. Moving from "aim for 30" to "10–15, at least 8" does not resolve Q-27-6. Q-27-6 stays the owner's open breadth-vs-quality question.
- **The alias = name measure is noisy at this sample size.** The same prompt family has measured 1.0% (A on 4.5), 2.1% (control) and 5.1% (Plan 27 W4.3, 5 of 98 items). 24/995 against 24/1,119 is not a distinguishable difference.
- **§5.3's name-quality line is ambiguous.** It names "editorial prefix *survivors*" (after the backstop) beside raw measures, and compares them to "control's rate" in the singular. The first pass read it as each raw measure separately, and this pass keeps that reading so the gate stays unchanged. Read as one combined raw defect rate, the candidate is 2.5% against control's 7.7%, which passes. Read as survivors after the backstops, both are 0%.

**Spend.** Anthropic **$1.489** (A low $0.120, B $0.121, C $0.074, A disabled $0.113, A on Haiku 4.5 $1.062), under the $2 cap. The spot check made no model call: 656 Nominatim requests and 50 Google escalations, within the process-local budgets.

**Needs the owner — one ruling.** Only the owner may loosen §5.3. Do you accept alias-identical-to-name at 2.4% against 2.1% for this candidate, given that production strips every such alias before storage?
- **If yes** (recommended — the evidence supports it), the switch is mechanical:
  - A model-keyed discovery prompt: Haiku 5.5's profile carries variant A's two lines, and Haiku 4.5 keeps today's text.
  - A `'claude-haiku-5-5'` discovery profile `{ maxTokens: 48000, effort: 'low', thinking: { type: 'disabled' } }` (D-30-6: about 2 × the observed maximum of 22,715).
  - `DISCOVERY_MODEL = 'claude-haiku-5-5'`, a rewritten 64K comment, a re-captured discovery sha256 pin, and a new pin on the prompt text.
  - Then the route generation on the DB copy, the `LIVE_ANTHROPIC=1` smoke, and the backend suite.
- **If no:** stay on Haiku 4.5 (F-30-13: a finite window). Sonnet 5.5 is not indicated: Haiku 5.5 already matches control's volume at about a tenth of the cost, and "accept fewer verified items" is no longer the trade, because the candidate returns as many items with more verified.

Separately, the owner may want to rule on the reading of §5.3's name-quality line for W4–W5.

#### W3 switch — owner-accepted, discovery on Haiku 5.5

**Status:** 2026-10-18 — **COMPLETE; DEPLOYED in Deploy A at `a12f473` (2026-10-18).**

**Owner ruling, recorded as §5.3 requires.** The owner "accepts alias-identical-to-name 2.4% vs 2.1% for variant A on Haiku 5.5 thinking disabled + low". This is the only loosening; every other §5.3 criterion passed as measured above.

**What changed.**
- **`claude.js`:**
  - `DISCOVERY_MODEL = 'claude-haiku-5-5'`.
  - A new `MODEL_PROFILES['claude-haiku-5-5'].discovery` of `{ maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' }`. D-30-6: about 2 × the 22,715-token maximum of the measured run. The measured run's allowance was 96,000, but no generation came near it, so the allowance is not a variable here.
  - The discovery prompt's two volume/selection lines moved into `DISCOVERY_SELECTION_RULES`, keyed by model. `discoverySystemPrompt(model)` builds the prompt; `discoverDestination` selects it from `profile.model`. Marker `D-30-1` sits above the map.
  - Haiku 4.5's row and rules are kept verbatim. A model with no rules fails at boot and on use.
  - The stale "~30 items ≈ 40–50K tokens" comment on the Haiku 4.5 row now states the W0 measurement (17,857 median / 32,509 max).
  - Not changed: `MIN_CATEGORIES_WITH_ITEMS`, `discoveryGeneration.js`, and every lifecycle and budget path.
- **`claude.test.js` pins:**
  - The discovery request-body pin is re-captured: `4feadef7…`.
  - A new rollback pin proves Haiku 4.5's profile still sends the exact W0 body: `0c8c2727…`, unchanged.
  - New prompt-text pins: Haiku 4.5 `34c3742f…`, byte-identical to the pre-W3 constant; Haiku 5.5 `b851c503…`, byte-identical to the system prompt the measured runs recorded. Both were checked against the run file.
  - Further tests: the two prompts differ only in the two lines; every model with a discovery profile has rules; a model without rules is refused before any request.
- **Harness:**
  - `profiles.mjs` `control` is now the live Haiku 5.5 profile. `baseline-45` is the W0 control.
  - The first-pass 5.5 profiles carry `promptVariant: 'original'`, so they still measure the frozen prompt.
  - `discoveryPromptVariants.mjs` reads the live rules per model, and variant A is a byte-for-byte no-op on Haiku 5.5.
  - New `discoveryRouteCheck.mjs`.

**Route verification** (`NODE_ENV=test node scripts/modelEval/discoveryRouteCheck.mjs`, which runs the real `POST /api/trips/:tripId/discover` on a DB copy; session minted in the copy):
- **Destination:** Tainan, TW, a first generation, absent from the dev catalogue.
- **Generation:** `[discover] end … stop_reason=end_turn output_tokens=15707 categories=8 items=73 dropped=0`.
- **SSE stream:** `thinking` at 8.0 s; essentials at 10.5 s; then one ping between each pair of categories (6 in all); wellness and `done` at 61.5 s.
- **Per-category counts:** 10, 10, 11, 10, 9, 9, 3 and 11. Architecture's 3 is under the floor, as the prompt allows.
- **Verification queue:** rows were inserted and enqueued per category. When the stream ended, 50 were `pending`, 15 already `unverified` and 8 already `verified`, because verification starts as each category lands. After the drain: 10 verified and active, 2 verified and archived as provider-id duplicates, 61 unverified (16% verified).
- **Budgets and side effects:** the process-local budget used 262 of 1,000 resolver requests and 50 of 50 escalations. `generation_count` is 1. The copy was deleted, and the owner DB counts were unchanged.

**Checks.**
- `LIVE_ANTHROPIC=1 npx vitest run tests/live`: 6/6 passed. The discovery shape ran on the new profile.
- `cd backend; npm test`: 45 files passed (1 skipped), 1,055 tests passed, 6 skipped (the live suite).

**Spend.** The route run and the live smoke cost a few cents at Haiku 5.5 rates. The W3 total is about $1.73 of Anthropic spend: $0.213 for the first pass, $1.489 for the second pass, and about $0.03 for the switch checks.

**Not done here (W6 owns them).**
- `docs/ENGINEERING.md:121` (the models bullet) was corrected at Deploy A, because it had become a false statement about production. W6 still adds the effort/cache line.
- The `docs/DECISIONS.md` rows.

**Deploy A** went out on 2026-10-18 at `a12f473`. The record is under *Deploy A record* below.

**Rollback:** set `DISCOVERY_MODEL` back to `'claude-haiku-4-5-20251001'`. That one line restores Haiku 4.5's settings and its original prompt; the rollback test pins the resulting body to the W0 hash. A stale refresh on the old model fills in any partial batch (Plan 26 semantics). No catalogue rebuild and no mass refresh (`docs/DECISIONS.md`).

*First-pass rollback note (superseded by the switch):* nothing to roll back; no production constant changed.

**Steps.** Sweep per §5.2; measure actual `output_tokens` (thinking included) per generation and set the allowance (D-30-6); pick the profile (candidate: effort `low`, 96,000); set `DISCOVERY_MODEL`; update the `claude.js:350` comment to state the new reasoning (the 64K ceiling rationale is Haiku-4.5-specific and must not survive as a false fact) and `claude.test.js:210`; keep `MIN_CATEGORIES_WITH_ITEMS` and all lifecycle/budget behaviour untouched; one real local generation through the route (fresh destination in the dev DB copy — *not* production) to confirm per-category streaming and the `thinking` ping still interleave; confirm the resolver verification queue behaves identically on the new rows (budgets, provenance `pending`).

**Gate.** §5.3 discovery. **Rollback:** revert the constant; a stale-refresh on the old model complements any partial batch (Plan 26 semantics). No catalogue rebuild, no mass refresh, before or after (`docs/DECISIONS.md`).

**Deploy A (default, Q-30-5):** after W3 — `/deploy` with the standard pre-deploy backup; post-deploy: one descriptor on a new manual stop, one discovery "show more" on a fresh destination the owner chooses, container logs show `[discover]` lines with `stop_reason=end_turn` and 8 categories. Observation window: 7 days (one catalogue freshness cycle); watch descriptor `null` warnings and discovery stop reasons.

**Deploy A record (2026-10-18; owner-requested).** Production now runs `a12f473`.

- **What shipped:** W1, D-30-8, W2, W3 and Plan 31 W1, plus the docs for Plans 30, 31 and 32.
- **How it reached `main`.** `main` now carries a "Protect Default" ruleset, created 2026-10-02: changes must arrive through a pull request, with 0 approvals required. The direct push every earlier deploy used was refused. The release went through [PR #2](https://github.com/cchen362/Trippy/pull/2) as a merge commit, so every commit hash is unchanged. The repository has no CI checks.
- **Pre-flight:**
  - Backend: 45 files, 1,055 tests passed.
  - Frontend: 44 files, 327 tests passed; `vite build` OK.
  - `LIVE_ANTHROPIC=1` smoke: 6/6.
  - No secrets and no tracked data in the diff (`f2383de..a12f473`, 63 files).
  - The only dependency change is `@anthropic-ai/sdk` ^0.135.0. No new environment variable.
- **Backup:** `~/Trippy/backups/trippy-pre-plan30A-20261018-095916.db`, `integrity_check` ok, 12.9 MB. Migrations through 035; 5 trips, 105 stops, 3,014 discovery places, 22 co-pilot messages. Nightly backup cron confirmed active.
- **Server:**
  - `git pull --ff-only` moved `f2383de` to `a12f473`; then `docker compose up -d --build`.
  - Startup log: `Migration applied: 036_copilot_message_notice.sql`, then `Trippy backend running … [production]`. No error lines.
  - `/api/health` returns `{"status":"ok","db":"connected","mcp":{"enabled":true,…}}`.
- **Live state after the deploy:**
  - `_migrations` max is 36. `copilot_messages.notice` exists, and 0 rows are set (no backfill, as designed).
  - Counts are identical to the backup.
  - The container's `claude.js` has `DISCOVERY_MODEL` and `PHOTO_DESCRIPTOR_MODEL` set to `'claude-haiku-5-5'`; the SDK is 0.135.0.
- **Production key, checked in place of the Appendix A step 2 Console check:**
  - One minimal request per shape, run from inside the container with the production key. Discovery's `thinking: disabled` + `low` and the descriptor's `low` both returned `end_turn`, so no workspace allow-list blocks `claude-haiku-5-5`.
  - The rate-limit tier cannot be read from the server. It stays an owner Console item, and is low-risk at this volume.
- **Owner production QA: PASSED (2026-10-18), on the new trip "BKK - 30 W3 Deploy A".**
  - **Photo:** a new manual stop ("KhuaKling PakSod Thong Lo") got its photo. This covers the descriptor and Plan 31 W1.
  - **Stopped reply:** a stopped co-pilot reply survived a reload with its "This reply was stopped." label (D-30-8).
  - **Discovery:**
    - Bangkok's first open and a "show more" both streamed 8 categories.
    - The container log shows three generations, all `stop_reason=end_turn categories=8 dropped=0`, with 85, 96 and 90 items (20,321–21,345 output tokens).
    - The owner reported that the first view looked thin: 67 places, food 5. After a reload and reopen the panel showed the full catalogue: 206 active places, food 22.
- **Defect found during QA — older than Deploy A, not caused by the model switch.**
  - Opening Discovery on the brand-new trip fired **two** cache-miss generations for Bangkok, 5 s apart (16:06:41 and 16:06:46 UTC). The panel showed only the second request's stream: the rows that the first request, 5 s ahead, had not already inserted.
  - The first request's places were stored but not shown until the reload. The duplicate also spent one of Bangkok's three daily generations (`MAX_GENERATIONS_PER_DESTINATION_PER_DAY`).
  - No discovery file changed in Deploy A (`f2383de..a12f473`).
  - Being investigated in its own session: the double request, probably the `TripPage` pre-warm and the panel sending different cache keys, plus the missing server-side single-flight. That session produces findings first; nothing is fixed here.
  - **Findings (2026-10-19): Plan 33 — Discovery Single-Flight Generation.** The keys were *not* different: the pre-warm and the panel both send `bangkok|TH` and the client deduplicates them. The second request comes from anything that rebuilds `TripPage` mid-generation (leave the trip and return, reload, PWA relaunch, settings save), and the server has no single-flight, so it starts a second generation. Proposed fix: concurrent requests join the running generation. Awaiting owner approval.
- **"Show more" yield:** 90 generated, 50 new; the other 40 (44%) repeated stored names, which `insertPlaces` drops. That is above the 31% exclusion-repeat rate W3 measured for this profile. It is one data point, against a 156-name exclusion list, so watch it over the observation window.
- **Observation:** no calendar window (owner ruling 2026-10-19, §7). The owner's production pass passed the same day; descriptor `null` warnings and discovery stop reasons stay as standing log checks, read at Deploy B and on request.

### W4 — Extraction → Sonnet 5.5

**Status:** 2026-10-19 — **COMPLETE (owner-accepted); not deployed (Deploy B).** `EXTRACTION_MODEL = 'claude-sonnet-5-5'`, profile `{ maxTokens: 16000, effort: 'medium' }`. Details are under *W4 switch* below; the sweep record follows unchanged. **Sweep record:** two criteria short of the gate; one owner ruling needed. Nothing was switched at that point: `EXTRACTION_MODEL` was still `claude-sonnet-4-6`. `claude.js` and `claude.test.js` are untouched, so the W0 extraction sha256 pin still holds. The two shortfalls are both formatting or prompt issues, not misread facts. Sonnet 4.6 shows the same two (one of them worse), so no candidate is judged against a bar control itself meets. Like W3, this stops rather than loosening §5.3. Steps 3–4 (switch, re-pin, browser pass, live smoke) were not run.

**Corpus.** `private/extraction/` is still **empty** (Q-30-4), so everything below is synthetic.
- The 15 W0 text fixtures.
- 8 new committed renders of those texts, made by `renderExtractionFixtures.mjs` with the installed Chromium headless shell (no new dependency):
  - 6 phone email screenshots at 1170×2532. Five are travel; one is the dinner invite.
  - 2 single-page A4 PDFs with selectable text.
  - The renderer throws if any source fact is missing or any digit is added.
- The "10 hardest" for `high` are the 17 fixtures tagged `hard`: 11 text and 6 renders.

**Sweep** (2026-10-19, harness, `--concurrency 2`, dev key, prompt frozen).
- Control is a fresh Sonnet 4.6 run on all 23 fixtures. The W0 run on disk (15 text fixtures) scores identically on every shared fixture.
- Run files: `data/model-eval/runs/extraction/{control,primary,alt-low,alt-high}/2026-10-18T16-3*.jsonl`. The harness stamps UTC.

| Metric | Control: Sonnet 4.6, 8,192 | **Primary: 5.5 `medium`, 16,000** | 5.5 `low`, 16,000 | 5.5 `high`, 16,000 (hard, n = 17) |
|---|---|---|---|---|
| `stop_reason` | `end_turn` 23/23 | `end_turn` 23/23 | `end_turn` 23/23 | `end_turn` 17/17 |
| Parse / `max_tokens` / refusal | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Booking count correct | 23/23 | 23/23 | 23/23 | 17/17 |
| Critical-field accuracy (§5.3 fields) | 231/231 | **231/231** | 231/231 | 175/175 |
| — text / image / PDF | 139/139 · 64/64 · 28/28 | 139 · 64 · 28 (all correct) | all correct | all correct |
| Critical errors | 0 | **0** | 0 | 0 |
| High confidence on a wrong *critical* field | 0 | **0** | 0 | 0 |
| Other labelled fields (flight/train no., localName), as labelled | 22/22 | 15/22 | 15/22 | 13/18 |
| — high confidence but different from the label (all `flightNumber`) | 0 | **6** | 7 | 5 |
| Flight numbers Trippy can use (`normalizeFlightQuery` accepts the pair and gets the right designator) | **0/16** | 7/16 | 7/16 | 5/12 |
| — unusable *and* marked high confidence | **16** | 9 | 8 | 7 |
| `isTravelRelated` correct | 22/23 | 22/23 | 22/23 | 16/17 |
| Wall time median / max | 9.6 / 19.9 s | **4.7 / 11.8 s** | 4.5 / 10.6 s | 5.0 / 13.6 s |
| — text / image / PDF median | 9.2 · 11.1 · 12.0 s | 4.5 · 5.1 · 5.9 s | 4.3 · 4.6 · 5.1 s | 5.0 · 5.1 · 4.9 s |
| Output tokens median / max (thinking included) | 663 / 1,700 | 746 / 2,180 | 724 / 1,988 | 812 / 2,370 |
| Responses with a thinking block | 0/23 | 2/23 | 1/23 | 5/17 |
| Est. thinking tokens, max | 0 | 475 | 366 | 585 |
| Input tokens median: text · image · PDF | 1,300 · 2,679 · 2,911 | 1,687 · 5,402 · 3,314 | same as primary | same |
| Cost median: text · image · PDF | $0.0139 · $0.0178 · $0.0209 | $0.0108 · $0.0183 · $0.0158 | $0.0106 · $0.0181 · $0.0156 | $0.0114 · $0.0190 · $0.0142 |
| Cost per successful extraction | $0.0159 | **$0.0136 (−14%)** | $0.0133 | $0.0155 |
| Run total | $0.365 | $0.312 | $0.305 | $0.264 |

How the thinking estimate works: output minus text. The scorer takes the text's tokens per character from the same run's responses that had no thinking block. Two runs cross-check it:
- 5.5 runs: 0.407 tokens/char from the thinking-free responses in each run.
- `count_tokens` on the W0 control's 15 responses (31,825 chars): 0.397 on 5.5's tokenizer, and 0.324 on 4.6's — within 0.4% of 4.6's billed output.

**Image token cost (F-30-14), measured with `count_tokens`** (`imageTokens.mjs`; free).
- One 1170×2532 screenshot: **1,459 tokens on Sonnet 4.6 → 3,825 on Sonnet 5.5 (2.62×)**. That is $0.0044 → $0.0077, +$0.0033 per image.
- F-30-14 predicted 1,513 → 3,950, so the estimate holds.
- Whole image extraction: median **$0.0178 → $0.0183 (+3%)**. Cheaper output offsets the dearer image.
- PDFs: 1,689–1,697 → 1,722–1,754 tokens, so a PDF costs less on 5.5.

**Forced cut-off (D-30-3)** — profile `forced-cutoff`, `max_tokens` 300, harness only.
- Both multi-leg fixtures stopped at `max_tokens` with *"The booking reader's output was cut off — try fewer pages or split the file."*
- On the text version, Sonnet 5.5 spent all 300 tokens thinking and returned **no text block at all**. The W1 classifier reported it correctly; a parser that trusted content would have said "no JSON block".

**Gate (§5.3), primary (`medium`):**

| Criterion | Result |
|---|---|
| Zero new critical errors | **pass** (0) |
| Critical-field accuracy ≥ control | **pass** (231/231 = 231/231) |
| No field marked `high` that is wrong | **fail.** Against the labels as written, 6 `flightNumber` fields. Against Trippy's own contract, 9, where control has 16. |
| `isTravelRelated:false` on all non-travel fixtures | **fail, identically on control and every candidate.** Both dinner invites (text and image) are correct. `non-travel-fare-promo` comes back `true` with 0 bookings on all four profiles. |
| Parse + `max_tokens` + refusal = 0 | **pass** (0/23) |
| Median latency ≤ 1.5× control | **pass** (4.7 s against 9.6 s, 0.49×) |
| Cost per successful extraction reported | $0.0136 against $0.0159 (−14%); images +3% |

**What the evidence says, in product terms.**
- **Facts.** On Sonnet 5.5 at `medium`, every booking in the corpus came back with the same dates, times, references, places and countries as today, from text, screenshots and PDFs alike.
- **Speed and cost.** An import finishes in about half the time (about 5 s against 10 s). It costs about 14% less, or about the same for a screenshot.
- **The flight-number shortfall is the field's format, not its content.** Both models read the designator correctly. Sonnet 4.6 always writes the airline code into the number (`carrierCode "KE"`, `flightNumber "KE012"`). Sonnet 5.5 does that about half the time and otherwise writes `"012"`.
- **Trippy's own code expects `"012"`.** Every stored flight is `SQ` + `842`. The booking card renders `${carrierCode} ${flightNumber}`. The live-status lookup refuses `"KE012"` and `"KE 012"` with a 400.
- **So on today's model, every imported flight would read "KE KE012" and fail its status check.** Sonnet 5.5 would fix about half of them by accident.
- **The fare-promo shortfall is a prompt ambiguity both models share.** Rule 6 puts "or contains no extractable booking" in parentheses. Both models answer "travel-related, no bookings", and the review screen then says "We couldn't find any bookings in that." instead of "This doesn't look like travel." Nothing is fabricated either way.

**Facts corrected or learned:**
- **W0's "151/151 critical fields" counted every labelled field.** §5.3's critical set is dates, times, refs, type, origin/destination, city and countryCode: 139 of those 151. The other 12 are flight and train numbers and `localName`. The scorer now reports the two separately, and adds the flight-number usability check against the real `lookups.normalizeFlightQuery`.
- **The W0 `flightNumber` labels follow Sonnet 4.6's form**, which Trippy's lookup rejects. This looks like a pre-existing production defect on any imported flight: card text plus a failing status pill. Whether any of production's 3 artifacts was a flight was not checked. The robust fix is deterministic and model-agnostic, in `importer.js` `normalizeExtractedBooking`: strip a leading carrier code and spaces from `flightNumber`. It is outside W4's files and not done here.
- **Thinking is rare at `medium` on this workload** (2 of 23 responses, ≤ 475 tokens). The +12% median output is mostly the tokenizer (+23% on the same JSON) offset by terser text. `low` is statistically indistinguishable on this corpus.
- **The F-30-14 high-resolution image estimate holds within 3%.**
- **Sonnet 5.5 can return a thinking-only message when the allowance is tight.** That argues against setting the allowance by the 2× rule alone (below).

**Allowance, if switched (D-30-6).** The observed maximum is 2,370 tokens including thinking, so 2× would give about 4,800. **Recommend 16,000** (≤ 21,333, F-30-6), and say so in the code comment, for three reasons:
- The corpus's largest input holds 3 bookings, while a real multi-page PDF itinerary is unmeasured.
- A tight allowance can be spent entirely on thinking.
- `max_tokens` is a ceiling, not a spend; Sonnet 4.6 ran at 8,192, about 4× its own maximum.

**Spend.** Anthropic **$1.27**: control $0.365, primary $0.312, `low` $0.305, `high` $0.264, forced cut-off $0.021. `count_tokens` calls are free.

**Unresolved limitations.**
- **No owner inputs.** The image and PDF results are **provisional**. The screenshots are clean renders, not photos, compressed captures or cluttered real apps; the PDFs are single-page; n = 23 is too small for percentile claims.
- Steps 3–4 (switch, re-pin, browser pass at 375 px and desktop, `LIVE_ANTHROPIC=1`) wait on the ruling.

**Needs the owner — one ruling.** Do you accept the two shortfalls and switch extraction to Sonnet 5.5 at `medium`, 16,000? The two are:
- the `flightNumber` format, where today's model is worse;
- the fare-promo `isTravelRelated`, which is identical on today's model.

Recommended: **yes**, with the flight-number normalisation fixed as its own small change. That fix also repairs today's Sonnet 4.6 imports. If yes, the switch is mechanical:
- a `'claude-sonnet-5-5'` extraction row `{ maxTokens: 16000, effort: 'medium' }`;
- `EXTRACTION_MODEL` flipped, keeping the Plan 2A D3 comment;
- the extraction sha256 pin re-captured;
- a rollback pin proving Sonnet 4.6's row still sends `eb6fafb2…`;
- then the browser pass and the live smoke.

**Rollback:** nothing to roll back; no production constant changed.

**Files (this pass).** In `backend/scripts/modelEval/`:
- New: `renderExtractionFixtures.mjs`, `imageTokens.mjs`, `fixtures/extraction/{img,pdf}-*.json` with `fixtures/extraction/files/*`.
- Changed: `extraction.mjs` (committed fixtures may name a file by `path`), `lib/score/extraction.mjs`, `profiles.mjs` (`forced-cutoff`), `README.md`.

#### W4 switch — owner-accepted, extraction on Sonnet 5.5

**Status:** 2026-10-19 — **COMPLETE; not deployed.** It ships with Deploy B (§7).

**Owner ruling, recorded as §5.3 requires.** The owner "accept[s] the flightNumber format and fare-promo isTravelRelated shortfalls for Plan 30 W4" and switched extraction to Sonnet 5.5 at effort `medium`, 16,000. These are the only loosenings; every other §5.3 criterion passed as measured above.

The flight-number normalisation is being fixed separately and model-agnostically in `importer.js` (a sibling session started 2026-10-19), not here.

**What changed.**
- **`claude.js`:**
  - `EXTRACTION_MODEL = 'claude-sonnet-5-5'`.
  - The Plan 2A D3 comment is kept and extended: the tier ruling stands, only the version moved.
  - A new `MODEL_PROFILES['claude-sonnet-5-5'].extraction` of `{ maxTokens: 16000, effort: 'medium' }`, with no `thinking` field, so adaptive thinking stays on. Its comment records why the allowance is above D-30-6's 2× rule: no multi-page itinerary was measured, a tight allowance produced a thinking-only reply, and F-30-6 caps a non-streaming call at 21,333.
  - Sonnet 4.6's row stays as the rollback row; it is still live for the co-pilot.
- **`claude.test.js`:**
  - The extraction request-body pin is re-captured: **`57a2bedd…73bf`**. The body's structure is asserted first: keys `model, max_tokens, output_config, system, messages`, `max_tokens` 16,000, `output_config: {effort:'medium'}`, no `thinking`.
  - A new rollback pin proves Sonnet 4.6's row still sends the exact W0 body, `eb6fafb2…`, unchanged.
  - Profile tests: the live extraction profile, Sonnet 4.6's row kept, and the allowance ≤ 21,333. The co-pilot assertions are unchanged.
- **Harness:** `profiles.mjs` `control` is now the live Sonnet 5.5 profile, and `assertControlIsLive` passes. `baseline-46` is the Sonnet 4.6 control; its run files moved to `runs/extraction/baseline-46/` (gitignored).
- **Not changed:** the prompt, the confirmation step, artifact retention, `importer.js`.

**Checks.**
- `cd backend; npm test`: 45 files passed (1 skipped), **1,057 passed**, 6 skipped (the live suite). `claude.test.js`: 143/143.
- `LIVE_ANTHROPIC=1 npx vitest run tests/live`: **6/6** on Sonnet 5.5. The extraction raw and `extractBookings` shapes both ran.
- **Browser pass**: Playwright, dev servers from `launch.json`, the W3 verify trip, a minted dev session that was deleted afterwards. No booking was confirmed, so the trip is unchanged.

| # | Viewport | Input | Result |
|---|---|---|---|
| 1 | 375 × 812 | Pasted SQ 322 confirmation | Review in ~5 s. Flight, Fri 12 Mar → Sat 13 Mar, SIN → LHR, `9RB4TX`. `import_artifacts.model = claude-sonnet-5-5`. |
| 2 | 375 × 812 | Phone screenshot (`img-cjk-high-speed-train.png`, 1170×2532) | Review in 5.9 s. G8501, Chengdu East → Chongqing West, Mon 3 May, `EA71234567`. |
| 3 | 375 × 812 | PDF (`pdf-round-trip-single-email.pdf`) | Review in 7.5 s. 2 of 2 KLM legs, `PX2K6C`. |
| 4 | 375 × 812 | Non-travel paste (an office meeting note) | "This doesn't look like travel." in 1.3 s. |
| 5 | 375 × 812 | Forced cut-off | The real Sonnet 5.5 `max_tokens` error from the harness (`forced-cutoff`) was replayed through a Playwright route, with no server call. The panel shows *"The booking reader's output was cut off — try fewer pages or split the file."* inline under the inputs. |
| 6 | 1280 × 860 | Phone screenshot (`img-cjk-ryokan-japan.png`) | Review in 5.6 s. 旅館 山水荘 (Ryokan Sansuiso), 8–10 Nov, `KY-88213`, the country inferred from the Kyoto address, and the "Extend trip" prompt. |

**Observed during the pass, not caused by W4:**
- The first PDF attempt got a 500. `node --watch` restarted the dev backend mid-request, because another session was editing files in this shared checkout. The retry succeeded.
- **That interrupted request left its `import_artifacts` row at `extracting` permanently** (`0a276ba6…`, dev DB). A process restart during an extraction, such as a deploy, would do the same in production. It is pre-existing and noted for a later look.
- Sonnet 5.5 did not write the flight number as `SQ322` consistently. Test 1 produced the doubled form, as the sweep predicted; the importer fix covers it.
- One assumption line named a schema field ("noted in details.note"). Across the sweep this is 0 of 45 assumptions on 5.5 against 1 of 50 on 4.6, so it is not a regression.

**Spend.** ≈ $0.07 for the browser pass and the live smoke. The W4 total is about **$1.34**.

**Not done here.**
- `docs/ENGINEERING.md` ("Booking extraction and the co-pilot use Sonnet 4.6 unless …") becomes false when Deploy B ships. Correct it at Deploy B, as W3 did at Deploy A.
- W6 owns the `docs/DECISIONS.md` rows.

**Rollback:** set `EXTRACTION_MODEL` back to `'claude-sonnet-4-6'`. That one line restores `{ maxTokens: 8192 }` with no effort and no thinking. The rollback test pins the resulting body to the W0 hash `eb6fafb2…`, so the main extraction pin must be flipped back to that literal too.

**Steps.** Sweep per §5.2 on the labelled corpus (Q-30-4); pick the profile (candidate: effort `medium`, 16,000); set `EXTRACTION_MODEL`; keep the Plan 2A D3 comment (the ruling is *Sonnet-tier, not Haiku* and still holds; only the version string changes); the import flow's confirmation step and artifact retention are untouched; local browser pass at 375 px and desktop: paste text, upload a screenshot, upload a PDF, and a non-travel input — confirm the new specific error copy for a forced `max_tokens` case (lower the allowance temporarily in the harness, never in code).

**Gate.** §5.3 extraction. **Rollback:** revert the constant.

### W5 — Co-pilot → Sonnet 5.5

**Status:** 2026-10-19 — **COMPLETE (owner-ruled D-30-9); not deployed (Deploy B).** `COPILOT_MODEL = 'claude-sonnet-5-5'`, profile `{ maxTokens: 16000, effort: 'low' }`, under the explain-after-proposal protocol. Details are under *W5 switch* below; the E-COP-1 record and the remedy measurements that led to the ruling follow unchanged. **E-COP-1 record (same day, earlier):** STOPPED AT E-COP-1; nothing switched; Q-30-3 put to the owner. At that point `COPILOT_MODEL` was still `claude-sonnet-4-6`; `claude.js`, `claude.test.js` and every frontend file were untouched, so the W0 co-pilot sha256 pin still held. On the primary candidate the explanation the prompt asks for reached the panel on **4 of 10** proposing turns (control 10/10). That is the material loss §6 W5 says to stop on, so the §5.3 sweep was not completed as a gate; the same 20 scenarios were instead run under the three Q-30-3 remedies, harness-only, and the numbers are below. Run files: `data/model-eval/runs/copilot/<profile>/2026-10-18T17-*.jsonl` (harness UTC stamps); the control is the W0 Sonnet 4.6 run.

#### E-COP-1 — primary candidate (Sonnet 5.5, adaptive effort `low`, 16,000/iter, prompt frozen)

| Measure | Control: Sonnet 4.6 | Primary |
|---|---|---|
| Explanation reached the stream as text before the `proposal` event | 10/10 | **4/10** |
| A `text` block precedes the `propose_itinerary_changes` tool_use in the raw content | 10/10 | **4/10** |
| Turns with a thinking block (any iteration) | 0/20 | 6/20 |
| Thinking tokens (exact, `usage.output_tokens_details.thinking_tokens`): median / max, share of output | 0 | 0 / 1,258 (28%) |

**Which turns, and what came back instead.** The split is exact. Every single-iteration edit kept its prose: `remove-pottery`, `move-lingyin`, `update-palace-museum`, `stale-apply-handoff` (`text > tool_use:propose`, 119–293 chars). Every search-then-propose turn lost it, 6 of 6: `grounded-add-local-dinner`, `grounded-add-nature-category`, `grounded-add-night-market`, `multi-search-near-cap`, `timing-fit-in-museum`, `mixed-language-night-market`. On five of those the terminal call is `thinking(empty) > thinking(empty) > tool_use:propose` — a reasoning block and then the progress-update block F-30-9 describes, both empty under the default display — and on `grounded-add-night-market` it is `tool_use:propose` alone, no note of any kind. The SSE for those six turns is `tool started/done`, pings, `proposal`, `done`: the traveller gets a change preview with not one word above it, in English or (the mixed-language scenario) Chinese. The same turns also lost the one-line remark Sonnet 4.6 wrote before calling the search, so their first visible event is the tool badge.

**In product terms.** On today's model, every "pick one and add it" request comes back as a short explanation of the pick followed by the preview card. On Sonnet 5.5 at `low` with the prompt as written, 6 of the 10 proposing scenarios — and all 6 that involve a catalogue search, which is the main way a traveller asks for something new — come back as a bare card. The persisted history loses the explanation too (only `text` is saved), so a reload shows the same bare card. Direct edits (remove, move, retime, note) are unaffected.

**Everything else on the primary passed or improved.** Tool sequence 20/20; proposes as expected 20/20; real ids 10/10; server validation 10/10; booking-linked targets 0; every `add_stop` grounded with a `placeId` from that turn's results 10/10; `catalogueState` relayed 6/6; out-of-scope declined warmly, generation-capped relayed honestly, both booking refusals redirected to Logistics (read from `fullText`); truncations 0/20; silent turns 0/20; every text-less turn carries a notice 19/19; query cap 1/20 as on control; ping spacing ≤ 8,011 ms on every turn over 10 s (control's 12,941 ms gap is the W0 run, which predates W1's ping); within-turn cache reads on iterations 2+ median 6,411 (control 5,070; same system block, 5.5 tokenizer); cost per turn median $0.0064 / mean $0.0100 against $0.0098 / $0.0124 (−35% / −19%); turn total median 4.1 s against 6.7 s. **One §5.3 line fails as a consequence of E-COP-1:** TTFD max is 9,551 ms (gate ≤ 8 s) because on search turns the first text now arrives after the tool result (median 1,028 ms is inside the gate).

#### Q-30-3 remedies, measured on the same 20 scenarios (harness-only; `claude.js` unchanged)

Profiles in `profiles.mjs`: `alt-updates-low` (a), `alt-between-tools` (b), `v-reply-text-low` and `v-reply-text-short-low` (c), plus `alt-medium` from the §4 sweep. `lib/copilotPromptVariants.mjs` applies the prompt variants and the beta header on the wire, after the recorder, so the run files store what was sent.

| Measure | Control 4.6 | Primary `low` | `medium` | **(a)** `low` + `display: updates` + beta header | **(b)** `between_tools` at `medium` | **(c1)** prompt `reply-text`, `low` | **(c2)** prompt `reply-text-short`, `low` |
|---|---|---|---|---|---|---|---|
| Text before the proposal event (SSE) | 10/10 | 4/10 | 4/10 | 4/10 | **10/10** | 5/10 | 4/10 |
| `text` block before the propose tool_use | 10/10 | 4/10 | 4/10 | 4/10 | 5/10 | 5/10 | 4/10 |
| Non-empty progress-update text right before the propose tool_use | 0/10 | 0/10 | 0/10 | **4/10** | **5/10** | 0/10 | 0/10 |
| Explanation available either way (text, or an update that could be shown) | 10/10 | 4/10 | 4/10 | **8/10** | **10/10** | 5/10 | 4/10 |
| Real ids / server validation | 10/10 | 10/10 | **9/10** | 10/10 | 10/10 | 10/10 | 10/10 |
| Tool sequence as expected | 20/20 | 20/20 | 20/20 | 19/20 | 20/20 | 20/20 | 20/20 |
| TTFD median / max (n with any text) | 962 / 4,347 (20) | 1,028 / 9,551 (14) | 1,148 / 8,803 (14) | 1,157 / 7,241 (14) | **1,267 / 2,177 (20)** | 1,059 / 7,314 (15) | 1,624 / 7,590 (14) |
| Time to first visible output incl. update text, median / max (n) | 962 / 4,347 (20) | same | same | 1,582 / 13,830 (18) | 1,267 / 2,177 (20) | same | same |
| Turns with a thinking block / with non-empty thinking text | 0 / 0 | 6 / 0 | 6 / 0 | 6 / 4 | 5 / 5 | 5 / 0 | 5 / 0 |
| Thinking tokens max (share of output) | 0 | 1,258 (28%) | 1,300 (26%) | 1,125 (28%) | 663 (15%) | 1,218 (26%) | 1,051 (23%) |
| Max SSE gap on turns > 10 s | 12,941 (pre-ping) | 8,003 | 8,011 | 6,750 | 5,949 | 7,906 | 6,515 |
| Cost per turn median / mean | $0.0098 / $0.0124 | $0.0064 / $0.0100 | $0.0052 / $0.0095 | $0.0053 / $0.0089 | $0.0079 / $0.0109 | $0.0064 / $0.0099 | $0.0063 / $0.0096 |
| Run total | $0.247 | $0.201 | $0.189 | $0.177 | $0.218 | $0.198 | $0.191 |

Grounding, booking-linked targets (0), `catalogueState` relay (6/6), truncations (0), silent turns (0) and notices (19/19) were identical on every column.

**What each remedy actually does, read from the recordings:**
- **(a) `display: "updates"`.** The progress-update block before the propose call now carries text on 4 of the 6 affected turns, and it reads as a reply to the traveller, e.g. *"I've chosen Jia Shanghai Restaurant for your second night's dinner—a mid-range local spot known for classic Shanghainese dishes … Since it closes at 21:00, I'll plan for an earlier dinner, which fits well after your Yu Garden visit"* and *"Adding Lingyin Forest Nature Reserve, the protected forest right behind Lingyin Temple—a quiet, low-detour option (2–3 hrs) that fits well before your evening flight …"*. The other 2 (`grounded-add-night-market`, `mixed-language-night-market`) went search → propose with no note at all, so **2 of 10 proposing turns would still be a bare card.** The update is written after the hidden reasoning, just before the tool call, so it does not help time-to-first-visible (max 13.8 s on the eight-search turn). It needs the beta header `thinking-display-updates-2026-08-18` on every request. In one run the day-scoped audit called `check_trip_health` twice (19/20).
- **(b) `between_tools` at `medium`.** No hidden reasoning: the only thinking blocks are the progress updates, and they carry their text with no header. The model writes a one-line remark before every search (*"Let me look through the catalogue for nature spots in Hangzhou."*), so every turn has text within 2.2 s. The pick's explanation then comes as `text` on 5 of 10 proposing turns (*"Raohe Street Night Market is the one …"*, 222 chars) and as a progress update on the other 5 (*"I'll go with Nine Streams and Eighteen Gullies as the best fit—a quiet, shaded ravine walk that offers a genuine break without overlapping other stops. I'll slot it between Lingyin Temple and the Longjing tea village …"*; the Chinese scenario's update is in Chinese). **Without forwarding the update, the traveller sees a one-liner and a card on those 5; with forwarding, 10/10.** Thinking tokens are the update text itself (max 663, 15% of output). Cost is 19% under control per turn, the highest of the 5.5 columns.
- **(c) prompt-only.** Neither rewording of the "explain your reasoning" line moved the search turns at `low` (5/10 and 4/10). The direct edits kept their prose under both; one variant lost `stale-apply-handoff`'s text while gaining `mixed-language-night-market`'s. The guidance's rule — notes longer than a sentence or two before a tool call become progress-update blocks — holds whatever the line says, so a prompt-only fix is not available at `low`.
- **`medium` (adaptive)** is not a candidate: the same 4/10, plus one invented `stopId` in a `move_stop` (`grounded-add-nature-category`), the first ID defect in any co-pilot run.

**What (a) and (b) both need in production, and (c) would have avoided:** a Plan 11 contract change. `streamCopilotResponse` forwards only `text` deltas and persists only `fullText`; a progress update is a `thinking` block, so it would have to be forwarded as a distinct SSE event (a model-written summary, shown as a visibly different line, not as the reply), replayed unchanged in the next iteration (already done), and **persisted** so a reload does not lose it again — `copilot_messages.content` holds text only, so that is a storage decision (inline marker or a column, which would be migration 037, the number Plan 32 is also counting on). `useCopilot.js` and `CopilotPanel.jsx` would render the new line. Plan 32 edits the same four files (§7), so the two must be sequenced, not run side by side.

**Needs the owner — one ruling (Q-30-3).** Which remedy, if any, should W5 implement before the §5.3 sweep is completed on it?
- **(a)** adaptive `low` + `display: "updates"` + beta header + forward-and-persist the update line: explanation on 8/10, bare card on 2/10, cheapest per turn ($0.0053 median), hidden reasoning stays.
- **(b)** `between_tools` at `medium` + forward-and-persist the update line: explanation on 10/10 (5 as prose, 5 as the update line), a remark before every search within 2.2 s, no beta header, no hidden reasoning, $0.0079 median (still −19% vs control).
- **(b-lite)** `between_tools` at `medium` with **no** protocol change: 10/10 turns show text, but on the 5 update turns that text is only the one-line remark and the pick's reasoning is not shown — closest to today's behaviour without touching Plan 11 contracts, and honest only if the owner accepts that gap.
- **Stay on Sonnet 4.6** for the co-pilot (its retirement floor is 2027-02-17, F-30-13) and ship Deploy B without W5.
The earlier Q-30-3 option (c) in §3 — writing the explanation *after* the tool call — is a protocol change out of this plan and was not measured.

**Spend.** Anthropic **$1.18** for the six 20-scenario runs (primary $0.201, `medium` $0.189, (a) $0.177, (b) $0.218, (c1) $0.198, (c2) $0.191). D-30-7 counts were unchanged for the copy and the owner DB on every run (the owner's dev catalogue now reads 2,341 places / 14 destinations / 3,072 verification attempts; the W0 table's absolutes are no longer current).

**Facts corrected or learned.**
- Sonnet 5.5 reports exact thinking tokens in `usage.output_tokens_details.thinking_tokens` on every response; the scorer now uses it when present and estimates only for Sonnet 4.6. The W3/W4 estimate method is still what those waves' tables rest on.
- The co-pilot's silent interval is real on 5.5: between the last search result and the proposal the stream carried nothing but pings for up to 9 s (`multi-search-near-cap`, 1,258 thinking tokens). D-30-4's ping is what kept those turns under Cloudflare's timer.
- The system block costs 6,411 cache-read tokens on 5.5 against 5,070 on 4.6 (+26%, the new tokenizer); at $0.10/MTok that is immaterial.
- §5.3's TTFD line and E-COP-1 are the same defect seen twice: the text that used to arrive before the search is the text that now does not arrive.

**Files (this pass).** `backend/scripts/modelEval/profiles.mjs` (five co-pilot profiles; `betas` is a harness-only key), `copilot.mjs` (installs the request patch after the recorder; records `promptVariant`/`betas`), `lib/copilotPromptVariants.mjs` (new), `lib/score/copilot.mjs` (keep-alive gap, exact/estimated thinking tokens, notice-on-text-less, progress-update and time-to-first-visible rows, `blocks` column), `README.md`, this plan.

**Rollback (E-COP-1 record):** nothing to roll back at that point; no production constant changed.

#### W5 switch — owner-ruled D-30-9, co-pilot on Sonnet 5.5

**Status:** 2026-10-19 — **COMPLETE; not deployed.** It ships with Deploy B (§7).

**Owner ruling, recorded as §3 and §5.3 require (quoted):** "Approved: change the protocol so the proposal tool call no longer ends the turn; the model explains afterwards as final text with tools disabled for that step, adaptive thinking stays on at low effort, measured on both models through the 20 scenarios. Record it as a Plan 11 amendment." Remedies (a), (b) and (b-lite) were rejected: they protect a display artefact by forwarding an API summary channel as the reply and couple the product to one model's thinking-display semantics. This is **D-30-9** (§3; `docs/DECISIONS.md`); it answers Q-30-3.

**What changed.**
- **`claude.js` — the loop (D-30-9).** When a response carries `propose_itinerary_changes`, the loop no longer breaks. It appends the assistant content unchanged (thinking blocks included) and one user turn holding exactly one `tool_result` for that call, `{"status":"received","operationCount":N}` — a neutral acknowledgement that promises nothing about validity or persistence — then runs one more `messages.stream` with the same settings, system block and `tools` array plus `tool_choice: {type:'none'}`, and breaks after it unconditionally. Query tool_use blocks beside a propose call are still ignored (Plan 11 Wave 1 "terminal wins"); every other iteration sends no `tool_choice` key. The explanation streams through the existing `text` path and is persisted as `fullText` by the unchanged `persistTurn`; the `proposal` event still follows the loop, so the panel order is explanation → card with **no frontend change**. A cut or refusal *on the explain step* adds the existing notice and still emits the proposal (its operations arrived complete); a cut *before* the proposal still discards it (Plan 11 D5). A client abort between the two steps takes the existing `client_abort` path (`stopped` row, operations null). `iterations` counts the explain step. Marker `D-30-9` at the loop change, citing the Plan 11 Wave 1 rule it amends.
- **Prompt.** One bullet under *How to propose changes* changed, shared by both models: *"Call the tool first. Once Trippy has acknowledged the call, explain the proposed changes to the traveller in prose: what changes and why, in your own words. If you are not proposing changes, do not call the tool."* The "never write changes as prose" rule and the real-id rule are byte-identical. Sonnet 4.6 did not regress under the shared prompt (table below), so the line is not keyed by model.
- **Settings.** `MODEL_PROFILES['claude-sonnet-5-5'].copilot = { maxTokens: 16000, effort: 'low' }` (no `thinking` field: adaptive stays on) and `COPILOT_MODEL = 'claude-sonnet-5-5'`. Sonnet 4.6's row stays as the rollback row for extraction and the co-pilot. `reportTurnMetrics` keeps writing the configured model string; new rows read `claude-sonnet-5-5` (seen in the dev `copilot_turn_metrics` during the browser pass), old rows are history.
- **`claude.test.js`.** Co-pilot request-body pin re-captured twice, deliberately and structure-first: `739c12cf…c4c` for Sonnet 4.6 under the new prompt (now the **rollback pin**, asserted by passing the 4.6 row explicitly) and **`3a751ac7…c712`** for the live Sonnet 5.5 body (`model`, `max_tokens` 16000, `output_config: {effort:'low'}`, no `thinking`, no `tool_choice`). New prompt-text pin on `system[0].text` with an empty itinerary: `80142664…d365`. Fourteen new tests cover the acknowledgement round trip (content replayed unchanged, one `tool_result`, the right id, `tool_choice` only on the explain call, identical `tools`/`system`), the SSE order, one `persistTurn` with the explanation and operations, metrics `iterations`, a query tool beside the propose call not executed, cut/refusal on the explain step, abort between the steps, an explain step with no text (proposal emitted, no `empty` notice — documented current behaviour), malformed operations (`operationCount` 0), and exactly one explain step per turn. Extraction, descriptor and discovery pins untouched.
- **`docs/DECISIONS.md`:** one row for D-30-9. **Harness:** `scenarios.json` expects `proposal_acknowledged` after `propose_itinerary_changes` on the 10 proposing scenarios (the scorer derives it from the recorded calls: `tool_choice: none` plus a `tool_result` for the propose id in the preceding assistant turn, and checks the acknowledgement is well-formed); the scorer's E-COP-1 raw measure is now "explanation text block in the explain step", the old reading stays as an informational row, and five explain-step cost rows were added. The two rejected prompt variants' code is removed (run files stay as history); `lib/copilotRequestPatch.mjs` keeps only the beta-header patch for the historical `alt-updates-low` profile. `profiles.mjs` `control` is the live Sonnet 5.5 profile; `baseline-46` is Sonnet 4.6.

**E-COP-1 under D-30-9 — both models, same 20 scenarios, prompt shared** (run files `runs/copilot/{control,primary,alt-medium}/2026-10-18T17-3*.jsonl`; D-30-7 counts unchanged on all three):

| Measure | Sonnet 4.6, 8,192 (D-30-9) | **Sonnet 5.5 `low`, 16,000 (D-30-9)** | Sonnet 5.5 `medium` (D-30-9) |
|---|---|---|---|
| Explanation reached the stream as text before the `proposal` event | **10/10** | **10/10** | 10/10 |
| Explanation `text` block in the explain step (final call, `tool_choice: none`) | **10/10** | **10/10** | 10/10 |
| Acknowledgement step present and well-formed | 10/10 | 10/10 | 10/10 |
| Pre-tool `text` block before the propose call (informational) | 7/10 | 0/10 | 0/10 |
| Raw block sequences, proposing turns | `[text>]tool_use ‖ text` | `[thinking>]tool_use ‖ text` (5 of 10 with an empty reasoning block before the propose call; never before the explanation) | same shape |

On Sonnet 5.5 the explanation is written entirely in the explain step and reads as a reply (*"I've added Jia Shanghai Restaurant to the end of day 2 (11 April) as your dinner. I left it untimed … I chose it because you asked for a proper sit-down local dinner …"*; the Chinese scenario answers in Chinese). On Sonnet 4.6 the explanation is duplicated on 7 of 10 turns: a pre-tool sentence or two as before, then the post-acknowledgement text.

**§5.3 sweep** (n = 20; the old-protocol W0 control is kept as the cost/latency reference):

| Metric | W0 control: 4.6, old protocol | 4.6, D-30-9 | **5.5 `low`, D-30-9** | 5.5 `medium`, D-30-9 |
|---|---|---|---|---|
| Tool sequence / proposes as expected | 20/20 · 20/20 | 20/20 · 20/20 | **20/20 · 20/20** | 20/20 · 20/20 |
| Real ids · server validation | 10/10 · 10/10 | 10/10 · **9/10** (an `add_stop` with stop type `"nature"`) | **10/10 · 10/10** | 10/10 · 10/10 |
| Booking-linked targets · adds grounded with a `placeId` from that turn · clock time invented | 0 · 10/10 · 0 | 0 · 10/10 · 0 | **0 · 10/10 · 0** | 0 · 10/10 · 0 |
| `catalogueState` relayed · out-of-scope declined · capped relayed honestly (read) | 6/6 · yes · yes | 6/6 · yes · yes | **6/6 · yes · yes** | 6/6 · yes · yes |
| Query cap hit (expected 1) · hard stop | 1/20 · never | 1/20 · never | **1/20 · never** | 1/20 · never |
| TTFD median / max (n with text) | 962 / 4,347 (20) | 1,157 / 5,752 (20) | **4,345 / 17,272 (20)** | 4,948 / 19,856 (20) |
| Max SSE gap on turns > 10 s (ping ≤ 10 s) | 12,941 (pre-W1 run, no ping) | 8,013 (n=8) | **8,002 (n=2)** | 8,009 (n=2) |
| Truncations · silent turns · text-less turns without a notice | 0 · 0 · 0/19 | 0 · 0 · 0/19 | **0 · 0 · 0/19** | 0 · 0 · 0/19 |
| Cache read on iterations 2+ (median) | 5,070 (n=9) | 5,090 (n=14) | **6,439 (n=14)** | 6,439 (n=14) |
| Explain step: wall ms median / max · output tokens median / max · cache read · uncached input | — | 4,901 / 12,256 · 162 / 441 · 5,090 · 1,576 | **2,847 / 4,716 · 255 / 542 · 6,439 · 905** | 3,158 / 4,670 · 292 / 498 · 6,439 · 918 |
| Thinking: turns with a block · tokens max (share), exact from `output_tokens_details` | 0 · 0 | 0 · 0 | **6/20 · 820 (12%)** | 6/20 · 1,176 (17%) |
| Turn total median / max | 6.7 / 30.0 s | 8.5 / 39.9 s | **5.0 / 17.3 s** | 5.0 / 19.9 s |
| Cost per turn median / mean | $0.0098 / $0.0124 | $0.0163 / $0.0190 | **$0.0093 / $0.0137** | $0.0059 / $0.0128 |
| Run total | $0.247 | $0.380 | **$0.273** | $0.256 |

**Gate (§5.3), primary 5.5 `low`:**

| Criterion | Result |
|---|---|
| E-COP-1 100% | **pass** (10/10, both measures) |
| Grounding: 0 named places outside results; out-of-scope declined; states relayed | **pass** |
| Tool/ID correctness; validation on every proposing turn; booking-linked never targeted | **pass** (10/10, 10/10, 0) |
| Query cap respected; hard stop never on well-formed scenarios | **pass** |
| TTFD median ≤ 2.5 s and max ≤ 8 s | **fails as written: 4.3 s / 17.3 s.** Owner reading, applied here: under D-30-9 the explanation is by construction the *last* thing in a turn, so the first text arrives after the tool call(s); on search turns the first visible output is the tool badge, which the July 2026 ruling made the progress affordance. Reported, not loosened by this session — see *Unresolved limitations* for the one case the reading does not cover. |
| Keep-alive ≤ 10 s on every turn > 10 s | **pass** (8,002 ms) |
| Truncations 0; silent turns 0; every text-less turn carries a notice | **pass** |
| Within-turn cache reads ≥ control on multi-iteration turns | **pass** (6,439 vs 5,070 / 5,090; the explain step reads the full system block, so `tool_choice` did not break the prefix) |
| Cost per turn vs control | median $0.0093 vs $0.0098 (−5%), mean $0.0137 vs $0.0124 (+10%); the explain step costs about $0.005 per proposing turn and adds 2.8 s median / 4.7 s max |

`medium` is the measured alternative, not chosen: the same 10/10 with more thinking (1,176 max) and a 4.9 s TTFD median; in the earlier old-protocol run it invented a `stopId` once (9/10 ids), which `low` never did across four runs.

**Allowance (D-30-6).** Largest single iteration on Sonnet 5.5 across every W5 run: 1,764 output tokens thinking included (the eight-search proposal step; 1,258 thinking); largest explain step 542. 16,000 is far above 2× on purpose: adaptive thinking at `low` varied from 820 to 1,258 tokens on the same scenario between runs, a tight allowance can be spent entirely on thinking and return no text (W4's 300-token run), the call is streamed so F-30-6's 21,333 cap does not apply, and the allowance is a ceiling, not a spend.

**Checks.**
- `cd backend; npm test`: 45 files passed (1 skipped), **1,083 passed**, 6 skipped (the live suite); `claude.test.js` 160/160. No timeout this time.
- `LIVE_ANTHROPIC=1 npx vitest run tests/live`: **6/6** on the switched profiles (10.9 s).
- No frontend file changed, so no frontend suite or build was run.
- **Browser pass** (built-in browser pane, dev servers from `launch.json`, dev DB, a 1-day session minted through a one-shot login page and deleted afterwards; `node --watch` had reloaded the switched `claude.js`). Verify trip "Shanghai - Hangzhou (W3 verify)", nothing applied there; the apply ran on a throwaway trip created and deleted in the pass. Every turn wrote a `copilot_turn_metrics` row with `model = claude-sonnet-5-5`.

| # | Viewport | Turn | Result |
|---|---|---|---|
| 1 | 375 × 812 | Plain question (flight time, rest of day 1) | 1 iteration, first text 1.2 s, 968 chars; it noticed the dinner stop's note says closed on Sundays. |
| 2 | 375 | Whole-trip audit | `check_trip_health` badge, then 1,910 chars leading with the 14:00-free arrival-day overload and an Okinawa placeholder day. 7.0 s total. |
| 3 | 375 | Retime the booking-linked SQ 832 | No proposal; redirected to Logistics with the knock-on effects. 2.9 s. |
| 4 | 375 | Move the Tower to day 2 (proposal, **rejected**) | 2 iterations; 571 chars of explanation streamed **before** the `proposal` event; card below it with Apply/Reject; metrics `iterations 2`, `cache_read 11,344` (both steps read the block), `proposal_ops 1`; rejected → DISMISSED. |
| 5 | 375 | Stop before any text | Notice-only row *"This reply was stopped."*, metrics `client_abort`, `error 0`. |
| 6 | 375 | Stop after the first text | 166-char partial saved as `stopped`; metrics `client_abort`, `error 0`, input 9,032, cache read 5,672. |
| 7 | 375 | Long walkthrough, let run | 15.1 s, 2,062 output tokens, 5,178 chars; one ping interleaved at 6.9 s after the first chunk, max silent gap 350 ms. |
| 8 | 375 | QA trip: grounded dinner add → **applied** | search (Shanghai fresh) → 1,018 chars of explanation → card → Apply. The stop landed on day 1 with `provider_id google:…`, WGS-84 coordinates from the catalogue place, a photo and attribution. 3 iterations, TTFD 7.1 s, cache read on all three steps. |
| 9 | 1280 × 860 | QA trip: move that dinner to day 2 (proposal, rejected) | 532 chars of explanation above the card at desktop width; rejected; trip deleted. |

**Spend.** Anthropic ≈ **$2.33** for W5 in all: E-COP-1 and remedies $1.18 (recorded above), the three D-30-9 runs $0.91 (4.6 $0.380, 5.5 `low` $0.273, `medium` $0.256), the browser pass ≈ $0.21 (seven turns on the verify trip $0.19 plus two on the deleted QA trip), the live smoke ≈ $0.03.

**Facts corrected or learned.**
- The shared prompt works on both models under D-30-9, so no model-keyed co-pilot prompt was needed. Sonnet 4.6's one validation miss (`"nature"` as a stop type) is the first in any co-pilot run; one sample, not investigated further since 4.6 is now the rollback row.
- The explain step reads the whole cached system block on every call (6,439 tokens on 5.5): adding `tool_choice` on the last iteration did not touch the prefix.
- Sonnet 5.5 never writes text before the propose call under the new prompt (0/10); Sonnet 4.6 still does on 7/10, so a 4.6 rollback shows a short lead-in plus the explanation.
- Loading a trip page in the browser pass fired the plan tab's discovery pre-warm for a stale Shanghai catalogue (`generation_count` 3 → 4 in the dev DB). Normal product behaviour, not W5; the harness runs keep D-30-7 by design and all three stayed unchanged.
- The pane's `fetch` resolves on the first body chunk, so in-page SSE timestamps are relative to the first chunk; absolute TTFD comes from `copilot_turn_metrics`, as W1 found.

**Unresolved limitations.**
- **Direct edits have no progress affordance for the first 2–4 s.** On a remove/move/retime the model now calls the tool immediately and the explanation follows the acknowledgement, so the first text arrives at 3.0–5.0 s (Sonnet 4.6 old protocol: ~0.7–1.1 s). The proposal tool emits no `tool` event, so the panel shows nothing in that window — the owner's tool-badge reading covers search and audit turns, not this case. A one-line follow-up (emit `{type:'tool', tool:'propose_itinerary_changes', state:'started'}` and a "Drafting the change…" label) would close it; not done here because it touches the frontend and the ruling's scope. **Resolved 2026-10-19 (D-30-9 follow-up, branch `plan30-w5-propose-badge`, not deployed):** the proposal now reports as a tool — `started` when its `tool_use` block opens (falling back to the end of that response), `done` on the explain step's first text delta or when the turn leaves the loop without one — and the panel labels it "Drafting the change…". Badge measured in the browser at 1.0 s (375 px) and 1.6 s (desktop) after send, then replaced by the explanation; starting at the block's open rather than its end saved ~0.6 s of operation streaming on a one-op edit.
- Visible self-corrections at `low`: one plain answer wrote a wrong weekday and corrected itself mid-sentence (*"on Tuesday… Sorry, I'll correct that"*), and after an applied proposal the next turn "corrected" its own earlier (accurate) message because the itinerary now contained the stop. The second is a context gap older than W5 (an applied proposal's outcome is not in the conversation), surfaced more visibly by a model that reconciles out loud.
- The model relays catalogue provenance to the traveller (*"the catalogue lists these places as 'unverified'"*), the word D-27-1 keeps out of the discovery UI. The tool result carries it; a prompt line could stop it. Pre-existing, not W5.
- Motion (sheet slide, drag) was not exercised: the pane runs the tab hidden; settled states were verified.
- The public-host turn with a catalogue search (no 524 through Cloudflare) is a post-deploy step (§7, Deploy B).
- `docs/ENGINEERING.md` ("Booking extraction and the co-pilot use Sonnet 4.6 …") becomes false at Deploy B; correct it then, as W3 did at Deploy A. W6 owns the `docs/DECISIONS.md` chosen-profiles entry.

**Rollback (one line):** `claude.js` → `COPILOT_MODEL = 'claude-sonnet-4-6'`. That restores `{ maxTokens: 8192 }` with no effort and no thinking under the D-30-9 protocol and the new prompt (the rollback pin `739c12cf…` proves the body); the main co-pilot pin must be flipped back to that literal too. D-30-9 itself stays (it is correct on 4.6: 10/10). Reverting D-30-9 as well would need the loop change and the prompt bullet reverted together.

**Files.** `backend/src/services/claude.js`, `backend/tests/claude.test.js`, `docs/DECISIONS.md`, `backend/scripts/modelEval/{profiles.mjs, copilot.mjs, README.md, fixtures/copilot/scenarios.json, lib/score/copilot.mjs, lib/copilotRequestPatch.mjs (new), lib/copilotPromptVariants.mjs (removed)}`, this plan.

**Steps.** Sweep per §5.2 with the recorded SSE events; **E-COP-1 first** — if the pre-proposal explanation vanishes under the primary candidate, stop and put Q-30-3 to the owner with the recordings before choosing a remedy; pick the profile (candidate: effort `low`, 16,000/iter); set `COPILOT_MODEL`; `reportTurnMetrics` continues to record the configured model string (new rows say `claude-sonnet-5-5`; old rows are history); verify cache reads within multi-iteration turns on the real API; local browser pass on the dedicated verify trip (Plan 11/12 memory): plain question, audit, grounded add → proposal → apply, booking-linked refusal, abort mid-turn, and a deliberately slow turn to see ping spacing; through the public host after deploy, one turn that includes a catalogue search to prove no 524.

**Gate.** §5.3 co-pilot. **Rollback:** revert the constant; the W1 keep-alive and notices stay (they are correct on 4.6 too).

**Deploy B (default):** after W5 — `/deploy`; post-deploy proof as above plus the owner's Appendix A §B pass. No calendar observation window (owner ruling 2026-10-19, §7); the owner's same-day production pass is the gate, and as standing log checks watch `copilot_turn_metrics` (TTFD, stop reasons, truncation count, output tokens) weekly against the W0 baseline, and the import error log for `refusal`/`max_tokens` messages.

### W6 — Close-out

**Status:** NOT STARTED.

Update `docs/ENGINEERING.md` ("Discovery and Photos" bullet naming the models; add one line under "API Cost and Provider Discipline": effort is fixed per workload because changing it resets the prompt cache), the design spec table rows 79 and 338–341, `docs/DECISIONS.md` (one row per D-30 marker; a "Model 5.5 migration — chosen profiles and why" entry with the measured numbers so the next agent does not re-sweep), and this plan's header. `git diff --check`. Record final spend and the observation-window outcome. Close.

---

## 7. Rollout, observation, rollback — summary

- **Order (revised by owner ruling 2026-10-19):** W1 → W2 → W3 → **Deploy A** (done 2026-10-18 at `a12f473`, owner pass passed) → W4 → W5 → **Plan 32 M1, M2** → **Deploy B** (carries migration 037 after 036) → W6. No waiting between waves.
- **No calendar observation windows (owner ruling 2026-10-19).** Production volume is too low for a 7- or 14-day window to observe anything (F-30-15, W0 production baseline: 8 co-pilot turns ever, one discovery generation a month, no extraction in a month). The gate after each deploy is the owner's deliberate 20-minute pass through the public host on a phone (Appendix A step 4: one real screenshot import, one co-pilot turn with a catalogue search, one "show more" on a heavily browsed destination, one manual stop), plus the orchestrator's same-day read of the container log. The per-workload rollback triggers below stay in force permanently as standing log checks, not as gates.
- **Plan 32 (remove a stopped exchange) sits after W5, before Deploy B.** It edits the same co-pilot files W5 evaluates (`claude.js`, `routes/copilot.js`, `useCopilot.js`, `CopilotPanel.jsx`) and adds a `turn` SSE event to every stream, so it must not change the co-pilot while W5 measures it, and it cannot run in this checkout alongside any wave (every wave touches `claude.js`). If W5 stalls on an owner decision (Q-30-3), Plan 32 may use that idle time.
- **Rollback unit = one workload constant.** Because profiles are keyed by model (D-30-1), a revert never sends `effort` to Haiku 4.5 or `between_tools` to Sonnet 4.6. Rollback = one-line commit + `/deploy` (standard backup ritual; no migration, so no schema rollback). Q-30-1 offers the env-var alternative.
- **Rollback triggers (per workload, standing log checks):** descriptors — null-warning rate above the W0 baseline over any 24 h; discovery — any generation ending `max_tokens`/`refusal`, or <8 categories on a destination that reached 8 on control; extraction — any owner-observed critical error, or a `refusal`/`max_tokens` failure on a legitimate input; co-pilot — TTFD max > 10 s, any 524 through the public host, any silent turn, truncation rate > 0, grounding violation observed.
- **Time-bound external risk:** if Anthropic announces Haiku 4.5's deprecation, the Haiku rollback window closes at the retirement date; W2/W3 should not wait on W4/W5 (D-30-5).
- **Provenance:** `copilot_turn_metrics.model` and `import_artifacts`' stored model string record whichever model actually ran; nothing rewrites history.

---

**Deploy B record (2026-10-19; run by the orchestrator on the owner's go).** Production now runs `a2c47d5` (from `a12f473`). Pre-flight: local main equal to origin and clean; backend 1,153 passed (6 skipped), frontend 357 passed, build clean; no secrets or data files in the deploy diff; one additive migration in range (037). Server before: healthy on `a12f473`, nightly backup and health-check cron present; pre-deploy backup `trippy-pre-plan30B-20261018-125653.db` (12,902,400 bytes, integrity ok); migrations at 036; Plan 32's legacy-pairing check on the backup: 1 stopped reply, verdict `ok`. Deploy: `git pull --ff-only` → `a2c47d5`, `docker compose up -d --build`; startup log `Migration applied: 037_copilot_message_reply_to.sql` then `Trippy backend running`; `_migrations` max 37 at 18:57:11 UTC. Verification: `/api/health` ok on the host and through `https://trippy.zyroi.com` (PWA 200 in 0.84 s); unauthenticated `/api/trips` → 401; 0 error lines since restart; no model traffic yet. **Owner production pass (Appendix A step 4) still to run:** one real screenshot import, one co-pilot question that triggers a catalogue search then a proposal (explanation above the card, badge before it), Stop a reply and Remove the exchange then reload, one "show more" on a heavily browsed destination plus a leave-and-return during a fresh generation, one manual stop. Rollback stays one constant per workload plus a redeploy; 037 is additive and needs no schema rollback.

## 8. Verification expectations

- Backend: `cd backend; npm test` green at every wave; the opt-in live smoke green at W1, W2–W5 switch points, and before each deploy (`LIVE_ANTHROPIC=1`).
- Frontend: `cd frontend; npm test; npm run build` at W1 and W5 (the only frontend-touching waves).
- UI: co-pilot and import flows exercised in a real browser at 375 px and desktop before W1, W4, W5 are called complete; the owner runs the production pass (Appendix A).
- Evidence retained: harness run files (local, gitignored), the scored tables pasted into status lines, spend per wave, and the exact chosen profile per workload.
- Never call a wave complete from a build or a mocked suite alone — every switch wave includes a paid, real-model comparison and a real-browser pass.

---

## 9. Estimate (provisional, one engineer, assumes fixtures available)

| Wave | Estimate |
|---|---|
| W0 harness + fixtures + control run | 6–9 h |
| W1 hardening + SDK bump + tests + live smoke | 6–8 h |
| W2 descriptors | 1.5–2 h |
| W3 discovery | 3–4 h |
| W4 extraction (labelling dominates) | 4–6 h |
| W5 co-pilot (E-COP-1 may add a remedy cycle) | 4–7 h |
| W6 docs + decisions | 1–2 h |
| **Total** | **26–38 h** (calendar: a few days; no observation windows per the 2026-10-19 ruling) |

The assessment's 19–31 h did not include a reusable harness or the W1 never-silent work; both are deliberate additions here because the first (keep-alive) is a production-correctness requirement and the second (harness) is what makes every later model change cheap.

### 9.1 Recommended session driver per wave (owner-requested, 2026-10-18)

The orchestrator model is the Claude Code session that reads this plan and runs the wave; coding is delegated to Sonnet 5.5 subagents (at most two in flight, never overlapping files; never a Fable subagent) per the owner's global rules. Effort is the session's effort setting. Fable 5.1 costs about 2.5× Opus 5.5 per token, so it is reserved for the two waves whose outcome turns on judgment the plan could not pre-decide.

| Wave | Driver | Effort | Why this and not the tier above or below |
|---|---|---|---|
| W0 harness + fixtures + control run | Opus 5.5 | high | Mostly build work against a precise spec; the judgment is in fixture quality, which high effort covers. Fable adds cost without a decision to make. |
| W1 hardening + SDK bump | Opus 5.5 | high | Careful but fully specified (D-30-1, D-30-3, D-30-4); the risk is regressions, caught by the suite and the live smoke, not by deeper reasoning. |
| W2 descriptors | Sonnet 5.5 | high | Smallest blast radius, one constant, a 50-item scored sweep; a Sonnet session can run it end to end. |
| W3 discovery | Opus 5.5 | high | The gate needs a blind quality read of real places and a budget decision from measured tokens; Opus-level judgment, no open product question. |
| W4 extraction | Opus 5.5 | high | Correctness is scored against owner labels; critical-error triage benefits from Opus but needs no product call. Escalate the gate review to Fable only if a critical-error class appears that the labels do not settle. |
| W5 co-pilot | Fable 5.1 | high | E-COP-1 and the Q-30-3 remedy are product and protocol judgment on recorded SSE traces, touching Plan 11 contracts; this is the one wave where a wrong read ships a worse co-pilot. |
| W6 close-out | Sonnet 5.5 | medium | Documentation and decision rows from recorded evidence. |

Effort above high is not recommended for any wave: none is long-horizon agentic work, and xhigh/max mainly lengthen the session.

---

## Appendix A — Owner checklist (things only the account holder can do)

1. **Baseline export (W0).** On the server: `sqlite3 ~/Trippy/data/trippy.db "SELECT model, COUNT(*), AVG(output_tokens), AVG(ttfd_ms), MAX(ttfd_ms), AVG(total_ms), SUM(stop_reason='max_tokens'), SUM(error) FROM copilot_turn_metrics GROUP BY model;"` (host `sqlite3`, read-only) and `docker logs trippy-trippy-1 2>&1 | grep '\[discover\] ok'` — paste the numbers (no text) into W0.
2. **Console checks (before Deploy A).** Rate-limit tier rows for `claude-sonnet-5-5` and `claude-haiku-5-5`; organisation creation date (before/after 2026-08-31 — informational, F-30-10); confirm the API key's workspace has no model allow-list that would block the new ids.
3. **Fixtures (W0/W4, Q-30-4).** Drop redacted real booking inputs and their expected values into `backend/data/model-eval/private/` on the dev machine.
4. **Production passes.** After Deploy A: add a manual stop (photo appears), run "show more" on one fresh destination (8 categories stream). After Deploy B: import one real confirmation (text, screenshot, PDF), run the co-pilot scenarios in §5.2 on a non-critical trip, apply one proposal, try one turn with a catalogue search through `trippy.zyroi.com`.
5. **Decisions.** Answer Q-30-1 … Q-30-5 at any point before the wave that needs each; defaults apply otherwise.
