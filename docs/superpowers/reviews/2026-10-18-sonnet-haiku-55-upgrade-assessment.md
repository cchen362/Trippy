# Sonnet and Haiku 5.5 — upgrade assessment and orchestrator handoff

Date: 2026-10-18 (Asia/Singapore)

Status: Advisory input for independent orchestrator assessment and implementation planning. The owner intends to upgrade both model families. Nothing has been implemented or deployed by this review.

Companion: [Opportunity exploration brief](2026-10-18-model-55-opportunity-exploration-brief.md). Discovery is a separate track, not an upgrade prerequisite or a selected feature direction.

## 1. Mandate and recommendation

The owner wants all current Sonnet 4.6 workloads moved to Sonnet 5.5 and all current Haiku 4.5 workloads moved to Haiku 5.5. Prepare an objective implementation plan for that outcome, with workload-specific evaluation and rollout gates. Surface a regression with evidence rather than treating the migration intent as proof that every configuration is acceptable.

Recommendation: pursue one coordinated migration covering all four workloads, while measuring and approving each workload independently. Haiku has the stronger price case; Sonnet's value depends more on accuracy, useful tool behavior and perceived latency. A model-name replacement alone is insufficient.

This document distinguishes:

- **Checkout facts:** observations from the local source and installed dependencies on this date, not verification of deployed configuration.
- **Provider facts:** published API behavior and pricing, linked below; recheck before implementation.
- **Recommendations:** proposed settings, evaluation design and estimates, not adopted engineering rules.
- **Unknowns:** account access, runtime compatibility, real quality, latency and spend have not been measured against 5.5.

No paid evaluations, production inspection, implementation, deployment or billing-history analysis was performed for this assessment. Existing tests were inspected, not executed.

## 2. Current scope and evidence

Read [ENGINEERING.md](../../ENGINEERING.md) in full, then [DECISIONS.md](../../DECISIONS.md). Live code outranks stale specification text. Source line references below describe this checkout and may move.

| Workload | Live constant in `backend/src/services/claude.js` | Request | Target |
|---|---|---|---|
| Booking extraction | `EXTRACTION_MODEL`, line 17: `claude-sonnet-4-6` | `extractBookings`, lines 97–181; non-streaming text/image/PDF input; 8,192 output-token allowance | `claude-sonnet-5-5` |
| Co-pilot | `COPILOT_MODEL`, line 21: `claude-sonnet-4-6` | `streamCopilotResponse`, line 521 onward; SSE, three tools, 8,192 tokens per model response; ephemeral system cache | `claude-sonnet-5-5` |
| Discovery | `DISCOVERY_MODEL`, line 23: `claude-haiku-4-5-20251001` | `discoverDestination`, lines 337–448; NDJSON category stream; 64,000 tokens | `claude-haiku-5-5` |
| Photo descriptors | `PHOTO_DESCRIPTOR_MODEL`, line 19: `claude-haiku-4-5-20251001` | `generatePhotoDescriptor`, lines 464–499; short text input and fenced JSON; 256 tokens | `claude-haiku-5-5` |

Source: [claude.js](../../../backend/src/services/claude.js). All four requests omit explicit thinking/effort settings. They do not use forced tool choice, custom sampling parameters, assistant prefill or manual thinking budgets.

Additional evidence:

