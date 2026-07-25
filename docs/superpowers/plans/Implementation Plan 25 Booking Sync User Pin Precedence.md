# Implementation Plan 25 — Booking Sync Must Not Overwrite a User Pin

**Status:** 2026-07-26 — **W1 COMPLETE, W2 NOT STARTED.** Investigation complete; owner product decisions D-25-1 and D-25-2 taken (below). The fix is implemented and proven at runtime; test-suite alignment and manual QA remain. **No migration. No new external API calls — this plan removes one.**

> **Repo is intentionally one test red between W1 and W2.** The `:1580` probe asserts the buggy behaviour on purpose and now fails (`expected 'user_confirmed' to be 'resolved'`) — that failure *is* the proof the fix landed. W2 Step 1 rewrites it. Do not "fix" the suite by reverting the change.

**Origin:** [Plan 24 Appendix A](<Implementation Plan 24 Google Maps Deep Link Place Identity.md>#appendix-a--spun-out-d4-booking-sync-overwrites-a-user-confirmed-pin) (spun-out owner decision D4, approved as the next work item 2026-07-26), recorded as **G5** in the [2026-07-25 deep-link identity review](../reviews/2026-07-25-google-maps-deep-link-identity-review.md) §8. Plan 24 is CLOSED and stays closed; nothing here reopens it.

**Defect, one sentence:** re-saving a hotel booking that carries a Google `placeId` silently discards the user's manually corrected map pin on the booking-linked stop and reinstates the Google identity and coordinates.

**Severity: HIGH on trust, LOW on volume.** The loss is silent, unrecoverable without the user noticing and re-pinning, and hits the one gesture in the product that means "I know better than the machine." Production holds exactly **one** at-risk row today (§F-25-6), but the trigger is any booking edit, and the population grows with every hotel booked through Places autocomplete.

---

## Validated facts — established 2026-07-26, do not re-derive

**F-25-1 — The defect is confirmed at runtime, not read from code.** Two probe tests in `backend/tests/locationIntegration.test.js` (`:1580` and `:1639`) ran the discriminating experiment and both of Appendix A's predictions held: a `placeId` booking re-save discarded a `user_confirmed` pin and reinstated `provider_id = google:*`; the same sequence *without* a `placeId` preserved the pin untouched. Appendix A's question 4 ("does it reproduce on a new trip?") is therefore answered **yes** — the probe runs on a trip the harness creates fresh under current code.

**F-25-2 — Mechanism.** `backend/src/services/stops.js`, `resolveLocationForStop` (`:142-316`) evaluates:

| Order | Line | Guard |
|---|---|---|
| 1st | `:159` | `if (trustedCoordinates && !generatedCoordinates) return preserveLocationFields(...)` |
| 2nd | `:165` | `const protectedUserPin = existing?.location_status === 'user_confirmed' && !input.reResolveLocation && !trustedCoordinates` |

`bookingPlaceLocation` (`:881-913`) returns `coordinateSystem: 'wgs84'`, `coordinateSource: 'places'`, `locationStatus: 'resolved'`, `providerId: google:<placeId>` whenever `details_json.placeId` exists. That satisfies `trustedCoordinates` (`:75-78`), so guard 1 returns and **guard 2 is never evaluated**. The `existingStop` UPDATE at `:980-1035` then overwrites `lat`, `lng`, `provider_id`, `resolved_name`, `resolved_address`, `coordinate_source`, `location_status`, and `location_confidence`.

> Line numbers drift by ~7 from those quoted in Plan 24 Appendix A (which cited `:152`/`:158`). The lines above were re-read at `3289b76` and are current.

**F-25-3 — Exactly three call sites, all in `stops.js`.**

| Line | Enclosing function | Passes `existing`? | Guard 2 reachable? |
|---|---|---|---|
| `:437` | `resolveCreateStopData` | no (create path) | no — nothing to protect |
| `:533` | `resolveUpdateStopData` | yes | yes |
| `:940` | `syncStopWithBooking` | yes | **no — guard 1 pre-empts it (the defect)** |

`syncStopWithBooking` has exactly two callers: `backend/src/services/bookings.js:158` (create) and `:202` (update). The channel-agnostic importer reaches it through those. **Every** booking update re-runs the sync, including edits that touch no location field at all.

**F-25-4 — Appendix A's caller claim was partly wrong: the Discovery trusted fast path is a CREATE, not an update.** `DiscoveryPanel.jsx:426-467` (`handleAddToDay`) and `:489-526` (`handleAddPlaceResult`) call `onAddStop`, which is wired to `createStop` at `frontend/src/pages/PlanTab.jsx:26,57,154`. It therefore reaches `resolveCreateStopData` (`:437`) with no `existing`, and **no guard change can affect it**. Appendix A's question 3 shrinks further than the appendix itself claimed: the only non-booking flow a guard change could touch is MapTab's Google "Check location" pick.

**F-25-5 — Candidate (c), a global reorder of guards 1 and 2, is a provable no-op.** `protectedUserPin` already contains `&& !trustedCoordinates` (`:167`), so whenever guard 1 would fire, guard 2 is false regardless of order. Making (c) mean anything requires *also* deleting that clause — and the two edits together would block `MapTab.saveCorrection` (`frontend/src/pages/MapTab.jsx:101-116`, which sends `locationStatus: 'user_confirmed'`, itself "trusted") from ever moving an already-pinned stop again. So (c) is not "simplest with the largest blast radius"; it is *either* inert *or* a hard regression on re-pinning, unless a further "incoming user intent" exemption is bolted on. Deleting `!trustedCoordinates` **alone**, without the reorder, is also a no-op for every shipped caller.

**F-25-6 — Production census (read-only, `trippy-trippy-1`, `/app/data/trippy.db`, 2026-07-26).** 102 stops · 4 `location_status = 'user_confirmed'` · 4 `coordinate_source = 'user_pin'` (the same 4) · 16 booking-linked stops, of which **1** is user-confirmed. 21 bookings (11 hotel, 3 flight, 2 train); 11 carry a `placeId` — **all 11 are hotels**, flights and trains never do. Of those 11 linked stops: 8 `resolved`/`places`/`google:*`, 2 `unresolved`, 1 `user_confirmed`.

The single at-risk row:

| Trip | Stop | Stop coords | Booking `placeId` | `details_json` lat/lng |
|---|---|---|---|---|
| Chengdu - Chongqing | Regent Chongqing (`875d592c…`, `user_pin`) | 29.571138, 106.570398 | `ChIJAQDwhxMzkzYRISqy1Z_sNdc` | **null / null** |

This row is worse than the generic case: with no stored coordinates, `bookingPlaceLocation`'s legacy branch (`:886-899`) will make a **live `lookupHotelDetails` call to Google**, backfill `details_json`, and then overwrite the pin. So the next edit to that booking costs a paid Places call *and* destroys the pin. **Do not edit that booking before this plan ships.**

**F-25-7 — Two hard schema gaps, both fatal to candidate (b).** Neither `bookings` nor `stops` has an `updated_at`, so "how often is a booking re-saved after creation?" is unanswerable. More decisively: there is no record anywhere of which `placeId` a stop was last synced from — a user pin **clears** `provider_id` by design (`preserveLocationFields`, `:126-140`, and Plan 24 F10/D-24-4). Candidate (b) ("pin wins unless the booking's `placeId` changed since last sync") therefore cannot be implemented without new persisted state, i.e. a migration. Production also shows **zero** observed drift: all 8 `places`-sourced linked stops are coincident with their booking's stored coordinates.

**F-25-8 — `reResolveLocation` has no UI.** The escape hatch referenced in guard 2 is set nowhere in the frontend — only in `stops.js:166,186,194` (the logic itself) and `backend/tests/locationIntegration.test.js:330,351`. It is not a recovery path for users and this plan does not make it one.

**F-25-9 — Recovery after the fix already exists and stays intact.** Under "pin always wins", a user who *does* want the booking's Google location back has two working routes, both through `resolveUpdateStopData` (`:533`) and both untouched by this plan: **Check location → pick the Google result** (`MapTab.jsx:144-174`, sends `coordinateSource: 'places'`, `locationStatus: 'resolved'`, `providerId: google:*`), and **Move pin → Set here** (`MapTab.jsx:101-116`). This is what makes D-25-1 safe: the fix removes a silent automatic overwrite, it does not remove the user's ability to move the stop.

**F-25-10 — `repairTripStopLocations` is already correct.** `backend/src/routes/map.js:29-35` → `stops.js:804` bypasses `resolveLocationForStop` entirely and self-excludes user pins with `WHERE s.location_status != 'user_confirmed'` (`:816`). It needs no change, and it is the precedent for keying protection on `location_status` alone (see D-25-3).

**F-25-11 — The co-pilot cannot reach this.** `copilotProposals.js:526` calls `resolveUpdateStopData`, but the apply path hard-restricts fields to `ALLOWED_UPDATE_FIELDS = ['title','type','time','note','duration','estimatedCost','bestTime']` (`:27`, re-enforced per key at `:219`). No coordinate ever arrives. `add_stop` uses the create path (`:519,521`).

---

## Owner decisions

**D-25-1 — Pin always wins.** *(Appendix A question 1, owner 2026-07-26.)* `syncStopWithBooking` must never move a stop whose `location_status` is `user_confirmed`. The overwrite is not desirable even when the booking's Google coordinates are newer: an occasionally-wrong automatic correction that erodes trust is worse than a stop that stays exactly where the user put it, and recovery is a gesture the user already knows (F-25-9). This is the same standard the owner applied to deep-link resolution on 2026-07-26 — precision over polish.

**D-25-2 — Silent.** *(Appendix A question 2, owner 2026-07-26.)* No toast, no banner, no marker. Under D-25-1 nothing is lost and nothing moves, so there is nothing to warn about; a notice on every unrelated booking edit would be noise, and firing UI from a background sync would brush against the repo's no-uninitiated-motion rule. The co-pilot v1 loss-warning precedent applies to *destructive* actions — this fix makes the action non-destructive instead, which is strictly better than warning about it. **Consequence: this plan touches no frontend file and has no 375px surface.** Appendix A's conditional "if a warning is chosen, verify it at 375px with the software keyboard open" is therefore **not triggered**.

**D-25-3 — Protection keys on `location_status === 'user_confirmed'` alone,** not on `coordinate_source === 'user_pin'`. Rationale: that is already the key used by guard 2 (`:165`) and by `repairTripStopLocations` (`:816`), so one predicate means one meaning across the file. In production the two sets are identical (4 rows, F-25-6), but legacy `curated:*` + `user_confirmed` rows exist on older trips and deserve the same protection — a confirmation is a confirmation regardless of which gesture produced it.

**D-25-4 — Protection is scoped to *location* fields only.** A booking re-save must still update the linked stop's `title`, `type`, `time`, `note`, `day_id`, `is_featured`, and photo. Only `lat`, `lng`, `provider_id`, `resolved_name`, `resolved_address`, `coordinate_system`, `coordinate_source`, `location_status`, `location_confidence`, `location_query`, and `country_code` are preserved. Moving a hotel booking to a different date must still move the stop to that day — it must not move the pin.

---

## Recommendation among Appendix A's candidates: **(a) caller-scoped precedence**

| Candidate | Call sites affected | Migration | Verdict |
|---|---|---|---|
| **(a) Caller-scoped precedence** — booking sync alone respects an existing confirmed pin | **1 of 3** (`:940` only). `resolveCreateStopData` and `resolveUpdateStopData` byte-identical. | none | **ADOPT** |
| (b) Identity-aware guard — overwrite only when the booking's `placeId` changed | 1, but adds a persisted "last synced place id" to `stops` | **required** (F-25-7) | Reject — buys a guarantee against a drift failure mode with zero production evidence, at the cost of new schema and a second source of place identity that a pin is supposed to clear. Also inconsistent with D-25-1: if the pin wins, *why* it wins should not depend on Google. |
| (c) Global reorder of guards 1 and 2 | 0 as stated (inert, F-25-5); or 2, breaking re-pinning, if the `!trustedCoordinates` clause is also deleted | none | Reject — the version that compiles does nothing; the version that does something regresses `MapTab.saveCorrection`. |

**Blast radius of (a), argued against F-25-3.** `resolveCreateStopData` never sees `existing`, so it is untouched by construction. `resolveUpdateStopData` is reached by MapTab's manual pin, MapTab's Google pick, StopCard note/title edits, and the co-pilot's field-restricted `update_stop` — none of which change, because the edit lives inside `syncStopWithBooking`, not inside `resolveLocationForStop`. The guard order stays exactly as it is; the guards themselves are not edited. That is the narrowest possible change that fixes the defect, and it is the only candidate whose blast radius is provably one call site.

**Shape of the fix.** In `syncStopWithBooking` (`:922-951`), decide whether the linked stop holds a confirmed location *before* consulting the booking's place identity, and when it does, take the booking's own non-place branch — the one whose input is `{ coordinateSource: 'booking' }` with no coordinates. That input makes `trustedCoordinates` false, so guard 2 fires and preserves the existing location through the code path the `:1639` companion test **already proves works**. The fix reuses the preservation semantics that exist rather than writing a second definition of "a preserved pin", and it also skips `bookingPlaceLocation` entirely, which means the legacy `lookupHotelDetails` backfill (F-25-6) never fires for a pinned stop. Guard 2 returns before `shouldResolve`, so no geocode runs either.

---

## Wave 1 — The fix

**Status: COMPLETE 2026-07-26.** Implemented exactly as specified in Steps 1–3, no deviations. One file changed: `backend/src/services/stops.js`, two hunks, +16/−1.

- **Step 0 baseline measured at `97ee1af`** and matched the plan's predicted figures exactly: backend **703 passed / 32 files**, frontend **271 passed / 42 files**, `npm run build` green (PWA precache 33 entries, 1161.73 KiB). The suite exited 0 with no Windows teardown segfault this run.
- **Step 1** — added non-exported `linkedStopHoldsConfirmedLocation(existingStop)` immediately after `bookingCountryCode`, keyed on `location_status === 'user_confirmed'` alone (D-25-3). Its comment carries the D-25-1 rationale, the explicit "not redundant with guard 2, which is unreachable from this caller" warning, and a pointer back to this plan.
- **Step 2** — gated the place branch by short-circuiting the call itself: `const placeLocation = linkedStopHoldsConfirmedLocation(existingStop) ? null : await bookingPlaceLocation(booking);`. `null` makes the *pre-existing* ternary select the `{ coordinateSource: 'booking' }` branch, so guard 2 fires and every line downstream (`location`, photo resolve, the UPDATE at `:980-1035`) is byte-identical. The cost rationale is in the code comment.
- **Step 3** — verified, no edit needed, as the plan predicted. Guard 2 returns `existing.country_code`, so `resolvedLocation.countryCode || bookingCountryCode(booking)` can only *fill* a null country, never overwrite a good one on a pinned stop.
- **Blast-radius proof:** `git diff` shows hunks at lines 922 and 950 only — **zero** edits between `:142` and `:316`, so guard order and guard conditions are untouched (F-25-5 respected). `git status --short` shows one modified file; no frontend file, no migration (D-25-2).
- **Runtime proof:** post-change backend run is **702 passed / 1 failed (703)**. The single failure is the `:1580` probe at its first inverted assertion — `expected 'user_confirmed' to be 'resolved'` — i.e. it fails *because the pin now survives*. The `:1639` companion stayed green, so the `placeId` and no-`placeId` branches now agree. This is the W1 definition of done, not a regression.

### Step 0 — Baseline
Record pre-change totals: `cd backend; npm test` and `cd frontend; npm test`, plus `npm run build`. Expected green baseline at `3289b76`: backend **703 passed / 32 files**, frontend **271 passed / 42 files**. (Per repo record the backend suite ends in a Windows teardown segfault *after* results print — read the printed totals.) These are W2's gates.

### Step 1 — One named predicate
Add a small non-exported helper in `backend/src/services/stops.js`, adjacent to `bookingPlaceLocation`, expressing D-25-3: a linked stop holds a confirmed location when `existingStop?.location_status === 'user_confirmed'`. Name it for what it protects, not for how it is used. Comment it with the D-25-1 rationale and a pointer to this plan — the next reader must not "simplify" it away as redundant with guard 2, which it is *not*, because guard 2 is unreachable from this caller (F-25-2).

Do **not** add it to `resolveLocationForStop`, do **not** change guard order, and do **not** touch the `!trustedCoordinates` clause. F-25-5 is the reason.

### Step 2 — Gate the place branch in `syncStopWithBooking`
At `:939-951`, skip the `bookingPlaceLocation` call when the predicate holds, and pass the existing non-place input shape (`{ title, locationQuery, coordinateSource: 'booking' }`). Everything downstream — `location`, the photo resolve, the UPDATE at `:980-1035` — stays exactly as written, which is what delivers D-25-4: title, type, time, note, day, featured flag, and photo still sync; the location fields come back untouched from guard 2.

Note in the code comment that skipping `bookingPlaceLocation` is deliberate on the cost side too: it is the only path that can trigger a paid `lookupHotelDetails` call during a booking save, and a pinned stop has no use for its result.

### Step 3 — Verify the country fallback still behaves
`:952-955` layers `bookingCountryCode(booking)` over `resolvedLocation.countryCode`. Guard 2 returns `existing.country_code`, which for a pinned stop is preserved by Plan 24's D-24-4. Confirm the `||` fallback cannot null out or overwrite a good country on a pinned stop; if the booking's country disagrees with the pin's, the **pin's** country wins, because it is the input that selects the tile provider, the maps app, and the coordinate datum (Plan 24 D-24-4). Fix only if this reading proves wrong when tested — do not pre-emptively restructure.

### W1 definition of done
- Predicate and gate implemented; guard order and guard conditions in `resolveLocationForStop` unchanged (`git diff` must show zero edits between `:142` and `:316`).
- No frontend file changed (D-25-2).
- No file under `backend/src/db/migrations/` changed.
- Baseline suites still green apart from the two probe tests, which W2 owns and which are **expected to fail at this point** — the `:1580` probe asserts the buggy behaviour on purpose.

---

## Wave 2 — Verification

**Status: NOT STARTED.**

### Step 1 — Update the two existing probe tests
Per Plan 24 Appendix A's cross-reference, these assert current (buggy) behaviour deliberately and **must be updated when behaviour changes**.

- `backend/tests/locationIntegration.test.js:1580` — *"G5/Appendix-A probe — a placeId booking re-save overwrites a user-confirmed pin (documents current behavior, not a fix)"*. **Rewrite, do not delete.** It becomes the primary regression test: rename to state the fixed behaviour, invert `:1623-1626` to assert `location_status === 'user_confirmed'`, `provider_id === null`, and the pin's coordinates (29.6 / 106.6). **Keep `:1628-1636` verbatim** — the consistency-pair assertion (never a Google id sitting on a pin's coordinates) is the invariant that must hold whichever way D4 resolved, and it will now settle on `isPinPair`. Update the comment block at `:1574-1579` to cite this plan instead of "documents current behavior".
- `backend/tests/locationIntegration.test.js:1639` — *"G5 companion prediction — a booking with no placeId … preserves the pin"*. **Unchanged and must stay green.** It now proves the two branches agree rather than diverge; adjust only the comment that frames it as a prediction.

