# Implementation Plan 4 — UX Sweep Fixes

Findings report from the 2026-07-05 app-wide UX/UI sweep, approved for implementation.
This document is the source of truth for batch status — update the status table below as
waves land, so any session (or usage-limit reset) can resume from here without re-discovery.

## Batch status

| Wave | Batch | Items | Status |
|------|-------|-------|--------|
| 1 | 1. Timezone | C1 + originTz day-wrap tests | verified (2026-07-05, frontend 20/20 + backend 186/186) |
| 2 | 2. Modal scroll + confirms | H1, M4 | verified (2026-07-05, 375px preview: sheet/modal scroll + two-step confirms + inline error on real 429) |
| 2 | 3. Stream/state machine | C3, L2 | verified (2026-07-05, live 401 stream error → input unlocks, error surfaced; done-after-error dedup guarded client-side) |
| 3 | 4. PWA/nav | C2, L9 | verified (2026-07-05, map-config rule confirmed in built sw.js; C2 session-guard code-reviewed — standalone mode not emulatable in preview) |
| 3 | 5. Error surfacing + share link | H2, M7, L4, M3 | verified (2026-07-05, live backend-down move → shared ErrorBanner, no silent divergence; share link persists across modal reopen; backend 189/189) |
| 4 | 6. Discovery | H3 (+Q3 improvements), M1, M6, L5, L11 | verified (2026-07-05, backend 197/197 incl. no-exclusion + TZ + merge-on-refresh tests; 375px preview: no mid-keystroke flicker, "— verify" hours badges, DayPicker Escape/labels; stale-refresh stream contract fixed to deliver merged breadth) |
| 5 | 7. Today/map | H4, M2, L1, L3, L7 | pending |
| 5 | 8. Stragglers | M5, L6, L8, L10, L12 | pending |

Pacing rule: one wave at a time, max 2 agents in flight (frontend-heavy + backend-heavy).
After each wave: backend `npm test`, frontend build, 375px preview pass, update this table, commit.

---

## Context
Systematic hunt for silent failure modes, dead affordances, mobile breakage, and workflow
dead-ends across all tabs, post commit 265f16a (location-resolution overhaul). Investigation
only — nothing implemented. Each finding: severity, root cause, proposed fix. Approve
item-by-item; approved fixes get delegated to Sonnet/Opus subagents with self-contained specs.

Verified by reading every page/hook/service and all major components, executing the suspect
date-conversion code in Node, and cross-checking backend SSE/cache/share routes.

---

## CRITICAL

### C1. `naiveIsoToAbsolute` is off by 24 hours whenever the day wraps in the target timezone
- **Where:** [date.js:14-28](frontend/src/utils/date.js) — used by `todayModel.bookingInstant` and ALL booking-card date/time formatting ([bookingCardUtils.js](frontend/src/components/logistics/bookingCardUtils.js) → Flight/Train/Hotel/Other cards + ExtractedBookingCard).
- **Root cause:** offset is computed from hour/minute only; the calendar-day component of the tz-formatted instant is ignored. Verified in Node:
  - `18:30 Asia/Shanghai` → instant **+24h late** (any wall-clock ≥16:00 in UTC+8; ≥15:00 in UTC+9)
  - `01:00 America/New_York` → instant **24h early**
- **User impact:** (a) Logistics cards show the **wrong calendar date** for evening flights/trains and for hotel check-ins ≥16:00 in Asia (time renders correctly, date is +1 day — the exact market this app targets). (b) Today tab anchor `passed` flags are a day off → evening flight stays "hero" all next day / collapse logic wrong.
- **Fix:** compute the diff against the full formatted date (`Date.UTC(get('year'), get('month')-1, get('day'), get('hour'), get('minute'))`), not hour/minute alone. Add `originTz` day-wrap cases to `todayModel.test.js` — **zero originTz tests exist today**, which is why 186/186 passes.

