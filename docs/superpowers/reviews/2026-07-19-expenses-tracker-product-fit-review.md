# Expenses Tracker — Product-Fit and Feasibility Review

**Status:** OPEN — discovery and independent-assessment input only. This is not an implementation plan and does not authorize source, migration, configuration, or deployment changes.

**Review date:** 2026-07-19

**Question:** Is a lightweight expenses tracker an appropriate feature for Trippy, and, if so, what is the smallest coherent product boundary worth planning?

## Executive framing

The candidate is not a general personal-finance product, budget planner, or Splitwise clone. It is a **shared trip-spending diary** that also records purchases a traveller has fronted for named people outside the trip.

The product case is plausible because Trippy already brings together logistics, day-to-day travel, and collaboration. The strongest ordinary job is “what did this trip cost us?” The differentiating job is “I bought items for several friends while travelling; who owes me what?” The latter must remain bounded, or it will pull Trippy into a broad payments and group-settlement product.

The feature should proceed to an implementation plan only if an independent review confirms that it can remain fast to capture, private, and clearly trip-scoped. The central risk is not the database shape; it is whether the primary total and repayment semantics are intelligible enough to earn a permanent entry point in a deliberately compact mobile trip shell.

## 1. Scenarios that define the problem

| Scenario | Example | Required outcome |
| --- | --- | --- |
| Booking cost | A hotel, flight, train, or transfer has a final price. | Include it in trip costs; permit entry while creating/editing the booking or later from Expenses. |
| Fast in-trip capture | A cab, meal, activity, or shop purchase happens while travelling. | Record it in a few taps, with amount and category first; date and currency need sensible defaults. |
| Shared couple spending | One partner pays for a hotel; the other pays for meals. | Show one combined trip cost while preserving who paid each purchase. |
| Purchase on behalf | One traveller buys souvenirs for Sarah and Jamie, who will repay later. | Preserve the one purchase and exact amounts owed by each named person. |
| Separate partner purchases | Each partner buys items for different friends. | Make clear who each friend owes; a generic “owed” list is insufficient. |
| Post-trip settlement | Friends pay after the traveller returns and hands over the items. | Keep the record after trip end and allow an owed amount to be marked settled. |
| Multi-country trip | JPY, KRW, and USD purchases need one summary in SGD. | Preserve original currency and show a clearly labelled estimate in one summary currency. |
| Public itinerary sharing | An itinerary is shared by public link. | Never expose expense, booking-price, repayment, or collaborator financial data. |

## 2. Candidate product model

This is a discovery hypothesis, not an approved schema or UI specification.

1. A trip has one shared expense record set, visible to authenticated owner/collaborators.
2. Each purchase records one **payer**, defaulting to the signed-in collaborator adding it.
3. A purchase can record zero or more **owed amounts** for named people. They are labels in the trip record, not Trippy users, invitees, or notification recipients.
4. Each owed amount is either **open** or **settled**. Partial repayments, payment methods, reminders, and payment-history accounting are excluded.
5. A booking price is an expense linked to that booking, whether entered from Logistics or Expenses. There must be one monetary source of truth, not parallel booking-price and expense systems that can double-count.

This resolves the partner case without requiring couples accounting. One shared trip can contain a hotel paid by a partner, an item paid by the user for Sarah and Jamie, and an item paid by the partner for Chris. The owed amount inherits its purchase's payer, so the interface can say “Sarah owes you” and “Chris owes partner” without ambiguity.

### Totals need deliberate names

The discussion supports three distinct values. Collapsing them into one “Total spent” number would be misleading.

| Value | Meaning | Example: S$600 hotel + S$100 purchase (S$80 owed by friends) + S$70 purchase (S$70 owed by a friend) |
| --- | --- | --- |
| **Trip cost** | The couple's own share, excluding purchases made on behalf of others. | S$620 |
| **Paid upfront** | Money the couple initially paid, including purchases friends will repay. | S$770 |
| **Awaiting repayment** | Open owed amounts, grouped by payer. | S$150 |

“Trip cost” is the candidate primary number because it answers the stated main job. It is a net estimate of what belongs to the couple, not a bank-statement balance. The independent reviewer should challenge this terminology and calculation before it is fixed; if users read it as literal cash outflow, it will create mistrust.

## 3. Candidate experience — intentionally restrained

Trippy's four bottom-navigation slots are stable: Trips/Today, Plan, Logistics, and Map ([BottomNav](../../../frontend/src/components/nav/BottomNav.jsx)). Expenses should not become a fifth mobile tab. The candidate entry point is a wallet icon in the authenticated trip header, where Share and Edit already live ([TripPage](../../../frontend/src/pages/TripPage.jsx), [TopBar](../../../frontend/src/components/nav/TopBar.jsx)).

The candidate is a trip-level Expenses view, not a floating calculator or global finance area. Its first screen should answer the three values above, show recent entries and open repayments, and provide an obvious add action.

Fast manual capture should begin with:

> Amount → category → save

Details appear only when needed: original currency, date, booking link, payer, note, and “someone owes me” with named owed amounts. For meals and transport, an equal-split shortcut is plausible; for purchases on behalf, exact manual amounts are required. Owed amounts must never exceed the purchase amount.

