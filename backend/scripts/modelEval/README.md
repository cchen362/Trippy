# Model evaluation harness (Plan 30)

Runs Trippy's four Anthropic workloads — booking extraction, photo descriptors, discovery
generation, and the co-pilot — through the **real** service functions in
`src/services/claude.js` with a named profile injected, and records every API call. It is
run by hand from a developer machine. It is never part of `npm test`, and production code never
imports it.

Plan: `docs/superpowers/plans/Implementation Plan 30 Model 5.5 Migration.md` (§4 profiles,
§5 evaluation design, W0 baseline).

## Running

From `backend/`, with `NODE_ENV=test` so `src/config.js` loads the real `ANTHROPIC_API_KEY`
from `backend/.env` without demanding the other production variables:

```bash
NODE_ENV=test node scripts/modelEval/descriptor.mjs --profile control
NODE_ENV=test node scripts/modelEval/extraction.mjs --profile control
NODE_ENV=test node scripts/modelEval/discovery.mjs --profile control --concurrency 3
NODE_ENV=test node scripts/modelEval/copilot.mjs --profile control --concurrency 2
node scripts/modelEval/score.mjs descriptor --profile baseline-45,control
```

Shared flags: `--profile <name>` (see `profiles.mjs`; default `control`), `--only <id,id>`,
`--limit <n>`, `--concurrency <n>`, `--max-usd <n>` (default 10 — the run stops starting new
items once the projected spend for the whole list passes it, and exits with code 2).
`discovery.mjs` and `copilot.mjs` also take `--dry-run` (set up and count, no API call) and
`--keep-db` (keep the database copy for inspection).