### C2. Installed PWA can never reach the trips list (workflow dead-end)
- **Where:** [TripsHomePage.jsx:51-57](frontend/src/pages/TripsHomePage.jsx)
- **Root cause:** the "resume last trip" redirect fires on **every** mount in standalone mode, not just app launch. TopBar "← Trips" → TripsHomePage mounts → instantly bounced back to `lastTripId/plan`.
- **User impact:** in the installed app you cannot switch trips, view past trips, or create a new trip. Invisible in browser testing.
- **Fix:** run the redirect once per app session (`sessionStorage` flag set after first redirect), keep current behavior for cold launch.

### C3. Co-pilot permanently locks up after any stream error
- **Where:** [useCopilot.js:34-60](frontend/src/hooks/useCopilot.js) + [claude.js:341](backend/src/services/claude.js)
- **Root cause:** `streaming` is only reset by the `done` chunk. The backend error path writes `{type:'error'}` then ends **without** `done`; a dropped connection sends neither. The stream promise resolves normally → no cleanup runs. State lives in TripPage, so closing/reopening the panel doesn't help.
- **User impact:** after one copilot error, the input is disabled until a full page reload; "Stop" button no-ops.
- **Fix:** reset `streaming`/`streamingText` in a `finally` after `copilotApi.send` resolves; treat the `error` chunk as terminal. Optionally also write `done` after `error` server-side.

---

## HIGH

### H1. Four modals have no scroll containment — forms unreachable at 375px
- **Where:** [AddBookingModal.jsx:512](frontend/src/components/logistics/AddBookingModal.jsx), [EditTripModal.jsx:36](frontend/src/components/trips/EditTripModal.jsx), [AddPlaceModal.jsx:169](frontend/src/components/timeline/AddPlaceModal.jsx), Logistics detail sheet ([LogisticsTab.jsx:144](frontend/src/pages/LogisticsTab.jsx)). NewTripModal and CaptureFlow already do it right (`max-h-[85vh] overflow-y-auto`).
- **Root cause:** `fixed inset-0` + `items-end` wrapper with an unconstrained child: content taller than the viewport overflows upward with no scrolling mechanism.
- **User impact:** flight/train forms (~12 fields + tz selects) on a phone: top fields (or Save) physically unreachable. Train form is the worst offender.
- **Fix:** apply the CaptureFlow pattern (`max-h-[85vh] overflow-y-auto` on inner container) to all four.

### H2. Stop mutations fail silently everywhere (reorder/move/delete/note/pin-correction)
- **Where:** `useStops.error` is never rendered; [PlanTab.jsx](frontend/src/pages/PlanTab.jsx) handlers await without catch; [Timeline.jsx:102-105](frontend/src/components/timeline/Timeline.jsx) keeps the optimistic order on failed reorder (no revert/refetch); StopCard/TransitStop `handleNoteBlur` clears `noteDirty` **before** the await, so a failed note save is silently lost on next refresh; [TripPage.jsx:54-74](frontend/src/pages/TripPage.jsx) `handleDelete`/`handleEditSave` are try/finally with no catch; MapTab `saveCorrection` same pattern.
- **User impact:** on flaky hotel wifi (the core usage context), reorders/notes/moves appear saved but aren't; UI and DB silently diverge until next reload.
- **Fix:** one shared error surface (inline banner or small toast in trip layout) fed by `useStops`/`useBookings` error state; on reorder failure re-sync from server; move `noteDirty=false` after successful await.

### H3. Global discovery cache is polluted by per-trip exclusions (known lead #2 — confirmed)
- **Where:** [discovery.js:124-159](backend/src/routes/discovery.js)
- **Root cause:** cache-miss generation passes the requesting trip's stop titles as Claude exclusions, then stores the result in `global_discovery_cache` shared by all users for 7 days. "Show more" merges more per-trip-shaped output into the same row.
- **User impact:** first user to ask about a city silently shapes (and shrinks) what everyone else sees; famous landmarks the first user already added never appear for anyone.
- **Fix:** generate for the global cache **without** trip exclusions; filter trip-owned items at serve/display time (frontend already has `normalizeName`-based "In trip" matching; `showMore` already dedupes client-side).

