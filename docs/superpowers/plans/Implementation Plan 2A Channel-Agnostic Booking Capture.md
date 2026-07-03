# Trippy — Channel-Agnostic Booking Capture ("Dump Your Travel Chaos")

## Context

The workshop doc `docs/superpowers/plans/Implementation Plan 2 Redesign Onboarding Paths.md` identified setup friction as Trippy's main UX pain: creating a trip asks for schema-first inputs (comma-separated destinations, country codes) and adding logistics means manually classifying and typing booking details. The product promise is *"dump your travel chaos here, Trippy organizes it."*

**Key constraint (user decision):** bookings come from any channel — websites, apps, phone calls — so NO per-provider integrations, email imports, MCP, or booking APIs. The capture surface is channel-agnostic: paste text, upload a screenshot, upload a PDF, or type a note. Claude's API natively reads images and PDFs (base64 content blocks), so no OCR library is needed.

**Scope decisions (confirmed with user):**
1. v1 inputs: pasted text + screenshots + PDFs.
2. Capture-first scope: Path 1 (booked-first at trip creation), Path 4 (ongoing capture into existing trip), plus NewTripModal simplification. Route segments / undated "Day 1/Day 2" trips / conflict UI are OUT of scope (future plan) — but schema must not block them.
3. One CaptureFlow component, two entry points (Logistics tab + new-trip step). AddBookingModal survives as manual fallback and as the editor for correcting extractions.
4. Raw artifacts stored in a new table with extraction status, linked to created bookings (re-extract + audit).

**Why this is cheap to build well:** the existing backend already does the hard part. `createBooking()` (`backend/src/services/bookings.js:72`) auto-runs `syncStopWithBooking()` (`backend/src/services/stops.js:666`) which creates timeline stops, resolves locations, fetches photos; and `deriveDayCity()` (`backend/src/services/trips.js:143`) already implements the workshop doc's precedence (manual override > hotel booking > transit arrival > cascade). Extraction just needs to produce correctly-shaped bookings and feed them through the existing pipeline — zero changes to that code.

**Verified codebase facts** (spot-checked):
- `request()` wrapper supports `timeoutMs` (frontend/src/services/api.js:3-11) — long extraction calls need no new plumbing.
- `AddBookingModal.handleSubmit` awaits `onSubmit` then closes (AddBookingModal.jsx:408-419), and `hydrateFormFromBooking` (line 234) accepts camelCase booking shape → the modal works as a local draft editor with no changes.
- `syncStopWithBooking` returns null safely when the booking date has no day row (stops.js:683-686) → out-of-range bookings save without a stop, no crash.
- `express.json()` at backend/src/index.js:34 has the default 100 KB limit → must raise for base64 uploads.
- No multer / file upload exists anywhere; no paste/FileReader handling in frontend.

---

## Design Decisions

