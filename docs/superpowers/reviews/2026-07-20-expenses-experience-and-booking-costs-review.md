# Expenses Experience and Booking-Cost Integration Review

**Status:** OPEN — focused product, UX, and architecture review. This is not an implementation plan and does not authorize source, migration, configuration, or deployment changes.

**Review date:** 2026-07-20
**Baseline:** The shipped Plan 19 Expenses tracker; [initial product-fit review](2026-07-19-expenses-tracker-product-fit-review.md); [implementation record](../plans/Implementation%20Plan%2019%20Trip%20Expenses.md).

## Executive conclusion

The next Expenses work should not start with new capture surfaces. It should first repair the **implemented repayment-reading experience**: a repayment must state which expense created it, and that same expense must visibly state that money is still owed. The current screen presents the diary and repayments as disconnected lists, which becomes unworkable as records grow.

After that refinement, booking-side entry is a sound, bounded extension. It should be implemented as **two contextual editors for one canonical expense record**, never as a booking `price` field synchronized with a separate expense. A booking may legitimately have more than one linked expense, so cards should disclose that state quietly and defer the detail to the booking sheet or Expenses.

Direct expense capture from itinerary stops is deliberately **dropped from this exploration**. It introduces a relationship and interaction surface whose value is not yet sufficient to justify the semantic and UI complexity.

## 1. Current evidence and immediate UX problem

The shipped screen renders recent entries followed by a separate `Open repayments` section ([ExpensesTab](../../../frontend/src/pages/ExpensesTab.jsx)). `RepaymentsList` groups owed rows by person, but although it carries `expenseTitle` in its row data, it does not render that field ([RepaymentsList](../../../frontend/src/components/expenses/RepaymentsList.jsx)). A user can see “Sarah owes you ¥50” but cannot see that it arose from, for example, the Popmart expense.

The reverse relationship is also absent: an expense row shows category, date, original/estimated amount, booking glyph, and payer initial, but not any open owed amount ([ExpenseList](../../../frontend/src/components/expenses/ExpenseList.jsx)). The two surfaces therefore cannot be reconciled without opening records one by one.

The attached owner screenshot demonstrates a third, direct interaction issue: the global co-pilot floating button overlaps the `Mark settled` action in the repayments section. That makes a primary action partially obscured on the phone-sized layout. `TripPage` mounts the FAB above every route whenever the panel is closed ([TripPage](../../../frontend/src/pages/TripPage.jsx)); the Expenses route currently makes no allowance for that control.

There is also an immediate destructive-action risk. The Expense sheet exposes `Delete`, and its parent closes the sheet even if deletion fails ([ExpensesTab](../../../frontend/src/pages/ExpensesTab.jsx); [ExpenseSheet](../../../frontend/src/components/expenses/ExpenseSheet.jsx)). There is no confirmation or undo. An accidental tap can therefore permanently remove a financial record and any owed rows attached to it.

Finally, the summary is honest but not fully explicit about its boundary. Unestimated amounts render as a separate `+ ¥… unestimated` note, while the headline continues to read `Spent` ([ExpenseSummary](../../../frontend/src/components/expenses/ExpenseSummary.jsx)). A user reconciling a trip cost can reasonably read the headline as complete. The note must state that these original-currency values are **not included in the headline total yet**.

The route also has no deliberate local exit. Expenses is an authenticated sub-route, but the bottom navigation has no Expenses item and the always-present header return goes to the global Trips list rather than back to the in-trip context ([BottomNav](../../../frontend/src/components/nav/BottomNav.jsx); [TopBar](../../../frontend/src/components/nav/TopBar.jsx)). A user who opens the wallet from Plan or Logistics has no clear, matching way to close it and return to that context.

### Why generic filtering is not the first fix

Sorting by date is already the service default. Generic category, payer, booking, date, and status filters would add controls before restoring the core relationship. A filter can narrow a list, but it cannot explain why someone owes money.

The one potential filter worth assessing after the relationship is repaired is a task-oriented view switch:

- `All entries` — the normal spending diary.
- `Needs settlement` — only entries that have one or more open owed rows paid by the current user.

It should be a compact local view choice, not a general filter system.

### 1.1 Make total exclusion unmistakable

Retain the original-currency unestimated detail, but change the note to explain the arithmetic:

```text
Spent                         S$642.30
Not included in total yet: +¥12,400 unestimated
```

Do not imply that the money did not occur; it is a real spend with an unavailable conversion estimate. The wording distinguishes the source-of-truth original amount from the temporarily incomplete summary-currency total. The diary row can continue to say `Unestimated`; the summary is where total inclusion must be explicit.

