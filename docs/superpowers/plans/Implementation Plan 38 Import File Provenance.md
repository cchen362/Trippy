# Implementation Plan 38 — Import File Provenance

**Status:** 2026-10-20 — **APPROVED (owner, 2026-10-20). W0 COMPLETE; W1 gate G-38-1 PASSED** (§5: the schema compiles on both models; `filePositions` 15/15 exact on every sweep; no regression; 0 refusals; total spend ≈ $2.63). **W1 COMPLETE on branch `plan38-import-file-provenance`, not merged or deployed** (backend suite 1,304 passed; confirm rejects an empty `filePositions` list; repair script with 5 tests; browser-verified at 375 px and desktop, §5; DECISIONS D-38-1/3/5 and the ENGINEERING note added). Next: W2 (merge, deploy through the `deploy` skill, run the repair, owner click-script). Q-38-1 ruled: correct with the script, mapping confirmed. Q-38-2 ruled: no move-document control in this plan. Q-38-3 ruled: accept. The owner also asked that one confirmation holding several bookings (flights + hotel in one PDF, or a whole flight/train/hotel itinerary) shows under every booking it holds; D-38-1 already does this, and W0 fixture (e) measures it. No code changed yet. The only production access was read-only (two queries against the live database, nothing written). It is a prerequisite for Plan 37 W1 (D-37-1 resolves a booking's documents through `resolveBookingDocuments`).

**Origin.** During Plan 37 W0 (2026-10-20) the owner imported four Chengdu–Chongqing screenshots in one go into the production trip "Chengdu - Chongqing". Four bookings were created, and **every one of them lists all four screenshots** under Documents. The SQ 842 flight shows the Regent Chongqing hotel voucher, the Ritz-Carlton Chengdu voucher and the return flight.

**Scope in one sentence:** when the booking reader extracts a booking it also says which of the uploaded files it read it from; Trippy stores that on the booking, and the booking shows only those files.

**Not in scope.**
- No migration. The link stays where it lives today, in `details_json.importedFrom` (F-38-1), so Plan 37's migration 038 is not disturbed.
- No change to the review screen or any other frontend file (D-38-4 explains why an open tab on an old bundle still works).
- No change to the MCP path. MCP bookings carry no `importedFrom` (F-37-17) and never call the model.
- No way, in this plan, to move an import document from one booking to another by hand (Q-38-2).
- Pasted text is still not shown as a document (F-37-16 is unchanged).

---

## Bottom line, in plain language

**What you see today.** Upload four screenshots at once (two hotels, two flights) and Trippy makes four bookings correctly, but each booking's Documents list shows all four screenshots. When you open SQ 842 at the airport you have to guess which picture is the boarding information.

**What changes.** Each booking lists only the screenshot it came from. A PDF that holds an outbound and a return flight still shows under both flights. A confirmation split across two screenshots shows both under its one booking.

**Why it matters beyond tidiness.** Plan 37 will read every document into "Conditions" (check-in windows, baggage rules) and show them under the booking the document belongs to. With today's link, the Regent's check-in window would appear under SQ 842. This plan has to land first.

**Cost.** One short extra answer per booking from the reader (a list like `[2]`), a few words of labelling per file in the request, and one round of measurement before shipping (cap $3). No new model call. No ongoing cost.

**The four existing Chengdu bookings** are corrected by a one-time data fix after deploy, once you confirm the mapping (Q-38-1).

---

## 1. Validated facts (do not re-derive)

- **F-38-1 — The booking-to-file link is artifact-level only.** `normalizeExtractedBooking` stamps `detailsJson.importedFrom = { artifactId, model, extractedAt }` (`backend/src/services/importer.js:181`). It is called at extraction (`runExtraction`, `importer.js:320-321`) and again at confirm on the client's bookings (`confirmArtifact`, `importer.js:418`). Nothing records which input file a booking came from.
- **F-38-2 — Documents resolve to every file of the artifact.** `resolveBookingDocuments` (`backend/src/services/documents.js:7-43`) selects every `import_artifact_files` row of `importedFrom.artifactId` with `kind IN ('image','pdf')` (`:11-27`), ordered by `position`. URLs are `/api/import/artifacts/:artifactId/files/:position`. Its two callers are `formatBooking` (`services/bookings.js:35`) and `mapBooking` (`services/trips.js:104`).
- **F-38-3 — The reader is never told the file boundaries.** `extractBookings` (`backend/src/services/claude.js:535`) pushes the files as bare `text` / `image` / `document` blocks in order (`:559-573`), with no label between them. `EXTRACTION_OUTPUT_SCHEMA` (`claude.js:234-367`) has no field for provenance, and `toAppExtraction` (`:505-531`) carries none.
- **F-38-4 — Model output order is not file order.** The production artifact `1b659f4489cce6039079ca587c42de7e` holds files `0 regent_chongqing.png`, `1 SIN_TFU_SQ.png`, `2 TFU_SIN_SQ.png`, `3 TFURZ_Chengdu.png`; the extraction listed `Regent Chongqing, The Ritz-Carlton Chengdu, SQ 842, SQ 843`. Position in the answer cannot stand in for provenance.
- **F-38-5 — Production has exactly one multi-file import.** Read-only query, 2026-10-20: 5 artifacts in total. Three are confirmed; two of them hold one file each (one text, one image), and the third is the Chengdu artifact (4 images, 4 bookings, trip `b110d4b79828a60132cf08cc757e5c39`). The four bookings are `bac15cc05452c30e7c556a1fb4ee730c` (Regent Chongqing), `02c2b872948b5bc70e7a2fce3a40233d` (The Ritz-Carlton, Chengdu), `5cba008a8b853e463bda2217ec209570` (SQ 842, SIN→TFU), `a22fd68b76081dd028ad3aef0f1932b4` (SQ 843, TFU→SIN). None has a manual attachment. A single-file import is already correct today.
- **F-38-6 — The client round-trips `detailsJson` verbatim.** `buildDraftBookings` keeps the extraction booking as draft data; the draft edit form spreads `...current.detailsJson` (`AddBookingModal.jsx:159-161`); `toBookingConfirmPayload` sends `detailsJson` unchanged (`frontend/src/services/bookingPayload.js:16`); the new-trip capture path does the same (`NewTripModal.jsx:203`). Whatever the server stamps into `importedFrom` at extraction therefore comes back at confirm, on old and new bundles alike. A later booking edit also spreads `detailsJson`, so the link survives edits (`bookings.js:203`).
- **F-38-7 — The cache returns a stored extraction.** `findCachedArtifact` (`importer.js:99-122`) matches by the sorted set of file hashes and returns the stored `extracted_json` without a model call (`importer.js:347-354`). An extraction stored before this plan carries no provenance.
- **F-38-8 — The schema rules this plan must respect.** D-34-1/D-34-2: API-enforced schema, frozen constant, re-checked by `validateAgainstSchema`, any deviation a named 502, nothing repaired. D-34-5: no optional property anywhere, 4 of 16 union definitions used, a test walks the schema. The validator understands only `type, const, enum, anyOf, $ref, $defs, required, properties, additionalProperties, items, minItems, pattern, description` and the types `object, array, string, null` (`claude.js:377-382`). It has no `integer`/`number`, so an integer `enum` is checked by `===` membership, which the validator already supports. Plan 37 W0 recorded that `maxItems` is dropped by the compile probe, so the plan does not use it. Rule 10 stays. Request bodies are pinned by sha256 in `backend/tests/claude.test.js` (extraction at `:1501-1524`).
- **F-38-9 — Up to four inputs per import.** `MAX_INPUTS = 4` (`importer.js:14`), mirrored by the frontend's `MAX_INPUTS`.
- **F-38-10 — The extraction harness already takes several files per fixture.** Fixtures in `backend/scripts/modelEval/fixtures/extraction/*.json` carry a `files` array; the rendered images sit in `fixtures/extraction/files/`. `schemaProbe.mjs` builds schema variants with `extractionVariant(mutate)`. On branch `plan37-w0` (not yet on `main`), Plan 37 W0 added five probes to `schemaProbe.mjs`.
- **F-38-11 — Decision markers near the code.** `importer.js`: Plan 2A D1 (BLOBs), D-34-7 (enum case), Plan 28 W2.1 sharing notes. `claude.js`: Plan 2A D6, D-34-1/2/3/5/7. `documents.js`: none. Nothing this plan does reverses any of them. The new field is a required array, not an optional property, and it adds no union.

---

## 2. Design

### D-38-1 — The reader names its source files, as a required array

`$defs.booking` gains a required property:

```js
sourceFiles: {
  type: 'array',
  minItems: 1,
  items: { enum: [1, 2, 3, 4] },
  description: 'The numbers of the files this booking was read from (see the File labels). Usually one; more when one booking spans several files.',
},
```

- It is required, so D-34-5 holds. An array adds no union definition. There is no `maxItems` (F-38-8).
- The `enum` repeats `MAX_INPUTS`, and a test pins `enum` equal to `1..MAX_INPUTS`. The pattern is the one `EXTRACTION_BOOKING_TYPES` already uses against `BOOKING_TYPES`.
- The schema stays frozen (D-34-2). The schema cannot know how many files a given request holds, so after validation `extractBookings` checks every number is `≤ files.length`. A number out of range is a named 502 ("unexpected shape"), never clamped, because under D-34-2 nothing is repaired.
- 1-based on the wire because the labels the model reads are "File 1 … File n". Converted once, in `toAppExtraction`'s caller, to 0-based `filePositions`, the value `import_artifact_files.position` and the file URL use. Duplicates are folded to a sorted unique list. This is a defined fold of a set the schema cannot express, in the same way `toAppExtraction` drops `""` details keys. It is not a repair.
- The W0 compile probe settles whether `items: { enum: [1,2,3,4] }` compiles on Sonnet 5.5 and 4.6. If it does not, the fallback is `items: { type: 'string', pattern: '^[1-4]$' }` with the same post-check. Both are recorded, and the plan's text is updated before W1.

### D-38-2 — Each file is labelled in the request, and the prompt says why

In `extractBookings`, each file is preceded by one text block: `File 1 of 4 (image):`, `File 2 of 4 (pdf):`, `File 1 of 1 (pasted text):`. Labelling uses the count and kind only, **never the filename**. A filename is user-typed metadata ("tfurz_chengdu.png") that can be wrong or misleading, and the booking must be read from the content.

A new prompt rule is inserted before rule 10, so rule 10 stays the last line:

> 10. Each input file is labelled "File n of N". In `sourceFiles`, list the number of every file the booking's details were read from: one number when a booking comes from one file, all of them when one booking is spread across several files, and the same number on several bookings when one file holds several bookings.
> 11. Do not explain your reasoning in prose.

Renumbering rule 10 to 11 is a text change to a measured line. W0 re-runs the Plan 34 refusal fixture (the "show your reasoning" input) to show the refusal rate is still 0. A single-file import labels its one file the same way, so a booking from a one-file import is always `[1]` and there is no special case.

### D-38-3 — Provenance is stored on `importedFrom`, and the document list filters by it

- `normalizeExtractedBooking(raw, { artifactId, model, extractedAt, fileCount })` stamps `importedFrom = { artifactId, model, extractedAt, filePositions }`.
  - At extraction, `filePositions` comes from the reader (D-38-1).
  - At confirm, it comes from the round-tripped `raw.detailsJson.importedFrom.filePositions` (F-38-6) and is **validated against this artifact's own file count**: integers, each `0 ≤ p < fileCount`, sorted and unique. Anything else is a 400.
  - `artifactId`, `model` and `extractedAt` stay server-stamped as today ("never trust a client-supplied importedFrom" keeps its reason: the artifact id is what grants access).
  - The worst a tampered `filePositions` can do is show a different file of the same artifact, which the same user is confirming and can already open. If it is absent, the key is omitted (D-38-5).
- A new exported helper in `documents.js`, `importFilesOf(detailsJson) → { artifactId, positions | null }`, is the one place that reads the link. `resolveBookingDocuments` uses it and adds `AND position IN (…)` when `positions` is non-null. Plan 37 W1's `documentFacts.js` enumeration must use the same helper (F-37-16 / D-37-1), so documents and facts can never disagree about which files a booking owns. That requirement is recorded in §6 for Plan 37.
- A text input is part of the numbering (it is a file the reader read), but `resolveBookingDocuments` still shows only images and PDFs. A booking read only from pasted text therefore shows no import document (Q-38-3).

### D-38-4 — No frontend change; old bundles keep working

Because the server stamps `filePositions` into `detailsJson.importedFrom` at extraction and every client path round-trips `detailsJson` (F-38-6), confirm receives the positions with no client change. A PWA tab opened before the deploy behaves in one of two ways:
- If it extracted against the new server, the round-trip carries the positions.
- If it extracted before the deploy and confirms after it, the draft has no positions, and those bookings get today's behaviour (D-38-5).

The confirm API contract is unchanged.

### D-38-5 — Legacy rule, cache rule and the one production correction

- **Legacy read rule:** `importedFrom` without `filePositions` → every image/PDF of the artifact (today's behaviour). This is exactly right for a single-file artifact, and after the correction below no production booking of a multi-file artifact lacks positions.
- **Cache rule:** `createArtifactAndExtract` treats a cached extraction as a miss when the artifact has more than one file and any stored booking lacks `filePositions`. It then re-extracts (one model call, only for pre-plan multi-file uploads). So a re-upload of old files never mints a new booking with the all-files behaviour. A single-file cached extraction is still reused.
- **Production correction (W2):** a one-off script `backend/scripts/importFileProvenanceRepair.js`, dry-run by default and `--apply` to write, following the `refetchCjkBookingEvidence.js` convention. It holds the owner-confirmed mapping for artifact `1b659f44…` (Q-38-1) and refuses to write unless each booking's id, title and artifact id and each file's position and filename match what is expected. In one transaction it sets `importedFrom.filePositions` on the four bookings and on the four bookings inside the artifact's `extracted_json`, which keeps the cache honest. It is idempotent: a second run reports "already correct" and writes nothing. It touches no other key.

### D-38-6 — Where the markers go

`D-38-1` above the `sourceFiles` property; `D-38-2` above the label loop and on the prompt rule's comment; `D-38-3` on `importFilesOf` and in `normalizeExtractedBooking`; `D-38-5` on the cache-miss branch and in the repair script. Rows for D-38-1, D-38-3 and D-38-5 go in `docs/DECISIONS.md`, and `docs/ENGINEERING.md` "Bookings, Capture, and Documents" gains one bullet: an import booking's documents are the files the reader named, not the whole upload.

---

## 3. Waves

### W0 — Fixtures and the compile probe (harness only)

**Why the quality run is not in W0 (found 2026-10-20 while starting W0).** The extraction harness calls the real `extractBookings`, which validates the answer against the live frozen schema (`additionalProperties: false`). An answer carrying `sourceFiles` is therefore a named 502 until `claude.js` changes, and a harness-only prompt variant (`lib/extractionPromptVariants.mjs`) cannot measure it. The paid quality run moves to W1 step 2, against the branch's code, and gates the merge. Nothing reaches production before the gate passes.

1. **Compile probe.** Append `matrix` probes to `schemaProbe.mjs`, built with `extractionVariant` (the live schema plus `sourceFiles`), for Sonnet 5.5 and Sonnet 4.6, cold and warm, plus the string-pattern fallback on 5.5. Record compile time against the current schema's last recorded figure. Plan 37 W0 merged to `main` on 2026-10-20 and this branch merged it, so this is a plain append that never edits Plan 37's probes.
2. **Fixtures.** Five new synthetic multi-file fixtures, generated by `renderExtractionFixtures.mjs` so their `expected` is assembled from the source fixtures and cannot drift. Each expected booking carries `filePositions` (0-based, the app's shape):
   - (a) the Chengdu shape: four screenshots, two hotels and two flights, answer order unlike file order;
   - (b) one PDF with outbound and return plus one hotel screenshot;
   - (c) one hotel booking split across two screenshots;
   - (d) pasted text plus one screenshot, each a different booking;
   - (e) one itinerary PDF holding a flight, a train and two hotels, uploaded with one unrelated hotel screenshot. The four itinerary bookings each name the PDF, and the screenshot's hotel names only the screenshot (owner request, 2026-10-20).

   The scorer gains a `filePositions` exact-set field, reported on its own line.

### W1 — Contract, storage and display (backend only)

1. `claude.js`: `sourceFiles` (D-38-1), file labels and the rule (D-38-2), the post-validation range check, and the conversion in `extractBookings`. `toAppExtraction` carries `filePositions` on each booking. The app shape is otherwise unchanged (D-34-3).
2. **Measure (cap $3), before anything else in W1 is built.**
   - **Runs:** every existing extraction fixture plus the five W0 composites on the live profile (Sonnet 5.5 `medium`), three repeats; the five composites on Sonnet 4.6 (the rollback row), one repeat; the Plan 34 refusal fixture, six repeats.
   - **Gate G-38-1 (all must hold):**
     - `filePositions` exact on every composite on every repeat (5.5);
     - no existing fixture loses a field it scored before, compared with the Plan 34 W1 baseline run;
     - refusals 0 on the refusal fixture;
     - the schema compiles on both models (W0).

   Result, spend and run files are recorded in §5. If the gate fails, stop and bring the result to the owner, and do not loosen the check.
3. `importer.js`: `fileCount` into `normalizeExtractedBooking` (from `validatedFiles.length` at extraction; from a `COUNT(*)` of the artifact's files at confirm), the confirm validation, and the cache-miss rule (D-38-5).
4. `documents.js`: `importFilesOf` and the filtered query (D-38-3).
5. Tests:
   - `claude.test.js`: schema-budget walk still passes (0 optionals, 4 unions); `enum` equals `1..MAX_INPUTS`; validator accepts `[1]`, `[2,4]`, and rejects `[]`, `[0]`, `["1"]`; out-of-range `[3]` with 2 files is a named 502; labels present in the request body and filenames absent; extraction request sha256 re-captured with structure asserted first, and the commit says so.
   - `importer.test.js`: extraction stamps positions; confirm keeps valid round-tripped positions, rejects out-of-range or non-integer ones with 400, omits them when absent; a client-supplied `artifactId` is still overwritten; a multi-file cached extraction without positions re-extracts, and a single-file one is reused.
   - New `backend/tests/documents.test.js`: filtered list; legacy list; text-only position yields no import document; manual attachments unaffected; shared PDF on two bookings shows under both.
   - Backend suite green (`npm test`). Frontend suite and build unchanged but run.
6. **Browser verification (local, dev servers from `launch.json`):** on a dev trip, import three screenshots in one go (a hotel, and a PDF render holding outbound and return). Confirm, open each booking at 375 px and at desktop, and check that the hotel shows only its voucher and both flights show the one PDF. Re-open after a page reload. This costs one live extraction call.
7. Plan status, `DECISIONS.md` rows, `ENGINEERING.md` bullet, markers; commit.

### W2 — Deploy and correct production

1. Merge to `main`, deploy through the `deploy` skill (pre-deploy backup via `/home/chee/trippy-backup.sh`, health check). Confirm in the container that the new schema is in place.
2. Copy `importFileProvenanceRepair.js` into the container and run it dry. Show the owner the printed plan, four lines of the form "SQ 842 → SIN_TFU_SQ.png". Then run `--apply`, then dry again to show "already correct".
3. **Owner click-script** (production, after a full app restart: close, reopen, close, reopen):
   - Open "Chengdu - Chongqing" → Logistics.
   - Open SQ 842: Documents shows only `SIN_TFU_SQ.PNG`.
   - SQ 843 shows only `TFU_SIN_SQ.PNG`, Regent Chongqing only `REGENT_CHONGQING.PNG`, Ritz-Carlton only `TFURZ_CHENGDU.PNG`.
   - Tap one to confirm it opens.
4. Plan status → CLOSED; memory and Plan 37 note updated.

---

## 4. Owner questions

**Q-38-1 — Fixing your four Chengdu bookings.**
*Plain language:* your four existing bookings were created before Trippy knew which screenshot each came from, so they need a one-time correction.
*Example:* after the fix, SQ 842 lists only SIN_TFU_SQ.png.
*Implication:* the alternative is deleting the four bookings and importing again, which costs a model call and loses any edits or costs you added. The correction is a small script that writes four values, checks every name before it writes, and can be run twice safely.
*Recommendation:* **correct them with the script, using this mapping:** Regent Chongqing → regent_chongqing.png, The Ritz-Carlton Chengdu → TFURZ_Chengdu.png, SQ 842 (Singapore→Chengdu Tianfu) → SIN_TFU_SQ.png, SQ 843 (Tianfu→Singapore) → TFU_SIN_SQ.png. Please confirm the mapping, since it rests on the filenames and the routes.

**Q-38-2 — When the reader picks the wrong screenshot.**
*Plain language:* the reader could, rarely, attach a booking to the wrong file, and this plan adds no button to move a document between bookings.
*Example:* you upload two hotel vouchers from the same chain, and both hotels end up showing the same voucher.
*Implication:* today you could only add the right file by hand with Attach; the wrong one would stay listed. Building a "this isn't this booking's document" control is extra frontend work (a design pass plus a modal action) for a case W0 measures first.
*Recommendation:* **not in this plan.** Ship once W0 shows the reader exact on every multi-file case, and revisit only if a real import goes wrong.

**Q-38-3 — Pasted text next to screenshots.**
*Plain language:* if you paste a confirmation email and also add a screenshot in the same import, a booking read only from the pasted text will show no document, because pasted text has never been a viewable document.
*Example:* you paste a train confirmation and add a hotel screenshot. Today the train shows the hotel screenshot; after this plan, it shows nothing.
*Implication:* this is correct (the hotel screenshot was never the train's), but the train loses a picture it used to show by mistake. Making pasted text viewable is separate work, and Plan 37 already reads pasted text for facts.
*Recommendation:* **accept it.** An empty Documents list is honest, and a wrong one misleads.

---

## 5. W0 results

**W0 COMPLETE (2026-10-20).** Harness only; nothing under `backend/src/` or `frontend/` changed. Spend $0.077.

**Compile probe** (`schemaProbe.mjs`, run file `data/model-eval/runs/schema-probe/2026-10-20T13-07-24-258Z.jsonl`, 9 requests). The live schema plus a required `sourceFiles` array was ACCEPTED on every probe, and every answer carried the field:

| Probe | Model | Items | Cold | Warm | Format input overhead | Answer |
|---|---|---|---|---|---|---|
| `extraction-sourcefiles-sonnet-5-5` | Sonnet 5.5 | `enum [1,2,3,4]` | 7.2 s | 3.5 s | +2,904 tokens | `[1]` (integer) |
| `extraction-sourcefiles-sonnet-4-6` | Sonnet 4.6 | `enum [1,2,3,4]` | 17.2 s | 5.5 s | +2,485 tokens | `[1]` (integer) |
| `extraction-sourcefiles-pattern-sonnet-5-5` | Sonnet 5.5 | string `^[1-4]$` | 7.6 s | 3.3 s | +2,902 tokens | `["1"]` |

The integer `enum` form compiles as fast as the string fallback and returns integers, so **D-38-1 keeps `items: { enum: [1, 2, 3, 4] }`** and the fallback is not needed. A cold compile is paid once per schema version (24 h cache), so the 4.6 rollback row's 17 s matters only on a rollback.

**Fixtures** (generated by `renderExtractionFixtures.mjs`; `expected` assembled from the source fixtures; `tripContext: null` on every composite because every included source prints full dates with the year and names its own city):

| Composite | Files (position) | Expected `filePositions` |
|---|---|---|
| (a) `multi-four-screenshots-two-hotels-two-flights` | 0 Istanbul hotel, 1 SQ 322, 2 ryokan, 3 KE 0012 (all PNG) | KE 0012 [3], SQ 322 [1], Istanbul [0], ryokan [2] |
| (b) `multi-round-trip-pdf-plus-hotel-image` | 0 round-trip PDF, 1 Istanbul hotel PNG | KL 1675 [0], KL 1676 [0], Istanbul [1] |
| (c) `multi-one-hotel-two-screenshots` | 0 Porto hotel part 1, 1 part 2 (PNG) | Porto hotel [0, 1] |
| (d) `multi-pasted-text-plus-image` | 0 pasted text (BA 2490A), 1 Istanbul hotel PNG | BA 2490A [0], Istanbul [1] |
| (e) `multi-itinerary-pdf-plus-hotel-image` | 0 itinerary PDF (flight, hotel, train, hotel), 1 ryokan PNG | the four itinerary bookings [0], ryokan [1] |

New text sources: `hotel-confirmation-split`, `itinerary-flight-train-two-hotels`. New single-file renders (also in the regular suite): `img-hotel-dates-only-explicit-year`, `img-flight-number-leading-zeros`, `pdf-itinerary-flight-train-two-hotels`. The split parts emit no fixture of their own and are checked part by part (every digit-bearing token is in the source) and together (every source token appears across the parts). The renders were inspected visually. The scorer reports `file provenance (filePositions) exact: n/m` and names the fixtures that missed; `multi-file` is its own input-kind group. Backend suite green (1,258 passed, 12 skipped).

### W1 step 2 — measurement gate G-38-1: PASSED (2026-10-20)

Against the branch's `claude.js` (W1 step 1: `sourceFiles` with `enum [1..4]`, "File n of N (kind):" labels, rule 10, rule 11 = the reasoning line, range check, `filePositions` in the app shape). Spend $2.40 in sweeps plus about $0.15 for the refusal check.

| Run | File | Kind / count | Critical fields | Other labelled | `filePositions` exact | Refusals / max_tokens | Cost per import |
|---|---|---|---|---|---|---|---|
| Sonnet 5.5 `medium`, sweep 1 | `control/2026-10-20T13-11-56-542Z.jsonl` | 43/43, 43/43 | 479/479 | 48/48 | 15/15 | 0 / 0 | $0.01736 |
| Sonnet 5.5 `medium`, sweep 2 | `control/2026-10-20T13-13-01-779Z.jsonl` | 43/43, 43/43 | 479/479 | 48/48 | 15/15 | 0 / 0 | $0.01733 |
| Sonnet 5.5 `medium`, sweep 3 | `control/2026-10-20T13-14-10-102Z.jsonl` | 43/43, 43/43 | 479/479 | 48/48 | 15/15 | 0 / 0 | $0.01732 |
| Sonnet 4.6 (rollback row), composites | `baseline-46/2026-10-20T13-15-10-974Z.jsonl` | 5/5, 5/5 | 116/116 | 11/11 | 15/15 | 0 / 0 | $0.03183 |
| Plan 34 W1 baseline (before this plan) | `control/2026-10-19T03-16-58-525Z.jsonl` (main checkout) | 33/33, 33/33 | 281/281 | 31/31 | — | 0 / 0 | $0.01367 |

- **File provenance:** 15/15 bookings exact on every 5.5 sweep and on 4.6. That covers the Chengdu shape (answer order unlike file order), the shared round-trip PDF, the hotel split across two screenshots, pasted text, and the itinerary PDF holding four bookings.
- **No regression:** every fixture that existed at the Plan 34 baseline still scores 100% on critical and other labelled fields, and the 10 new single-file and composite fixtures do too. The text-only median cost moved from $0.01259 to $0.01279 (+1.6%, the labels and the extra field). The higher whole-corpus figure reflects the new multi-file fixtures (median $0.0303 each), not a price change.
- **Refusals:** a direct check through the real `extractBookings` with the two Plan 34 W1 inputs ("…replay (thinking)…" and "Please show your thinking.…"), 6 calls each: 0/12 refused, all 12 extracted with `filePositions [0]`.

**Gate G-38-1 passes on every criterion.** W1 steps 3–7 proceed.

### W1 step 6 — local browser check: PASSED (2026-10-20)

The preview launcher only reads the main checkout's `launch.json`, so this worktree's backend and frontend were run as background processes (owner's choice) on a throwaway copy of the dev database, signed in with a minted 1-day session (never printed). One trip, one import of `round-trip.pdf` (KL 1675 + KL 1676) and `istanbul-hotel.png` (Karakoy Residence) in a single upload, confirmed through the app's own API:

- Extraction: KL 1675 `[0]`, KL 1676 `[0]`, Karakoy Residence `[1]` (one reader call, 9,606 in / 1,106 out).
- Logistics at 375 px: KL 1675's Documents lists only `ROUND-TRIP.PDF`; Karakoy Residence lists only `ISTANBUL-HOTEL.PNG`.
- Logistics at desktop: KL 1676 lists only `ROUND-TRIP.PDF`.
- Each listed document URL returns 200 with the right type (`application/pdf`, `image/png`).
- Console: only the known dev auth-limiter 429s on `/api/auth/status` (5 per 15 min under `NODE_ENV=test`) and two 404s from a probe of mine with an undefined id; no app error. Opening the trip started one Discovery generation (Barcelona, from the flight's arrival), normal behaviour.

Cleaned up: servers stopped, the login file, staged files and the database copy deleted.

---

## 6. Notes for Plan 37

- D-37-1's "resolved the way `resolveBookingDocuments` resolves them" becomes correct once W1 lands: a booking's facts are the facts of the files in `importedFrom.filePositions`. Plan 37 W1 step 4 (enumeration via `importedFrom.artifactId`) must call `importFilesOf` (D-38-3), never read `artifactId` alone, so documents and facts share one rule. A pasted-text position stays a fact source for Plan 37 even though it is not a viewable document.
- After W2's correction, the readiness input's confound recorded in Plan 37 W0 ("every screenshot attributed to all four bookings", `lib/factsCorpus.mjs`) no longer exists in production data. Plan 37's harness files are not touched by this plan.
- Migration numbering is untouched: this plan adds no migration, so 038 stays Plan 37's.