**D1 — Artifact storage: BLOBs in SQLite.** Artifacts are small (caps: text ≤ 100 KB, image ≤ 5 MB — Claude's per-image limit, PDF ≤ 10 MB, ≤ 4 inputs per capture). better-sqlite3 handles Buffers natively; Docker deploy has a single `./data:/app/data` volume, so blobs-in-DB = one backup story + FK CASCADE cleanup. `content_hash` (sha256) enables dedupe: identical re-upload returns cached extraction, no Claude call (CLAUDE.md cost discipline).

**D2 — Transport: base64 JSON, not multipart.** No multer dep exists; Claude needs base64 anyway; the existing `request()` wrapper stays unchanged. Client base64-encodes via FileReader, server forwards to Claude and decodes to Buffer for storage. Requires `app.use(express.json({ limit: '16mb' }))` in `backend/src/index.js:34`.

**D3 — Model: `claude-sonnet-4-6`, single non-streaming call.** Already proven in this repo (copilot). Messy screenshots, Chinese train bookings, and date-ambiguity reasoning are where Haiku degrades, and extraction errors are user-facing. ~$0.02–0.05 per capture; hash-dedupe prevents repeat spend. One `EXTRACTION_MODEL` constant. No SSE — a 5–25 s single response with a loading state; use `timeoutMs: 120000`.

**D4 — Output contract: fenced ```json block + strict server-side validation** (matches copilot mutation pattern in services/claude.js). Server validates everything: enum types, `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}` datetimes, IANA tz via `Intl.DateTimeFormat` try/catch. Malformed output → artifact `status='failed'` + stored error + retry button.

**D5 — Timezones: Claude emits IANA guesses (city→tz is reliable); server validates; user confirms in review.** No geo-tz at extraction (no lat/lng yet).

**D6 — deriveDayCity compatibility:** extraction populates exactly what `extractCityFromBooking()` (trips.js:115-131) reads — flight/train/bus → `detailsJson.destinationCity`/`originCity` (canonical **English** names), hotel/other → `detailsJson.city`. Local names (成都) preserved in title/station fields.

**D7 — Future-proofing for route segments:** `trip_id` nullable on artifacts, raw bytes + full extraction JSON retained, schema includes bus/ferry types, per-booking ISO `countryCode`s, `assumptions[]` array.

---

## Extraction JSON Schema (contract: prompt ↔ importer ↔ UI)

Claude returns one fenced json block:

```json
{
  "isTravelRelated": true,
  "summary": "China Eastern round-trip SHA-CTU + Chengdu hotel",
  "language": "zh",
  "bookings": [{
    "type": "flight",                         // flight|train|bus|ferry|hotel|other
    "title": "MU5401",
    "confirmationRef": "ABC123",              // never invented; null if absent
    "bookingSource": "Trip.com",
    "startDatetime": "2026-09-14T08:35",      // local wall-clock, no offset; null if unknown
    "endDatetime": "2026-09-14T11:50",
    "origin": "SHA - Shanghai Hongqiao",      // station/airport for transit, address for hotel
    "destination": "CTU - Chengdu Tianfu",
    "terminalOrStation": "Terminal 2",
    "originTz": "Asia/Shanghai",
    "destinationTz": "Asia/Shanghai",
    "details": {
      "originCity": "Shanghai", "destinationCity": "Chengdu",   // English exonyms (D6)
      "originCountryCode": "CN", "destinationCountryCode": "CN",
      "city": null,                            // hotels/other only
      "carrierCode": "MU", "flightNumber": "5401", "airlineName": "China Eastern",
      "trainNumber": null, "originStation": null, "destinationStation": null,
      "seatClass": null, "address": null, "localName": null, "note": null
    },
    "confidence": { "overall": "high", "fields": { "confirmationRef": "medium" } },
    "assumptions": ["Year 2026 inferred from trip date range"]
  }]
}
```

Prompt rules (in `EXTRACTION_SYSTEM`, services/claude.js):
1. Extract EVERY distinct booking — one email can hold outbound + return flights + hotel; one object per leg/stay.
2. Never invent values; unknown → null + lowered confidence.
3. Date inference: inject today's date + (if trip exists) trip range/destinations into user turn. Missing year → infer from trip range (else nearest future), record in `assumptions`. Ambiguous DD/MM → prefer reading inside trip range, else low confidence.
4. Hotels with date-only info → `T15:00`/`T11:00` defaults + assumption (mirrors AddBookingModal's `withDefaultTime`).
5. Multilingual: English city exonyms in `details.*City`; local names preserved; set `language`.
6. Non-booking input → `isTravelRelated:false, bookings:[]` + one-line summary. No prose outside JSON.
7. IANA tz only; null when unsure.
8. Transfers/rentals/tickets → `other` with descriptive titles.

Server-side `normalizeExtractedBooking()` maps this → existing booking POST shape, with `detailsJson` = `details` minus nulls plus `importedFrom: { artifactId, model, extractedAt }`.

---

## DB Migration — `backend/src/db/migrations/011_import_artifacts.sql`

(Never touch 001–010; runner picks up new files by filename sort.)

```sql
CREATE TABLE IF NOT EXISTS import_artifacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id TEXT REFERENCES trips(id) ON DELETE SET NULL,   -- nullable: capture-before-trip (Path 1)
  status TEXT NOT NULL DEFAULT 'pending',                 -- pending|extracting|extracted|confirmed|failed
  model TEXT,
  extracted_json TEXT,
  error TEXT,
  created_booking_ids TEXT NOT NULL DEFAULT '[]',         -- JSON array, written at confirm
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  extracted_at TEXT,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS import_artifact_files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  artifact_id TEXT NOT NULL REFERENCES import_artifacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('text','image','pdf')),
  media_type TEXT NOT NULL,        -- text/plain, image/png|jpeg|webp, application/pdf
  filename TEXT,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,      -- sha256 hex
  content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_artifacts_user ON import_artifacts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_import_artifacts_trip ON import_artifacts(trip_id);
