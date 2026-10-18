# Implementation Plan 30 — Sonnet 5.5 / Haiku 5.5 Migration

**Status:** 2026-10-18 — **APPROVED by the owner (plain approval, defaults of Q-30-1 … Q-30-5 apply until answered). W0 may start; nothing implemented, nothing deployed.** Written at `ad959a5` from the owner's stated intent to move all four Anthropic workloads to their 5.5 counterparts, after an independent verification of the [2026-10-18 upgrade assessment](../reviews/2026-10-18-sonnet-haiku-55-upgrade-assessment.md) against live code, the installed SDK, and official provider documentation (all fetched 2026-10-18). Every setting, threshold, budget and estimate below is **provisional** until the evaluation in W0–W1 produces numbers; the plan says which gate turns each one into a decision. Waves are implemented later via `/implement-milestone`; each wave updates its own status line and commits. The owner questions Q-30-1 … Q-30-5 carry a default each wave follows unless the owner says otherwise — none of them blocks W0.

**Origin.** The owner wants Sonnet 4.6 → Sonnet 5.5 (extraction, co-pilot) and Haiku 4.5 → Haiku 5.5 (discovery, photo descriptors). The companion [opportunity exploration brief](../reviews/2026-10-18-model-55-opportunity-exploration-brief.md) is a separate product-discovery track and is **not** an input to this plan: no new tool, capability, or product behaviour rides on this migration.

**Scope in one sentence:** change which model answers each of the four existing requests in `backend/src/services/claude.js`, set thinking/effort/output allowances that are measured rather than inherited, make each request path honest about the response shapes the new models produce (thinking blocks, refusals, truncation, silence), and ship each workload only after it passes its own paired evaluation — with a per-workload revert that restores the old model *with the old model's compatible parameters*.

**Not in scope.** No new tools, no model call on the hosted MCP path (a closed cost boundary — `docs/DECISIONS.md`), no change to proposal-apply semantics, catalogue lifecycle, resolver order, provider tiers, pin precedence or the geography ladder; no database migration; no rewriting of historical `copilot_turn_metrics.model` values, `import_artifacts` provenance, or completed plan docs to say 5.5; no image downscaling dependency (measure first — F-30-14); no prompt redesign beyond what a measured regression requires; no Opus, Fable, batch, fast-mode, server-side fallback or task-budget features.

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

**Owner questions (defaults in bold; none blocks W0):**

- **Q-30-1 — Env override per workload for rollback without a rebuild?** An `EXTRACTION_MODEL`-style env var would let `.env` + container restart flip a workload in seconds. Cost: a second source of truth that drifts (the repo already carries a `.env` precedence gotcha), and production `.env` is edited by hand. **Default: no** — constants in code, rollback is a one-line revert + `/deploy` (a few minutes).
- **Q-30-2 — Bump the SDK in W1?** **Default: yes**, gated and revertable (D-30-2).
- **Q-30-3 — If E-COP-1 shows the pre-proposal explanation vanishing, which remedy?** (a) `display: "updates"` (beta header) and forward non-empty progress-update text to the panel as a visibly *different* line (it is a model-written summary, not the prose); (b) `between_tools` at `medium` — same summary text, no beta header, no up-front thinking; (c) a protocol change so the model's explanation is written *after* the tool call (a Plan 11 contract change — out of this plan). **Default: decide at the W5 gate from the measurement; do not pre-commit.**
- **Q-30-4 — Extraction fixtures.** Real confirmations are the only honest corpus. **Default:** the owner supplies 15–25 redacted real inputs (screenshots, PDFs, pasted emails) into the gitignored private fixtures directory; the plan adds 10–15 synthetic hard cases (DD/MM ambiguity, missing year, overnight flights, multi-leg, CJK local names, non-travel input) that are committed. Fewer real inputs lowers the confidence of the W4 gate; it does not change the method.
- **Q-30-5 — Deploy grouping.** **Default: two deploys** (Haiku after W3, Sonnet after W5), each followed by its own observation window.

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

**Status:** 2026-10-18 — **COMPLETE, not deployed.** Still on the old models: no `*_MODEL` constant, prompt or tool schema changed, and the four W0 sha256 request-body pins pass with their literals untouched. Markers `D-30-1`, `D-30-3` and `D-30-4` are stamped in `claude.js`; `D-30-4` is also stamped in `useCopilot.js` and `CopilotPanel.jsx`.

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
- `useCopilot`'s Stop comment says the server keeps the partial text. It does not: the abort path returns before `persistTurn`, so a stopped reply vanishes on reload (seen in the dev DB). This predates W1 and is left for a follow-up.
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

### W2 — Photo descriptors → Haiku 5.5

**Status:** NOT STARTED.

**Steps.** Run the §5.2 descriptor sweep; score; pick the profile; set `PHOTO_DESCRIPTOR_MODEL = 'claude-haiku-5-5'` and its profile (candidate: effort `low`, 1,024); update `claude.test.js:1073`; local verification via the Plan 10 throwaway script pattern (temp DB, live Unsplash, 5 manual stops) to confirm the descriptor → Unsplash path still yields relevant photos — inspect the actual photos, not just a valid query. Record the sweep table, chosen profile, spend and unresolved limitations in this status line.

**Gate.** §5.3 descriptors. **Rollback:** revert the constant (profile follows automatically).

### W3 — Discovery → Haiku 5.5

**Status:** NOT STARTED.

