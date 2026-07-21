# Implementation Plan 20 — Expenses Refinement and Booking Costs

**Status:** COMPLETE — all four waves CLOSED, deployed, and owner prod-QA'd (2026-07-21). No migration was needed anywhere in this plan, as forecast. Wave 1 CLOSED (committed `450c493`, deployed `a2e93f0`, owner prod QA passed 2026-07-21 via the click-script). Wave 2 CLOSED (committed `6e71a1b`, deployed 2026-07-21, owner prod QA passed 2026-07-21 — all 7 click-script items confirmed). Wave 3 CLOSED (committed `33c62d0`, deployed 2026-07-21, owner prod QA passed 2026-07-21 — all 9 click-script steps confirmed). Wave 4 CLOSED (committed `1e7f4e2`, deployed 2026-07-21, owner prod QA passed 2026-07-21 — all 8 click-script steps confirmed).

**Written:** 2026-07-21, from the [expenses experience review](../reviews/2026-07-20-expenses-experience-and-booking-costs-review.md) (§9 records the binding owner decisions) after an independent code-verified assessment. This plan is self-contained: every file path, payload shape, and gotcha below was verified against the live code on 2026-07-21 at commit `dc38d00`. Do not re-derive these facts; trust them unless the code has visibly moved.

**Schema impact: NONE.** No migration is needed anywhere in this plan. Migration 031 already provides everything (`expenses.booking_id` nullable FK with `ON DELETE SET NULL`, `expense_owed` with `ON DELETE CASCADE`). Bookings must never gain a price column.

---

## Model recommendation per wave

| Wave | Recommendation | Why |
| --- | --- | --- |
| W1 | Sonnet medium, solo | Frontend-only, fully specified below down to copy and CSS; no cross-cutting judgement left. |
| W2 | Sonnet medium, solo | One bounded SQL aggregate plus display components; the read-model decision is already made. |
| W3 | Opus medium (or Opus orchestrator + one Sonnet coder) | Composite create atomicity, FX-default subtleties, and prop-threading across ExpenseSheet call sites need judgement beyond the spec. |
| W4 | Opus medium (or Opus orchestrator + one Sonnet coder) | Destructive, transactional, multi-record; failure-state handling is where cheap models cut corners. |

QA for every wave: run automated tests locally, exercise the flow in a real browser at 375px via the dev servers, then hand the owner a click-script for prod verification after deploy (the owner runs production browser passes, not the agent).

---

## Binding product decisions (from review §9)

1. **Mirror line is payer-only.** The diary shows "X owes you …" only when `expense.payerUserId === current user id`. Non-payer viewers see the plain row. This is presentation altitude, not privacy — all data stays visible in the expense sheet for every collaborator.
2. **Settled rows stay inline**, struck-through, with toggle-back. Never remove them from the list on settle. No "Settled recently" section in this plan.
3. **Booking-delete review shows repayment consequences per checked line**, plus an aggregate on the confirm button.
4. **Rows are shared, totals are personal.** Booking badge/detail counts all linked expenses (any payer, with payer initial shown per line); the Expenses summary stays scoped to the viewer's own expenses (existing `computeTotals` behaviour — do not change it).
5. **Owed names get entry-time suggestion chips + normalized grouping.** Normalized key = lowercase with all internal whitespace removed. Display form = first-entered spelling.
6. **Replace the expense-row link glyph** (11px `Link2` icon) with the linked booking's title in the mono metadata line (W2).
7. Out of scope, unchanged from review §8: stop-side capture, price columns, refunds/negative expenses, filters/budgets, public-share exposure, fifth nav tab.

---

## Verified code map (read this before touching anything)

**Backend**
- `backend/src/services/expenses.js` — full CRUD + `computeTotals` (viewer-scoped) + FX stamping. `listExpenses` awaits a bounded FX-stamping pass up to `LIST_STAMP_BUDGET_MS = 700` ms — **never call it just to render a badge**.
- `backend/src/routes/expenses.js` — all expense routes under `requireAuth` + `requireTripAccess`, trip-scoped paths.
- `backend/src/services/bookings.js` — `formatBooking` (line ~15) is the single serialization point; `listBookings` (line ~64) feeds both `GET /trips/:tripId/bookings` and the trip-detail payload. `deleteBooking` (line ~153) deletes booking-required stops, nulls stop links, deletes the booking. `createBooking` is async only because of `syncStopWithBooking`; the DB writes are synchronous.
- `backend/src/routes/bookings.js` — `POST /trips/:tripId/bookings` (create), `DELETE /bookings/:bookingId` (delete; access via `assertBookingAccess` inside the service, no trip in path).