### H4. Today tab deep links ignore GCJ-02 (China nav ~300–500m off)
- **Where:** [NavigateIcon.jsx](frontend/src/components/today/NavigateIcon.jsx) consumers pass raw `stop.lat/lng` from trip detail; Map tab correctly uses backend-converted `displayLat/displayLng` ([mapData.js:104-107](backend/src/services/mapData.js)).
- **User impact:** with AMap as provider, Today-tab navigation buttons open pins offset by hundreds of meters — during the trip, when it matters most.
- **Fix:** either surface `displayLat/displayLng` (per map config) in trip detail stops, or port `wgs84ToGcj02` to the frontend and convert in `buildDeepLink` when provider is `amap`.

---

## MEDIUM

### M1. DiscoveryPanel: stale default destination + live-input flicker (known lead #1 + extension)
[DiscoveryPanel.jsx:248-266](frontend/src/components/discovery/DiscoveryPanel.jsx). Mount-only `discover()`; also `destination` doubles as the input draft AND the state lookup key — while editing the field, `getDestination(partialText)` returns the empty entry so the hero/results/search box vanish mid-keystroke. **Fix:** split `committedDestination` from input draft; recompute default when `activeDay` changes or panel opens.

### M2. Hotel-hero evening state loses navigation to the hotel
[todayModel.js:173-177](frontend/src/utils/todayModel.js) builds hotel hero without `stop`; [TodayTab.jsx:71](frontend/src/pages/TodayTab.jsx) suppresses TonightCard when hotel is hero → NavigateIcon (needs stop coords) disappears exactly when you're heading to the hotel. **Fix:** attach `tonightStop` to the hotel hero item.

### M3. Existing share link invisible on modal reopen
[useCollaboration.js](frontend/src/hooks/useCollaboration.js) never loads the current link; backend `createShareLink` is idempotent but there's no GET. UI always shows "Create share link" — owner can't see a live public link exists, can't copy/revoke without "creating." **Fix:** include share-link state in the collaborators payload (or add GET) and hydrate the hook.

### M4. Destructive actions without confirmation, inconsistently
Logistics detail sheet **Delete Booking** is one tap (Plan tab remove = two-step; trip delete = two-step). Admin panel **Remove user** is one tap. Both also lack error surfacing on failure. **Fix:** two-step confirm pattern (already established in StopCard) + error text.

### M5. DayHeader rules-of-hooks violation (latent crash)
[DayHeader.jsx:11](frontend/src/components/timeline/DayHeader.jsx) — `if (!day) return null` **before** `useEffect`. A trip with zero days that later gains days changes the hook count → React throws. **Fix:** move the early return below hooks.

### M6. Discovery cache TTL compared in wrong timezone
[discovery.js:101-104](backend/src/routes/discovery.js) — `fetched_at` stored via SQLite `datetime('now')` (UTC, no marker), parsed with `new Date()` (local). Correct only while the server runs UTC. Docker host may be, but it's a latent footgun also present anywhere else `datetime('now')` round-trips through `new Date`. **Fix:** compare in SQL (`julianday`) or store/parse with explicit `Z`.

### M7. Capture-into-new-trip import failure is silent
[TripsHomePage.jsx:71-75](frontend/src/pages/TripsHomePage.jsx) — trip is created, booking confirm fails → `console.error` only; user lands on empty Logistics with no explanation (comment acknowledges recoverability but user is never told). **Fix:** pass a flag/message into navigation state and show a banner on Logistics ("We saved your trip but couldn't import the bookings — try Add bookings again").

---

## LOW (quick wins / polish)

