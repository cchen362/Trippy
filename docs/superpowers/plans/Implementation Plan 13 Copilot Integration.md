# Implementation Plan 13 — Co-pilot Integration (Bottom Sheet, Contextual Entry Points, Seed Prompts)

**Status: WAVE 1 COMPLETE (2026-07-12) — mockups owner-approved, entry-point set signed off. Waves 2–4 unblocked.**

**Origin:** Stage 3 of the owner-approved co-pilot sequencing (decision session
2026-07-12, following the
[Co-pilot Foundation and Integration Review](../reviews/2026-07-11-copilot-foundation-and-integration-review.md)
§5 findings C1/C2 and §7 Directions D and E). Stage 1 (trust foundation) shipped as
[Implementation Plan 11](Implementation%20Plan%2011%20Copilot%20Trust%20Foundation.md),
CLOSED in production at `7d6c904`. Stage 2 (grounding) is
[Implementation Plan 12](Implementation%20Plan%2012%20Copilot%20Grounding.md),
finalized at `b538b37`, Wave 1 implemented at `4abcb61` — see "Dependency posture" below.

**Goal:** make the co-pilot feel like part of the product instead of a detached
full-screen chat. Three deliverables: (1) the full-screen panel becomes a **bottom
sheet** at partial height with the plan visible behind it (full screen is the sheet's
*expanded state*, not a separate surface); (2) **contextual entry points** — the FAB
becomes context-aware (active day/tab/stop) and per-object entry points live inside
existing action surfaces, adding zero new persistent chrome; (3) the empty state's
"Ask me anything…" is replaced with **trip-grounded seed prompts** derived from the
real trip. All UI specified against design spec §8 at 375px; a design/mockup pass is
the first wave and gates everything else.

**Explicitly NOT in this plan:** route/distance tools, proactive health-finding
surfacing, live/proactive data (review Direction G), undo, any new co-pilot
capabilities or backend tools (Plan 12 owns grounding), new persistent chrome of any
kind.

**Dependency posture vs Plan 12 (required statement):** Plan 13 has **no code
dependency on Plan 12** and must not assume any Plan 12 wave is implemented. All
Plan 13 work is specified against current `main` (`7d6c904`). This is safe in both
orders because unknown SSE event types are ignored by `useCopilot` (Plan 12 fact 11)
— a sheet built before Plan 12 simply won't render `tool` events until Plan 12
Wave 4 adds handling. **One coordination rule:** Plan 12 Wave 4 and Plan 13 Wave 2
both rewrite `CopilotPanel.jsx`/`useCopilot.js` — they must not run concurrently;
whichever lands second rebases and preserves the other's behavior (tool-activity
line and verified-place badge from Plan 12; sheet states from Plan 13). Waves 3–4
of this plan touch the send path and host components Plan 12 never touches.

---

## 0. Verified facts this plan is built on (traced 2026-07-12)

Confirmed in current `main` (`7d6c904`); implementation sessions must not re-derive them.

1. **The panel is a fixed full-screen overlay.** `CopilotPanel` renders a
   `motion.div` with `position: fixed; inset: 0; zIndex: 200`, spring y-slide
   entrance (`CopilotPanel.jsx:99-111`), inline header / scrolling message list /
   input bar as flex column. The design spec already names the motion idiom:
   "Co-pilot slide-up: spring easing via Motion library" (design spec §8.7,
   `2026-04-23-trippy-design.md:312`). framer-motion is in use throughout
   (`TripPage.jsx:3,155` — `AnimatePresence`).
2. **The FAB is the only affordance and is context-blind.** `CopilotFab` is
   `position: fixed; bottom: 80; right: 20; zIndex: 100` (`CopilotFab.jsx:6-21`),
   mounted by `TripPage` and hidden while the panel is open
   (`TripPage.jsx:154`). `onClick` carries nothing.
3. **TripPage already owns everything the context-aware FAB needs.**
   `copilotOpen` state and `copilotState = useCopilot(tripId)` live in `TripPage`
   (`TripPage.jsx:33-34`); `activeDayId`/`activeDay`/`setActiveDayId` live in
   `useTrip` (`useTrip.js:14,58-65`) and are already available at TripPage level
   via `tripState` and passed to tabs through outlet context (`TripPage.jsx:152`).
   The active **tab** is the route: `today | plan | logistics | map` segments
   under `/trips/:tripId/` (`BottomNav.jsx:41-45`) — derivable in TripPage from
   `useLocation()`. Discovery is a panel inside the Plan tab, not a route
   (`PlanTab.jsx:30,146-157`).
