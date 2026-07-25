# Implementation Plan 24 — Google Maps Deep-Link Place Identity and Link-Coordinate Correctness

**Status:** 2026-07-25 — **PLAN CLOSED. W1, W2, W3 COMPLETE · DEPLOYED to production 2026-07-25 at `8b6af67` · owner production pass PASSED 2026-07-25** (all Appendix B rows; four observations raised, three were designed behaviour and one a pre-existing coincident-marker data quirk — no code change required, see Appendix B). The only remaining Plan 24-adjacent work is [Appendix A](#appendix-a--spun-out-d4-booking-sync-overwrites-a-user-confirmed-pin), deliberately out of scope. No migration. No new external API calls. Commits: W1 `45de419`, W2 `8ae31cc`, W3 `989f04c`, docs pin `8b6af67`. The owner's production click-script is [Appendix B](#appendix-b--owner-production-qa-click-script).

**Deploy record (2026-07-25).** Server fast-forwarded `7801cf4 → 8b6af67` (nine commits: the four Plan 24 commits plus five docs-only commits that had never shipped), container `trippy-trippy-1` rebuilt via `docker compose up -d --build`. Pre-deploy backup `~/Trippy/backups/pre-plan24-<stamp>.db`, `integrity_check: ok`. Zero files under `backend/src/db/migrations/` in the deployed diff — the no-migration profile was verified on the server, not merely asserted. Infrastructure verification: `/api/health` 200 `{"status":"ok","db":"connected"}`, clean startup logs, backup cron intact. Live read-only spot check through `getTripMapData`: "Kimpton Da An Hotel" (Taipei - Kaohsiung) returns `linkLat`/`linkLng` and `googlePlaceId` `ChIJQYzd58yrQjQRMxp7e6xhxxY`; across all five production trips **0 located stops lack a link datum**, and a Chengdu - Chongqing stop returns a link datum genuinely displaced from its stored coordinate, confirming the GCJ-02 branch converts rather than passes through. Browser QA was deliberately not run by the agent — Appendix B is the owner's.

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

**F2 — `deepLink.js` has no test file.** `frontend/src/utils/deepLink.test.js` does not exist. ~~There is no test anywhere asserting the shape of a produced URL.~~

> **CORRECTED during W2 (2026-07-25).** The second sentence was **wrong**. `backend/tests/map.test.js:95-119` held five URL-shape assertions (amap, naver, google, unknown-provider-defaults-to-google, label special-character encoding) — but they exercised the **dead backend twin**, not the builder the app ships. So the repo's only URL-shape coverage guarded code with zero production callers, which is the sharpest possible argument for F1's deletion instruction. W2 deleted the function *and* those five assertions together; **W3's `deepLink.test.js` must carry all five branches forward onto the live frontend builder** so the coverage moves rather than disappears. F1's "zero callers" claim was correct about production code and incomplete about tests — grep tests too, next time.

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

> **STRENGTHENED during W3 (2026-07-25), from a read-only production query.** The enumeration above is **incomplete**: production also holds **8 `relation:<id>` rows** (e.g. `relation:2110257` "Dujiangyan Irrigation System", `relation:2999045` "Dragon and Tiger Pagodas"), a prefix that appears nowhere in this plan or the review and does not exist in the dev database at all. Every one is correctly rejected, because the positive `google:` allowlist rejects *by construction* rather than by enumerating what to exclude. Had the denylist approach been taken, it would have leaked a prefix nobody knew existed. Do not replace clause 1 with a denylist, and do not "complete" the OSM prefix list — the point is that the list cannot be known to be complete.

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

**Status: COMPLETE 2026-07-25.** Pure correctness. No payload field is added for identity in this wave; RC-1 is W2. All seven steps implemented as designed, no deviations. Baselines held exactly: backend **676 passed / 31 files**, frontend **240 passed / 39 files**, `npm run build` green. No test file was added or modified (W3 owns all new tests), and no existing assertion was weakened.

**Step 0 findings.** The safety grep found **no consumer depending on `country_code` being cleared by a pin** — the only two references to its NULL-ness are `country_code = COALESCE(country_code, ?)` fills (`stops.js:841`, `:1048`), which only *benefit* from preservation. D-24-4 was therefore safe to implement without a product question.

**W1 verification actually performed** (beyond the gates; the normative matrix is still W3's):
- *Real-data Maps-vs-Today parity probe* over the legacy `Chengdu - Chongqing` trip plus the `Taipei - Kaohsiung` and `Shanghai - Hangzhou` current-code trips — **39 stops, 0 parity mismatches**: 38 linked, 1 correctly unlinked (the coordinate-less unresolved `G3360` transit stop), 18 needing a link-datum conversion. Legacy unknown-datum, legacy `curated:*`+`gcj02`+`user_confirmed`, and legacy `user_pin`+`gcj02` rows all came through precise and unmoved, because on an all-CN trip the tile provider and link provider coincide.
- *RC-2b quantified* on synthetic rows (the case current data lacks, F14/review §7b): an **HK** stop on a mainland-CN day was **598 m** off under the old display-pair link and now sends true WGS-84 to Google; a **KR** stop on a CN day was **459 m** off and now sends true WGS-84 to Naver; a genuine **CN** stop still converts to GCJ-02 for Amap. Provider and coordinates agreed across both surfaces in all three.
- *Browser, 375px, real session*: Today's `NavigateIcon` rendered `https://www.google.com/maps/search/?api=1&query=22.6205,120.2807` for a `TW` stop — provider taken from the **stop's own country**, coordinates unrounded — and the Map tab popup produced a **byte-identical** href. Zero console errors.
- *D-24-4 through the real UI*: **Move pin → Set here** left `provider_id`/`resolved_name`/`resolved_address` NULL (correct, and what keeps D-24-3 safe) while **`country_code` stayed `TW`**; a subsequent real Google pick in *Check location* stamped `country_code: TW` alongside `provider_id: google:ChIJW8ThIHYEbjQR8k12HL3R1uY`. The QA stop and minted session were deleted afterwards.

**Not verified locally, owed to the owner's production pass:** the `AddPlaceModal` and MapTab set-pin *modal* surfaces could not be opened in the in-app Browser pane (the known `document.hidden` → paused-rAF freeze), so `AddPlaceModal`'s `countryCode` forwarding was exercised by driving the exact payload it now builds, not by typing in the modal. MapTab's `handlePickResult` forwarding *was* exercised through the real UI. The full era-split manual matrix remains W3's.

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

**As implemented:** the frontend twin deliberately still does **not** carry F5's unknown-datum nulling, so Today keeps linking legacy unknown-datum coordinates exactly as it does today — G6 is out of scope and must not move in either direction. The corrected header now states this explicitly instead of claiming an exact mirror. Confirmed unaffected: `TripRouteCover.jsx:2` imports `wgs84ToGcj02` only. Separately confirmed by reading `TripMap.jsx:6-10` that a `StopMarker` only renders when `canRenderMarker` is true, and that `toDisplayCoordinates` nulls on datum-*independent* conditions — so `linkLat` can never be null where `displayLat` is present, meaning the new `Number.isFinite(stop.linkLat)` gate cannot remove a Map-tab link that exists today.

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

**Status: COMPLETE 2026-07-25.** All five steps implemented as designed. Gates: backend **672 passed / 31 files** (676 W1 baseline **+1** new share test **−5** deleted dead-twin assertions — see the F2 correction above), frontend **240 passed / 39 files** unchanged, `npm run build` green. The invariant lives only in `backend/src/utils/googlePlaceIdentity.js`; the frontend contains zero clause logic.

**W2 verification actually performed** (the normative matrix is still W3's):
- *Invariant run over all 58 real stops*: **7 qualify** with genuine `ChIJ…` IDs; **51 return null, every one of them on clause 1**. Of those, **28** carry unprefixed `way:*`/`node:*` OSM identifiers and **3** carry `curated:*` — concrete proof of F11/F12: an `osm:`-prefixed *denylist* would have handed all 28 OSM ids to Google as place IDs. No row failed on clauses 2–5, consistent with the plan's claim that RC-4 has zero rows.
- *Browser, 375px, real session* — Google **with** ID: `…?api=1&query=22.6244914,120.30142339999999&query_place_id=ChIJHTWHW4YEbjQRYHlaoZkM1dw` (exact coordinates retained as the D-24-5 safety net). Google **without** ID (Malaysian `manual_lookup`/OSM stops): `…?api=1&query=4.6249395,101.1572286` — byte-identical to the pre-W2 form. **Amap**: byte-identical to the W1 baseline across the legacy trip, **0 place IDs leaked anywhere** — including `Crowne Plaza CHENGDU PANDA GARDEN`, a stop that *does* hold a valid `googlePlaceId` but links via Amap, proving the non-Google branches ignore a supplied ID on real data rather than only in theory.
- *Share payload*: independently re-read `share.js:64-84` — its `mapStop` is a hand-built allowlist (no `provider_id`, no provenance, no status) that cannot inherit from either mapper W2 touched. G7 holds; one regression test now guards it.
- *Trip-context payload*: `googlePlaceId` arrives bare (prefix stripped) beside the raw `providerId`, null where it should be.

**Data observation contradicting F14.** `Crowne Plaza CHENGDU PANDA GARDEN` lives in the **legacy** `Chengdu - Chongqing` trip yet satisfies all five clauses — F14 predicted "legacy: 0 of 39". The likely cause is booking sync having restamped a Google identity onto it after the resolver landed, which is exactly the **Appendix A / D4** mechanism. **Era is not a reliable proxy for identity**, so W3's era-split manual matrix must classify rows by their actual provenance columns, not by trip creation date.

Additive payload. Depends on W1 only for coherence: `googlePlaceId` is emitted solely for stops whose stored datum is `wgs84` (invariant clause 4), which is exactly the datum W1 sends to Google.

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

**Status: COMPLETE 2026-07-25 · owner production pass PASSED 2026-07-25.** Full matrix in review §10; it is normative, not a summary. Owner QA result and the four observations raised are recorded in [Appendix B](#appendix-b--owner-production-qa-click-script).

**Gates, all green:** backend **703 passed / 32 files** (+31), frontend **271 passed / 42 files** (+31), `npm run build` green. **62 tests added, zero source files modified in W3** — every W1/W2 behavior passed its test unmodified on the first honest run, and no assertion was loosened to make a test pass.

New files: `frontend/src/utils/deepLink.test.js` (12), `frontend/src/utils/deepLinkTarget.test.js` (13), `frontend/src/utils/coordinates.test.js` (6), `backend/tests/googlePlaceIdentity.test.js` (24 — one per review §5 row 1–13, plus edge cases). Extended: `backend/tests/locationIntegration.test.js` (+7, new `describe` block only; no existing test altered).

**The RC-2b/RC-3 fix, proven in a real browser.** A throwaway single-day CN trip was created with three qualifying stops on the *same mainland-China day*, then deleted. At 375px and again at 1280px, **Today** and the **Map popup** produced byte-identical links for all three:

| Stop | App | Link coordinates | `query_place_id` |
|---|---|---|---|
| CN Jiefangbei | `uri.amap.com` | `29.55995…,106.55521…` — **converted to GCJ-02** | absent |
| HK Victoria Peak | `google.com` | `22.2759,114.1455` — **true WGS-84, unconverted** | `ChIJ_qa_hk` |
| KR Gyeongbokgung | `map.naver.com` | `37.5796,126.977` — true WGS-84 | absent |

Three apps and three datum decisions from one day. Under the old code all three would have received that day's GCJ-02 tile pair — the HK link ~598 m off and the KR link ~459 m off. This single screen is the RC-2, RC-2b, RC-3, and D-24-6 acceptance evidence.

**G5 / Appendix A is now CONFIRMED at runtime, not merely read from code.** The two probe tests form the discriminating experiment Appendix A specified, and both behaved exactly as predicted: a booking **with** `details.placeId` re-saved after a user pin **silently discards the pin** and reinstates the Google identity and coordinates; a booking **without** `placeId` takes the other branch, `protectedUserPin` fires, and the pin **survives untouched**. D4 is therefore a confirmed live defect, not a hypothesis — see [Appendix A](#appendix-a--spun-out-d4-booking-sync-overwrites-a-user-confirmed-pin), whose "Mechanism (read from code, not yet reproduced at runtime)" heading is now out of date. The probe asserts the safety property that must hold whichever way D4 is resolved: coordinates and `provider_id` always move together, never a Google ID stranded on the pin's coordinates.

**Two honest limitations of the automated matrix:**
1. **The parity test is one-sided.** `googlePlaceId` parity between the two mappers is a direct assertion (both call the same one-owner helper), and the coordinate *inputs* are asserted identical — but the backend test cannot execute the frontend's `resolveDeepLinkTarget`, so the provider axis is re-derived using backend functions rather than cross-checked. The genuine cross-surface proof is empirical, not automated: a one-off probe imported the frontend helper against real data and found **0 mismatches across 39 real stops**, and the browser table above shows byte-identical hrefs from both surfaces. The two suites now pin the same provider/datum table, so drift in either breaks a test.
2. **`AddPlaceModal`'s modal surface was never opened in a browser** (the in-app pane's paused-rAF freeze). Its `countryCode` forwarding was exercised by driving the exact payload it builds. MapTab's `handlePickResult` forwarding *was* driven through the real UI with a live Places call.

**Production reconnaissance (read-only, 2026-07-25)** — used to build the owner click-script, and worth keeping: prod holds **100 stops, 28 of which qualify (28%)**, a better payoff than D3's 13%-all-data framing. Prod has only **5** unknown-datum rows and **4** `user_pin` rows. No production trip mixes CN with TW/HK/KR stops, so **RC-2b is not reproducible from production data either** — it stays covered by tests, exactly as F14/review §7b anticipated. Prod also surfaced the `relation:` prefix that corrected F11 above.

**Latent trap recorded, not a defect:** there is a **third** stop mapper, `stops.js formatStop`, which W2 deliberately did not touch, so create/update responses omit `googlePlaceId`. This is currently invisible because `useStops.run` calls `onChanged: tripState.refresh` after every mutation, refetching through `getTripDetail` (which does emit it). If anyone ever switches those hooks to optimistic local patching, the place ID would silently vanish from a just-edited stop until the next refetch.

Highlights and gates:

### Automated
- **New** `frontend/src/utils/deepLink.test.js` (F2 — first coverage this helper has ever had): google+ID URL shape and parameter order; google+null ID byte-identical to today's URL (no-regression anchor); amap and naver ignore a supplied ID; unsafe characters encoded; coordinate precision not rounded. **Plus the five branches inherited from the deleted backend twin** (see the F2 correction): amap, naver, google, unknown-provider-defaults-to-google, and label special-character encoding. W2 deleted those assertions along with their dead subject, so this file is where that coverage must reappear — do not let it lapse. Also cover google+**empty-string** ID (must omit the parameter, not emit `query_place_id=`).
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

**Status:** **INVESTIGATED AND SUPERSEDED 2026-07-26 → [Implementation Plan 25 — Booking Sync Must Not Overwrite a User Pin](<Implementation Plan 25 Booking Sync User Pin Precedence.md>).** Questions 1–4 are answered there; the owner took decisions D-25-1 (pin always wins) and D-25-2 (silent — nothing is lost, so nothing to warn about), and candidate **(a) caller-scoped precedence** was adopted. Three corrections to this appendix, established during that investigation and recorded as facts F-25-4, F-25-5, and F-25-7 in Plan 25: the Discovery trusted fast path is a **CREATE**, not an update, so no guard change can reach it; candidate **(c) is a provable no-op** as stated, because `protectedUserPin` already contains `&& !trustedCoordinates`; and candidate **(b) cannot be built without a migration**, because a user pin clears `provider_id` and nothing else records which `placeId` a stop was last synced from. Read Plan 25, not this appendix, for the current shape of the work. The text below is retained as the investigation's starting point.

Deliberately excluded from Plan 24 (owner decision D4, 2026-07-25) because it changes **write precedence** rather than read/display, is orthogonal to deep links, and needs its own QA pass.

**Caller enumeration for question 3 — established 2026-07-26, do not re-derive.** `resolveLocationForStop` has exactly **three** call sites, all in `backend/src/services/stops.js`:

| Line | Enclosing function | Passes `existing`? | Guard 2 reachable? |
|---|---|---|---|
| `:437` | `resolveCreateStopData` | **no** (create path) | no — nothing to protect |
| `:533` | `resolveUpdateStopData` | **yes** | yes |
| `:940` | `syncStopWithBooking` | **yes** | **no — guard 1 pre-empts it (the defect)** |

So only **two** call sites can protect a pin, and a *global* guard reorder would alter exactly one other caller: `resolveUpdateStopData`. That is the path the Discovery trusted fast path (`DiscoveryPanel.jsx:434-465`) and the Map "Check location" Google pick (`MapTab.jsx:153-163`) both reach — so question 3 reduces to a single, tractable question: *should a Google pick through `resolveUpdateStopData` still be allowed to move a `user_confirmed` stop?* `syncStopWithBooking` itself has two callers, `bookings.js:158` (create) and `bookings.js:202` (update); the importer reaches it through those.

### Symptom to confirm
Re-saving a hotel booking that was created through Google Places autocomplete **silently discards a user's manually corrected pin** on the booking-linked stop, and reinstates a Google identity on that stop.

### Mechanism — ~~read from code, not yet reproduced at runtime~~ **CONFIRMED at runtime 2026-07-25 (Plan 24 W3)**

> The two probe tests in `backend/tests/locationIntegration.test.js` executed the discriminating experiment below and **both predictions held exactly**: a `placeId` booking re-save silently discarded a `user_confirmed` pin and reinstated `provider_id = google:*` with the booking's coordinates; the same sequence with a **non**-`placeId` booking preserved the pin untouched. The reading below is therefore verified behavior, and question 4 ("does it reproduce on a new trip?") is **answered yes** — the probe runs on a trip created fresh by the test harness under current code. Questions 1–3 remain genuinely open, and question 3 is still the real risk.

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

The W3 probe **confirmed this mechanism at runtime** (see the W3 status block) — both of Appendix A's predictions held, so D4 is a verified live defect rather than a code reading.

---

## Appendix B — Owner production QA click-script

Run **after** deploying. Every stop named below was confirmed present in production by a read-only query on 2026-07-25, so no hunting is required. Do the **375px phone pass first**, then spot-check two rows on desktop. A row fails if the wrong app opens, the pin is visibly displaced, or a name appears on a stop that should be an unnamed dropped pin.

**Reading the result:** "**named card**" = Google opens showing its own place name, photo, and details. "**dropped pin**" = Google opens on a bare coordinate marker with no name. Both are correct outcomes — the point is that each stop gets the *right* one.

### A. Current-code half — stops must gain real names

| # | Where | Expected |
|---|---|---|
| A1 | **Taipei - Kaohsiung** (active) → **Today**, 25 Jul → tap Navigate on **Formosa Boulevard Station (Architecture)** | Google opens a **named card**, correct pin |
| A2 | Same trip → **Map** → day 25 Jul → tap that stop's pin → **Open in Google Maps** | Identical destination to A1 — same app, same place, same pin. **This is the parity check; a mismatch here is the most serious possible failure.** |
| A3 | Same trip → **Map** → day 20 Jul → **Kimpton Da An Hotel** | **named card** (hotel booking carrying a `placeId`) |
| A4 | Same trip → **Map** → day 24 Jul → **Fo Guang Shan Buddha Museum** | **named card** |
| A5 | Same trip → **Map** → day 23 Jul → **Dragon and Tiger Pagodas (Lotus Pond)** | **dropped pin** at the right spot, **no name** — OSM-resolved (`relation:2999045`); a Google name here would be the bug W2 prevents |
| A6 | **Kuala Lumpur** → **Map** → day 5 Aug → **SQ 125** | **named card**; a Singapore stop inside a Malaysian trip, so it also proves the stop's own country drives the link |

### B. China half — Amap, and never a Google place ID

| # | Where | Expected |
|---|---|---|
| B1 | **Shanghai - Hangzhou** → **Map** → day **29 Jul** → **Qinghefang Antique Street** | **Amap** opens (not Google), pin on the right street. **Note:** this stop and **Qinghefang Night Market & Street Food** (same day) are stored at byte-identical coordinates and the *same* `provider_id`, so their markers sit exactly on top of each other and only one is tappable. Either one satisfies this row — the deep link is identical. See the 2026-07-25 QA note below. |
| B2 | Same trip → **Map** → day 26 Jul → **Shanghai the Bund W Hotels** | **Amap**, pin on the hotel |
| B3 | Same trip → **Map** → day 28 Jul → **The Bund** | **Amap**, correct pin, **no name** (OSM `relation:2142077`) |
| B4 | Once that trip is live (from 26 Jul), repeat **B1 from the Today tab** | Same app and same pin as B1 — the RC-2 regression check from Today |

### C. Legacy half — untrustworthy rows must stay precise and unnamed

Passing only A and B proves nothing. This half proves the fix degrades honestly instead of inventing names.

| # | Where | Expected |
|---|---|---|
| C1 | **Chengdu - Chongqing** → **Map** → day 9 Jun → **Regent Chongqing** | **Amap**, pin **exactly where it is today** — a hand-placed `user_pin` stored in GCJ-02; it must not shift and must not gain a name |
| C2 | Same trip → **Map** → day 14 Jun → **Long Chao Shou** | Pin at its current position, **no name** (unknown-datum legacy row) |
| C3 | Same trip → **Map** → day 15 Jun → **Dujiangyan Irrigation System** | **dropped pin**, no name (`relation:2110257`) |
| C4 | Same trip → **Map** → day 13 Jun → **W Chengdu** | **No "Open in..." button at all** — unresolved with no coordinates, so offering a link would be wrong |
| C5 | **Kuala Lumpur** → **Map** → day 3 Aug → **Petronas Twin Towers** | Google **dropped pin** exactly where the pin was placed, **no named card** (`user_pin`, identity correctly cleared) |

### D. Write-path check (one minute)

| # | Where | Expected |
|---|---|---|
| D1 | Any trip → **Map** → a stop → **Move pin** → pan slightly → **Set here** → reopen the popup | Still the **correct app for that country** after pinning. This is the D-24-4 fix: before it, pinning wiped the stop's country and the app choice fell back to day geography |
| D2 | **Plan** → **Add place** → type a place → pick a Google suggestion → save → open it from the Map | **named card.** This is the one surface the agent could not click locally (the in-app browser cannot open modals), so it is the highest-value row for you to run |

### Owner QA result — 2026-07-25: PASSED

All rows passed. Four observations were raised and each was checked against production data; **three were the designed behaviour and one is a pre-existing data/rendering quirk unrelated to this plan.** None required a code change.

- **A5 — "opened Google Maps showing coordinates."** Expected, and the point of W2. `Dragon and Tiger Pagodas (Lotus Pond)` carries `provider_id = relation:2999045` (OSM), so the positive `google:` allowlist yields no place id and the link degrades to a coordinate-only dropped pin. A *named* card here would have been the bug.
- **C5 — "Google Maps opened showing coordinates."** Expected. `Petronas Twin Towers` is `coordinate_source = user_pin`, `provider_id = NULL` — identity correctly cleared, so the owner's hand-placed pin wins and no Google name is invented.
- **C4 — "no pin, only a 'Place on Map' button, so no 'Open in…' button."** Expected, exactly as written. `W Chengdu` is `location_status = unresolved` with `lat`/`lng` `NULL`; "Place on Map" is the correct affordance and offering a deep link would be wrong.
- **B1 — wrong day in the script, and the stop's marker is invisible.** Both correct observations. The day was a script error (the stop is on **29 Jul**, now fixed above). The invisible marker is **real but not caused by this plan**: `Qinghefang Antique Street` and `Qinghefang Night Market & Street Food` were both created on 2026-07-09, 57 seconds apart, and the resolver mapped both onto the same real place — identical `lat`/`lng` (`30.241968, 120.170816`), identical `provider_id` (`google:ChIJIyHi70OdTDQRmQAg6H8E-WU`), both `resolved_name = "Qinghefang"`. `StopMarker` renders a plain Leaflet `<Marker>` with no coincident-pin offset or clustering, so one sits exactly beneath the other. A production-wide sweep found **exactly one** such pair, so this is a single data coincidence, not a systemic fault. Because both stops share the same place id, coordinates, and country, their deep links are byte-identical — tapping the visible twin fully satisfies B1.

**Follow-up, not scheduled:** coincident markers have no offset/spiderfy treatment. One prod occurrence; needs an owner decision (nudge overlapping pins, cluster them, or merge the duplicate stops) before any work starts.

### Why most stops open on coordinates, not a named card — 2026-07-25

Raised after QA when several KL/Taipei pins and a freshly added stop all opened coordinate-only. **All expected.** The cause is resolver ordering, not this plan.

`placeResolver.js` (~L614–645) tries **Nominatim first** and only falls through to **Google Places when Nominatim returns no result**. Nominatim is strong on exactly the landmarks a traveller adds — temples, parks, pagodas, streets, towers — so the common path succeeds and stamps `provider_id = way:/node:/relation:` with `coordinate_source = manual_lookup`. Clause 1 requires a literal `google:` prefix, so those correctly produce a coordinate-only link. **A named card is the exception by design.**

Measured across all **102** production stops on 2026-07-25:

| Outcome | n | % |
|---|---|---|
| **Qualifies — named card** | 29 | 28% |
| OSM `way:` | 41 | 40% |
| OSM `node:` | 12 | 12% |
| OSM `relation:` | 9 | 9% |
| `provider_id` NULL (user pin) | 5 | 5% |
| No coordinates — no link button | 4 | 4% |
| `curated:` | 2 | 2% |

Two stops created four minutes apart on 2026-07-25 demonstrate the split cleanly: **Lotus Pond** → `relation:2999045` / `manual_lookup` / `estimated` → coordinates (Nominatim knew it); **Apple The Exchange TRX** → `google:ChIJr4bX6743zDERAgnOBGsB1F0` / `places` / `resolved` → named card (Nominatim did not know a new mall tenant, so it fell through to Google). Same code path, opposite outcome, decided purely by OSM coverage.

**A named card therefore appears only when:** (1) the stop was added via Plan → Add place from a Google autocomplete suggestion, which bypasses the resolver entirely; (2) Nominatim failed and Google Places answered; or (3) a booking carried its own `placeId`. It never appears for well-mapped OSM places, hand-placed pins, or unresolved stops.

Note also that a place-id-less Google link sends `query=<lat>,<lng>` and **deliberately omits the stop's name** — sending the name as a text query is precisely how Google opens a confidently wrong place. Precision over prettiness is the W2 premise; do not "fix" this by adding the label.

**Unscheduled options if naming coverage should improve** (owner decision, own plan). Costed against production on 2026-07-25 — see the next section, which **supersedes the earlier guess that "Discovery-only Google-first" is the cheap option.**

### Costing the naming-coverage options — measured 2026-07-25

Measured, not estimated. Production totals: **2,014** `discovery_places` across **11** destinations (~183/city), **102** stops all-time.

**The Discovery-first option is nearly a no-op, because Discovery already pays Google.** Of 1,219 *verified* discovery places, **1,173 carry `google:`** and only **46 carry OSM** — Nominatim fails on ~96% of Discovery's AI-generated venue names ("Qinghefang Alley Late Drinking Route"), so the paid fallback already fires almost every time. Flipping Discovery to Google-first therefore adds **+46 calls per ~1,219 (+3.8%)**, not a new cost centre.

**And it would not fix the symptom.** Verified discovery places already yield named cards: `DiscoveryPanel.jsx` (~L440) has a trusted fast path carrying `placeRef` (`google:…`), `coordinateSource:'places'`, `locationStatus:'resolved'` onto the stop, satisfying all five clauses with **zero** extra API calls. The 2026-07-25 `Lotus Pond` add missed it only because that row is `provenance='unverified'` with NULL id/coords — **784 of 2,014 (39%)** are unverified, so they fall to the slow Nominatim-first path. The daily resolver budget is 500 and peak observed daily verification was 421, so **the budget is not obviously the binding constraint** — the unverified backlog needs its own investigation, not an assumption.

| Change | Extra Google calls | Cost at list |
|---|---|---|
| **Stop resolver → Google-first** | **+62, all-time** (62 of 102 stops are Nominatim-resolved) | **~$0.002** |
| Discovery → Google-first | +46/month | ~$1.50/mo |
| Discovery verification as it runs today | (already being spent) | ~1,219/mo |

Rating enrichment is **off** in production (`rating` NULL on all 2,014 rows), so calls sit on the cheaper **Text Search Pro** field-mask tier, not Enterprise. Absolute per-call pricing was **not** verified in-session and Google's 2025 model includes a per-SKU monthly free allowance that may zero this out — **confirm current rates before acting.** The call-volume figures above are measured and reliable; only the dollar conversion is uncertain.

### OWNER DECISION 2026-07-26 — precision over polish. This follow-up is CLOSED.

**No resolver change will be made.** The owner's ruling: an occasionally-wrong named card is a trust failure, and map accuracy will not be traded for a slightly more polished Google Maps card. Nominatim-first ordering stays; coordinate-only deep links for OSM-resolved, user-pinned, and unresolved stops are the accepted, correct behaviour. **Do not re-propose Google-first for either the stop resolver or Discovery.** The costing below is retained only as the evidence base for that decision.

The one item that survived is *not* about naming: the investigation surfaced Discovery **data-quality** problems (44% of served suggestions unverified; dedupe blind to them), spun out to [2026-07-26 Discovery catalogue quality review](../reviews/2026-07-26-discovery-catalogue-quality-review.md).

**Superseded recommendation (retained for context):** do **not** change Discovery's resolver order — it moves ~4% of calls and fixes nothing. The two levers that actually improve naming are (1) flipping the **stop** resolver to Google-first, which is financially trivial but carries a real quality risk — Google Text Search returns confident *wrong* matches on ambiguous names where OSM gives precise geometry, the exact tension W2 exists to manage, so it needs a confidence guard — and (2) closing the 39% unverified discovery backlog so more adds take the existing free fast path.

### Not reproducible in production — do not hunt for it

No production trip mixes mainland-China stops with HK/TW/KR stops, so the **HK-or-KR-on-a-mainland-day** case — the largest single correction at ~598 m and ~459 m — cannot be exercised from existing prod data. It is covered by integration tests and was demonstrated in a browser on a purpose-built trip. To see it live, add a Hong Kong stop to a day of **Shanghai - Hangzhou**, confirm it opens **Google** on the correct HK building while that day's other stops still open Amap, then delete it.

### If a row fails

Note the trip, day, stop name, which surface (Today vs Map), and the URL the button actually opened (long-press → copy link). A stop's `provider_id`, `coordinate_source`, `coordinate_system`, `location_status`, and `country_code` determine every expectation above, so those five columns plus the observed URL are enough to diagnose without reproducing.