### 1.2 Define Expenses as a contextual route with an explicit close behaviour

Expenses is neither a bottom-navigation destination nor a modal. Treat it as a contextual route that needs a visible exit contract:

- Add a labelled close control (`Close expenses`) in the trip header while this route is active. It returns to the in-trip route from which Expenses was opened.
- Make the active wallet control a toggle only if it performs the exact same close-and-return behaviour. It needs an active visual state and an accessible name such as `Close trip expenses`; a second wallet must not unexpectedly navigate somewhere else.
- Preserve deep-link behaviour: if there is no safe same-trip origin, close to a deterministic in-trip fallback rather than relying on browser history or sending the user to the full Trips list.
- Do **not** make `Escape` close the Expenses route. Escape should retain its existing modal/sheet meaning; treating it as page navigation would be surprising on desktop and risks closing the context while a user is editing or recovering from an error.

The implementation plan must inspect analogous contextual routes and header actions before deciding whether the X, active wallet toggle, or both are appropriate. The invariant is not a particular icon: it is that opening the utility has an immediate, visible, and predictable way back.

## 2. Recommended immediate repayment experience

### 2.1 Turn “Open repayments” into a source-resolved task list

Rename the section **To collect** and place it immediately after the summary when it has content. Keep person grouping because it matches the settlement job, but render each source expense as a child row:

```text
TO COLLECT

Sarah · ¥80 outstanding
Popmart                 ¥50    Mark settled
Airport transfer        ¥30    Mark settled

Marcus · S$42 outstanding
Jing'an dinner          S$42   Mark settled
```

Each source title opens the expense editor. The settlement button operates on that exact owed row. If a person owes in more than one currency, do not invent a cross-currency person total; show the original-currency child amounts instead.

Only open rows belong here. Settled rows should disappear from `To collect`; an optional `Settled recently` disclosure can provide history without turning an action list into a mixed-status ledger.

### 2.2 Mirror the state onto the diary entry

An expense with an open repayment should carry one restrained line in the existing diary row:

```text
Popmart
20 Jul · Paid by Chen
Sarah owes you ¥50.00
```

For more than one person on one expense, show a compact summary such as `2 people owe you ¥80.00`, with full names and values available on opening the expense. Entries without an open repayment remain unchanged. This preserves the diary’s low-noise default while making the relationship discoverable in both directions.

### 2.3 Solve the mobile action collision explicitly

The co-pilot FAB must not obscure settlement controls. Before an implementation plan, decide and test one of these coherent remedies:

1. Add enough route-aware bottom clearance to Expenses so the last task row remains fully reachable above the FAB.
2. Suppress or relocate the FAB on the Expenses route while a repayment action is available.
3. Move the `To collect` interaction to a sheet where its footer actions are protected from global chrome.

The first is likely the smallest change, but it must be verified at 375px with the final repayment row, not just with a short list.

### 2.4 Protect expense deletion

Expense deletion needs the same deliberate treatment as booking deletion, but simpler because it affects one record:

```text
Delete “Popmart”?
This removes the ¥100 expense and Sarah’s ¥50 repayment record.

[Cancel] [Delete expense]
```

The default focus and visual weight must remain on `Cancel`; the destructive action should be explicit. If deletion fails, keep the expense sheet open with the input intact and show the error there. Do not close the sheet and make the user rediscover which record failed to delete. An undo could be assessed later, but confirmation plus correct failure handling is the required minimum.

## 3. Booking-side costs: recommended product shape

### 3.1 One monetary source of truth

The live schema intentionally declares `expenses` as the first and only monetary source of truth; a booking cost is an expense row with `booking_id`, and bookings must not gain a `price` column ([migration 031](../../../backend/src/db/migrations/031_expenses.sql)). The service validates that a linked booking belongs to the same trip and already supports changing that link from the Expenses editor ([expenses service](../../../backend/src/services/expenses.js)).

This supports the desired user experience without two-way synchronization:

```text
Booking form/card ── creates or edits ──┐
                                         ▼
                               canonical expense record
                                         ▲
Expenses diary ───── creates or edits ──┘
```

Both surfaces read and edit the same record. An expense update appears in Logistics because Logistics reads a booking’s linked-expense projection; a booking-context update appears in Expenses because it is the same row. There is no booking price to reconcile or double-count.

### 3.2 Preserve the many-expense relationship

Do not force one expense per booking. A flight can have a fare, later baggage, seat selection, an upgrade, or a change fee; a hotel can have a deposit and balance. The current nullable foreign key allows multiple expense rows to reference one booking and deliberately uses `ON DELETE SET NULL` ([migration 031](../../../backend/src/db/migrations/031_expenses.sql)).