4. **The empty state is generic copy.** `isEmpty` (`CopilotPanel.jsx:96`) renders
   the literal "Ask me anything about your trip..." (`CopilotPanel.jsx:218-235`).
   This is finding C1 verbatim.
5. **The send path carries message text only.** `useCopilot.send(text)`
   (`useCopilot.js:40`) → `copilotApi.send(tripId, message, …)` posts
   `{ message }` (`copilotApi.js:5-6`); the route validates only
   `req.body.message` (`copilot.js:72-74`) and stores it verbatim in
   `copilot_messages` (`copilot.js:85-88`). Extra body fields are ignored today,
   so a structured `context` field is purely additive.
6. **Volatile screen context must NOT go into the system prompt.** The system
   prompt embeds the itinerary JSON and carries
   `cache_control: { type: 'ephemeral' }` (`claude.js:406-445`); it is stable
   across turns while the trip is unchanged, which is what makes the cache pay
   (Plan 11 fact 10, Plan 12 fact 1). Screen context changes every open/tab
   switch — injecting it there would bust the cache every turn. The correct
   injection point is the conversation `messages` array built at
   `copilot.js:91-103`.
7. **`copilot_messages` has no context column.** Columns in use: `id, trip_id,
   user_id, role, content, created_at` (insert at `copilot.js:85-88`, history
   select at `copilot.js:23-32` which also joins `users.display_name`). **Next
   migration number is 029** (latest is `028_copilot_proposals.sql`).
8. **The per-stop action surface already exists.** The expanded stop card renders
   an inline action row — Remove / Move to → / Photo → — in DM Mono
   (`StopCard.jsx:281-299`); collapsed cards have no menu. This is the "existing
   overflow menu" a stop-level entry point extends. `StopCard.test.jsx` exists
   and must stay green.
9. **DayHeader has no menu** — only the city-override pencil
   (`DayHeader.jsx:80-91`). Day-level context therefore belongs to the
   context-aware FAB (which already knows the active day, fact 3), not to a new
   header control.
10. **The Discovery suggestion card's action surface** is the bottom row "Add to
    day" + report affordance (`SuggestionCard.jsx:306-329`), inside the
    full-screen `DiscoveryPanel` (`DiscoveryPanel.jsx:308`).
11. **The plan is genuinely visible behind a partial sheet.** `main` content and
    `BottomNav` (sticky, `z-30`, `BottomNav.jsx:34-37`) sit far below the panel's
    `zIndex: 200`; nothing else occupies the bottom half of the viewport, so a
    ~55–60% sheet leaves the timeline readable.
12. **`useCopilot` state shape (post-Plan-11):** `messages` (stable ids),
    `proposals` (normalized, keyed to messages via `messageId`), `streaming`,
    `streamingText`, plus `send/applyProposal/rejectProposal/cancel/clear`
    (`useCopilot.js:16-174`). SSE event types consumed: `text | proposal | error |
    done`; unknown types are ignored (Plan 12 fact 11).
13. **Panel auto-scrolls on new content** (`CopilotPanel.jsx:53-55`) — scroll
    containment inside the sheet already exists; the no-auto-expand rule is about
    sheet *height*, not scroll position.
14. **Test baseline:** backend 512 tests / 27 files green at `7d6c904`; frontend
    `npm run build` clean; frontend vitest suites exist for `PlanTab`, `StopCard`,
    `DiscoveryPanel`, `TransitStop`.

---

## 1. Design decisions (owner-approved 2026-07-12 — encode, don't re-open)

- **P1 — Bottom sheet, one surface, two states.** The co-pilot presents as a
  bottom sheet at **partial height ~55–60%** with the plan visible behind it.
  **Full screen is the sheet's expanded state** — reached by dragging up on
  mobile — not a separate surface or component.
- **P2 — No auto-expand, ever.** Long replies scroll *inside* the sheet at its
  current height; the sheet never changes height except by explicit user action.
  This is an instance of the standing owner rule: no uninitiated motion.
- **P3 — Gestures never port across form factors.** Mobile gets drag
  (handle-led) between partial/expanded/dismissed. Desktop gets a distinct
  pointer-native treatment: an **explicit expand/collapse control** in the sheet
  header and a close control — no drag-gesture emulation, no hover-triggered
  motion. Every interactive treatment in this plan is specified for touch AND
  pointer separately.
