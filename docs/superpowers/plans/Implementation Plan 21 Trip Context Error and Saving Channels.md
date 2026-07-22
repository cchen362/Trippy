# Implementation Plan 21 — Trip Context Error and Saving Channels

**Status:** NOT STARTED — written 2026-07-21.

**Written:** 2026-07-21, from an investigation opened by a Wave 4 observation in [Implementation Plan 20](<Implementation Plan 20 Expenses Refinement and Booking Costs.md>): a failed booking delete showed its error inline *and* raised `TripPage`'s shared banner. The investigation found the duplicate banner is the least of it. Every fact below was verified against live code on 2026-07-21 at commit `e4b95d2`. Do not re-derive these facts; trust them unless the code has visibly moved.

**Schema impact: NONE.** Frontend only. No migration, no API change, no backend file touched.

**User-visible impact: three currently-dead submit guards start working.** Everything else in this plan is internal wiring with zero rendered difference. That asymmetry matters for QA: the *absence* of a visual change is the pass condition almost everywhere, and the three guards are the only place where behaviour must visibly change.

---

## Model recommendation per wave

| Wave | Recommendation | Why |
| --- | --- | --- |
| W1 | Opus orchestrator + one Sonnet coder | Deletes a shared error channel that four call sites silently depend on. The risk is a *silent* regression — an error that stops being displayed anywhere. Needs a reviewer who checks each dependent by hand. |
| W2 | Opus orchestrator + one Sonnet coder | Mechanical rename across three tabs, but it is the wave that restores three real submit guards. Cheap to get 95% right and easy to leave one call site reading a stale key. |
| W3 | Opus orchestrator, no coder | Verification, convention capture, deploy. |

Waves are sequential — W1 and W2 both touch `TripPage.jsx` and `PlanTab.jsx`, so they must not run in parallel. Within a wave, do not split work across two subagents; the file overlap is total.

QA for every wave: automated tests locally, then exercise the flow in a real browser, then hand the owner a click-script for prod verification after deploy.

---

## The root cause, stated once

`TripPage.jsx:178` merges three hooks into one flat outlet context:

```js
<Outlet context={{ ...tripState, ...stopActions, ...bookingActions, discovery, live: isLive, reportError, openCopilot }} />
```

`useTrip` returns `{ ..., loading, error, refresh }`. `useStops` and `useBookings` each return `{ saving, error, ...mutations }` — **identical shapes**. Later spreads win, so:

- `error` collides **three ways** (trip-load / stops / bookings) → `bookingActions.error` wins.
- `saving` collides **two ways** (stops / bookings) → `bookingActions.saving` wins.

Separately, `run()` in both action hooks does two jobs in one `catch`:

```js
} catch (err) {
  setError(err);   // broadcast to a shared surface
  throw err;       // ...and let the caller handle it
}
```

Nothing declares which channel a given call site uses, so every call site gets both. `TripPage.jsx:52-58` mirrors both hooks' `error` into one `pageError` banner. Call sites were then written inconsistently over eighteen months of waves.

Everything in the Findings section below is a symptom of those two facts.

---

## Findings (severity, with the evidence)

**F1 — `saving` is wrong on the Plan and Map tabs. Live bug. HIGH.**
Because `bookingActions` is spread last, every consumer reading `saving` off the trip context gets the *booking* saving flag. Neither Plan nor Map ever performs a booking mutation, so on those tabs the flag is **permanently `false`** and three guards have never once fired:

| Consumer | Line | Intended guard | Actual behaviour today |
| --- | --- | --- | --- |
| `MapTab` pin-correction save | `MapTab.jsx:495,501` | disable while saving | never disables → **double-submit window on pin correction** |
| `AddPlaceModal` submit | `AddPlaceModal.jsx:191,195` (via `PlanTab.jsx:166`) | disable + `Adding...` label | never disables → **duplicate stops possible** |
| `Timeline` reorder indicator | `Timeline.jsx:115` (via `PlanTab.jsx:144`) | show `Saving order...` | indicator never appears |

`LogisticsTab.jsx:57` reads `saving` and *is* correct — but only by the accident of spread order.

**F2 — Booking failures are reported twice. MEDIUM-LOW.**
All three booking mutations already report inline: create/edit through `AddBookingModal`'s own `error` state (`AddBookingModal.jsx:210` sets, `:729` renders); delete through `LogisticsTab`'s `deleteError` (rendered in `BookingDeleteReview`, and at `LogisticsTab.jsx:405` for the no-cost path). The `bookingActions.error` mirror adds a redundant global banner behind the modal. **Zero call sites depend on it.**