**Steps.** Sweep per §5.2; measure actual `output_tokens` (thinking included) per generation and set the allowance (D-30-6); pick the profile (candidate: effort `low`, 96,000); set `DISCOVERY_MODEL`; update the `claude.js:350` comment to state the new reasoning (the 64K ceiling rationale is Haiku-4.5-specific and must not survive as a false fact) and `claude.test.js:210`; keep `MIN_CATEGORIES_WITH_ITEMS` and all lifecycle/budget behaviour untouched; one real local generation through the route (fresh destination in the dev DB copy — *not* production) to confirm per-category streaming and the `thinking` ping still interleave; confirm the resolver verification queue behaves identically on the new rows (budgets, provenance `pending`).

**Gate.** §5.3 discovery. **Rollback:** revert the constant; a stale-refresh on the old model complements any partial batch (Plan 26 semantics). No catalogue rebuild, no mass refresh, before or after (`docs/DECISIONS.md`).

**Deploy A (default, Q-30-5):** after W3 — `/deploy` with the standard pre-deploy backup; post-deploy: one descriptor on a new manual stop, one discovery "show more" on a fresh destination the owner chooses, container logs show `[discover]` lines with `stop_reason=end_turn` and 8 categories. Observation window: 7 days (one catalogue freshness cycle); watch descriptor `null` warnings and discovery stop reasons.

### W4 — Extraction → Sonnet 5.5

**Status:** NOT STARTED.

**Steps.** Sweep per §5.2 on the labelled corpus (Q-30-4); pick the profile (candidate: effort `medium`, 16,000); set `EXTRACTION_MODEL`; keep the Plan 2A D3 comment (the ruling is *Sonnet-tier, not Haiku* and still holds; only the version string changes); the import flow's confirmation step and artifact retention are untouched; local browser pass at 375 px and desktop: paste text, upload a screenshot, upload a PDF, and a non-travel input — confirm the new specific error copy for a forced `max_tokens` case (lower the allowance temporarily in the harness, never in code).

**Gate.** §5.3 extraction. **Rollback:** revert the constant.

### W5 — Co-pilot → Sonnet 5.5

**Status:** NOT STARTED.

**Steps.** Sweep per §5.2 with the recorded SSE events; **E-COP-1 first** — if the pre-proposal explanation vanishes under the primary candidate, stop and put Q-30-3 to the owner with the recordings before choosing a remedy; pick the profile (candidate: effort `low`, 16,000/iter); set `COPILOT_MODEL`; `reportTurnMetrics` continues to record the configured model string (new rows say `claude-sonnet-5-5`; old rows are history); verify cache reads within multi-iteration turns on the real API; local browser pass on the dedicated verify trip (Plan 11/12 memory): plain question, audit, grounded add → proposal → apply, booking-linked refusal, abort mid-turn, and a deliberately slow turn to see ping spacing; through the public host after deploy, one turn that includes a catalogue search to prove no 524.

**Gate.** §5.3 co-pilot. **Rollback:** revert the constant; the W1 keep-alive and notices stay (they are correct on 4.6 too).

**Deploy B (default):** after W5 — `/deploy`; post-deploy proof as above plus the owner's Appendix A §B pass. Observation window: 14 days; watch `copilot_turn_metrics` (TTFD, stop reasons, truncation count, output tokens) weekly against the W0 baseline, and the import error log for `refusal`/`max_tokens` messages.

### W6 — Close-out

**Status:** NOT STARTED.

Update `docs/ENGINEERING.md` ("Discovery and Photos" bullet naming the models; add one line under "API Cost and Provider Discipline": effort is fixed per workload because changing it resets the prompt cache), the design spec table rows 79 and 338–341, `docs/DECISIONS.md` (one row per D-30 marker; a "Model 5.5 migration — chosen profiles and why" entry with the measured numbers so the next agent does not re-sweep), and this plan's header. `git diff --check`. Record final spend and the observation-window outcome. Close.

---

## 7. Rollout, observation, rollback — summary

- **Order:** W1 (hardening) → Deploy A? (optional, recommended) → W2, W3 → **Deploy A** → observe 7 d → W4, W5 → **Deploy B** → observe 14 d → W6.
- **Rollback unit = one workload constant.** Because profiles are keyed by model (D-30-1), a revert never sends `effort` to Haiku 4.5 or `between_tools` to Sonnet 4.6. Rollback = one-line commit + `/deploy` (standard backup ritual; no migration, so no schema rollback). Q-30-1 offers the env-var alternative.
- **Rollback triggers (per workload, during observation):** descriptors — null-warning rate above the W0 baseline over any 24 h; discovery — any generation ending `max_tokens`/`refusal`, or <8 categories on a destination that reached 8 on control; extraction — any owner-observed critical error, or a `refusal`/`max_tokens` failure on a legitimate input; co-pilot — TTFD max > 10 s, any 524 through the public host, any silent turn, truncation rate > 0, grounding violation observed.
- **Time-bound external risk:** if Anthropic announces Haiku 4.5's deprecation, the Haiku rollback window closes at the retirement date; W2/W3 should not wait on W4/W5 (D-30-5).
- **Provenance:** `copilot_turn_metrics.model` and `import_artifacts`' stored model string record whichever model actually ran; nothing rewrites history.

---

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
| **Total** | **26–38 h** (calendar: longer — two observation windows of 7 and 14 days) |

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