The design implication is that a booking card must not become a mini ledger:

| Linked state | Card-level signal | Detail surface |
| --- | --- | --- |
| No linked expense | `Add cost` | Start a prelinked expense from the booking. |
| One linked expense | `Cost · ¥42,000` | Open the canonical expense editor. |
| Several linked expenses | `3 costs logged` | Show original-currency lines and `Add another cost`. |

Do not place payer details, repayment state, individual expense rows, or a converted/net aggregate directly on the card face. A single roll-up becomes misleading when costs span currencies, have unresolved FX estimates, or include reimbursement-eligible amounts. The detail sheet can show the lines; Expenses remains the ledger and totals surface.

### 3.3 Contextual entry behaviour

Booking create/edit can offer an optional `Booking cost` disclosure. Filling it creates the first prelinked expense with sensible defaults:

- title seeded from the booking title;
- category inferred from the booking type where appropriate;
- linked booking fixed in the booking-context sheet;
- date editable as the purchase date, not silently inferred as the travel date;
- current collaborator as default payer;
- existing currency, FX, and repayment controls retained as needed.

The booking detail sheet is the better home for `Add another cost` and management of several linked records. The Expenses sheet retains the existing booking picker for later, free-form costs.

Do not automatically rewrite a historical expense title or date when a booking changes. The booking label can be displayed contextually, but an expense is its own financial record.

## 4. Deleting a Logistics booking with linked costs

The current booking deletion path removes the booking. SQLite then retains linked expenses but nulls their booking association ([booking service](../../../backend/src/services/bookings.js); [migration 031](../../../backend/src/db/migrations/031_expenses.sql)). This is data-safe but creates a double job if the user expects the costs to disappear too.

When a booking has linked expenses, the delete flow should become a review step:

```text
Delete “Singapore Airlines SQ…”?
3 costs are linked to this booking. Select any costs to delete too.

[ ] Fare · S$620
[ ] Seat selection · S$35
[ ] Checked baggage · S$80
    Select all

Unchecked costs stay in Expenses without a booking link.

[Cancel] [Delete booking and 2 selected costs]
```

Key rules:

- All expense checkboxes start unchecked. Financial history must not be silently preselected for deletion.
- `Select all` keeps the common “remove this entire cancelled plan” path quick.
- An expense the user keeps should retain enough text context to be intelligible without the deleted booking. Expenses created from booking context should already use the booking title; assess an explicit “Formerly linked to …” note only if real kept records would otherwise be ambiguous.
- Deleting the booking and selected expenses must be one server-side transaction, not client-side sequential deletes.
- This is about deleting a Trippy card, not cancelling with a supplier. Refund and cancellation-fee accounting remain outside this lightweight tracker.

For a cancellation fee, the minimal supported workflow is valid: delete refunded original costs, then add a manual expense titled `Cancellation fee — [booking title]`. It is appropriately unlinked because the booking no longer exists. Do not introduce refunds, negative transactions, or cancellation-status accounting through this deletion dialog.

## 5. Stop-side entry is deliberately deferred

Adding an expense from a stop is plausible but not part of the next scope. A stop represents an itinerary intention rather than proof of a purchase. A persistent stop/expense relationship would raise questions about optional activities, ticket quantities, booking timing, refund state, card density, and whether a stop’s expected cost is an estimate or an actual transaction.

Do not add a `stop_id` relationship or Plan-card finance affordance in the next plan. Revisit only if the booking and manual-capture flow demonstrate a concrete missed-capture problem that a contextual shortcut would solve.

## 6. Architecture implications and implementation-plan gates

The proposed work is feasible, but it is not a presentation-only change. A later plan should first answer these questions and demonstrate the stated invariants.

| Area | Required decision or proof |
| --- | --- |
| Booking API shape | How a booking list/detail receives a bounded linked-expense state/count without N+1 expense requests. |
| Atomicity | A composite create/update path for a booking with its first cost; either both records persist or neither does. |
| Multiple costs | Whether the booking detail lists every linked expense, and how it handles mixed original currencies and unestimated FX without misleading totals. |
| Delete review | Checked-cost semantics, zero/one/many-cost copy, transactionality, and failure behaviour that leaves the dialog open. |
| Expense deletion | Named confirmation that includes linked repayment consequences; no close on failed deletion; mobile proof against accidental taps. |
| Data preservation | Booking deletion leaves unchecked costs unlinked; selected costs delete; retained titles/notes remain meaningful. |
| Access | Existing trip-access checks apply to both booking and expense in every composite operation. |
| Refresh | Editing through either context updates the diary, summary, booking-card indicator, and open-repayment presentation without stale local state. |
| Mobile | 375px proof for long person names, several repayment rows, the last settle action, and co-pilot coexistence. |
| Total clarity | A foreign-currency unestimated entry visibly states that it is excluded from the headline until a rate is available; never silently drop or imply a completed total. |
| Route exit | Wallet-open origin, explicit close control, active-wallet toggle behaviour, deep-link fallback, and Escape semantics are specified and match analogous Trip routes. |
| Regression | Public share remains expense-free; booking-to-stop synchronization remains intact; FX remains non-blocking and transparent. |