**F3 — The banner outlives its context. MEDIUM.**
`pageError` is cleared only by manual dismiss or by the next error. `TripPage` does not unmount on tab switches, so an error raised by a Plan reorder follows the user to Map and Logistics, floating above unrelated content. Directly observed during Plan 20 W4 QA: the banner survived closing the booking sheet and opening a different booking.

**F4 — The stops mirror is genuinely load-bearing. This is why "just delete the banner" is wrong.**
Four call sites deliberately rely on it, each with a comment saying so:

- `PlanTab.jsx:33-44` `handleReorder` — catch refetches to re-sync, comments that the banner surfaces the message.
- `PlanTab.jsx:54` `handleDeleteStop` — `.catch(() => {})`, a bare swallow that violates CLAUDE.md's no-swallow rule and makes its dependence invisible.
- `StopCard.jsx:114-123` `handleNoteBlur` — keeps `noteDirty` true, comments that the banner surfaces it.
- `TransitStop.jsx:28-38` `handleNoteBlur` — same.

**F5 — Double-reporting inside stops too. LOW.**
`PlanTab.jsx:49` `handleMove` and `MapTab.jsx:113` `saveCorrection` both call `reportError` *and* trip the mirror. Same target, so the second just overwrites the first — harmless today, but it means no one can reason about who owns a given message.

**F6 — Test fixtures mask the collision.**
`PlanTab.dayswitch.test.jsx:115` builds its context as `{ ...tripState, ...stopActions, discovery: {}, live: false, reportError: vi.fn() }` — **without `bookingActions`**. So in tests `saving` resolves to the stops flag, which is the opposite of production. `PlanTab.test.jsx:17` hardcodes `saving: false`. This is a large part of why F1 survived to production.

---

## Binding decisions

**D1. Namespace the two action hooks; keep trip data flat.**

```js
context={{ ...tripState, stopActions, bookingActions, discovery, live: isLive, reportError, openCopilot }}
```

Consumers become `stopActions.updateStop(...)`, `stopActions.saving`, `bookingActions.createBooking(...)`.

Assessment behind this choice (the owner asked for implication vs effort):
- **User-facing UX/UI impact: zero, for every option considered.** No rendered output changes anywhere except the three F1 guards, and those change identically under every option. So UX risk does not discriminate between the options; only regression risk and durability do.
- **Effort is barely above the cheapest option.** Only three files consume action keys (`PlanTab`, `MapTab`, `LogisticsTab`). `ExpensesTab`, `TodayTab`, and `TripIndexRedirect` read only trip *data* (`trip`, `days`, `bookings`, `activeDay`, `live`, `refresh`) and are **untouched**.
- **It is the only option that removes the bug class** rather than the two instances of it. Merging two identically-shaped objects into one namespace is the generator; renaming today's colliding keys leaves the generator in place for the next hook.
- **Do NOT namespace as `bookings: bookingActions`.** `tripState` already exposes `bookings` (the array, `useTrip.js:62`) and it is consumed by `ExpensesTab`, `TodayTab`, `MapTab`, and `LogisticsTab`. That key is taken; shadowing it would break four files. Use `bookingActions`/`stopActions` verbatim.
- Trip data stays flat because renaming it has real churn across all six consumers and buys nothing — `tripState` is the only source of those keys.

**D2. The call site owns the error message.** After W1 there is exactly one rule: pass `onError` at hook construction to opt into the shared page banner; handle the rejection locally to own it yourself. No hook holds latched `error` state that something else might or might not be reading.

**D3. Stops keep the shared banner; bookings do not.** `useStops` is constructed with `onError: reportError`; `useBookings` is not. This is the deliberate, documented contract — it is what keeps F4's four call sites working, and it is now visible at the construction site instead of buried in four comments.

**D4. `pageError` clears on route change.** A banner must not outlive the screen that produced it. Clearing on `location.pathname` change is safe for every current producer: `handleReorder`, both `handleNoteBlur`s, `handleMove`, and `saveCorrection` all leave the user on the originating tab, and `TripPage`'s own `reportError` calls (delete trip `:88`, save settings `:103`) do not navigate on failure.

