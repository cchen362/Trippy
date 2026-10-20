# Implementation Plan 37 — The Living Dossier, Phase 1: document facts, Conditions, Due

**Status:** 2026-10-20 — **W0 COMPLETE; W1 COMPLETE (merged to local main at `c791f17`); W2 COMPLETE on branch `plan37-w2` (not merged, not deployed); W2b (reader 37.2) COMPLETE 2026-10-21 on branch `plan37-w2b`, built on `plan37-w2` (not merged, not deployed); W3 (Due) COMPLETE 2026-10-21 on branch `plan37-w3`, built on `plan37-w2b` (not merged, not deployed; merge order w2 → w2b → w3); next the deploy (W4).** **APPROVED by the owner 2026-10-20** with the default on every question (Q-37-1 to Q-37-9); the owner takes the production backup copy for W0's corpus; W0 runs in a fresh session on Opus 5.5 at `high` (§9) from the handoff note `2026-10-20-plan37-w0-handoff.md` beside this plan. Written at `8ffc1b5` (`origin/main`). Origin: the [living-dossier assessment](../reviews/2026-10-20-model-55-exploration-assessment.md) and the owner's rulings of the same day (R-1, R-2, R-3, O-1 to O-5, recorded in `docs/DECISIONS.md`, "Living dossier direction"). W0 is the experiment the owner approved under O-4; every decision below is provisional until its named gate. Each owner question carries a default. Waves are implemented later via `/implement-milestone`, each on its own branch. The assessment pencilled this in as Plan 36; that number was taken the same day by Discovery catalogue completeness, so the assessment and DECISIONS now say Plan 37.

**Origin.** The assessment chose "the living dossier" as the flagship: Trippy reads every document on a trip in full, not just the booking line, and keeps three things current: an inbox, Conditions and Due on each booking, and a readiness ledger. The owner ruled that bounded background compute is allowed without notifications or polling (R-1), that documents arriving through MCP are read like every other document (R-2), that a booking-change proposal kind is Phase 3 scope (R-3), that intake must be platform-neutral (O-1), that inbound email is acceptable and staged last (O-2), that Conditions and Due alone are worth shipping if the ledger disappoints (O-3, reviewed as it goes), that the experiment is approved (O-4), and that ideas come later (O-5). This plan is Phase 1: the experiment, then facts, Conditions and Due on the documents Trippy already holds.

**Scope in one sentence:** read every document on a trip in full into source-quoted facts, show them as Conditions under each booking and as Due across the trip, and first prove on the owner's real documents that the facts can be trusted and that cross-document checking finds something worth finding.

**Not in scope.**
- The inbox and its channels (Phase 3), and R-3's booking-change proposals (Phase 3).
- The readiness ledger as a product surface, the co-pilot's evidence tools, and Today's "applies tonight" lines (Phase 2). W0 runs the ledger as a **harness prototype only**, because the owner's O-4 approval covers Part A of the experiment, which needs it.
- Research of open questions (Phase 4) and ideas (Phase 5).
- No change to the four existing workloads' profiles, prompts or schemas; extraction's schema is untouched.
- No notifications, no provider polling (R-1). No travel-time reasoning (R-4).
- Facts never enter the public share, MCP `get_trip`, or the co-pilot context in this plan (R-12; D-37-7).
- No frontend PDF rendering library (F-37-31); PDF text is read on the server.

---

## Bottom line, in plain language

**What you get at the end of this plan.** Under each booking in Logistics, the conditions its documents state: *check-in from 15:00*, *free cancellation until 14 November*, *cabin 7 kg, checked 20 kg outbound only*, each with the sentence quoted from the document and the page it is on, and a tap that opens the document at that page. At the top of Logistics, the deadlines that are still ahead, in order, with a countdown. Nothing else in the product changes. Documents you have already imported are read once, in the background, at the first deploy.

**What is decided before any product code.** W0 runs the experiment you approved: Trippy's facts reader over your real documents, graded by you line by line, and a prototype of the whole-trip check over the same material. It answers four things. Are the facts accurate enough to act on (the gate that decides whether anything ships)? Does the cross-document check find connections you had not noticed (the gate that decides whether Phase 2 is written)? Which model should read at import, the cheap one or the careful one? And does Sonnet 5.5's sharper vision actually read dense phone screenshots better than Sonnet 4.6, or was that only a hypothesis?

**The honest risks.** First, trust: a wrong deadline is worse than no deadline, so the facts gate is strict (deadline, time and requirement facts wrong in no more than 3 % of a hand-checked sample). Second, the corpus: no production export exists on this machine (F-37-30), the dev database holds 14 import artifacts, and Part A needs document-rich trips, so W0 begins by taking a read-only production backup copy and, if that is thin, by the owner adding confirmations from the last two years as private fixtures. Third, the contract: the facts schema must compile under the same limits Plan 34 hit (no optional properties, no range quantifier on a group); W0 compiles it before anything depends on it.

**Cost.** Reading a document costs about a third of a cent on Haiku 5.5; a trip's documents, cents; W0's whole experiment, under $8 at list with the cap set to that. Production volume is low, so the daily cap on reads is a safety rail, not a constraint.

**If W0 fails.** If the facts gate fails, nothing ships and the reason is recorded in DECISIONS.md; the direction is not rebuilt as a nicer document index. If only the ledger gate fails, this plan continues (O-3) and Phase 2 is not written.

---

## 1. Validated facts — established 2026-10-20 at `8ffc1b5` (`origin/main`), do not re-derive

Code facts were read at `a44f437` and `8ffc1b5` (the Plan 36 W1 commits moved `claude.js` only below line 728). Provider facts come from the `claude-api` reference bundled with Claude Code 2.1.299 and are re-checked at each wave.

**The harness.**
- **F-37-1** `backend/scripts/modelEval/` runs the real service functions with a named profile injected and records every call. `profiles.mjs:19-108` declares `PROFILES[workload][name] = { model, maxTokens, thinking?, effort?, subset?, promptVariant?, betas? }`; `toServiceProfile` strips the harness-only keys (`:121-124`); a `control` profile must JSON-equal `profileFor(workload)` or the run throws (`:126-135`). `WORKLOADS` (`:110`) drives `score.mjs`, which needs `lib/score/<workload>.mjs` exporting `score(records)`.
- **F-37-2** Run files are `data/model-eval/runs/<workload>/<profile>/<ISO-ts>.jsonl` (`lib/runner.mjs:43-53`, gitignored); `buildRecord` (`:78-103`) carries model, settings, timings, `stopReason`, `stopDetails`, `usage` with cache fields, `costUsd`, `output`, `extra` and `calls[]`. The recorder (`lib/recorder.mjs:84,153`) replaces base64 image and document data with length and sha256 (`:26-33`) and keeps only `type`/`text` of response blocks (`:51-67`). `--max-usd` defaults to 10 and stops scheduling when `(spent/done)*total` exceeds it (`lib/runner.mjs:19,108-131`; exit 2).
- **F-37-3** `lib/pricing.mjs:8-13` prices Sonnet 4.6, Sonnet 5.5, Haiku 4.5 and Haiku 5.5 (the ≤ 100K tier only; a longer Haiku prompt throws, `:25-27`).
- **F-37-4** `lib/dbCopy.mjs:70-86` copies the **dev** database (`config.dbPath`, `backend/.env:3 DB_PATH=./data/trippy.db`) with the SQLite backup API into `data/model-eval/db/` and opens the copy with `initDb(copyPath)`; `DB_PATH` in the environment is never honoured (`config.js:10`, dotenv `override:true`). No `runMigrations()` runs on a copy, and `COUNT_QUERIES` (`:33-43`) is a fixed table list. Side effects are proved by counts before and after (D-30-7).
- **F-37-5** Private fixtures live under `data/model-eval/private/<workload>/<id>/fixture.json` with files beside them (`extraction.mjs:50-68`); the directory is gitignored (`.gitignore:19`) and **empty** on this machine.
- **F-37-6** `schemaProbe.mjs` compiles a hand-written schema on a model with `noformat` / `cold` / `warm` requests and records acceptance or the exact 400 (Plan 34 W0). Plan 34 measured: optional properties double compile time and 14+ are rejected after 180 s; a range quantifier on a group (`{0,7}`) is rejected; `+` on a group compiles (`ianaZone`); 16 inline unions is the limit and a `$ref` counts once per definition (Plan 34 W0 table).

**`backend/src/services/claude.js`.**
- **F-37-7** `MODEL_PROFILES` (`:41-94`, deep-frozen) is keyed by model; `WORKLOAD_MODELS` (`:96-101`, unexported) maps extraction → `claude-sonnet-5-5`, descriptor → `claude-haiku-5-5`, discovery → `claude-haiku-5-5`, copilot → `claude-sonnet-5-5`. `profileFor` (`:106-116`) throws on a missing row, and a load-time loop (`:119`) runs it for every workload, so **a new workload without a row for its model breaks module import**. Non-streaming `max_tokens` must stay ≤ 21,333 (`:47-48`; `claude.test.js:1705-1709`). The client is `new Anthropic({ apiKey })` with no retry or timeout override (`:5-10`).
- **F-37-8** `requestSettings` (`:127-134`) builds `{ model, max_tokens, [thinking], [output_config: { effort?, format? }] }`. `classifyStop` (`:142-149`) returns `complete` | `refused` | `truncated` (`max_tokens` or `model_context_window_exceeded`). `deepFreeze` (`:194-200`) is module-private.
- **F-37-9** `validateAgainstSchema` (`:494-497`) supports exactly `type`, `const`, `enum`, `anyOf`, `$ref`, `$defs`, `required`, `properties`, `additionalProperties` (false only), `items`, `minItems`, `pattern`, `description` (`:378-381`), and only the types `object`, `array`, `string`, `null` (`:383`). It **throws** on any other keyword or type (`:396,400,404-406,417`); `claude.test.js:2114` asserts that `maxLength` and `integer` throw. Enum and const match case-insensitively and return the schema's spelling (`:425-441`, D-34-7). The D-34-5 budget test (`claude.test.js:2128`) walks `EXTRACTION_OUTPUT_SCHEMA` only.
- **F-37-10** `EXTRACTION_SYSTEM` (`:177-192`) ends with rule 10, "Do not explain your reasoning in prose." (`endsWith` test `:2197`, sha256 pin `:2194`); without it, inputs asking to see reasoning drew `reasoning_extraction` refusals (`:173-176`).
- **F-37-11** `extractBookings` (`:535-638`) is non-streaming: `{ ...requestSettings(profile, { format }), system: EXTRACTION_SYSTEM, messages: [{ role: 'user', content }] }` (`:577-581`); the system block is a plain string with no `cache_control` (only the co-pilot has one, `:1306`); content is a date/trip text block, an optional context block, then `text` → `{ type: 'text' }`, `image` → `{ type: 'image', source: { type: 'base64', media_type, data } }`, `pdf` → `{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }` (`:554-573`). Every failure is a `502` with a named message (`:593-631`); usage is logged and returned as `{ input_tokens, output_tokens }` only, and `importer.js:318` drops it, so **no extraction cost is persisted anywhere**.
- **F-37-12** `generatePhotoDescriptor` (`:1017-1071`) is the small structured-output template: `messages.create` with `format`, `classifyStop`, exactly one text block, `JSON.parse`, `validateAgainstSchema`, every failure `null` with a `console.warn`.