- **P4 — The FAB stays the ONLY persistent co-pilot affordance**, and becomes
  context-aware: opening it carries the active tab, active day, and (when opened
  from a stop's entry point) the stop. Contextual entry points add **zero new
  persistent chrome** — they live inside existing action surfaces (the expanded
  stop card's action row, fact 8; the Discovery suggestion card's action row,
  fact 10). Nothing new renders on collapsed cards, headers, or nav.
- **P5 — Context is visible to both the user and the model** (review Direction
  D). Whatever context a turn carries is rendered in the UI as a DM Mono context
  chip on that message — never silently injected. Server-side, context goes into
  the conversation turn, never the cached system prompt (fact 6).
- **P6 — Seed prompts are trip-grounded and deterministic.** The empty state
  offers up to 3 tappable prompts derived client-side from the real trip (active
  day's city and stop mix, upcoming bookings, untimed-day density) — no LLM call,
  no generic copy, instant render. Tapping one sends it as an ordinary message
  carrying the current context. (Mechanism note: derivation is deterministic
  because an LLM call here would add cost/latency to every panel open for copy
  the trip data already implies; the owner decision fixed "from the real trip",
  and this is the only implementation consistent with API cost discipline.)
- **P7 — Design before code.** Wave 1 produces mockups against design spec §8 at
  375px (plus the desktop treatment) and the owner approves them before any
  implementation wave starts. The mockup approval also fixes the concrete v1
  entry-point set (P4 names the candidate surfaces; the owner signs off the
  final set on the mockups, at which point it binds Waves 3–4).
- **P8 — Everything Plan 11 shipped keeps working inside the sheet.** Proposal
  cards, apply/reject, loss warnings, status copy, attribution, owner-only clear
  — unchanged in behavior, re-laid-out only as the sheet requires. Gold stays
  accent-only; the three-font system applies; no new colors.

---

## Wave 1 — Design pass: mockups at 375px (gates all other waves)

**Status: COMPLETE (2026-07-12). Owner approved the mockups and the v1 entry-point set (EP-1 stop
card + EP-2 Discovery suggestion; all exclusions confirmed). Deliverable:
`docs/superpowers/mockups/plan13-wave1-copilot-sheet-mockups.html` (self-contained, fonts inlined;
also published as a Claude artifact). One deviation from the candidate design, owner-decided at
sign-off: EP-1 "Ask co-pilot →" gets its OWN ROW above the Remove/Move/Photo action row — a fourth
item wraps the row at 375px and collides visually with the Unsplash credit line directly below
(`StopCard.jsx:405-436`); Wave 4 must implement the own-row placement. Recommendations R1–R4
(no scrim at partial / non-modal partial with BottomNav covered / keyboard never resizes the sheet /
structural edge: hairline + shadow + 16px radius) are ratified and bind Waves 2–4.**
**Model recommendation: Opus (or Fable) medium solo — no coding subagents.**
This wave is pure design taste against a strict spec with an owner sign-off gate;
volume is tiny and delegating it to a cheaper model is where AI-slop risk lives.

Produce static HTML/CSS mockups (owner-viewable artifacts, not app code) covering:

1. **Sheet anatomy at 375px:** partial state (~55–60% height, plan visible
   behind, drag handle, header with title + close, message list, input bar),
   expanded state (full screen), and the transition affordance. Decide and show:
   backdrop treatment at partial vs expanded (recommendation: no scrim at
   partial — the whole point is seeing the plan; subtle scrim at expanded),
   whether the background stays scrollable at partial (recommendation: yes,
   sheet is modal only when expanded), and how the input bar coexists with the
   keyboard at partial height on mobile.
2. **Desktop treatment (≥ sm):** same sheet component, explicit expand/collapse
   control in the header, pointer hover states, max-width/centering so a
   full-width bar doesn't stretch across a wide viewport. No drag handle
   affordance shown on pointer devices (P3).
3. **Context chip:** DM Mono chip idiom for a message that carried context
   (e.g. `DAY 3 · HANGZHOU`, `STOP · WEST LAKE`), consistent with the existing
   badge language (uppercase, letter-spacing, one gold accent max per
   component).
4. **Seed-prompt empty state:** up to 3 trip-grounded prompts as tappable rows
   or cards, with the real derivation examples mocked from a real trip shape
   (never lorem/generic).
5. **Entry-point placements:** the stop card action row gaining an
   "Ask co-pilot →" item (fact 8) and the Discovery suggestion card variant
   (fact 10) — shown in place so the owner can judge density. Present the
   proposed v1 entry-point set for sign-off (P7).

Acceptance: owner has approved the mockups (including the entry-point set) at
375px and desktop; every implementation wave below references the approved
mockups as its visual source of truth. No app code changed.

## Wave 2 — Bottom sheet presentation (frontend)

**Status: NOT STARTED — UNBLOCKED (Wave 1 approved 2026-07-12). NOTE: Plan 12 has since
shipped to production (2026-07-13, `d72eb2d`), so this wave lands SECOND — the coordination
rule applies: rebase onto current `main` and PRESERVE Plan 12 Wave 4's tool-activity line
and verified-place badge in `CopilotPanel.jsx`/`useCopilot.js`. The §0 facts were traced at
`7d6c904` (pre-Plan-12); re-verify the `CopilotPanel.jsx`/`useCopilot.js` line numbers in
facts 1/4/12/13 against current `main` before relying on them — Plan 12 Wave 4 edited both
files.**
**Model recommendation: Opus medium orchestrator + one Sonnet coding subagent.**
Cross-form-factor gesture/motion work is the plan's highest UX-risk change and the
exact bug class the owner has corrected before (gesture porting, uninitiated
motion); the orchestrator owns the interaction QA, Sonnet writes the code.

1. Refactor `CopilotPanel` from the fixed full-screen overlay (fact 1) into the
   sheet per approved mockups: partial (~55–60%) and expanded states, spring
   transition consistent with spec §8.7. `TripPage` keeps ownership of
   open/close state (fact 3).
2. Mobile: drag handle with drag-up to expand, drag-down to partial, drag-down
   from partial to dismiss. Touch targets ≥ 44px. Expanded state may also be
   exited via the header control.
3. Desktop/pointer: explicit expand/collapse header control and close button;
   no drag affordance rendered (P3). Keyboard: Escape closes.
4. **P2 hard rule:** content growth (streaming text, proposal cards) never
   changes sheet height — verify by streaming a long reply at partial height
   and confirming the sheet stays put while the thread scrolls (fact 13
   behavior preserved inside the sheet).
5. Everything currently in the panel keeps working unchanged (P8): messages,
   streaming + Stop, proposal cards with apply/reject/status/loss warnings,
   attribution, owner-only clear, error copy. If Plan 12 Wave 4 has landed
   first, the tool-activity line and verified badge are preserved (dependency
   posture above).
6. Frontend build clean; existing frontend suites green.

Acceptance (real browser, dev servers per `trippy-copilot-local-qa`, verified at
375px and a desktop width): open FAB → sheet at partial height with the plan
readable behind it; drag up → full screen; long streamed reply at partial →
sheet height unchanged, content scrolls; desktop shows the explicit control and
no drag handle; all Plan 11 Wave 3 acceptance flows still pass inside the sheet.

## Wave 3 — Context-aware FAB and context passing (frontend + backend)

**Status: NOT STARTED. Blocked on Wave 1 approval.**
**Model recommendation: Sonnet medium solo.**
Fully specified additive plumbing — the injection point, cache constraint, and
schema are pinned in §0; no design judgment beyond the approved chip mockup.

1. Frontend: `TripPage` composes a context object at open time —
   `{ tab, dayId?, stopId? }` from the route segment and `tripState.activeDayId`
   (fact 3); entry points (Wave 4) pass `stopId`/their own context through the
   same channel. `useCopilot.send(text, context?)` forwards it;
   `copilotApi.send` posts `{ message, context }` (additive per fact 5).
2. Backend: validate context server-side — `tab` from the known set, `dayId`/
   `stopId` must belong to `:tripId` (same trip-membership discipline as
   Plan 11 D12); invalid context is dropped with a log, never a failed turn.
   Inject a compact bracketed context line into the **user turn** in the
   `messages` array (fact 6 — never the cached system prompt), e.g.
   `[Viewing: Plan tab, Day 3 (Hangzhou), stop "West Lake"]` resolved
   server-side from the trip detail so the model sees names, not ids.
3. Migration `029_copilot_message_context.sql`: nullable `context_json` on
   `copilot_messages`; store the validated context with the user message;
   history endpoint returns it (extends the select at `copilot.js:23-32`).
4. Frontend renders the P5 context chip on user messages that carry context —
   live and from history identically (same normalization pattern as proposals,
   fact 12).
5. Tests: context validation (cross-trip id dropped, unknown tab dropped),
   injection composes the resolved line into the model turn and not the system
   prompt, history round-trips `context_json`; chip render test.

Acceptance: opening the co-pilot from the Plan tab on Day 3 and asking "how's
this day looking?" yields an answer about Day 3 without naming it in the
message; the chip shows the context; refresh → chip persists from history; a
turn with no context sends and renders exactly as today.

## Wave 4 — Contextual entry points and seed prompts (frontend)

**Status: NOT STARTED. Blocked on Wave 1 approval (entry-point set signed off there) + Wave 3 (context channel).**
**Model recommendation: Sonnet medium solo.**
Additive UI inside existing components against approved mockups and an
already-built context channel; existing component tests fence regressions.

1. Stop-level entry point: add the approved item to the expanded stop card's
   action row (fact 8) — opens the sheet with `{ tab, dayId, stopId }` context
   and focuses the input (no auto-sent message; the user speaks first). Skip on
   `transit` stops if the mockups say so. `StopCard.test.jsx` stays green.
2. Remaining approved entry points from the Wave 1 sign-off (candidate: the
   Discovery suggestion card action row, fact 10, carrying the suggestion's
   name as context). Implement exactly the signed-off set — nothing more.
3. Seed prompts (P6): replace the empty-state copy (fact 4) with up to 3
   deterministic trip-grounded prompts per the approved mockups — derived in a
   pure frontend util (new `utils/copilotSeeds.js`, unit-tested) from the trip
   detail already in `TripPage` (fact 3): e.g. active day's city + stop count,
   next upcoming booking, a fully-untimed day. Tap → `send(promptText,
   currentContext)`. Empty derivation input (degenerate trip) falls back to a
   single neutral prompt — never lorem, never a blank panel.
4. Frontend build clean; all frontend suites green; verify at 375px.

Acceptance (real browser at 375px): from an expanded stop card, the entry point
opens the sheet at partial height with the stop's chip showing and input
focused; the empty state on a real trip shows prompts naming that trip's actual
places/days; tapping one sends it with context and the reply is about the right
object; no new UI renders anywhere when the sheet is closed.

## Wave 5 — QA, verification, deploy

**Status: NOT STARTED.**
**Model recommendation: Opus medium solo (no coding subagents).**
QA judgment, deploy, and the owner click-script are orchestration work; fixes
found here are small enough to do inline.

1. Full backend suite + frontend build/tests green; migration 029 applies clean
   on a copy of real data.
2. Agent local browser pass over Waves 2–4 acceptance flows on the dedicated QA
   trip (`trippy-copilot-local-qa`), at 375px AND desktop width, both form-factor
   treatments (P3), plus a regression pass over the Plan 11 click-script flows
   inside the sheet.
3. Owner click-script for the production pass (standing preference — agent does
   not drive mutating prod browser sessions): sheet partial/expand/dismiss on a
   real phone, no-auto-expand check on a long reply, context-aware turn from
   Plan tab, stop entry point, seed prompts on a real trip, desktop expand
   control.
4. Confirm server access, then `/deploy` per the deploy skill; post-deploy:
   health check, `context_json` column present in prod, one context-carrying
   turn on the prod test trip renders its chip after refresh.
5. Update this plan's status lines; wrap-up commit.

---

## Open items deliberately NOT in this plan

- Route/distance matrix or geography-comparison tools — future, needs its own
  cost/provider decision (carried from Plan 12).
- Proactive surfacing of trip-health findings (badges, notifications, day-header
  indicators) — requires Plan 12's `check_trip_health` to exist first, and
  Direction G prerequisites apply; entry points here stay user-initiated.
- Live/proactive data (weather, flight status, location) — explicitly deferred
  (review Direction G).
- Undo/restore — revisit only if post-v1 usage shows confirm+warnings is
  insufficient (carried from Plan 11).
- Unsplash production-tier application — separate open follow-up (Plan 10
  close-out).
- Booking-linked stop protection on the regular stops routes — separate product
  decision (carried from Plan 11).
- A Logistics/booking-card entry point ("what does this booking affect?") —
  candidate for a later stage; excluded from v1 unless the owner adds it at the
  Wave 1 sign-off.
