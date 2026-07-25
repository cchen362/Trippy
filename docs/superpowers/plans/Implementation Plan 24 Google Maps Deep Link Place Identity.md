# Implementation Plan 24 — Google Maps Deep-Link Place Identity and Link-Coordinate Correctness

**Status:** OPEN 2026-07-25 — **not started.** W1 → W2 → W3, single deploy. No migration. No new external API calls.

**Review basis:** [2026-07-25 Google Maps deep-link identity review](../reviews/2026-07-25-google-maps-deep-link-identity-review.md) (committed `a917215`). That document's verified facts, scenario table, data invariant, and legacy-vs-live segmentation are **inputs to this plan — do not re-derive them.**

**Owner decisions, resolved 2026-07-25 (review §11):** D1 one plan / three waves / single deploy · D2 `country_code` forwarding folded into W1 · D3 no identity-upgrade backfill, expectation accepted · D4 booking-sync-overwrites-user-pin **split out** → see [Appendix A](#appendix-a--spun-out-d4-booking-sync-overwrites-a-user-confirmed-pin).

**Schema impact: NONE.** Every field this plan needs is already persisted on `stops`. Both new payload fields are derived read-only output. If something here appears to need persistence, that is a new decision, not an assumption.

**Provider-cost impact: NONE.** No Places, Nominatim, Amap, or Unsplash calls are added. Google's advice to refresh place IDs older than 12 months is acknowledged and deliberately **not** adopted (review §3, G1).

---

## Origin

The reported symptom was narrow: opening a stop in Google Maps shows raw coordinates instead of the place name. Investigation found the symptom is real and is **one of three** defects sharing the same three lines of code:

1. **Naming (RC-1)** — `query_place_id` is never sent, so Google always renders a dropped pin even when the stop has a stored Google place ID.
2. **Link coordinates (RC-2)** — the link is built from **display** coordinates, which are converted for the *tile* provider, while the *link* provider is chosen separately. The two can disagree, sending GCJ-02 coordinates to Google or Naver.
3. **Provider parity (RC-3)** — Today picks the maps app from the **day's** country; Maps picks it from the **stop's** country. The same stop can open two different apps from two tabs.

RC-2 and RC-3 are live bugs today, independent of place IDs. RC-1 cannot be fixed without touching the same code path, which is why they ship together.

---

## Validated facts — do not re-derive

**F1 — One link builder, two callers.** `frontend/src/utils/deepLink.js:3` `buildDeepLink(provider, lat, lng, label)` is the only link constructor. Callers: `components/map/OpenInMapsButton.jsx:4` (from `StopMarker.jsx:76`) and `components/today/NavigateIcon.jsx:17` (from `HeroCard`, `TonightCard`, `UpcomingRow`). A duplicate exists at `backend/src/services/mapConfig.js:74` with **zero callers** — dead code, see W2 step 5.

**F2 — `deepLink.js` has no test file.** `frontend/src/utils/deepLink.test.js` does not exist. There is no test anywhere asserting the shape of a produced URL.

**F3 — Map markers must keep tile-datum coordinates.** `StopMarker.jsx:48-49` uses `displayLat/displayLng` for `<Marker position>`. That is correct for rendering and must not change. Only the *link* coordinates are wrong. The fix therefore **adds** a link coordinate pair; it does not repoint the existing one.

**F4 — The backend converts both directions; the frontend twin converts only one.** `backend/src/services/coordinates.js:104-108` handles `wgs84→gcj02` *and* `gcj02→wgs84`. `frontend/src/utils/coordinates.js:69-73` handles only `wgs84→gcj02`, despite a header comment claiming an exact mirror. Consumers of the frontend twin: `NavigateIcon.jsx:3` and `TripRouteCover.jsx:2` (which imports `wgs84ToGcj02` only, so it is unaffected by adding the inverse).

**F5 — `toDisplayCoordinates` returns nulls for untrustworthy provenance.** Backend `coordinates.js:93-101`: `coordinate_system === 'unknown'` and not estimated → `displayLat/displayLng` null and `canRenderMarker: false`. This is desirable for links too (it is what keeps legacy unknown-datum rows link-free) and must be preserved by the new link-coordinate path.

**F6 — Payload asymmetry, per surface.**
- `backend/src/services/mapData.js:94-118` `formatMapStop` omits `providerId`, `coordinateSource`, `coordinateSystem`, and `countryCode`. It does emit `deepLinkProvider` (computed at `:236-237`).
- `backend/src/services/trips.js:47-77` `mapStop` emits `providerId`, `coordinateSource`, `coordinateSystem`, `locationStatus` — but **omits `countryCode`**.

**F7 — The Option C precedence lives at one line.** `mapData.js:236`: `stop.country_code || geoByDayId.get(stop.day_id)?.countryCode || null`, then `getMapConfigForCountry(linkCountry).deepLinkProvider`. Today has no equivalent; it uses `mapConfigByDay[dayId].deepLinkProvider` (`TodayTab.jsx:29,51-74`).

**F8 — Today links to Google during the map-data load window.** `TodayTab.jsx:15` calls `useMapData(trip?.id)` **with no refresh key**. While loading, `mapConfig` is `null`, so `todayMapConfig` is `undefined`, so `deepLinkProvider` is `undefined`, so `buildDeepLink` takes its `default:` branch and emits a **Google** URL with unconverted coordinates — for a China stop, the wrong app *and* the wrong datum. Pre-existing, previously unrecorded, fixed as part of W1 step 6.

**F9 — `useMapData` in Today is intentionally unkeyed and that is fine for config, not for coordinates.** Because it never refetches, any *coordinate* taken from that payload would go stale the moment a pin is corrected on the Map tab. This is the reason W1 derives Today's link coordinates client-side from live trip context rather than joining against `/map-data` stops. `mapConfigByDay` (day geography) is stable enough to keep reading from it, which is already today's behavior.

**F10 — The manual pin already clears provider identity.** `MapTab.saveCorrection` (`MapTab.jsx:101-111`) omits `providerId`; `preserveLocationFields` (`stops.js:119-133`) resolves `providerId: input.providerId ?? null`; `writeUpdateStop` writes `provider_id = ?` unconditionally (`stops.js:603,634`). Verified in data: all 7 `user_pin` rows have `provider_id` NULL. **No stale-ID-after-pin defect exists.** The same function also nulls `resolved_name`, `resolved_address`, and `country_code` — only the last of those is a defect (see D-24-4).

**F11 — The OSM resolver emits an unprefixed identifier.** `placeResolver.js:451` produces `way:<id>` / `node:<id>`, **not** `osm:way:<id>`. Any denylist keyed on an `osm:` prefix would miss every real OSM row. Hence the positive `google:` allowlist.

**F12 — Discovery's trusted path labels non-Google identities as `places`.** `DiscoveryPanel.jsx:454` sends `providerId: suggestion.placeRef` alongside a hard-coded `coordinateSource: 'places'`, and `placeRef` may be `google:*`, `way:*`, `node:*`, or `curated:*` (`routes/discovery.js:47`). Gating identity on `coordinate_source` alone would send non-Google IDs to Google.

**F13 — Google's URL contract** (review §3, fetched from official docs 2026-07-25): `api=1` required; `query` **required for all search requests**; `query_place_id` optional; "If you specify both parameters, the query is only used if Google Maps cannot find the place ID." A resolvable-but-relocated ID therefore **moves the destination** — the fallback only protects against `NOT_FOUND`.

**F14 — Era boundary** (review §7b): `placeResolver.js` and `mapData.js` both landed 2026-04-28; the two April trips predate them entirely. Current-code stops: 7 of 14 (50%) qualify for a named Google card; legacy: 0 of 39. All 11 unknown-datum stops are legacy with none created since. **No backfill is proposed** — legacy rows correctly fail the invariant and degrade to coordinate-only.

---

## Locked design decisions

**D-24-1 — Link coordinates follow the *link* provider, not the tile provider.** The datum mapping is `amap → gcj02`, `google → wgs84`, `naver → wgs84`, owned by one exported function. This single change fixes the HK/MO/TW-on-a-mainland-day and KR-on-a-mainland-day cases together, and is the root-cause fix rather than a per-provider patch.

**D-24-2 — The link coordinate pair is additive; `displayLat/displayLng` are untouched** (F3). No caller may fall back from link coordinates to display coordinates — that fallback *is* the bug. When link coordinates are null, no link renders.

**D-24-3 — The place-ID invariant lives in exactly one backend helper.** The frontend receives a pre-decided nullable `googlePlaceId` and never re-derives the rule. Invariant (review §4), all five clauses required:
1. `provider_id` starts with `google:` with a non-empty suffix (positive allowlist — F11, F12);
2. `location_status === 'resolved'`;
3. `coordinate_source === 'places'`;
4. `coordinate_system === 'wgs84'`;
5. `lat` and `lng` both finite.

**D-24-4 — G4 is scoped to `country_code` only.** A manual pin *should* clear `provider_id`, `resolved_name`, and `resolved_address` — the stop is no longer an attested named place, and that clearing is what makes D-24-3 safe (F10). It should **not** clear `country_code`, which is not an identity claim but the input that selects the map tiles, the maps app, and the coordinate datum. Losing it is a functional regression. W1 preserves country across a pin and stamps it on Google picks; it changes nothing else about pin clearing.

**D-24-5 — `query` always carries the exact coordinates; a name is never substituted.** Per F13, `query` is mandatory and is the safety net. Sending `resolved_name` as `query` would reintroduce fuzzy search and could move the destination.

**D-24-6 — Provider precedence is duplicated deliberately, and asserted equal by test.** Today cannot reuse the backend's `getMapConfigForCountry` and must not take coordinates from `/map-data` (F9). So one small frontend helper mirrors F7's precedence, and W3 includes a parity test asserting both surfaces agree for the same stop. This is the Plan 21 pattern: accept a mirror, make the mirror provable.

**D-24-7 — No link renders until the provider is known.** Fixing F8 by rendering nothing (rather than defaulting to Google) matches how `NavigateIcon` already behaves for a stop without coordinates, and avoids a wrong-app link in the load window. An icon appearing after data load is existing behavior, not new motion.

---

## Wave 1 — Link geometry, provider parity, and country preservation

**Status: NOT STARTED.** Pure correctness. No payload field is added for identity in this wave; RC-1 is W2.

### Step 0 — Baseline and one safety check (before any edit)
- Record pre-change test counts: `cd backend; npm test` and `cd frontend; npm test`, plus `npm run build`. These are the W3 gates. (Per repo record the backend suite ends in a Windows teardown segfault *after* results print — read the printed totals.)
- **Grep for any code that depends on `country_code` being cleared by a pin** before implementing D-24-4. If a consumer relies on the NULL, that is a product question, not a silent override.

### Step 1 — Own the link datum (backend)
`backend/src/services/mapConfig.js`: export `linkCoordinateSystemForProvider(provider)` → `'gcj02'` for `amap`, `'wgs84'` otherwise. One owner for D-24-1; no caller may inline the mapping.

### Step 2 — Emit link coordinates from the map payload (backend)
`backend/src/services/mapData.js`:
- `formatMapStop` gains `linkLat` / `linkLng`, computed by calling the existing `toDisplayCoordinates(row, { coordinateSystem: linkCoordinateSystemForProvider(deepLinkProvider) })`. Reuse the existing helper — do not write a second conversion path.
- `displayLat/displayLng/canRenderMarker` keep their current tile-datum computation, unchanged (D-24-2, F3).
- F5's null-on-untrustworthy-provenance behavior must hold for the link pair too.

### Step 3 — Expose the stop's country to Today (backend)
`backend/src/services/trips.js` `mapStop`: add `countryCode: row.country_code` (F6). The column already exists on the row; `stops.js formatStop:37` already emits it, so this closes an inconsistency between two mappers of the same table.

### Step 4 — Complete the frontend coordinate twin
`frontend/src/utils/coordinates.js`: add the `gcj02 → wgs84` branch mirroring `backend/src/services/coordinates.js:106-108`, and correct the header comment that currently claims an exact mirror (F4). `TripRouteCover` imports only `wgs84ToGcj02` and is unaffected — verify, don't assume.

### Step 5 — One frontend owner for "how do I open this stop externally"
New `frontend/src/utils/deepLinkTarget.js`, exporting a single `resolveDeepLinkTarget(stop, dayMapConfig)` → `{ provider, lat, lng }` or `null`:
- provider = stop's own country first (`CN → amap`, `KR → naver`, any other non-empty code → `google`), else `dayMapConfig?.deepLinkProvider`, else **null** (D-24-7). This mirrors F7 exactly and is the subject of the D-24-6 parity test.
- coordinates = `toDisplayCoordinates(stop, { coordinateSystem: linkCoordinateSystemForProvider(provider) })`, i.e. the same datum rule as the backend, applied to live trip-context data (F9).
- returns `null` when the provider is unknown or either coordinate is non-finite.

### Step 6 — Repoint the two link call sites
- `components/map/StopMarker.jsx`: pass `stop.linkLat` / `stop.linkLng` to `OpenInMapsButton`, render the button only when both are finite. **No fallback to `displayLat/displayLng`** (D-24-2).
- `components/today/NavigateIcon.jsx`: replace the direct `toDisplayCoordinates` call with `resolveDeepLinkTarget`, and return `null` when it returns `null` — this is the F8 fix. Also resolves F4's shape trap (the component currently destructures `{ lat, lng }`, which only works because the twin's return shape differs from the backend's).
- `pages/TodayTab.jsx`: keep passing `todayMapConfig` (needed as the day-level fallback) but stop treating its `deepLinkProvider` as the answer.

### Step 7 — D-24-4: preserve country, stamp it on picks
- `backend/src/services/stops.js`: `preserveLocationFields` resolves `countryCode` as `input.countryCode ?? existing?.country_code ?? null` (the function must receive `existing`; it is already in scope at the `trustedCoordinates` return, `stops.js:152`). `provider_id`, `resolved_name`, `resolved_address` clearing is unchanged.
- `frontend/src/pages/MapTab.jsx` `handlePickResult` and `frontend/src/components/timeline/AddPlaceModal.jsx`: forward the `countryCode` that `lookupHotelDetails` already returns (`lookups.js:164`) in the stop payload. No new lookup call.

### W1 definition of done
1. For every stop, the coordinates handed to a maps app are in that app's datum, proven by the integration tests in W3 — including the HK-on-a-mainland-day and KR-on-a-mainland-day cases, which are structurally reachable though absent from current data (review §7b, RC-2b).
2. Maps and Today choose the same app and the same coordinates for the same stop (D-24-6 parity test).
3. No link is emitted with an unknown provider (F8).
4. A manual pin no longer discards `country_code`; a Google pick stamps it.
5. Marker rendering is byte-identical in behavior — `displayLat/displayLng` untouched.

---

## Wave 2 — Google place identity

**Status: NOT STARTED.** Additive payload. Depends on W1 only for coherence: `googlePlaceId` is emitted solely for stops whose stored datum is `wgs84` (invariant clause 4), which is exactly the datum W1 sends to Google.

### Step 1 — The invariant, in one place
New `backend/src/utils/googlePlaceIdentity.js`: `googlePlaceIdForStop(row)` → the bare place ID (prefix stripped) when all five D-24-3 clauses hold, else `null`. Pure function over a `stops` row, no DB access, no I/O. Placed in `utils/` per the repo's file conventions (pure shared helper, not business orchestration).

### Step 2 — Expose it from both mappers
- `backend/src/services/mapData.js` `formatMapStop`: `googlePlaceId`.
- `backend/src/services/trips.js` `mapStop`: `googlePlaceId`.
Both call the same helper. Neither reimplements a clause.

### Step 3 — Confirm the share payload stays clean
`backend/src/services/share.js` builds its own reduced payload and currently emits `lat` only, with no `providerId`; the public route renders neither `OpenInMapsButton` nor `NavigateIcon` (review G7). Verify by reading the file and by a test asserting the share response contains no `googlePlaceId` and no `providerId`.

### Step 4 — Extend the link builder
`frontend/src/utils/deepLink.js`: `buildDeepLink(provider, lat, lng, label, googlePlaceId)`. Append `&query_place_id=<encoded>` **only** when `provider === 'google'` and the ID is a non-empty string. `query=<lat>,<lng>` is always present (D-24-5, F13). Amap and Naver URLs are unchanged, byte-for-byte.

### Step 5 — Pass it through, and delete the dead twin
- `StopMarker.jsx` → `OpenInMapsButton` → `buildDeepLink`, and `NavigateIcon.jsx`, forward `stop.googlePlaceId`.
- Delete the zero-caller duplicate `buildDeepLink` at `backend/src/services/mapConfig.js:74-83` (F1). Leaving a second, now-divergent implementation of the same URL contract is exactly the tech debt the repo rules forbid. Confirm zero callers at implementation time before deleting.

### W2 definition of done
1. A stop satisfying all five clauses opens Google showing **Google's own place name and details**, at the correct location.
2. Every other stop — OSM, curated, manual pin, estimated, legacy, unknown-datum, unresolved — opens a coordinate-only link at its exact stored position, with no name and no ID.
3. Amap and Naver URLs are unchanged.
4. The invariant exists in exactly one place; the frontend contains no clause logic.
5. Nothing new appears in the public share payload.

---

## Wave 3 — Verification

**Status: NOT STARTED.** Full matrix in review §10; it is normative, not a summary. Highlights and gates:

### Automated
- **New** `frontend/src/utils/deepLink.test.js` (F2 — first coverage this helper has ever had): google+ID URL shape and parameter order; google+null ID byte-identical to today's URL (no-regression anchor); amap and naver ignore a supplied ID; unsafe characters encoded; coordinate precision not rounded.
- **Frontend** coordinate tests: the new `gcj02→wgs84` inverse; no double-conversion when stored and target systems match; backend-agreement on a known Chongqing coordinate.
- **Frontend** `deepLinkTarget` tests: provider precedence (stop country wins, day fallback, null when neither), and null when coordinates are non-finite.
- **Backend** invariant tests: one case per row 1–15 of review §5, including row 6 (`coordinate_source === 'places'` + `way:123` → null) and row 10 (`estimated` + `google:*` → null).
- **Backend** integration in `backend/tests/locationIntegration.test.js`: HK stop on a CN-derived day → `google` + WGS-84; KR stop on a CN day → `naver` + WGS-84; CN stop on a JP day → `amap` + GCJ-02 + null ID; **Maps-vs-Today parity** (identical provider, coordinates, and `googlePlaceId` from `/map-data` and `GET /trips/:id/days`); stale-ID-after-manual-pin (ID present → pan and save → `provider_id` NULL and `googlePlaceId` null); country preserved across a pin (D-24-4); the Appendix-A probe documenting current booking-sync behavior.
- **Gates:** `cd backend; npm test` and `cd frontend; npm test` both green at or above the W1 step 0 baseline, and `cd frontend; npm run build` green.

### Manual — era-split, 375px first then desktop, every case in **both** Maps and Today
Per review §10 the matrix is deliberately split, and **passing one half proves nothing**:
- **Legacy half** (`Chengdu - Chongqing`, created 2026-04-24, predates the resolver): unknown-datum stops, the two `curated:*` rows carrying `user_confirmed`+`gcj02`, legacy OSM stops, legacy `user_pin` `gcj02` stops → all must stay precise, unnamed, and unmoved from today's positions.
- **Current-code half** (a July trip): Google-picked place, Discovery-via-Google, Discovery-via-OSM, hotel booking with `placeId`, a newly panned pin, and a newly pinned stop on a CN day viewed from Today (the RC-2 regression check, reproducible today).
- Per house convention the agent verifies locally and the **owner runs the production pass**; a green build is not completion when behavior is involved.

---

## Explicitly out of scope

- **D4 / G5** — booking sync overwriting a `user_confirmed` pin. Spun out, [Appendix A](#appendix-a--spun-out-d4-booking-sync-overwrites-a-user-confirmed-pin).
- **G6** — Today linking unknown-datum coordinates that Maps refuses to render. Confirmed **legacy-data-only** (all 11 rows are April, none created since 2026-04-28). Must not regress; the legacy QA half covers it.
- **Any identity backfill** (D3). Legacy stops correctly degrade to coordinate-only.
- **Any Places refresh call** for stale IDs (G1, F13).
- **RC-4 repair.** Zero rows in either era; the invariant's `resolved` clause is prevention, and no data fix is warranted.
- Migrations, model changes, and any change to marker rendering.

---

## Appendix A — Spun-out D4: booking sync overwrites a `user_confirmed` pin

**Status:** NOT INVESTIGATED. Deliberately excluded from Plan 24 (owner decision D4, 2026-07-25) because it changes **write precedence** rather than read/display, is orthogonal to deep links, and needs its own QA pass. This appendix is written to be actionable by a fresh orchestrator with no access to the Plan 24 session.

### Symptom to confirm
Re-saving a hotel booking that was created through Google Places autocomplete **silently discards a user's manually corrected pin** on the booking-linked stop, and reinstates a Google identity on that stop.

### Mechanism (read from code, not yet reproduced at runtime)

`backend/src/services/stops.js`, `resolveLocationForStop` (lines 135-309) evaluates guards in this order:

| Order | Line | Guard |
|---|---|---|
| 1st | `:152` | `if (trustedCoordinates && !generatedCoordinates) return preserveLocationFields(...)` |
| 2nd | `:158` | `const protectedUserPin = existing?.location_status === 'user_confirmed' && !input.reResolveLocation && !trustedCoordinates` |

`trustedCoordinates` is defined at `:149` via `hasTrustedCoordinateMetadata` (`:75-78`): finite coordinates **and** `coordinateSystem ∈ {wgs84, gcj02}` **and** `locationStatus ∈ {resolved, estimated, user_confirmed}`.

`syncStopWithBooking` (`:915-948`) builds its input from `bookingPlaceLocation` (`:874-906`), which — whenever `details.placeId` exists — returns `coordinateSystem: 'wgs84'`, `locationStatus: 'resolved'`, `providerId: google:<placeId>`. That satisfies `trustedCoordinates`, so guard 1 fires and **guard 2 is never evaluated**. The `existingStop` UPDATE at `:973-1028` then overwrites `lat`, `lng`, `provider_id`, `resolved_name`, `resolved_address`, `coordinate_source`, `location_status`, and `location_confidence` with the booking's Google values.

**Sharp, checkable prediction** — use this to confirm the mechanism rather than trusting the reading: a booking **without** a `placeId` takes the other branch (`:938-942`, `{ coordinateSource: 'booking' }`, no coordinates), so `trustedCoordinates` is false, guard 2 fires, and the pin **is** preserved. If the pin survives a non-`placeId` booking re-save but is lost on a `placeId` booking re-save, the mechanism is confirmed.

### Reproduction steps
1. Create a hotel booking via Google Places autocomplete (so `details_json` carries `placeId`, and the linked stop syncs with `provider_id = google:*`).
2. Map tab → the hotel stop's popup → **Move pin / Check location** → pan away → **Set here**. Confirm in the DB: `location_status = 'user_confirmed'`, `coordinate_source = 'user_pin'`, `provider_id` NULL.
3. Edit *any* field on that booking (a confirmation reference is enough) and save, triggering `syncStopWithBooking`.
4. Re-read the stop. Expected-under-the-bug: coordinates back at the Google location, `provider_id` back to `google:*`, `location_status` back to `resolved`, and no warning shown to the user.
5. Repeat with a manually entered booking (no `placeId`) and confirm the pin survives — the prediction above.

### Read-only data inspection technique
`better-sqlite3` resolves only under `backend/`, so put a throwaway ESM script there and delete it after:

```bash
node backend/.probe.mjs
```

Open `backend/data/trippy.db` with `new Database(path, { readonly: true })`. Useful starting queries: booking-linked stops whose `location_status = 'user_confirmed'`; hotel bookings whose `details_json` contains `placeId`; and the join between them. In production the same shape works via `docker exec -w /app/backend trippy-trippy-1 node -e`; note that production `~/Trippy/data` is root-owned with no passwordless sudo, so take backups into the chee-owned `~/Trippy/backups/` with `sqlite3 .backup` rather than editing in place.

### Questions the investigation must answer before any fix
1. **Is the overwrite ever *desirable*?** If an OTA corrects a hotel's address, the booking's new Google coordinates may be better than a months-old pin. The answer determines whether the fix is "pin always wins" or "pin wins unless the booking's place identity changed."
2. **Does the pin lose silently, or should the user be told?** The co-pilot v1 precedent (owner-approved) was a **loss warning instead of undo**. The same reasoning may apply.
3. **What else depends on guard 1 preceding guard 2?** This is the key risk. The Discovery trusted fast path (`DiscoveryPanel.jsx:434-465`) and the Map "Check location" Google pick (`MapTab.jsx:153-163`) both send trusted coordinates through the same function. A **global** reorder would mean a user-confirmed stop could no longer be repositioned by picking a Google result — plausibly a regression, plausibly correct. Enumerate every caller of `resolveLocationForStop` and classify which ones *should* beat a user pin before touching the order.
4. **Does it reproduce on a new trip?** The mechanism is code shape, not data, so it should — but confirm on a trip created under current code, per the standing rule that older trips predate un-backfilled implementations and must not be mistaken for live bugs.

### Candidate approaches (do not pre-decide)
- **(a) Caller-scoped precedence.** Make the booking-sync path alone respect an existing `user_confirmed` pin — narrowest blast radius, leaves Discovery and manual Google picks untouched.
- **(b) Identity-aware guard.** Let `bookingPlaceLocation` decline to claim `resolved` when the linked stop already holds a user pin *and* the booking's `placeId` is unchanged since the last sync — targets "the booking didn't actually move" without blocking genuine corrections.
- **(c) Global reorder** of guards 1 and 2. Simplest to read, largest blast radius; only viable after question 3 is answered.

### Verification the fix will require
- A backend integration test per the reproduction steps, asserting the pin and `provider_id` survive a booking re-save, **plus** a companion test proving the paths that *should* still move a stop (Discovery trusted add, Google pick in Check location) are unaffected.
- Manual QA on a trip created under current code: pin a booking-linked hotel, edit the booking, confirm the pin holds; then confirm a deliberate Google re-pick still moves it.
- If a user-facing warning is chosen, verify it at 375px with the software keyboard open, per the repo's mobile-first rule.

### Cross-reference
Recorded as **G5** in [the 2026-07-25 review](../reviews/2026-07-25-google-maps-deep-link-identity-review.md) §8, classified there as **LIVE (code shape), data-age independent**. Plan 24's W3 includes a *probe* test that documents current behavior without changing it — that test is the natural starting point for this work, and it will need updating when the behavior changes.
