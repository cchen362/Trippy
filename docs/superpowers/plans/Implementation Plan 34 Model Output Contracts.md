# Implementation Plan 34 — Model Output Contracts

**Status:** 2026-10-19 — **WRITTEN, NOT APPROVED.** No wave has started. Nothing in this plan may begin before **Plan 30 Deploy B** is live and the owner has passed its production check (Plan 30 §7). Every decision below is **provisional** until its gate passes. Each owner question Q-34-n carries a default, which a wave follows unless the owner rules otherwise. Q-34-1, the only question that blocked a wave, was answered by the owner on 2026-10-19 (the default); the plan itself is still unapproved. Waves are implemented later via `/implement-milestone`. Each wave updates its own status line and lands through a branch and PR (`main` is PR-protected).

**Origin.** Plan 30 moved Trippy's four Anthropic workloads to the 5.5 models and froze every prompt so that model was the only variable. That freeze was right for a migration. It left two shortfalls that the owner accepted at the Plan 30 W4 gate, and they are contract defects, not model defects:

- **Flight numbers.** Extraction asks for "a single fenced JSON code block" in prose and finds it with a regex. Nothing in that contract says what shape `flightNumber` takes. Sonnet 4.6 always wrote `"KE012"`; Sonnet 5.5 writes `"KE012"` about half the time and `"012"` otherwise. [PR #9](https://github.com/cchen362/Trippy/pull/9) now repairs the value at the importer and MCP boundary (`normalizeFlightDetails`), but the contract still allows both forms.
- **Fare-promotion emails.** Rule 6 tells the model to answer `isTravelRelated: false` when the input "contains no extractable booking". The review screen, however, already has a separate message for "travel, but no booking". Every model measured, on every effort level, answers a fare-sale email as `true` with no bookings, contradicting rule 6. The rule conflates two different things.

The owner's standing rule, "No meeting in the middle" (`docs/ENGINEERING.md`, 2026-10-19), says to do the sound change, including contract work, rather than to keep patching around these. The sound change is to let the API enforce the shape. Structured outputs (`output_config.format` with a JSON schema) constrain decoding to the schema, so a malformed or mis-shaped answer cannot be produced. This plan applies that to the two workloads whose output the server parses as one JSON object. It also settles three measured questions that Plan 30 raised and left open (candidates c–e from the orchestrator's brief).

**Scope in one sentence:** replace the fenced-JSON-plus-regex output contract of booking extraction and photo descriptors with a schema enforced by the API, fix the two contract defects it exposes (flight-number shape and the three-way travel classification), and settle — by measurement through the Plan 30 harness — whether descriptors should author a fallback query, whether discovery can run with thinking on, and how the old models' rows leave the code when they retire.

**Not in scope.**
- No new product capability, tool, model call, or UI element.
- No change to which model serves a workload. The tier rulings stand: Plan 2A D3 (Sonnet for extraction) and Plan 10 D3 (Claude-authored descriptors).
- No change to the stored or API shape of an extraction. `import_artifacts.extracted_json`, the review screen, the MCP path and stored rows are untouched (D-34-3).
- No structured outputs for discovery. Its per-category NDJSON stream is the product's progressive reveal; a single schema-constrained object would arrive only at the end, and eight per-category requests would multiply cost and latency. (Recorded as considered and rejected, §3 D-34-1.)
- No change to the co-pilot. Its action channel is a tool call, already schema-shaped; Plan 30 W5 owns that path (owner ruling D-30-9, being implemented at the time of writing).
- No server-side fallback (`fallbacks`), no batch, no Opus, no Fable — same boundary as Plan 30.
- No database migration. 037 belongs to Plan 32.
- No fix to `lookups.js`'s carrier-code pattern. It rejects digit-bearing IATA codes such as `3K` or `U2`. This is found in passing (F-34-12) and becomes its own follow-up.

---

## 1. Validated facts — established 2026-10-19 at `ce841cf` (`origin/main`), do not re-derive

Code facts cite `origin/main` at `ce841cf`. Provider facts come from the pages named, fetched 2026-10-19, and from the `claude-api` skill bundled with Claude Code 2.1.299. Re-check provider facts at each deploy.

**F-34-1 — Two workloads parse model prose with a regex.**
- **Extraction.** `backend/src/services/claude.js:155` says "Output ONLY a single fenced JSON code block"; rule 9 (`:201`) repeats it. `extractBookings` (`:207`) calls `messages.create` (`:249`), classifies the stop (D-30-3), then takes the **last** fenced block (`:285`, `matchAll`) and `JSON.parse`s it. The only shape check is `typeof isTravelRelated === 'boolean' && Array.isArray(bookings)` (`:304`).
- **Photo descriptor.** `PHOTO_DESCRIPTOR_SYSTEM` (`:635`) asks for a fenced block. `generatePhotoDescriptor` (`:650`) takes the **first** fenced block (`:680`), truncates `photoQuery` to 8 words (`:692`), and coerces `sceneType` through `coerceSceneType` (`:146`, exact match against `SCENE_TYPES`, `:137`).
- **Both paths.** Every failure returns `null` (descriptor, Plan 10 D3 never-block) or a 502 (extraction). Plan 2A D4 is the decision that chose this contract: "fenced ```json block + strict server-side validation".
- **The other two workloads.** Discovery streams NDJSON lines (`processLine`, `:524`). The co-pilot acts only through a tool call.

**F-34-2 — `flightNumber` is unconstrained, and Trippy's own consumers expect digits.**
- The extraction prompt types it as `string | null` (`claude.js:179`).
- Trippy's flight pattern is `FLIGHT_NUMBER_RE = /^[0-9]{1,4}[A-Z]?$/` (`backend/src/services/lookups.js:376`). The carrier code is a separate field, `CARRIER_CODE_RE = /^[A-Z]{2,3}$/` (`:375`).
- `normalizeFlightQuery` (`:388`) 400s on a carrier code inside the number.
- `normalizeFlightDetails` (`backend/src/services/importer.js:151`) strips a leading airline code that matches `carrierCode` at the import boundary. It is shared with the MCP validator (`backend/src/services/mcp/validate.js:239`) and runs again on client-edited bookings at confirm (`importer.js:161`, `normalizeExtractedBooking`).
- Plan 30 W4 measured that 7 of 16 flight numbers were usable on Sonnet 5.5 and 0 of 16 on Sonnet 4.6, before PR #9.

**F-34-3 — The app already distinguishes three outcomes; only the prompt conflates them.**
- **Review screen.** `ExtractionReview.jsx:17` treats `!isTravelRelated || bookings.length === 0` as empty. Line 24 shows "We couldn't find any bookings in that." when `isTravelRelated` is true, and "This doesn't look like travel." when it is false.
- **New-trip modal.** `NewTripModal.jsx:159` treats both as empty and shows the model's `summary`.
- **Warnings.** `importer.js:218–225` (`computeWarnings`) emits `notTravelRelated` and `empty` independently.
- **The prompt.** Rule 6 (`claude.js:198`) tells the model to answer "travel, no booking" as `isTravelRelated: false`.
- **Measured.** The fixture `non-travel-fare-promo` is labelled from rule 6 (`false`). All four Plan 30 W4 profiles answered `true` with 0 bookings.
- **Unrepresented today.** The fourth combination, `isTravelRelated: false` *with* bookings, is invalid, and nothing rejects it.