### Step 2 — New tests proving the paths that *should* still move a stop are unaffected
Appendix A requires this companion coverage explicitly. All in `backend/tests/locationIntegration.test.js`:

1. **Normal booking sync still works.** A `placeId` booking whose linked stop is *not* `user_confirmed` re-saves to the booking's Google coordinates and `google:*` identity, exactly as today. This is the test that catches an over-broad predicate.
2. **The Google pick still moves a pinned stop.** Drive `updateStop` with `MapTab.handlePickResult`'s exact payload (`:152-163`) against a `user_confirmed` stop and assert it moves and takes the Google identity. F-25-9's recovery path, pinned by a test.
3. **A re-pin still moves a pinned stop.** Drive `MapTab.saveCorrection`'s exact payload (`:104-111`) against an already-`user_confirmed` stop and assert the new coordinates land. This is the assertion that would have caught candidate (c)'s regression.
4. **No paid lookup for a pinned stop.** Spy on `lookupHotelDetails`; re-save a *legacy* `placeId` booking (a `details_json` with `placeId` but no `lat`/`lng`, the F-25-6 Regent Chongqing shape) whose linked stop is pinned, and assert the spy was **not** called and the pin survives. Covers the one real production row and the cost claim together.
5. **D-25-4 scope.** On a pinned linked stop, a booking re-save that changes the title and the date still updates the stop's `title` and `day_id` while leaving every location column byte-identical.
6. **D-25-3 key.** A `user_confirmed` stop whose `coordinate_source` is *not* `user_pin` (the legacy `curated:*` shape) is protected too.

