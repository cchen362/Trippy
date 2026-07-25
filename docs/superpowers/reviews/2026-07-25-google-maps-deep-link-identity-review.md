# Google Maps Deep-Link Identity and Precision — Review

**Date:** 2026-07-25
**Status:** REVIEW COMPLETE — owner decisions resolved (§11). Legacy-vs-live verification added (§7b). Ready for an implementation plan to be drafted.
**Scope of investigation:** every path that produces a "open this stop in a maps app" link, on both the Map tab popup and the Today tab, plus every stop-entry path that writes the location identity those links depend on.
**Nothing was changed.** This document is findings only.

---

## 1. The reported outcome

> When a stop is opened in Google Maps from either Maps or Today, a real Google-resolved place should show its actual place name/details while retaining the exact destination. Manually placed, estimated, legacy, OSM, curated, or otherwise non-Google locations must remain precise and must not be misrepresented as a named Google place.

The investigation confirms the reported symptom and finds that it is **two independent defects**, in different files, with different risk profiles. A plan that only addresses the naming symptom leaves a live coordinate-precision bug in place for exactly the stops most likely to appear in a China trip.

---

## 2. Verified root causes

### RC-1 — Naming: no place identity is ever sent (the reported symptom)

`frontend/src/utils/deepLink.js:10` builds every Google link as:

```
https://www.google.com/maps/search/?api=1&query=<lat>,<lng>
```

There is no `query_place_id` anywhere in the repository. Google therefore performs a coordinate search and renders a generic dropped-pin card even when the stop *is* a Google-resolved place with a stored place ID.

Both surfaces call this one helper, so the gap is uniform:
- Map popup: `components/map/StopMarker.jsx:76` → `OpenInMapsButton.jsx:4`
- Today: `components/today/NavigateIcon.jsx:17` (used by `HeroCard`, `TonightCard`, `UpcomingRow`)

**Neither surface can currently make the decision, for different mechanical reasons:**

| Surface | Payload source | `providerId` present? | `countryCode` present? |
|---|---|---|---|
| Map tab | `backend/src/services/mapData.js:94` `formatMapStop` | **No** — also omits `coordinateSource` and `coordinateSystem` | Yes (used internally at `:236`, not emitted) |
| Today | `backend/src/services/trips.js:47` `mapStop` | Yes | **No** |

### RC-2 — Precision: the link reuses the *tile* provider's datum, not the *link* provider's

This is a live, shipping bug independent of place IDs.

- `StopMarker.jsx:48-49` passes `displayLat/displayLng` to the link builder. Those are converted for the **day's tile provider** (`mapConfigByDay`), so on a day whose derived country is `CN` every stop on that day is shifted into GCJ-02 for rendering.
- The **link provider** is chosen separately, from the stop's own country (`mapData.js:236-237`, the deliberate "Option C" precedence).

The two decisions can disagree. Concretely:

| Situation | Link provider | Coordinates sent | Result |
|---|---|---|---|
| HK / MO / TW stop on a mainland-CN day | `google` | GCJ-02 | Google pin ~300–600 m off |
| KR stop on a mainland-CN day | `naver` | GCJ-02 | Naver pin off by the same margin |

The mirror-image failure exists on Today, caused by an incomplete frontend port:

- `backend/src/services/coordinates.js:104-108` implements **both** conversion directions (`wgs84→gcj02` *and* `gcj02→wgs84`).
- `frontend/src/utils/coordinates.js:63-74` implements **only** `wgs84→gcj02`, despite a header comment asserting it "mirrors backend `toDisplayCoordinates`' wgs84 guard exactly".

So a stop **stored** as `gcj02` that sits on a non-CN day passes through unconverted and is handed to Google as GCJ-02. The Map tab handles this case correctly (the backend converts); Today does not. Measured: **9 stops in the local dev database are stored `gcj02`** (§7), all of them mainland-China places including two flight stops on Singapore-Airlines legs — the cross-country day is a realistic arrangement, not a contrived one.