Discovery profiles may carry a harness-only `promptVariant` (Plan 30 W3 second pass): `discovery.mjs` then
rewrites the two volume/selection lines of the system prompt on the wire, from
`lib/discoveryPromptVariants.mjs`, after the recorder is installed so the run file stores the prompt
actually sent. `claude.js` is never changed to measure a variant. A variant must name **both** lines when
the model's live lines differ from Haiku 4.5's original: an unnamed line falls back to the original, not the live
one (Plan 34 W4's `exact-count` names both). The discovery scorer reports thinking tokens from the API's exact
`output_tokens_details.thinking_tokens` when every call carries it, with the Plan 30 W3 estimate printed beside it.

Plan 36 W2 added to discovery: `--repeat <n>` runs every selected item n times (records keep the plain `fixtureId`; `extra.repeat` is the 1-based repetition) to measure a collapse rate. Fixtures `hoian` and `danang` have no dev-catalogue row, so they are `firstOnly` (no exclusion capture, no `exclusions` variant) and `optIn` (generated only when named by `--only`, so the standard 12-generation corpus is unchanged): `--only hoian,danang --repeat 4`. The scorer adds collapse runs (output under 12,000 tokens and most categories under 8 items), essentials median/min, the share of categories under 8 items, and logistics entries by name (raw, any category and essentials only; backs D-36-4, a name heuristic to read, not a verdict), with `ess`, `collapse` and `logi` columns per item.

Extraction profiles may carry `promptVariant` too (Plan 34 W1): `extraction.mjs` installs it from
`lib/extractionPromptVariants.mjs` after the recorder, wrapping `Messages.prototype.create`, and throws unless the
request's system prompt is exactly the live `EXTRACTION_SYSTEM`, so a no-op patch cannot be measured under a variant's
name. The two Plan 34 extraction profiles run the full corpus (no subset): `contract-think` is the live settings with
the `think-first` sentence (§4.3, F-34-7) appended on the wire, and `contract-high` is the same contract at effort
`high` (Q-34-3). The scorer reads the kind the model answered (`result.kind`), reports the schema-valid share of
`end_turn` responses, and lists the cold calls (grammar compile) apart from the latency median (§5.1); run files
recorded before W1 still score, with the kind derived from the app-shaped output.

Co-pilot profiles may carry `betas` (an `anthropic-beta` header passed as the stream call's options), harness-only,
from `lib/copilotRequestPatch.mjs` (Plan 30 W5, Q-30-3); it is installed after the recorder the same way. The
two co-pilot prompt variants measured on 2026-10-19 (no effect) were rejected in favour of the acknowledgement
protocol (D-30-9) and are gone; their run files remain under `runs/copilot/v-reply-text-*/`. The scorer
recognises the acknowledgement step (`proposal_acknowledged`) from the recorded API calls.

After a `DISCOVERY_MODEL` switch, `discoveryRouteCheck.mjs [--destination Tainan] [--country TW]` runs one
real first generation through `POST /api/trips/:tripId/discover` on a database copy. It prints the SSE
timeline (categories with the 8 s `thinking` ping), the inserted rows' provenance before and after the
verification drain, and the resolver budgets. Then it deletes the copy and checks that the owner
database's counts did not move.

`control` is today's production configuration. Every script refuses to run a control pass if
`profiles.mjs` has drifted from `profileFor(workload)` in `claude.js`.

## What a run writes

One JSON line per fixture to `backend/data/model-eval/runs/<workload>/<profile>/<timestamp>.jsonl`
(gitignored): fixture id, model, settings, `stopReason`, `stopDetails`, summed `usage` with cache
fields, wall time, time to first stream event, cost, the parsed service output, and `calls[]` —
each API call's request body and response blocks as recorded by `lib/recorder.mjs`. Base64 image
and PDF payloads are always replaced by their length and a hash. For private fixtures the input
text and the raw response text are replaced the same way; only the parsed output is kept.

The recorder wraps the SDK's `messages.create` / `messages.stream` from outside the service, so a
streamed call's `stop_details` is captured from the wire `message_delta` event even though SDK
0.91.1's `finalMessage()` drops it (Plan 30 F-30-5).

## Fixtures

- `fixtures/` — committed and synthetic only: extraction hard cases with expected JSON, the 50
  descriptor places, the 6 discovery destinations, and the co-pilot trips and 20 scenarios.
  A committed extraction fixture may reference a rendered PNG/PDF by relative `path` under
  `fixtures/extraction/files/` (resolved like a private fixture's files); `renderExtractionFixtures.mjs`
  produces them from eight of the text fixtures using the installed Chromium headless shell (Plan 30 W4).
  Every extraction label carries `expected.kind` — `bookings`, `travel_no_booking` or `not_travel`
  (Plan 34 Q-34-1) — and a flight's `details.flightNumber` label is the designator as printed
  (`"KE012"`, or an any-of array for a codeshare); the label conventions are in the header of
  `lib/score/extraction.mjs`.
- `fixtures/facts/` — two synthetic documents for the Plan 37 facts reader: a two-page hotel PDF with a
  real text layer and a Japanese pasted confirmation, each with its `bookingContext` and an `expected`
  list for a human check; `renderFactsFixtures.mjs` renders the PDF (Chromium via `lib/chromium.mjs`,
  shared with `renderExtractionFixtures.mjs`) and checks its pages with `pdfjs-dist`.
- `backend/data/model-eval/private/` — **gitignored, never committed.** The owner's redacted real
  booking inputs (Plan 30 Q-30-4). Layout:
  `private/extraction/<id>/fixture.json` plus the files it names, where `fixture.json` has the
  same shape as a committed extraction fixture except that each entry in `files` carries a
  relative `path` (and `mediaType` for images) instead of inline `content`. `extraction.mjs`
  creates the directory if it is missing and loads every fixture it finds there.

## Owner data is never touched (Plan 30 D-30-7)

`discovery.mjs` and `copilot.mjs` copy the dev database with SQLite's backup API (the WAL is
included) into `backend/data/model-eval/db/` and open only the copy, through `initDb(copy)`.
`src/config.js` loads `backend/.env` with `override: true`, so setting `DB_PATH` would not redirect
anything — the scripts never read `config.dbPath`. They never call `runCatalogueGeneration`,
`insertPlaces`, `enqueueForVerification`, or the co-pilot route's `persistTurn`, and they print
row counts for the catalogue, verification, resolver-cache and co-pilot tables before and after —
for the copy and for the owner's database, which is opened read-only — and exit 1 if any changed.

## Structured-output compile probe (Plan 34 W0)

```bash
NODE_ENV=test node scripts/modelEval/schemaProbe.mjs [--only <probeId,...>] [--max-usd 1] [--concurrent]
```

Sends the extraction schema to `claude-sonnet-5-5` and `claude-sonnet-4-6` and the descriptor schema
(§4.2) to `claude-haiku-5-5` and `claude-haiku-4-5-20251001`, on a trivial input, with the real
`MODEL_PROFILES` settings and `output_config.format` merged beside any `effort`. The extraction probes
send `EXTRACTION_SCHEMA_W0` (every `details` field required, `""` for absent); `extraction-plan-*`
send §4.1 as written, which the API rejects after its 180 s compile limit ("Schema is too complex.").
Per pair: `noformat` (same request, no format — the input-token baseline), `cold` (first use of the
schema in the run, so the grammar compiles), then `warm`. A rejected `cold` skips `warm` and tries the
fallback schemas in order until one is accepted (extraction: the plan's original `carrierCode` pattern;
descriptor: the same 8-word rule written as seven optional groups instead of `{0,7}`, then no
`photoQuery.pattern` at all). Sonnet 5.5 budget probes: `union-inline-17` / `union-inline-16` (the
16-union limit), and `complexity-<variant>`, each the §4.1 schema with one ingredient removed or
reshaped (`COMPLEXITY_VARIANTS`: patterns, `details` size and shape, `fieldConfidence`, the `result`
union, and `ref-per-use-on-8` for how a `$ref` counts against the union limit). Run them with
`--concurrent`: a rejected compile holds its request for the full 180 s. `--only bogus` lists every id.
`emit-category-haiku-5-5` (Plan 35 W0) compiles `EMIT_CATEGORY_INPUT_SCHEMA` as a strict `emit_category`
tool on Haiku 5.5, on the staged discovery prompt (`lib/emitCategoryTool.mjs`), with the real discovery
profile (thinking disabled, which the forced `tool_choice` requires) and `max_tokens` 8,000; its
`noformat` request is the same call without the tool, and `shapeCheck` records the category, item count
and `checkCategoryInput` result.

It writes one JSONL file, `data/model-eval/runs/schema-probe/<timestamp>.jsonl`: per request the exact
body sent (schema included), the API error text verbatim when rejected, `stopReason`, `usage`,
`costUsd`, the text output and its parse, and a `shapeCheck` of recorded facts (extraction: `kind`,
booking count, `carrierCode`/`flightNumber`; descriptor: query word count, whether `sceneType` is in
`SCENE_TYPES`). A summary table prints at the end. The `--max-usd` guard stops new requests when the
spend so far plus the dearest request seen could pass the cap; the full matrix costs a few cents.

Guarantees: the calls are direct SDK `messages.create` calls with hand-written frozen schemas — never
`extractBookings` / `generatePhotoDescriptor` (their regex parsers would reject schema output), never
`messages.parse()` or the SDK's json-schema/zod helpers (they rewrite the schema; Plan 34 D-34-2).
SDK retries off, nothing is repaired. No database is opened and nothing is written outside
`data/model-eval/`.

## Staged-emission probe (Plan 35 W0)

```bash
NODE_ENV=test node scripts/modelEval/stagedEmissionProbe.mjs [--only ipoh,chengdu,okinawa] [--runs 2] [--parallel off|on|both] [--max-usd 1] [--max-steps 12] [--concurrency 1] [--strict on|off]
```

Measures whether Haiku 5.5 with adaptive thinking (effort `low`, no `thinking` field) thinks per category
when the catalogue is delivered through an `emit_category` tool, or still plans the whole catalogue
before its first call (Plan 34 W4: first category at 44 s). Each run is a real tool loop on the live
discovery prompt with the `exact-count` volume line and the NDJSON output opening replaced by the
staging paragraph (`stagedDiscoverySystemPrompt`): stream a step, replay the assistant turn verbatim
(thinking blocks and signatures included), answer every `tool_use` with a `tool_result`
(`{ received, remaining }`), repeat until the model ends its turn, `--max-steps` is reached, or the API
errors. `tools`, `tool_choice` and the system block are byte-identical on every step; the cache
breakpoint sits on the system block and the newest `tool_result` only. The user message is the live one.
`--parallel` selects the `tool_choice` setting: `off` is `disable_parallel_tool_use: true`
(`parallel: "disabled"`), `on` is `false` sent explicitly (`"allowed"`), `both` runs each. Runs are
sequential unless `--concurrency` is raised, so timing is not perturbed. `--strict off` sends the same tool
without `strict` (a diagnostic: W0 used it to tell the strict decoder's CJK `localName` corruption apart
from the loop itself); each run record carries `strict`.

It writes one JSONL file, `data/model-eval/runs/staged-probe/<timestamp>.jsonl`, one line per run: the
steps (block timeline from the step's and the run's start, exact `thinking_tokens` from `usage`, stop
reason and details, usage, cost, text blocks so any prose is visible, each delivered category's full
tool input with its `checkCategoryInput` result; the first two request bodies whole, later ones as a hash) and the totals
(`firstCategoryMs` — run start to the first `tool_use` block closing, the moment a server could persist
the first category — thinking tokens before the first call and per step, calls per turn, duplicates,
prose-only turns, `end_turn` before the eighth category). Thinking text and signatures are never
written. The summary prints a per-run table and, per `parallel` setting, the Plan 35 §5 go/no-go:
median thinking before the first call <= 1,200 tokens; one `emit_category` per turn on at least 10/12 of
turns with a call; at least one thinking block after the first step; no prose-only turn and no
`end_turn` before the eighth category. The `--max-usd` guard refuses a step that, at the dearest step
seen so far, could pass the cap (exit code 2).

Guarantees: direct SDK `messages.stream` calls with retries off; nothing is repaired or retried. No
database is opened and nothing is written outside `data/model-eval/`.

## Photo fallback passes (Plan 34 W0, reused by W2)

```bash
NODE_ENV=test node scripts/modelEval/photoFallback.mjs --profile control [--run <descriptor run .jsonl>] [--passes 3] [--limit <places per pass>] [--max-calls 700]
```

For every record with a non-null `output` in a descriptor run file (default: the newest under
`data/model-eval/runs/descriptor/<profile>/`), calls the real `selectPhoto` from `src/services/unsplash.js`
with that output's `photoQuery` and `sceneType`, `excludeIds: []` (the Plan 31 measuring method), live,
for `--passes` passes. Each place is classified from the queries actually sent: `fallback` (a sent query
that is not a word-prefix of the primary — only the scene fallback is not), `retried` (a shorter prefix
was sent, D-31-1), `recoveredByRetry`, `none`. It prints per-pass counts and the mean fallbacks and
writes `data/model-eval/runs/photo-fallback/<profile>/<timestamp>.json` (per-place `sent[]`, per-pass
counts, `summary.fallbacksPerPass`, `mean`, `minRateLimitRemaining`, `totalCalls`).

Guarantees: `globalThis.fetch` is replaced before `unsplash.js` is imported and throws on anything but
`GET https://api.unsplash.com/search/photos`, so download tracking or any other call can never fire.
There is no cache — every pass is live. Measured in W0: three passes of the same 50 queries gave
7 / 7 / 7, so Unsplash search is deterministic for a fixed query and the 14–20 spread Plan 30 W2 saw
came from the model writing different queries on each run. To measure noise, run the descriptor
harness several times and pass each run file once (`--run`), rather than one run file three times.
No database is imported. `--max-calls` is a hard stop, and the run stops early if
`X-Ratelimit-Remaining` drops below 50 (the key's limit is 1,000 requests/hour; a pass is at most
4 calls x 50 places).

## Descriptor `broadQuery` and the photo query replay (Plan 34 W3)

```bash
NODE_ENV=test node scripts/modelEval/descriptor.mjs --profile w3-broad          # a descriptor run with broadQuery
NODE_ENV=test node scripts/modelEval/photoQueryReplay.mjs --profile w3-broad [--run <descriptor run .jsonl>]... [--max-calls 400]
node scripts/modelEval/photoBlindSheet.mjs --replay <photo-query-replay .json> [--seed 34]
node scripts/modelEval/photoBlindSheet.mjs --score <data/model-eval/runs/photo-blind/<timestamp>>
```

The `w3-broad` descriptor profile is the live settings (Haiku 5.5, effort low) with a harness-only
`promptVariant: 'broad-query'`. `lib/descriptorContractVariants.mjs` installs it after the recorder: it adds one
`- broadQuery:` line before the `- sceneType:` line of the system prompt and sends a copy of the live schema with a
required `broadQuery` string, throwing unless the request carries exactly the live `PHOTO_DESCRIPTOR_SYSTEM` and
schema. The run file stores the request actually sent and the raw answer; the real `generatePhotoDescriptor` is given
the answer with `broadQuery` removed (its live schema is `additionalProperties: false`), and each record's
`extra.broadQuery` holds what the model wrote. `claude.js` is unchanged. The descriptor scorer validates against the
schema the request carried and adds `broadQuery` rows (present, words median / max, over 4 words, identical to
`photoQuery`) when a run has them.

`photoQueryReplay.mjs` takes one or more descriptor run files (`--run` repeats; default the newest for the profile) and,
for every record with an output, runs four chains with `excludeIds: []`: `A0` today's `selectPhoto` (zero-result
prefix retry, D-31-1), `A1` the prefix retry on any primary miss, `B0` primary, then `broadQuery` on a zero-result
primary, then the scene fallback, `B1` the same on any primary miss. `A0` is also run through the real `selectPhoto`
and the two must send the same queries and choose the same photo, or the script throws `parity failure`. Unlike
`photoFallback.mjs` it keeps a cache of successful search responses keyed by request URL, because W0 measured search as
deterministic for a fixed query: one result then serves every chain and run file, and only real network calls count toward
`--max-calls` (default 400; it stops with exit code 2 if `X-Ratelimit-Remaining` drops below 50 or the next place could
pass the cap). The same fetch guard applies (search only, no download tracking, no database). It writes
`data/model-eval/runs/photo-query-replay/<profile>/<timestamp>.json` with per-place chain outcomes (`step` is `primary`,
`retry4`, `retry3`, `broad`, `scene` or `none`) and per-chain fallbacks, recovered counts and means, and prints a table.

`photoBlindSheet.mjs` (offline) turns a replay into a blind read of the photos the chains recovered by retry or broad
(deduplicated by place and photo, shuffled with a seeded PRNG). `--replay` writes `sheet.html` (stop and photo only, no
query or chain), `key.json` and a `verdicts.json` template to `data/model-eval/runs/photo-blind/<timestamp>/`; fill in
each verdict as `right`, `generic` or `wrong`, then `--score <dir>` prints per chain (pooled across runs, each use
counted) the recovered, right, generic and wrong counts and the wrong-place rate, and writes `score.json`.

## Document facts and the readiness prototype (Plan 37 W0)

```bash
NODE_ENV=test node scripts/modelEval/facts.mjs --db data/model-eval/private/db/prod-<date>.db --census
NODE_ENV=test node scripts/modelEval/facts.mjs --db <copy> --profile facts-haiku-55-medium --max-usd 8
NODE_ENV=test node scripts/modelEval/facts.mjs --sheets --run <run.jsonl>,<run.jsonl>,<run.jsonl>
NODE_ENV=test node scripts/modelEval/readiness.mjs --db <copy> --facts <facts run.jsonl> [--repeat 2] [--dry-run]
NODE_ENV=test node scripts/modelEval/readiness.mjs --sheets --run <readiness run.jsonl>
node scripts/modelEval/score.mjs facts --profile facts-haiku-55-medium,facts-sonnet-55-medium,facts-sonnet-46-medium
node scripts/modelEval/score.mjs readiness --profile readiness-sonnet-55-high
```

Two measuring workloads with no live counterpart: `profileFor('facts')` throws (F-37-7), so neither has a
`control` profile and neither script asserts one. The contract (schema, prompt, request builder, answer
classifier, `findQuote`) is `lib/factsContract.mjs`, which W1 moves into `claude.js` byte-identical. The
schema is §4.1 **without `maxItems`**: the API rejects that keyword on Haiku 5.5, Sonnet 5.5 and Sonnet 4.6
("For 'array' type, property 'maxItems' is not supported", compile probe 2026-10-20), so a read is bounded
by its `max_tokens` allowance. `FACTS_OUTPUT_SCHEMA_AS_PLANNED` keeps §4.1 as written for the probe only.

- `facts.mjs` takes one source: `--fixtures` (committed synthetic, `fixtures/facts/`, rendered by
  `renderFactsFixtures.mjs`), `--private` (`private/facts/<id>/fixture.json`, the extraction private shape
  plus a `bookingContext`) or `--db <path>` (a production backup copy). Documents are enumerated by
  `lib/factsCorpus.mjs`: import files of every kind, pasted text included (D-37-8), joined to bookings
  through `details_json.importedFrom.artifactId`, and booking attachments; documents of one trip with
  the same `content_hash` are read once (D-37-1). `--census` makes no API call and writes the grading
  sample to `private/facts/sample.json`. A run writes one record per document with the parsed facts,
  each quote's verification against the text layer (`lib/documentText.mjs`, `pdfjs-dist` legacy build;
  images and PDFs without a text layer are unverifiable) and the outcome: `complete`, `refused`,
  `truncated`, `invalid` (bad shape or an empty quote, D-37-2) or `error`. Nothing is retried
  (`maxRetries: 0`) or repaired. `facts-sonnet-46-medium` runs on images only (B1).