CREATE INDEX IF NOT EXISTS idx_import_artifact_files_hash ON import_artifact_files(content_hash);
```

Two tables because one capture = one Claude call = one review session, but may contain multiple files (multi-screenshot train booking → all blocks in ONE extraction call). Booking↔artifact linkage: `created_booking_ids` + `detailsJson.importedFrom.artifactId` — no FK on bookings, no migration risk.

---

## Backend Work

### `backend/src/services/claude.js` — add
- `const EXTRACTION_MODEL = 'claude-sonnet-4-6'`, `EXTRACTION_SYSTEM` prompt.
- `export async function extractBookings({ files, contextText })` — content blocks in order: images as `{type:'image', source:{type:'base64', media_type, data}}`, PDFs as `{type:'document', ...}`, pasted text inline in final text block + contextText + instruction. `max_tokens: 8192`, plain await. Parse with existing fenced-block regex (last match); throw 502 if unparseable. Log `[import] extract files=%d in=%d out=%d` from `response.usage`.

### `backend/src/services/importer.js` — new
```js
createArtifactAndExtract(userId, { tripId, inputs, force })
reextractArtifact(userId, artifactId)
confirmArtifact(userId, artifactId, { tripId, bookings })
listArtifactsForTrip(userId, tripId)
getArtifactDetail(userId, artifactId)   // metadata + extraction, never blobs
deleteArtifact(userId, artifactId)
```
- Validation: 1–4 inputs, per-kind size caps, media-type whitelist, sha256 per file. Parameterized SQL throughout.
- Dedupe: same user + same file-hash set + status extracted/confirmed + `!force` → return cached with `cached: true`.
- Extract: insert artifact (`status='extracting'`) + files in one transaction → `extractBookings()` → validate/normalize each booking → `extracted_json`, `status='extracted'`. Errors: `status='failed'` + `error`, rethrow (fail loudly).
- Warnings (computed live at extract time when tripId present, returned not stored): `duplicate` (case-insensitive confirmationRef+type match vs trip bookings, includes existing bookingId), `beforeTripStart`, `afterTripEnd` (+ `suggestedEndDate` for one-tap extend via existing `PATCH /api/trips/:tripId`), `notTravelRelated`, `empty`, `lowConfidence`.
- Confirm: re-validate client-edited bookings with same normalizer; **sequential** `await createBooking(userId, tripId, payload)` loop (each triggers Nominatim/Unsplash calls — don't stampede); stamp `importedFrom` server-side; update artifact (`trip_id`, `created_booking_ids`, `status='confirmed'`). Out-of-range booking saves without a stop (verified safe).
- `assertArtifactAccess`: artifact owner OR artifact's trip passes `assertTripAccess` → collaborator capture (Path 4) works for free.

### `backend/src/routes/imports.js` — new, mounted in index.js

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/import/artifacts` | `{tripId?, force?, inputs:[{kind, mediaType?, filename?, content}]}` → `201 {artifact, extraction, warnings, cached}` |
| POST | `/api/import/artifacts/:id/extract` | re-run Claude (force), same response |
| POST | `/api/import/artifacts/:id/confirm` | `{tripId, bookings:[payload]}` → `201 {bookings:[created]}` |
| GET | `/api/trips/:tripId/import/artifacts` | `{artifacts:[metadata]}` |
| GET | `/api/import/artifacts/:id` | `{artifact, extraction}` |
| DELETE | `/api/import/artifacts/:id` | `{ok:true}` |

All behind `requireAuth` + artifact/trip access checks. **Modify `backend/src/index.js`:** mount router; `express.json({ limit: '16mb' })`.

### `backend/src/utils/countries.js` — new (M3)
`countryCodeFromName(name)`: 'Japan'→'JP', 'CN'→'CN' pass-through, unknown→null. Built by inverting `Intl.DisplayNames('en', {type:'region'})` + alias map (USA, UK, South Korea, Hong Kong, Macau, Taiwan…). No new dependency. Critical: `destination_countries` ISO codes drive map provider choice (CN → AMap/GCJ-02 in mapConfig.js:25-48) and Nominatim country biasing — removing the user-facing country-codes field must not break China trips.

---

## Frontend Work