**Documents, import, attachments.**
- **F-37-13** `importer.js`: `createArtifactAndExtract` (`:341-378`) validates ≤ 4 inputs of kind `text` | `image` | `pdf` (100 KiB / 5 MiB / 10 MiB, `:8-14`), computes `contentHash` as sha256 of the raw bytes (`:63-66`), inserts `import_artifacts` (status `extracting`) and `import_artifact_files` BLOBs in one transaction (`:358-375`), then runs extraction inline in the POST (`routes/imports.js:17-22`). There is no hash-cache table: `findCachedArtifact` (`:99-122`) matches the sorted file-hash list against the same user's `extracted` | `confirmed` artifacts for the trip.
- **F-37-14** `confirm` (`importer.js:400-445`) stamps `detailsJson.importedFrom = { artifactId, model, extractedAt }` on each created booking (`:181`) and writes `created_booking_ids` on the artifact (`:438-442`). The booking-to-artifact link is only that JSON key; **one artifact can back several bookings** (outbound and return from one PDF).
- **F-37-15** `booking_attachments` (migrations 012 and 035): `id` TEXT hex, `booking_id` FK CASCADE, `media_type`, `filename`, `size_bytes`, `content` BLOB, `created_at`, `content_hash` (sha256 of raw bytes, `attachments.js:78`), `source` `'manual'` | `'mcp'`; caps 5 MiB / 10 MiB, 4 per booking, png/jpeg/webp/pdf (`:5-7`). **`writeAttachment` (`:53-87`) is the single writer** for both the manual path (`addAttachment` `:89-98`) and the MCP path (`uploads.js:178-183`).
- **F-37-16** `resolveBookingDocuments(bookingId, detailsJson)` (`documents.js:7-43`) returns `{ source: 'import' | 'attachment', url, mediaType, filename }` and nothing else: no id, hash, kind or position. The import side follows `importedFrom.artifactId` with `kind IN ('image','pdf')` (`:11-16`), so **a pasted-text input is not a document today**. URLs are `/api/import/artifacts/:artifactId/files/:position` (`routes/imports.js:53-62`) and `/api/bookings/:bookingId/attachments/:attachmentId` (`routes/bookings.js:57-66`), both served `Content-Disposition: inline`. It is called per booking from `services/bookings.js:35` and `services/trips.js:104` (`mapBooking`), so `documents[]` is in the `/detail` payload.
- **F-37-17** `PUT /mcp/uploads/:ticket` (`routes/mcp.js:143-167`) calls `consumeUploadTicket` (`mcp/uploads.js:123-200`), which writes the row through `writeAttachment(..., { source: 'mcp' })` inside a transaction (`:175-196`) and returns `{ httpStatus: 201, attachment, alreadyAttached: false }`; a replay returns 200 with `alreadyAttached: true` (`:168`). MCP bookings carry no `importedFrom`; `email_text` sources never upload (`apply.js:28-31`).

**Background work, budgets, shutdown.**
- **F-37-18** The discovery single-flight registry is a module `Map` keyed by destination (`discoveryGeneration.js:23`), registered synchronously before any `await` (`:182-190`), deleted in `finally` (`:217-219`); `getRunningGeneration` (`:50-59`) lets a caller check then start with no `await` between. Daily budgets in `config.js` (`:62,69,77,84`) are in-memory counters reset when `todayUtc()` changes, lost on restart; the only persisted Anthropic cap is `MAX_GENERATIONS_PER_DESTINATION_PER_DAY = 3` (`db/discoveryCatalogue.js:330`, table `discovery_generation_daily`). `/api/import/artifacts` has no rate limiter (`rateLimit.js` covers auth and MCP only).
- **F-37-19** Detached work in this codebase is an async IIFE with `.catch(console.error)` (`discoveryPrewarm.js:32-62`), `setImmediate(() => stamp().catch(() => {}))` (`expenses.js:186-190`), and a per-key serial queue with a `draining` flag (`discoveryVerify.js:616-650`). `shutdown.js:24-43` closes the server, then the DB (`index.js:102-108`), then exits; **nothing tracks or cancels a background job, so an in-flight job meets a closed database.**
- **F-37-20** `tests/setup/noDiscoveryPrewarm.js:14-17` stubs `prewarmTripScopes` suite-wide because detached generations outlived tests. Eleven test files `vi.mock('../src/services/claude.js', factory)` with a few named exports (`mcpUploads.test.js:24`, `mcpDrafts.test.js:25`, `mcpClient.e2e.test.js:27`, `bookingStopSplit.test.js:22`, `copilotProposals.test.js:22`, `copilot.test.js:14`, and five discovery/grounding files), so a new job reachable from those tests needs a suite-wide stub of the same kind.

**Migrations, ids, access, payloads.**
- **F-37-21** Highest migration is 037; the next is **038**. The runner (`db/migrations.js:9-54`) applies unapplied `*.sql` | `*.js` in filename order, each in one transaction, and records them in `_migrations`; `tests/migrations.test.js:96` asserts exactly 37 rows. Ids are `TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))` for `bookings`, `booking_attachments`, `import_artifacts`, `import_artifact_files`, `copilot_proposals`, `copilot_turn_metrics`; FKs use `ON DELETE CASCADE` for owned rows and `SET NULL` for soft links; `foreign_keys=ON` (`database.js:11`). Migration 030 is the telemetry template: no text, token counts, `stop_reason` free text, prune on write (`routes/copilot.js:276-291`).
- **F-37-22** Booking routes have no middleware; `assertBookingAccess(userId, bookingId)` (`services/trips.js:846-863`, owner or collaborator, else 404) runs inside the services. `requireTripAccess` (`middleware/tripAccess.js:3-10`) guards `/trips/:tripId/…` routes. `getTripDetail` (`services/trips.js:1274-1325`) returns bookings via `mapBooking` (`:85-106`): `documents[]` and `expenseSummary`, no attachment rows or hashes.
- **F-37-23** `buildPublicTripDetail` (`share.js:86-148`) returns `{ trip, days }` only, by whitelist; MCP `get_trip` exposes `documentCount` only (`mcp/tools.js:295`); the co-pilot context drops document metadata by design (`copilotTools.js:162-166`). Regression-guard template: `trips.test.js:1037-1053`.
- **F-37-24** `vitest.workspace.js:7-22`: `unit` (setup `noNetwork.js` + `noDiscoveryPrewarm.js`) and `live` (`tests/live`, gated by `LIVE_ANTHROPIC=1`, 6 tests through `profileFor`/`requestSettings`). The SDK captures `fetch` at construction, so unit tests mock `@anthropic-ai/sdk` (`claude.test.js:8-17`) or spy on the service (`vi.spyOn(claudeService, 'generatePhotoDescriptor')`). Test databases are file-backed temp copies with real migrations (`importer.test.js:108-123`).
- **F-37-25** `backend/package.json` has **no PDF or image library** (no `pdfjs-dist`, `pdf-parse`, `sharp`); `geo-tz ^8.1.6` is present; the Dockerfile is `node:20-alpine` with `npm ci --omit=dev` (this machine runs Node 22.14.0).

**Frontend.**
- **F-37-26** `pages/LogisticsTab.jsx`: sections by type in the order flight, hotel, other, train (`:270`); cards via `CARD_BY_TYPE` (`:28-32`) with props `{ booking, onOpen }`; the **booking detail sheet is an inline overlay** (`:291`, `fixed inset-0 z-[110]`, `max-h-[85vh]`), not a `ModalShell`, with no Escape, focus trap or scroll lock; Documents render only when `documents?.length > 0` (`:315`) as pills that open `<DocumentViewer document={viewerDoc} />` (`:323,493`); the sub-section pattern (Documents `:315-367`, Costs `:369-406`) is an `mt-4` wrapper, a mono label `text-xs tracking-[0.22em] uppercase` in `--cream-mute`, rows, and a neutral outlined action. It consumes `trip, bookings, activeDay, refresh, bookingActions` from `useTripContext()` (`:49-65`) and instantiates `useExpenses` itself (`:68`). Invalidation points after a document changes: `:167` create, `:177` delete, `:203` attach, `:218` remove, `:547-550` capture confirm.
- **F-37-27** Every card root is `<button class="logistics-card">` (`TicketStubCard.jsx:30-35`, `HotelBookingCard.jsx:28-33`, `OtherBookingCard.jsx:29-34`), so an interactive child is invalid markup; a tappable source belongs in the sheet. Dossier cards (hotel, other) end with `.logistics-card-rows` whose COST row is `last` (`index.css:1194-1196`); a new zone goes after the rows, never as more `.logistics-data-row`s. Ticket cards (`TicketStubCard`) take display-ready props only (`:3-4`); the notches depend only on `.logistics-footer-line` staying a full-width unpadded child of `.logistics-transit-body`; content above the footer is safe, and a last element needs the 28 px right padding for the chevron. `.logistics-card-grid-standard > .logistics-card:only-child` (`index.css:1405-1410`) needs the card as the grid's sole direct child. Gold on a card is the confirmation reference and the Paperclip only (Plan 16); `--foil` and `--obsidian-divider` are declared with no consumer.
- **F-37-28** `components/documents/DocumentViewer.jsx` takes `{ document, onClose }` (`:8`), renders a PDF in `<iframe src={document.url}>` (`:84`) and an image in `<img>` (`:94`), is `z-[210]` (`:47`) with its own Escape and scroll lock (`:18-37`). Document URLs carry no query or hash (`documents.js:22,36`), so a `#page=N` fragment is syntactically safe; the service worker matches `url.pathname` only (`vite.config.js:66,115,130`) and denies `/api/` navigations (`:59`), so a fragment cannot change routing. Whether iOS Safari or Android Chrome honour `#page` inside an iframe is **not determinable from code**.
- **F-37-29** `formatCountdown(startDate, now)` (`utils/date.js:15-27`) is date-only and returns `''` for today or earlier (`utils/date.test.js:46-77`); the Trips Home status line (`TripCard.jsx:47-61`) is a bare mono line with gold only on the `.trip-live-dot` (`index.css:213-220`, reduced-motion safe `:174-186`). The per-route store pattern is `useExpenses` (`hooks/useExpenses.js:21-150`: `requestIdRef`, `hasLoadedRef`, mount effect keyed on `tripId`), instantiated by the route, never by `TripPage`; `useBookings` has no `error`/`onError` (`hooks/useBookings.js:7-27`). `TripPage.test.jsx` mocks every hook TripPage uses, so a new hook in TripPage would break it; tabs are separate lazy chunks (`App.jsx:7-17`).
- **F-37-30** `backend/data/` holds the dev database `trippy.db` (5.8 MB) and two old copies; `data/model-eval/private/extraction/` and `data/model-eval/db/` are empty. **No production export copy exists on this machine.** Plan 34 W0 counted the dev database at 14 `import_artifacts` and 25 `bookings`.
- **F-37-31** A frontend PDF.js would collide with the 3 MB precache cap and a glob that omits `.mjs`/`.wasm` (`vite.config.js:60-61`). A new `GET /api/trips/:id/facts` matches no runtime-caching rule and is not a navigation, so it is network-only; offline it is absent unless the hook degrades quietly.

---

## 2. Which earlier decisions each wave touches

| Decision | What it says | Wave | How this plan treats it |
|---|---|---|---|
| **R-1** (owner, 2026-10-20) | Bounded background compute on changed data is allowed; no notifications, no provider polling. | W1 | The read job runs after a document is stored and at boot for unread documents; it never notifies and never polls. D-37-3. |
| **R-2** (owner, 2026-10-20) | MCP-uploaded attachments are read like every other document; no model call inside an MCP tool's request. | W1 | The kick lives in `writeAttachment`, after the row is committed, for manual and MCP alike (F-37-15, F-37-17); the MCP response never waits on it. |
| **R-3** (owner, 2026-10-20) | A booking-change proposal kind, Phase 3. | none | Out of scope here; recorded so no wave drifts into it. |
| **O-3** | Conditions + Due alone are worth shipping if the ledger disappoints; reviewed as it goes. | W0 | Encoded in the gates: G-37-1 decides shipping, G-37-2 decides only whether Phase 2 is written. |
| **D-34-1, D-34-2, D-34-6, D-34-7** | API-enforced output contract; parse one block, validate in code; one contract per workload on every model; enum case normalised. | W1 | The facts contract follows them exactly (§4). D-37-4. |
| **D-34-5** (schema budget) | Never an optional property; `""` for not given. | W0, W1 | `FACTS_OUTPUT_SCHEMA` has 0 optional properties and 0 unions; the budget test is extended to walk it; W0 compiles it first. |
| **D-30-1, D-30-6** | Settings keyed by model; allowances from measurement. | W0, W1 | Rows for both 5.5 models; `FACTS_MODEL` picks; the allowance is 2× W0's largest observed output. |
| **D-30-3** | Classify the stop; a cut-off is a named failure, never a silent retry. | W1 | Every read records `complete` / `refused` / `truncated` / `invalid` / `error`; no auto-retry. |
| **D-30-7** | The harness never touches owner data. | W0 | **Amended for W0 by O-4:** owner documents are read as inputs from a read-only production backup copy; nothing is written; run files keep parsed facts and hashes under `private/`. D-37-11. |
| **D-33-1** | One generation per destination; in-process registry. | W1 | The read job reuses the registry pattern, keyed by document. |
| **Plan 3 D4, D5** | The document vault; the full-screen viewer with a near-white pane. | W2 | The viewer gains a `page` prop; the pane and overlay stay as they are (Plan 18 D2). |
| **Plan 16** (Logistics obsidian refit) | Gold once per card on the confirmation ref; notches anchored on the footer line; `:only-child` span. | W2 | Conditions on a card carry no gold and sit where F-37-27 says they are safe. |
| **Plan 20** (expenses store per route) | A route-scoped store is never lifted into `TripPage`. | W2, W3 | `useDocumentFacts` is instantiated by `LogisticsTab` only. |
| **Plan 21 D3** | A mutation failure has one owner; action hooks are namespaced. | W2 | The facts hook is read-only; its load error renders inline in Logistics, like expenses. |
| **D-27-1** | "Verified" or no label; never a negative word. | W2 | A booking with no facts shows nothing; a quote that could not be verified says "read from image", a fact about the source, not a verdict. |
| **Plan 28 cost boundary** | Never a model call on the MCP path. | W1 | Clarified by R-2: no model call inside a tool request; background reads are channel-blind. |
| **Public share rule; R-12** | No bookings, documents or co-pilot history in the public payload. | W1 | Facts are a new table hung on bookings; `buildPublicTripDetail` already whitelists (F-37-23); a test holds the exclusion. D-37-7. |
| **Plan 36** (Discovery catalogue completeness, W1 deployed 2026-10-20) | A catalogue is fresh only when complete. | none | Independent. Both plans edit `claude.js`; merge in sequence, never side by side. |