**F-34-4 — Stored and served extraction shape.**
- `runExtraction` stores the normalised extraction as `import_artifacts.extracted_json` (`importer.js:311–325`).
- A content-hash duplicate re-serves the stored row with no model call (`:340–345`, Plan 2A D1). `getArtifactDetail` parses it back (`:454`).
- Old rows therefore reach `computeWarnings` and the frontend indefinitely, so the API shape is a compatibility contract with stored data.
- The PWA uses `registerType: 'autoUpdate'` (`frontend/vite.config.js:31`), so a tab left open across a deploy keeps the old bundle until reload.

**F-34-5 — Only `confidence.overall` is read; `confidence.fields` has no product reader.**
- `ExtractedBookingCard.jsx:34,73` reads `overall`.
- Nothing in `frontend/src` or `backend/src` reads `confidence.fields`; the Plan 30 harness scorer does (`backend/scripts/modelEval/lib/score/extraction.mjs:95`).
- `normalizeExtractedBooking` drops `null`, `undefined` and `''` from `details` before storing (`importer.js:165–171`), so "absent" and "null" already mean the same thing there.
- `type` falls back to `'other'` unless it is exactly one of `BOOKING_TYPES` (`importer.js:17,162`).

**F-34-6 — Structured outputs: supported models and schema rules** ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), fetched 2026-10-19).
- **Models.** The page's supported-model list includes `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`, which covers every model in `MODEL_PROFILES`. (The bundled skill's prose list omits Sonnet 4.6; the official page is authoritative.)
- **Supported.** `enum` (scalar values only); `const`; `anyOf`; `allOf` without `$ref`; `$ref`/`$defs`; `required`; `additionalProperties: false` (mandatory on every object); string `format` from a fixed list (not one that matches `YYYY-MM-DDTHH:MM`); array `minItems` of 0 or 1 only.
- **`pattern`.** Supported for simple regexes: anchors, `* + ?`, simple `{n,m}`, character classes, groups. Not supported: backreferences, lookaround, `\b`, large `{n,m}` ranges. "Complex patterns may result in 400 errors."
- **Not supported.** `minLength`/`maxLength`, numeric bounds, recursive schemas, `maxItems`.
- **Limits per request.** At most **24 optional parameters** and **16 parameters with union types** (`anyOf` or type arrays such as `["string","null"]`). There is also an internal compiled-grammar size limit ("Schema is too complex for compilation") and a 180 s compile timeout.
- **"Structured outputs don't guarantee the capitalization of string `enum` and `const` values."**
- **Output and failures.** The answer is the response's `text` block. On `stop_reason: "max_tokens"` the output "may be incomplete and not match your schema". On `"refusal"`, which is HTTP 200 and billed, "the refusal message takes precedence over schema constraints".
- **Compilation.** The first use of a schema compiles a grammar; compiled grammars are cached "for 24 hours from last use". Changing only `name`/`description` does not invalidate that cache; changing the schema structure does. Changing `output_config.format` invalidates the *prompt* cache. That is irrelevant here, because neither workload caches.
- **Reasoning fields.** "A property that asks for the model's thinking or step-by-step reasoning may lead to a `reasoning_extraction` refusal. Ask for a short explanation instead."