### RC-3 — Provider parity: Today keys off the day, Maps keys off the stop

`pages/TodayTab.jsx:29,51-74` passes `todayMapConfig.deepLinkProvider` — the **day's** provider — to every `NavigateIcon`. `mapData.js:236` uses the **stop's** country with the day as fallback. A CN-resolved stop on a JP day therefore opens Amap from Maps and Google from Today; the reverse arrangement inverts it. The mechanical blocker is `trips.js mapStop` not emitting `countryCode`.

### RC-4 — The genuinely dangerous stale pairing (not where it was expected)

`backend/src/services/stops.js:220-233`: when the caller supplied coordinates but the resolver's result was rejected as a different place (`isSimilarPlace` false), the function returns the **caller's** `lat`/`lng` together with the **resolver's** `providerId`, at `locationStatus: 'estimated'`. Identity and coordinates describe different places by construction.

Because Google's contract is that the place ID *wins* (§3), sending that ID would relocate the user to the resolver's place and silently discard the coordinate the code deliberately preserved. This is the strongest argument for a conservative allowlist rather than "has an ID → use it". Measured occurrences in current data: **0** — the path is armed but unfired (§7).

---

## 3. Official Google contract (verified this session)

From [Maps URLs — Get started](https://developers.google.com/maps/documentation/urls/get-started):

- `api=1` "is required in every request."
- "The query parameter is **required for all search requests**." Accepts a place name, an address, or "comma-separated latitude/longitude coordinates."
- `query_place_id` is optional, "a textual identifier that uniquely identifies a place."
- **Precedence:** "If you specify both parameters, the query is only used if Google Maps cannot find the place ID."
- "If you are trying to definitively link to a specific establishment, the place ID is the best guarantee that you will link to the right place."

From [Places — Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id):

- "Place IDs may change due to updates on the Google Maps database. In such cases, a place may receive a new place ID, and the old ID returns a `NOT_FOUND` response."
- A `NOT_FOUND` "indicates that the specified place ID is obsolete. A place ID may become obsolete if a business closes or moves to a new location."
- Google "recommends refreshing place IDs if they are more than 12 months old," free via a Place Details request specifying only the place-ID field.

**Consequence for design.** The documented fallback protects against an ID that no longer resolves. It does **not** protect against an ID that resolves to a *relocated* business — in that case Google honours the ID and moves the destination. So a wrong ID is a wrong destination, not merely a wrong label. `query` must always carry the exact coordinates, and the ID must only be attached when we can attest that the ID and the coordinates describe the same place.

---

## 4. Data invariant — when a stored Google Place ID is safe

A stop's `provider_id` may be used as `query_place_id` **only when all five clauses hold**:

1. `provider_id` starts with `google:` and has a non-empty suffix — a **positive prefix allowlist**, never an inference from `coordinate_source`;
2. `location_status === 'resolved'` — excludes `estimated` (RC-4), `unresolved`, and `user_confirmed`;
3. `coordinate_source === 'places'`;
4. `coordinate_system === 'wgs84'`;
5. `lat` and `lng` are both finite.

Anything failing any clause is **coordinate-only**, silently — no name, no ID, no degraded fallback, no user-visible difference beyond Google showing a dropped pin.

Two notes on why the allowlist must be positive rather than "not a manual pin":

- Discovery's trusted fast path hard-codes `coordinateSource: 'places'` while passing `placeRef` through (`DiscoveryPanel.jsx:454`), and `placeRef` may be an OSM or curated identifier. Gating on `coordinate_source` alone would send non-Google IDs to Google.
- The OSM resolver emits `way:<id>` / `node:<id>` — **not** `osm:way:<id>` (`placeResolver.js:451`). A denylist keyed on an `osm:` prefix would miss every real OSM row.

---

## 5. Scenario table: source/state → identity → correct behavior

| # | Source / state | Stored identity | Correct Google behavior |
|---|---|---|---|
| 1 | Google picker — Add Place (`AddPlaceModal.jsx:152`), Discovery "On the map" (`DiscoveryPanel.jsx:513`) | `google:*`, `places`, `wgs84`, `resolved` | ✅ `query=lat,lng&query_place_id=<id>` |
| 2 | Map "Check location" → picked a Google result (`MapTab.jsx:153-163`) | `google:*`, `places`, `wgs84`, `resolved` | ✅ place ID |
| 3 | Google resolver fallback (`placeResolver.js:551`); CN results already un-shifted to true WGS-84 at `:535-539` | `google:*`, `places`, `wgs84`, `resolved` | ✅ place ID |
| 4 | Hotel/booking sync with `details.placeId` (`stops.js:894-905`) | `google:*`, `places`, `wgs84`, `resolved`, `country_code` null | ✅ place ID |
| 5 | Discovery verified fast path, `placeRef` = `google:*` | `google:*`, `places`, `wgs84`, `resolved` | ✅ place ID |
| 6 | Same path, `placeRef` = `way:*` / `node:*` / `curated:*` — **`coordinate_source` is still `'places'`** | non-Google ID | ❌ coordinate-only |
| 7 | Nominatim/OSM resolution (`placeResolver.js:451`) | `way:<id>`, `manual_lookup`, `wgs84` | ❌ coordinate-only |
| 8 | Curated seed (`placeResolver.js:29-128`) | `curated:*`, `curated` | ❌ coordinate-only |
| 9 | Manual panned pin (`MapTab.jsx:101-111`) | `provider_id` **NULL** — verified cleared, §6 | ❌ coordinate-only, exact pin |
| 10 | Estimated stop carrying a resolver-stamped ID (`stops.js:220-233`) | `google:*` **paired with different coordinates** | ❌ coordinate-only (RC-4) |
| 11 | Cache read, confidence < 0.7 (`placeResolver.js:280`) | `google:*` but `estimated` | ❌ coordinate-only |
| 12 | Legacy row, `coordinate_system = 'unknown'`, or pre-redesign curated row (§7) | ID may exist | ❌ coordinate-only |
| 13 | Unresolved, no coordinates | — | No link rendered at all (unchanged) |
| 14 | Any CN stop | — | Amap + GCJ-02; **never** `query_place_id` |
| 15 | Any KR stop | — | Naver + WGS-84; never `query_place_id` |

---

## 6. What the manual-pin path actually does

The pre-review hypothesis was that saving a manually panned pin might leave a stale Google Place ID behind. **It does not.** `MapTab.saveCorrection` (`MapTab.jsx:101-111`) omits `providerId`; the payload satisfies `trustedCoordinates` (`stops.js:149-153`) and returns through `preserveLocationFields` (`stops.js:119-133`), which resolves `providerId: input.providerId ?? null`. `writeUpdateStop` writes `provider_id = ?` unconditionally (`stops.js:603,634`). Confirmed in data: all 7 `user_pin` rows have `provider_id` NULL.

The same path also nulls `resolved_name`, `resolved_address`, and **`country_code`** — see G4.

The real stale-identity vectors are RC-4 and G5 below, neither of which was in the original list of suspicions.

---

## 7. Measured against the local dev database (53 stops with coordinates)

Read-only query, `backend/data/trippy.db`, 2026-07-25.

| Bucket (`provider_id` prefix / status / source / system) | Count |
|---|---|
| `way:*` / estimated / manual_lookup / wgs84 | 14 |
| NULL / estimated / — / unknown | 10 |
| NULL / user_confirmed / user_pin / **gcj02** | 7 |
| **`google:*` / resolved / places / wgs84 — SAFE** | **7** |
| NULL / unresolved / — / unknown | 5 |
| `way:*` / resolved / manual_lookup / wgs84 | 5 |
| `node:*` / estimated / manual_lookup / wgs84 | 4 |
| `curated:*` / user_confirmed / curated / **gcj02** (legacy, see below) | 2 |
| `node:*` / resolved / manual_lookup / wgs84 | 2 |
| NULL / estimated / discovery / unknown | 1 |
| `curated:*` / estimated / curated / wgs84 | 1 |

Derived facts:

- **Only 7 of 53 stops (13%) qualify for a named Google card** under §4 — but that headline number is an artefact of legacy data and must not be used for scoping. Split by era it is **7 of 14 (50%) for stops created under current code**, and **0 of 39** for pre-resolver stops. See §7b and decision D3.
- **RC-4 occurrences: 0.** The path exists; current data has not hit it. The invariant clause stays regardless.
- **`country_code` is NULL on 45 of 53 stops (85%).** The "Option C" stop-country precedence at `mapData.js:236` is therefore inert for most stops today — they already fall back to the day's country. This materially lowers the risk of the RC-3 parity fix, and raises the value of G4.
- **9 stops are stored `gcj02`**, all with `country_code` NULL — so Today picks their provider purely from the day's config. The RC-2 Today failure fires whenever one of those days derives to a non-CN country.
- **Stop-country vs day-seed-country mismatches: 0** in current data, so the HK-on-CN-day case in RC-2 is currently theoretical — but it is cheap to make structurally impossible, and the day's *derived* country (not the seed column measured here) is what actually selects tiles.
- **Legacy contamination is real and is contained by the prefix rule.** Two `curated:*` rows dated 2026-04-25 carry `location_status = 'user_confirmed'`, `coordinate_system = 'gcj02'`, `confidence 0.98` — values today's `CURATED_PLACES` cannot produce (it emits `estimated`/`wgs84`/`0.72`). These predate the maps redesign. Note the corollary: **`user_confirmed` does not reliably mean "a human placed this pin"** — any future logic that treats it as a proof of human intent will be subtly wrong on legacy rows.

---

## 7b. Legacy vs. live: which findings reproduce on a NEW trip

The owner correctly flagged that older trips predate implementations that were never backfilled, so a finding measured in data may already be fixed for new trips. Segmenting by creation date settles it.

**Era boundary, established from git (first commit that added each file):**

| Component | Landed |
|---|---|
| `placeResolver.js` (cached resolver, Google fallback, curated table) | 2026-04-28 `a1d15ae` |
| `mapData.js` (map payload, per-day config, Option C link provider) | 2026-04-28 `a4ec5ee` |
| `deepLink.js` | 2026-07-04 `57ca966` |
| `frontend/src/utils/coordinates.js` (the GCJ-02 twin) | 2026-07-05 `2ec3d1e` |
| Migration 019 (Google CN GCJ-02 repair) | 2026-07-08 `99e3455` |

**The two April trips (`Chengdu - Chongqing` 2026-04-24, `Ipoh - Kuala Lumpur` 2026-04-25) predate every one of those.** Their 39 stops were written before a place resolver, a map payload, or coordinate provenance existed. The three July trips (`Bali` 07-07, `Taipei - Kaohsiung` 07-08, `Shanghai - Hangzhou` 07-10) are current-code data.

| Bucket | Apr (legacy, 39 stops) | Jul (current, 14 stops) |
|---|---|---|
| `google:*` / resolved / places / wgs84 — **safe for `query_place_id`** | 0 | **7 (50%)** |
| OSM (`way:*`/`node:*`) | 20 | 5 |
| No identity, `coordinate_system = 'unknown'` | 11 | 0 |
| `user_pin` stored `gcj02` | 5 | 2 |
| `curated:*` | 3 | 0 |
| `country_code` NULL | 39 / 39 (100%) | 6 / 14 (43%) |

### Per-finding classification

| Finding | Verdict | Evidence |
|---|---|---|
| **RC-1** no `query_place_id` ever sent | **LIVE — and the majority case for new trips.** 50% of current-era stops qualify vs 0% of legacy. Fixing it is worth more than the 13% headline suggested. | `deepLink.js:10`; era split above |
| **RC-2** link uses tile datum, not link datum | **LIVE.** Two `gcj02` stops were created in July under current code (`SQ 832`, `West Lake`, both `user_pin` in the Shanghai–Hangzhou trip). `MapTab.saveCorrection` still writes `activeMapConfig.coordinateSystem`, so a pin on any CN day reproduces it today. | `MapTab.jsx:107`; `frontend/src/utils/coordinates.js:63-74` |
| **RC-2b** HK/MO/TW or KR stop on a mainland day | **LATENT-LIVE — structural, not data.** 0 rows in either era, but nothing prevents it; a new trip that adds a Hong Kong stop to a Shenzhen day hits it immediately. | `StopMarker.jsx:48` vs `mapData.js:236` |
| **RC-3** Maps-vs-Today provider parity | **LIVE.** Pure code shape, independent of data age. | `TodayTab.jsx:29` vs `mapData.js:236` |
| **RC-4** estimated stop stamped with a resolver's Google ID | **LATENT — 0 rows in either era.** Path is reachable in current code; the invariant clause is cheap insurance, not a repair. | `stops.js:220-233` |
| **G4** `country_code` wiped by picks and pins | **LIVE but narrower than the raw 85% suggests.** Current-era stops resolved by Google/Nominatim *do* carry a country (8/14); the NULLs are precisely the `user_pin` and unresolved rows. The wipe is real in current code. | `stops.js:119-133`; era split |
| **G6** Today links `unknown`-datum coordinates that Maps refuses to render | **LEGACY-DATA-ONLY.** All 11 unknown-datum stops are April; **zero** created since the resolver landed. Confirms the recommendation to leave it out of scope — but the *graceful degradation* must still be QA'd against the April trip. | era split; `coordinates.js:93-101` |
| Legacy `curated:*` rows with `user_confirmed` + `gcj02` + confidence 0.98 | **LEGACY-ONLY.** Today's `CURATED_PLACES` emits `estimated`/`wgs84`/`0.72`; these values are unreachable in current code. Contained automatically by the `google:` prefix rule. | §7; `placeResolver.js:29-44` |
| **G5** booking sync overwrites a user pin | **LIVE (code shape).** Independent of data age. | `stops.js:152` vs `:158` |

### What this changes about the plan

1. **Nothing in §9 is a legacy-only chase.** Every wave-1 and wave-2 item reproduces on current code; only G6 and the odd curated rows are legacy, and both were already out of scope.
2. **No backfill is needed or proposed.** Legacy stops simply fail the §4 invariant and degrade to coordinate-only links — which is the correct behavior for them anyway, since they genuinely have no trustworthy identity. That is the fix working as designed, not a gap.
3. **The QA matrix must be split by era** so we prove both halves: current-code stops gain names, legacy stops stay precise and unnamed. See §10.

---

## 8. Gotchas, regressions, and must-stay-coordinate-only cases

- **G1 — The place ID wins, so a wrong ID moves the destination.** Mitigation is the tight invariant plus a permanently-present `query=lat,lng`. No Places refresh calls (cost); Google's 12-month refresh advice is acknowledged and deliberately not adopted.
- **G2 — Never put a name in `query`.** Keeping `query` as exact coordinates is what preserves "retains the exact destination" for every row in §5.
- **G3 — Gate on the `provider_id` prefix, never on `coordinate_source`** (§4).
- **G4 — `country_code` is wiped by Google picks and by manual pins.** `preserveLocationFields` sets `countryCode: input.countryCode ?? null`, and neither `MapTab.handlePickResult` nor `AddPlaceModal` forwards the `countryCode` that `lookupHotelDetails` already returns (`lookups.js:164`). After a pick or a pin the stop loses its own country and the link provider falls back to the day's. Separate defect; it becomes more visible once Today becomes country-driven. See decision D2.
- **G5 — Booking sync outranks a user pin.** In `resolveLocationForStop`, the `trustedCoordinates` early return (`stops.js:152`) precedes the `protectedUserPin` check (`stops.js:158`). A booking re-save carrying `details.placeId` therefore overwrites a `user_confirmed` pin **and** reinstates a `google:` identity. This is the true "stale Google identity beats the user's pin" vector. Pre-existing and out of scope here; must appear in the QA matrix so we prove the ID/coordinate pairing stays internally consistent. See decision D4.
- **G6 — Today links where Maps refuses to render.** The backend returns `canRenderMarker: false` for `coordinate_system === 'unknown'` when not estimated (`coordinates.js:93-101`); the frontend twin has no equivalent guard, so `NavigateIcon` will link unknown-datum coordinates. Flagged, out of scope, must not regress.
- **G7 — Sharing.** `share.js` exposes `lat` only, no `providerId`, and the public route renders neither `OpenInMapsButton` nor `NavigateIcon`. Any new derived field must not leak into the share payload.
- **G8 — Two same-named functions with different return shapes.** `NavigateIcon.jsx:11` destructures `{ lat, lng }`; the *backend* `toDisplayCoordinates` returns `displayLat/displayLng`. It works only because the frontend twin returns a differently-shaped object. A live trap for whoever edits the conversion helpers.
- **G9 — No new provider spend.** Everything proposed reads columns already persisted. Zero additional Places / Nominatim / Amap calls.

---

## 9. Recommended smallest coherent scope

One plan, three waves. No migration. No new external calls.

**W1 — Precision and parity (pure correctness, no payload additions).**
Derive link coordinates from the **deep-link provider's** datum (`amap → gcj02`; `google`/`naver → wgs84`) rather than the tile provider's. Add the missing `gcj02 → wgs84` branch to `frontend/src/utils/coordinates.js`. Add `countryCode` to `trips.js mapStop` and extract the stop-country→day-fallback precedence into one shared helper both surfaces call, so Maps and Today cannot drift again. Fixes RC-2 and RC-3 together.

**W2 — Place identity (additive payload).**
Put the §4 invariant in exactly **one** backend helper and expose a single derived, nullable `googlePlaceId` (bare ID, no `google:` prefix) from *both* `formatMapStop` and `trips.js mapStop`. The frontend never re-derives the invariant. Extend `buildDeepLink(provider, lat, lng, label, googlePlaceId)` to append `&query_place_id` for `google` only, when present. `query=<lat>,<lng>` is always emitted.

**W3 — Verification** (§10).

**Explicitly out of scope:** any Places refresh call; any migration; G5 (booking sync overriding a user pin); G6 (the `unknown`-datum asymmetry); any backfill that would upgrade OSM/no-identity stops to Google identities.

---

## 10. Required tests and manual QA matrix

### New frontend unit — `frontend/src/utils/deepLink.test.js`
This file does not exist; `buildDeepLink` currently has **zero** direct coverage.

1. `google` + valid ID → `?api=1&query=<lat>,<lng>&query_place_id=<id>`, `query` present;
2. `google` + null ID → today's exact URL byte-for-byte (no-regression anchor);
3. `amap` + ID present → ID absent from the URL;
4. `naver` + ID present → ID absent;
5. ID containing URL-unsafe characters → encoded;
6. coordinate precision neither truncated nor rounded.

### Frontend unit — `coordinates` helper
`gcj02 → wgs84` inverse; a `gcj02` stop under a `gcj02` target is **not** double-converted; a `wgs84` stop under `wgs84` is untouched; round-trip agreement with the backend for a known Chongqing coordinate.

### Backend unit — the invariant predicate
One case per row 1–15 of §5: `googlePlaceId` is the bare ID for rows 1–5 and `null` for rows 6–13. Must explicitly include row 6 (`coordinate_source === 'places'` + `way:123` → null) and row 10 (`estimated` + `google:*` → null).

### Backend integration — extend `backend/tests/locationIntegration.test.js`
- HK stop on a CN-derived day → provider `google`, link coordinates **WGS-84** (not the GCJ-02 display pair);
- KR stop on a CN-derived day → provider `naver`, WGS-84;
- CN stop on a JP day → `amap` + GCJ-02, `googlePlaceId` null;
- **Maps-vs-Today parity:** the same stop yields identical provider, identical link coordinates, and identical `googlePlaceId` from `/map-data` and from `GET /trips/:id/days`;
- **Stale-ID-after-manual-pin:** create a Google-picked stop (ID present) → save a panned pin → assert `provider_id` NULL **and** `googlePlaceId` null;
- **G5 probe:** pin a booking-linked hotel stop, re-save the booking, assert coordinates and `provider_id` remain a consistent pair (documents current behavior even if unchanged).

### Manual QA — 375px first, then desktop; every row exercised in **both** the Maps popup and Today
Owner runs the production pass per house convention; the agent verifies locally first.

**The matrix is deliberately split by data era (§7b).** Use a July trip (`Bali`, `Taipei - Kaohsiung`, or `Shanghai - Hangzhou`) for the current-code rows and an April trip (`Chengdu - Chongqing`) for the legacy rows. Passing only one half proves nothing: the current-code half proves stops gain real names, the legacy half proves untrustworthy rows stay precise and unnamed rather than being misrepresented.

**Legacy-era rows (`Chengdu - Chongqing`, created 2026-04-24 — predates the place resolver):**

| Case | Expected |
|---|---|
| Legacy `unknown`-datum stop (11 exist) | dropped pin, or no link — never a named place, never a shifted pin |
| Legacy `curated:*` row with `user_confirmed` + `gcj02` (`Luohan Temple`, `Chaotianmen Dock`) | Amap, pin exactly where it is today — the `user_confirmed`/`gcj02` combination must not be mistaken for a human pin or double-converted |
| Legacy OSM-resolved stop | dropped pin at exact coordinates, no wrong name |
| Legacy `user_pin` `gcj02` stop (`Waldorf Astoria Chengdu`, `SQ 842`) | correct app for the day, pin unmoved from today's position |

**Current-code rows (a July trip):**

| Case | Expected |
|---|---|
| Google-picked museum (Add Place) | Google opens the **named place card**, correct pin |
| Discovery place verified via Google | named place card |
| Discovery place verified via OSM (`way:*`) | dropped pin at exact coordinates, no wrong name |
| Manually panned pin (newly created) | dropped pin exactly where the user set it |
| Newly pinned stop on a CN day, then viewed from Today | Amap, pin unshifted — the RC-2 regression check, reproducible today |
| "Check location" → picked Google result | named place card |
| Hotel booking with `placeId` | named hotel card |
| Estimated stop (row 10) | dropped pin at the stop's own coordinates, **not** the resolver's place |
| CN stop | Amap opens, pin correct |
| HK stop on a mainland day | Google, pin on the correct HK building (RC-2 regression check) |
| KR stop on a mainland day | Naver, correct pin |
| Same stop, Maps then Today | same app, same pin, same name |

---

## 11. Owner decisions — RESOLVED 2026-07-25

- **D1 — Wave packaging: APPROVED as recommended.** One plan; W1 = precision/parity, W2 = place identity, W3 = verification. Single deploy (no migration, no new external calls).
- **D2 — G4 `country_code` forwarding: APPROVED, folded into W1.** Forward the `countryCode` that `lookupHotelDetails` already returns from the Map "Check location" pick and from Add Place, and stop nulling it on a manual pin.
- **D3 — Expectation setting: ACCEPTED, no identity-upgrade backfill.** Revised by the era analysis (§7b): the payoff is **50% of stops created under current code**, not the 13% all-data figure. Legacy stops correctly degrade to coordinate-only. Split out as its own exploration only if the owner later wants OSM stops upgraded to Google identities, which would cost Places calls and needs a separate budget decision.
- **D4 — G5 booking sync overwriting a user pin: SPLIT OUT.** Not folded into this plan. It changes write precedence, needs its own investigation and QA pass, and is orthogonal to deep links. Tracked as a follow-up.

**Additional owner constraint (2026-07-25):** older trips predate implementations that were deliberately never backfilled, so no finding may be treated as live without checking whether current code still produces it. §7b is the response — every wave-1/wave-2 item was verified to reproduce on current-code data, G6 and the odd `curated:*` rows were confirmed legacy-only and remain out of scope, and no backfill is proposed.