---

## 3. Decisions — PROVISIONAL until the named gate; stamp markers only when a wave lands

- **D-37-1 — A fact belongs to a document, and a document is read once per contract.** The read key is `content_hash` + model + `FACTS_PROMPT_VERSION`; every attempt writes a `document_fact_reads` row; a document is re-read only when the key changes, a previous read failed, or a backfill is asked for. A booking shows the facts of its documents, resolved the way `resolveBookingDocuments` resolves them (F-37-16), so one PDF backing two flights shows its baggage line under both. Deleting a document deletes its facts (cascade). *Gate:* W1 tests. Marker in `services/documentFacts.js`.
- **D-37-2 — No fact without its quote, and verification is recorded, not assumed.** The server refuses to store a fact whose `quote` is empty (a named `invalid` outcome). `quote_verified = 1` only when the normalised quote is found in text Trippy extracted itself: the PDF's text layer, or the pasted text. A fact from an image, or from a PDF with no text layer, is stored unverified and shown as "read from image". When the text layer locates the quote on a page, `verified_page` is stored beside the model's `page`, and the UI prefers it. *Gate:* W1 tests on a text-layer PDF, a CJK PDF, a scanned PDF and an image. Marker in `services/documentText.js`.
- **D-37-3 — Reads are channel-blind, deferred, single-flight and capped (R-1, R-2).** One kick in `writeAttachment` after its transaction (manual and MCP alike) and one at import confirm; the job is an async IIFE with `.catch` (F-37-19), registered in a module `Map` keyed by document before any `await` (F-37-18); `MAX_DOCUMENT_READS_PER_DAY` (config, default 300, in-memory like the discovery budgets) gates it; a boot pass after migrations queues every document with no `complete` read for the current key, so a restart mid-read heals itself and a backfill is the same pass. No notification, no poll, no new mechanism. *Gate:* W1 tests (single-flight, cap, boot pass, MCP path). Marker at the kick sites.
- **D-37-4 — The facts contract is API-enforced under Plan 34's rules.** `FACTS_OUTPUT_SCHEMA` is one object type with every property required, `""` for not given, no `anyOf`, inside `validateAgainstSchema`'s keyword set (F-37-9); **W0 found `maxItems` rejected by the API on every model, so the schema carries none and the validator is not extended.** One text block is parsed and validated; refused, truncated, invalid and error are named outcomes on the read row and are never repaired or retried automatically. *Gate:* W0 compile probe (schema accepted on both 5.5 models), W1 tests. Marker beside the schema constant.
- **D-37-5 — Conditions show only where there is something to show.** A booking with no facts shows no Conditions section and no copy. On a card, at most two quiet lines (the next deadline, the first window) with no gold; the full list with quotes and source taps lives in the detail sheet, between Documents and Costs. *Gate:* W2 browser pass at 375 px and desktop. Marker in `LogisticsTab.jsx` beside the section.
- **D-37-6 — Due is what is still ahead.** Facts of kind `deadline` whose `value_at` date is today or later, across the trip, ordered by `value_at`; a deadline leaves the strip after its day (no "missed" copy); the next one carries the single gold accent; the countdown reuses `formatCountdown` for days ahead and says "Today" for the same day (F-37-29 returns `''` there), with the time as written beside it when the document gave one. *Gate:* W3 browser pass. Marker in `components/logistics/DueStrip.jsx`.
- **D-37-7 — Facts are private trip data.** Never in `buildPublicTripDetail`, never in `get_trip`, never in the co-pilot context in this plan; a regression test holds each. *Gate:* W1 tests. Marker in `share.js` beside the whitelist.
- **D-37-8 — A pasted confirmation is a source too.** `import_artifact_files` of kind `text` are read like a PDF (today they are not documents, F-37-16); their quotes are verifiable by definition; their source line says "from the pasted confirmation", since there is no viewer URL for text. *Gate:* W1 tests, W2 browser pass. Marker in `documents.js`.
- **D-37-9 — The import-time reader is chosen by measurement.** Haiku 5.5 at `medium` reads at import unless W0 B2 shows it missing the costly kinds (deadline, window, requirement) by more than one point against Sonnet 5.5 at `medium`; both models get a `facts` row in `MODEL_PROFILES`, `FACTS_MODEL` picks (D-30-1), and no 4.x row exists because there is nothing to roll back to. *Gate:* W0 B2. Marker beside the profile rows. **Decided by W0 (2026-10-20): Haiku 5.5 `medium`** (B2 tie at 100 %).
- **D-37-10 — A time keeps its document's zone or says it has none.** `value_at` is stored as written (local to the place); `value_tz` is set only when the document states a zone or the booking's own `origin_tz`/`destination_tz` columns supply one, and `tz_source` records which; the UI shows "zone not stated" rather than assuming. *Gate:* W0 grading (does a booking-supplied zone ever mislead?), W2 browser pass. Marker in the prompt's rule 5.
- **D-37-11 — W0 reads owner documents from a read-only production backup copy and writes nothing.** Enumeration opens the copy with `readonly: true`; the readiness prototype works on a disposable copy of that copy through `initDb`; the owner's dev database is never opened for writing; run files and grading sheets live under `data/model-eval/private/facts/` (gitignored) and hold parsed facts and hashes, never document bytes. *Gate:* W0 side-effect table. Marker in `facts.mjs`.
- **D-37-12 — One switch stops the reads.** `DOCUMENT_FACTS_ENABLED` (default on, read at startup like `MCP_ENABLED`) disables the kicks and the boot pass without a code change; the UI shows nothing when no facts exist. Feature rollback is one revert plus a redeploy; migration 038 is additive and stays. *Gate:* W1 test, W4 deploy. Marker in `config.js`.

---

## 4. The contract

### 4.1 Schema (W0 compiles it; W1 lands it)

```js
export const FACT_KINDS = Object.freeze([
  'deadline', 'window', 'requirement', 'instruction', 'allowance', 'contact', 'restriction', 'cost_condition',
]);

// D-37-4 (Plan 37): one object type, every property required, "" for not given, no anyOf —
// inside D-34-5's budget (0 optional properties, 0 unions) and validateAgainstSchema's keyword set
// plus maxItems. The `at` pattern's optional group is the one construct W0's compile probe must
// confirm (Plan 34 saw a range quantifier on a group rejected; `+` on a group accepted).
export const FACTS_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['documentSummary', 'language', 'facts'],
  properties: {
    documentSummary: { type: 'string', description: 'One line: what this document is, e.g. "Hotel confirmation, 3 nights".' },
    language: { type: 'string', pattern: '^[a-z]{2}$', description: "ISO 639-1 code of the document's primary language." },
    facts: { type: 'array', maxItems: 40, items: { $ref: '#/$defs/fact' } },
  },
  $defs: {
    fact: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'label', 'value', 'quote', 'page', 'at', 'tz', 'tzSource', 'appliesFrom', 'appliesTo', 'confidence'],
      properties: {
        kind: { enum: [...FACT_KINDS] },
        label: { type: 'string', description: 'Up to five English words, e.g. "Free cancellation until".' },
        value: { type: 'string', description: 'The condition as one short English phrase.' },
        quote: { type: 'string', description: 'The sentence or fragment exactly as printed, in its original language. Never paraphrase, translate or shorten it.' },
        page: { type: 'string', pattern: '^([1-9][0-9]{0,2})?$', description: 'Page number as printed, 1-based; "" for a single image or when pages are not distinguishable.' },
        at: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?)?$', description: 'The moment the condition refers to, local to the place: a date, or a date and time; "" if none.' },
        tz: { type: 'string', pattern: '^([A-Za-z]+(/[A-Za-z0-9_+-]+)+)?$', description: 'IANA zone only when stated by the document or supplied by the booking context; "" otherwise.' },
        tzSource: { enum: ['document', 'booking', 'none'] },
        appliesFrom: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' },
        appliesTo: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' },
        confidence: { enum: ['high', 'medium', 'low'] },
      },
    },
  },
});
export const FACTS_OUTPUT_FORMAT = Object.freeze({ type: 'json_schema', schema: FACTS_OUTPUT_SCHEMA });
export const FACTS_PROMPT_VERSION = '37.1';
```

Budget: 0 optional properties, 0 unions (no `anyOf`), 5 patterns, 3 enums, 1 `$ref` definition. `maxItems` is new to `validateAgainstSchema` and to `claude.test.js:2114`'s list of rejected keywords (it moves to the supported side with a test). If W0's compile probe rejects the `at` pattern's `( … )?` group, `at` becomes two fields, `date` and `time`, each with a flat pattern, before W1; the stored shape is the same either way.

### 4.2 Prompt (W1 lands it; W0 measures it on the wire from a harness constant that must match)

This is version 37.1 as W0 measured it and W1 landed it. W2b amended it to 37.2 (the allowance examples, rule 5, new rules 10 to 12, the reasoning guard as rule 13; §6 W2b); `FACTS_SYSTEM` in `claude.js` is the live text.

```
You are a travel-document reading engine. You receive one document that belongs to a traveller's booking (a confirmation email, an e-ticket, a hotel voucher, a pass, a tour voucher, a luggage-forwarding sheet, or a screenshot of one) and must list every condition in it as structured JSON.

A condition is anything that could change what the traveller must do, bring, pay or expect, or when: deadlines (cancel by, change by, check-in opens, pay by, collect by), windows (check-in hours, reception hours, pickup time, entry slot, validity period), requirements (passport, printed voucher, the card used to pay, a QR code, an ID matching the name), instructions (meeting point, platform, terminal, how to reach, what to show), allowances (baggage, seats, guests, breakfast), contacts (phone, email, address in local script), restrictions (non-refundable, non-changeable, no late entry, age limits), cost conditions (deposit, city tax, resort fee, late fee).

Rules:
1. Read the whole document, every page. One fact per condition; a condition stated twice is one fact.
2. NEVER invent a value. Quote the sentence or fragment exactly as printed, in its original language; never paraphrase, translate or shorten the quote. Put the English reading in "value".
3. Skip boilerplate that names no specific time, amount, place or action (general terms, marketing, "subject to conditions" lines). Keep anything with a time, a date, an amount, a place, a name requirement or an action.
4. "at" is the moment the condition refers to, local to the place, as a date or a date and time; "" when the condition has none. A date without a year takes the year from the booking context below; make no other inference.
5. "tz" is the IANA zone only if the document states a zone or the booking context supplies one, and "tzSource" says which; otherwise "" and "none". Never guess a zone.
6. "page" is the page number as printed, 1-based; "" for a single image or when pages are not distinguishable.
7. "kind" is one of the eight kinds; choose the closest. "label" is up to five English words; "value" is one short English phrase.
8. The booking context below (type, title, dates, zones, trip dates) is for disambiguation only; never produce a fact from the context itself.
9. If the document holds no condition, return an empty "facts" array; never pad.
10. Do not explain your reasoning in prose.
```

The user turn is one text block of booking context (type, title, start, end, `originTz`, `destinationTz`, trip dates; no "today", since nothing here depends on it) followed by the document block in extraction's transport (F-37-11): `text`, `image`, or `document`. The request is `messages.create` with `requestSettings(profile, { format: FACTS_OUTPUT_FORMAT })`, the system string as a plain string (no `cache_control`: one document per call, nothing stable enough to cache), `max_tokens` measured in W0 and set to about 2× the largest observed output (D-30-6; the ceiling for a non-streaming call is 21,333, F-37-7).

