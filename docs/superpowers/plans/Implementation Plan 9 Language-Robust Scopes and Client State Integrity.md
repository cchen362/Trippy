# Implementation Plan 9 — Language-Robust Scopes and Client State Integrity

**Status: NOT STARTED — approved for implementation 2026-07-10; owner implements separately.**

**Origin:**
[Plan 8 Production QA Findings](../reviews/2026-07-10-plan8-production-qa-findings.md)
(parent: [Implementation Plan 8](Implementation%20Plan%208%20Destination%20Scopes%20and%20Geography%20Identity.md)).
Design decisions D1–D6 in the findings doc were scenario-hardened and owner-approved
2026-07-10. Do not re-litigate them; this plan encodes them.

**Goal:** make destination identity robust across languages and scripts (the `杭州市`
class of bug), make trip-destination editing honest (chips = durable scope vocabulary),
fix the Plan-tab state-loss race, and stop the Discovery catalogue re-polluting itself —
while preserving Plan 8's promotion ladder, anchors, and read-time-healing architecture.

---

## 0. Verified facts this plan is built on (2026-07-10 production QA)

Confirmed in deployed code and live production data; implementation sessions must not
re-derive them.

1. **`lookupHotelDetails` sends no `languageCode`** on the Place Details GET
   (`backend/src/services/lookups.js:118-127`), while all three autocomplete calls send
   `languageCode: 'en'` (`lookups.js:31,80,229`). Google's per-place default language is
   inconsistent: the production Shanghai booking stored romanized components
   (`aal1: "Shang Hai Shi"`), the Hangzhou booking stored CJK
   (`locality: "杭州市"`, `sublocality: "拱墅区"`, `aal1: "浙江省"`).
2. **The W2 ladder behaved exactly per spec on that CJK input**: `杭州市` fails rule 1
   (no Hangzhou scope existed; cross-script keys can never fold equal) and promotes
   verbatim via rule 2 (genuine `locality`). Anchors and place identity stayed correctly
   separated (`拱墅区` anchor, WGS-84 coords). The bug is the *evidence language*, not
   the ladder.
3. **`createTrip` seeds every day with `destinations[0]` only**
   (`trips.js:487,514-525`); additional chips are discarded entirely (destinations are
   derived from days). Fallback when no chips: `defaultCity = destinations[0] || title`.
4. **`updateTrip`'s destination edit is rename/removal-only, keyed on raw day seeds**
   (`trips.js:545-588`). Adding a chip rewrites no day and survives only in the echoed
   response (`destinationsOverride`) — gone on next reload. It cannot rename a
   hotel-derived label (no raw seed matches `杭州市`).
5. **The destination picker drops the place ID.** `fetchDestinationAutocomplete` maps
   only `label`/`countryCode` from `placePrediction` (`lookups.js:242-245`); the raw
   prediction carries `placeId`. Chips can only be added by clicking a suggestion —
   `DestinationChipPicker.jsx:7-12` has no free-text path. Informal regions (南疆) and
   counties/AAL3 (南江县) are outside the type whitelist and unreachable in any language.
6. **`useTrip.refresh` has no request sequencing** (`frontend/src/hooks/useTrip.js:23-43`):
   `setDetail(nextDetail)` applies whichever `GET /trips/:id/detail` response resolves
   last. All mutations funnel into it via `onChanged()` (`useStops.js:8-21`,
   `useBookings.js:8-21`); nothing disables add/move affordances in flight
   (`DayPicker.jsx:100`, `StopCard.jsx:225`, `PlanTab.jsx:48` — the latter also swallows
   move errors with `.catch(() => {})`). Backend `getTripDetail` is synchronous
   better-sqlite3 and always complete — the state loss is purely client-side clobbering
   (production DB retained all 19 stops; logs show a user double-POST of one Discovery
   add, the retry symptom).
