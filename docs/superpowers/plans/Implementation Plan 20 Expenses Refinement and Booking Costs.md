# Implementation Plan 20 — Expenses Refinement and Booking Costs

**Status:** IN PROGRESS — Wave 1 complete (committed `450c493`, 2026-07-21), awaiting owner prod QA after deploy. Waves 2–4 not started.

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
- Dev QA: launch.json servers (frontend :5174, backend :3002); mint an `auth_sessions` row and set `document.cookie` to log in.
- Money is always integer minor units. Conversions happen only in `computeTotals`; every other surface shows original currency.
- Prod migrations table is `_migrations` (irrelevant here — no migration — but do not "helpfully" add one).

---

## Wave 1 — Expenses screen refinement (frontend only)

**Status:** COMPLETE — implemented 2026-07-21, awaiting owner prod QA after deploy. `frontend/src/pages/ExpensesTab.jsx`, `frontend/src/pages/TripPage.jsx`, `frontend/src/components/expenses/ExpenseList.jsx`, `ExpenseSheet.jsx`, `ExpenseSummary.jsx`, `RepaymentsList.jsx`. All items 1a–1g implemented as specified; `frontend/src/components/expenses/ExpenseSummary.test.jsx` updated for the new unestimated copy. `npm test` (178/178) and `npm run build` pass. Verified live in a real browser at 375px against the dedicated "Shanghai - Hangzhou (W3 verify)" QA trip: normalized to-collect grouping (mixed settled/open, currency-safe outstanding sum), payer-only gold mirror line (confirmed present as payer, confirmed absent when payer switched to a second collaborator), FAB clearance, full delete-confirm cycle including a forced backend-down failure (sheet stayed open with inline error, confirm state persisted, retry succeeded and closed the sheet), owed-name suggestion chips (pool composition, payer exclusion, prefix filtering, tap-to-fill), and the wallet route-exit toggle (icon color, origin round-trip back to Logistics, deterministic fallback to the trip's index redirect when no origin is set).

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

**Status:** NOT STARTED

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

**Status:** NOT STARTED

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

**Status:** NOT STARTED

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