### Step 3 — Gates
`cd backend; npm test` and `cd frontend; npm test` at or above the W1 Step 0 baseline (backend gains ~6 tests, frontend unchanged), and `npm run build` green. Frontend counts must be **identical** to baseline — a changed frontend count means D-25-2 was violated.

### Step 4 — Manual QA on a trip created under current code
Per Appendix A, and per the standing rule that older trips predate un-backfilled implementations. Run locally (frontend `:5174`, backend `:3002` via `launch.json`) against a **freshly created** trip, not a legacy one:

1. Create a hotel booking through Google Places autocomplete. Confirm in the DB that the linked stop has `provider_id = google:*` and `location_status = 'resolved'`.
2. Map tab → the hotel stop → **Move pin** → pan away → **Set here**. Confirm `location_status = 'user_confirmed'`, `coordinate_source = 'user_pin'`, `provider_id` NULL.
3. Edit the booking's confirmation reference and save. **Re-read the stop: coordinates, `provider_id`, and `location_status` must be unchanged.** Confirm the title/time still reflect the booking.
4. Change the booking's date to another day in the trip and save. The stop must move to the new day **and keep its pin**.
5. **Check location** → search → pick a Google result. The stop must move and take `provider_id = google:*` — recovery still works (F-25-9).
6. **Move pin → Set here** again on that stop. It must move — re-pinning is not blocked.