**F-34-7 — Structured outputs with adaptive thinking on Sonnet 5.5** ([Prompting Claude Sonnet 5.5 § Reasoning tasks with JSON output](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5#reasoning-tasks-with-json-output), fetched 2026-10-19).
- **Reasoning only in thinking.** "With structured outputs, the response text holds only the JSON, so the model can work the problem out only in its thinking. When it skips thinking, it can be less accurate." This happens "particularly at `low` and `medium` effort". Extraction runs at `medium` (Plan 30 W4) and thought on only 2 of 23 fixtures there.
- **Remedy.** Adding "Think the problem through before you answer." to the end of the system prompt makes the model think more often. At `low`/`medium` this "raises accuracy, though not to what the model reaches at `high`", with a larger rise in output tokens. `xhigh` is the most accurate.
- **Runaway thinking.** "With structured outputs at `low` and `medium` effort, the model occasionally keeps thinking until it reaches `max_tokens`. … Treat any response whose `stop_reason` is `"max_tokens"` as failed, even if its text holds valid JSON, and retry."
- **`between_tools`.** In a request without tools, `between_tools` means no thinking at all, and the guide recommends adaptive thinking instead. Neither workload sends tools.
- **Haiku 5.5.** The one documented interaction (migration guide, *Behavioral shifts*) is that with thinking *disabled* the model can skip a needed tool call when JSON output is also requested. Neither workload has tools. The descriptor runs at `low` with adaptive thinking (Plan 30 W2), not disabled.

**F-34-8 — The installed SDK, `@anthropic-ai/sdk` 0.135.0 (`backend/node_modules`).**
- **What it exposes.**
  - `client.messages.parse()` (`resources/messages/messages.d.ts:52`).
  - The helpers `@anthropic-ai/sdk/helpers/json-schema` (`jsonSchemaOutputFormat`) and `@anthropic-ai/sdk/helpers/zod` (`zodOutputFormat`).
  - The request type `output_config.format: { type: 'json_schema', schema }` (`JSONOutputFormat`, `messages.d.ts:3362`).
- **`parse()` throws before Trippy can classify the stop.** `parse()` runs `JSON.parse` (or the zod parser) on **every** `text` block and **throws** `AnthropicError("Failed to parse structured output …")` when one does not parse (`lib/parser.js`, `parseOutputFormat`). A `max_tokens` or `refusal` response therefore throws inside the SDK before Trippy's `classifyStop` (D-30-3) can name the cause.
- **The helpers send a different schema.** Both helpers rewrite the schema by default (`lib/transform-json-schema.js` moves unsupported constraints into descriptions), so the body sent differs from the schema written.
- **Zod is not a direct dependency.** `zod` 4.6.5 is present only as an optional peer of the SDK and a transitive dependency of the MCP packages; `backend/package.json` does not declare it.

**F-34-9 — Request bodies are sha256-pinned per workload** (`backend/tests/claude.test.js`, `origin/main`).
- Extraction `57a2bedd…` (`:1279`) and its Sonnet 4.6 rollback `eb6fafb2…` (`:1285`).
- Descriptor `dafd384a…` (`:1297`); the Haiku 4.5 descriptor row is pinned by structure, not by hash.
- Discovery `4feadef7…` (`:1310`) and its Haiku 4.5 rollback `0c8c2727…` (`:1316`).
- Discovery prompt texts `34c3742f…` / `b851c503…` (`:1457,1459`).
- `requestSettings` (`claude.js:110`) builds `model`, `max_tokens`, `thinking` and `output_config: { effort }` from a model-keyed profile (D-30-1). It has no notion of an output format yet.
- The opt-in live smoke `backend/tests/live/anthropic.live.test.js:111` asserts "fenced JSON parsed from text blocks".

**F-34-10 — The harness can measure a contract change only on a branch.**
- **How Plan 30 measured.** Plan 30 measured prompt variants on the wire (`lib/discoveryPromptVariants.mjs`, `lib/copilotPromptVariants.mjs`) without editing `claude.js`.
- **Why that fails here.** A contract change replaces the *parser* as well. The service function's regex would reject a schema-constrained answer, so a wire-only patch cannot exercise the real code path.
- **Before and after.** The honest comparison is the service code before (fresh W0 run on `main`) and after (the same fixtures on the wave's branch). `main` is PR-protected, so nothing reaches production until the gate passes.
- **Recorded runs.** Plan 30 W4 runs are on disk: `data/model-eval/runs/extraction/{control,baseline-46,…}/2026-10-18T16-3*.jsonl`. The descriptor runs are under `runs/descriptor/`.

**F-34-11 — Photo-query headroom is small after Plan 31.**
- **Today.** `selectPhoto` (`backend/src/services/unsplash.js:145`) retries a zero-result query with its first 4, then first 3, words (D-31-1, `:144`) before the scene fallback.
- **Measured headroom.** Fallbacks fell from **15 → 5 of 50** on cached payloads; about one recovered photo in five is a related-but-wrong place (Plan 31 §0.5).
- **Noise.** Run-to-run noise on the same 50 places was 14–20 fallbacks before Plan 31 (Plan 30 W2).
- **Discovery queries.** Discovery-authored `photoQuery` values (catalogue items) reach the same `selectPhoto` with no second query, so D-31-1's prefix retry must stay for that path whatever this plan decides.

**F-34-12 — Found in passing (not in scope).**
- `CARRIER_CODE_RE` and `FLIGHT_DESIGNATOR_RE` (`lookups.js:375,377`) accept letters only. They reject IATA codes containing a digit (`U2`, `3K`, `9W`), so a status lookup for such a flight 400s. This is true of manual entry today as well.
- The schema in §4.1 accepts the true IATA shape, so extraction will store `U2` correctly; only the lookup refuses it. This needs its own small follow-up, not this plan.

**F-34-13 — Discovery's thinking question, from Plan 30 W3's second pass.**
- **At adaptive `low`.** Haiku 5.5 treats "at least 8" as the target, landing at a median of 7.5 items per category. Its first category arrives at 35.9 s median.
- **What shipped.** Thinking disabled at `low` (variant A) gives 11 items per category and a first category at 11.6 s.
- **What was never measured.** Neither run tested an *exact-count* volume line with thinking on.
- **Profile.** The shipped profile is `{ maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' }` (`claude.js:39–74`). The prompt rules are keyed by model (`DISCOVERY_SELECTION_RULES`, `:348`).

**F-34-14 — Lifecycle** ([model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), per Plan 30 F-30-13; re-check at each deploy).
- `claude-haiku-4-5-20251001`: retirement not sooner than 2026-10-15, already passed.
- `claude-sonnet-4-6`: not sooner than 2027-02-17.
- Notice is at least 60 days before retirement.
- **Rows still in use.** Sonnet 4.6 is still the live co-pilot model until Plan 30 W5 switches it. Haiku 4.5's rows (descriptor, discovery, and its discovery prompt rules) are rollback-only.

---

## 2. Which earlier decisions each wave touches

| Decision | What it says | Touched by | How |
|---|---|---|---|
| **Plan 2A D3** | Extraction uses a Sonnet-tier model, single non-streaming call | — | Stands. No model or streaming change. |
| **Plan 2A D4** | Output contract: fenced JSON block + strict server-side validation | **W1** | **Fenced-block half superseded** by D-34-1; the strict-server-side-validation half stands and is extended (D-34-2). DECISIONS.md "Superseded" row. |
| **Plan 2A D6** | City fields are canonical English; local names in `localName`/stations | W1 | Stands; carried into the schema's field descriptions verbatim. |
| **Plan 2A D7** | Full extraction JSON retained; schema has bus/ferry, per-booking country codes, `assumptions[]` | W1 | Stands; the stored shape is unchanged (D-34-3). |
| **Plan 2A D1** | Content-hash dedupe re-serves a stored extraction | W1 | Stands; it is why the API shape cannot change (F-34-4). |
| **Plan 10 D3** | Descriptors authored by Claude; never block stop creation; stored on the stop | **W2, W3** | Stands. Every failure still returns `null`. W3 may add a second, unstored query. |
| **Plan 10 D8** | Closed scene-type vocabulary | **W2** | Stands; the schema's `enum` is built from `SCENE_TYPES`, so the vocabulary has one source. |
| **Plan 10 D2** | Tier count (already superseded by D-31-1) | W3 | Only if W3's gate passes (D-34-9). |
| **Plan 31 D-31-1** | Zero-result retry with 4- then 3-word prefix | **W3** | Measured against a model-authored broad query; superseded **only** on the descriptor path and **only** if the gate passes. |
| **Plan 30 D-30-1** | Request settings keyed by model | W1, W2, W5 | Stands. The output format is a *workload* property merged into `output_config` beside the model's `effort` (D-34-6). |
| **Plan 30 D-30-3** | Classify the stop before trusting content; a retry is the caller's choice, never silent | W1, W2 | Stands; it is the reason for D-34-2. Q-34-3: measured `max_tokens` stops lead first to effort `high`, and to a logged retry only if `high` also runs away. |
| **Plan 30 D-30-6** | Allowances and effort chosen from measurement | W1 | Extraction's effort may move from `medium` to `high` under Q-34-3. |
| **Plan 30 W3 profile** | Discovery on Haiku 5.5 with thinking disabled | **W4** | Replaced only if thinking-on matches it (D-34-10). |
| **Plan 30 D-30-5 / W6** | Haiku first; old rows kept for rollback | **W5** | Rows removed only on a deprecation notice (D-34-11). |

---

## 3. Decisions — PROVISIONAL until the named gate; stamp markers only when a wave lands

- **D-34-1 — Output the server parses as one JSON object is constrained by the API, never by prompt text and a regex.**
  - **What changes.** Extraction and the photo descriptor send `output_config.format: { type: 'json_schema', schema }`. Their prompts lose every output-format instruction (`claude.js:155`, `:201`, `:635`). The fenced-block regexes (`:285`, `:680`) are deleted, not kept as a fallback.
  - **Discovery is excluded.** Its NDJSON stream *is* the progressive reveal (Not in scope).
  - **The co-pilot is excluded.** Its action channel is already a tool schema.
  - *Gate:* W1 (extraction) and W2 (descriptor), each on its own measurement.
  - Marker `D-34-1` above each schema constant. DECISIONS.md moves Plan 2A D4 to "Superseded".
- **D-34-2 — Call `messages.create` with a frozen, hand-written schema constant, classify the stop, then `JSON.parse` exactly one `text` block and validate it.** Do not use `messages.parse()` or the zod and json-schema helpers. Three reasons, all verified (F-34-8):
  - `parse()` throws on a cut-off or refused response *before* `classifyStop` can turn it into the traveller-facing message D-30-3 requires.
  - The helpers rewrite the schema, so the body sent is not the schema written, and the sha256 pin would be guarding the wrong thing.
  - `zod` is not a declared dependency.

  The server still validates the parsed object, so a schema violation is a loud, named failure and never a silent repair:
  - **Extraction:** a 502 with "The booking reader returned an unexpected shape", plus `raw`.
  - **Descriptor:** `null` with a `console.warn`.

  The validation is the schema's own rules re-checked in code: required keys, enum membership after case normalisation (D-34-7), and patterns. It is not a second, different contract. *Gate:* W1, W2.
- **D-34-3 — The model answers a three-way classification; the app keeps its two existing fields.**
  - **The model's contract.** The schema's `result` is a discriminated union: `bookings` (with at least one booking), `travel_no_booking`, or `not_travel`. The invalid fourth state ("not travel, yet bookings") cannot be produced, and a booking cannot be returned under a non-booking kind.
  - **The app's contract.** The server maps the union to the stored and API shape the app already reads: `{ isTravelRelated, summary, language, bookings }`.
  - **Why the app shape stays.** Stored rows (Plan 2A D1 dedupe), open tabs on an old bundle (F-34-4), `computeWarnings` and both frontend readers keep working with no change and no compatibility shim.
  - **Rule 6** becomes the classification rule in §4.3. The mapping of `travel_no_booking` is Q-34-1.
  - *Gate:* W1.
- **D-34-4 — `flightNumber` is the number only, and `carrierCode` the airline code only, enforced by `pattern`.**
  - **Patterns.** `flightNumber` uses `^[0-9]{1,4}[A-Z]?$`, which is Trippy's own `FLIGHT_NUMBER_RE`. `carrierCode` uses `^([A-Z0-9]{2}|[A-Z]{3})$`, the true IATA/ICAO shape (F-34-12).
  - **Why the normaliser stays.** `normalizeFlightDetails` stays, because MCP clients and the confirm step's client-edited bookings are not schema-constrained. For extraction it becomes a no-op; a W1 test proves that.
  - *Gate:* W1. Every labelled flight number is usable (§5.1).
- **D-34-5 — The schema's budget is spent deliberately.** Every nullable field costs one of the 16 union slots. Every optional field costs one of the 24 optional slots. The extraction schema uses 10 unions and 16 optionals (§4.1):
  - Top-level booking fields stay **required and nullable** (9 unions), because `normalizeExtractedBooking` reads them as `raw.x || null`.
  - `details` fields become **optional**, because the importer already treats absent as null (F-34-5).
  - The discriminated `result` is the tenth union.

  Per-field confidence becomes an array `fieldConfidence: [{ field, level }]`, because an open-keyed map needs `additionalProperties` other than `false`, which is unsupported. The server folds it back into `confidence.fields` so the stored shape is unchanged. Any later field addition must re-count against these limits. A test asserts both counts. *Gate:* the W0 compile probe.
- **D-34-6 — One output contract per workload, sent identically to every model that has a row for it.**
  - **What the rollback row sends.** The Sonnet 4.6 and Haiku 4.5 rollback rows send the same schema and prompt as the live 5.5 rows. Both models support structured outputs (F-34-6). Settings stay keyed by model (D-30-1), and `requestSettings` gains a workload-supplied `format` that it merges into the same `output_config` object as the model's `effort`. Haiku 4.5's row therefore sends `output_config: { format }` with no `effort`.
  - **Rollback pins are re-captured, not kept.** The rollback row is measured under the new contract (W1, W2).
  - **Rolling back the contract itself means reverting the wave's commit.** Because the app shape does not change (D-34-3), that revert needs no data step.
  - *Gate:* W1, W2. If a rollback model fails the gate under the new contract, the rollback row is not "kept as is": the owner rules (Q-34-2).
- **D-34-7 — Enum values are case-normalised before membership checks.** The docs do not guarantee enum capitalisation (F-34-6). `coerceSceneType` and the `type` check in `normalizeExtractedBooking` lower-case before matching, so `"Flight"` stays a flight instead of silently becoming `'other'` (F-34-5). Marker `D-34-7`. *Gate:* W1, W2 (unit tests).
- **D-34-8 — A `max_tokens` stop under a schema is a failure, never a partial answer, and it is counted.**
  - D-30-3 already fails it before parsing. This plan adds the measured rate to every sweep table, because the Sonnet 5.5 guide names runaway thinking at `low`/`medium` under structured outputs as a known behaviour (F-34-7).
  - What a non-zero rate leads to is Q-34-3. Raising effort to `high` comes first, because it treats the cause. One automatic, logged retry is considered only if `high` also runs away; that would amend D-30-3's "a retry is the caller's choice".
- **D-34-9 — The descriptor authors a broad fallback query only if it measurably beats D-31-1.** Provisional default: **keep D-31-1**, because:
  - the headroom is 5 of 50 (F-34-11);
  - discovery-path stops would still need the prefix retry, so adopting the pair adds a second retry mechanism rather than replacing one;
  - storing the broad query would need a catalogue column.

  W3 measures the pair and decides by its gate. *Gate:* W3.
- **D-34-10 — Discovery runs with adaptive thinking if, and only if, thinking-on matches the shipped thinking-off profile on volume, quality and first-category time.** If it matches, prefer it: the provider's guidance is to lower effort rather than turn thinking off (Plan 30 F-30-4), and one fewer disabled capability is one fewer field a later model can reject. If it matches on everything but time to first category, the owner rules (Q-34-4). *Gate:* W4. Re-captures only the discovery pins.
- **D-34-11 — A retiring model's rows leave the code on the deprecation notice, not on a date guess.**
  - When Anthropic announces retirement of `claude-haiku-4-5-20251001` or `claude-sonnet-4-6`, W5 removes that model's `MODEL_PROFILES` row, its `DISCOVERY_SELECTION_RULES` entry (Haiku 4.5), its rollback pins and tests, and its harness `baseline-*` profiles (the run files stay on disk).
  - Sonnet 4.6's rows go only after the co-pilot no longer runs on it (Plan 30 W5).
  - The removal is recorded in DECISIONS.md, so no agent restores a retired id. *Gate:* the notice.

**Owner questions.** Each is written in plain language first; a default applies unless the owner rules.

- **Q-34-1 — What should Trippy say when someone imports a travel email that holds no booking?** **ANSWERED 2026-10-19 by the owner: the default.** `travel_no_booking` maps to `isTravelRelated: true` with no bookings, so the review screen says "We couldn't find any bookings in that." The W0 fixture labels follow this.
  - **Plain language.** A fare-sale newsletter, a price alert, or a "your trip is coming up" email with no confirmation is about travel, but there is nothing to import. Trippy has two messages: "We couldn't find any bookings in that." and "This doesn't look like travel."
  - **Example.** You forward "SKYDEALS WEEKLY — London to Tokyo from £489". Today's rule says to answer "This doesn't look like travel." Every model ignores that rule and Trippy actually shows "We couldn't find any bookings in that."
  - **Implication.** Choosing "couldn't find any bookings" makes the rule match what the models already do and what the screen already says; it is the honest description. Choosing "doesn't look like travel" keeps the old rule; the new contract can enforce it, at the cost of telling the traveller something untrue about an email that is plainly travel.
  - **Recommendation (default): "We couldn't find any bookings in that."** — `travel_no_booking` maps to `isTravelRelated: true` with no bookings. It is the true statement, and it needs no UI change.
- **Q-34-2 — If an old model fails the new contract, what is its rollback row?** *(Only asked if W1 or W2 measures a failure.)*
  - **Plain language.** Each workload keeps its previous model as a one-line emergency rollback. After this plan, that rollback would send the new schema too.
  - **Example.** If Sonnet 4.6 under the schema mislabelled a date that it reads correctly today, rolling extraction back to 4.6 would bring that mistake with it.
  - **Implication.** Option one is to keep the row and record the measured weakness: rollback still works, with known lower quality. Option two is to drop the row early: no model rollback, only a revert of the whole plan. Keeping a separate old contract for the old model is ruled out by D-34-1, because it means two parsers.
  - **Recommendation (default): keep the row and record the measurement**, because a known-weaker rollback beats none while Sonnet 4.6 and Haiku 4.5 are still served.
- **Q-34-3 — Should an import that runs out of room retry once automatically?** *(Only asked if W1 measures any `max_tokens` stop at the chosen setting.)*
  - **Plain language.** Under a schema, the model sometimes "thinks" until it hits its length limit and returns nothing usable. Today the traveller sees "The booking reader's output was cut off — try fewer pages or split the file." and must press Try Again.
  - **Example.** One import in, say, fifty fails that way on a perfectly ordinary screenshot, and the message wrongly tells you to split a one-page file.
  - **Implication.** A runaway is not a cheap failure. It spends the whole 16,000-token allowance, about $0.16 against about $0.014 for a normal import, and it is a long wait. There are three responses:
    - **Retry once, logged.** This repeats that cost and that wait on the same failure, and it amends Plan 30 D-30-3's "a retry is the caller's choice, never silent".
    - **Raise extraction's effort from `medium` to `high`.** The provider says the runaway "almost never happens" at `high` (F-34-7). This treats the cause rather than the symptom. Plan 30 W4 measured `high` on the 17 hard fixtures at $0.0155 against $0.0136 per import (+14%) and 5.0 s against 4.7 s median, with the same accuracy.
    - **Change nothing.** This keeps the misleading message on a failure that is not the traveller's fault.
  - **Recommendation (default, revised 2026-10-19): decide from the measured rate.** W1 always measures `high` beside `medium`.
    - If `medium` shows no runaway, nothing changes.
    - If it shows any and `high` shows none, move the profile to `high` (a D-30-6 profile change, re-pinned).
    - Only if `high` also runs away, ask about a logged retry.
    - In every case, the message for a thinking runaway stops telling the traveller to split the file.
- **Q-34-4 — Is a slower first category acceptable if discovery with thinking on is otherwise as good?** *(Only asked if W4 passes every criterion except time to first category.)*
  - **Plain language.** Discovery today shows its first category in about 12 seconds with the model's up-front thinking turned off. With thinking on, Plan 30 saw about 36 seconds.
  - **Example.** You open Discovery for Tainan. Today, Essentials appears after about 12 s; with thinking on it might take about 30 s, with the same eight categories after that.
  - **Implication.** Keeping thinking off keeps the faster first impression but relies on a setting the provider steers away from. Turning it on removes that reliance and costs the wait.
  - **Recommendation (default): keep thinking off unless the first category is within Plan 30 §5.3's bound** (control + 5 s). The traveller feels the wait; they do not feel the setting.

---

## 4. The contracts

### 4.1 Extraction schema (proposed; W0 proves it compiles on all four models)

Built once as a frozen constant in `claude.js`. `BOOKING_FIELD_NAMES` is the list in `fieldConfidence.items.properties.field.enum`. The `description` strings are model-facing and may be tuned without recompiling (F-34-6). The structure may not change without re-counting D-34-5.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "language", "result"],
  "properties": {
    "summary": {
      "type": "string",
      "description": "One line for the traveller: what was found, or why nothing could be imported."
    },
    "language": {
      "type": "string",
      "pattern": "^[a-z]{2}$",
      "description": "ISO 639-1 code of the input's primary language, e.g. en, zh."
    },
    "result": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "bookings"],
          "properties": {
            "kind": { "const": "bookings" },
            "bookings": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/booking" } }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind"],
          "properties": { "kind": { "const": "travel_no_booking" } }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind"],
          "properties": { "kind": { "const": "not_travel" } }
        }
      ]
    }
  },
  "$defs": {
    "nullableText": { "type": ["string", "null"] },
    "localDatetime": {
      "anyOf": [
        { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$" },
        { "type": "null" }
      ]
    },
    "ianaZone": {
      "anyOf": [
        { "type": "string", "pattern": "^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$" },
        { "type": "null" }
      ]
    },
    "booking": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type", "title", "confirmationRef", "bookingSource", "startDatetime", "endDatetime",
        "origin", "destination", "terminalOrStation", "originTz", "destinationTz",
        "details", "confidence", "fieldConfidence", "assumptions"
      ],
      "properties": {
        "type": { "enum": ["flight", "train", "bus", "ferry", "hotel", "other"] },
        "title": { "type": "string", "description": "Short human title, e.g. the flight or train number, or the hotel name." },
        "confirmationRef": { "$ref": "#/$defs/nullableText" },
        "bookingSource": { "$ref": "#/$defs/nullableText" },
        "startDatetime": { "$ref": "#/$defs/localDatetime" },
        "endDatetime": { "$ref": "#/$defs/localDatetime" },
        "origin": { "$ref": "#/$defs/nullableText" },
        "destination": { "$ref": "#/$defs/nullableText" },
        "terminalOrStation": { "$ref": "#/$defs/nullableText" },
        "originTz": { "$ref": "#/$defs/ianaZone" },
        "destinationTz": { "$ref": "#/$defs/ianaZone" },
        "details": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "originCity": { "type": "string", "description": "Canonical English city name." },
            "destinationCity": { "type": "string", "description": "Canonical English city name." },
            "originCountryCode": { "type": "string", "pattern": "^[A-Z]{2}$" },
            "destinationCountryCode": { "type": "string", "pattern": "^[A-Z]{2}$" },
            "city": { "type": "string", "description": "Canonical English city name (hotel and other bookings)." },
            "countryCode": { "type": "string", "pattern": "^[A-Z]{2}$" },
            "carrierCode": {
              "type": "string",
              "pattern": "^([A-Z0-9]{2}|[A-Z]{3})$",
              "description": "Airline code only: the 2-character IATA code (KE, U2) or the 3-letter ICAO code."
            },
            "flightNumber": {
              "type": "string",
              "pattern": "^[0-9]{1,4}[A-Z]?$",
              "description": "The flight number only, as printed, without the airline code: for KE012 write 012."
            },
            "airlineName": { "type": "string" },
            "trainNumber": { "type": "string" },
            "originStation": { "type": "string" },
            "destinationStation": { "type": "string" },
            "seatClass": { "type": "string" },
            "address": { "type": "string" },
            "localName": { "type": "string", "description": "The name in its original local script." },
            "note": { "type": "string" }
          }
        },
        "confidence": {
          "type": "object",
          "additionalProperties": false,
          "required": ["overall"],
          "properties": { "overall": { "enum": ["high", "medium", "low"] } }
        },
        "fieldConfidence": {
          "type": "array",
          "description": "One entry for each field you are not fully sure of; omit fields you read with certainty.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["field", "level"],
            "properties": {
              "field": {
                "enum": [
                  "type", "title", "confirmationRef", "bookingSource", "startDatetime", "endDatetime",
                  "origin", "destination", "terminalOrStation", "originTz", "destinationTz",
                  "originCity", "destinationCity", "originCountryCode", "destinationCountryCode",
                  "city", "countryCode", "carrierCode", "flightNumber", "airlineName", "trainNumber",
                  "originStation", "destinationStation", "seatClass", "address", "localName"
                ]
              },
              "level": { "enum": ["high", "medium", "low"] }
            }
          }
        },
        "assumptions": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Short statements of any inference you made, e.g. 'Year inferred from the trip dates.'"
        }
      }
    }
  }
}
```

- **Budget (D-34-5).** Unions: `nullableText` ×5 uses (`confirmationRef`, `bookingSource`, `origin`, `destination`, `terminalOrStation`), `localDatetime` ×2, `ianaZone` ×2, and `result` give 10 positions. A `$ref` to one definition may count once (4) or per use (10); both are under 16, and the W0 probe records which. Optional parameters: the 16 `details` properties, under 24. Headroom left for a later field: 6 unions, 8 optionals.
- **Server mapping** (`extractBookings`, after `classifyStop` and validation):
  - `isTravelRelated = result.kind !== 'not_travel'` (Q-34-1 default);
  - `bookings = result.kind === 'bookings' ? result.bookings : []`;
  - each booking's `fieldConfidence` is folded into `confidence.fields` (`{ [field]: level }`), and `fieldConfidence` is removed.

  The returned and stored object has exactly today's keys.
- **Rule 7 is now enforced by the grammar.** A bare `"UTC"` cannot match `ianaZone`. `normalizeTz` still validates real zones.

### 4.2 Descriptor schema (proposed)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["photoQuery", "sceneType"],
  "properties": {
    "photoQuery": {
      "type": "string",
      "pattern": "^[^ ]+( [^ ]+){0,7}$",
      "description": "A culturally specific English stock-photo search, at most 8 words, naming the actual place, cuisine or activity."
    },
    "sceneType": {
      "enum": ["temple_shrine", "market", "street_neighborhood", "nature_outdoors", "museum_gallery",
               "landmark_architecture", "food_drink", "nightlife", "beach_water", "viewpoint",
               "wellness", "hotel_stay", "entertainment", "generic"]
    }
  }
}
```

