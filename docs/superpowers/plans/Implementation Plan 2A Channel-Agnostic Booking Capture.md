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

### M2 — Capture UI in existing trip (Path 4)
- **Create:** `frontend/src/services/importApi.js`, `frontend/src/components/import/{CaptureFlow,CaptureInput,ExtractionReview,ExtractedBookingCard}.jsx`.
- **Modify:** `frontend/src/pages/LogisticsTab.jsx` only.
- **Verify:** preview tooling at 375px: paste fixture → review → edit a card via AddBookingModal → confirm → bookings grouped in Logistics, Plan day headers show derived cities, Map shows stops. Edge checks: duplicate re-import (unchecked card), out-of-range (extend button PATCHes trip), cat photo (friendly non-travel state), oversized file (client rejection), collaborator account repeats flow.

### M3 — New-trip integration + NewTripModal simplification (Path 1)
- **Create:** `backend/src/utils/countries.js`, `backend/tests/countries.test.js`.
- **Modify:** `frontend/src/components/trips/NewTripModal.jsx`, `backend/src/services/trips.js` (createTrip country normalization only), `frontend/src/pages/TripsHomePage.jsx` (navigate to logistics when bookings imported).
- **Verify:** skip-path trip with chips Chengdu/Chongqing → `destination_countries=["CN"]`, Map tab uses AMap (GCJ-02 path intact); capture-path with flight fixture → dates prefilled, trip created, bookings confirmed, lands on Logistics; legacy ISO-code payloads still accepted; `npm test` in backend/ passes.
- **Optional (flagged):** `updateTrip` earlier-startDate extension mirroring the endDate branch — enables backward extension for before-start captures. Not required for v1.

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