Verify at 375px because that is the repo default for exercising the Map tab, not because this plan adds a surface — there is none (D-25-2). Known constraint: the in-app Browser pane runs the tab as `document.hidden`, so modal/animation surfaces freeze; the Chrome extension against an already-logged-in `localhost:5174` tab is the working route for Trippy browser QA. Delete any QA trip and minted session afterwards.

### W2 definition of done
- Both probe tests updated and green; six new tests green; gates at or above baseline; frontend count unchanged.
- Manual matrix above passed on a current-code trip, with the DB reads recorded in this plan's status block.
- Production proof recorded but **not performed by the agent**: after deploy, the owner edits the Regent Chongqing booking (F-25-6) and confirms the pin holds. That row is the real-world instance of the defect and is the cleanest possible production check.

---

## Deploy profile

Standalone, backend-only, no migration, no frontend bundle change, and one *fewer* possible Google Places call. Pre-deploy backup into the chee-owned `~/Trippy/backups/` via `sqlite3 .backup` (prod `~/Trippy/data` is root-owned with no passwordless sudo). Post-deploy: `/api/health`, clean startup logs, then the owner's Regent Chongqing check above.

---

## Explicitly out of scope

- **Any change to guard order or guard conditions in `resolveLocationForStop`** — F-25-5.
- **A `reResolveLocation` UI control** — F-25-8. There is no product request for one, and F-25-9 already provides recovery.
- **Persisting a last-synced place identity** — rejected as candidate (b), D-25-1 rationale plus F-25-7.
- **The two `unresolved` placeId bookings** found in the census (F-25-6) — a separate data-quality question, not this defect.
- **Discovery catalogue quality** — [2026-07-26 review](../reviews/2026-07-26-discovery-catalogue-quality-review.md), findings-only, five owner decisions still open.
- **Coincident map markers stacking invisibly** — Plan 24 Appendix B, low severity.
- **Deep-link naming and resolver ordering** — closed by owner decision 2026-07-26.