**Frontend**
- `frontend/src/pages/ExpensesTab.jsx` — route page. **Known bug at lines 44–47:** `handleDelete` does `.catch(() => {})` then closes the sheet — a failed delete is silently swallowed. W1 fixes this.
- `frontend/src/components/expenses/RepaymentsList.jsx` — already computes `expenseTitle` per row (line 18) but never renders it. Filters to `payerUserId === currentUserId`. Groups by raw `row.name` string equality.
- `frontend/src/components/expenses/ExpenseList.jsx` — diary row: category icon circle, title, mono date line with the 11px `Link2` glyph, right column amount + `est.`/`unestimated`, payer-initial circle.
- `frontend/src/components/expenses/ExpenseSummary.jsx` — headline `Spent`, secondary lines, unestimated note currently `+ ¥… unestimated` (line 29).
- `frontend/src/components/expenses/ExpenseSheet.jsx` — add/edit on `ModalShell` (`zBase={220}`). Owed rows live in the collapsed "More" section; Delete button in footer calls `onDelete(expense.id)` directly with no confirmation.
- `frontend/src/hooks/useExpenses.js` — list/create/update/delete/toggleOwedSettled (optimistic with snapshot rollback), silent single FX refetch after 3 s.
- `frontend/src/pages/TripPage.jsx` — mounts `CopilotFab` on every route when the panel is closed (line ~171). Wallet button in the TopBar actions does `navigate(\`/trips/${tripId}/expenses\`)` with `aria-label="Open trip expenses"` (line ~135).
- `frontend/src/pages/LogisticsTab.jsx` — booking detail sheet with the correct delete pattern to copy: `handleDeleteBooking` (lines 91–100) keeps errors visible and resets confirm state on failure.
- `frontend/src/hooks/useTrip.js` — bookings come from the trip-detail payload (`detail.bookings`, line 62); `useBookings` mutations call `onChanged: tripState.refresh`.

