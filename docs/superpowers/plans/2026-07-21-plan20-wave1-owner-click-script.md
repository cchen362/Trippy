# Plan 20 Wave 1 — Owner Production Click-Script

Run this against production (https://trippy.zyroi.com) after the Wave 1 deploy (commit
`a2e93f0`). Use a trip you don't mind adding a few test expenses to — the changes are
frontend-only, no backend/schema change, so anything you add is normal expense data
(delete it after if you'd rather not keep it). Do the flows roughly in order since #2–#4
build on state from #1.

## 1. To-collect grouping and payer-only mirror line
1. Open a trip's Expenses tab (wallet icon in the top bar). If prompted for a summary
   currency, pick one — this is normal first-time setup, unrelated to this deploy.
2. Add two expenses you paid for, each with an owed row: e.g. "Taxi" ¥60 owed by "Sam",
   and "Dinner" ¥120 owed by "sam" (lowercase, extra spacing if you like).
3. Confirm the section is titled **"To collect"** (not "Open repayments") and sits
   directly under the summary, above "Recent entries."
4. Confirm both owed rows collapse under **one** "Sam" group (case/whitespace-insensitive
   grouping) with a header like `Sam · ¥180.00 outstanding`.
5. Tap "Mark settled" on one row — it should strike through and stay in the list (not
   disappear). Tap again to unsettle.
6. On the diary row for "Taxi," confirm a small gold line reads "Sam owes you ¥60.00"
   underneath the date.

**Pass:** heading renamed and repositioned; grouping merges near-duplicate names;
settled rows stay inline with strikethrough; gold mirror line appears on rows you paid.

## 2. Mirror line is payer-only (needs a second collaborator)
1. If the trip has another collaborator, edit one of the expenses above and change "Paid
   by" to them, then save.
2. Confirm the gold mirror line disappears from that diary row (since you're no longer
   the payer) even though the owed row still exists.
3. Change "Paid by" back to yourself and save.

**Pass:** mirror line only ever shows on rows you paid for, never otherwise. Skip this
flow if you don't have a second collaborator handy.

## 3. Delete confirmation
1. Open any expense you're fine losing (or the test one from #1) and tap **Delete**.
2. Confirm the button that was "Delete" disappears, and a **different** red "Delete
   expense" button appears on the opposite side of the footer, with a sentence above it
   like `Delete "Taxi"? This removes the ¥60.00 expense and Sam's ¥60.00 repayment
   record.`
3. Tap **Cancel** — confirm it reverts to the normal Cancel/Save footer without deleting
   anything.
4. Reopen Delete, this time tap **Delete expense** for real.

**Pass:** the destructive button is never in the same spot as the original "Delete" tap
(so a fast double-tap can't hit both); the consequence sentence is accurate; Cancel
truly cancels; the real delete removes the row and closes the sheet.

## 4. Owed-name suggestion chips
1. Add a new expense, expand "More," and tap into the "Someone owes me" name field.
2. Confirm a handful of chips appear below the input (names from past owed rows and/or
   your collaborators, never your own name).
3. Type a couple of letters — the chip list should filter to matching names, then
   disappear once you've typed a full exact match.
4. Tap a chip — it should fill the name field instantly.

**Pass:** chips are relevant, exclude you, filter as you type, and tapping one fills the
field without requiring a second tap.

## 5. Bottom clearance and route toggle
1. Scroll to the very bottom of a long expenses list — confirm the last row's buttons
   are fully visible and tappable above the floating co-pilot button, not obscured by it.
2. From any other tab (Plan/Logistics/Map), tap the wallet icon to open Expenses —
   confirm the icon turns **gold** while you're on the Expenses screen.
3. Tap the (now gold) wallet icon again — confirm it takes you back to the tab you came
   from, not the trip list.

**Pass:** nothing is hidden behind the co-pilot button; the wallet icon visibly toggles
and returns you to where you started.

---

Report back anything that doesn't match "Pass" above — a screenshot plus what you tapped
helps a lot. Once all five pass, I'll mark Wave 1 CLOSED in the plan doc.