## 7. Recommended planning order

1. **Immediate Expenses refinement:** source-resolved `To collect`, diary repayment mirrors, settled-row behaviour, and FAB/action collision.
2. **Booking read model and card/detail disclosure:** linked-cost state visible in Logistics without ledger noise.
3. **Booking-context create/edit:** first cost and later ancillary cost paths against the canonical expense record.
4. **Booking deletion review:** selective linked-expense handling, transaction, and mobile failure states.
5. **Only then assess stop-side capture again**, with evidence rather than presumed convenience.

## 8. Explicit exclusions for the next implementation plan

- Stop-side expense capture or a persistent stop/expense relationship.
- A booking price column or duplicated monetary field.
- Automatic supplier-cancellation, refund, negative-expense, or cancellation-fee accounting.
- Generic finance dashboard filters, budgets, settlement reminders, payment initiation, or external-friend accounts.
- Public sharing of expenses, booking costs, repayments, or financial metadata.
- A fifth bottom-navigation tab.

## 9. Post-review owner decisions (2026-07-21)

An independent follow-up assessment (2026-07-21) verified every factual claim above against the live code and surfaced five product decisions the owner has now resolved. These are binding on the implementation plan.

| # | Question | Decision |
| --- | --- | --- |
| a | Diary repayment mirror for non-payer viewers | **Render the mirror line only when the viewer is the payer.** Rationale is presentation altitude, not privacy — all collaborators can open any expense and see every owed row; only the "X owes you" phrasing is worth diary-level space. |
| b | Settled-row behaviour in the repayments section | **Keep settled rows inline with strikethrough and a toggle-back**, exactly as shipped. §2.1's "settled rows disappear" is rejected: the checklist mental model plus mis-tap recovery wins. Revisit clutter with a collapsed "Settled (n)" group only if a real trip demonstrates the problem. |
| c | Open-repayment consequences in the booking-delete review | **Yes, per-line.** Each checked cost with open owed rows shows a one-line consequence under its checkbox (e.g. `includes Sarah's ¥50 open repayment`), and the confirm button aggregates. Bottom-only warnings are rejected as overlookable. |
| d | Scoping of booking cost indicators versus summary totals | **Rows are shared, totals are personal.** The booking card badge and detail-sheet cost lines count all linked expenses regardless of payer (trip-wide); the Expenses summary stays scoped to the viewer's own outlay (shipped D1). Each cost line in the booking detail shows the payer initial so the asymmetry is self-explaining. |
| e | Owed-name identity (free-text `expense_owed.name`) | **Both fixes.** Entry-time suggestion chips in the owed rows (existing owed names on this trip plus collaborator display names) prevent variants at the source; grouping and chip dedupe use a normalized key (lowercase, internal whitespace stripped) so `Chee Loon` / `Cheeloon` / `CheeLoon` / `cheeloon` group as one person. Display uses the first-entered form. |

Additional owner UI feedback (2026-07-21): the expense-row booking link glyph (11px `Link2` icon after the date) is too small to notice and reads as punctuation. Replace it with a legible booking reference in the row's mono metadata line as part of the booking-disclosure wave, since both surfaces of the expense-booking relationship should be redesigned together.

Implementation is planned in `../plans/Implementation Plan 20 Expenses Refinement and Booking Costs.md`.

## Suggested follow-up review prompt

```text
Read docs/superpowers/reviews/2026-07-20-expenses-experience-and-booking-costs-review.md.

This is review-only. Do not change code, migrations, docs, or production state.

Independently assess the proposed next Expenses scope against the current Trippy codebase: source-resolved repayments, the global co-pilot/FAB collision, booking-context entry and display for multiple linked costs, and selective linked-cost handling when deleting a booking card. Treat the document as a hypothesis, not a prescription.

Return: (1) any product or semantic flaw in the proposed UX; (2) the smallest technically safe architecture; (3) required API/data invariants and test cases; (4) mobile and failure states that could invalidate the design; and (5) a clear recommendation on whether this is ready for a bounded implementation plan. Do not write the implementation plan.
```
