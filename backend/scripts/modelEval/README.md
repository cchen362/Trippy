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
actually sent. `claude.js` is never changed to measure a variant.

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