7. **`resolvePhotoUrl` swallows all failures** (`try { } catch { return null; }`,
   `backend/src/services/stops.js:318-333`, zero logging). Photo queries build from the
   resolved city (`stops.js:50-66,354-361`), so `"Park Hyatt Hangzhou 杭州市 hotel"`
   yielded nothing, silently. Discovery-added stops are unaffected (they carry catalogue
   photo URLs). The Logistics `HotelBookingCard` has no image capability at all — the
   photo surface is the Timeline hotel *stop* card.
8. **Overlapping hotels resolve silently to the earliest check-in.**
   `listBookingsForTrip` orders `COALESCE(start_datetime, ...) ASC` (`trips.js:680`) and
   `deriveDayGeo` takes the FIRST active hotel (`trips.js:295`). A shorter stay booked
   inside a longer one never moves any day, with no signal.
9. **`getOrCreateDestination` is exact-match on `(city_key, country_code)`** with `''`
   as the unknown bucket (`backend/src/db/discoveryCatalogue.js:21-37`). The KL trip's
   `days.city_country` is `NULL` (predates country-coded seeds; migration 021's check
   covered non-null values only), so on 2026-07-09 15:37 a Discovery call recreated the
   `kualalumpur|''` twin (173 places) one day after 021 deleted it.
10. **Production residue to repair:** catalogue row `杭州市|CN` (83 places); recreated
    `kualalumpur|''` twin; KL trip `days.city_country` NULL; Park Hyatt Hangzhou booking
    `details_json` carries CJK structured fields (its stop's `unsplash_photo_url` is
    NULL); trip `d2813bc528519dfaa90c6ae8be5a17b0` day headers Jul 29–Aug 1 resolve
    `杭州市` and its derived summary is `["Shanghai","杭州市"]`. All trips are owner test
    data (standing owner statement, 2026-07-10).
11. **`buildTripScopes` reads day seeds + overrides only** (`trips.js:149-167`), called
    from `listDaysForTrip` (`trips.js:696`), `getDayGeo` (`trips.js:743`),
    `mapData.js:137`, `share.js:99`. Day-header overrides auto-resolve and store
    `city_override_country` (`updateDayCityOverride`, `trips.js:813-840`); the client
    can only send `cityOverride` (`routes/days.js:22-30`); clearing reverts (NULL).
12. **Hotel bookings carry `lat`/`lng` in `details_json`** (all bookings since the
    Places picker existed, including legacy) — containment matching (D3) has its input
    on both current and legacy bookings.
13. **Plan 8 W4 removed session tokens from destination autocomplete** because no
    details call followed. D3 introduces one (bounds fetch on selection), so the
    autocomplete→details session pair becomes completable again.
14. Test baseline at time of writing: **backend 387 / frontend 66, all green.**

---

## 1. Design decisions (owner-approved 2026-07-10 — encode, don't re-open)

- **D1 — Chips are scope vocabulary, never day allocation.** Adding a chip stores a
  scope; removing one shrinks the vocabulary and touches no day; days move only via
  bookings and overrides. The trip's displayed destinations become
  *stored scopes ∪ resolved-day cities* so a two-chip trip reads "Shanghai · Hangzhou"
  from creation.
- **D2 — Scopes are persisted** in a new `trip_scopes` table:
  `{trip_id, label, country_code, kind, place_id, bounds_json, source, position}` where
  `source ∈ {picker, freetext, seed-backfill}`. Backfill existing trips from day seeds +
  overrides ONLY — hotel-derived labels (`杭州市`) must never become stored scopes.
- **D3 — Containment matching ("rule 1.5").** Bounds are captured once at chip
  selection (place ID → viewport). A hotel whose `lat/lng` falls inside a scope's bounds
  promotes to that scope's label — solving cross-script, romanization-variant, and
  suffix matching in one mechanism, and healing the existing Hangzhou trip read-time the
  moment a "Hangzhou" chip is added. Tie-break: rule-1 string match first, then smallest
  containing bounds. Free-text scopes have no bounds and never containment-match.
- **D4 — Creation seeding stays all-days = chip #1.** Even-split rejected (guesses
  wrong; wrong seeds are sticky). The "all Shanghai" oddity is cured by D1's summary
  change plus hotel-driven movement.
