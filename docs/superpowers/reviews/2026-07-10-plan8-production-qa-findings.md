# Plan 8 Production QA — Findings (2026-07-10)

**Status: FINDINGS DELIVERED — awaiting owner approval before any fix work. Investigation only; no production data or code was modified.**

**Scope:** post-deploy validation of
[Implementation Plan 8](../plans/Implementation%20Plan%208%20Destination%20Scopes%20and%20Geography%20Identity.md)
against the owner's Shanghai–Hangzhou production test trip
(`d2813bc528519dfaa90c6ae8be5a17b0`, created 2026-07-09 14:08).

All claims below are grounded in this session's evidence: read-only production DB queries,
a derivation replay through the deployed `listDaysForTrip`, production container logs, and
line-level code traces of the deployed source (local `main` == deployed).

---

## Verdict

Plan 8's machinery is **working as designed** — promotion ladder, resolution anchors,
demotion log, scope healing (Bali/Kaohsiung), ISO chips, anchor-biased stop resolution, and
map-pin accuracy all verified in production. But the deployment surfaced **one new bug the
plan didn't anticipate** (Google Place Details returning CJK address components because the
details call — unlike every autocomplete call — sends no `languageCode`), **one design gap**
(the second destination chip of a multi-city trip is discarded at creation, so it never
becomes a trip scope), and confirmed **one pre-existing frontend bug** (unguarded
last-response-wins refetch race) plus **one W6 cleanup regression** (the `kualalumpur|''`
catalogue twin re-created itself because the KL trip's day seeds have `city_country: NULL`).

---

## Raw production state (the trip)

- **Days:** all 7 days seed `city: "Shanghai", city_country: "CN"`. No overrides. The
  "Hangzhou" chip picked at creation exists **nowhere** — `createTrip` seeds every day with
  `destinations[0]` only (`trips.js:487,514-525`) and destinations are derived from days, so
  chip #2 is discarded. → `tripScopes` = `["Shanghai"]` only.
- **Shanghai hotel** (`Shanghai the Bund W Hotels`): `locality: null`,
  `sublocality: "Hong Kou Qu"`, `aal1: "Shang Hai Shi"`, `countryCode: "CN"` — romanized.
- **Hangzhou hotel** (`Park Hyatt Hangzhou`): `locality: "杭州市"`, `sublocality: "拱墅区"`,
  `aal1: "浙江省"`, `countryCode: "CN"` — **CJK**.
- **Deployed derivation replay:** Jul 26–28 resolve `Shanghai` (anchor `Hong Kou Qu`);
  Jul 29–31 resolve `杭州市` (anchor `拱墅区`); Aug 1 resolves `杭州市` via previous-day carry.
- **Derived trip summary:** `destinations: ["Shanghai", "杭州市"]` — the CJK label reaches
  trip cards, Edit Trip chips, share view, and importer/copilot context.
- **Discovery catalogue:** new row `杭州市|CN` (83 places, generated Jul 9 14:15 — a real
  Claude generation keyed under CJK, split from any future `hangzhou|CN`). Log line:
  `[discover] destination=杭州市, China (CN)`.
- **Stops:** all 19 persisted with correct coordinates. Every stop has an Unsplash photo
  **except** the Park Hyatt Hangzhou hotel stop (`unsplash_photo_url: NULL`).
- **Logs:** demotion warns fire only for the two Bali fragment bookings (expected). No
  demotions for this trip — both hotels promoted. `Hangzhou Old City` was POSTed twice
  (two inserts; only one row remains — inferred manual delete of a duplicate during
  testing, consistent with the issue-3 UI staleness).

---

## Issue 1 — Hangzhou day headers show `杭州市`

**Root cause (two independent contributors):**

1. **Missing `languageCode` on the Place Details call.** `lookupHotelDetails`
   (`backend/src/services/lookups.js:118-127`) sends no `languageCode` param, while all
   three autocomplete calls send `languageCode: 'en'` (`lookups.js:31,80,229`). That's why
   the *suggestion text* was English ("Park Hyatt Hangzhou, Gongshu District, Hangzhou…")
   but the stored `addressComponents` came back in local script. Google's per-place default
   language is inconsistent — the Shanghai hotel happened to return romanized components,
   Hangzhou returned CJK.
2. **The Hangzhou chip never became a trip scope.** `createTrip` seeds all days from
   `destinations[0]`; chip #2 is discarded (`trips.js:487,514-525` — pre-existing Plan 6
   behavior, but Plan 8's rule 1 depends on scopes built from day seeds + overrides, so
   the ladder had no "Hangzhou" scope to promote to).