- `readiness.mjs` is a grading prototype, not the Phase 2 design (`lib/readinessPrototype.mjs`). Per
  document-rich trip (`--min-docs`, default 8) and repeat, it sends the trip as the co-pilot serialises
  it (`copilotTripContext`, imported), bookings without bookkeeping, days, the facts run's facts and
  `runTripHealthChecks` findings, each under a short evidence id (B, D, F, H), and streams one answer
  of `holds` / `conflict` / `question` items. A cited id that does not exist is recorded as
  `unknownEvidence`, never repaired.
- `--sheets` writes blind grading sheets under `private/facts/grading/` (facts: one per document per run;
  readiness: one per trip per run and repeat), the model hidden behind a letter code and `key.json`
  mapping codes to runs. No document bytes are written there. The scorers read the marked sheets back:
  `lib/score/facts.mjs` prints G-37-1 (costly kinds wrong ≤ 3 %, missing ≤ 1 in 10) and, through the
  `compare` hook in `score.mjs`, B2 (Haiku 5.5 within one point of Sonnet 5.5 on the costly score) and
  B1 (Sonnet 5.5 against 4.6 on images); `lib/score/readiness.mjs` prints G-37-2 and G-37-3.
  `FACTS_GRADING_DIR` / `READINESS_GRADING_DIR` point the scorers at another grading root.
- The compile probe has five Plan 37 ids: `facts-haiku-5-5`, `facts-sonnet-5-5`, `facts-sonnet-4-6`,
  `facts-plan-haiku-5-5` (§4.1 as written, to re-run the rejection) and `readiness-sonnet-5-5`. They carry
  their own profile from `profiles.mjs`, since `MODEL_PROFILES` has no row for either workload.

Owner documents (D-37-11): `--db` is opened `readonly` (`lib/sourceDb.mjs`) for the census, the
enumeration and the bytes. `readiness.mjs` needs `getTripDetail`, which reads through `getDb()`, so it
takes a backup-API copy of the copy into `data/model-eval/db/`, opens that with `initDb`, and removes it at
the end. Every mode ends with the side-effect table: every table's row count and a digest for the
source (must not change), the working copy (must not change), and the dev database (counted readonly;
a change there means another process wrote to it, reported, not a failure). Run files keep parsed
facts and hashes, never document bytes; the recorder redacts request and response text for any source
but the committed fixtures. Everything lands under the gitignored `backend/data/model-eval/`.