- [Backend dependencies](../../../backend/package.json) declare `@anthropic-ai/sdk: ^0.91.0`; the lockfile and installed package are 0.91.1. Installed message types include adaptive thinking and effort but omit `between_tools`. This is an SDK compatibility investigation, not proof of a JavaScript runtime rejection.
- Extraction filters response blocks by type before parsing the last fenced JSON block. It logs input/output usage and returns model provenance. It does not explicitly reject a truncated response before parsing.
- Co-pilot selects tool blocks by type, preserves complete assistant content within its query loop, checks `max_tokens`, aborts on client disconnect and aggregates token/cache usage. It streams only text events to the user. Five query executions are permitted per turn, with a further budget-notice/hard-stop mechanism.
- [Co-pilot route](../../../backend/src/routes/copilot.js), lines 24 and 181–255: the latest 50 stored messages become model history; persisted history is text/context, not signed thinking blocks. Per-turn model, tokens, cache usage, first-text latency, duration, iterations, stop reason and error are stored in `copilot_turn_metrics`.
- Discovery's final message is awaited but its usage and stop reason are discarded. A minimum of four populated categories is accepted although the prompt requests eight. The 64K allowance was introduced after historical truncation of late categories.
- [Generation pipeline](../../../backend/src/services/discoveryGeneration.js), lines 33–107: up to 400 exclusion names; insertion occurs per completed category; freshness/counts advance after successful generation. A failed generation may already have inserted partial rows by deliberate design.
- Descriptor output is filtered by block type. Missing/malformed output returns `null`, allowing fallback rather than blocking stop creation. This can conceal a quality regression if only HTTP success is measured.
- [Claude tests](../../../backend/tests/claude.test.js) and [importer tests](../../../backend/tests/importer.test.js) mock Anthropic. They verify application behavior, not real model accuracy or wire compatibility.
- Hosted MCP makes no Anthropic call. No MCP model migration or second extraction belongs in this scope.

## 3. Published changes and compatibility

Provider documentation consulted on 2026-10-18:

- [S1: Sonnet migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
- [S2: Haiku migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- [S3: Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [S4: Haiku behavior changes](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5)

**Sonnet [S1]:** thinking is adaptive by default; omitted thinking previously meant no thinking on 4.6. Thinking is billed as output and shares `max_tokens`. `between_tools` disables up-front thinking at effort `high` or below; `disabled` is rejected. Forced tool use, manual thinking budgets and non-default sampling are unsupported. Some intermediate notes move into thinking blocks. Replay complete blocks unchanged within a tool loop; signed blocks constrain edits to earlier context. The newer tokenizer produces about 30% more tokens for the same text. Large-image token counts also increase; the guide's 2000×1500 example uses about 2.5 times the image tokens.

**Haiku [S2, S4]:** adaptive thinking is on by default, at default medium effort. Unlike Sonnet, `thinking: disabled` is accepted at high effort or below. Thinking shares the output allowance, so a small request can exhaust its budget before returning text. Manual thinking budgets, assistant prefill and unsupported sampling settings need replacement if present. Read blocks by type and handle refusal outcomes. Token counts increase by approximately 30% for identical text. Published maximum output is 128K; that is capacity, not a recommended application budget.

Most parameter-breaking cases are absent from today's requests. The material risks are changed defaults, response visibility, token allowances, final-response handling and actual model behavior. Do not turn the full provider migration checklist into unrelated Trippy work.

## 4. Economics: rates are not workload savings

Standard global Claude API rates, USD per million tokens [S3]:

| Model / prompt tier | Input | Output | 5-minute cache write | Cache read |
|---|---:|---:|---:|---:|
| Sonnet 4.6 | 3.00 | 15.00 | 3.75 | 0.30 |
| Sonnet 5.5 | 2.00 | 10.00 | 2.50 | 0.10 |
| Haiku 4.5 | 1.00 | 5.00 | 1.25 | 0.10 |
| Haiku 5.5, prompt up to 100K | 0.10 | 0.50 | 0.125 | 0.01 |
| Haiku 5.5, prompt over 100K | 0.50 | 2.50 | 0.625 | 0.05 |

Haiku's tier depends on input prompt length, not generated output length. Current short text prompts appear likely to qualify for the lower tier; verify by counting the full request, including exclusions. Neither Haiku workload currently sends images. Neither explicitly requests prompt caching, so cache rates are not automatic Haiku savings.

Illustrative calculations, assuming equivalent text, 1.3 times the tokens, identical cache behavior and no extra thinking/retries:

- Sonnet ordinary text: `1.3 × 2/3 = 0.867`, about **13% cheaper**; cache reads: `1.3 × 0.10/0.30 = 0.433`, about **57% cheaper**.
- Haiku short-prompt text: `1.3 × 0.1 = 0.13`, about **87% cheaper**. At the long-prompt tier, equivalent text would be about 35% cheaper under the same assumptions.
- Sonnet's cited large-image example: `2.5 × 2/3 = 1.667`, about **67% higher image-input cost**. This is one image component, not a universal extraction-cost increase.
- A discovery output of 50K old tokens costs $0.25; 65K new tokens costs $0.0325 at the lower Haiku tier, before input and additional thinking.

These are arithmetic illustrations, not observed savings. Re-baseline actual input, output including thinking, cache writes/reads, retries and downstream resolver requests. Report cost per successful extraction, useful co-pilot turn, usable discovery place and valid descriptor. No monthly-dollar forecast is defensible without volume data. Provider speed/benchmark claims do not establish Trippy-specific gains.

## 5. Workload findings and proposed evaluation settings

### 5.1 Extraction — leading risk: plausible but incorrect booking facts

Evaluate ambiguous years/date formats, timezones, overnight/multiple legs, local scripts, dense screenshots, PDFs and non-travel input. Compare field correctness and uncertainty against manually labelled expected results. JSON validity alone is inadequate.

Start with adaptive medium/high as candidates; use a low-thinking control only to measure the quality tradeoff. Select a finite output allowance from observed thinking plus JSON sizes. Explicitly assess refusal, truncation and incomplete results before normalization/confirmation. Keep existing confirmation and source retention behavior.

### 5.2 Co-pilot — leading risk: valid-looking advice that ignores grounding or commitments

Compare adaptive low/medium and `between_tools` medium; higher effort is a candidate for difficult scenarios, not an automatic default. Keep settings stable enough to measure cache behavior. Confirm SDK stream support with actual API responses containing thinking/signature blocks.

Exercise catalogue grounding, deterministic health checks, booking-linked protection, real IDs, query cap, proposal validation, stale apply, abort and multi-iteration turns. Preserve full content inside the loop. Current text-only persistence means old signed blocks are not replayed across user turns; do not invent a history rewrite solely for this migration.

Check perceived progress and long quiet intervals through public ingress. The repository records Cloudflare's 100-second no-bytes timeout; opening SSE headers alone is not evidence that every long silent turn is safe. Determine whether keep-alives or progress handling are required. Handle refusal/context-limit outcomes without disguising them as normal completion. Rendering internal reasoning is not required.

### 5.3 Discovery — leading risk: incomplete or weak generations stored as useful catalogue content

The code estimates 40–50K old output tokens for its requested volume. Applying the illustrative tokenizer factor yields 52–65K before thinking: today's 64K allowance may again cut late categories. The four-category guard cannot establish eight-category completeness. Observe final stop reasons, category coverage, malformed lines, actual usage and time to first usable category. Rejecting an interrupted generation must respect existing partial-insert semantics and must not mark it fresh.

Compare thinking disabled, adaptive low and adaptive medium on a bounded subset first. Tune the allowance from evidence; do not simply assign the provider maximum. Judge specific, real, correctly located places and aliases, useful category variety, duplicate/exclusion handling, photo metadata and resolver work per usable result. Smaller cities may honestly support fewer items: do not force volume at the expense of quality.

Keep the verified corpus, seven-day reuse, incremental merge, generation caps and resolver budgets. No production rebuild or mass refresh for evaluation. Resolver coverage is an existing owner decision, not a new target to maximize by changing provider order.

### 5.4 Photo descriptors — leading risk: silent fallback regression

Compare thinking disabled against adaptive low. The 256-token limit needs validation under the selected mode and tokenizer. Track non-empty valid JSON, the eight-word cap, scene vocabulary, useful specificity, fallback rate and latency. Inspect representative search results rather than assuming a valid query produces a relevant photo. Do not multiply paid photo searches across the whole corpus without a measured need.

## 6. Proposed evaluation and decision gates

This is a starting design for the orchestrator to refine, not a completed benchmark or statistical guarantee.

| Workload | Suggested initial paired corpus | Evidence to retain |
|---|---|---|
| Extraction | About 30 representative text/image/PDF inputs; repeat difficult cases | Labelled field accuracy, critical errors, uncertainty, parse/truncation/refusal outcomes, latency and cost |
| Co-pilot | About 20 scenarios; repeat difficult tool sequences | Grounding, correct tools/IDs, proposal validity and boundaries, first-text and total latency, query count/cache/cost |
| Discovery | Six destinations spanning local scripts, large/small cities and sparse categories; first generation and exclusions; repeat finalists | Coverage, usefulness, reality/location checks, parse/stop outcomes, resolver efficiency, first-category/total latency and cost |
| Descriptors | About 40–50 varied places, cuisines and ambiguous names | Output validity, scene/query relevance, fallback rate, latency and cost |

Use the same inputs for old/new models. First isolate the model difference with common prompts/tools, then evaluate any justified prompt/settings changes separately. Screen settings on a small subset before expanding to avoid a wasteful full Cartesian sweep. Blind qualitative judgments where practical. Match the existing date-context behavior so runs on different days are not mistaken for model differences.

Use disposable evaluation storage and bounded provider calls; no owner trip mutations or corpus writes. Determine a run budget before dispatch. Keep sensitive source material local and redact retained reports. A small corpus supports a deployment decision with ongoing observation, not a claim of universal superiority.

Proposed acceptance principles:

1. No new critical booking errors or application-boundary failures in the reviewed corpus. Investigate baseline failures too; zero observed errors is not proof of zero risk.
2. Co-pilot quality and grounded proposals are at least comparable, with explicit treatment of regressions rather than an aggregate score hiding them.
3. No systematic discovery category loss, increased invalid output or material curation/resolver regression. No increase in descriptor fallback without an accepted tradeoff.
4. Define numeric latency, cost and failure thresholds against measured baseline before the final sweep. Report medians, slow cases and sample sizes; do not fabricate p95 confidence from a tiny sample.
5. Each workload has a recorded chosen configuration, acceptance evidence, unresolved limitations and rollback trigger. Migration intent does not justify silently lowering a quality bar.

## 7. Scope, verification, rollout and sizing

Likely implementation surface: `claude.js`, SDK dependency/lockfile if needed, meaningful model-response tests, narrow telemetry/stream handling where the evaluation identifies a gap, current engineering/spec documentation and a migration decision record. No database migration or broad UI redesign is presently indicated; the orchestrator must verify that assumption.

Do not rewrite historical model provenance, metrics rows or completed plans to say 5.5. Test fixtures representing old records can remain old. Preserve the MCP no-model boundary, proposal apply semantics, catalogue lifecycle, provider tiers, pin precedence and geography rules. New product tools/research/agents belong to the separate discovery track.

Plan the migration in reviewable units: baseline and fixtures; SDK/response compatibility; per-workload settings and validation; final regression checks; staged activation and observation. These are planning inputs, not an assigned plan number or implementation authorization from this document.

Use the repository's required backend tests, frontend tests/build and affected phone/desktop checks where applicable. Add tests for real integration risks such as thinking plus text/tool blocks, refusal, truncation and abort; mocked tests cannot replace paid-provider comparison. Verify public streaming behavior before declaring rollout complete.

Prefer independent workload rollback, restoring each old model with its compatible settings rather than changing the model ID while retaining incompatible parameters. Keep data formats unchanged where feasible. Observe new metrics and fallback/partial-generation outcomes after activation. If a candidate fails, isolate the cause and hold that workload instead of blocking every successful workload or adding an unmeasured fallback chain.

Preliminary one-engineer estimates, assuming representative material is available:

| Scope | Estimate |
|---|---:|
| Sonnet migration and evaluation | 13–21 hours |
| Additional Haiku work, sharing SDK and verification setup | 6–10 hours |
| Combined | **19–31 hours, roughly 3–4 working days** |

These estimates include compatibility, focused handling/tests, paired evaluation, documentation and rollout verification. They exclude major prompt redesign, feature development and waiting for an observation period. Re-estimate after baseline inspection; calendar duration may be longer.

## 8. Orchestrator handoff

The owner has chosen to pursue both model upgrades. Independently verify this assessment against current code and current official provider documentation. Produce your own evidence-led assessment and a repository-conforming implementation plan for all four workloads. Keep configuration choices, thresholds and SDK changes provisional until validated; surface any blocker with concrete evidence and a proposed resolution.

The plan should specify scope, workload settings to compare, evaluation fixtures/budget/metrics, acceptance criteria, verification, deployment/observation, rollback and documentation updates. Do not implement or deploy merely because this assessment exists; this handoff asks for assessment and planning.

Then use the separate [exploration brief](2026-10-18-model-55-opportunity-exploration-brief.md) for an independent discovery pass. Return upgrade planning and product exploration as separate deliverables. Product discovery must not become a prerequisite, hidden feature requirement or scope expansion of the migration.