**D5. Out of scope.** No backend changes. No change to `run()`'s rethrow contract — callers that `await` a mutation must still be able to `catch`. No new error UI, no toast system, no retry affordance. `MapTab`/`PlanTab.handleMove`'s now-single `reportError` call (F5) is left as the explicit owner of its message.

---

## Verified code map

**Hooks**
- `frontend/src/hooks/useStops.js` — 30 lines. `run()` at `:8`; returns `{ saving, error, createStop, updateStop, deleteStop, reorderStops }`.
- `frontend/src/hooks/useBookings.js` — 34 lines. `run()` at `:8`; returns `{ saving, error, createBooking, updateBooking, deleteBooking, lookupHotels, lookupHotelDetails, lookupFlight, lookupCities }`. `deleteBooking` takes `(bookingId, deleteExpenseIds)` as of Plan 20 W4.
- `frontend/src/hooks/useTrip.js:58-69` — returns `{ detail, trip, days, bookings, activeDayId, setActiveDayId, activeDay, loading, error, refresh }`. **`error` and `bookings` are the two keys that make naive merging dangerous.**

**Composition root**
- `frontend/src/pages/TripPage.jsx` — hooks constructed at `:34-35`; mirroring effects at `:52-58`; `reportError` at `:60`; `ErrorBanner` at `:177`; outlet context at `:178`. `useLocation` is **already imported and in use** at `:31` (`isExpensesRoute`), so D4 needs no new import.

**Action consumers (the only three files W2 touches)**
- `frontend/src/pages/PlanTab.jsx:15-29` destructures `reorderStops, createStop, saving, deleteStop, updateStop, reportError` among trip data. Uses `saving` at `:144` and `:166`.
- `frontend/src/pages/MapTab.jsx:25` destructures `updateStop, saving, reportError`. Uses `saving` at `:495`, `:501`.
- `frontend/src/pages/LogisticsTab.jsx:48-62` destructures `createBooking, updateBooking, deleteBooking, saving`. Uses `saving` at `:426`, `:467`, `:469`, and passes it to `BookingDeleteReview`.

**Non-consumers — confirm they stay untouched**
- `ExpensesTab.jsx:17`, `TodayTab.jsx:14`, `TripIndexRedirect.jsx:5` read trip data only.

**Tests that will need fixture updates**
- `frontend/src/pages/PlanTab.test.jsx` — `mockContext` at `:15-23` (`saving: false`, `reportError: vi.fn()`); asserts `handleMove` calls `reportError` at `:45-56` and does not on success at `:58-68`. **These two assertions must stay green** — they encode F5's deliberate behaviour.
- `frontend/src/pages/PlanTab.dayswitch.test.jsx:115` — see F6.
- `frontend/src/components/timeline/AddPlaceModal.test.jsx`, `StopCard.test.jsx`, `TransitStop.test.jsx` — pass props directly, so likely unaffected; verify rather than assume.

**Gotchas carried in from prior plans**
- Dev servers via `.claude/launch.json` (frontend :5174, backend :3002). Start them yourself; they are usually not running.
- Browser QA uses the **Claude in Chrome extension** against an already-logged-in `localhost:5174` tab — not the in-app Browser pane, whose cookie-mint auth 401s and which runs the tab as `document.hidden` (framer-motion freezes at frame 0).
- The dev backend runs `NODE_ENV=test`, so `AUTH_RATE_LIMIT` is **5 per 15 minutes** (`backend/src/middleware/rateLimit.js:3`). On "Too many requests", bump the mtime of `backend/src/index.js` to restart `node --watch` and reset the in-memory limiter — far faster than waiting out the window.
- Chrome on Windows enforces a ~500px minimum window width; verify phone layout by clamping the container to 375px and measuring `scrollWidth - clientWidth`.

---

## Wave 1 — Error channel

**Status:** COMPLETE — 2026-07-22. Browser-verified locally; not yet deployed (deploy held until W2 per the plan). Baseline 187 → 191 tests (4 added). Deviations: none beyond the anticipated comment refresh in the two F4 note-blur call sites and `handleReorder`; also removed a now-useless `catch(err){throw err}` in `useBookings` (try/finally is behaviour-identical and cleaner). No product decision changed.