### 4.3 Verification and storage

- **Text layer.** `services/documentText.js` extracts text from a PDF with `pdfjs-dist` (legacy build, `getTextContent()` per page, pages joined with markers; Q-37-4) and passes a text artifact through. `findQuote(text, quote)` normalises both sides (Unicode NFKC, every whitespace character removed, zero-width characters removed) and returns `{ found, page }`. No OCR; an image or a scanned PDF yields no text and the fact is stored unverified.
- **Tables (migration 038, additive).** `document_fact_reads`: `id` TEXT hex, `trip_id` FK CASCADE, `booking_id` NULL FK CASCADE (attachments only), `artifact_file_id` NULL FK CASCADE, `attachment_id` NULL FK CASCADE, `content_hash`, `model`, `prompt_version`, `status` CHECK (`complete` | `refused` | `truncated` | `invalid` | `error` | `skipped`), `fact_count`, `verified_count`, token counts, `total_ms`, `stop_reason`, `error` (a short category, never document text), `created_at`; a CHECK that exactly one of the two source columns is set; indexes on `(content_hash, model, prompt_version)` and `(trip_id, created_at)`. `document_facts`: `id`, `read_id` FK CASCADE, `trip_id` FK CASCADE, `booking_id` NULL FK CASCADE, the same source pair, `kind` CHECK (the eight), `label`, `value`, `quote`, `page` NULL, `verified_page` NULL, `quote_verified` INTEGER 0/1, `value_at` NULL, `value_tz` NULL, `tz_source` CHECK, `applies_from` NULL, `applies_to` NULL, `confidence` CHECK, `position`, `created_at`; indexes on `(trip_id, kind, value_at)` and `(booking_id)`. `tests/migrations.test.js:96` moves from 37 to 38 rows.
- **API.** `GET /api/trips/:tripId/facts` (`requireTripAccess`) returns `{ bookings: [{ bookingId, facts: [...] }], readsPending }`, where artifact-file facts are attached to every booking whose `importedFrom.artifactId` names the file's artifact (D-37-1) and each fact carries its document `key` and `url` (for the source tap) and `verifiedPage ?? page`. `documents[]` in the detail payload gains an additive `key` (`artifactFile:<id>` | `attachment:<id>`) so the client can pair facts to document pills.
- **What stays out.** No facts in `/detail`, in the share payload, in `get_trip`, in the co-pilot context (D-37-7). No facts for the public page's `days`.

---

## 5. Gate and measurement (W0)

Everything runs through `backend/scripts/modelEval/` under Plan 30's rules as amended by D-37-11: a read-only backup copy for inputs, side-effect counts printed, `--max-usd` capped, recorded request bodies, blinded grading, private material never committed.

**Corpus.** A production backup copy taken with the existing ritual (`docs/DECISIONS.md`, "Production server facts": host `sqlite3` into `~/Trippy/backups/`), copied to `backend/data/model-eval/private/db/prod-<date>.db` (gitignored) with the owner's approval (Q-37-1). Step 1 is a **census**: trips × documents (import files by kind, attachments) × bookings, printed before any paid call. The assessment's threshold stands: if fewer than three trips carry eight or more documents, the owner adds confirmations from the last two years as private fixtures under `private/facts/<id>/fixture.json` (the extraction private-fixture shape, F-37-5, plus a `bookingContext`), and the census is re-run.

**Runs.**
- `facts.mjs --profile facts-haiku-55-medium | facts-sonnet-55-medium | facts-sonnet-46-medium` over every document in the corpus (`--db <copy>` or `--private`), the live-to-be prompt and schema from `lib/factsContract.mjs` (W1 must land them byte-identical, pinned by a test, as `lib/emitCategoryTool.mjs` and Plan 35 did). Sonnet 4.6 runs on the image subset only (B1). Each record keeps the parsed facts, the verification result against the text layer (the harness carries its own copy of `findQuote` until W1), usage and cost.
- `readiness.mjs --profile readiness-sonnet-55-high --facts <facts run>` per trip: the input is the trip as the co-pilot serialises it (`copilotTools.js`, imported, not copied), bookings with their zones and details, the chosen facts run's facts for that trip, and `runTripHealthChecks(getTripDetail(tripId))` findings (on a disposable `initDb` copy of the backup copy); the output contract is a harness-only `READINESS_OUTPUT_SCHEMA` (`lib/readinessPrototype.mjs`: items of kind `holds` | `conflict` | `question` with `text`, `evidence` ids and `severity`). This is a prototype for grading, not the Phase 2 design.
- `schemaProbe.mjs --only facts-haiku-5-5,facts-sonnet-5-5,facts-sonnet-4-6,readiness-sonnet-5-5`: compile both schemas with `noformat` / `cold` / `warm` and record the input-token overhead.
- `score.mjs facts` and `score.mjs readiness` read the graded sheets and print the gate numbers.

**Grading, by the owner, blind to model.** `facts.mjs --sheets` writes one markdown sheet per document under `private/facts/grading/<run>/`, model hidden behind a code (a key file maps codes to runs), listing each fact as label, value, quote, page, verified or not, with a column for ✓ correct / ✗ wrong / and a line for anything missing. A hand-checked sample of about 30 documents, chosen by the census to cover every kind of document and every language present. `readiness.mjs --sheets` writes one sheet per trip listing each ledger line with its evidence and three columns: true / false; already known / new; would it have changed an action.

**Gates.**
- **G-37-1, trust (decides whether anything ships).** On the sample, facts of kind deadline, window or requirement wrong in **no more than 3 %** of such facts, counted per fact against the document, and missing costly facts (ones the owner marks as present in the document but absent from the sheet) at most 1 in 10. Fail: nothing ships; the numbers go to DECISIONS.md.
- **G-37-2, payoff (decides whether Phase 2 is written).** At least **half** of the document-rich trips (eight or more documents) yield at least one ledger line the owner marks new, true and action-changing. Fail: this plan continues (O-3); the Phase 2 plan is not written, and the numbers are recorded.
- **G-37-3, ledger trust.** No more than **1 in 10** ledger lines false. Fail: as G-37-2, and the cause is named (time zone, a stale document, a missing fact) so a later attempt knows where to start.
- **B1, the vision hypothesis.** On the image subset, Sonnet 5.5 against Sonnet 4.6 on the costly kinds. Recorded whatever it says; it changes no decision in this plan, only the assessment's honesty note.
- **B2, the import-time reader (D-37-9).** Haiku 5.5 `medium` within one point of Sonnet 5.5 `medium` on the costly kinds → Haiku reads at import; otherwise Sonnet, and §9's cost line changes.
- **Contract.** Both schemas accepted on both 5.5 models; `max_tokens` stops 0 at the chosen allowance; refusals 0 (rule 10 kept); quote verification rate on text-layer documents reported (it is the production "standing log check" baseline).

**Budget (list prices, F-37-3).**

| Step | Calls | Spend |
|---|---|---|
| Compile probes | 4 schemas × 3 requests | ≈ $0.05 |
| Facts, Haiku 5.5 and Sonnet 5.5, ~60 documents each | ~120 | ≈ $1.0 |
| Facts, Sonnet 4.6 on ~20 images | ~20 | ≈ $0.4 |
| Readiness prototype, ~6 trips × 2 runs at `high` | ~12 | ≈ $3.0 |
| **Total** | | **≈ $4.5, cap `--max-usd 8`** (Q-37-9) |

---

## 6. Waves

Each wave starts by reading this plan, implements only that wave on its own branch, runs `cd backend; npm test` (and `cd frontend; npm test; npm run build` where the frontend is touched), updates its status line with evidence, and commits. A PR is optional (owner ruling 2026-10-19). Plan 36 and this plan both edit `claude.js`; merge in sequence.

### W0 — Measure (harness only, no production change)

**Status:** COMPLETE 2026-10-20 (branch `plan37-w0`). Every gate measured on the owner's whole production corpus (6 documents; the designed sample was ~30): **G-37-1 PASS** (0 wrong, 0 missing costly facts on all three readers, under the owner's ruling on what "missing" covers) — W1 may proceed once Plan 38 lands; **G-37-2 FAIL** (0 of 27 ledger lines new) — **the Phase 2 plan is not written**; **G-37-3 PASS** (1/27 false); **D-37-9: Haiku 5.5 `medium` reads at import** (B2 tie at 100 %); B1 a tie. The contract drops `maxItems` (API-rejected). Spend $0.55 of the $8 cap. Results below; `docs/DECISIONS.md` "Plan 37 W0 — measured outcomes".

**Files.** `backend/scripts/modelEval/facts.mjs`, `readiness.mjs`, `lib/factsContract.mjs` (schema, prompt, `findQuote`), `lib/readinessPrototype.mjs`, `lib/score/facts.mjs`, `lib/score/readiness.mjs`, `profiles.mjs` (the four facts and readiness profiles), `schemaProbe.mjs` (four probes), `lib/pricing.mjs` (unchanged unless prices moved; re-check), `README.md` under `modelEval`; `package.json` gains `pdfjs-dist` as a **devDependency** for the harness's `findQuote` (promoted to a dependency in W1). Nothing under `backend/src` or `frontend` changes.

**Steps.**
1. **Corpus and census.** With the owner's approval, take a production backup copy (the existing ritual) to `private/db/`; `facts.mjs --db <copy> --census` prints trips, documents by kind and language guess, bookings, and the document-rich trip count, and opens the copy `readonly: true`. If fewer than three trips are document-rich, pause for private fixtures (Q-37-1) and re-run the census.
2. **Compile probe.** The four probes; record acceptance, cold and warm latency, and input-token overhead. If the `at` pattern is rejected, split it (§4.1) and re-probe before step 3.
3. **Facts runs.** The three profiles over the corpus (Sonnet 4.6 on images only), `--max-usd 8`. Print per profile: documents, facts, facts per document, costly-kind count, verification rate on text-layer documents, `stop_reason` counts, largest output, cost per document and per run.
4. **Grading sheets** for the sample; the owner grades; `score.mjs facts` prints G-37-1 and B1/B2.
5. **Readiness prototype** on the chosen facts run, two runs per trip; sheets; the owner grades; `score.mjs readiness` prints G-37-2 and G-37-3.
6. **Side-effect table** (dev database read-only counts, copy counts) printed at the end of every script; the private directory listed to confirm nothing left it.
7. Record every number in this plan, whatever it says, with the decisions D-37-9 and the Phase 2 go / no-go stated.

**Acceptance.** The census, the compile table, the facts table, the grading results, the readiness results, the gate verdicts and the spend are pasted here; D-37-9 is decided; nothing under `src/` changed; the side-effect table is clean.

#### W0 results

**The harness (2026-10-20).** Under `backend/scripts/modelEval/` (README section "Document facts and the readiness prototype"): `facts.mjs` (census, paid run, blind sheets), `readiness.mjs` (prototype run, sheets), `lib/factsContract.mjs` (schema, prompt, request builder, answer classifier, `findQuote`), `lib/factsCorpus.mjs` (document enumeration, D-37-1 dedupe by content), `lib/sourceDb.mjs` (read-only source, disposable copy, all-table side-effect counts), `lib/documentText.mjs` (`pdfjs-dist` text layer), `lib/readinessPrototype.mjs`, `lib/score/facts.mjs`, `lib/score/readiness.mjs`, a `compare` hook in `score.mjs`, five probes in `schemaProbe.mjs`, `renderFactsFixtures.mjs` and `fixtures/facts/` (a two-page text-layer hotel PDF and a Japanese pasted confirmation, synthetic), `lib/chromium.mjs` (Chromium finder shared with `renderExtractionFixtures.mjs`). §4.2's prompt and §4.1's schema were checked byte-for-byte against this plan's text before the first call. Backend suite green (47 files, 1,264 tests); nothing under `src/` or `frontend/` changed.

**Step 2 — compile probe** (`schemaProbe.mjs`, run file `runs/schema-probe/2026-10-20T10-46-13-941Z.jsonl`, 15 requests, $0.0928):

