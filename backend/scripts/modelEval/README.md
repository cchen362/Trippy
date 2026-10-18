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
