# Plan 11 Wave 4 — Owner Production Click-Script

Run this against production (https://trippy — or whatever host you use to reach
100.94.82.35:6768) after the Wave 4 deploy. Use a real trip you don't mind editing, or
the dedicated QA trip if one exists in prod. Each numbered flow is independent; do them
in order since #4 and #5 build on state from #1–#3.

## 1. Propose → refresh → still-pending → apply
1. Open a trip, tap the co-pilot FAB.
2. Ask for something concrete and low-risk, e.g. "Add a casual coffee stop on day 1."
3. Wait for the prose reply and the proposal card (should show `Add:` with the stop
   title, target day, and a `NO TIME · FLEXIBLE` badge — never a fabricated time).
4. **Refresh the page.** Reopen the co-pilot panel. The same proposal card must still
   show as pending (not lost, not auto-applied).
5. Tap **Apply**. Card should flip to `Applied`. Close the co-pilot and confirm the new
   stop appears on the Plan tab in the right day, in a sane position.

**Pass:** proposal survives refresh; Apply works; stop appears correctly.

## 2. Loss warning
1. Pick an existing stop that has a note written on it (or add one first via the normal
   stop editor).
2. Ask the co-pilot to remove that stop, or update its title.
3. The proposal card must show a prominent warning above Apply — something like "this
   stop has your notes — they'll be deleted" — **before** you tap Apply.
4. If you're comfortable losing the note, Apply; otherwise stop here.

**Pass:** warning is visible and specific, not a generic error, and appears before Apply
is tappable.

## 3. Booking-linked refusal
1. Ask the co-pilot to change something about a booking-linked stop (a hotel or flight
   entry that shows the confirmation-ref styling) — e.g. "move my hotel booking to a
   different day."
2. The reply should be prose-only: it explains the stop is booking-linked and points you
   to Logistics. **No proposal card should appear at all.**

**Pass:** no proposal card; prose redirects to Logistics.

## 4. Stale proposal (edit a DIFFERENT stop than the one targeted)
1. Ask the co-pilot to change one specific stop (e.g. "update the title of the noodle
   lunch stop to 'Noodle Dinner'"). Wait for the proposal card — **do not apply it yet.**
2. In a second tab (or after backgrounding the co-pilot panel), go to the Plan tab and
   directly edit or reorder a **different** stop on the same trip using the normal UI
   (not the co-pilot) — e.g. drag-reorder two stops, or edit a different stop's time.
3. Go back to the pending proposal from step 1 and tap **Apply**.
4. Expect a "can't apply — this no longer matches your trip, ask again" message (plain
   language, not a raw error string or stack trace).

**Pass:** stale message is readable and product-voiced; the trip's actual state (from
step 2) isn't clobbered by the stale apply attempt.

## 5. Long conversation (optional spot-check)
If you have a trip with a long co-pilot history (50+ messages), open its co-pilot panel
and confirm the messages shown are the **most recent** ones, not an old frozen batch
from early in the conversation. (This was verified programmatically in dev during Wave
4 QA — this is just a production spot-check if you happen to have a long thread handy.)

---

Report back anything that doesn't match "Pass" above — screenshot + what you asked the
co-pilot helps a lot.