**What was verified in the browser (Chrome extension, logged-in `localhost:5174`, Taipei–Kaohsiung trip):**
- Stop create forced to fail → shared page banner **"SOMETHING WENT WRONG — Forced stop failure (QA)"** appeared on Plan *and* the modal's own inline error showed (both channels, as intended).
- Navigated Plan → Map → banner **cleared** (D4).
- Booking delete forced to fail → inline sheet error **"Forced booking delete failure (QA) Nothing was deleted."** with **no** page banner (booking mirror removed). No DB mutation occurred (all forced failures rejected client-side).

Files: `frontend/src/hooks/useStops.js`, `frontend/src/hooks/useBookings.js`, `frontend/src/pages/TripPage.jsx`, `frontend/src/pages/PlanTab.jsx`. Comment-only touches in `StopCard.jsx`, `TransitStop.jsx` (F4 wording). New tests: `useStops.test.jsx`, `useBookings.test.jsx`.

1. **Both hooks:** add `onError` to the options object. Replace the latched error state entirely — delete the `error` `useState` and remove `error` from the returned object. `run()`'s catch becomes:

   ```js
   } catch (err) {
     onError?.(err);
     throw err;
   }
   ```

   Keep the rethrow (D5) and keep `saving`. Add `onError` to `run`'s `useCallback` dependency array alongside `onChanged`.

2. **`TripPage.jsx`:** hoist `reportError` above the hook constructions and wrap it in `useCallback` so it is a stable dependency. Construct `useStops({ onChanged: tripState.refresh, onError: reportError })` and leave `useBookings` without `onError`. Delete **both** mirroring `useEffect`s at `:52-58`. Add a comment at the `useStops` construction naming D3 as the contract and listing the four dependent call sites, so the next person cannot delete it blind.

3. **`TripPage.jsx`:** clear `pageError` when `location.pathname` changes (D4). `useLocation` is already in scope at `:31`.

4. **`PlanTab.jsx:54`:** replace `handleDeleteStop`'s `.catch(() => {})` with a catch that `console.error`s and comments that the shared banner surfaces the message. No behaviour change — this only makes the dependence visible and satisfies the no-swallow rule.

**Do not** change `handleReorder`, `handleMove`, `StopCard.handleNoteBlur`, or `TransitStop.handleNoteBlur`. Their bare `catch` blocks are correct once `onError` routes the message; only their comments may need a word to match the new mechanism.

**W1 verification.** `cd frontend; npm test` (baseline 187) and `npm run build`. Add a test that a rejected booking mutation does **not** set the page banner, and one that a rejected stop mutation **does**. Browser: force a stop note-save failure and a reorder failure and confirm the banner still appears for both; force a booking delete failure and confirm the inline error appears with **no** page banner; then switch tabs and confirm a raised banner clears.

---

## Wave 2 — Action namespacing

**Status:** COMPLETE — 2026-07-22. Browser-verified locally; not yet deployed (single deploy held for W3). Tests 191 passing (unchanged from the W1 baseline — this wave adds no tests, only re-shapes two fixtures) and `npm run build` clean. All three F1 guards confirmed live in a real browser (Chrome extension, logged-in `localhost:5174`, "Shanghai – Hangzhou (W3 verify)" trip):