| Probe | §4.1 as written | §4.1 without `maxItems` | Cold / warm | Format overhead (input tokens) | Answer |
|---|---|---|---|---|---|
| facts, Haiku 5.5 `medium` | **rejected** (400) | accepted | 6.3 s / 4.7 s | 943 → 2,122 (+1,179) | 3 facts, valid |
| facts, Sonnet 5.5 `medium` | **rejected** (400) | accepted | 4.1 s / 2.6 s | 943 → 2,122 (+1,179) | 3 facts, valid |
| facts, Sonnet 4.6 `medium` + adaptive | **rejected** (400) | accepted | 22.3 s / 6.5 s | 712 → 1,694 (+982) | 3 facts, valid |
| readiness, Sonnet 5.5 `high` | n/a | accepted | 5.8 s / 5.2 s | 1,059 → 1,533 (+474) | 1 conflict, valid |

- **`maxItems` is not supported by structured outputs:** "output_config.format.schema: For 'array' type, property 'maxItems' is not supported", on all three models. §4.1 assumed it was. **The contract is §4.1 without `maxItems`** (`FACTS_OUTPUT_SCHEMA` in `lib/factsContract.mjs`); a read is bounded by its `max_tokens` allowance, whose cut-off is the named `truncated` outcome, and W0 step 3 measures the real facts-per-document maximum. Consequences for W1: `validateAgainstSchema` gains **no** `maxItems` keyword (W1 step 2 and D-37-4's "plus maxItems" drop), and there is no 40-fact cap in code unless step 3's numbers argue for one. §4.1 as written is kept as `FACTS_OUTPUT_SCHEMA_AS_PLANNED` and probe `facts-plan-haiku-5-5`, so the rejection can be re-run.
- **The `at` pattern's nested optional group compiles** on all three models (§11's first open item is closed); the `date` / `time` split is not needed.

**Harness smoke on the synthetic fixtures** (2 documents per profile; `runs/facts/<profile>/2026-10-20T10-49-*.jsonl`): Haiku 5.5 `medium` 18 facts, Sonnet 5.5 `medium` 19 facts; both `complete` with `end_turn`; every quote found in the text layer (37/37, the CJK full-width quote through NFKC); every model page that was stated matched the page the quote was found on (23/23); the marketing paragraph skipped by both; largest output 2,539 tokens (Haiku, thinking included); $0.0018 (Haiku) and $0.026 (Sonnet) for the two-page PDF. Seen, for grading rather than verdicts: Haiku credited "(Japan time)" to the booking (`tzSource: booking`) where Sonnet said `document`; both filled the check-in date from the booking's arrival day; Haiku dropped the 15:00 from the ryokan check-in's `at`. The grading sheets carry `at` and the zone with its source for that reason. Side-effect table unchanged on every run.

**Found while building — for W1, not W0.** `pdfjs-dist` releases that run on Node 20 (5.6.83 up to, not including, 6.2.108) carry GHSA-hq66-cqwq-w95j (high: arbitrary JavaScript execution on opening a malicious PDF); the patched releases need Node ≥ 22.13. W0 uses `pdfjs-dist ~6.4.299` as a devDependency (this machine runs 22.14). Production's Dockerfile is `node:20-alpine`, and Node 20 left support in April 2026, so W1's promotion of `pdfjs-dist` to a dependency needs the image moved to Node 22 (rebuild plus the backend suite on 22), not a pin to a vulnerable release. F-37-25 and §11's third open item ("loads on `node:20-alpine`") change accordingly.

**Step 1 — corpus and census (2026-10-20).** Production backup taken by the agent at the owner's instruction with the host ritual (`sqlite3 .backup` as chee into `~/Trippy/backups/trippy-pre-plan37w0-20261020-105743.db`, `PRAGMA integrity_check` ok, production only read), copied to `backend/data/model-eval/private/db/prod-2026-10-20.db` (sha256 `e80b4fc4…a19334`, identical on both ends; gitignored). `facts.mjs --db … --census`, no API call:

| | Production copy |
|---|---|
| Trips / bookings | 8 / 17 |
| Trips with a document | 2 (`Penang - Deploy B`, `Shanghai - Hangzhou (W4 Test)`), both test trips |
| Documents (unique content) | 2: one image (import), one 2-page PDF with a text layer (manual attachment) |
| Import files backing no booking | 3 (artifact status confirmed 1, extracted 2) |
| Document-rich trips (≥ 8 documents) | **0** |