This is a UX direction to evaluate, not a mandate. In particular, the independent review should test whether currency is too important to hide in a multi-country trip.

## 4. Currency and trust boundary

One **summary currency** should be selected per trip. Each expense retains the original amount/currency, the summary-currency estimate, and the reference rate/date used for the estimate.

A daily reference-rate provider such as [Frankfurter](https://frankfurter.dev/) is viable for an estimate because it is keyless and exposes historical rates. It must not be presented as the final card-statement exchange rate. The estimate should be captured with the expense, using a historical rate for the purchase date where possible, rather than continually recalculating old purchases at today's rate. Provider choice, caching/failure behavior, currency coverage, and whether this accuracy level earns user trust remain feasibility questions.

## 5. Existing Trippy fit and constraints to inspect

The following facts support investigation; they do not approve the feature.

- Logistics already provides a natural source for flight, hotel, train, bus, ferry, and other booking costs ([LogisticsTab](../../../frontend/src/pages/LogisticsTab.jsx) and `frontend/src/components/logistics/`).
- Authenticated collaborators have private trip access, while public share links return a deliberately reduced itinerary ([collaboration service](../../../backend/src/services/collaboration.js), [sharing service](../../../backend/src/services/share.js)). Expenses must follow the private collaborator boundary and be absent from public-share responses.
- The PWA's cached reads are a resilience layer, not a separate offline-write architecture. The review must assess whether a network-dependent fast-capture flow is acceptable; this feature must not casually create an offline-sync subsystem.
- The mobile header already contains compact actions and a co-pilot entry competes for screen space. Any header icon needs 375px usability and reachability validation.

## 6. Current boundary from product discovery

**In scope to assess**

- Logistics costs, manual in-trip spending, and shopping purchases.
- One shared record for a couple/collaborating trip.
- A payer for every expense and multiple named owed amounts on one purchase.
- Original transaction currency plus an approximate summary-currency value.
- Open/settled repayment state after a trip ends.
- Entry from Logistics or Expenses with one underlying monetary record.

**Explicitly out of scope for a first release**

- Budgets, spending limits, or financial planning.
- Receipt scanning.
- Bank/card sync, statement reconciliation, or card foreign-exchange fees.
- Payment initiation, reminders, notifications, or external-friend accounts.
- Partial repayments, instalments, or a payment ledger.
- Public-share visibility.
- A fifth bottom-navigation tab.

## 7. What the independent assessment must answer

1. Is this a coherent extension of a private trip planner, or does it dilute Trippy's core job enough that it should be declined or deferred?
2. Which scenario has enough frequency and value to justify the feature: trip-cost recall, booking-cost consolidation, purchases on behalf, or a narrower subset?
3. Is a combined “Trip cost” that excludes reimbursement-eligible amounts understandable and trustworthy? If not, what is the smallest clearer presentation?
4. Does payer plus named owed amounts cover the couple/friends cases without silently becoming a group-settlement product?
5. Is a header icon and dedicated view the best mobile placement, given the existing header, co-pilot control, and four-tab model? Identify a better placement if evidence supports one.
6. Can capture remain genuinely low-friction while retaining enough data for multi-currency and reimbursement behaviour?
7. Is the reference-rate estimate acceptable for product trust? What failure and stale-data behaviour is needed before it can be shown?
8. What access-control, public-share, deletion/edit, and collaboration risks must be resolved before planning?
9. Does post-trip settlement justify keeping the feature available after the trip ends, and can binary open/settled status remain enough?
10. What is the smallest release that proves value without creating a finance subsystem or an offline-sync project?

## 8. Gates before an implementation plan

Do not write a detailed plan until the reviewer can state a defensible answer to these gates:

1. **Product:** a clear primary user job and a reason this belongs in Trippy rather than another tool.
2. **Semantics:** unambiguous definitions for trip cost, paid upfront, repayments, payer, and named recipients.
3. **Scope:** a small release whose exclusions prevent finance-product creep.
4. **Trust:** private collaborator-only access, public-share exclusion, correct ownership enforcement, and clear currency-estimate wording.
5. **Usability:** a phone-first capture flow that remains useful during a real trip.
6. **Technical:** one booking/expense source of truth, a viable migration/access shape, and no accidental commitment to offline writes or a fragile FX dependency.

## Suggested Fable 5 handoff prompt

```text
Read docs/superpowers/reviews/2026-07-19-expenses-tracker-product-fit-review.md.

Independently assess whether a trip Expenses feature is appropriate for Trippy before any implementation plan is written. This is review-only: do not change code, migrations, docs, or production state.

Treat the review's candidate shape and exclusions as context, not a prescribed answer. Verify the live architecture where relevant and challenge the product fit, user value, mobile UX, shared-trip/reimbursement semantics, privacy, currency-estimate trust, and scope risk. Ask if critical facts are missing rather than assuming them.

Return: (1) a clear go / defer / decline recommendation with reasoning; (2) what is sound, unclear, or risky; (3) the smallest defensible product boundary if it should proceed; (4) the decisions or evidence still needed before a detailed implementation plan; and (5) only then, a high-level feasibility outline. Do not write the implementation plan itself.
```