### `frontend/src/services/importApi.js` — new
Thin client over `request()` with `timeoutMs: 120000` on extract/confirm. Plus `fileToInput(file)` helper: FileReader→base64 (strip `data:` prefix), kind from `file.type`, client-side size caps.

### `frontend/src/components/import/` — new
```
CaptureFlow.jsx            state machine: input → extracting → review → done
├── CaptureInput.jsx       paste textarea + drag-drop + <input type="file" multiple accept="image/*,application/pdf">
├── ExtractionReview.jsx   summary + warnings + card list + confirm bar
│   └── ExtractedBookingCard.jsx   include-toggle, type badge, fields, confidence hints, Edit
└── (reuses) AddBookingModal as draft editor: booking={draft}, onSubmit={(data)=>updateDraft(localId,data)}
```
- Bottom-sheet modal per existing pattern (`flex items-end sm:items-center`, `--ink-surface`, backdrop-blur). Playfair italic headline "Dump your travel chaos here."; DM Mono labels; gold used once (the Extract CTA). `accept="image/*,application/pdf"` gives mobile camera + photo library natively. 375px first.
- Review cards: duplicates default-unchecked ("already saved"); assumptions/low-confidence → muted hint ("check the date — year was inferred"); `afterTripEnd` → one-tap "Extend trip to {date}" (`tripsApi.update`); confirm bar "Add N bookings" → `importApi.confirm` → `tripState.refresh()`.
- Non-travel artifact → friendly line from `extraction.summary` + retry/replace.

### Path 4 — `frontend/src/pages/LogisticsTab.jsx` (only file modified in M2)
Primary CTA "＋ Add bookings" opens CaptureFlow; DM Mono text button "enter manually" opens existing AddBookingModal unchanged.

### Path 1 — `frontend/src/components/trips/NewTripModal.jsx` rework (M3)
Two-step sheet:
- **Step 1 "What do you already have?"**: embedded CaptureInput (tripId=null → tripless extraction), prominent "Skip — start from scratch". On success prefill: startDate/endDate from booking date span, destination chips from unique `details.*City` chronologically (+countryCodes), suggested title "{firstCity} {Month YYYY}".
- **Step 2 details**: title, destination chips (reuse `CityInput` + `bookingsApi.lookupCities` — needs no trip context), dates, travellers, pace, InterestTagPicker. **Country-codes field deleted**; backend `createTrip` normalizes country names → ISO via `countryCodeFromName` (2-letter pass-through keeps API backward compatible).
- Capture path: `tripsApi.create` → `importApi.confirm(artifactId, {tripId, bookings})` → navigate to `/trips/:id/logistics`. Skip path unchanged (→ plan).

---

## Milestones (each independently executable + verifiable)