**Verdict: the production corpus cannot carry W0** (§5's threshold is three document-rich trips). Per Q-37-1's default, W0 pauses for the owner's confirmations from the last two years, and the census is re-run on them. One constraint shapes how they arrive: the readiness prototype needs a real trip (`getTripDetail`: days, bookings, health findings), so loose files under `private/facts/<id>/` can feed the facts runs (G-37-1, B1, B2) but not G-37-2 or G-37-3; confirmations imported into Trippy trips feed both. The census also exposed that pdfjs needs its data directories on Node: `lib/documentText.mjs` now passes `cMapUrl` (without it a CJK PDF on a predefined CMap decodes to the wrong characters and no quote could verify), `standardFontDataUrl` and `wasmUrl`. W1's `documentText.js` must do the same.

**Step 1, second census (2026-10-20, owner's ruling).** The owner has no further confirmations to supply (screenshots for four Chengdu–Chongqing bookings only, none in Chinese or Japanese) and imported those four into production in one import (4 files, artifact confirmed 11:11 UTC). Fresh backup `trippy-pre-plan37w0-20261020-111533.db` (integrity ok, sha256 `56cade53…92ec9`, local `prod-2026-10-20b.db`). Census: 3 trips with documents, **6 documents** (5 images, 1 PDF), the Chengdu–Chongqing trip 4 documents across 7 bookings, document-rich trips **0**. The grading sample is all six. W0 ran on this corpus; the gates are read against its size below.

**Step 3 — facts runs** (`--db prod-2026-10-20b.db`; run files `runs/facts/<profile>/2026-10-20T11-16-*.jsonl`):

| | Haiku 5.5 `medium` | Sonnet 5.5 `medium` | Sonnet 4.6 `medium` (images) |
|---|---|---|---|
| Documents / outcomes | 6 / complete 6 | 6 / complete 6 | 5 / complete 5 |
| `stop_reason` | end_turn 6 | end_turn 6 | end_turn 5 |
| Facts (per document median / max) | 36 (6 / 10) | 35 (6 / 11) | 30 (5 / 11) |
| Costly-kind facts | 16 | 15 | 12 |
| Quotes verified on the text-layer document | 10/10 | 11/11 | n/a (no text layer) |
| Model page = page found | 10/0 | 11/0 | n/a |
| Largest output tokens | 4,319 | 1,703 | 1,659 |
| Cost per document median / max | $0.0009 / $0.0029 | $0.0154 / $0.0318 | $0.0193 / $0.0324 |
| Run cost | $0.0074 | $0.1006 | $0.1024 |

Refusals 0, cut-offs 0, invalid 0. Five of six documents are screenshots, so quote verification (D-37-2) applies to one document: on real data most facts will be stored unverified ("read from image"). The readers disagree visibly on one screenshot (facts 5 / 2 / 4, costly 2 / 0 / 2), which grading settles. The largest output, 4,319 tokens, is Haiku's thinking-inclusive answer on the two-page PDF; W1's allowance at 2× is about 8,700 (D-30-6).

**Step 5 — readiness prototype** on the one real trip with documents (Chengdu–Chongqing, `--min-docs 4`), Sonnet 5.5 `high`, two repeats over each 5.5 facts run (`runs/readiness/readiness-sonnet-55-high/2026-10-20T11-17-36-096Z.jsonl` over Haiku's facts, `…11-18-15-790Z.jsonl` over Sonnet's): all four complete, input ~12,600–13,000 tokens, output 2,144–2,885, $0.046–$0.054 each ($0.20). Items per run: holds 2 / 2 / 2 / 3, conflicts 0 / 0 / 1 / 0, questions 4 / 3 / 3 / 7; unknown evidence ids 0.

**A confound the owner found in the same session.** One import of four screenshots created four bookings, and **every booking shows all four screenshots** under Documents (the SQ 842 flight lists the Chongqing hotel's voucher). Root cause: the booking-to-document link is artifact-level — `confirm` stamps only `importedFrom.artifactId` (`importer.js:181`), extraction never says which input file a booking came from, and `resolveBookingDocuments` returns every image and PDF file of the artifact (`documents.js:11-27`). F-37-14 recorded "one artifact can back several bookings" but not "one artifact holds several unrelated files". Consequences: (1) **D-37-1 as written would show every screenshot's conditions under every booking of that import** (a hotel's check-in window under a flight), so W1 cannot land before the file-to-booking link exists; (2) in W0, `lib/factsCorpus.mjs` attributes each of the four screenshots to all four bookings, so the readiness input tells the model every fact belongs to four bookings, which may produce false conflicts or questions — the grader should mark such lines false and note the cause. Facts accuracy (G-37-1, B1, B2) is unaffected: a fact is graded against its own document.

**Readiness grading (owner, 2026-10-20; marks given in chat and transcribed into the four sheets).** 27 ledger lines over the four runs (11 over Haiku's facts, 16 over Sonnet's): **26 true, 1 false (3.7 %)**; all 27 marked *already known* and *would not have changed an action*.
- **G-37-3 (ledger trust, ≤ 1 in 10 false): PASS** — 1/27 pooled (1/11 = 9.1 % over Haiku's facts, 0/16 over Sonnet's). The false line is a `question` asking whether the Regent Chongqing confirmation's additional charges and taxes sit inside its total; it rests on two facts whose "quotes" are bare column labels read from a screenshot ("Additional charges", "Taxes"). Cause named per §5: a weak fact (a label quoted instead of a sentence), not a time zone or a stale document.
- **G-37-2 (payoff, at least half of document-rich trips yield a new, true, action-changing line): FAIL** — 0 of 27 lines new, 0 action-changing, on every repeat. **The Phase 2 plan is not written** (§7; O-3 keeps W1–W4 open on G-37-1 alone). Read against its corpus: the gate was designed for three or more trips with eight or more documents, and the owner's whole production corpus is one real trip with four screenshots, so this measures "on everything the owner keeps in Trippy, a cross-document check found nothing the owner did not already know", not the designed sample. Both readings are recorded; the verdict is the rule's.
- The multi-file attribution confound (above) cost nothing here: no line was marked false for mixing up which screenshot belongs to which booking.

**Steps 4 and 6 — facts grading and scoring (owner, 2026-10-20).** The owner graded all 17 sheets blind (marks given in chat, transcribed into the sheets; one row of 06-B, an `instruction`, left unmarked and counted ungraded). Codes: A Haiku 5.5, B Sonnet 5.5, C Sonnet 4.6 (`key.json`). Every one of the 100 marked rows was marked correct. The owner listed as missing: "total charges/cost" (04-A) and the flight date, flight number, departure and arrival airport of the Capella test trip's PDF, a flight document attached to a hotel booking (06-A, 06-B). **Owner ruling (2026-10-20): those are outside the facts' job** — the flight details are a booking's own data, the total is a cost condition, not a costly kind — so the total is kept as a `cost_condition` miss and the flight details move to the sheets' Notes with the ruling; strictly counted, both 5.5 readers would have failed G-37-1 at 21–24 % missing per fact (Haiku 5 of 21, Sonnet 5.5 4 of 19).

| | Haiku 5.5 `medium` | Sonnet 5.5 `medium` | Sonnet 4.6 `medium` (images) |
|---|---|---|---|
| Facts graded / ungraded | 36 / 0 | 34 / 1 | 30 / 0 |
| Costly (deadline / window / requirement) correct / wrong / missing | 16 / 0 / 0 | 15 / 0 / 0 | 12 / 0 / 0 |
| Costly wrong | 0 % | 0 % | 0 % |
| Missing, per fact / per document | 0 % / 0 of 6 | 0 % / 0 of 6 | 0 % / 0 of 5 |
| Costly score (all / images) | 100 % / 100 % | 100 % / 100 % | — / 100 % |
| **G-37-1** | **PASS** | **PASS** | PASS |

- **G-37-1 (trust): PASS.** The per-fact vs per-document reading of "missing at most 1 in 10" is moot (0 either way). Size, honestly: 43 costly facts graded with 0 wrong. That meets the 3 % limit as written; it cannot prove it — with 0 errors in 43 the plausible error rate still reaches about 7 % (rule of three) — so W4's standing log checks and the owner's production pass carry the remaining weight.
- **B2 / D-37-9: Haiku 5.5 `medium` reads at import** (tie at 100 %, 0 points behind; Haiku costs $0.0009 per document median against Sonnet's $0.0154). §9's cost line stands.
- **B1 (vision): a tie** — Sonnet 5.5 and Sonnet 4.6 both 100 % on the five screenshots (none CJK). The hypothesis is neither confirmed nor refuted at this size; recorded, no decision changes.
- **The owner's notes — W2 design inputs, not failures.** (1) Conditions that are true of the document but may not apply to the booking ("passengers on MH-operated flights …", re-checking baggage for an onward flight that does not exist) — W2 must decide how an inapplicable condition is shown or held back. (2) Cost conditions next to a total (Regent Chongqing: additional charges and taxes that are *inside* the CNY 5,404.02 total) must not read as extra cost; the readiness prototype's one false line came from the same two facts, whose "quotes" were bare column labels.

**Step 7 — verdicts and what W1 inherits.**
- **Gates:** G-37-1 PASS → W1–W4 may proceed. G-37-2 FAIL → **Phase 2 (the readiness ledger) is not written** (O-3). G-37-3 PASS (1/27 false; the cause named above).
- **W1 changes from this wave:** `FACTS_OUTPUT_SCHEMA` without `maxItems` (no validator change; D-37-4's "plus maxItems" drops); `facts` rows for Haiku 5.5 and Sonnet 5.5 with `FACTS_MODEL = claude-haiku-5-5` at `medium`; allowance about 2× the largest observed output, 2 × 4,319 ≈ 8,700 tokens (D-30-6), well under 21,333; `documentText.js` passes pdfjs its `cmaps/`, `standard_fonts/` and `wasm/` directories; `pdfjs-dist` ≥ 6.2.108 with the image on Node 22 (GHSA-hq66-cqwq-w95j); **Plan 38 (each booking linked to its own import file) lands first**, or D-37-1 shows one screenshot's conditions under every booking of its import.
- **Spend:** compile probe $0.093, synthetic smoke $0.044, facts runs $0.210, readiness $0.201 — **$0.55** of the $8 cap.
- **Side effects:** every run's table unchanged (production copies opened read-only; the readiness working copies unchanged before vs after and removed; the dev database unchanged); production itself was only read, by the host `sqlite3 .backup` ritual, twice.

### W1 — Contract, storage and the read job (D-37-1 … D-37-4, D-37-7 … D-37-12; R-1, R-2)

**Status:** COMPLETE 2026-10-20 on branch `plan37-w1` (not merged, not deployed; W4 deploys). Every acceptance item met: backend suite green (54 files, 1,426 tests; the kick stubbed suite-wide by `tests/setup/noDocumentFacts.js`, no network); `LIVE_ANTHROPIC=1` smoke green (7/7, the new test reads the two-page PDF through `readDocumentFacts`); the share payload, `get_trip`, `/detail` and co-pilot-context exclusions held by tests (D-37-7); the flag off produces no read; an MCP-channel attachment kicks a read (stubbed in `mcpUploads.test.js`, real in step 8). Markers stamped: D-37-1, -2, -3, -4, -7, -8, -9, -10, -12; DECISIONS rows added. **As built, beyond this section's text:** the contract was moved, not copied — `lib/factsContract.mjs` re-exports `claude.js`/`documentText.js`, and four sha256 pins taken from W0's harness constants at `72f8184` prove byte-identity; `facts` gains a live `control` profile. `classifyFactsResponse` stores a short error code only (`not_one_text_block`, `not_json`, `schema_mismatch`, `empty_quote`, `api_<status>`, `connection`, `aborted`, `unexpected`), because a validator message can echo document text. Reads run one at a time behind `setImmediate` (so the MCP kick inside its transaction runs after commit); the cap writes `skipped`/`daily_cap`; shutdown aborts the read in flight and writes nothing (F-37-19). `importFileRowsOf` in `documents.js` is the one enumeration of a booking's import files for Documents and facts (D-38-3), and `documents[]` gains the additive `key`. A per-source read is the unit (no cross-source reuse by hash: a fraction of a cent saved is not worth coupling two bookings' contexts). The image moved to `node:22-alpine` with `engines >=22.13` (GHSA-hq66-cqwq-w95j), and that forced `better-sqlite3` ^9.6.0 → ^12.11.1: 9.6.0 has no Node 22 musl prebuild, so the first local `docker build` failed in `npm ci` (node-gyp, no Python). Upgrading the driver was chosen over adding a compiler to the image. The rebuilt image was proved locally: the three fixture PDFs read inside it (page-2 and CJK quotes found, the scanned PDF has no text), and the server booted on a dev-database copy on Node 22.23.3, applied 038, ran the boot pass, answered `/api/health`, returned 401 on `/facts` without a session, and stopped cleanly on SIGTERM. That closes §11's `pdfjs-dist`-on-Alpine item ahead of W4. **Step 8 (dev copy).** The dev database has 22 import uploads but no document owned by a booking (both confirmed imports' bookings were deleted) and no attachments, so the boot pass correctly queued 0. On the same copy, three stored imports were confirmed through `confirmArtifact` (a PDF backing two KLM flights, a 12306 screenshot, a pasted SQ confirmation) and three PDFs attached (two manual, one through the MCP writer): 6 reads, all `complete`, 26 facts; quotes verified 2/2 (PDF), 11/11 (two-page PDF, page-2 facts located on page 2), 4/4 (CJK PDF through NFKC, MCP channel), 3/3 (pasted text); 0/3 on the screenshot and 0/3 on the scanned PDF, stored as read from image by design; the PDF's facts show under both flights; a second boot pass queued 0. Spend about $0.006 at list. **Seen, for W2 (not defects of W1):** the reader still emits a booking's own schedule as facts ("KL 1675 Amsterdam (AMS) 09:05" as a `window`), which the owner ruled are not facts for G-37-1; W2 decides whether such lines are shown, and any prompt change is a new `FACTS_PROMPT_VERSION` measured first.

**Files.** `backend/src/db/migrations/038_document_facts.sql`; `backend/src/services/claude.js` (`FACT_KINDS`, `FACTS_OUTPUT_SCHEMA`, `FACTS_OUTPUT_FORMAT`, `FACTS_SYSTEM`, `FACTS_PROMPT_VERSION`, `readDocumentFacts({ document, bookingContext, profile })`, `facts` rows under both 5.5 models, `FACTS_MODEL`, `WORKLOAD_MODELS.facts`, `maxItems` in `validateAgainstSchema`); `backend/src/services/documentText.js` (new); `backend/src/services/documentFacts.js` (new: `listDocumentsForTrip`, `kickDocumentReads`, the registry, the daily cap, `readOne`, persistence, `listTripFacts`, `requeueUnreadDocuments`); `backend/src/services/attachments.js` (kick after `writeAttachment`'s transaction); `backend/src/services/importer.js` (kick after confirm); `backend/src/services/documents.js` (additive `key`; text inputs as sources, D-37-8); `backend/src/routes/trips.js` (`GET /:tripId/facts`); `backend/src/config.js` (`documentFactsEnabled`, `documentReadsDailyBudget`); `backend/src/index.js` (boot pass after migrations, behind the flag); `backend/tests/setup/noDocumentFacts.js` (suite-wide stub of the kick, registered in `vitest.workspace.js` beside `noDiscoveryPrewarm.js`); tests: `migration038.test.js`, facts-contract tests in `claude.test.js` (budget walk extended to `FACTS_OUTPUT_SCHEMA`; pinned request body; stop classification; every validation failure named; `maxItems` supported), `documentText.test.js` (text-layer PDF, CJK PDF, scanned PDF, image, pasted text, whitespace and NFKC cases, page location), `documentFacts.test.js` (enumeration including text inputs and MCP attachments; single-flight; daily cap; persistence and cascade; boot pass; flag off), privacy tests (share payload, `get_trip`, co-pilot context contain no facts), `tests/live/anthropic.live.test.js` (one synthetic PDF through `readDocumentFacts`); `package.json` (`pdfjs-dist` as a dependency; the Docker build on `node:20-alpine` proves it loads without native modules).

**Steps.**
1. Migration 038 and its test (template `migration035.test.js:55-118`); the 37 → 38 count.
2. The contract in `claude.js`, byte-identical to W0's harness constant (a test pins the hash, as the prompts are pinned today); `maxItems` added to the validator with its test; the budget walk extended.
3. `documentText.js` and its tests on committed synthetic fixtures (a generated text-layer PDF, a CJK one, a scanned-style image-only PDF, a PNG).
4. `documentFacts.js`: enumeration (import files of all three kinds through `importFilesOf(detailsJson)` in `services/documents.js` — never `importedFrom.artifactId` alone, so a booking's facts come only from the files the reader named, D-38-3; a booking without `filePositions` owns every file of its import, D-38-5; attachments), the registry, the cap, `readOne` (fetch bytes, build context from the booking and trip, call, classify, parse, validate, verify quotes, insert the read row and facts in one transaction), the boot pass, the flag.
5. The two kicks (`writeAttachment`, confirm), outside their transactions, through the same `kickDocumentReads`.
6. The route, and `documents.js`'s additive `key`.
7. The privacy tests, the suite-wide stub, the live smoke.
8. A dev-copy run: `initDb` on a copy of the dev database, the boot pass over its 14 artifacts, facts inspected by hand; the owner's QA on dev (Conditions are not visible until W2, so this is a database read).

**Acceptance.** Backend suite green (the kick stubbed suite-wide, no network); `LIVE_ANTHROPIC=1` smoke green; the dev-copy run shows reads with `complete` status and verified quotes on text-layer documents; a pasted-text artifact yields verified facts; an MCP-uploaded attachment on a test server kicks a read (stubbed); the share payload, `get_trip` and the co-pilot context tests hold; the flag off produces no read.

### W2 — Conditions in Logistics and the viewer's page anchor (D-37-5, D-37-8, D-37-10)

**Status:** COMPLETE 2026-10-20 on branch `plan37-w2` (not merged, not deployed). Owner rulings at the start: Q-37-10, Q-37-11, Q-37-12 (§10), which added W2b and D-37-13/-14; mid-wave the owner reversed Q-37-7 (D-37-15) and asked for each ticket number to print once. **As built.** Cards (`cardConditions.js`, `CardConditions.jsx`): the next upcoming deadline, given as its moment as written ("12 Nov 18:00", `factFormat.js`, never through `Date`), and the first window; the label wraps rather than truncating (a truncated label plus a two-line value lost the time and zone in the browser); after `.logistics-card-rows` on hotel/other, above the footer on tickets; no gold; the aria-label carries the lines. Sheet (`BookingConditions.jsx`): between Documents and Costs; primary kinds, then "Also in the document" behind a hairline (D-37-13); label, English line, the quote in its own script, the time with its zone or "zone not stated" (D-37-10), and a source line (`p.2 · read from PDF` / `read from image` / `from the pasted confirmation`, plus the file's name when a booking's facts come from more than one document) that opens the viewer at the page. `DocumentViewer` takes `page` and appends `#page=N` to the iframe and its links only. `useDocumentFacts` is per route; a failed load logs and changes nothing on screen. **The wait (D-37-15).** The silent 10 s follow-up was built first and measured against a real read: the two-page PDF's read took 10.5 s, so the follow-up came first. Now an attach or an import confirm marks the booking "Reading … for its conditions" (card and sheet, cream pulse dot, reduced-motion static), and the client makes one `GET /facts?wait=1` that `waitForTripReads` holds until the trip's reads settle (cap 30 s), plus at most one more while reads are pending; then "Still reading". The ticket eyebrow now names the airline (or the train's route) and the number stays between the codes. **Verified.** Frontend 51 files / 451 tests and build green; backend 53 files / 1,431 tests green. Browser, built-in pane, on a dev copy with real facts (`backend/data/model-eval/db/plan37-w2-facts.db`: the three stored imports confirmed and four PDFs/PNGs attached, 7 Haiku reads, then 3 more during QA, about $0.012 in all; the dev database's sha256 unchanged): at 375 px all four card types carry the zone with the ticket notches on the perforation; the sheet's grouping, quotes (Japanese in its script), zones and source taps; a booking with no facts shows nothing; with the facts request failing, Logistics renders all eight cards with no zone and no error text and logs `[facts] load failed`; at 1280 px the two-column grid holds and the lone card spans at 560 px (`:only-child`); desktop Chromium opens the PDF at page 2; a real attach showed the reading row and its conditions arrived 8.3 s later with the fade, through one held request per attach. **Owner to check:** whether the phone honours `#page` (under phone emulation the pane stayed on page 1; §11), and the reading row on the phone in W4's pass. **Seen, for W2b:** the KLM PDF backing both legs gives each flight both legs' departure and arrival lines (reader 37.2 rule a).

**Files.** `frontend/src/services/factsApi.js` (new); `frontend/src/hooks/useDocumentFacts.js` (new, per-route, `requestIdRef`, quiet degrade when the request fails offline); `frontend/src/pages/LogisticsTab.jsx` (hook instance; facts passed to cards by `bookingId`; the sheet's Conditions sub-section between Documents and Costs, in the existing sub-section pattern; refetch at the five invalidation points and one follow-up fetch about 10 s after an attach or confirm, Q-37-7); `frontend/src/components/logistics/HotelBookingCard.jsx`, `OtherBookingCard.jsx` (a `.logistics-conditions` zone after `.logistics-card-rows`), `TicketStubCard.jsx`, `FlightBookingCard.jsx`, `TrainBookingCard.jsx` (a `conditions` prop rendered above the footer line); `frontend/src/index.css` (`.logistics-conditions`: tokens only, the 640 px+ padding list, the 28 px right padding on a last element); `frontend/src/components/documents/DocumentViewer.jsx` (`page` prop: `#page=N` appended inside the viewer to the iframe `src` and the new-tab link, never to `doc.url`); tests: `LogisticsTab.test.jsx` (new: mocks `./TripPage.jsx`, `../context/AuthContext.jsx`, `useExpenses`, `useCollaboration`, `factsApi`; `MemoryRouter`), `DocumentViewer.test.jsx` (page fragment), card tests for the zone.

**Design.** On a card: up to two lines in `font-mono text-[10px]` labels and `font-body` values in `--cream-dim`, no gold, no interaction (F-37-27). In the sheet: the Conditions label in the sub-section style; one row per fact, label (mono, `--cream-mute`), value (body, `--cream`), the quote in `font-body italic` (`--cream-dim`), and a source line `p.2 · read from PDF` | `read from image` | `from the pasted confirmation` that is a button opening the viewer at `verifiedPage ?? page`; `zone not stated` beside a time with `tzSource: none`. Nothing renders for a booking with no facts.

**Acceptance.** Frontend suite and build green; at 375 px and desktop, on a dev copy with W1's facts: all four card types show the zone without breaking the notches or the `:only-child` span at 760 px+; the sheet lists facts with working source taps; the viewer opens a multi-page PDF at the page on a desktop browser and the result on the owner's phone is recorded (F-37-28; if the fragment is ignored, the page number stays visible in the source line and the plan records it under §11); a booking with no facts shows nothing; offline, Logistics renders as today with no error for the missing facts.

### W2b — Reader 37.2: the three W0 notes fixed at the source (D-37-14)

**Status:** COMPLETE 2026-10-21 on branch `plan37-w2b` (from `plan37-w2`; not merged, not deployed); the owner graded the diff and approved. **As built.** `FACTS_PROMPT_VERSION = '37.2'`. Rules 10 (schedule and identity, with what the traveller must do or where they must go kept even when printed in the schedule line), 11 (the total and every line of a summary of charges that adds up to it are the price; a `cost_condition` is a charge no stated total includes or one an action or deadline triggers) and 12 (circumstance first in `value`); "Do not explain your reasoning in prose." is rule 13. Two further edits, both measured: the allowance examples drop "seats, guests" (they contradicted rule 10), and rule 5 says a zone named in words ("Japan time") is a stated zone (the first 37.2 draft kept that zone on 3/12 reads against 37.1's 2/2; 3/3 after). Four drafts were measured; the first lost hotel hours printed beside the booked date and the third, which quoted "Additional charges" as a negative example, made that line appear 3/3, so rule 11 names the structure, not a label. **Measured** (Haiku 5.5 `medium`, three final reads per source; the production copy `prod-2026-10-20b.db`, the W2 dev copy's seven sources, the two synthetic fixtures, and four owner confirmations added as private fixtures under `private/facts/`: Hilton Waldorf Chengdu, IHG Kimpton KL, Grand Hyatt Singapore, and the FY3125 boarding pass on its own flight): the booking's schedule and identity 0 times; lines inside a printed total 1/9 (37.1 ≈ 6/7); the Hyatt 10 % service and 9 % GST that no total includes 3/3; hotel hours, cancellation deadlines, requirements, terminals and contacts kept; every other fact changed in wording only. Known residual: boarding time on a boarding pass 2/3 (gate and counter closing 3/3). Owner ruling at the grade: boarding-pass facts exist only once the pass is attached, days before departure, so no surface reserves a slot for them (W2's cards already show only what exists; W3 must keep that). The per-document diff is `backend/data/model-eval/private/facts/w2b-diff-37.1-vs-37.2.txt` (private). Pins in `claude.test.js` updated (prompt, request body, last rule, version); backend 54 files / 1,437 tests green; `LIVE_ANTHROPIC=1` smoke 7/7 including a real facts read. Spend ≈ $0.31 of the $1 cap. Added 2026-10-20 by the owner's W2 rulings (Q-37-10, Q-37-11, Q-37-12). Must land before W4, so production only ever holds 37.2 reads (migration 038 is not applied in production; a `FACTS_PROMPT_VERSION` change re-reads every source through the boot pass, D-37-1). Independent of W3 (no shared file).

**Why.** W2 shows facts as the reader gives them (D-37-14). Three reader habits seen in W0 and on the W2 dev copy would otherwise reach the traveller: (1) a condition true of the document but not of this booking ("re-check baggage for onward flight" with no onward flight; "passengers on MH-operated flights …"); (2) amounts that make up a printed total read as extra cost (Regent Chongqing "Additional charges" 463.50 and "Taxes" 305.92, inside CNY 5,404.02; quotes that are bare column labels); (3) the booking's own schedule emitted as facts ("Departs Singapore Changi at 12:25", quoted "SIN 12:25"; flight number; cabin class). The W2 dev copy adds a sharper case of (3): the KLM PDF backs both legs, and the reader listed both legs' departure and arrival times under each flight, so KL 1676's first window was the outbound departure.

**Files.** `backend/src/services/claude.js` (`FACTS_SYSTEM` rules, `FACTS_PROMPT_VERSION = '37.2'`, the sha256 pins in `claude.test.js`); `backend/scripts/modelEval/` (a `facts` comparison profile run on 37.1 vs 37.2); no schema change, no migration, no frontend change.

**Steps.**
1. Draft three prompt rules: (a) the booking's own schedule and identity are not conditions — the vehicle's departure and arrival times, airports and stations, flight or train number, cabin class, seat, booked dates of stay, guest names — while a hotel's check-in and check-out hours, gate or counter closing times and reception hours stay (they are policies about what the traveller may or must do); (b) an amount that is a line of a stated total is part of the total, not a condition; a `cost_condition` is a charge beyond what is paid (deposit, tax payable at the desk, resort fee, a fee after a deadline); (c) a condition that applies only in a circumstance (a carrier, a connection, a passenger type) keeps that circumstance in `value` ("If you have an onward flight: …"). "Do not explain your reasoning in prose." stays the last rule (the extraction pattern, F-37-10).
2. Measure 37.1 against 37.2 with the W0 harness on the production corpus copy (`prod-2026-10-20b.db`), the synthetic fixtures and the W2 dev copy's seven sources; print per document the facts removed, added and changed; cents.
3. The owner grades the diff (not a full re-grade): every removed fact is one of the three classes, nothing costly was lost, G-37-1's costly kinds still 0 wrong.
4. Land the prompt and version with updated pins; the backend suite and the `LIVE_ANTHROPIC=1` smoke green.

**Acceptance.** The diff graded by the owner; the three note classes absent on the corpus; no costly fact lost; pins and suite green; DECISIONS row D-37-14 updated with the numbers.

### W3 — Due (D-37-6)

**Status:** COMPLETE 2026-10-21 on branch `plan37-w3` (from `plan37-w2b`; not merged, not deployed). **Owner rulings at the start (2026-10-21, recorded in D-37-6):** a deadline from a document that backs several bookings shows once, naming each booking in trip order; two facts under the same booking with the same `at` and the same label (trimmed, case-insensitive) collapse; the strip shows the next three with an "N more" / "Fewer" toggle; a muted DM Mono "Due" eyebrow heads it. **As built.** `dueLines.js` (pure selection and dedupe, marker D-37-6) and `DueStrip.jsx` (marker D-37-6), mounted in `LogisticsTab.jsx` between the header and the sections, fed by the route's one `useDocumentFacts` instance. Each line is two rows at 375 px: dot slot, label and countdown; then the title(s) and the moment as written (`formatAtAsWritten`). **Deviations from this section's text:** the helper is `formatDeadlineCountdown(date, now)` in `utils/date.js` ("Today" on the day, `''` before it, `formatCountdown` after) rather than `formatDeadline`: the moment as written already lives in `factFormat.js` (components), and `utils` must not import from components. The strip is capped at 560 px on desktop (the lone card's width), because at full width a countdown sat about 850 px from its label. **Found and fixed:** `.trip-live-dot`'s reduced-motion override sat before its base rule in `index.css` with equal specificity, so the dot pulsed under reduced motion everywhere since Plan 22 (Trips Home "Active now", the Discovery manifest); the override now follows the base rule. **Verified.** Frontend 53 files / 465 tests and build green; no backend change. Browser, on a copy of `plan37-w2-facts.db` with three dates moved (one deadline to today, one to yesterday, one KLM window made a shared "Change by"), served with `DOCUMENT_FACTS_ENABLED=0`: at 375 px eight lines in order, "Today" on the day, yesterday's deadline absent, the KLM line once naming both flights, Park Hyatt Shanghai's two documents collapsed to one line, one gold dot on the first line only, "5 more" expands to all eight and "Fewer" (44 px target), no horizontal scroll; at 1280 px the 560 px strip; under emulated reduced motion the dot is still (`animation-name: none`) and pulses again without it; with `/facts` failing, Logistics renders as before with no strip and no error copy and logs `[facts] load failed`; two trips without facts show no strip. **Not verified:** a trip whose facts exist but whose deadlines are all past was not opened in the browser (the same empty path as no facts, covered by `dueLines.test.js`); the owner's phone, in W4's pass. **Follow-up the same day (owner review of the built strip).** (1) Due shows one line, the next deadline, with "N more": the header plus a three-line strip took about 57 % of a 375 × 812 screen; the strip is now 112 px (was about 220) and the first booking section starts at 531 px (was 634). (2) Zones (D-37-10 extended): `services/factZone.js` derives a zone-less fact's zone per owning booking when facts are served — zone column, `details.tz`, coordinates through `geo-tz` (already a dependency), then a country whose platform-listed zones share one offset (the booking's, else its trip day's resolved country, passed in by the route because `documentFacts.js` cannot import `trips.js`). Every served zone must be one the platform accepts. (3) `components/logistics/deadlineTime.js`: a deadline with a known zone leaves Due and the card at its real moment; with no zone it stays its whole written day; order by moment; a "your time" note only when the device's clock differs. Two encoding defects caught in review: the note's "·" had been written as a lone Latin-1 byte in both the component and its test, so the test passed while matching the broken text. Verified: backend 55 files / 1,457 tests, frontend 54 files / 476 tests, build green. Browser at 375 px and 1280 px on a second QA copy (device zone Asia/Singapore): a Shanghai-zoned 00:30 deadline earlier today left both Due and its card; the zone-less 00:30 stayed as "Today" (it holds the gold dot until the day ends, as ruled); notes showed only for Amsterdam ("4 Nov 06:59 your time"), Tokyo ("17:00 your time") and London ("13 Nov 02:00 your time"), none for Singapore, Shanghai or the zone-less line; one gold dot; no horizontal scroll; the London line holds one row in the 560 px strip. The owner's dev database was not opened (its WAL unchanged since the incident below). **QA incident:** the worktree's copied `backend/.env` set `DB_PATH=./data/trippy.db` and `config.js` loads it with `override: true`, so the first QA backend start opened the owner's dev database through the `backend/data` junction and applied migration 038 there (two empty tables and a `_migrations` row; reads were off, nothing else written). Local main already carries 038, so the owner's next dev start would have applied it identically. For worktree QA, never copy `backend/.env`; pass `DB_PATH` and `NODE_ENV=test` explicitly.

**Files.** `frontend/src/components/logistics/DueStrip.jsx` (new); `frontend/src/pages/LogisticsTab.jsx` (the strip between the header and the sections); `frontend/src/utils/date.js` (`formatDeadline`: `formatCountdown` for days ahead, "Today" for the same day, plus the time as written); tests.

**Design.** A bare block above the sections, in the Trips Home status-line register: one line per deadline, `font-mono text-[10px] tracking-[0.24em] uppercase` label (CANCEL BY, CHANGE BY, CHECK-IN OPENS, PAY BY), the booking title in `font-body`, the date and time as written, and the countdown; the next deadline's line in `--cream`, the rest in `--cream-dim`; the single gold accent is a 6 px dot on the next one (`.trip-live-dot`, reduced-motion safe). The strip is absent when there is no upcoming deadline. No pill, no border.

**Acceptance.** Frontend suite and build green; at 375 px and desktop the strip renders in order, disappears after a deadline's day, and shows "Today" on the day; reduced motion verified.

### W4 — Deploy, owner production pass, close-out

**Status:** NOT STARTED.

**Steps.** Deploy through the `deploy` skill after a pre-deploy backup; migration 038 confirmed in `_migrations`; `DOCUMENT_FACTS_ENABLED` present in the production `.env`; the boot pass reads the production documents under the daily cap (Q-37-3), and the container log shows `[facts] read …` lines with statuses; the owner's production pass: open a trip, see Conditions on a booking that has a document, open the source at its page on the phone, see Due in order, attach a new document and see its conditions appear within a minute, confirm the public share shows nothing new. Then `docs/ENGINEERING.md` ("Bookings, Capture, and Documents": the facts contract, D-37 markers, the daily cap, the flag, next free migration 039), `docs/DECISIONS.md` (one row per landed D-37 marker), this header with total spend, `git diff --check`.

**Standing log checks (after deploy, no window).** A read ending `refused`, `truncated` or `invalid` on a legitimate document; a verification rate on text-layer documents clearly below W0's baseline; a day that hits the cap; any `[facts]` line naming an error category more than once in a day.

---

## 7. Sequencing and rollback summary

- **Order.** W0 → W1 → W2 → W2b and W3 (either order; no shared file) → deploy → W4. W2b must land before the deploy. W2 and W3 both edit `LogisticsTab.jsx`, so they are sequential. Plan 36's remaining waves and this plan's W1 both edit `claude.js`; merge in sequence.
- **If W0 fails G-37-1.** Nothing past W0 is built; the numbers go to DECISIONS.md with the cause; a re-attempt needs a changed contract or model, not a re-run.
- **If W0 fails only G-37-2 or G-37-3.** W1–W4 proceed (O-3); the Phase 2 plan is not written; the numbers are recorded.
- **Rollback unit.** `DOCUMENT_FACTS_ENABLED=0` stops reads at once without a code change (D-37-12); the UI shows nothing without facts; the full feature rollback is one revert plus a redeploy. Migration 038 is additive and stays; no data step.

---

## 8. Verification expectations

- Backend `npm test` green at every wave; the network guard means every model call in tests is stubbed, and the read kick is stubbed suite-wide so no detached read outlives a test.
- `LIVE_ANTHROPIC=1` smoke at W1 and before deploy.
- Frontend `npm test` and `npm run build` at W2 and W3.
- Browser: W2 and W3 at 375 px first, then desktop, on a dev copy carrying real facts; all four card types; the `:only-child` layout at 760 px+; reduced motion on the Due dot; offline Logistics unchanged.
- Migration 038 applied on a disposable copy before deploy; the production `_migrations` row confirmed after.
- The share-payload, `get_trip` and co-pilot-context exclusion tests (D-37-7) at W1 and re-run before deploy.
- D-30-7 side-effect tables printed and clean on every harness run; the private directory never enters a commit (`git status` before every commit in W0).
- Never call a wave complete from the harness or the suite alone when the traveller-facing flow changed: W2, W3 and W4 need the browser pass, W4 the owner's.

---

## 9. Estimate (provisional, one engineer)

| Wave | Effort |
|---|---|
| W0 corpus, probes, runs, sheets, scoring | 1–1.5 days, plus 1–2 h of the owner's grading |
| W1 migration, contract, text layer, job, route, tests, smoke | 2–2.5 days |
| W2 Conditions, viewer page, tests, browser pass | 1–1.5 days |
| W3 Due, tests, browser pass | 0.5–1 day |
| W4 deploy, owner pass, close-out | 0.5 day |

**Operating cost at list** (re-baselined by W0): about $0.003 per document on Haiku 5.5, about ten times that on Sonnet 5.5; a document-rich trip, cents; the first-deploy backfill of every existing document, well under a dollar.

**Recommended session driver per wave.** W0 and W1: Opus 5.5 at high (a new workload with a contract, a migration, a background job that must be right on every stop reason and on shutdown). W2 and W3: Sonnet 5.5 under orchestration (frontend work against a fixed contract, copy and design). W4: Sonnet 5.5.

---

## 10. Owner questions

Each follows the plain-language shape: what it is, one example, the implication, the recommendation. A default applies unless the owner rules otherwise. **Ruled 2026-10-20: the owner approved the plan with the default on every question below.**

**Q-37-1 — Where do W0's documents come from?**
- **Plain language.** The experiment needs real confirmations. This machine has no production export (F-37-30); the dev database holds 14 imports.
- **Example.** A production backup copied down and opened read-only gives every document ever imported into Trippy; if that is still only two trips with many documents, your own confirmations from the last two years, dropped into a private folder that is never committed, fill the gap.
- **Implication.** The backup takes the existing ritual (host `sqlite3` into `~/Trippy/backups/`, then a copy to this machine) and your approval, as O-4 gave for the export copy; private fixtures take you an hour of collecting files. Nothing is written back anywhere.
- **Recommendation (default): both.** The backup first, then fixtures if the census says fewer than three document-rich trips.

**Q-37-2 — Which model reads documents at import?**
- **Plain language.** Haiku 5.5 is about ten times cheaper than Sonnet 5.5 and may read fine print just as well; W0 measures both on your documents.
- **Example.** If Haiku misses "online check-in opens 48 h before" on a screenshot that Sonnet catches, the cheap reader is the wrong one.
- **Implication.** Cents either way at Trippy's volume; the question is accuracy on the costly kinds.
- **Recommendation (default): Haiku 5.5 at `medium`, unless B2 shows it more than one point behind on deadlines, windows and requirements** (D-37-9).

**Q-37-3 — At the first deploy, which existing documents are read?**
- **Plain language.** Documents already in Trippy are read once in the background after the deploy, so Conditions appear on old bookings too.
- **Example.** Every document ever imported, under the daily cap of 300, continuing the next day if there are more; or only trips that have not ended yet.
- **Implication.** All documents cost well under a dollar and let you check the feature on past trips; the cap keeps a surprise from spending more.
- **Recommendation (default): all documents, once, under the cap.**

**Q-37-4 — Which PDF text library?**
- **Plain language.** To prove a quote is really in a PDF, the server needs the PDF's text. Two libraries do this in Node.
- **Example.** `pdfjs-dist` (Mozilla's PDF.js, legacy build) reads text page by page, which gives the page number; `pdf-parse` wraps it with a simpler call but less page control.
- **Implication.** Either adds one dependency to the backend image; neither needs native modules; `pdfjs-dist` is the better-maintained of the two and gives pages.
- **Recommendation (default): `pdfjs-dist`.** W1's Docker build on `node:20-alpine` proves it loads.

**Q-37-5 — Is this the rule for Due?**
- **Plain language.** Due shows only deadlines that are still ahead, in order; after a deadline's day passes, it leaves the strip without comment.
- **Example.** "Free cancellation until 14 Nov" shows "In 2 weeks", then "Today", then disappears on the 15th; it never says "missed".
- **Implication.** Due stays a calm list of what is coming, in Trippy's voice; it is not a scold.
- **Recommendation (default): yes** (D-37-6).

**Q-37-6 — Conditions on the card, or only in the sheet?**
- **Plain language.** A card can carry two quiet lines (the next deadline, the first window) and the sheet the full list; or the card stays as it is and everything lives in the sheet.
- **Example.** The hotel card shows "CHECK-IN from 15:00 · CANCEL BY 14 Nov" under its rows; tapping opens the sheet with all seven facts, quotes and sources.
- **Implication.** Two lines make the feature visible without opening anything, at the cost of a slightly taller card; the sheet-only version keeps today's cards untouched.
- **Recommendation (default): two lines on the card, the list in the sheet** (D-37-5).

**Q-37-7 — What shows while a just-uploaded document is being read?**
- **Plain language.** A read takes a few seconds after an upload; the first refetch returns nothing yet.
- **Example.** You attach a PDF; Trippy fetches facts once more about ten seconds later and the Conditions appear, with no copy in between; or it shows a quiet "Reading…" line.
- **Implication.** The silent follow-up keeps the surface free of transient copy; the line tells you something is happening.
- **Recommendation (default): the silent follow-up fetch.**
- **Reopened and reversed by the owner, 2026-10-20 at W2.** Measured on the W2 dev copy: reads took 4.3 to 10.5 s, and a two-page PDF's read (10.5 s) finished after the 10 s follow-up, so its conditions would only have appeared on the next visit — "highly likely it will be missed". **Ruled: show the wait.** The booking says its document is being read, and the wait ends when the read does, through one held request (D-37-15).

**Q-37-8 — Keep a switch to stop reads in production?**
- **Plain language.** One environment setting that turns the background reads off without a code change.
- **Example.** Reads start failing on a document type after a provider change; you flip the switch, the UI shows what it already has, and the cause is fixed calmly.
- **Implication.** One more `.env` line and a startup read, like `MCP_ENABLED`; nothing else.
- **Recommendation (default): yes** (D-37-12).

**Q-37-9 — Is $8 the right cap for W0?**
- **Plain language.** The experiment is expected to cost about $4.50 at list; the cap stops the scripts starting new calls past it.
- **Example.** If the census finds many more documents than expected, the runs stop at the cap and report how far they got.
- **Implication.** Below $8 is cheaper than one night's parking; raising it later is a flag.
- **Recommendation (default): $8.**

**Asked and ruled 2026-10-20, at the start of W2 (the owner's W0 notes, and what W1's dev run showed).** The owner took the recommendation on each.

- **Q-37-10 — A condition true of the document but maybe not of this booking** ("re-check baggage for onward flight" with none; "passengers on MH-operated flights …"). **Ruled: subordinate, and fix the reader.** The card shows only deadlines and windows (D-37-5), so such lines never reach it; the sheet lists deadlines, windows, requirements and restrictions first and instructions, allowances, contacts and cost lines under a quieter "Also in the document" (D-37-13); reader 37.2 keeps the circumstance in the English line (W2b).
- **Q-37-11 — Cost lines already inside a printed total** (Regent Chongqing). **Ruled: fix in reader 37.2** (W2b); W2 displays cost conditions as given, and no 37.1 read reaches production.
- **Q-37-12 — The booking's own schedule emitted as facts.** **Ruled: fix in reader 37.2** (W2b), not a display rule; hotel check-in and check-out hours stay facts.

---

## 11. Not verified, and how to close it

- **Whether the `at` pattern's optional group compiles** on Sonnet 5.5 and Haiku 5.5. Closed by W0 step 2; the fallback is two flat fields.
- **Whether `#page=N` is honoured inside the viewer's iframe** on the owner's phone (F-37-28). Closed by W2's device check; if not, the page number stays visible in the source line and a later wave may render the page server-side. **W2 (2026-10-20):** desktop Chromium honours it (opened at page 2); under the pane's phone emulation it stayed on page 1, which proves nothing about a real phone. Moved to W4's owner pass.
- **Whether `pdfjs-dist`'s legacy build loads on `node:20-alpine` without native modules.** Closed by W1 (2026-10-20): the image is `node:22-alpine` (GHSA-hq66-cqwq-w95j); it was built locally and read the three fixture PDFs.
- **How well Haiku 5.5 reads CJK phone screenshots against Sonnet 5.5 and Sonnet 4.6.** Closed by W0 B1 and B2.
- **Whether a booking-supplied time zone (`tzSource: booking`) ever misleads.** Closed by W0 grading; if it does, D-37-10 drops the booking source.
- **The daily cap value.** W0's census says documents per trip; 300 is a guess that production volume will never meet; recorded, not measured.
- **The readiness prototype's shape is not the Phase 2 design.** W0 measures whether cross-document checking finds things; how the ledger is built, cached and surfaced is Phase 2's plan, written only if G-37-2 and G-37-3 pass.
