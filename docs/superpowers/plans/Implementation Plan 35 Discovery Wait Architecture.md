# Implementation Plan 35 — Discovery Wait Architecture

**Status:** 2026-10-20 — **W0 COMPLETE: the staged-emission probe is a NO-GO** (§6 W0). Haiku 5.5 still planned the catalogue before its first `emit_category` call (median 2,268–2,980 thinking tokens against the 1,200 budget), the first category landed at 23–37 s against the ~15.7 s gate, and strict tool input corrupted CJK `localName` values after the first category. Under Q-35-2 as ruled (the default), **W1 and W3 are not built**, D-34-10 stands, and D-35-1 / D-35-4 are not adopted (D-35-5). **W2 COMPLETE at `689e3e5`:** the curation-manifest wait state (D-35-2), browser-verified at 375 and 1280 px with held requests and no generation spent; not deployed. **W4 COMPLETE at `c73774d`:** every stored scope is pre-warmed at create and chip save, and the fresh path re-queues pending rows (D-35-3); not deployed (§6 W4 results). MCP-created trips are deliberately not pre-warmed (Plan 28 cost boundary). **Next: deploy (W2 + W4 + W0's log line together), then W5.** APPROVED by the owner 2026-10-20: Q-35-1 to Q-35-4 all ruled (§10). Written at `4cffede` (`origin/main`, the Plan 34 W4 commit) as the plan that Plan 34 §6 W4 and `D-34-10` defer Q-34-4 to. Every decision below is **provisional** until its gate passes. Each owner question Q-35-n carries a default. Waves are implemented later via `/implement-milestone`; each lands on its own branch.

**Origin.** Plan 34 W4 measured Discovery on Haiku 5.5 with adaptive thinking on and an exact-count volume line. It was better on every quality measure the gate has: "show more" repeating an excluded place 0 % against 30 %, alias identical to name 1.2 % against 5.7 %, verified 15 % against 12 %, wellness padding 60 % against 72 %. It failed one criterion: the first category reached the traveller after **44.2 s** (range 32.6–78.8 s) instead of **10.7 s**, because the model plans the whole catalogue in one thinking block before it writes a line. The owner ruled that thinking stays off *for now*, and asked whether the loading architecture itself had been examined for a way to keep thinking on without the wait. It had not. This plan examines it.

**Scope in one sentence:** change *when* Discovery's first category arrives on a cold destination so that adaptive thinking can stay on without the traveller waiting for it, make every remaining wait readable, and measure how often production meets one.

**Not in scope.**
- No change to catalogue freshness (7 days), the daily cap (`MAX_GENERATIONS_PER_DESTINATION_PER_DAY = 3`), D-33-1 single-flight, or the join path (D-33-2, D-33-3).
- No change to the items-per-category contract. Writing fewer or shorter items to buy a faster first category is a product change, not a loading change (§4, rejected alternative c).
- No forwarding of the model's thinking display (`display: 'summarized'` or `'updates'`) as a progress line. Rejected for the reason D-30-9 gives: it couples the product to one model's thinking-display semantics.
- No analytics table or request log. The production measure in W0 is a read-only query on tables that already exist plus one log line.
- No change to the other three workloads.
- No migration.

---

## Bottom line, in plain language

**What the traveller feels today.** Open Discovery on a city Trippy has already catalogued and it is instant. Open it on a city nobody has asked about before and the screen shows three grey placeholder cards, with no words, for about 11 s before Essentials appears, then one more category every 9 s or so. That 11 s is the only wait in Discovery, and it happens on the very first open of a new city, the moment that sets the impression.

**What thinking on would do to that wait.** The model would spend 30–70 s thinking before writing anything, so the same wordless placeholders would sit there for 44 s on a typical city and 79 s on a bad day. Everything after that is as good or better than today. Plan 34 W4 proved the quality; the owner did not accept the wait.

**Why the wait is that long, and why it is architectural.** The thinking is one block, written before the first line, because the request gives the model nothing to stop for. Thinking interleaves only across tool calls. Discovery sends no tools, so the model plans all eight categories up front. That is a property of how we ask, not of the model.

**The four candidates, in one line each.**
1. **Pre-warm every trip city**, not only Day 1's. Fewer travellers meet a cold city. The ones who do wait exactly as long.
2. **Staged emission through a tool.** The model hands over one category at a time through an `emit_category` tool. Thinking then happens per category, and the first category waits only for the first category's thinking.
3. **Parallel per-category requests.** Eight requests at once. The first category arrives when the fastest finishes. Cross-category deduplication is lost, and the single-flight registry has to learn that eight requests are one generation.
4. **A readable wait state.** The placeholders say what is happening and how far along it is. The wait is unchanged, but it is no longer a blank.

**Recommendation.** Do **2 and 4 together**, with **W0's probe first**, and do **1** as well, scoped to a trip's stored scopes (owner's steer of 2026-10-20, Q-35-3). Option 2 is the only candidate that attacks the cause: it changes the request shape so that the model's planning is spread across categories instead of done before the first one. Option 4 is owed regardless, because today's 11 s is already a wordless blank. Option 1 makes a multi-city trip consistent (Day 1 warm and Day 4 cold is the inconsistency the owner named) at a cost of cents; its one real consequence, verification budget spent on the creation day, is handled in the same wave (F-35-12). It cannot help the two cold cases that remain, a trip opened the moment it is created on a later day's city and a city typed into Discovery's search; those are what 2 and 4 are for. Option 3 trades away the one-generation model Plan 33 just installed, for a first-category time that is not clearly better than option 2's.

**The honest risk.** The gate is tight. Today's 10.7 s is about 1 s to the first byte plus about 10 s of writing 11–12 items. Plan 34 §5.1 allows 5 s more. At the rate the W4 run produced thinking, 5 s is about 900 thinking tokens. Option 2 passes only if the model's thinking before its *first* `emit_category` call stays under that, and nothing in the W4 data says whether it will: the W4 run never had a tool boundary to stop at. W0's probe measures exactly this before any product code is written. If the probe fails, the fallback is **not** "thinking on with a nicer spinner". That would be accepting a measured regression because the rest passed, which the owner's "No meeting in the middle" rule forbids. The fallback is to keep thinking off, ship W2, and record why.

---

## 1. Validated facts — established 2026-10-20 at `4cffede` (`origin/main`), do not re-derive

Code facts cite `origin/main` at `4cffede`. Measurements are Plan 34 §6 W4's, read from its run files (`backend/data/model-eval/runs/discovery/control/2026-10-19T06-01-48-115Z.jsonl` and `v-exact12-adaptive-low/2026-10-19T06-01-51-175Z.jsonl`, gitignored, local). Provider facts come from the `claude-api` skill bundled with Claude Code 2.1.299 (Haiku 5.5 migration guide); re-check them at each deploy.

**F-35-1 — Only a cold destination blanks the screen.** A fresh catalogue (under 7 days) streams every category from the database and ends `done` (`backend/src/routes/discovery.js:250–256`). A stale one streams its stored rows *before* generation starts (`:391–395`), so the grid is full while the refresh runs. "Show more" appends and keeps the grid on screen (`frontend/src/hooks/useDiscovery.js:96–107`). A request that joins a running generation gets everything already saved at once (`routes/discovery.js:265`, D-33-2). The blank is therefore: a **true miss**, or a **join before the leader's first category has landed**.

**F-35-2 — The blank has no words.** `DiscoveryPanel.jsx:1027` renders `<TabSkeleton />` (`:160`): three pulsing rectangles, literal colours (`#1a1410`, `rgba(201,160,80,0.08)`) rather than tokens, no copy, no count. The active tab's dot pulses (`:811`). The server's 8 s keep-alive, `{ type: 'thinking' }` (`routes/discovery.js:398`; `:281` on the join path), is parsed and ignored by `useDiscovery.js:55–74`. The "show more" tile is the one place with words: "Finding more places" (`DiscoveryPanel.jsx:651`).

**F-35-3 — Pre-warm covers Day 1 only.** `TripPage.jsx:69–93` fires `discovery.discover(city, countryCode)` once per trip load for `days[0]`'s city (or the trip's first destination when Day 1 has no city). The co-pilot kicks a background generation for a destination it searched and found cold (`backend/src/services/copilotGrounding.js:43–75`, `kickBackgroundGeneration`), through the same D-33-1 registry; that kick already runs with no request attached and no stream, which is the shape a server-side pre-warm would reuse. Nothing pre-warms the trip's other scopes or days.

**F-35-4 — One streaming request, no tools, thinking all up front.** `discoverDestination` (`backend/src/services/claude.js:843–922`) sends one `messages.stream` with the system prompt (`discoverSystemWith`, `:701–727`) and one user line, no `tools`, and parses NDJSON lines as they complete; each parsed line becomes one `onCategory` call. The prompt says "Output all 8 categories in this order". With adaptive thinking, the W4 run produced exactly **one** thinking block per generation (12/12), all of it before the first text, 6,253 tokens median (4,213–14,105). So time to first category tracks thinking tokens, and nothing in the request can make the model stop thinking early.

**F-35-5 — The timing budget, derived from the W4 run files (this plan's one new derivation).**
- Control (thinking disabled): first category 10.7 s median (6.5–18.6 s); first stream event about 0.7–1.3 s; text emitted at about 250 output tokens/s; a category is 11–12 items, about 2.3 k tokens. **The first category is 1 s of latency plus about 10 s of writing.**
- Thinking on: first category 44.2 s median; the gap between consecutive categories is **unchanged** (9.5 s median against 9.0 s), so the whole penalty is the up-front block. 6,253 thinking tokens over about 33 s is roughly **190 tokens/s**.
- The gate (§5) is control + 5 s. **Five seconds is about 900–1,000 thinking tokens.** Any design that keeps thinking on must either keep the thinking that precedes the first category under that, or make the first category not wait on it.

**F-35-6 — Thinking interleaves across tool calls on Haiku 5.5; forced tool choice skips it.** Adaptive thinking enables interleaved thinking automatically on the 4.6+ family (migration guide, no header). The Haiku 5.5 guide adds two constraints this plan must respect: a **forced** `tool_choice` (`any` or a named tool) makes the response start with the tool call and **no thinking block**, so a staged design must use `tool_choice: { type: 'auto' }` and tell the model in the prompt when to call the tool; and `disable_parallel_tool_use: true` still works with `auto`, which is the one lever that can hold the model to one category per turn. Whether Haiku 5.5 at `low` thinks a *little* before each call or still plans everything before the first call is **not documented** and must be measured (W0 probe). Thinking blocks must be passed back unmodified with each `tool_result`, and the conversation must stay append-only (preserved thinking, breaking change 5).

**F-35-7 — The co-pilot already runs this loop shape.** `streamCopilotResponse` (`claude.js:1296–1320`) streams each step with `cache_control` on the system block, keeps the tools list identical between iterations, replays the assistant content (thinking blocks included) plus one `tool_result` per call, and sends a `{ type: 'ping' }` every 8 s (`COPILOT_PING_INTERVAL_MS`) so Cloudflare's 100 s no-bytes timeout never fires. A staged Discovery loop reuses this shape; it does not invent one. Prompt caching on Haiku 5.5 needs a 512-token prefix (skill, prompt-caching); the discovery system prompt is about 1.7 k tokens.

**F-35-8 — Settings are keyed by model and fixed per workload.** `MODEL_PROFILES['claude-haiku-5-5'].discovery` is `{ maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' }` with the `D-34-10` comment beside it (`claude.js:76–81`). `requestSettings` builds the body from `{ model, maxTokens, thinking, effort }` and a `format` (`:124`). Effort is never varied per request (prompt cache). Haiku 4.5's rollback row (`maxTokens: 64000`, no thinking) and its prompt rules must keep sending exactly the pre-W3 body (`backend/tests/claude.test.js` pins).

**F-35-9 — One generation per destination (D-33-1) is in-process and keyed by destination id.** `getRunningGeneration` / `runCatalogueGeneration` (`backend/src/services/discoveryGeneration.js:35–60, 147`) register one promise per destination and notify per-category listeners after each category is inserted. The route's join path, the daily cap (`routes/discovery.js:320`) and the co-pilot kick all assume **one** model conversation per generation. Option 3 (parallel requests) would have to change that assumption; options 1, 2 and 4 do not.

**F-35-10 — No production measure of cold-generation frequency exists, but the tables can answer part of it.** `discovery_generation_daily (destination_id, utc_date, count)` (migration 017) persists every finished generation per UTC day, and `discovery_destinations.generation_count` is a lifetime counter (migration 016). Together they give, read-only, how many *first* generations happened per week and on which destinations. What they cannot say is whether a traveller was looking: the route logs `[discover] destination=…` only when a generation starts (`claude.js:832`) and logs nothing on the fresh path, so the ratio of cold opens to all opens is unmeasurable today. Trippy keeps no HTTP request log (Plan 33, "What is not recoverable").

**F-35-12 — A place the verifier could not reach on the day is re-queued only by the next generation, never by an open.** Verification is fire-and-forget per category (`discoveryGeneration.js:123`) at `'background'` priority, about **4.14 provider requests per place** (Plan 26 F-26-24) against 1,000 a day and 50 Google escalations. When the budget runs out the remaining rows are marked `provenance = 'pending'` and left (`discoveryVerify.js:91`). `enqueueForVerification` folds a destination's pending rows back into the queue (`:619–629`), but it is called **only** from the generation pipeline. A fresh-cache open (`routes/discovery.js:250`) calls nothing, so a pending row waits for that city's next "show more" or its 7-day stale refresh. Three 90-place generations in one day are about 1,100 requests, so pre-warming a three-city trip would leave the tail of the third city `pending`, with no "Verified" label (D-27-1) and no verified rank term, until that city generates again. This is the one real consequence of option 1, and it is a defect in the re-queue trigger, not in pre-warming: the module header's own intent is "a pending row gets retried the next time anyone browses that destination".

**F-35-11 — Decision markers checked** with the ENGINEERING.md grep over `routes/discovery.js`, `services/claude.js`, `services/discoveryGeneration.js`, `services/copilotGrounding.js`, `hooks/useDiscovery.js`, `pages/TripPage.jsx`, `components/discovery/DiscoveryPanel.jsx`: D-33-1/2/3, D-30-1, D-30-3, D-30-6, D-30-8/9 (co-pilot), D-34-1/2/5/6/7/9/10/12, Plan 12 G3/G4, Plan 7 decisions 3 and 4, Plan 21 D3/D4, Plan 26 W4.8. The ones this plan touches are listed in §2; none is reversed silently.

---

## 2. Which earlier decisions each wave touches

| Decision | What it says | Wave | How this plan treats it |
|---|---|---|---|
| **D-34-10** | Discovery keeps thinking off; Q-34-4 deferred, not closed. Re-open only with a design that changes when, or how, the first category arrives. | W1, W3 | This plan *is* that design. W3 switches the Haiku 5.5 profile to adaptive thinking only if W1's gate passes. The exact-count line (Plan 34 W4) ships with it. |
| **D-34-1** (and its "Discovery is excluded" line) | API-enforced JSON schemas for one-object outputs; discovery excluded because its NDJSON stream is the progressive reveal. | W1 | Staged emission keeps the progressive reveal and gains schema enforcement per category through a `strict` tool. D-34-1's exclusion is **amended, not reversed**: the NDJSON parse stays as the Haiku 4.5 rollback path. Recorded as D-35-4. |
| **D-34-5** (schema budget) | Never add an optional property to a structured-output schema. | W0, W1 | The `emit_category` tool schema is compiled through the existing `schemaProbe.mjs` before W1, and holds the same budget rule: every item field required, `null` for "not given". |
| **D-30-1** (settings keyed by model) | Request settings live under the model that accepts them. | W1, W3 | The emission mode (`'stream'` or `'staged'`) joins the model-keyed discovery profile. Haiku 4.5's row keeps `'stream'`, so a one-constant rollback still sends the pre-W3 body. |
| **D-30-3** (classify the stop) | Every path branches on `stop_reason`. | W1 | Each staged step is classified; `end_turn` before eight categories is an incomplete generation, never silently accepted. |
| **D-30-6** (allowances from measurement) | `maxTokens` about 2× the largest observed output. | W1, W3 | Per-step allowance measured in W1 (the co-pilot's 16,000 is the starting point); the 48,000 single-request allowance no longer applies to a staged run. |
| **D-33-1/2/3** | One generation per destination; joiners get everything; "show more" joins. | W2 (join path copy) | Unchanged. Staged emission is still one generation with one registry entry. Option 3 is the only candidate that would have to touch these, and it is not recommended. |
| **D-30-9** (no thinking-display forwarding) | Rejected remedies that couple the product to thinking-display semantics. | all | Respected: the wait state is driven by counts the server knows (categories landed, elapsed), never by the model's thinking text. |
| **Plan 7 decision 4** (daily cap, "Trust criteria") | Three generations per destination per day. | W4 | A server-side pre-warm spends one of the three on each pre-warmed scope. Q-35-3 asks whether that is acceptable. |
| **Plan 21 D3/D4** (one error owner, page banner) | Mutation errors have one owner. | W2 | Unchanged; the wait state is not an error path. |

---

## 3. Decisions — PROVISIONAL until the named gate; stamp markers only when a wave lands

- **D-35-1 — Discovery's first category never waits on a whole-catalogue plan.** On a thinking-capable model the generation is staged: the model delivers each category through a tool call, so adaptive thinking interleaves per category and the first category waits only on the first category's thinking. *Gate:* W0 probe (go / no-go), then W1 (§5). Marker `D-35-1` on the staged loop in `claude.js`.
- **D-35-2 — A cold wait is always explained.** While Discovery has nothing to show for a destination, the panel says what is happening (first look at this city, curating eight categories), which category is being written, and how many have landed. The keep-alive carries those counts; the client never infers them from timing alone. *Gate:* W2 browser verification at 375 px and desktop. Marker `D-35-2` in `DiscoveryPanel.jsx` beside the wait state and in `routes/discovery.js` beside the keep-alive.
- **D-35-3 — Every stored scope of a trip is warmed when the trip is created or its scopes change.** Day 1 stays pre-warmed from the client as today; the server kicks the trip's other stored scopes (those with a country code) through `kickBackgroundGeneration`'s registry path, never a second mechanism, and a destination served fresh re-queues its `pending` rows (F-35-12). Owner ruling 2026-10-20 (Q-35-3). Marker `D-35-3` at the kick site and beside the fresh-path re-queue; a DECISIONS.md row.
- **D-35-4 — Amends D-34-1 for discovery.** On Haiku 5.5 each category is delivered as the input of a `strict` tool, so its shape is API-enforced and the NDJSON line parser is not on that path. The parser remains the Haiku 4.5 rollback path and is removed only with that row (Plan 34 W5). *Gate:* W1. Marker beside the tool schema constant; DECISIONS.md amends the D-34-1 row.
- **D-35-5 — Thinking on ships only through this plan's gate.** If W1 fails the first-category criterion, thinking stays off (D-34-10 stands), W2 ships on its own, and the failure is recorded so the question is not re-run without a new design. "Thinking on, explained by better copy" is explicitly **not** an outcome of this plan.

---

## 4. The candidates, evaluated

Each row answers: what the traveller gets, what it costs (money, latency, complexity), what it risks, and how `backend/scripts/modelEval` measures it.

### 4.1 Option 1 — Pre-warm every trip city or scope

**What it does.** When a trip is created or its scopes change, the server starts a background generation for every scope that has no fresh catalogue, through `kickBackgroundGeneration` (F-35-3), so by the time the traveller opens Discovery on Day 4's city it is warm.

**What the traveller gets.** Fewer cold opens on *existing* trips. **Nothing** on the two cases that matter most: a trip created seconds ago and opened straight away (the Plan 33 Bangkok case; a pre-warm at creation buys a few seconds' head start on a 44 s wait), and a city typed into Discovery's search box (`committedDestination`), which no pre-warm can anticipate.

**Cost.** Build: small (a service hook on `createTrip` and the scope-save path in `services/trips.js`, reusing the kick; no client change). Run: one generation per pre-warmed scope, about $0.014 on thinking-on (cents), one of the three daily generations per destination (Plan 7 decision 4; it matters only if the same city is "show more"d twice on the day it was created, and not at all when the shared catalogue is already fresh), and **about 370 verification requests per scope** (F-35-12) against 1,000 a day. Three new cities in one day exceed the day's budget, so the third city's tail stays `pending`.

**Risk.** Not spend: cents. The risk is F-35-12: a pre-warmed city opened a week later with its last 25 places unverified until it generates again. Closed inside W4 by re-queuing a destination's pending rows when it is served fresh, which is what the verifier's own header says should happen.

**Measured how.** Not through the model harness. W0's fresh-path log line gives cold opens against all opens before and after. The W0 production query is no longer needed to decide (the owner ruled on product grounds, §10); it stays as an optional read.

**Verdict.** A frequency reducer, not a latency fix, and the right product default for a multi-city trip: Day 1 warm and Day 4 cold is the inconsistency the owner named. There is no significant blocker. Ruled in Q-35-3 (revised default **yes**, scoped to stored scopes that carry a country code, kicked together at create and scope save, with the F-35-12 re-queue in the same wave).

### 4.2 Option 2 — Staged emission through an `emit_category` tool (recommended)

**What it does.** The request carries one tool, `emit_category({ category, items })`, with `strict: true`, `tool_choice: { type: 'auto' }`, and a prompt line telling the model to deliver each category by calling it, in order, one call per category. The server runs the co-pilot's loop shape (F-35-7): stream a step, on `tool_use` persist that category through the existing `handleCategory` path (`discoveryGeneration.js:60–130`, unchanged), answer with a one-line `tool_result`, repeat until eight categories or a non-`tool_use` stop. Thinking happens between calls, so the first category is preceded only by whatever the model thinks before its first call.

**What the traveller gets.** If the probe holds, a first category near today's time *and* the thinking-on quality. The per-category cadence is unchanged (F-35-5). Every category is schema-valid at the API (D-35-4): dropped lines become impossible.

**Cost.**
- *Latency.* One extra round trip per category, about 0.7–1.3 s each (F-35-5's first-event time), so about +7 s on total time, plus per-step thinking. Total time must not exceed W4's 116 s median (§5).
- *Money.* Output tokens as W4 (about 27 k, 27 % thinking). Input grows per step: the system prompt and tool (about 2 k) plus every earlier category's tool input (about 2.3 k each) and its thinking block, replayed. Uncached, roughly 85 k input tokens per generation, about $0.009 at Haiku 5.5's rate; with `cache_control` on the system block and the latest `tool_result` (F-35-7), most of it reads at a tenth of that. Expected cost per generation **$0.015–0.020** against W4's $0.0142 and today's $0.0093; measured in W1, not assumed.
- *Complexity.* A second emission path in `claude.js` selected by the model-keyed profile; a tool schema constant; scorer changes (reading tool inputs across calls instead of `calls[0]`'s text); new tests and pins. About a day of engineering (§9).

**Risk, in order of likelihood.**
1. **The model still plans everything before the first call.** Then step 1 thinks as long as W4 did and the gate fails. This is the single unknown that decides the plan, and W0's probe measures it before any product code.
2. **The model batches several `emit_category` calls in one turn** after one thinking block. `disable_parallel_tool_use: true` (F-35-6) holds it to one per turn; the probe measures both settings.
3. **A `strict` schema with eight item fields and a `null`-able `lat`/`lng` fails to compile.** The W0 `schemaProbe.mjs` run settles this before W1.
4. **The model ends the turn early** (`end_turn` after five categories). Classified under D-30-3 as an incomplete generation; the `MIN_CATEGORIES_WITH_ITEMS` guard (`claude.js:735`) still applies.

**Measured how.** W0: `stagedEmissionProbe.mjs` (new, standalone like `schemaProbe.mjs`): 3 destinations × 2 runs × {parallel allowed, disabled}, recording per step the exact `thinking_tokens`, time to the first `tool_use`, calls per turn, and any prose. W1: `discovery.mjs --profile v-staged-adaptive-low` against a same-day `control`, 12 runs each, scored by the extended `lib/score/discovery.mjs`, then `discoverySpotCheck.mjs` if volume passes. The harness calls the real `discoverDestination` with the profile; `categoryTimes` come from `onCategory` exactly as today.

**Verdict.** The sound change. It addresses the cause (no tool boundary, so no interleaving) rather than hiding the wait or spreading the risk thinner.

### 4.3 Option 3 — Parallel per-category requests

**What it does.** Eight requests at once, each "curate the *food* of X", each with its own thinking; the first category arrives when the fastest finishes. A variant, 3b, chains them: each request excludes the names the previous ones returned, so cross-category duplicates are prevented at the cost of running serially.

**What the traveller gets.** 3a: a first category after roughly 1 s plus one category's thinking plus 10 s of writing, which is the same arithmetic as option 2's first step, so *not clearly faster*. 3b: the same first category, and a total time of eight serial requests.

**Cost.** 3a multiplies input by eight (cheap on Haiku 5.5, about $0.002 even with a 400-name exclusion list, and the system prompt caches) and opens eight concurrent streams per cold open, 24 at the harness's concurrency 3, against rate limits this plan cannot see. The real cost is structural: the prompt's "do not repeat the same place across categories" cannot hold across parallel requests (`duplicateDrops`, the scorer's cross-category measure, would rise); the daily cap, batch number, `MIN_CATEGORIES` guard and failure semantics all assume one conversation (F-35-9); the D-33-1 registry would have to treat eight requests as one generation and a joiner would subscribe to eight; and the per-model prompt rules would need per-category variants, which re-pins every prompt. 3b avoids the duplicate problem and the registry problem but keeps the per-category prompt split and adds seven serial round trips; it is option 2 without the conversation, so the model cannot hold a place back for a later category, and it gains no schema enforcement.

**Risk.** Quality: a place that fits two categories lands in whichever request wrote it first (3a) or is excluded from the second by name only (3b). Operational: eight streams per cold city.

**Measured how.** Would need a new harness script (`discovery.mjs` calls one `discoverDestination`); the scorer would need per-request stitching. Not built unless option 2's probe fails and the owner asks for it (Q-35-2).

**Verdict.** Not recommended. It buys at best the same first-category time as option 2 and pays for it with the single-generation model.

### 4.4 Option 4 — A readable wait state (recommended, independent of the rest)

**What it does.** While a destination has nothing to show, the panel shows a **curation manifest** instead of three mute rectangles: the eight categories as a fixed list in the prompt's order, each row carrying its state. The server's keep-alive gains fields it already knows: `{ type: 'thinking', phase: 'generating' | 'joined', categoriesDone, writing }` where `writing` is the category currently expected (the prompt's fixed order), and one status event goes out before the first ping so the manifest appears at once. The client shows, in the panel's voice (design spec §12.9: quiet confidence, sentence case, no exclamation marks):

- one Cormorant sentence above the list: "First look at Ipoh. Trippy is curating eight categories; Essentials lands first." When joined: the same sentence (the traveller cannot tell and does not need to). After 60 s with nothing landed: "Still curating. Larger cities take longer." No countdown, no promised seconds;
- the manifest: eight rows, DM Mono tracked-uppercase labels from `CATEGORY_LABELS`, fixed height so nothing shifts as rows fill. A **landed** row shows its count in cream and is tappable (it calls the existing `handleCategorySelect`, so the traveller reads Essentials while Food is being written: that is the part that shortens the wait in the head). The **writing** row carries the panel's single gold element, the existing `.trip-live-dot` pulse (reduced-motion safe), and the word "writing". **Queued** rows sit in `--cream-mute`. Hairlines are `--ink-border`; the surface is `--ink-mid`; no literals (F-35-2's `#1a1410` and `rgba(201,160,80,0.08)` go);
- a DM Mono status line under the sentence: `CURATING · 2 OF 8`.

Once the active tab's categories have landed the manifest gives way to the cards, as the skeleton does today; other tabs still show their pulsing dot. Stale refresh and "show more" are unchanged (the grid is already on screen). At 375 px the sentence, status line and eight rows fit above the fold inside the panel; verified in W2, not assumed.

**What the traveller gets.** The same wait, named and navigable. On today's 11 s this is owed already; on any longer wait it is the difference between "broken" and "working", and the tappable landed rows mean the traveller is reading real places within the first category's time rather than watching a count.

**Cost.** About a day: route (two fields on an event the route already sends, both paths), `useDiscovery` (keep the fields in the entry), `DiscoveryPanel` (the manifest component, copy, tokens, row tap), tests, and a Playwright pass at 375 px and 1280 px using Plan 33's held-request technique so no generation is spent per screenshot. No model cost.

**Risk.** Copy that over-promises. The copy carries counts and category names, never times.

**Measured how.** Not through the model harness. Browser verification (§8) and `discoveryRouteCheck.mjs`, which already prints the SSE timeline with pings, extended to print the new fields.

**Verdict.** Ship it in every outcome. On its own it is not an answer to Q-34-4 (D-35-5); with option 2 it is what the traveller sees during the first category's thinking.

### 4.5 Rejected alternatives, recorded so they are not rediscovered

- **(a) Forward the model's thinking display as progress** (`display: 'summarized'` or `'updates'`). Same objection as D-30-9: a display artefact coupled to one model's semantics, and it does not shorten anything.
- **(b) A separate cheap planning call, then a writing call.** Adds a model call for work the model does anyway, and the plan's tokens are paid twice (once as output, once replayed as input). Option 2 gets the same effect from the tool boundary without a second request.
- **(c) A smaller or terser first category.** Changes the product to buy a number; F-35-5 shows writing is 10 of the 10.7 s, so only a *halved* first category would move the gate. Not a loading change.
- **(d) Thinking on with better copy as the end state.** The meet-in-the-middle case: accepting the measured 44 s because the other criteria passed. Forbidden by the owner's rule, and D-35-5 says so.
- **(e) `eager_input_streaming` on the tool**, so items stream inside a tool call. The client only renders complete categories, so it gains nothing, and eager streaming turns off the API's input validation, which is the point of D-35-4.

---

## 5. Gate and measurement

Everything runs through `backend/scripts/modelEval/`, under Plan 30's rules: D-30-7 (no owner data, no shared-catalogue writes, proved by side-effect counts), `--max-usd` caps, recorded request bodies, blinded qualitative reads, private fixtures never committed. Each wave re-captures only the pins it moves.

**W0 probe (go / no-go for W1).** `stagedEmissionProbe.mjs`, 3 destinations (Ipoh, Chengdu, Okinawa: a small, a large and a mixed-script case) × 2 runs × {`disable_parallel_tool_use` on, off}, adaptive thinking at `low`, the live system prompt plus the staging line and tool. Go to W1 only if, on the setting chosen:
- step-1 thinking tokens median **≤ 1,200** (F-35-5's budget with a little slack; the gate itself is time, measured in W1);
- one `emit_category` per turn on ≥ 10 of 12 turns-with-a-call;
- ≥ 1 thinking block on a step after the first (interleaving actually happens);
- no turn whose only content is prose; `end_turn` only after the eighth category.

Otherwise: record the numbers, do not build W1, raise Q-35-2.

**W1 gate (Discovery, staged, thinking on).** Against a same-day re-run of the shipped `control` (12 runs) on the same 6 destinations × first/exclusions:
- **first category ≤ control + 5 s** (median; the W4 control was 10.7 s, so about 15.7 s), measured by `categoryTimes[0].t` from `onCategory`, exactly as W4;
- total time median ≤ W4's thinking-on median (116 s), and reported against control;
- then every Plan 34 §5.1 *Discovery thinking-on* criterion: `end_turn` (or the staged equivalent: eighth category delivered then `end_turn`) 12/12 and 8/8 categories 12/12; items per category median ≥ control − 1; dropped lines 0 (structurally, with the schema); name-quality measures each ≤ control's; exclusion repeats ≤ control's; cost per usable item reported; verified share ≥ control's on `discoverySpotCheck.mjs`, run only if volume passes; thinking tokens exact;
- staged-specific: schema-valid tool input 96/96 categories; each category delivered exactly once; cross-category `duplicateDrops` ≤ control's; `max_tokens` stops 0 at the chosen per-step allowance; per-step allowance about 2× the largest step observed (D-30-6).

**W2 verification (wait state).** Not a model gate. Playwright at 375 × 812 and 1280 px, reduced motion on and off: the copy and count appear within one ping of opening a cold destination; counts advance as categories land; the join path shows the same copy; the stale path shows no skeleton; no console errors; tokens, not literals, in the computed styles.

**Budget.**

| Wave | Anthropic calls | Spend | Other providers |
|---|---|---|---|
| W0 | 12 probe generations + 1 schema compile | ≈ $0.20 | none; prod query is read-only |
| W1 | 12 staged + 12 control, spot check | ≈ $0.35 | spot check ≤ 1,000 Nominatim, ≤ 50 Google (process-local budgets) |
| W2 | none (held requests) | $0 | none |
| W3 | `discoveryRouteCheck.mjs` + live smoke | ≈ $0.05 | one real verification drain on a copy |
| **Total** | | **≈ $0.60** | |

---

## 6. Waves

Each wave starts by reading this plan, implements only that wave on its own branch, runs `cd backend; npm test` (and `cd frontend; npm test; npm run build` where the frontend is touched), updates its status line with evidence, and commits. A PR is optional (owner ruling 2026-10-19).

### W0 — Measure and probe (no production change)

**Status:** COMPLETE 2026-10-20 — **NO-GO.** Results in "W0 results" at the end of this wave. Spend $0.29 against the $0.20 budget; the overrun was a second probe pass, which saved every delivered category as evidence, and a strict-off diagnostic.

**Files.** `backend/scripts/modelEval/stagedEmissionProbe.mjs` (new); `schemaProbe.mjs` (one more schema to compile); `routes/discovery.js` (one log line); `README.md` under `modelEval`.

**Steps.**
1. **Production cold-open measure.** A read-only query the owner runs on the production database (or approves for a session; Plan 33 recorded that a session's prod read was refused by the permission check): per destination, the first `utc_date` in `discovery_generation_daily`, joined to `discovery_destinations`, for the last 90 days; and for each, whether that destination is some trip's Day 1 city (from `days`/`trip_scopes`). Report: first generations per week; share that were a Day 1 city; share with no trip at all (co-pilot kicks and typed searches). This answers Q-35-3.
2. **A fresh-path log line.** `[discover] served fresh destination=%s` beside the fresh return (`routes/discovery.js:250`), so from the next deploy the container log can give cold opens against all opens. Secret-free, one line, no table.
3. **Schema compile.** Add the `emit_category` input schema (category enum; `items`: array of objects with every item field required, `lat`/`lng` typed `['number','null']`, `aliases` array of strings) to `schemaProbe.mjs` and compile it as a `strict` tool on Haiku 5.5. If it is rejected as too complex, simplify under D-34-5's rules before W1.
4. **The probe.** `stagedEmissionProbe.mjs`: D-30-7 shape (no DB; the system prompt from `discoverySystemPrompt(HAIKU_55)` plus the staging line from a harness constant; recorder installed). Per step record `thinking_tokens` (exact), time to first `tool_use` `content_block_start`, calls per turn, text blocks, `stop_reason`. Print a per-run table and the §5 go / no-go.
5. Record the probe's numbers in this plan whatever they say.

**Acceptance.** The measure is recorded here with its query; the log line is in; the schema compiles; the probe's table is in this plan and the go / no-go is stated.

#### W0 results (2026-10-20, W0 working tree over `5581694`)

**Step 1: production cold generations (read-only).** Run with the owner's approval over ssh: `docker exec -i -w /app/backend trippy-trippy-1 node -` fed a script that opened `/app/data/trippy.db` with `readonly: true`. The query took each destination's first `utc_date` in `discovery_generation_daily`, joined it to `discovery_destinations`, and classified each against the trips that exist today. Day 1 means `days` at the trip's earliest date, `city_override` before `city`, folded with `canonicalGeoKey`. Scope means `trip_scopes.canonical_key`/`label`. Measured 2026-10-20 04:57 UTC, window from 2026-07-22 (90 days).
- 15 destinations have daily rows; **6 had their first generation in the window**: 1 in the week of 2026-07-27 (Chiang Mai), 3 in the week of 2026-09-14 (Kyoto, Singapore, Osaka), and 2 in the week of 2026-10-12 (Bangkok, Penang).
- **2 of 6 were a trip's Day 1 city** (Bangkok, Penang). **4 of 6 matched no current trip.** Those are co-pilot kicks, typed searches, or trips since deleted; the classification uses today's trips, so it cannot tell these apart. 0 were a non-Day-1 scope.
- Volume is too low to rank causes. It confirms only that cold generations are rare, and that most of them happen where no pre-warm could reach. Q-35-3 was ruled on product grounds, so this is recorded only.

**Step 2: fresh-path log line.** `[discover] served fresh destination=<id> places=<n>` sits beside the fresh return in `routes/discovery.js`. It uses the destination id, as the join line does, and contains no secrets. From the next deploy, cold opens against all opens = `[discover] destination=` lines against those plus `served fresh` and `joined running generation` lines.

**Step 3: schema compile.** `schemaProbe.mjs --only emit-category-haiku-5-5`. `EMIT_CATEGORY_INPUT_SCHEMA` (in `scripts/modelEval/lib/emitCategoryTool.mjs`: 11 required item fields, `lat`/`lng`/`localName` nullable, no optional property) was **ACCEPTED** as a `strict` tool on Haiku 5.5.
- First call 11.2 s and second call 15.7 s, with a forced tool choice and thinking disabled.
- The tool adds 965 input tokens.
- Both outputs passed `checkCategoryInput`, with 6 and 13 items. Cost $0.0033.

**Step 4: the probe.** `stagedEmissionProbe.mjs` with the settings §5 calls for: Ipoh, Chengdu and 冲绳 (Okinawa) × 2 runs × {`disable_parallel_tool_use` true, false}, adaptive thinking at `low`, and 16,000 per step. The prompt was the live Haiku 5.5 prompt with the exact-count volume line, and with the NDJSON opening replaced by `STAGING_PARAGRAPH`: one call per category, in order, one call per turn, no text. Run file `runs/staged-probe/2026-10-20T05-04-53-969Z.jsonl`, $0.187. All 12 runs delivered 8 distinct categories in order and ended `end_turn`.

| Setting | Thinking before first call, median (range) | First category, median (range) | Total time, median | One call per turn | Later steps with thinking | Go / no-go |
|---|---|---|---|---|---|---|
| parallel disabled | **2,268** (1,795–3,757) | **26.9 s** (25.6–37.3) | 114 s | 48/48 | 14 steps in 5 of 6 runs | **NO-GO** |
| parallel allowed | **2,980** (1,259–4,223) | **29.6 s** (23.0–32.1) | 104 s | 48/48 | 17 steps in 5 of 6 runs | **NO-GO** |

§5 criteria by setting: thinking ≤ 1,200 failed on both. One call per turn passed on both. Interleaving passed on both, but it is small: most later steps think 0 tokens, and only one run thought more than 1,200 after step 1. "No prose-only turn" failed on both: 2 closing messages per setting, two of which were self-critiques (below). No run ended early.

What the numbers mean:
1. **The tool boundary halves the up-front plan but does not spread it.** W4's single block was 6,253 tokens. Here step 1 thinks 1,259–4,223 and the rest of the run thinks almost nothing. The model still plans most of the catalogue before Essentials.
2. **Thinking was not the whole gap; the 1,200-token budget was necessary but not sufficient.** Step-1 medians (parallel disabled): first stream event 1.1 s, thinking phase 11.4 s, then **14.2 s to write the first category as tool input**. Later steps write a category in 10.3 s (median 2,632 output tokens), so the per-category pace matches NDJSON. The three runs closest to the budget (1,234–1,428 tokens, counting the diagnostic below) still landed at 22–24 s. Even with zero thinking, step 1 would land at about 15 s, which is the gate with no margin.
3. **Strict tool input corrupts CJK local names once a category has been replayed.** A second pass saved every delivered category (`…05-27-24-140Z.jsonl`, 4 runs before a session restart cut it, $0.065). Step 1 was clean on every run. From step 2 on, Chengdu's `localName` came back as control characters where 成都-style script belonged (`"\b\b\b…"`, `"\n\n\n\n"`). That was **10 items in one run and 79 of 80 later items in the other**, and one category collapsed to a single item whose local name was 32 backspaces. Ipoh (Latin-script local names) had 0 bad local names. The first pass showed the same signature without saving the inputs. Chengdu culture collapsed to 1 item in 3 of 4 runs. One Okinawa run delivered 21 items in total, 1–2 in seven of its eight categories. Two runs closed by reporting the junk themselves ("placeholder junk ('\n\n\n', '\ngg\n')"); for Okinawa that report is the model's account and was not read from saved inputs.
4. **Strict off is not a fix** (diagnostic, `--strict off`, Chengdu × 2, parallel disabled, `…05-53-45-867Z.jsonl`, $0.033). Local names stayed correct CJK, but the shape broke:
   - one category's `items` arrived as a 6,915-character JSON string;
   - three categories had items missing `sceneType`;
   - the other run shrank to 41 items, with 2–3 in four categories.
   Timing was the same: 22–23 s to the first category, 1,234–1,309 thinking tokens before the first call.
5. **Cost** was $0.007–0.019 per generation (median about $0.016), within Q-35-1's ceiling. It does not decide anything now.

**Verdict: NO-GO.** As §7 and Q-35-2 (ruled: the default) direct: W1 and W3 are not built. Thinking stays off and D-34-10 stands; D-35-1 and D-35-4 are not adopted; D-35-5 applies. W2 and W4 proceed. This records the result so it is not re-run without a new design. A re-attempt would have to answer three things together:
- a first-category writing time near 14 s, before any thinking;
- step-1 planning that the tool boundary does not spread;
- a strict-decoding defect on non-Latin strings across turns, which no prompt can address.

The probe and the compile probe stay in the harness, so a future model can be measured with one command (`--strict on|off` included).

### W1 — Staged emission in `claude.js`, measured (D-35-1, D-35-4)

**Status:** NOT BUILT — W0 was a NO-GO (2026-10-20). Closed under Q-35-2 as ruled; kept below as the design a future attempt would start from.

**Files.** `backend/src/services/claude.js`; `backend/tests/claude.test.js`; `backend/scripts/modelEval/profiles.mjs`, `lib/score/discovery.mjs`, `lib/discoveryPromptVariants.mjs`, `README.md`; `docs/DECISIONS.md` (provisional row).

**Design.**
- `MODEL_PROFILES[model].discovery` gains `emission: 'stream' | 'staged'` (a service-level key, stripped before `requestSettings`, as `format` is). Haiku 5.5 **stays `'stream'` with thinking disabled in this wave**; the staged path is reachable only through the harness profile `v-staged-adaptive-low = { model: HAIKU_55, maxTokens: <measured>, effort: 'low', emission: 'staged', promptVariant: 'exact-count-staged' }`. Haiku 4.5's row is untouched.
- `discoverDestination(destination, exclusions, onCategory, profile)` dispatches on `profile.emission`. The staged path: `EMIT_CATEGORY_TOOL` (frozen, `strict: true`); system prompt = `discoverSystemWith(rules)` with the output-format paragraph replaced by the staging instruction for models whose profile is staged (the rules object gains an `emission` paragraph keyed by model, so Haiku 4.5's prompt pin is byte-identical); `tool_choice: { type: 'auto', disable_parallel_tool_use: <from W0> }`; loop as F-35-7 with `cache_control` on the system block and on the latest `tool_result`; each `tool_use` → `canonicalizeCategoryName`, the same sanitise-and-dedupe as `processLine`, `onCategory`; `tool_result` content `{"received":"food","remaining":5}`; stop classification per step (D-30-3), `end_turn` before eight categories → the existing insufficient-yield / incomplete error; the `[discover] end …` log line reports steps and thinking tokens.
- Per-step `maxTokens` measured: start at 16,000, set to about 2× the largest observed step (D-30-6).
- Scorer: read tool inputs across all `calls` (not `calls[0]`'s text) when `settings.emission === 'staged'`; add `stepsCount`, `firstToolUseMs`, per-step thinking; keep every existing measure so control scores unchanged.
- Tests: a staged pin (request body hash for step 1 and step 2, including the replayed thinking block shape), a mocked eight-step loop delivering eight categories in order, an `end_turn` after five, a `max_tokens` step, a refusal step, a duplicate category delivered twice (second ignored, logged), a schema-budget assertion on `EMIT_CATEGORY_TOOL` (no optional properties).

**Steps.**
1. Implement behind the profile key; suite green; existing discovery pins unchanged.
2. `discovery.mjs --profile control` and `--profile v-staged-adaptive-low`, 12 each, `--concurrency 3`, same day.
3. Score; spot check if volume passes; wellness row read as W4 did (Q-27-6 evidence).
4. Record the table here against both the same-day control and the W4 thinking-on run.

**Acceptance.** §5 W1 gate. On pass: proceed to W3. On fail: D-35-5 applies; record and raise Q-35-2; the staged code stays behind the profile key only if the owner wants a later attempt, otherwise it is removed in the same wave (no dead paths).

### W2 — Readable wait state (D-35-2)

**Status:** COMPLETE 2026-10-20 on branch `claude/magical-leavitt-781091` (over `c97b361`), not deployed. Record in "W2 results" at the end of this wave.

**Files.** `backend/src/routes/discovery.js` (both keep-alives and a status event), `backend/tests/discovery.test.js`; `frontend/src/hooks/useDiscovery.js`, `useDiscovery.test.js`; `frontend/src/components/discovery/DiscoveryPanel.jsx`, `DiscoveryPanel.test.jsx`; `frontend/src/index.css` only if a class is needed beyond the existing `.trip-live-dot`.

**Steps.**
1. Route: before the first ping on the generate and join paths, `write({ type: 'status', phase, categoriesDone, writing })`; the 8 s ping carries the same fields. `writing` is `DISCOVERY_CATEGORIES[categoriesDone]` (the prompt's fixed order). `discoveryRouteCheck.mjs` prints them.
2. Hook: keep `phase`, `categoriesDone`, `writing`, `startedAt` in the entry; clear on `done`/`error`.
3. Panel: replace the bare `<TabSkeleton />` case with the curation manifest from §4.4 (copy as ruled in Q-35-4); tokens instead of literals; `CATEGORY_LABELS` for the row labels; landed rows call `handleCategorySelect`; the writing row uses the existing `.trip-live-dot`; fixed row heights so the list never reflows; reduced motion respected.
4. Tests: route emits status then pings with advancing counts on both paths; hook stores and clears them; panel renders the sentence and eight rows for `generating` and `joined`, advances the landed/writing/queued states as categories arrive, switches tab on a landed-row tap, shows the 60 s line, and shows nothing of it on stale or fresh.
5. Playwright pass per §5 W2, on a dev-DB copy with Plan 33's held-request technique; screenshots at 375 px and 1280 px kept in the wave record.

**Acceptance.** §5 W2 verification; frontend suite and build green; backend suite green.

#### W2 results (2026-10-20)

**What shipped.**
- **Progress has one source: the D-33-1 registry entry.** `services/discoveryGeneration.js` records each delivered category before the leader's `onCategory` and the joiners' listeners fire. `getRunningGeneration(id)` gains `progress()`, which returns `generationProgress(delivered, first)`. So the generate path and the join path cannot disagree.
- **The event contract** is `{ phase, categoriesDone, writing, first }`, on a `status` event and on the 8 s `thinking` keep-alive, on both paths. The fresh path is untouched: it sends no status and no ping.
  - `phase` is `'generating'` or `'joined'`.
  - `writing` is the category after the *last delivered* one in `DISCOVERY_CATEGORIES` order, or `null` after wellness. It does not index by count, so a category the model skips does not leave the pulse a row behind.
  - `first` is `!useExclusions`: true on a true miss, false on a stale refresh or "show more".
- **Hook** (`frontend/src/hooks/useDiscovery.js`; the plan's file list says `hooks/`, which is where it lives). Each entry keeps `progress` and `startedAt`, and both are cleared on `done`, on both error branches and on every exit path.
- **Panel.** `TabSkeleton` (literal colours) is deleted. `CurationManifest` renders under the same condition: eight fixed 44 px rows in prompt order, using the Q-35-4 copy and `.discovery-manifest*` classes in `index.css` (tokens only).
  - A landed row is a button that calls `handleCategorySelect`. A category that is reachable only under "More" selects the More tab.
  - The row being written carries `.trip-live-dot` on `var(--gold)`, the manifest's only gold element.
  - A delivered row with nothing to show reads `—`; queued rows are `--cream-mute`.
  - The "Still curating" line replaces the sentence at 60 s while `categoriesDone` is 0.
- `discoveryRouteCheck.mjs` prints the new fields. It was not run, because it spends a real generation; W3's route check is the place for it.
- `D-35-2` markers sit beside the registry helper, both route keep-alives, the hook parser, and the manifest component and its render site.

**Deviations from the steps above, all additive.**
1. A `status` event also goes out **after every delivered category**, not only before the first ping. Without it, the counts would trail a landed category by up to 8 s.
2. `first` was added so that "First look at {city}." is never shown on a refresh. On a stale refresh with one empty tab, the manifest shows the status line and rows with no sentence. That adds no new copy.
3. `discoveryGeneration.js` is touched (registry progress) as well as the route.
4. The route's generate path looks up the registry entry on first use and then holds it. The registry deletes the entry when the generation settles, so a late write must never dereference a missing entry.

**Tests.**
- Backend: **1232 passed, 6 skipped** (45 files, 1 skipped). Of those, 13 are new:
  - 6 `generationProgress` cases and 2 `progress()` cases;
  - 5 route cases: status 0/essentials/first:true before any category, then advancing; stale refresh `first:false`, with a status even for an empty category; a joiner's status after the saved chunks; pings carrying progress on both paths (fake `setInterval`); the fresh path emitting none.
- Frontend: **371 passed** (44 files), with 4 new hook tests and 9 new manifest tests. `npm run build` is green.

**Browser verification (built-in pane, dev-DB copy, no generation spent).**
- **Setup.** The worktree's backend ran on a copy of the dev database, with `ANTHROPIC_API_KEY` blanked in its untracked `.env`, so no generation could be paid for even by accident. The login was a 1-day `auth_sessions` row, deleted afterwards.
- **Held requests (Plan 33's technique, driven from the page).** `window.fetch` was replaced only for `/discover`, with a `ReadableStream` the session wrote SSE events into by hand. The items were real Shanghai rows, read once from a fresh catalogue.
- **Backend log for the whole pass:** one `[discover] served fresh destination=9` line (that read) and **zero** `[discover] destination=` generation lines. The page was opened through an SPA click, so the Day 1 pre-warm was held too.
- **Checked:**
  - **First look:** the sentence and `CURATING · 0 OF 8` appear on the first status. At 375 × 812 the manifest ends at 594 px, above the fold.
  - **Counts advance as categories land.** With the traveller on Food, Essentials 12 and Culture 11 show as cream buttons, and Food is writing.
  - **A real click on the Essentials row** switches to Essentials and renders its 12 cards.
  - **The joined phase** is the same frame (keep-alive with `phase: 'joined'`).
  - **The end of the stream** gives way to cards, with every tab showing its count.
  - **A typed search (Ipoh) at 1280 px** shows the first-look frame, and at 60 s the "Still curating" line (82 s elapsed, `categoriesDone` 0).
  - **Computed styles resolve to the tokens:** rows `--ink-mid`, hairlines `--ink-border`, landed `--cream`, queued `--cream-mute`, and the dot `--gold`, the only element in the manifest computing to gold. Rows are 44 px each. Fonts are Cormorant (sentence) and DM Mono (rows).
  - **No console errors** from the panel. The only entries were the login's 401/429, from before it opened.
- **Screenshots:** `docs/assets/plan35-w2/` holds `375-1-first-look.jpg`, `375-2-two-landed.jpg`, `1280-1-three-landed-joined.jpg`, `1280-2-first-look.jpg` and `1280-3-still-curating.jpg`.

**Not verified here.**
- **Reduced motion was not emulated.** The pane cannot set `prefers-reduced-motion`. The existing reduced-motion block that stops `.trip-live-dot` was confirmed present in the loaded CSSOM, and the manifest adds no animation of its own.
- **The pane cannot show the pulse.** It runs the tab hidden, so the dot shows a frozen frame.
- **The real route was not exercised end to end in a browser**, because that would spend a generation. It is covered by the route tests, and W3's `discoveryRouteCheck.mjs` run (or the owner's production click-script) is the first live look.
- **The 1280 px sentence wrapped its last word** ("lands / first.") inside the 560 px column (frame 1280-1). `text-wrap: pretty` was added to `.discovery-manifest-sentence` after the pass. It was not re-screenshotted.

### W3 — Switch Haiku 5.5 discovery to staged, thinking on (D-34-10 reopened) and deploy

**Status:** NOT BUILT — W1 was not built (W0 NO-GO, 2026-10-20). D-34-10 stands.

**Files.** `claude.js` (profile row: drop `thinking`, `emission: 'staged'`, measured `maxTokens`; `DISCOVERY_SELECTION_RULES['claude-haiku-5-5']` takes the exact-count volume line and the staging paragraph), `claude.test.js` (re-capture only the Haiku 5.5 discovery body and prompt pins), `profiles.mjs` (`control` becomes the staged profile; `assertControlIsLive` enforces it), `docs/DECISIONS.md`, `docs/ENGINEERING.md` (Discovery paragraph).

**Steps.**
1. Flip the row; suite green; Haiku 4.5 pins unchanged.
2. `discoveryRouteCheck.mjs` on a fresh destination: SSE timeline shows the status event, pings with counts, first category time, eight categories, verification drain.
3. `LIVE_ANTHROPIC=1` smoke.
4. `/deploy` with the standard backup ritual. Owner production click-script: create a trip for a never-opened city, open Discover, read the wait copy, time the first category by eye, confirm eight categories and one `[discover] destination=` line; then reopen within a minute to see the join copy.

**Acceptance.** Owner production pass recorded; the standing log checks from Plan 30 (`max_tokens`/`refusal` stops, under-8-category generations) extended with "any generation with more than eight steps or a duplicate category".

**Rollback.** One commit: the row returns to `thinking: disabled`, `emission: 'stream'`, 48,000, and variant A's volume line. Pins return with it.

### W4 — Server-side pre-warm of trip scopes, and pending rows re-queued on open (D-35-3)

**Status:** COMPLETE 2026-10-20, not deployed. Backend suite green (45 files passed, 1 skipped as before). Acceptance passed on a dev-DB copy (results below). D-35-3 is stamped in code; its DECISIONS.md row is added at merge.

**Files.** `backend/src/services/trips.js` (`createTrip`, the scope-save path); a small `services/discoveryPrewarm.js` that calls `kickBackgroundGeneration` for each stored scope that carries a country code and has no fresh catalogue, respecting the daily cap and the D-33-1 registry; `routes/discovery.js` fresh path; `services/discoveryVerify.js` (an exported re-queue for pending rows that `enqueueForVerification` already contains, callable with no new ids); tests for each.

**Steps.**
1. Pre-warm: on create and on scope save, kick every stored scope with a country code (a scope without one is skipped, never guessed: Plan 26 W4.8's no-country table stays the route's business), all at once rather than serially, since generation is the slow part and the Nominatim pacer already serialises verification. Never for a scope already fresh or already generating. One log line per kick. Day 1's client pre-warm stays as it is.
2. F-35-12: when the fresh path serves a destination that has `pending` rows, re-queue them (the fold-back `enqueueForVerification` already does, with an empty id list). This is the verifier header's stated intent; it also benefits every pending row left by any earlier budget exhaustion, pre-warm or not.
3. Measure with the W0 fresh-path log line after a week: cold opens before and after; and the `[discoveryVerify] budget status` line on a three-scope creation day.

**Acceptance.** Suite green; the kicks are observable in the log; a three-scope trip created on a dev-DB copy shows three `[discover] destination=` lines, one registry entry each, the daily counter at 1 per destination; a destination with pending rows served fresh drains them; the resolver budget status is reported in the wave record.

#### W4 results (2026-10-20, working tree over `c97b361`)

**What shipped.**
- `services/discoveryPrewarm.js` (new) holds `kickBackgroundGeneration`, moved verbatim from `copilotGrounding.js` (only its log prefix changed), and `prewarmTripScopes`. The co-pilot search imports the kick from there, so there is still one mechanism. It moved because `trips.js` now calls the pre-warm and `copilotGrounding.js` imports `trips.js`. Leaving it in place would have made an import cycle. It also could not go into `discoveryGeneration.js`: the co-pilot tests observe `runCatalogueGeneration` across the module boundary, and an internal call would bypass that.
- `prewarmTripScopes` skips scopes with no country code, duplicate keys, and destinations that are fresh, generating or at the daily cap. Everything else is kicked at once, with one `[discoveryPrewarm] kick trip=… destination=…|CC label=… merge=…` line each.
- `createTrip` calls it after its transaction commits. `updateTrip` calls it after the chip reconcile commits.
- **Deviation, for the owner to confirm:** `createTrip` takes `{ prewarmDiscovery }`, and MCP `apply_draft` passes `false`. The MCP path never calls Anthropic (DECISIONS.md, Plan 28 cost boundary). Its `createTrip` also runs inside the uncommitted D-28-3 transaction, so a kick there could mint catalogue rows for a trip that then rolls back. An MCP-created trip warms when it is opened (Day 1) or when its chips are next saved. Q-35-3 did not distinguish channels; pre-warming MCP-created trips too would mean reopening the Plan 28 boundary, which is a separate ruling.
- `discoveryVerify.requeuePendingVerification(db, destinationId)` is `enqueueForVerification`'s fold-back with no new ids. It adds one gate: when today's resolver budget is already spent, it starts no drain, because a drain then could only mark the same rows `pending` again. `routes/discovery.js` calls it on the fresh path, beside the W0 log line.
- `db/discoveryCatalogue.isCatalogueFresh` is the freshness rule for the co-pilot search and the pre-warm. The route keeps its own inline copy for now: W2 owned that part of the file during this wave. Switching it to the helper is a one-line follow-up after the merge.
- Tests: `tests/discoveryPrewarm.test.js` (9), `tests/discoveryFreshRequeue.test.js` (2), and 4 in `discoveryVerify.test.js`.
- `tests/setup/noDiscoveryPrewarm.js` stubs `prewarmTripScopes` for the unit project. Without it, 298 detached generations fired from unrelated trip tests. They passed only because this worktree had no API key. With a key loaded, each would have been a request the network guard fails (the DECISIONS.md section "Backend unit suite makes no network calls" gains a note on this at merge).

**Acceptance on a dev-DB copy** (`better-sqlite3` backup of `backend/data/trippy.db` into the session scratchpad; real Haiku 5.5 generation, real resolver; escalation capped at 10 for this run to bound Google spend; resolver budget at its default 1,000).
- **Pre-warm.** Trip "W4 QA Taiwan loop" had Tainan, Hualien and Taichung (`TW`) plus "Nowhereville" with no country. None of the three had a catalogue row before.
  - Three `[discoveryPrewarm] kick` lines and three `[discover] destination=… , Taiwan (TW)` lines, all within 0.3 s.
  - Registry: one running entry each (ids 24, 25, 26). No row was minted for the country-less scope.
  - All three ended `end_turn` with 8 categories and 0 dropped lines: 99, 78 and 81 items, the last at 83.8 s.
  - Daily counter: 1 per destination.
- **Resolver budget on the creation day.** The three drains ran together under the shared pacer. `[discoveryVerify] budget status` reported `resolverRequests=934/1000`, then `1001/1000` and `1004/1000`, at +712 s to +757 s (escalation `10/10`, reverify `0/150`). Then `daily resolver REQUEST budget exhausted (1000)`. Final state:
  - Tainan: 32 pending, 64 unverified, 3 verified.
  - Hualien: 5 pending, 73 unverified.
  - Taichung: 0 pending, 80 unverified, 1 verified.
  This is F-35-12 reproduced: a three-city creation day ends with the tail of the last-drained city `pending`.
- **Fresh open drains them.** A new process stood in for the next day, with fresh in-process budgets. It served Tainan through the route's fresh path: `[discover] served fresh destination=24 places=99`, 8 categories plus `done:cached`, and no generation. The re-queued drain took 112 s and 154 resolver requests (`154/1000`). It left Tainan at 0 pending, 95 unverified and 4 verified.
- **Spend:** about $0.06 Anthropic (six Haiku 5.5 generations: the first run's script exited mid-drain on the resolver's unref'd pacing timers, so the run was repeated from a fresh copy), about 2,160 Nominatim requests, and 30 Google escalations.
- **Observed, not in W4's scope:** Taiwan places verified at about 3 % (8 of 258). The cap of 10 escalations bounds this run, so it is not a production number. It is recorded only so that nobody reads it as a W4 effect.

**Step 3 (a week of production logs)** opens with the deploy. Compare `[discover] destination=` lines against `served fresh` and `joined running generation` lines before and after, and read the `[discoveryVerify] budget status` line on the first multi-city creation day.

### W5 — Close-out

**Status:** NOT STARTED.

Update `docs/ENGINEERING.md` ("Discovery and Photos": emission mode, thinking setting, the wait-state contract), `docs/DECISIONS.md` (one row per landed D-35 marker; amend D-34-1 and close D-34-10 / Q-34-4 with the outcome), Plan 34's header (Q-34-4 closed by Plan 35), and this header. `git diff --check`; record total spend.

---

## 7. Sequencing and rollback summary

- **Order.** W0 → (W1 ‖ W2 ‖ W4) → W3 → deploy → W5. W2 and W4 can start at once; W1 waits on W0's go. W2 and W4 touch different files (panel and hook against trips service and verifier); both touch `routes/discovery.js`, so they are merged in sequence, not side by side.
- **As run (2026-10-20): W0 said no-go, so the order is now W2 ‖ W4 → deploy → W5.** Q-35-2 was ruled before the probe (the default), so no new ruling is needed.
- **If W0 says no-go.** W2 still ships (it is owed on today's 11 s). W1/W3 are not built; Q-35-2 goes to the owner with the probe's numbers; this plan closes with D-34-10 standing and the reason recorded.
- **Rollback unit.** One model-keyed row in `MODEL_PROFILES` plus a redeploy (D-30-1). The staged path and the stream path coexist by model until Plan 34 W5 retires Haiku 4.5's row; at that point the stream path's future is decided there, not here.
- **No migration, so no schema rollback.**

---

## 8. Verification expectations

- Backend `npm test` green at every wave; the network guard means every model call in tests is stubbed.
- `LIVE_ANTHROPIC=1` smoke at W3 before deploy.
- Frontend `npm test` and `npm run build` at W2 and W3.
- Browser: W2 and W3 at 375 px first, then desktop; reduced motion checked; the join path exercised, not assumed.
- D-30-7 side-effect table printed and clean on every harness run.
- Never call a wave complete from the harness alone when the traveller-facing flow changed: W2 and W3 need the browser pass.

---

## 9. Estimate (provisional, one engineer)

| Wave | Effort |
|---|---|
| W0 measure, schema compile, probe | 3–4 h |
| W1 staged loop, scorer, tests, measurement | 1–1.5 days |
| W2 wait state, tests, browser pass | 0.5–1 day |
| W3 switch, route check, smoke, deploy, owner pass | 0.5 day |
| W4 pre-warm (conditional) | 0.5 day |
| W5 close-out | 1 h |

**Recommended session driver per wave.** W0 and W1: Opus 5.5 at high (a protocol change in `claude.js` with pins and a loop that must be right on every stop reason). W2: Sonnet 5.5 under orchestration (frontend work against a fixed contract and copy). W3–W5: Sonnet 5.5.

---

## 10. Owner questions

Each follows the plain-language shape: what it is, one example, the implication, the recommendation. A default applies unless the owner rules otherwise.

**Q-35-1 — If staged emission passes the gate, is the higher cost per cold city acceptable?**
- **Plain language.** Keeping thinking on and delivering categories one at a time costs more per brand-new city than today, because the model thinks (W4 measured +45 % per usable place) and because each category now costs a short extra exchange with the model.
- **Example.** Today a never-opened city costs about one cent to catalogue. With thinking on and staging it is expected to cost about one and a half to two cents, measured in W1. A fresh city is still free to reopen for seven days.
- **Implication.** At Trippy's volume this is cents per month. The gain is the W4 quality: no repeated places on "show more", cleaner aliases, more verified places, less padding.
- **Recommendation (default): yes**, provided W1 reports the measured number and it stays under 2× today's per-generation cost. The quality is what you asked for; the money is not the constraint.
- **Ruled 2026-10-20: OK (the default).**

**Q-35-2 — If the probe or W1 shows the first category still arrives late, what then?** *(Only asked on a W0 no-go or a W1 fail.)*
- **Plain language.** It is possible the model still does all its planning before the first category even with a tool to stop at. Then no loading change keeps thinking on without the wait.
- **Example.** The probe shows 4,000 thinking tokens before the first `emit_category` call on Taipei, so the first category would land at about 30 s.
- **Implication.** The choices are: keep thinking off and ship only the readable wait (no quality gain, no regression); or build the parallel-request variant (3a/3b) as a second attempt, which costs another measurement wave and trades away the one-generation model; or accept the wait, which this plan rules out (D-35-5).
- **Recommendation (default): keep thinking off, ship W2, record the probe's numbers against D-34-10 so the question is not re-run.** Build 3b only if you want a second attempt and accept that it reopens Plan 33's registry.
- **Ruled 2026-10-20: OK (the default).**

**Q-35-3 — Should the server pre-warm every scope of a trip, not only Day 1's city?**
- **Plain language.** When you create a three-city trip, Trippy would start cataloguing all three in the background, so Day 5's city is ready when you get to it. Today only Day 1's city is started, and only when you open the trip.
- **Example.** You create "Taiwan loop" with Taipei, Taichung and Kaohsiung. Today, opening Discover on the Kaohsiung day a week later means an 11 s wait (44 s with thinking on). With pre-warm it is instant, because Kaohsiung was catalogued the day you made the trip.
- **Implication.** Each pre-warmed city spends about two cents, one of that city's three daily generations, and about 90 places of verification budget out of a shared 1,000 requests a day, whether or not anyone opens it. It does nothing for a trip you open the moment you create it, nor for a city you type into Discovery's search. W0's production query will say how many cold opens were on a non-Day-1 city.
- **Original recommendation (default): no, until W0's measure shows that most cold generations were on cities that were already in a trip's scopes.** If it does, pre-warm **stored scopes only** (not every day's city), through the existing co-pilot kick, so there is one mechanism.
- **Owner, 2026-10-20:** on the fence; from the traveller's side it is intuitive that every city in the trip starts warming when the trip is created, and Day 1 warm with the rest cold is an inconsistent experience; asked whether there is a significant blocker and whether W0's measure is really needed first.
- **Assessment.** There is no significant blocker, and the measure is not needed to decide. The money is cents. The daily cap is spent only if the same city is "show more"d twice on its creation day. The one real consequence is F-35-12: three new cities in one day exceed the verification budget, and today a city's unreached places are re-queued only when it generates again, so a pre-warmed Kaohsiung opened a week later could show its last places without the "Verified" label until then. That is a defect in the re-queue trigger, and W4 fixes it at the cause by re-queuing pending rows when a city is served fresh. The two cases pre-warm cannot help remain: a trip opened the moment it is created on a non-Day-1 city, and a city typed into search; those are what W1 and W2 are for.
- **Revised default: yes.** Pre-warm every **stored scope that carries a country code**, all at once, on create and on scope save, through the co-pilot's existing kick (one mechanism), with the fresh-path re-queue in the same wave. Scopes without a country are skipped rather than guessed.
- **Ruled 2026-10-20: confirmed.** "Pre-warm every stored scope that carries a country code at trip create and scope save, with the fresh-path re-queue in W4."

**Q-35-4 — Is this the copy for the wait state?**
- **Plain language.** While a new city is being catalogued, the panel will show a short status line with a count and one sentence. This is the proposed wording.
- **Example.** Status line `CURATING · 2 OF 8`. Sentence: "First look at Ipoh. Trippy is curating eight categories; Essentials lands first." After a minute with nothing yet: "Still curating. Larger cities take longer." If you reopen the trip while it is still running you see the same lines with the count where it is.
- **Implication.** The copy names counts and categories and never promises seconds, so it stays true whether the first category takes 11 s or 44 s. Changing it later is a one-line edit.
- **Recommendation (default): adopt as written.** The one thing to decide is whether you want the city's name in the sentence; it is there because it tells you the request went to the right place, which the old skeleton never did.
- **Ruled 2026-10-20: yes, "or better if possible"; the UI must match, and a good waiting state should shorten the wait in the head.** Taken up in §4.4 and W2 as the curation manifest: eight fixed rows in the prompt's order, landed rows tappable so the traveller reads Essentials while Food is written, one gold pulse on the row being written, the sentence and count above. Copy stands as written.

---

## 11. Not verified, and how to close it

- **Whether Haiku 5.5 at `low` interleaves thinking per tool call rather than planning everything first.** CLOSED by W0 (2026-10-20): only a little; most of the plan still precedes the first call (W0 results).
- **Whether the `emit_category` strict schema compiles.** CLOSED by W0 step 3: it compiles; strict decoding then corrupts CJK `localName` after the first replayed category (W0 results, point 3).
- **How often production meets a cold open, and on which cities.** W0 step 1 measured the cold generations (6 in 90 days, 2 on a Day 1 city); the opens themselves are measurable from the next deploy through the fresh-path log line.
- **The per-generation cost of the staged loop with caching.** Measured by the W0 probe: $0.007–0.019, median about $0.016. W1 was not built.
- **Rate-limit behaviour of eight concurrent streams** (option 3a). Not measured, because option 3 is not recommended; it would have to be measured before any attempt.