### M1 — Backend extraction pipeline ✅ DONE
- **Branch:** `feature/booking-capture-m1`, commit `6790964`.
- **Created:** `backend/src/db/migrations/011_import_artifacts.sql`, `backend/src/services/importer.js`, `backend/src/routes/imports.js`, `backend/tests/importer.test.js`, `backend/tests/fixtures/` (flight-email.txt, train-ticket.png).
- **Modified:** `backend/src/services/claude.js` (`EXTRACTION_MODEL`, `EXTRACTION_SYSTEM`, `extractBookings()`), `backend/src/index.js` (mounted router, `express.json({limit:'16mb'})`), `backend/tests/migrations.test.js` (migration count 10→11).
- **Verified:** 143/143 backend tests pass (`npm test`). Live smoke test against the real Anthropic API on an isolated temp DB: text fixture → extraction with correct `detailsJson.destinationCity`/`originCity` English exonyms and IANA tz → repeat POST returns `cached:true` with zero additional Claude calls → confirm → `GET /api/trips/:id/detail` shows the booking with a stop synced to the correct day and `resolvedCity: "Chengdu"`.
- **Bug found + fixed during verification:** `normalizeExtractedBooking()` was not idempotent. The extraction API returns bookings shaped as `{detailsJson, startDatetime: "...:00", ...}`, but `confirmArtifact()` re-runs the normalizer on exactly that shape (per spec, "re-validate client-edited bookings with the same normalizer") — the normalizer was reading `raw.details` (Claude's raw key) and a bare `HH:MM` datetime regex, so a real confirm call silently dropped `startDatetime`/`endDatetime` and nearly all of `detailsJson`, keeping only `importedFrom`. **Fixed** by making the datetime regex accept an already-normalized `HH:MM:SS` suffix and having the normalizer fall back to `raw.detailsJson` when `raw.details` isn't present. Added a regression test (`normalizeExtractedBooking is idempotent...`) and strengthened the `confirmArtifact` test to assert the full field set (not just `importedFrom`) survives a round-trip.
- **Relevant for M2:** `ExtractionReview.jsx`'s confirm bar will send back exactly the extraction-response shape (post-edit) — this is the code path the bug lived in, now covered by tests and live-verified. No further changes needed on the backend side for M2 to consume.

### M2 — Capture UI in existing trip (Path 4) ✅ DONE
- **Branch:** `feature/booking-capture-m1` (continued).
- **Created:** `frontend/src/services/importApi.js` (`createArtifact`/`reextract`/`confirm`, `fileToInput`/`textToInput` with client-side size caps mirroring the backend), `frontend/src/components/import/{CaptureFlow,CaptureInput,ExtractionReview,ExtractedBookingCard}.jsx`.
- **Modified:** `frontend/src/pages/LogisticsTab.jsx` only — header CTA split into gold primary "+ Add bookings" (opens `CaptureFlow`) and secondary text link "enter manually" (existing `AddBookingModal` flow, unchanged); `CaptureFlow` conditionally mounted on `captureOpen` so its state resets cleanly on every reopen. Also added a `backend` entry to `.claude/launch.json` for local preview.
- **Design decisions made during implementation:**
  - `CaptureFlow` owns the shared modal header/padding/scroll container; `CaptureInput` and `ExtractionReview` render body-only content plus their own sticky footer (Extract CTA / confirm bar), avoiding duplicated header markup.
  - `AddBookingModal` originally only rendered field blocks for `hotel`/`flight`/`train`/`other`; editing an extracted `bus`/`ferry` booking would silently downgrade it to `other` and null out `origin`/`terminalOrStation`. Fixed at the root instead of working around it: `AddBookingModal.jsx` now treats `bus`/`ferry` as first-class types sharing the train form (route + station + departure/arrival + seat/class, relabeled per type via a `TRANSIT_LABEL` map), so the type survives edits intact and "enter manually" gains bus/ferry as real options too. This is the one deviation from "M2 modifies only `LogisticsTab.jsx`" — a small (~25 line), backend-compatible, and additive change (no `CHECK` constraint on `bookings.type`; nothing else assumes exactly four types).
  - Duplicate-flagged bookings default `included: false`; all other warning types (`lowConfidence`, `beforeTripStart`, `afterTripEnd`) are advisory and stay checked.
  - Draft edits round-trip through a single shared `AddBookingModal` instance with a synchronous `onSubmit` (no network call) that merges the form output back into local state — the modal's own `await onSubmit(...); onClose()` behavior is unchanged.
- **Verified live** against the real Chengdu–Chongqing trip data (preview tooling, 375px): pasted a flight-confirmation fixture → real `POST /api/import/artifacts` call → review screen rendered the summary, type badge, WHEN/WHERE/CONFIRMATION rows, two assumption hints, and the `afterTripEnd` warning with a working "Extend trip to {date}" button sourced from the actual `suggestedEndDate` → "Edit" opened `AddBookingModal` with every field (origin, destination, dates, confirmation ref, airline, booking source) correctly hydrated from the extraction and the type selector locked → Cancel/Close made zero network calls and left the trip's 7 existing bookings untouched → reopening `CaptureFlow` reset cleanly to an empty input screen. Did not click through to Confirm (would have written a fictional booking into real trip data) — the confirm payload construction and the `duplicate`/oversized-file/non-travel edge cases were verified by code review against the exact backend contract (`normalizeExtractedBooking`, `computeWarnings`) rather than live-clicked.
- **Bus/ferry fix verified live:** confirmed the 6-pill type selector (`hotel/flight/train/bus/ferry/other`) renders and is selectable; created a manual test "Bus" booking (title, stations, confirmation ref) via "enter manually" → field labels correctly read "Bus Number" → saved → persisted with `type: 'bus'` intact (grouped under "Other" in the Logistics list per existing display rules, badge correctly reads "BUS") and `origin`/`destination` both non-null → re-opened via "Edit Booking" and confirmed the same hydrated labels/values on the real persisted-booking path (not just the draft-editor path) → deleted the test booking, trip back to its original 7 bookings.
- **Noted, not fixed (M1 data quality, out of M2 scope):** for the flight fixture tested, Claude's extraction put the full flight number including carrier prefix into `detailsJson.flightNumber` (e.g. `"MU5401"` instead of `"5401"`), so `AddBookingModal`'s pre-existing `carrierCode + flightNumber` concatenation in `hydrateFormFromBooking` displays `"MUMU5401"` in the Flight Number field on edit. Cosmetic only (a manually-entered booking with the same field values would show the same thing); would need an `EXTRACTION_SYSTEM` prompt tweak in `services/claude.js` (M1 territory) to fix at the source.
- **Relevant for M3:** the conditional-mount-for-clean-reset pattern in `LogisticsTab.jsx` is reusable as-is if `NewTripModal`'s Step 1 embeds `CaptureInput` directly (M3 plan already calls for `tripId=null` tripless extraction through the same components). `AddBookingModal` now genuinely supports all six extraction types, so Step 1's capture-then-review path needs no further type-coverage work.

### M3 — New-trip integration + NewTripModal simplification (Path 1) ✅ DONE
- **Branch:** `feature/booking-capture-m1` (continued).
- **Created:** `backend/src/utils/countries.js` (`countryCodeFromName` — hardcoded ISO 3166-1 alpha-2 code list since `Intl.supportedValuesOf` does not enumerate region codes, English names derived from `Intl.DisplayNames` rather than hand-maintained, plus an alias map for common mismatches; strips messy Google Places `"Region, Country"` text to its last comma segment before matching), `backend/tests/countries.test.js`, `frontend/src/services/bookingPayload.js` (`toBookingConfirmPayload` — the confirm-payload field mapping extracted out of `CaptureFlow.jsx` so `NewTripModal.jsx` doesn't duplicate it), `frontend/src/components/trips/DestinationChipPicker.jsx` (wraps `CityInput` for typeahead add, renders removable `{city,country}` pills styled like `InterestTagPicker`).
- **Modified:** `backend/src/services/trips.js` (`createTrip` maps `destinationCountries` through `countryCodeFromName(raw) ?? raw` — keeps the original string on no-match since `getMapConfig` just falls through to its safe default branch for anything that isn't `CN`/`KR`), `frontend/src/components/logistics/CityInput.jsx` (`onCitySelect` now receives the whole `{city,country}` suggestion instead of a bare city string — its only 2 existing call sites in `AddBookingModal.jsx` updated to destructure), `frontend/src/components/import/CaptureFlow.jsx` (its inline confirm-payload mapping now calls the shared `toBookingConfirmPayload`), `frontend/src/components/trips/NewTripModal.jsx` (full rework — see below), `frontend/src/pages/TripsHomePage.jsx` (`handleCreateTrip` sequencing).
- **NewTripModal redesign:** two-phase state machine (`'capture' | 'details'`), not three — a trip-less capture has nothing to warn about (`computeWarnings` in `importer.js` returns `[]` whenever `tripId` is falsy, since there's no existing trip to compare duplicates/date-range against), so there's no per-card review step before a trip exists. Step 1 reuses `CaptureInput` directly (not the full `CaptureFlow`/`ExtractionReview`, which hard-require a real `tripId` for their internal confirm-call and extend-trip affordances) plus a "Skip — start from scratch" link and an inline non-travel/empty-extraction message with retry. On a non-empty extraction, `deriveTripPrefill(extraction)` derives destination chips (unique cities in chronological booking order, transit types pairing `originCity`/`destinationCity` with their ISO country codes already present in `detailsJson`; hotel/other bookings only have a city, no country field in the extraction schema, so their chips simply don't contribute a country — `destinations` and `destinationCountries` are independent arrays on the trip record, not a 1:1 pairing), the trip's date span (min/max `startDatetime`/`endDatetime`), and a suggested title (`"{firstCity} {Month YYYY}"`), then auto-advances to Step 2 (today's form, minus the two old free-text destination/country-code inputs, plus `DestinationChipPicker`). Submit attaches `captureArtifactId`/`captureBookings` to the payload only when a capture happened.
- **TripsHomePage sequencing:** `tripsApi.create()` is the point of no return — if the subsequent `importApi.confirm()` throws, the trip still exists (recoverable via the Logistics tab's own M2 capture entry point) rather than risking a duplicate trip on retry; navigates to `/trips/:id/logistics` when bookings were imported, else today's `/trips/:id/plan`.
- **Verified:** `npm test` in `backend/` passes 149/149 (143 baseline + 6 new `countries.test.js` cases). Live-verified against the real trip data (preview tooling, real Anthropic/Google Places API calls, `NODE_ENV=test` still pointed at the live `./data/trippy.db` per the existing `.claude/launch.json` — created test trips and deleted them afterward, same protocol as M2):
  - **Skip path:** typed "Chengdu" into the new chip picker → Google Places returned `"Sichuan, China"` as the raw secondary text → selected it → filled title/dates → submitted → trip created, navigated to `/plan`, Day 1 city correctly seeded "Chengdu" → Map tab issued real `wprdXX.is.autonavi.com` tile requests, confirming `destination_countries` normalized `"Sichuan, China"` → `["CN"]` and the AMap/GCJ-02 path is intact.
  - **Capture path:** pasted the `flight-email.txt` fixture (MU5401 SHA→CTU) into Step 1 → real `POST /api/import/artifacts` call with `tripId: null` → auto-advanced to Step 2 with title prefilled `"Shanghai September 2026"`, destination chips `[Shanghai, Chengdu]` in chronological (origin→destination) order, both dates `14/09/2026` — exactly matching `deriveTripPrefill`'s logic → submitted → trip created → `importApi.confirm` fired → landed on `/logistics` (not `/plan`) → the flight booking rendered in the bookings list.
  - **Non-travel input:** pasted "hello world, just saying hi..." → extraction returned `isTravelRelated:false` → modal correctly stayed on Step 1 (did not auto-advance) showing the extraction's own summary line ("Input is a casual greeting with no travel-related content or bookings.") with both "Extract" (retry) and "Skip" still available.
  - **Regression — `AddBookingModal`'s `CityInput` usage:** opened an existing trip's manual Train-booking form, typed "Chengdu", selected the Google suggestion, confirmed `fromCity` resolved to the plain string `"Chengdu"` (not `[object Object]`) — the `onCitySelect` signature change didn't break its two call sites.
  - **Regression — M2's `CaptureFlow`:** pasted the same flight fixture into an existing trip's "+ Add bookings" flow, extracted, reviewed, clicked "Add 1 bookings" → booking count went 7→8, no console errors → confirms the `toBookingConfirmPayload` extraction didn't change `CaptureFlow`'s behavior. Test trip/booking created during verification were deleted afterward via `DELETE /api/trips/:id` and `DELETE /api/bookings/:id`, leaving both real trips at their original state.
- **Not done (flagged as optional in the plan, still true):** `updateTrip` earlier-startDate extension mirroring the endDate branch. Not required for v1 — no before-trip-start capture case was hit in testing. Promoted to its own milestone below.

### M4 — Backward trip-start extension (symmetry with the existing end-date extend) ✅ DONE
**Why:** `CaptureFlow`'s `afterTripEnd` warning already offers a one-tap "Extend trip to {date}" button (`handleExtendTrip` → `tripsApi.update(tripId, {endDate})` → `updateTrip` inserts new `days` rows after the old end, seeded with the trip's default city). The symmetric `beforeTripStart` warning exists in `computeWarnings` (`backend/src/services/importer.js:206`) but today just renders a passive "it'll still be saved" message in `ExtractedBookingCard.jsx` with no action — and `updateTrip` (`backend/src/services/trips.js:334-377`) doesn't read or write `start_date` at all today, so a `startDate` sent in a PATCH is silently ignored. No good reason for the asymmetry; this closes it.

- **Modify (no new files expected):**
  - `backend/src/services/importer.js` — `computeWarnings`: add `suggestedStartDate: startDate` alongside the existing `beforeTripStart` push (mirrors `suggestedEndDate` on `afterTripEnd`).
  - `backend/src/services/trips.js` — `updateTrip`: mirror the existing `endDate` block for `startDate`. Extending backward (`input.startDate < existingRow.start_date`) inserts new `days` rows for the dates between the new and old start (exclusive), seeded with the same `defaultCity` logic already used for the end-date extension; shortening from the front (`input.startDate > existingRow.start_date`) mirrors the existing stops-guard (block with a 400 if any day being removed has stops, else delete those days). Add `start_date` to the final `UPDATE trips` statement.
  - `frontend/src/components/import/ExtractedBookingCard.jsx` — give `beforeTripStartWarning` the same button treatment as `afterTripEndWarning` ("Extend trip to {suggestedStartDate}"), replacing the current passive-only message.
  - `frontend/src/components/import/ExtractionReview.jsx` — thread the new extend-start callback down to the card (mirrors the existing `onExtendTrip`/`tripEndDate` threading).
  - `frontend/src/components/import/CaptureFlow.jsx` — `handleExtendTrip` (or a sibling `handleExtendTripStart`) calls `tripsApi.update(tripId, {startDate: suggestedStartDate})`, updates local `tripStartDate` state, and clears the `beforeTripStart` warning from affected drafts (mirrors the existing `afterTripEnd` clear-on-extend logic).
- **Not in scope:** `NewTripModal` (M3) doesn't need this — there's no existing trip to extend; capture-before-trip-exists just prefills the date span directly via `deriveTripPrefill`.
- **Verify:** paste/confirm a booking dated before an existing trip's start → card shows the before-start warning with a working "Extend trip to {date}" button → click it → `days` rows inserted before the old start with the trip's default city → warning clears on that card → `npm test` in `backend/` still green (add a case: extend-backward inserts the right day rows; shorten-from-front still blocked when the removed days have stops, mirroring the existing endDate test).
- **Verified:** new `backend/tests/trips.test.js` (no prior file existed for `updateTrip`) covers both the previously-untested existing end-date behavior and the new start-date behavior — 7 cases (extend/shorten/shorten-blocked-by-stops for each direction, plus a start-date no-op case). `backend/tests/importer.test.js`'s existing before/after-range test gained one assertion for `suggestedStartDate`. `npm test` in `backend/`: 156/156 passing (149 baseline + 7 new), zero regressions.
- **Live-verified** against the real Chengdu–Chongqing trip (preview tooling, real Anthropic API call, same protocol as M2/M3 — test data cleaned up afterward): pasted a flight fixture dated `2026-06-05` (3 days before the trip's real `2026-06-08` start) into the M2 "+ Add bookings" flow on that trip → review card correctly rendered "This is before your trip starts (2026-06-08)." with a working "Extend trip to 2026-06-05" button (previously this warning was passive-only) → clicked it → real `PATCH /api/trips/:id` fired with `{startDate: "2026-06-05"}` → response confirmed `trip.startDate: "2026-06-05"` and three new `days` rows (`2026-06-05`, `06-06`, `06-07`) inserted with `city: "Chengdu"` (the trip's first destination), while the pre-existing `2026-06-08` day and its 4 stops were untouched → the `beforeTripStart` warning cleared on the card with no page reload, matching `afterTripEnd`'s existing behavior exactly. Did not click "Add 1 bookings" (would have written a fictional booking into real trip data). Cleanup: reverted via the same `PATCH` endpoint with `{startDate: "2026-06-08"}`, which exercised the shorten-from-front branch live — response confirmed `dayCount: 10`, `firstDay: "2026-06-08"`, trip restored to its original range; confirmed booking count still 7 with no `TESTM4X` reference leaked. No console errors during the flow.

---

## Risks & Edge Cases
- **Huge pastes:** 100 KB cap → 400 with clear message; never silently truncate.
- **Non-booking artifacts:** `isTravelRelated:false` contract; nothing created.
- **Duplicates:** confirmationRef match → default-unchecked; content hash → cached extraction, zero spend.
- **Chinese/multilingual bookings** (real use case): English exonyms in city fields keep deriveDayCity working; local names preserved for display.
- **Ambiguous dates:** year-inference rules + `assumptions[]` surfaced on cards; user edits before confirm.
- **Partial extractions:** bookings API only requires type+title; low-confidence flags direct attention; AddBookingModal fills gaps.
- **Malformed model output:** 502, artifact `failed` + stored error, retry endpoint.
- **Out-of-range dates:** after-end → one-tap extend; before-start → saved without stop (verified safe in stops.js:683-686).
- **Cost:** one Claude call per capture, hash dedupe, no auto re-extract, usage logged, single model constant.

## Out of Scope (future plan)
Route segments model, undated/relative-day trips, booking-vs-route conflict UI. Schema decisions above (nullable trip_id, retained raw extraction, countryCodes, assumptions) keep the door open.