**Gotchas from prior plans (all learned the hard way — do not relearn):**
- All ids are **hex strings**. Never `Number()` a form value that holds an id (Plan 19 W3 regression).
- `.modal-input` sets `width:100%` and beats Tailwind `w-*` utilities; use inline style for narrower inputs (see ExpenseSheet owed amount input).
- The in-app Browser pane runs pages as `document.hidden` → requestAnimationFrame paused → framer-motion animations freeze at frame 0. Verify settled end-states, let the owner confirm motion.
- Dev QA: launch.json servers (frontend :5174, backend :3002). Use the **Claude in Chrome extension** for browser QA, not the in-app Browser pane — the pane runs the tab as `document.hidden` (see below) and its `document.cookie` auth-mint approach did not authenticate in this session (401s from `/api/auth/me` despite a validated `auth_sessions` row and correct cookie); Chrome extension against an already-logged-in localhost:5174 tab worked immediately with no login friction.
- A second dev-only user, **"Sam QA"** (`e8be62d8a35ec71c7893ef0dd6108b60`), exists as a collaborator on the "Shanghai - Hangzhou (W3 verify)" trip in the local dev DB (`backend/data/trippy.db`) — created during Wave 1 QA specifically so payer/non-payer scenarios (e.g. the mirror line's payer-only rule) can be tested with two real accounts without minting throwaway data each session. Local-only, never touches prod.
- Money is always integer minor units. Conversions happen only in `computeTotals`; every other surface shows original currency.
- Prod migrations table is `_migrations` (irrelevant here — no migration — but do not "helpfully" add one).

---

## Wave 1 — Expenses screen refinement (frontend only)

**Status:** CLOSED — owner prod QA passed 2026-07-21, all 5 click-script flows confirmed. Implemented 2026-07-21 (commit `450c493`); deployed to prod 2026-07-21 (commit `a2e93f0`, container `trippy-trippy-1` rebuilt and healthy, `/api/health` OK, no migration — schema untouched). `frontend/src/pages/ExpensesTab.jsx`, `frontend/src/pages/TripPage.jsx`, `frontend/src/components/expenses/ExpenseList.jsx`, `ExpenseSheet.jsx`, `ExpenseSummary.jsx`, `RepaymentsList.jsx`. All items 1a–1g implemented as specified; `frontend/src/components/expenses/ExpenseSummary.test.jsx` updated for the new unestimated copy. `npm test` (178/178 frontend, 650/650 backend) and `npm run build` pass. Verified live in a real browser at 375px against the dedicated "Shanghai - Hangzhou (W3 verify)" dev QA trip: normalized to-collect grouping (mixed settled/open, currency-safe outstanding sum), payer-only gold mirror line (confirmed present as payer, confirmed absent when payer switched to a second collaborator), FAB clearance, full delete-confirm cycle including a forced backend-down failure (sheet stayed open with inline error, confirm state persisted, retry succeeded and closed the sheet), owed-name suggestion chips (pool composition, payer exclusion, prefix filtering, tap-to-fill), and the wallet route-exit toggle (icon color, origin round-trip back to Logistics, deterministic fallback to the trip's index redirect when no origin is set). Post-deploy: confirmed prod serves the Expenses route cleanly (no console errors, correct commit, healthy container) but did not exercise the full interactive flow against real trip data — no prod trip currently has expenses tracking started, and the agent does not enter data into real trips (see owner click-script below). Wave marked COMPLETE only after owner prod QA passes.

No backend changes. All data already arrives in the list payload (each expense nests its `owed` rows; `RepaymentsList` already derives `expenseTitle`).

### 1a. Source-resolved "To collect"

In `ExpensesTab.jsx`, rename the section heading `Open repayments` → `To collect` and move the section **above** `Recent entries`, directly after the summary, but only when it has rows; keep the current position/empty-copy behaviour when empty ("No one owes you anything on this trip right now.").

In `RepaymentsList.jsx`:
- Group by **normalized name key** (`name.toLowerCase().replace(/\s+/g, '')`), display the first-encountered raw spelling as the group label.
- Per person, render a header line `Name · <sum> outstanding` **only when all open rows share one currency**; with mixed currencies, render the name alone — never invent a cross-currency total.
- Each child row: expense title (fallback: category label via `categoryMeta`, same fallback the diary uses) + amount + `Mark settled` button. The title is a button that calls a new `onOpenExpense(expenseId)` prop → `ExpensesTab` opens `ExpenseSheet` in edit mode for that expense (it already has `openEdit`; look the expense up by id from `expenses`).
- Settled rows stay inline struck-through with the existing toggle-back (decision 2). Keep the existing `settled ? 'Settled' : 'Mark settled'` button states and colors.
- 375px layout: child row is `flex items-center gap-3`; title `min-w-0 flex-1 truncate`; amount and button `shrink-0`. Long titles truncate — they must not push the settle button off-screen or wrap the amount.

### 1b. Diary repayment mirror

In `ExpenseList.jsx`, add one line to a row **only when** `expense.payerUserId === currentUserId` (thread `currentUserId` as a new prop from `ExpensesTab`) **and** the expense has ≥1 open (unsettled) owed row:
- One person: `Sarah owes you ¥50.00` (original currency, `formatMinor`).
- Multiple people: `2 people owe you ¥80.00` when one currency; `2 people owe you` when mixed currencies.
- Style: mono `text-[10px]`, color `var(--gold)` — this is the row's one permitted gold accent; if a row needs gold elsewhere later, this line drops to `--cream-dim`. Rows without open owed rows are pixel-identical to today.

### 1c. FAB clearance

In `ExpensesTab.jsx`, add bottom padding to the page container (the `max-w-2xl` div): `pb-28` (~112px) so the final settle button clears the co-pilot FAB. Do **not** touch `TripPage`/`CopilotFab` — no route-aware FAB suppression, no new chrome. Verify at 375px with the *last* repayment row: it must be fully tappable with the FAB visible.

### 1d. Expense delete confirmation + error handling

- In `ExpenseSheet.jsx`, tapping Delete no longer calls `onDelete` directly. It switches the footer's left slot to an inline confirm (copy the `confirmDelete` pattern from `LogisticsTab.jsx` lines 315–344): a plain `Cancel` text button and a red-bordered `Delete expense` button (`#e05a5a` / `rgba(224,90,90,0.28)` per existing convention). Above the footer (or as the ErrorBanner slot), state the consequence: `Delete "<title or category label>"? This removes the <amount> expense` plus, when owed rows exist, ` and <n> repayment record(s)` — name the person when n = 1 (`and Sarah's ¥50 repayment record`). Visual weight stays on Cancel.
- In `ExpensesTab.jsx`, fix `handleDelete`: remove `.catch(() => {})`; on failure keep the sheet open and surface the error inside the sheet (pass a delete-error setter or return the rejection to `ExpenseSheet` and reuse its `setError`). Close only on success. Confirm-state resets whenever the sheet opens (extend the existing `useEffect [open]` reset).
- Mis-tap protection: the initial Delete and the confirming Delete must not occupy the same screen position, so a double-tap cannot pass through both.

### 1e. Summary exclusion copy

In `ExpenseSummary.jsx` line 28–31, change the unestimated note to: `Not included in total yet: + ¥12,400 unestimated` (prefix once, then the existing joined per-currency list). Keep the diary rows' `unestimated` label unchanged.

### 1f. Route exit

- In `TripPage.jsx`, when `location.pathname` ends with `/expenses`: the wallet TopBar button becomes an active toggle — gold icon color, `aria-label="Close trip expenses"` — and clicking it (or a small adjacent `Close` control if the orchestrator judges the toggle alone too subtle at 375px) navigates back to the in-trip origin.
- Origin tracking: pass `state: { from: location.pathname }` in the wallet button's `navigate` call; on close, `navigate(state?.from)` when it is a same-trip path, else fall back to `/trips/${tripId}` (deterministic in-trip fallback — never the Trips list, never `history.back()` blindly, which breaks deep links).
- Do **not** bind Escape to route close; Escape keeps its modal/sheet meaning.

### 1g. Owed-name suggestion chips

In `ExpenseSheet.jsx`'s owed rows ("Someone owes me"):
- Build a suggestion pool: distinct owed names across `expenses` (thread the list or a precomputed name array as a new prop from `ExpensesTab`) plus collaborator `displayName || username` values, minus the current payer's own name, deduped by the normalized key (first spelling wins), sorted by frequency then alphabetically.
- Under a focused, still-empty name input, render up to ~6 chips (mono 10px, `--ink-border` border, tap fills the input). Filter chips by prefix once typing starts; hide when the input matches a chip exactly.
- Keyboard-open reachability at 375px matters: chips render *below* the input inside the scrollable form body, not in a floating layer that the software keyboard can cover.
- No backend rewrite of stored names — normalization is a comparison key, never a data migration.

**W1 verification:** `cd frontend; npm test; npm run build`. Browser at 375px: to-collect grouping with deliberately variant names, mirror line as payer and as non-payer (two accounts), settle/unsettle round-trip, delete confirm + forced failure (kill backend) keeps sheet open with error, last settle row clears the FAB, wallet toggle round-trips from Plan and from a direct URL load.

---

## Wave 2 — Booking linked-cost read model + disclosure

**Status:** CLOSED — owner prod QA passed 2026-07-21, all 7 click-script items confirmed. Implemented and deployed to prod 2026-07-21 (commit `6e71a1b`, container `trippy-trippy-1` rebuilt and healthy, `/api/health` OK, no migration — schema untouched). Corrects one plan fact discovered mid-implementation: `bookings.js`'s `listBookings`/`formatBooking` do **not** feed the trip-detail payload as this plan originally stated — `trips.js` has its own independent booking serializer (`mapBooking`/`listBookingsForTrip`), and `getTripDetail` (backed by `listBookingsForTrip`) is what `useTrip.js`/`detail.bookings` and therefore every frontend booking list (LogisticsTab, ExpensesTab) actually consume. `GET /trips/:tripId/bookings` (bookings.js's `listBookings`) is a separate, currently frontend-unused route. Implemented the `expenseSummary` aggregate in both places (a small duplicated grouped-query helper per file, matching the codebase's existing duplicate-serializer convention) rather than sharing one to avoid a trips.js↔bookings.js circular import. `listBookingsForTrip` itself stays a plain read (used internally by geo derivation in days.js/getDayGeo/share.js); the aggregate is attached only in `getTripDetail`, right before the response is assembled, and in bookings.js's `listBookings`. `createBooking`/`updateBooking` responses intentionally return `expenseSummary: null` (documented in code) — the next list/detail refresh carries the real value.

Backend: `backend/src/services/bookings.js`, `backend/src/services/trips.js`. Tests: `backend/tests/bookings.test.js` (+4), `backend/tests/trips.test.js` (+3, including the public-share regression guard — confirmed structurally: `share.js`'s `buildPublicTripDetail` never serializes `bookings` into its response at all, so `expenseSummary` can't leak). 657/657 backend, 178/178 frontend, `npm run build` all pass.

Frontend: `frontend/src/components/logistics/bookingCardUtils.js` (`costLineText` helper), `HotelBookingCard.jsx`/`OtherBookingCard.jsx` (new COST row, simplified `last`-row logic since COST always renders), `TicketStubCard.jsx` (new `costLine` footer row, deliberately non-gold — the ticket's one gold accent stays on the booking-ref value), `FlightBookingCard.jsx`/`TrainBookingCard.jsx` (wire `costLine`), `ExpenseList.jsx` (Link2 glyph replaced with the linked booking's title in the mono metadata line, `truncate` added), `ExpensesTab.jsx` (passes `bookings` through), `ExpenseSheet.jsx` (new `presetBookingId` prop — auto-expands "More" and preselects the booking when opened for a new prelinked expense), `LogisticsTab.jsx` (booking detail sheet gains a "Costs" section listing linked expenses with title/amount/payer-initial, each opening that expense in edit mode; "Add cost"/"Add another cost" opens the same `ExpenseSheet` prelinked via its own `useExpenses`/`useCollaboration` instance; save/delete call `refresh()` on the trip context so the card badge updates without a reload — no state-lifting into `TripPage`, deferred to W3's refresh-invariant work as the plan anticipated).

Verified live via the dev servers (frontend :5174, backend :3002) against the "Shanghai - Hangzhou (W3 verify)" trip at 375px using the Claude-in-Chrome extension (already-authenticated tab, per the established QA preference): all three card faces (`Add cost` / `Cost · ¥88.50` / `2 costs logged`) render correctly on hotel and flight/ticket cards; the flight and both hotel bookings' "Add cost"/"Add another cost" open `ExpenseSheet` correctly prelinked (verified via the select's actual `.value`, not `innerText` — a `<select>`'s innerText lists every option regardless of which is selected, a false alarm hit once during this QA pass); a real save round-trips instantly to `2 costs logged` on the card face and to the correct linked-expense list in the detail sheet; the Expenses screen's diary rows show `2026-07-21 · PARK HYATT HANGZHOU` / `PARK HYATT SHANGHAI` in place of the old link glyph. Post-deploy: confirmed prod serves `/trips` cleanly (HTTP 200, correct `<title>Trippy</title>`, healthy container, no migration ran); owner then ran the 7-item click-script in chat (delivered directly in chat rather than as a separate file) and confirmed all 7 pass — prelinked "Add cost" on both hotel and flight cards, card badge flipping live (`Add cost` → `Cost · …` → `N costs logged`), detail-sheet linked-expense list, and the Expenses diary's booking-title glyph replacement. Wave marked CLOSED.

### Backend read model

In `backend/src/services/bookings.js`, batch-compute per-booking expense aggregates inside `listBookings` — **one grouped query, not per-row work, and never via `listExpenses`** (its 700 ms FX-stamping budget would tax every trip-detail load):

```sql
SELECT booking_id, COUNT(*) AS count,
       MIN(id) AS only_expense_id, MIN(amount) AS only_amount, MIN(currency) AS only_currency
FROM expenses WHERE trip_id = ? AND booking_id IS NOT NULL
GROUP BY booking_id
```

(The `MIN()` columns are only trusted when `count = 1`, where they are exact.) Attach to each serialized booking:
`expenseSummary: null | { count, single: null | { expenseId, amount, currency } }` — `single` populated only when `count === 1`. Counts are trip-wide, any payer (decision 4). Extend `formatBooking` to accept the precomputed aggregate as an optional second argument so single-booking paths (`createBooking`/`updateBooking` returns) stay valid — they may return `expenseSummary: null` and rely on the list refresh, or compute their own small lookup; pick one and keep it consistent.

Public-share regression guard: confirm the share serialization path does not reuse this booking serializer, or explicitly strips `expenseSummary`; add a test asserting the share payload contains no expense data.

### Logistics card + detail sheet

In `LogisticsTab.jsx` (and the booking card component it renders, if separate):
- Card face, one mono line, per review §3.2 exactly: no linked expense → `Add cost` (only when the current user can edit); one → `Cost · ¥42,000` (original currency); several → `3 costs logged`. No payer, no repayment state, no converted totals, no summing across currencies on the card face — ever.
- `Add cost` opens the ExpenseSheet prelinked (full behaviour lands in W3; in W2 it may open the existing sheet with `bookingId` preset via the current props if trivially wireable, otherwise render the state read-only and note W3 completes it).
- Booking detail sheet: list each linked expense as `title-or-category-label · original amount · payer initial` (initial per decision 4), each row opening that expense in the ExpenseSheet. Fetching detail rows may reuse the already-loaded expenses list if Logistics gains access to it (see W3 refresh note) — do not add a per-booking expenses endpoint.

### Expense-row glyph replacement

In `ExpenseList.jsx`, replace the 11px `Link2` icon with the linked booking's title appended to the mono metadata line: `2026-07-20 · SQ 826`. Truncate the combined line (`truncate` already applies to the parent block — verify the metadata span gets `truncate` too). Requires a `bookings` prop (already available in `ExpensesTab` via trip context) to map `bookingId` → title; fall back to the bare date when the booking is missing (stale link).

**W2 verification:** `cd backend; npm test` (new aggregate tests: 0/1/many, mixed currencies, other-payer counted, share payload clean). Browser: card states for 0/1/3 costs, glyph replacement legible at 375px, payer initials correct with two accounts.

---

## Wave 3 — Booking-context create/edit

**Status:** CLOSED — owner prod QA passed 2026-07-21, all 9 click-script steps confirmed. Implemented and deployed to prod 2026-07-21 (commit `33c62d0`, container `trippy-trippy-1` rebuilt and healthy, `/api/health` OK, no migration — schema untouched; deployed bundle verified to carry the W3 strings; restore point `trippy-2026-07-21-030001.db`).

**Refresh-invariant decision (the one the plan left to the orchestrator): per-route `useExpenses` stores, NOT lifted into `TripPage`.** Owner-approved. Lifting would fire `GET /api/trips/:id/expenses` — which carries `listExpenses`' 700 ms FX-stamping budget — on *every* trip route mount (Today, Plan, Map), to serve a screen most sessions never open. `ExpensesTab` and `LogisticsTab` each own a `useExpenses` that refetches on mount, and they are never mounted simultaneously, so the two stores cannot visibly diverge. `LogisticsTab` already calls `tripState.refresh()` (card badge) plus its own `expensesState.refresh()` after any cost write. No third cache was built.

**Backend** (`backend/src/services/expenses.js`, `backend/src/services/bookings.js`): `createExpense` was split into three exported pieces with byte-identical external behaviour — `prepareExpenseCreate` (all validation/resolution, zero DB writes), `insertPreparedExpense(db, prepared, bookingIdOverride)` (inserts, must run inside a caller-owned transaction), `finalizeExpenseCreate` (post-commit `scheduleStamp`). `createBooking` now accepts an optional `cost` object: it rejects a `cost.bookingId` key with 400, calls `prepareExpenseCreate` **before** any write so an invalid cost throws with nothing persisted, then does the booking INSERT and the expense INSERT in one `db.transaction`. `syncStopWithBooking` stays outside/after (async, non-monetary). The create response now carries a real `expenseSummary: { count: 1, single: {...} }` when a cost was created — this corrects the Wave 2 code comment that claimed it is always null on create. No circular import: `expenses.js` never imports `bookings.js`, and `trips.js` never imports `bookings.js` (verified).

**Frontend**: `ExpenseSheet.jsx` replaces W2's `presetBookingId` with `fixedBookingId` (hides the booking `<select>`; renders the booking title as static `font-mono` text at the top of the form, above Amount) and `defaults` (partial `emptyForm` overrides). The W2 auto-expand-"More" hack is gone — "More" starts collapsed as it always did. New `frontend/src/components/expenses/bookingCostDefaults.js` owns `CATEGORY_BY_BOOKING_TYPE` (hotel→lodging; flight/train/bus/ferry→transport; other→other) and `bookingCostDefaults(booking, currentUserId)` → title from booking, category by type, `expenseDate` = today (purchase date, editable), payer = current user. `AddBookingModal.jsx` gains an optional collapsed `Booking cost` disclosure (amount + `CurrencyChip` + `Date paid`), create mode only. `toMinorUnits` was hoisted out of `ExpenseSheet` into `frontend/src/utils/currency.js` and is now shared.

**Deviations from the written spec (both deliberate, found in orchestrator code review):**
1. `AddBookingModal`'s cost is gated on the amount field alone, not on the disclosure being open, and **collapsing the disclosure clears the amount**. The as-written `costOpen && costAmount` gate would silently drop a typed cost if the user collapsed the section before saving — unacceptable for financial input.
2. `LogisticsTab`'s `addCostDefaults` memoises on the booking's `id`/`type`/`title` primitives, not the booking object. `bookings` gets a fresh array identity on every `tripState.refresh()`, and `ExpenseSheet` resets its form when `defaults` changes identity — the object form would have wiped an in-progress cost entry on any background refresh. Same bug class as Plan 11's title-pin regression.

**Verification.** `cd backend; npm test` → 663/663 (657 baseline + 6 new composite-create tests in `backend/tests/bookings.test.js`). `cd frontend; npm test` → 178/178; `npm run build` clean. Browser-verified against the "Shanghai - Hangzhou (W3 verify)" dev trip via the Claude-in-Chrome extension: composite create (hotel + ¥640.50 cost) → card badge showed `Cost · ¥640.50` immediately, and the persisted expense carried title-from-booking, `category: lodging`, `expenseDate` = today, correct `bookingId` and payer; prelinked `Add another cost` → static "Linked booking" line with the booking title, zero `<select>` elements in the form (picker suppressed, "More" collapsed), title/category/date all seeded, save flipped the badge live to `2 costs logged`; refresh invariant → both booking-context costs appeared in the Expenses diary, in the summary total, and with W2's booking-title metadata line, with no reload; live atomic-rollback probe against the running server (`cost.amount: 0`) → 400 with the booking count unchanged and no orphan row; client guard → inline `Booking cost must be a positive amount.` with the modal open and no booking created; collapse-clears-amount confirmed. Layout measured with the modal container clamped to 375 px (Chrome on Windows enforces a ~500 px minimum window width, so the viewport itself could not be set to 375): zero horizontal overflow on both new blocks, amount input + currency chip fit within the shell, linked-booking line renders in DM Mono at `rgb(240,234,216)` = `#f0ead8` with no truncation, no new gold introduced. No console errors.

**Owner prod QA (2026-07-21, phone width):** all 9 click-script steps passed — collapsed `Booking cost` disclosure defaulting to today's purchase date; the zero-amount guard holding the modal open with nothing half-saved; the card badge appearing as `COST · …` with no reload; the prelinked sheet showing a static linked-booking line with no picker and "More" collapsed; the badge flipping to `2 costs logged`; both costs landing in the Expenses diary and the SPENT total; and the post-delete state where costs survive unlinked (current, correct pre-W4 behaviour).

**Dev-DB note for Wave 4:** local QA left a "Hangzhou Airport Transfer Lodge" hotel booking on the W3-verify trip with **two** linked costs (¥640.50 + ¥120.00). Deliberately kept — W4's booking-deletion review needs exactly this fixture (a booking with multiple linked expenses).

### Prelinked ExpenseSheet reuse

Add props to `ExpenseSheet`: `fixedBookingId` (hides the booking `<select>`, shows the booking title as static text) and `defaults` (partial overrides of `emptyForm`). Booking-context defaults:
- title seeded from the booking title (editable);
- category by booking type: `hotel → lodging`, `flight/train → transport`, `other → other`;
- `expenseDate` = today (purchase date, visibly editable — never silently the travel date);
- payer = current user; currency = existing `defaultCurrency` logic; owed rows, manual FX, note all retained.
- Never rewrite an existing expense's title/date when its booking later changes — an expense is its own financial record.

`Add another cost` in the booking detail sheet reuses the same prelinked path. The Expenses screen's free-form booking picker stays as-is.

**Refresh invariant:** an expense saved from booking context must appear in Expenses, the summary, and the booking badge without a full reload. Simplest safe wiring: Logistics uses its own save path that on success calls both `tripState.refresh()` (badge) and, if `useExpenses` state is mounted, its `refresh()`. Since `ExpensesTab` owns `useExpenses` locally today, the orchestrator must decide: either lift `useExpenses` into `TripPage` outlet context (preferred — one store, both routes consistent) or accept refetch-on-route-entry (already free, `useExpenses` refetches on mount). Do not build a third cache.

### Composite create (new booking + first cost)

Extend `POST /trips/:tripId/bookings` with an optional `cost` object (same field names as the expense-create body minus `bookingId`). In `createBooking`, wrap the booking insert **and** the expense insert (reuse `createExpense`'s validation pieces or a shared internal helper — do not duplicate owed/amount/category validation) in one `db.transaction`; `syncStopWithBooking` stays outside/after, as it is async and non-monetary. Either both rows persist or neither. FX stamping for the new expense schedules after commit exactly as `createExpense` does.

Booking form UI: an optional collapsed `Booking cost` disclosure (amount + currency + optionally date; everything else takes the defaults above). Filling it and saving creates both records; a validation error from the cost (e.g. owed > amount can't occur here, but bad amount can) must fail the whole save with the form open and the error visible.

**W3 verification:** backend tests: composite create commits/rolls back atomically (inject invalid cost → no booking row); prelinked create validates `bookingId` trip membership (existing `resolveBookingId` covers the standalone path — test the composite path too). Browser: create booking with cost → badge shows `Cost · …` immediately; add second cost from detail sheet → `2 costs logged`; edit from booking context → diary updates.

---

## Wave 4 — Booking deletion review

**Status:** CLOSED — owner prod QA passed 2026-07-21, all 8 click-script steps confirmed. Implemented and deployed to prod 2026-07-21 (commit `1e7f4e2`, container `trippy-trippy-1` rebuilt and healthy, `/api/health` OK, deployed bundle verified to carry the W4 strings, prod DB counts unchanged and migrations still at 031 — no migration, as planned; restore point `trippy-2026-07-21-030001.db`).

Owner prod QA note: prod carried **no open owed rows** at deploy time, so the click-script had the owner create one (step 4) before the per-checked-line repayment consequence could be exercised at all. Keep this in mind for any future repayment-facing verification — an empty `expense_owed` silently makes that whole surface untestable.

**Backend** (`backend/src/services/bookings.js`, `backend/src/routes/bookings.js`): `deleteBooking(userId, bookingId, options = {})` accepts `options.deleteExpenseIds`. It validates the payload shape (array of non-empty strings, deduped preserving order) and then **every** id — existence, `trip_id` match (404, so cross-trip existence never leaks), and `booking_id === bookingId` (400) — all **before** the transaction opens, following Wave 3's `prepareExpenseCreate` validate-then-write pattern. One `db.transaction` then deletes the selected expenses (`expense_owed` cascades), runs the two pre-existing stop statements, and deletes the booking. Returns `{ ok: true, deletedExpenseCount }`. Unlisted linked expenses are left to migration 031's `ON DELETE SET NULL`, which needs no code. The route passes `req.body || {}`.

**Frontend**: new `frontend/src/components/logistics/BookingDeleteReview.jsx` (checkbox list, all unchecked; per-checked-line repayment consequence; `Select all`/`Clear all`; aggregate confirm label; `max-h-[40vh] overflow-y-auto` list so the footer stays reachable). `LogisticsTab.jsx` shows it only when the booking has linked expenses — a booking with none keeps the existing lightweight inline `Confirm?` flow untouched. `bookingsApi.remove`/`useBookings.deleteBooking` gained the optional id array (sent as a body only when non-empty, so a zero-selection delete is byte-identical to the old request).

**Orchestrator corrections to the delegated code (all root-cause, not polish):**
1. **Owed-name normalization was missing from the people count.** The consequence line counted distinct *raw* names, so `Sarah` and `sarah ` would have read "across 2 people" in a destructive warning — precisely what decision (e) exists to prevent. The normalization key was already duplicated in `ExpenseSheet.jsx` and `RepaymentsList.jsx`; rather than add a third copy it was extracted to `frontend/src/utils/owedNames.js` (`normalizeOwedName`) and all three now import it. Behaviour of W1's grouping/chips is unchanged.
2. **Concurrent-delete left the dialog unrecoverable.** A cost deleted on another device 404s the whole request (correctly), but the stale row stayed in the list, stayed checked, and was resent on every retry — an infinite failure loop. Fixed at both ends: `handleDeleteBooking` now re-syncs `expensesState` on failure (safe to await inside `catch` — `useExpenses.refresh` captures its own errors and never rejects), and the review sends `expenses.filter(selected)` rather than the raw selection Set, so a dead id can never be transmitted. `allSelected` likewise derives from the live list. This implements the plan's "offer the user a refresh" as self-healing rather than a manual button.
3. **Browser-default checkboxes.** The delegated code shipped stark white system checkboxes against the obsidian palette; the codebase already had a convention (`accentColor: 'var(--gold)'` in `ExtractedBookingCard.jsx` and `AddBookingModal.jsx`) which is now applied. Gold is the component's only accent; the destructive red stays exclusive to the confirm action.

**Tests.** Backend `backend/tests/bookings.test.js` +9 (no body, empty array, one selected, many selected, foreign-trip id → 404 with booking *and* all expenses intact, same-trip-different-booking id → 400, unlinked id → 400, nonexistent hex id → 404, non-array payload → 400) → **672/672**. New `frontend/src/components/logistics/BookingDeleteReview.test.jsx` +9 covering unchecked-by-default, consequence only for checked rows, settled owed rows never counted as open, the spelling-variant single-person case, multi-person, mixed-currency confirm label, the dead-id drop on re-render, select all/clear all, and the error state → **187/187**. `npm run build` clean.

**Browser-verified** against the "Shanghai - Hangzhou (W3 verify)" dev trip via the Claude-in-Chrome extension, on a fixture grown to 4 linked costs on one booking (two currencies, a 60-char title, one cost owed by two people, one owed by the same person under two spellings): dialog renders all four unchecked with the long title truncating and no row pushing the amount off; consequence lines appear only on check and read `includes Sarah's ¥120.00 open repayment` (the normalization fix, confirmed live) and `includes S$42.00 in open repayments across 2 people`; the confirm label reached `DELETE BOOKING AND 2 COSTS · S$42.00 + ¥120.00 IN OPEN REPAYMENTS` — currencies listed, never summed. **Forced failure used the real concurrent-delete scenario**, not a mock: a linked cost was deleted out-of-band mid-review, confirm returned 404, the dialog stayed open with `Expense not found Nothing was deleted.`, the list self-healed 3 → 2 rows with the selection intact and the label correctly dropping its repayment suffix, and a server re-read proved the booking and every remaining expense were untouched. The retry then succeeded: booking gone, the checked cost deleted (9 → 8 expenses), and the unchecked survivor persisted with `bookingId: null` and rendered in the Expenses diary with W2's bare-date fallback. A zero-cost booking (SQ 832) was confirmed to still show the plain `Confirm?` inline flow with no checkboxes and no review copy. Layout measured with the sheet clamped to 375 px: `scrollWidth - clientWidth === 0` on the panel and every descendant. No console errors.

**Known pre-existing behaviour, not a W4 regression:** a failed booking delete also raises `TripPage`'s shared page-level `ErrorBanner`, because `useBookings.run()` sets `bookingActions.error` for every booking mutation and `TripPage` mirrors it (`TripPage.jsx:177`). The banner sits behind the modal, and changing it would affect booking create/update too, so it was left alone.

### Backend

Extend `DELETE /bookings/:bookingId` to accept an optional JSON body `{ deleteExpenseIds: string[] }`. In `deleteBooking`:
- After `assertBookingAccess`, validate **every** id: the expense exists, `expense.trip_id` matches the booking's trip, and `expense.booking_id === bookingId`. Any failure → 400/404, delete **nothing**.
- One `db.transaction`: delete the listed expenses (cascade removes their owed rows), then the existing stop cleanup, then the booking. Unlisted linked expenses are left for `ON DELETE SET NULL` to unlink — verify post-state in tests: surviving rows have `booking_id IS NULL` with owed rows intact.
- Ids are hex strings end to end.

### Frontend delete review dialog

Replace the current inline `confirmDelete` in `LogisticsTab.jsx`'s booking sheet with a review step when the booking has linked expenses (keep the existing simple inline confirm when it has none — don't add ceremony to the common case):
- List every linked expense as an unchecked checkbox: `title-or-category-label · original amount`. **All start unchecked** — financial history is never preselected for deletion.
- Per decision 3: under each line whose expense has open owed rows, a consequence line, e.g. `includes Sarah's ¥50 open repayment` (one person) / `includes ¥80 in open repayments across 2 people` (several). Confirm button aggregates: `Delete booking and 2 costs · ¥80 in open repayments` — original currency; with mixed currencies list them (`¥80 + S$42`), never sum across.
- `Select all` toggle. Helper text: `Unchecked costs stay in Expenses without a booking link.`
- Confirm copy scales: 0 selected → `Delete booking only`; n selected → `Delete booking and n cost(s)` (+ repayment suffix when applicable).
- One request with `deleteExpenseIds`; **no client-side sequential deletes**. On failure the dialog stays open with the error (extend the `deleteError` pattern already at lines 91–100); a 404 from a concurrently-deleted expense fails the whole operation — offer the user a refresh, never partially apply.
- 375px: the checkbox list scrolls inside the sheet body; Cancel/confirm remain reachable in the footer with the list scrolled.

Cancellation-fee guidance (review §4) needs no code: delete refunded costs, add a manual `Cancellation fee — <booking title>` expense, unlinked. Do not build refund/negative-amount support.

**W4 verification:** backend tests: 0/1/many selected; foreign expense id rejected wholesale; transaction rollback leaves booking + expenses intact; unchecked survivors unlinked with owed rows preserved. Browser: full dialog at 375px with 3+ costs and a long title; forced failure keeps the dialog open; post-delete Expenses shows kept costs unlinked (glyph line falls back to bare date).

---

## Cross-wave invariants (assert in code review + tests every wave)

1. `expenses` is the only monetary truth; no booking price column or duplicated monetary field.
2. Owed sum ≤ amount on every write path, including composite create.
3. Original currency everywhere except `computeTotals`; no cross-currency arithmetic in any new UI.
4. Trip-access + ownership checks on every row of every composite operation.
5. Public share payloads carry zero expense/owed/cost data.
6. FX stamping stays non-blocking; nothing new calls `listExpenses` for non-list purposes.
7. Booking↔stop synchronization untouched by W3/W4 changes.
8. Gold accent: at most one per component; the mirror line is the diary row's gold.
9. Typography: all new labels/amounts in DM Mono per the fixed three-font system.

## Deployment

Each wave deploys independently via `/deploy` (git pull + Docker rebuild on the Debian server, container `trippy-trippy-1`, port 6768). No migration step this plan. After deploy, provide the owner a numbered click-script covering the wave's changed flows at phone width; the plan's wave status moves to COMPLETE only after owner prod QA passes.