- The `enum` is generated from `SCENE_TYPES`, never typed twice (Plan 10 D8). A test asserts equality.
- `slice(0, 8)` (`claude.js:692`) is deleted. A query over 8 words is now a contract violation to be logged, not silently cut.
- If W0 shows the `{0,7}` pattern is rejected, the fallback is: no pattern, an 8-word server check that returns `null` and warns.
- **W3 variant only:** an added required `"broadQuery": { "type": "string", "pattern": "^[^ ]+( [^ ]+){0,3}$" }`, described as "a broader 2–4 word search that would still show this kind of place if the specific one finds nothing".

### 4.3 Prompt changes (the only prompt edits in W1/W2)

- **Extraction.** Delete the fenced-block line (`:155`), the "Output shape" block (`:157–186`; the schema replaces it), and rule 9 (`:201`). Rewrite rule 6 as:
  > 6. Classify the input in `result.kind`: `bookings` when it contains at least one booking you can extract; `travel_no_booking` when it is about travel but holds no booking (a fare sale, a newsletter, a price alert, travel advice); `not_travel` otherwise. Never invent a booking to reach `bookings`.

  Add one line to the rules: "Put the airline code in `details.carrierCode` and only the number in `details.flightNumber`." Rules 1–5a, 7 and 8 are unchanged.