- **Add Place submit (F1 #2):** with a stops-create round-trip delayed, the submit button rendered `Adding...` **and** `disabled=true` throughout the in-flight window, then closed on success. Dead before W2 (booking `saving`, always false on Plan).
- **Timeline reorder indicator (F1 #3):** driven solely by `saving`; with a stop mutation delayed, `Saving order...` appeared while `stopActions.saving` was true and cleared on completion. *Note:* framer-motion's pointer-based `Reorder` drag cannot be driven by the CDP automation harness (the extension's mouse-drag doesn't fire it; synthetic pointer events wedge the renderer), so the indicator was lit via a real `deleteStop` — the identical, solely-`saving`-gated indicator the reorder path feeds.
- **Map pin-save (F1 #1):** with the pin PATCH delayed, the "Set here" button went `disabled=false / opacity 1` → `disabled=true / opacity 0.55` mid-flight, then closed on success. Dead before W2.

**Implementation deviation (documented, no product decision changed):** used **nested destructure** in the three consumers — pull `stopActions` / `bookingActions` from context, then `const { ... } = stopActions` — instead of dotting `stopActions.x` at each call site. Behaviourally identical (each render reads the same live flag), but it collapses ~20 scattered edits into 3 one-line changes and eliminates the wave's flagged "missed a call site → silent `undefined`" risk class entirely. No consumer mixes stop and booking actions, so per-call-site namespacing bought nothing. Grep confirmed no bare action key survives directly off `useTripContext()`.

**QA data notes:** the junk "QA Wave2 Probe Stop" created for the Add Place probe was deleted (it doubled as the reorder-indicator trigger). Two verify-trip stops (SQ 832, West Lake) had their provenance flag flipped to `user_confirmed` by the pin-save probes — coordinates unchanged, on the disposable verify trip. Mobile-viewport (375px) layout was **not** re-checked this wave: Chrome's ~500px min-width floored the resize, and all three guards are form-factor-independent logic (disabled/label/indicator) — the 375px pass is Wave 3's task.

Files: `frontend/src/pages/TripPage.jsx`, `frontend/src/pages/PlanTab.jsx`, `frontend/src/pages/MapTab.jsx`, `frontend/src/pages/LogisticsTab.jsx`, plus the test fixtures listed in the code map.

1. **`TripPage.jsx:178`:** stop spreading the action hooks. Pass them as `stopActions` and `bookingActions` (D1 — **not** `stops`/`bookings`; `bookings` is taken by the trip data array). Trip data keys stay flat.

2. **`PlanTab.jsx`:** destructure `stopActions` and call `stopActions.reorderStops/createStop/deleteStop/updateStop`. Both `saving` usages (`:144` Timeline, `:166` AddPlaceModal) become `stopActions.saving`. **This is the change that restores two of the three F1 guards** — expect `Saving order...` to appear during a reorder and the Add Place button to disable, both for the first time.

3. **`MapTab.jsx:25`:** destructure `stopActions`; `updateStop` → `stopActions.updateStop`; `saving` at `:495`/`:501` → `stopActions.saving`. **Restores the third F1 guard** — the pin-save button now disables during its request.

4. **`LogisticsTab.jsx`:** destructure `bookingActions`; the three mutations and all four `saving` usages become `bookingActions.*`. Behaviour is unchanged here (it was already resolving to the booking flag) — this is a rename only, and any behaviour difference is a bug in the change.

5. **Test fixtures:** update `PlanTab.test.jsx`'s `mockContext` and `PlanTab.dayswitch.test.jsx:115` to the namespaced shape. Per F6, `dayswitch` must now build a context that matches production; do not reintroduce a fixture that omits one of the two action objects.

**W2 verification.** Full `npm test` + `npm run build`. Grep the whole frontend for any surviving bare `saving`/`updateStop`/`createBooking` read off `useTripContext()` — a missed call site fails silently as `undefined`, which reads as "never saving" rather than as an error. Browser, all three guards explicitly:
- Map: start a pin correction, tap save, confirm the button disables for the duration.
- Plan: open Add Place, submit, confirm the button disables and reads `Adding...`.
- Plan: drag to reorder, confirm `Saving order...` appears.
Throttle the network if these round-trips are too fast to observe.

---

## Wave 3 — Convention capture and deploy

**Status:** NOT STARTED

1. Re-run the full bar and a 375px pass over Plan, Map, and Logistics — this plan touches the three busiest tabs and the pass condition almost everywhere is *no visible change*.
2. Add the rule to `CLAUDE.md`'s frontend section: the call site owns the error message; `onError` at construction opts a hook into the shared page banner; stop mutations use it and booking mutations do not; action hooks are namespaced in the outlet context and must never be flat-spread.
3. Deploy via `/deploy` and hand the owner a numbered click-script at phone width covering the three restored guards and a regression sweep of the tabs. Mark waves COMPLETE only after owner prod QA passes.

---

## Cross-wave invariants (assert in code review + tests every wave)

1. No hook returns a latched `error` that nothing consumes. If a hook exposes `error`, name its consumer.
2. Two objects of the same shape are never flat-spread into one context. Action hooks are namespaced.
3. Every mutation failure has exactly **one** owner: a local state that renders it, or `onError` → the page banner. Never both.
4. `run()` keeps rethrowing — every existing `await`/`catch` call site must continue to work unchanged.
5. The four F4 stop call sites still surface their failures after W1. Check each by hand, not by test count.
6. No user-visible change anywhere except the three F1 guards.
7. No backend file, migration, or API contract is touched by this plan.

## Deployment

One deploy after W3 via `/deploy` (git pull + Docker rebuild on the Debian server, container `trippy-trippy-1`, port 6768). No migration step. The waves are small and interdependent — deploying W1 alone would ship the error-channel change without the `saving` fix, so hold the deploy until W2 is verified.