- **D5 — Overlapping hotels: latest check-in wins the night** (the newest check-in is
  where the traveler sleeps). Tie on check-in date: latest `created_at` wins.
- **D6 — Discovery empty-country guard.** A request with no country reuses the single
  existing country-coded row for the same city key instead of minting a `''` twin.
  Deliberate free-text keys (北京, 南疆) remain valid rows.

**The three language planes (W2's conceptual frame, from the owner discussion):**
*input* (autocomplete accepts CJK, returns `en` labels — free-text chips cover
non-entity regions), *identity* (place IDs + bounds are the only language-independent
keys; string folding can never relate 杭州市 to "Hangzhou"), *display* (the user's own
words always win — ladder rule 1/1.5 promotes to *their* chip label; overrides win
outright; a trip labeled 南疆 shows 南疆 regardless of evidence script).

---

## 2. Orchestration model

Per global working rules: **Fable/Opus orchestrates; Sonnet implements.**

- Each wave runs via `/implement-milestone`: orchestrator writes precise task prompts,
  delegates to Sonnet subagents (max 2 in flight, never colliding on files), reviews
  every diff, browser-verifies at 375 px personally, updates status lines, commits.
  Never spawn a Fable subagent.
- Sonnet agents receive: the wave's section verbatim, the §0 facts, §1 decisions, and
  the fixture table. Ambiguity returns to the orchestrator, never lands in code.
- Wave order: **W1 and W4 are independent and may run first in any order. W2 → W3 are
  strictly sequential** (W3 consumes W2's stored bounds). **W5 runs after W1** (its
  booking re-fetch and photo backfill need English details) **and after D6's route
  guard ships (also W5) — cleanup before prevention would re-pollute. W6 runs last.**
- One commit per wave minimum; never end a session uncommitted.

---

## Wave 1 — English evidence + photo pipeline honesty

**Goal:** structured place evidence is always English (the matching plane), and photo
failures are visible. Small, backend-only, independently shippable.

### 1.1 `backend/src/services/lookups.js` — details language

Add `languageCode=en` as a query parameter to the Place Details request
(`lookups.js:118-120`; it joins `sessionToken` when present). All structured extraction
(`city`, `locality`, `sublocality`, `adminAreas`) then returns English longText.
`formattedAddress` will also come back English — acceptable; the address is display-only.

### 1.2 Audit sibling Google calls

`placeResolver.js`'s Google Places search and any other direct Places/Geocoding calls:
verify each sends `languageCode: 'en'` (or add it). Sonnet task: enumerate call sites,
report, patch the misses. (Nominatim calls are out of scope — different provider,
`accept-language` handled separately if ever needed.)

### 1.3 `backend/src/services/stops.js` — photo failure logging

`resolvePhotoUrl` (`stops.js:318-333`): on catch, `console.warn('[photo] unsplash lookup
failed', { title, city, error: err?.message })`; on an empty result set, `console.warn(
'[photo] no unsplash result', { query })`. Return value semantics unchanged (null →
gradient fallback). This is the fail-loudly rule, not a behavior change.

**Wave 1 tests:** details lookup passes `languageCode=en` (assert on the fetched URL);
CJK-payload mock still extracts whatever Google returns (the mock returns English —
assert fields land); photo failure paths emit warns (spy) and still return null.

**Delegation:** one backend Sonnet agent (files interlock lightly; small wave).

**Verification (orchestrator):** local run — add a mainland-China hotel via the real
modal; `details_json` structured fields are English; backend log shows photo warn if
Unsplash misses. 375 px pass on the booking modal.

---

## Wave 2 — Persisted trip scopes + honest chip editing

**Goal:** chips become durable scope vocabulary (D1/D2), with place IDs and bounds
captured at selection (feeding W3), free-text chips for non-entity destinations, and an
Edit Trip that does what it says.

### 2.1 Migration `023_trip_scopes.js`

New table `trip_scopes` (`id`, `trip_id` FK CASCADE, `label`, `country_code` nullable,
`kind` nullable, `place_id` nullable, `bounds_json` nullable, `source` NOT NULL,
`position` INTEGER NOT NULL, unique `(trip_id, canonical_key)` where `canonical_key` is
a stored column computed at write time via `canonicalGeoKey(label)`). **Backfill:** for
every existing trip, insert scopes from distinct day seeds + overrides (first-seen day
order, `source: 'seed-backfill'`, no place_id/bounds). Never from resolved/hotel-derived
values (§0 fact 10 — `杭州市` must not be backfilled).

### 2.2 Scope service + derivation input (`trips.js`)

- New `listTripScopes(tripId)` / write helpers in `backend/src/services/trips.js` (DB
  access stays in service per current file's own pattern; do not create a parallel
  module unless the file's size forces it — orchestrator's call at review).
- `buildTripScopes(days)` grows to `buildTripScopes(days, storedScopes = [])`: the
  returned array is stored scopes (position order) ∪ seed/override-derived scopes,
  deduped by `canonicalGeoKey`, stored-scope label winning ties. Stored scopes carry
  `boundsJson` through (W3 consumes it). All four call sites (§0 fact 11) pass the
  stored scopes.
- `createTrip`: write one scope row per submitted chip (position = array index,
  `source: 'picker'` or `'freetext'`, with `placeId`/`bounds` when provided). Day
  seeding unchanged (D4).
- `updateTrip`: replace the positional rename heuristic (`trips.js:557-588`) with scope
  CRUD — added chips insert scope rows; removed chips delete scope rows (days
  untouched); a rename (remove+add in one submit at the same position, same semantics
  the modal produces) relabels the scope row. **Day seeds are never rewritten by chip
  edits** (D1). Delete `destinationsOverride` echo-and-forget behavior *for
  destinations* — the response now reflects stored state truthfully.
- `deriveTripDestinationsFromDays` consumers: trip-level `destinations` /
  `destinationCountries` become *stored scopes (position order) followed by
  resolved-day cities not already present* (deduped by `canonicalGeoKey`), preserving
  the exact legacy response shapes (string[] + `.filter(Boolean)` quirk — untouched,
  same as Plan 8 §5). Applies to `getTripDetail`, `listTripsForUser`, `share.js`.

### 2.3 Bounds capture endpoint (`lookups.js` + route)

- `fetchDestinationAutocomplete` keeps `placeId` in its mapped result
  (`lookups.js:242-245`); `mergeDestinationPredictions` passes it through.
- New `lookupDestinationBounds(placeId, sessionToken)`: Place Details with field mask
  `id,location,viewport` (+ `languageCode=en`), returning
  `{placeId, bounds: {low: {lat,lng}, high: {lat,lng}}}` from `viewport`. Route
  `GET /api/lookups/destination-bounds?placeId=`.
- **Re-introduce session tokens on destination autocomplete** (§0 fact 13): the
  selection's bounds fetch completes the autocomplete→details session pair, earning the
  billing discount Plan 8 W4 correctly declined when no details call existed. Mirror
  the hotel picker's token plumbing.

### 2.4 Frontend picker + modals

- `DestinationChipPicker.jsx` / `CityInput.jsx`: chips store
  `{label, countryCode, kind, placeId}`; on suggestion select, fire the bounds fetch
  (non-blocking — chip is added immediately, bounds attach when the fetch lands; a
  failed bounds fetch leaves bounds null and the chip fully functional minus
  containment).
- **Free-text chips:** pressing Enter with no suggestion selected adds
  `{label: <typed text>, kind: 'freetext'}` — rendered with a `FREETEXT`-style tag in
  the same DM Mono/cream-dim treatment as `REGION` (not gold; accent discipline). This
  is the 南疆 path: deliberate, visible, no country/bounds.
- `NewTripModal.jsx` / `EditTripModal.jsx`: submit chips with
  `placeId`/`bounds`/`kind`; `EditTripModal` reads initial chips from the trip's stored
  scopes (new response field `scopes`, additive) instead of zipping
  `destinations`/`destinationCountries`. When removing a chip that resolved days still
  display, show an inline DM Mono note ("N days still show <label> — days keep their
  identity; edit day headers or bookings to change them") — honest UI, no blocking.

### 2.5 Day response / API contract (additive)

Trip detail and share responses gain `scopes: [{label, countryCode, kind, source}]`
(bounds/place_id stay server-side — no consumer). All legacy fields keep exact shapes.

**Wave 2 tests:** fixtures F2, F3, F4, F11, F12 (§6); scope CRUD unit tests incl.
rename-at-position; `buildTripScopes` merge/dedupe with stored + seed sources; bounds
endpoint mock; picker free-text add + bounds-attach; EditTripModal reads `scopes`.

**Delegation:** two Sonnet agents — backend (2.1–2.3, 2.5) and frontend (2.4).
Coordinate the `scopes` response shape and chip wire shape from this doc, not from each
other's code.

**Verification (orchestrator):** at 375 px — create a two-chip trip: trip card shows
both cities immediately, days seed chip #1; Edit Trip: add Suzhou → survives reload; add
a free-text chip 南疆 → visible tag, persists; remove a chip → days untouched, note
shown; reload after every step (state must come from storage, not echo).

---

## Wave 3 — Containment matching + overlapping-hotel policy

**Goal:** the promotion ladder matches places geographically (D3) and picks the right
hotel on overlapping nights (D5). Backend-only; strictly after W2.

### 3.1 Rule 1.5 in `extractGeoFromBooking` (`trips.js:188-264`)

After rule 1 (string scope match) and before rule 2 (locality): if the booking's
`detailsJson.lat/lng` exist, find scopes whose `boundsJson` contains the point.
If any: promote to that scope's label — when multiple contain it, prefer a rule-1
string-matched scope, else smallest bounds area. Demotion logging and anchor emission
unchanged (the anchor still carries the raw evidence when it differs from the promoted
label — `杭州市`-evidence hotels promoted to "Hangzhou" keep anchor `拱墅区`).
Rules 2/3/4 unchanged for bookings/scopes without geometry.

### 3.2 Latest-check-in-wins (`trips.js:295-300`)

`deriveDayGeo`'s active-hotel selection: among hotels active that night
(check-in ≤ date < check-out), pick the one with the **latest check-in** (tie: latest
`created_at`). Note the semantics change from `.find` on an ASC-ordered list — one
existing fixture may need its expectation updated and documented in place, mirroring
Plan 8 W2's mapData precedent.

### 3.3 Bounds hygiene

`boundsJson` parse failures or degenerate boxes (zero-area) are treated as no-bounds
(rule 1.5 skipped) with a one-time `console.warn` — never a throw (fail loudly, degrade
gracefully).

**Wave 3 tests:** fixtures F5, F6, F7 (§6); regression: all Plan 8 ladder fixtures
(F1–F10 of Plan 8's table) stay green; anchor still emitted alongside a rule-1.5
promotion; no-bounds scope falls through to rule 2 identically to today.

**Delegation:** **one** backend Sonnet agent (ladder + derivation interlock; this is
this plan's riskiest diff — orchestrator reviews line-by-line, as with Plan 8 W2).

**Verification (orchestrator):** seed a local copy of the production Shanghai–Hangzhou
trip; add a "Hangzhou" chip via Edit Trip → Jul 29–Aug 1 headers heal to "Hangzhou" with
zero data edits; add an overlapping shorter Suzhou hotel → its nights move to Suzhou;
remove it → nights revert. 375 px pass on Plan/Today/Map.

---

## Wave 4 — Client state integrity (independent; may ship any time)

**Goal:** the Plan tab never renders a stale snapshot, and in-flight actions can't be
double-fired.

### 4.1 `frontend/src/hooks/useTrip.js` — refresh sequencing

Monotonic request id captured per `refresh()` invocation; apply `setDetail`/
`setActiveDayId` only when the completing request is still the latest. (AbortController
optional on top; the id guard is the correctness fix.) Loading-state semantics for the
first load unchanged.

### 4.2 In-flight affordance guards

- `SuggestionCard.jsx` / `DayPicker.jsx:100`: adding disables that suggestion's Add
  control until its promise settles (per-suggestion pending state — not a global lock;
  adding B while A is in flight stays allowed and is now safe by 4.1).
- `StopCard.jsx:225` move actions: disable the moving stop's controls while its update
  is in flight.
- `PlanTab.jsx:48`: replace `.catch(() => {})` with surfaced feedback (the app's
  existing error affordance; clean message, no stack — fail loudly in dev via
  `console.error`, gracefully in prod).

**Wave 4 tests:** fixture F8 (§6) — unit test the id guard (older response resolving
after newer is dropped); pending-state render tests for SuggestionCard/StopCard; move
failure surfaces feedback.

**Delegation:** one frontend Sonnet agent.

**Verification (orchestrator):** at 375 px with network throttled (dev tools Slow 3G):
rapid-add three Discovery suggestions, return to Plan — all present, no empty days;
rapid-move a stop twice — final state matches the last action after settle; no
duplicate-add temptation (buttons disabled while pending).

---

## Wave 5 — Discovery guard + production data repair

**Goal:** the catalogue can't re-pollute (D6), and Plan-8-era residue is repaired.
Runs after W1 (re-fetch needs English details). Contains this plan's destructive
migration — owner reviews the repair inventory before deploy, same touchpoint pattern
as Plan 8 W6.

### 5.1 D6 guard — `backend/src/routes/discovery.js` + `db/discoveryCatalogue.js`

Before `getOrCreateDestination` with an empty `countryCode`: query for rows with the
same `city_key` and non-empty country. If exactly one exists, use it (log
`[discovery] country-fallback` with the key). If zero or multiple, keep today's exact
`''`-bucket behavior (multiple = genuinely ambiguous; do not guess). Free-text CJK keys
are unaffected (they have no country-coded twin).

### 5.2 Migration `024_geo_data_repair.js`

- Stamp `days.city_country = 'MY'` on the KL trip's NULL-country days — generalized:
  for any day with NULL `city_country` whose seed city canonically matches a catalogue
  row or scope with a single unambiguous country, stamp it; log each.
- Delete the recreated `kualalumpur|''` twin (children explicitly, counts logged —
  021's pattern).
- Delete the `杭州市|CN` destination row + children (regenerates as `hangzhou|CN` on
  demand for pennies once headers heal).
- Idempotent: re-run is a no-op (unit-tested like 021).

### 5.3 Booking evidence re-fetch (script, not migration)

One-off script (like 6.1's inventory pattern): for every hotel booking whose
`details_json` structured fields contain CJK while `placeId` exists, re-call
`lookupHotelDetails` (now English per W1) and rewrite `countryCode`/`locality`/
`sublocality`/`adminAreas`/`city` in place (all other fields untouched). Expected
production hit: the Park Hyatt Hangzhou booking (§0 fact 10); the script logs each
rewrite for owner review before running against production. This makes rule 1.5's
healing *and* the string rules agree on English evidence.

### 5.4 Photo backfill

After 5.3, run the existing `backfillTripPhotos` path (`stops.js:601`) for the affected
trip so the Park Hyatt stop gets its Unsplash photo with the now-clean query. Verify
the warn from 1.3 stays silent.

**Wave 5 tests:** fixture F10 (§6); migration unit tests against a fixture DB seeded
with all three residue shapes + idempotence; re-fetch script dry-run mode asserts
selection (CJK-detection regex `\p{Script=Han}` on the four structured fields).

**Delegation:** one backend Sonnet agent. Orchestrator runs the production deploy with
a **fresh pre-migration backup** (this plan's only destructive-migration deploy) and
executes 5.3/5.4 against production manually after reviewing the dry-run output.

**Verification (orchestrator):** post-deploy read-only checks — catalogue has no
`杭州市` row and no `''` twin with a country-coded sibling; KL days stamped `MY`;
KL Discovery serves the 160-place `MY` catalogue as a cache hit; Park Hyatt booking
fields English; its stop has a photo.

---

## Wave 6 — Production verification pass (runs last)

Re-run the QA session's checks end-to-end on production at 375 px, logged in:

1. Shanghai–Hangzhou trip: after adding a "Hangzhou" chip, day headers Jul 29–Aug 1
   read `Hangzhou` (rule 1.5, zero data edits beyond W5's evidence re-fetch); trip
   summary reads `["Shanghai","Hangzhou"]`; share view matches.
2. Create a fresh two-chip trip: card shows both cities immediately; Edit Trip
   add/remove chips survives reload; free-text 南疆 chip works and Discovery generates
   under its CJK key.
3. Add a mainland-China hotel: `details_json` English; header moves; hotel stop photo
   present; no `[photo]`/unexpected `[geo]` warns.
4. Overlap test: shorter hotel inside a longer stay moves its nights (D5).
5. Rapid Discovery adds + stop moves with no state loss (W4), then browser refresh
   shows identical state.
6. Catalogue spot-check: no new fragment/CJK-accidental/twin keys after the session.
7. Plan 8 regressions: Bali/Kaohsiung headers still healed; demotion warns unchanged
   (count distinct `bookingId`s); Chengdu↔Chongqing movement intact.

Update this plan's status lines and the findings review to CLOSED.

---

## 5. Migration and compatibility

- **Schema changes:** 023 (`trip_scopes` + backfill), 024 (data repair). Days, bookings,
  stops untouched. Never edit existing migrations.
- **Legacy response fields preserved exactly:** trip `destinations`/`destinationCountries`
  keep shapes incl. the `.filter(Boolean)` positional quirk (consumers migrate to the new
  `scopes` field opportunistically; the quirk retires in a future contract version, same
  note as Plan 8 §5). Day fields and `resolutionAnchor` unchanged. `POST /discover`
  request shape unchanged.
- **Ladder compatibility:** rule 1.5 is purely additive between rules 1 and 2; bookings
  or scopes without geometry behave byte-for-byte as today. Legacy bookings (lat/lng but
  CJK or string-only city) heal via rule 1.5 once a bounded chip exists — no data
  rewrite required (5.3 is belt-and-braces, not a prerequisite).
- **`deriveDayGeo` signature:** unchanged (scopes still arrive via the `tripScopes`
  param; entries gain optional `boundsJson`). Migration 014's import stays valid.
- **Deploy sequencing:** standard `/deploy` per wave; pre-migration backup mandatory for
  the W5 deploy. W3 changes production-visible headers on the Hangzhou trip only after
  the owner adds the chip — the healing is opt-in per trip, no surprise flips.

---

## 6. Verification plan

Baseline: backend 387 / frontend 66, all green before each wave.

| # | Fixture | Expected |
|---|---|---|
| F1 | Place Details mock, CN hotel | Request URL carries `languageCode=en`; structured fields stored from response |
| F2 | Create trip, chips [Shanghai, Hangzhou] | Two scope rows (positions 0,1); all days seed Shanghai\|CN; trip `destinations` = ["Shanghai","Hangzhou"] |
| F3 | Edit Trip on F2: add Suzhou chip | Scope row inserted; zero day rows changed; reload-equivalent re-read still lists Suzhou |
| F4 | Edit Trip on F2: remove Hangzhou chip while a day resolves Hangzhou via hotel | Scope row deleted; days untouched; `destinations` still contains Hangzhou (from resolved days) |
| F5 | Scope "Hangzhou" with bounds; hotel `locality: "杭州市"`, lat/lng inside bounds | Header "Hangzhou" (rule 1.5); anchor `拱墅区` kept; without bounds → header `杭州市` (rule 2, today's behavior) |
| F6 | Point inside two scopes' bounds, no string match | Smallest-area bounds wins; with a rule-1 string match on the larger, string match wins |
| F7 | Hotel A check-in Jul 26–Aug 1, hotel B Jul 29–31 (same trip) | Jul 29–30 resolve to B's geo (latest check-in); Jul 31 back to A |
| F8 | `useTrip.refresh`: response R1 issued before R2, resolves after | R1's payload dropped; state reflects R2 |
| F9 | Unsplash mock returns empty / throws | `console.warn` fired; stop photo null; no throw |
| F10 | Discovery request `countryCode: ''` with exactly one `kualalumpur\|MY` row | MY row reused, no `''` row created; with zero or two country rows → `''` bucket as today |
| F11 | Free-text chip 南疆 | Scope `{kind:'freetext'}`, no bounds/country; Discovery keys `南疆\|''`; never containment-matches |
| F12 | 023 backfill on a trip with seeds [Shanghai], override [Melaka], hotel-resolved 杭州市 | Scopes = Shanghai, Melaka (`seed-backfill`); 杭州市 absent |

Plus: full Plan 8 fixture regression (its F1–F10), migration idempotence for 023/024,
and the manual browser pass defined in Wave 6.

---

## 7. Risks and decisions

1. **Google viewport quality** (D3): viewports are approximate boxes; adjacent scopes
   can overlap (smallest-bounds tie-break mitigates), and a viewport can exceed true
   admin limits. Accepted: a wrong containment promotion still names a city the user
   chose as a trip destination — strictly better than a raw fragment or CJK surprise.
   Pinyin homographs (苏州/宿州 "Suzhou") remain a residual string-rule risk exactly
   where bounds are absent.
2. **`trip_scopes` is a second source of destination truth** — the thing Plan 8 §1
   declined. Now justified by three consumers (persistence, rule 1/1.5 targets,
   bounds); the derivation-first read path (`buildTripScopes` merging stored + seeds +
   overrides) keeps day identity itself derived, so no sync problem for headers.
3. **D5 changes behavior on existing overlapping bookings.** Production has none today
   (verified: the two Shanghai–Hangzhou hotels abut at Jul 29). Fixture F7 locks the
   semantics.
4. **Latency of bounds capture**: fetched on selection, non-blocking; a chip without
   bounds (fetch failed, freetext, legacy backfill) simply doesn't containment-match.
   No retry machinery in this plan — re-selecting the chip re-fetches.
5. **Session-token reintroduction** (2.3) must follow Google's pairing rules — the
   token is only sent when the bounds details call will actually complete the session;
   mirror the hotel picker's implementation, don't improvise.
6. **Catalogue deletion of `杭州市|CN`** throws away 83 generated places. Accepted:
   regeneration costs pennies; keeping a CJK-keyed twin of `hangzhou|CN` permanently
   splits the cache (Plan 8 W6's own disposition logic).
7. **Free-text scopes have no country** → their Discovery keys live in the `''` bucket
   by design; D6's guard only redirects when an unambiguous country-coded twin exists,
   so deliberate CJK keys are never hijacked.

---

## Wave status

- W1 English evidence + photo honesty: **COMPLETE** (2026-07-10) — `lookupHotelDetails`
  now sends `languageCode=en` on the Place Details call (joined with `sessionToken` when
  present); audited all other Google Places call sites (`lookups.js` autocomplete ×3,
  `placeResolver.js` Text Search) — already sending `languageCode: 'en'`, no other
  patches needed; `resolvePhotoUrl` now `console.warn`s on Unsplash throw
  (`[photo] unsplash lookup failed`) and empty result (`[photo] no unsplash result`),
  still returns `null` either way. Backend 391/391 green (387 baseline + 4 new fixture
  tests: F1 languageCode assertion + session-token pairing, CJK-payload English
  extraction, photo-warn-on-empty, photo-warn-on-throw). Not yet verified against live
  Google Places/Unsplash (requires a real mainland-China hotel add + API keys) —
  orchestrator/owner should do a live smoke test before Wave 5's re-fetch script
  depends on this.
- W2 persisted scopes + honest chip editing: **NOT STARTED**
- W3 containment matching + overlap policy (after W2): **NOT STARTED**
- W4 client state integrity (independent): **NOT STARTED**
- W5 Discovery guard + data repair (after W1; destructive migration — backup + owner
  inventory review): **NOT STARTED**
- W6 production verification pass (last): **NOT STARTED**