- **L1.** StatusPill re-fetches flight status (paid AeroDataBox call) on every Today-tab visit — component remounts per tab switch; no session cache or min-interval. Also "Status unavailable" conflates network failure with "provider has no data", and the checked-at timestamp only renders on success. [StatusPill.jsx:40-43](frontend/src/components/today/StatusPill.jsx)
- **L2.** Copilot **Stop** silently discards the partial assistant response (user bubble stays, reply vanishes; server may still persist its accumulated text → history mismatch on reload). [useCopilot.js:53-56](frontend/src/hooks/useCopilot.js)
- **L3.** TransitStop renders a bare sequence number where a time belongs (`stop.time || index+1` → "1" styled as a time). [TransitStop.jsx:94](frontend/src/components/timeline/TransitStop.jsx)
- **L4.** TripsHomePage `error` never cleared on successful reload; Logistics header reads "0 bookings across 1 sources" when empty and has no empty-state CTA styling ("across N sources" is fabricated by `|| 1`). [TripsHomePage.jsx:35-45](frontend/src/pages/TripsHomePage.jsx), [LogisticsTab.jsx:96](frontend/src/pages/LogisticsTab.jsx)
- **L5.** DayPicker popover: position computed once (detaches from anchor when the panel scrolls), closes on `mousedown` only, and the no-date fallback label prints a raw DB id (`day.day_number ?? day.id` — `day_number` doesn't exist in the frontend shape). [DayPicker.jsx:15-38,73](frontend/src/components/discovery/DayPicker.jsx)
- **L6.** MutationPreview `move_stop` row says "Move stop to Sat 6" without naming which stop (`resolveStopLabel` exists but isn't used for move). [MutationPreview.jsx:63-82](frontend/src/components/copilot/MutationPreview.jsx)
- **L7.** Map `fitBounds` on a single-pin day zooms to max (street-level disorientation). Add `maxZoom` option. [TripMap.jsx:12-20](frontend/src/components/map/TripMap.jsx)
- **L8.** AddPlaceModal biases place search with `day.city` before `resolvedCity` — opposite priority from DiscoveryPanel/MapTab. [AddPlaceModal.jsx:32](frontend/src/components/timeline/AddPlaceModal.jsx)
- **L9.** Offline PWA: `/api/map/:id/config` isn't in the SW runtime cache, so offline Today falls back to Google Maps deep links even when AMap is configured (worst in China). Add it to `runtimeCaching`. [vite.config.js:39-101](frontend/vite.config.js)
- **L10.** DocumentViewer uses `<embed type="application/pdf">` — unreliable in iOS Safari standalone PWA (often blank). Consider iframe/object fallback + "open in new tab" affordance. [DocumentViewer.jsx:22](frontend/src/components/documents/DocumentViewer.jsx)
- **L11.** SuggestionCard "In trip" matching is by normalized title across **all** days — generic names ("Old Town") false-positive and permanently disable Add for unrelated places. [SuggestionCard.jsx:27-35](frontend/src/components/discovery/SuggestionCard.jsx)
- **L12.** Closing CaptureFlow mid-extraction abandons the request with no warning; review drafts are lost on Close with no confirm.

## Product decisions (answered by owner, 2026-07-05)
- **Q1 (booking type locked in edit) / Q2 (destinations not editable):** intentional simplifications; owner is open to more flexibility **but only with full downstream analysis**. Deferred out of this sweep — tracked as a follow-up design task, not a batch item. Downstream surfaces to account for when we do tackle them: type change must remap `detailsJson` shape + linked itinerary stop (`bookingId` stops are type-derived), Today-tab anchor classification (hotel vs non-hotel), flight-only StatusPill, and card component selection; destination edits must reconcile `days[].city` derivation, discovery pre-warm destination, and location-resolution city bias.
- **Q3 (global discovery cache):** stays global by design — fire-once, crowd-sourced, cheap for the next user. H3's fix direction is confirmed (generate WITHOUT per-trip exclusions, filter at display time). Additional improvements to fold into the discovery batch:
  1. **Merge-on-refresh instead of replace:** when the 7-day TTL expires, regenerate and `mergeDiscoveryCategories` into the existing row (the merge helper already exists for "show more") rather than `INSERT OR REPLACE` — breadth accumulates over time instead of resetting to one generation's view.
  2. **"Show more" already crowd-sources breadth** into the global row — keep that; it becomes the organic fix for "first generation limits everyone."
  3. **Don't present unverifiable facts as fresh:** stop rendering `openingHours` as a badge of record (or suffix it "— verify"), since cached hours can be up to 7+ days stale and were never authoritative.
  4. Optional/cheap: store `generated_at` per merge so a future "refreshed N days ago" hint is possible.

## Clean bill of health (checked, no issues)
Design-language drift (fonts/palette/TODOs: none found) · auth offline fallback (cached-user pattern is solid) · UTC off-by-one date rendering (the SuggestionCard fix pattern is consistently applied elsewhere) · copilot apply/reject validation server-side · share view page states · GCJ conversion on the Map tab itself.

---

## Execution plan

**Step 0 — persist the report: DONE.** This document is that report. Each batch has a status line in the table above (`pending / in progress / done / verified`), updated as work lands — if a session ends or a usage limit resets, this doc is the resume point; no re-discovery needed.

## Session handoff prompt

Paste this to resume implementation in a fresh session:

```
Continue implementing the approved UX sweep fixes for Trippy (this repo).

Source of truth: docs/superpowers/plans/Implementation Plan 4 UX Sweep Fixes.md
— read it fully first. It has every finding (C1–C3, H1–H4, M1–M7, L1–L12) with
root cause, file:line refs, agreed fix, owner product decisions (Q1–Q3), and
the batch-status table. Check the table for current progress and start at the
first non-verified wave. (As of 2026-07-05: Wave 1 / timezone C1 is committed
and verified in cfc03f3 — start at Wave 2.)

Working rules:
- One wave at a time, max 2 Sonnet subagents in flight (split frontend-heavy
  vs backend-heavy so they don't collide on files). You orchestrate and QA;
  never spawn a Fable subagent.
- Wave order: (2: modal scroll/confirms + 3: copilot stream fix) →
  (4: PWA/nav + 5: error surfacing/share link) → (6: discovery cache) →
  (7: Today/map + 8: stragglers).
- After each wave: backend npm test (186+ passing baseline), frontend
  npx vitest run (20 passing baseline) + build, 375px preview pass on the
  affected tabs, update the status table in the plan doc, then commit the wave.
- Follow CLAUDE.md: no bandaids, no TODO/FIXME, parameterised SQL, fixed
  palette/typography, mobile-first.

Wave 2 note: C3 (copilot stream) touches frontend/src/hooks/useCopilot.js and
backend/src/services/claude.js; Batch 2 is frontend modals only — no shared
files, safe to run in parallel.
```

**Batches** (self-contained specs, delegated to **Sonnet subagents** — never Fable):
1. **Timezone** (C1 + originTz day-wrap tests) — highest blast radius, pure-function fix.
2. **Modal scroll + destructive confirms** (H1, M4) — mechanical, pattern-copy from CaptureFlow/StopCard.
3. **Stream/state machine** (C3, L2).
4. **PWA/nav** (C2, L9).
5. **Error surfacing** (H2, M7, L4) + **share link state** (M3).
6. **Discovery** (H3 incl. Q3 improvements, M1, M6, L5, L11).
7. **Today/map** (H4, M2, L1, L3, L7).
8. **Stragglers** (M5, L6, L8, L10, L12) — small one-liners, can ride with whichever batch is last.

**Usage-limit pacing:** run **one wave at a time — max 2 agents in flight** (one frontend-heavy + one backend-heavy so they don't collide on files). After each wave: run backend `npm test` + frontend build, update the status doc, commit that wave. Only then start the next wave. Never launch all batches at once — a mid-flight limit reset would leave half-finished agents whose state is expensive to re-verify. Suggested wave order: (1) → (2+3) → (4+5) → (6) → (7+8).

**Verification per batch:** backend `npm test` (186 + new tz tests), frontend build, and a 375px preview pass on the affected tab.