- **Measured extraction variant.** Append "Think the problem through before you answer." (F-34-7). It is adopted only if W1 measures a gain, per §5.1.
- **Descriptor.** Delete "Output ONLY a single fenced JSON code block…" and "Output nothing outside…". The two field rules stay.
- **Pins.** Each prompt gets a text pin, as Plan 30 W3 did for discovery.

---

## 5. Evaluation — the Plan 30 harness, reused

Every run goes through `backend/scripts/modelEval/`, with Plan 30's rules:
- D-30-7: no owner data and no shared catalogue writes, proved by side-effect counts;
- `--max-usd` caps;
- recorded request bodies;
- blinded qualitative judgments;
- private fixtures never committed.

Each wave **re-captures only its own workload's request-body pin(s)**.

### 5.1 Gates (Plan 30 §5.3, reused and extended)

**Extraction (W1).** All of Plan 30 §5.3 *Extraction*, against the same-day W0 run of `main` on the same fixtures, **plus:**
- schema-valid parse 100% of `end_turn` responses;
- `result.kind` correct on 100% of fixtures, labelled per Q-34-1;
- flight numbers usable by `normalizeFlightQuery` (the Plan 30 W4 scorer's check) on **100%** of labelled flights, with `normalizeFlightDetails` a no-op on every one;
- `max_tokens` stops 0 at the chosen setting (D-34-8; else Q-34-3);
- refusals 0, with special attention to `reasoning_extraction` on `assumptions` (F-34-6);
- median latency ≤ 1.5× the W0 run. The first call of each schema (grammar compile) is reported separately and is not part of the median; it is reported as its own line, because production extraction is rare enough that most production calls will be cold (Plan 30 W0: no extraction in a month).

The "think first" line is adopted only if it removes a critical error or raises critical-field accuracy without a `max_tokens` stop.

**Descriptor (W2).** All of Plan 30 §5.3 *Descriptors* against a same-day W0 run, **plus:**
- schema-valid 50/50;
- `sceneType` in vocabulary before case-normalisation 50/50;
- blind pairwise on 20 places at ≥ 50% for the new contract, counting ties as half;
- `selectPhoto` live fallback count over 3 runs, with its mean ≤ the W0 mean plus 2 (the 14–20 noise band, F-34-11).

**Photo query pair (W3).** Adopt the pair only if, over 3 runs of the 50 places through a harness copy of `selectPhoto`:
- mean fallbacks are lower than D-31-1's by at least 3 of 50; **and**
- the blind wrong-place rate on recovered photos is no worse than D-31-1's 1 in 5; **and**
- the owner accepts the second mechanism and, if wanted everywhere, a discovery prompt change plus a catalogue column (a migration after 037).

Otherwise record the numbers and keep D-31-1.

**Discovery thinking-on (W4).** Against a same-day re-run of the shipped `control` (12 runs) on the same 6 destinations × first/exclusions:
- `end_turn` 12/12 and 8/8 categories 12/12;
- items-per-category median ≥ control − 1;
- dropped lines 0;
- name-quality measures each ≤ control's, read as Plan 30 W3 did, with the noted alias-measure noise;
- exclusion repeats ≤ control's;
- first category ≤ control + 5 s, else Q-34-4;
- cost per usable item reported;
- verified share ≥ control's on `discoverySpotCheck.mjs`, run only if every volume criterion passes;
- thinking tokens exact when `usage.output_tokens_details.thinking_tokens` is present, otherwise Plan 30 W3's estimate.

### 5.2 Budget (from Plan 30's measured per-call costs)

| Wave | Anthropic calls | Spend | Other providers |
|---|---|---|---|
| W0 | ~31 extraction fixtures ×2 (5.5, 4.6), 50 descriptors, compile probe 4 models × 2 schemas ×2 | ≈ $1.0 | none |
| W1 | ~31 × (contract, contract + think line, contract at `high`, 4.6 under contract) + forced cut-off | ≈ $2.0 | none |
| W2 | 50 × (5.5, 4.5 under contract) + 20-pair blind read | ≈ $0.05 | ~450 Unsplash searches (3 runs × 50 × ≤3), within 1,000/hr |
| W3 | 50 × 3 runs with `broadQuery` | ≈ $0.01 | ≤ 450 Unsplash searches |
| W4 | 12 thinking-on + 12 control | ≈ $0.30 | spot check ≤ 1,000 Nominatim, ≤ 50 Google escalations (process-local budgets) |
| **Total** | | **≈ $3.5** | |

---

## 6. Waves

Each wave starts with reading this plan. It implements only that wave on its own branch and runs `cd backend; npm test` (plus `cd frontend; npm test; npm run build` if the frontend is touched; this plan expects it not to be). It updates the wave's status line with evidence and opens a PR.

### W0 — Baseline, fixtures, compile probe (no production change)

**Status:** NOT STARTED.

**Files.**
- `backend/scripts/modelEval/fixtures/extraction/*.json` (new fixtures);
- `backend/scripts/modelEval/schemaProbe.mjs` (new, harness-only);
- `backend/scripts/modelEval/README.md`;
- this plan.

**Steps.**
1. **New committed synthetic fixtures** (labelled in today's shape *and* with `expectedKind`):
   - flight-number forms: `KE 012`, `KE0012` (leading zeros as printed), a suffix letter (`BA 2490A`), a digit-bearing carrier (`U2 8123`), a codeshare "KE 5012 operated by Delta DL 7863";
   - travel-without-booking: a price alert, an airline newsletter, a visa-reminder email, a "your trip starts in 3 days" email with no reference;
   - not-travel: a utility bill.

   Re-label `non-travel-fare-promo` as `travel_no_booking` (`isTravelRelated: true`, no bookings), per the owner's Q-34-1 answer.
2. **Same-day baselines on `main`:** `extraction.mjs --profile control` and `--profile baseline-46` on the full corpus; `descriptor.mjs --profile control` and `baseline-45`; three `selectPhoto` fallback passes for the descriptor control queries.
3. **Compile probe.** `schemaProbe.mjs` sends each proposed schema once per model (`claude-sonnet-5-5`, `claude-sonnet-4-6` for extraction; `claude-haiku-5-5`, `claude-haiku-4-5-20251001` for the descriptor) on a trivial input, then once more. It records:
   - acceptance or the exact 400 (union/optional counts, `pattern`, `$ref` handling, "too complex");
   - cold versus warm latency;
   - input-token overhead against the same request without a format.

   It writes nothing outside `data/model-eval/`.

**Acceptance.**
- Both schemas compile on all four models, or §4 is revised with the probe's evidence before W1.
- Baseline tables are pasted here.
- D-30-7 counts are unchanged.

### W1 — Extraction contract (D-34-1 … D-34-8)

**Status:** NOT STARTED. Q-34-1 answered 2026-10-19 (the default), so the fixture labels are settled.

**Files.**
- `backend/src/services/claude.js`: `EXTRACTION_OUTPUT_SCHEMA`, prompt per §4.3, `requestSettings` merging a format, the parse/validate/map path, and the regex deleted;
- `backend/src/services/importer.js`: the D-34-7 case normalisation of `type`;
- `backend/tests/claude.test.js`: the extraction pin and Sonnet 4.6 rollback pin re-captured, a prompt-text pin, union/optional budget assertions, and parse/validate/map tests including a thinking-only `max_tokens` response and a `refusal`;
- `backend/tests/importer.test.js`: normalisation is a no-op on schema-shaped flights;
- `backend/tests/live/anthropic.live.test.js:111`: rename and assert a schema-shaped parse;
- `backend/scripts/modelEval/lib/score/extraction.mjs`: score `kind`;
- `docs/DECISIONS.md`: Plan 2A D4 moved to Superseded.

**Steps.**
1. Implement on a branch.
2. Run `extraction.mjs --profile control` (the branch's code) and `--profile baseline-46` (Sonnet 4.6 under the contract).
3. Run a harness-only `contract-think` profile (the same model and settings, with the §4.3 line added on the wire) and a `contract-high` profile (the same contract at effort `high`, for Q-34-3).
4. Run `forced-cutoff`.
5. Score against W0 and apply §5.1.
6. If the gate passes: browser pass at 375 px and 1280 px on the W3 verify trip (Plan 30 W4's six cases, plus one fare-promo paste showing the Q-34-1 copy), then `LIVE_ANTHROPIC=1` smoke and the backend suite.

**Acceptance.** §5.1 *Extraction*; suite green; live smoke green; browser pass recorded.

**Rollback.** Revert the W1 commit. Stored rows are unaffected (D-34-3), so no data step.

### W2 — Descriptor contract (D-34-1, D-34-2, D-34-6, D-34-7)

**Status:** NOT STARTED. Independent of W1 (different function, different pins). It may run before or after W1, never in parallel in one checkout.

**Files.**
- `backend/src/services/claude.js`: `PHOTO_DESCRIPTOR_OUTPUT_SCHEMA` built from `SCENE_TYPES`, prompt per §4.3, regex and `slice(0, 8)` deleted, and `coerceSceneType` lower-casing;
- `backend/tests/claude.test.js`: the descriptor pin re-captured, a new Haiku 4.5 descriptor body pin, the prompt-text pin, and enum-equals-`SCENE_TYPES`;
- live smoke `:135`.

**Steps.**
1. Run `descriptor.mjs --profile control` and `baseline-45` on the branch.
2. Run three `selectPhoto` fallback passes.
3. Do the blind pairwise read (20 places, seeded shuffle, key opened after voting).
4. Run the Plan 10 temp-DB end-to-end on five manual stops, and look at the photos.

**Acceptance.** §5.1 *Descriptor*. Plan 10 D3's never-block holds: a refusal or cut-off returns `null` and the stop still gets `resolvedName + city`.

**Rollback.** Revert the W2 commit.

### W3 — Model-authored fallback query, measured (D-34-9)

**Status:** NOT STARTED. Requires W2.

**Files (harness-only unless the gate passes).**
- `backend/scripts/modelEval/lib/descriptorContractVariants.mjs` (new): swaps in the §4.2 W3 schema and one prompt line on the wire, after the recorder;
- `backend/scripts/modelEval/photoQueryReplay.mjs` (new): runs `selectPhoto`'s gate and exclusion with a harness-local chain of primary → `broadQuery` → scene fallback, against primary → D-31-1 → scene fallback, on the same live Unsplash pools.

**Steps.**
1. Three runs of 50.
2. Blind wrong-place read of every recovered photo under both chains.
3. Apply the §5.1 gate.
4. If it passes, put the owner question in the gate's third clause before any code change. Adopting it touches `unsplash.js` (D-31-1), `stops.js`, Plan 10 D2/D3, and optionally the discovery prompt and a catalogue column.

**Acceptance.** A recorded decision in DECISIONS.md either way, so the question is not re-run.

**Rollback.** Nothing to roll back if harness-only.

### W4 — Discovery with thinking on, measured (D-34-10)

**Status:** NOT STARTED. Independent of W1–W3.

**Files.**
- `backend/scripts/modelEval/profiles.mjs`: a new `v-exact12-adaptive-low` profile `{ model: HAIKU_55, maxTokens: 48000, effort: 'low', promptVariant: 'exact-count' }` (no `thinking` field, so adaptive);
- `lib/discoveryPromptVariants.mjs`: the `exact-count` variant.

The `exact-count` variant keeps variant A's quality line and replaces the volume line with:

> - Return exactly 12 items in every category. Return fewer only when the destination genuinely cannot support 12 places that meet these rules; never pad with generic or mediocre places, and say nothing about any shortfall.

**Steps.**
1. `discovery.mjs --profile control` and `--profile v-exact12-adaptive-low`, 12 runs each, `--concurrency 3`, same-day.
2. Score, then run the spot check if volume passes.
3. Do a row read of wellness for Q-27-6 padding.
4. If the gate passes, apply D-34-10:
   - Haiku 5.5's `DISCOVERY_SELECTION_RULES` take the exact-count line;
   - the profile drops `thinking`;
   - re-capture **only** the discovery body pin and the Haiku 5.5 prompt pin. The Haiku 4.5 rollback pins are untouched.

   Then run `discoveryRouteCheck.mjs`, the live smoke and the suite.

**Acceptance.** §5.1 *Discovery*, or Q-34-4.

**Rollback.** Revert the commit; the thinking-off profile and the variant-A line return.

### W5 — Retirement of rollback rows (D-34-11; event-triggered, not scheduled)

**Status:** NOT STARTED. Waits for a deprecation notice (F-34-14). It is checked at every deploy by reading the deprecations page.

**Files.** `backend/src/services/claude.js` (rows, rules, comments that name the retired model), `backend/tests/claude.test.js` (rollback pins and row-existence tests), `backend/scripts/modelEval/profiles.mjs` (`baseline-*` profiles; run files stay), `docs/DECISIONS.md`.

**Steps.**
1. Remove the retired model's rows.
2. Assert at boot that no `*_MODEL` constant names it.
3. Record what each workload's rollback becomes: the next model, or "revert the switch commit".

**Acceptance.** Suite green, and a `git grep` for the retired id finds no runtime file.

### W6 — Close-out

**Status:** NOT STARTED.

Update:
- `docs/ENGINEERING.md`: "Bookings, Capture, and Documents" says extraction runs under a JSON schema enforced by the API, and why the app shape did not change; "Discovery and Photos" gets the descriptor schema, and W4's outcome if switched;
- `docs/DECISIONS.md`: one row per landed D-34 marker, the Plan 2A D4 superseded row, and W3's measured "keep" or "adopt" so it is not re-run;
- this plan's header.

Run `git diff --check`, record total spend, and close.

---

## 7. Sequencing and rollback summary

- **Order.** Plan 30 Deploy B → (owner approves this plan; Q-34-1 already answered) → W0 → W1 and W2 (sequential in one checkout; either order) → **Deploy** → W3 and W4 (harness-first; switch only on gate) → Deploy if either switched → W6. W5 runs whenever a notice arrives, and its prerequisite for Sonnet 4.6 is Plan 30 W5.
- **Shared files.** W1 and W2 both edit `claude.js`, `claude.test.js` and the live smoke, so they never run side by side. Plan 32 and Plan 30 W5 own the co-pilot section of the same files; this plan does not touch it.
- **Rollback unit.** One wave's commit. No migration anywhere, and no stored-data change (D-34-3).
- **Standing log checks after deploy.** These are not gates (Plan 30 §7 ruling):
  - `[import] extraction` 502s carrying the new "unexpected shape" message (any is a contract failure to investigate);
  - `[import] extraction cut off` rate (Q-34-3);
  - `[photo] descriptor not usable` warnings.

## 8. Verification expectations

- Backend `npm test` green at every wave. `LIVE_ANTHROPIC=1` smoke green at W1, W2, W4 switch points and before each deploy.
- Frontend suites only if a wave unexpectedly touches the frontend (D-34-3 says none should).
- Browser pass at 375 px and desktop for W1 (import flows) and W2 (manual stop photo). The owner runs the production pass after each deploy: one real screenshot import, one fare-promo paste, one manual stop.
- Never call a wave complete from mocks or a build alone. Each switch wave includes a paid, real-model comparison and the real flow.

## 9. Estimate (provisional, one engineer)

| Wave | Estimate |
|---|---|
| W0 fixtures + baselines + compile probe | 3–4 h |
| W1 extraction contract + sweep + browser pass | 5–7 h |
| W2 descriptor contract + sweep + photo check | 2–3 h |
| W3 query-pair measurement | 2–3 h |
| W4 discovery thinking-on measurement | 2–3 h |
| W5 retirement (when triggered) | 1–2 h |
| W6 close-out | 1 h |
| **Total** | **16–23 h** |

### 9.1 Recommended session driver per wave

The driver is the Claude Code session that runs the wave. Coding is delegated to Sonnet 5.5 subagents: at most two in flight, never on overlapping files, never a Fable subagent.

| Wave | Driver | Effort | Why this and not the tier above or below |
|---|---|---|---|
| W0 | Opus 5.5 | high | Fixture design and labels decide what every later gate can see; the compile probe may force a schema revision that needs judgment. |
| W1 | Opus 5.5 | high | The contract, the parse/validate/map path and the gate read are careful work against verified facts. The one product call (Q-34-1) is the owner's, so Fable buys nothing. |
| W2 | Sonnet 5.5 | high | Smallest blast radius, one function, a 50-item sweep and a photo check. A Sonnet session can run it end to end, as Plan 30 W2 did. |
| W3 | Opus 5.5 | high | A blind relevance read of real photos and a decision with a cross-plan cost (D-31-1, Plan 10 D2/D3). |
| W4 | Opus 5.5 | high | Same shape as Plan 30 W3: volume, name-quality and padding reads on real places. |
| W5 | Sonnet 5.5 | medium | Mechanical removal against a precise list. |
| W6 | Sonnet 5.5 | medium | Documentation from recorded evidence. |

Effort above high is not recommended for any wave.