**Mechanics through the W2 ladder (behaving exactly per spec):** Hangzhou evidence `杭州市`
fails rule 1 (no Hangzhou scope; cross-script keys can't match anyway), is a genuine Google
`locality` → rule 2 promotes it **verbatim**. Shanghai only stayed "Shanghai" by luck:
romanized AAL1 `"Shang Hai Shi"` + rule 1's `shi` suffix-strip matched the seed scope.

**Scope separation check (owner's question):** anchors (`拱墅区`) and provider place
identity (placeId, WGS-84 coords) are **correctly separated**. Display scope and Discovery
scope are by design the same value — so the CJK label polluted both: day headers, trip
summary, share, importer context, **and** the Discovery catalogue key (`杭州市|CN`).

**Verdict:** bug — but in the **write path** (W3's contract implicitly assumed
Latin/English evidence), not in the ladder. "Shanghai on every day" before bookings is
expected under current design (single-seed creation), though it's a product-quality gap for
multi-city trips. Severity: **high** (violates Plan 8's stated goal of traveler-facing
display identity; pollutes the shared catalogue; costs duplicate Claude generations).

## Issue 2 — Is manually editing `杭州市` → `Hangzhou` safe?

**Yes — safe, coherent, reversible.** The override pipeline is fully plumbed:

- `PATCH /trips/:id/days/:date` accepts only `cityOverride`; the backend **auto-resolves
  and stores `city_override_country`** via `resolveOverrideCountry` (`trips.js:813-840`) —
  "Hangzhou" will resolve to `CN`.
- `deriveDayGeo` layer 1 wins for that day; **later days without their own
  hotel/transit/override evidence inherit it** via previous-day carry (Aug 1 will heal
  automatically once Jul 31 is overridden; but Jul 29/30/31 each have the CJK hotel active,
  so **each of the three hotel nights needs its own edit** — the hotel layer outranks
  previous-day carry).
- Every consumer reads through the same resolved pipeline (verified per consumer): trip
  summary/chips, Discovery default (will key `hangzhou|CN` — one fresh, cheap catalogue
  generation since no such row exists), stop-resolution bias, photo queries for *future*
  stops, map labels **and** per-day map provider selection (driven by the auto-resolved
  override country), share view, importer/copilot context, all frontend labels.
- Reversible: clearing the field saves `NULL` and falls back to lower layers.
- Side effect (benign→useful): overrides join `buildTripScopes`, so "Hangzhou" becomes a
  scope and future English-evidence bookings can promote via rule 1.

**What it does NOT fix:** the booking's stored CJK `details_json` (still the source next
time evidence is read — but the override outranks it), the missing Park Hyatt stop photo
(no automatic photo refresh on override), and the orphaned `杭州市|CN` catalogue row.

## Issue 3 — Discovery/Plan state loss until browser refresh

**Root cause (CONFIRMED, frontend-only):** unguarded last-response-wins race in
`useTrip.refresh` (`frontend/src/hooks/useTrip.js:23-43`). Every mutation
(`useStops`/`useBookings` → `onChanged()`) triggers a full `GET /api/trips/:id/detail`
whose response **unconditionally replaces** the whole `{trip, days, bookings}` state — no
request token, no AbortController, no staleness check. Rapid Discovery adds or stop moves
(nothing disables the affordances while in flight: `DayPicker.jsx:100`,
`StopCard.jsx:225`, `PlanTab.jsx:48` fire-and-forget) put multiple refreshes in flight;
when an older response resolves last it clobbers state with a stale snapshot — which, in a
session where all stops were just added, renders "most days empty". Browser refresh fixes
it because a lone request has nothing to race.

Backend ruled out: `getTripDetail` is synchronous better-sqlite3, always returns complete
days+stops; all 19 stops persisted (server logs show the double-POST of `Hangzhou Old
City` — the user retrying an add the UI didn't reflect).

**Verdict:** pre-existing frontend architecture bug, **not** a Plan 8 violation; Plan 8's
extra Discovery traffic made it easier to trigger. Severity: **medium-high** (data looks
lost; provokes duplicate adds).

## Issue 4 — Hotel card images (Shanghai has one, Hangzhou doesn't)

- The Logistics-tab `HotelBookingCard` has **no image capability at all** (never built);
  the photo the owner sees is on the **Plan/Timeline hotel stop card**
  (`StopCard.jsx:79-83`, `stop.unsplash_photo_url`).
- The Park Hyatt stop's photo is NULL because `resolvePhotoUrl` built the Unsplash query
  from the resolved city: `"Park Hyatt Hangzhou 杭州市 hotel"` (`stops.js:50-66,354-361`) —
  mixed-script query, no results — and the `try { } catch { return null; }` at
  `stops.js:318-333` **swallows the failure with zero logging** (violates the repo's
  fail-loudly rule). Shanghai's query was clean ("Shanghai" already in the title).
  Discovery-added activity stops are unaffected because they carry catalogue photo URLs.
- Historical "some hotels have images, some don't" is the same fragility: any hotel whose
  resolved city string doesn't help the Unsplash query silently gets nothing.

**Verdict:** bug (same `languageCode` root cause as issue 1, plus a silent-catch
anti-pattern), not expected provider behavior. Severity: **low-medium** (cosmetic), but the
silent catch hides all photo-pipeline failures. Which result Unsplash actually returned is
*inferred* (the catch destroys the evidence) — the mechanism is confirmed in code.

## Issue 5 — Map pins (positive check): VALIDATED

All 19 stops carry accurate WGS-84 coordinates (Shanghai cluster ~31.23/121.47, Hangzhou
~30.24/120.15; spot-checked landmarks match reality). The GCJ-02→WGS-84 conversion for
mainland-China Places results is in the hotel lookup path (`lookups.js:141-152`) and both
hotels' stored coordinates are correct.

## Bonus finding — W6 cleanup regression (`kualalumpur|''` twin is back)

Migration 021 deleted the empty-country KL twin and stamped the survivor to `MY`, but the
**KL trip's `days.city_country` is NULL** (trip predates country-coded seeds; W6's "fully
clean" check covered non-null values only). On Jul 9 15:37 a Discovery call
(`[discover] destination=kuala lumpur existingStops=0`) recreated `kualalumpur|''` with a
fresh 173-place generation. Cleanup without fixing the *source* (null seed countries)
re-pollutes. Severity: **medium** (duplicate catalogue rows + duplicate Claude spend).

---

## What Plan 8 got right (verified in production this session)

- Promotion ladder + rule evaluation exactly per spec (including the F3/F4-style paths).
- Bali/Kaohsiung healing live; demotion warns fire only for the two Bali fragment bookings.
- Resolution anchors populated and separated (`Hong Kou Qu`, `拱墅区`), country always
  contributed (fact-4 fix works — both hotels stored `countryCode`).
- Trip summary/destinations derivation heals from resolved days.
- Catalogue keys canonical for Latin inputs; migrations 021/022 applied cleanly.
- Map pins + GCJ-02 handling.

---

## Next implementation plan — outline (Plan 9: Geography Language Identity & Client State Integrity)

**W1 — English-language place evidence (root fix for issues 1 & 4).**
Add `languageCode=en` to the Place Details request in `lookupHotelDetails`
(query param on `lookups.js:118-120`). Regression tests with mocked CJK-vs-en payloads.
Consider the same audit for `placeResolver.js`'s Google calls.

**W2 — Destination chips become durable trip scopes (design decision required).**
Options to decide with owner before implementation: (a) persist chips at creation
(re-introduce a minimal stored scope list — the thing Plan 8 §1 deliberately avoided;
revisit now that a real consumer exists), or (b) seed days across destinations
(e.g. first N days city A, rest city B), or (c) both. Must make rule 1 able to promote to
*any* chip of a multi-city trip. Includes UX for "trip shows only city #1 until bookings
exist".

**W3 — Frontend refresh sequencing (issue 3).**
Monotonic request-id (or AbortController) guard in `useTrip.refresh` so only the newest
in-flight `GET /detail` response is applied; disable add/move affordances while their own
mutation is in flight (SuggestionCard/DayPicker/StopCard) as defense in depth.

**W4 — Photo pipeline honesty (issue 4 remainder).**
Log (`console.warn`) on `resolvePhotoUrl` failure instead of silent null; re-fetch photo
when a stop's day geography changes materially, or provide a manual "refresh photo" path;
one-off backfill for the Park Hyatt stop after W1.

**W5 — Data repair + re-cleanup (bonus finding + issue 1 residue).**
Migration/script: stamp NULL `days.city_country` from derivable evidence (KL → MY); delete
the re-created `kualalumpur|''` twin; dispose of the `杭州市|CN` catalogue row (delete —
regenerates as `hangzhou|CN` for pennies); repair the Park Hyatt booking's CJK
`details_json` fields (or owner re-picks the hotel after W1). Guard: Discovery route
falls back to trip-level country when day country is null, so twins can't regenerate.

**W6 — Production verification.**
Re-run this session's checks: derivation replay shows `Hangzhou`; catalogue has no CJK or
empty-country keys for Latin-scope trips; rapid add/move in Plan produces no state loss at
375 px; hotel stop photos present for both cities.

**Interim owner action (safe today):** manually override the three Hangzhou hotel-night day
headers (Jul 29/30/31) to `Hangzhou` — Aug 1 heals via carry. Effects enumerated under
issue 2; fully reversible.
