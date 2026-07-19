# Implementation Plan 19 — Trip Expenses: Shared Spending Diary with Owed Amounts

**Status: OPEN — W1 (backend) + W2 (frontend) complete 2026-07-20; W3 (integration QA) pending.** W1: migration 031, currency utils, fx.js, expenses service/routes, trips summaryCurrency — 646/646 backend tests, migration proven on a real-DB copy. W2: expensesApi + useExpenses, wallet header icon (leftmost of 4), Expenses view, ModalShell capture sheet, summary-currency prompt — 178/178 frontend tests, clean build. Orchestrator smoke pass 2026-07-20 at 375px: create-expense end-to-end, CNY day-geo currency default, totals + D5e unestimated note + D5 footer render; FX service verified against live CDN for a past date (today's snapshot not yet published → correctly unestimated, never guessed).
**Date:** 2026-07-19
**Baseline:** Product-fit review `docs/superpowers/reviews/2026-07-19-expenses-tracker-product-fit-review.md` (all six gates answered; independent assessment returned GO). Modal system from Plan 17 (CLOSED, deployed 43f83d7) is the sheet primitive.
**Scope:** One additive migration, one backend route/service pair + FX service, one frontend Expenses view + capture sheet + header entry point. No co-pilot integration, no offline writes, no changes to public sharing beyond a regression test proving exclusion.

---

## 0. Verified facts (do not re-derive; checked 2026-07-19)

- **Bookings have no price column.** `backend/src/db/migrations/003_bookings.sql` — normalized columns + `details_json` only. The `expenses` table is therefore the *first and only* monetary source of truth; a booking cost is an expense row with `booking_id` set. Never add a price column to `bookings`.
- **Next migration number is 031** (030 = `copilot_turn_metrics`).
- **Public share is structurally safe.** `backend/src/services/share.js` builds responses field-by-field and uses bookings only for geography derivation. Expenses never join any share query; guard with a regression test, not new filtering logic.
- **Header entry point:** `TopBar.jsx` exposes a generic `actions` slot. TripPage currently renders Share (`Users`), Edit (`Edit2`), and — **owner only** — `AdminSettingsPanel` (which brings its own trigger button). The wallet icon makes it 4 icons for the owner, 3 for other users. The trip title already truncates on 375px (`truncate` on the `h1`); owner accepts further truncation. Place the wallet icon **first** (leftmost of the actions group) — it is the most-used in-trip action of the four.
- **Day-country derivation exists** in `backend/src/services/trips.js` (shared `deriveDayGeo`) with mirrored frontend helpers — the source for the currency default. `backend/src/utils/countries.js` has country-name/code mapping but **no country→currency map**; a small static `currencyForCountry(code)` util must be added (additive, same file or sibling).
- **FX provider verified live 2026-07-19:** fawazahmed0 exchange-api. Primary `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{YYYY-MM-DD}/v1/currencies/{code}.json`, fallback host `https://{YYYY-MM-DD}.currency-api.pages.dev/v1/currencies/{code}.json`. Keyless, no rate limits, daily snapshots, historical by date in URL. Confirmed coverage: TWD, VND, SGD, JPY, KRW, CNY (200+ currencies). Frankfurter (ECB, ~30 currencies, no TWD/VND) is the documented plan-B provider only.
- **ModalShell** (Plan 17) is the sheet primitive; edits to ModalShell itself require orchestrator review (standing rule). Plan 18 (modal sweep) is OPEN — this plan must not touch Plan 18's surfaces.

## 1. Owner-approved product decisions (2026-07-19 — LOCKED, do not re-litigate)

| # | Decision | Resolution |
|---|---|---|
| D1 | Primary number | **Spent-primary.** Headline = everything paid (incl. fronted purchases). Secondary lines: "Awaiting repayment: X" and "Your share (est.): Y". No headline number ever silently excludes cash outflow. |
| D2 | Capture modes | Both first-class: mid-trip fast capture (amount → category → save, ~3 taps, everything defaulted) AND post-trip batch entry (same sheet, date field one-tap visible — not buried in an "advanced" section). No offline writes; offline save fails loudly. |
| D3 | Currency default | Pre-filled from the selected day's derived country via a `currencyForCountry` map; shown as an inline chip next to the amount, one tap to change. Falls back to trip summary currency when no day context. |
| D4 | Edit rights | Any collaborator edits/deletes any expense (matches existing trip-edit semantics). No payer-scoped permissions. |
| D5 | FX provider | fawazahmed0 exchange-api, single provider, jsDelivr primary + pages.dev fallback host. Rules: (a) save NEVER blocks on FX — stamp `estimate + rate + rate_date` asynchronously; (b) one rate per (pair, date) cached in SQLite; (c) historical rate = purchase date; (d) optional manual rate override per expense (covers outages + card-rate purists); (e) missing estimate renders "estimate unavailable" and the entry is excluded from the converted total **with a visible note** ("+ ¥12,400 unestimated"), never guessed or dropped silently. Footer wording: "Estimates use daily mid-market reference rates, not your card's exchange rate." Converted amounts carry an "est." suffix. |
| D6 | Repayment model | One payer per expense (defaults to signed-in collaborator). Zero or more owed amounts: `{name, amount, open|settled}`. Names are plain labels — not users, invitees, or notification targets. Exact amounts only; sum of owed ≤ expense amount. Binary open/settled, no timestamps, no partials. **No equal-split shortcut** (first step onto the Splitwise slope — explicitly cut). |
| D7 | Entry point & lifetime | Wallet header icon (leftmost of actions), dedicated Expenses view. No fifth bottom-nav tab. Feature stays fully usable after trip end (post-trip settlement is a core scenario). Summary currency chosen once per trip, changeable in trip edit; past entries are never re-rated (stamped rates are permanent unless manually overridden). |

**Out of scope for this release (from the review — enforce):** budgets/limits, receipt scanning, bank/card sync, payment initiation/reminders/notifications, external-friend accounts, partial repayments/ledger, public-share visibility, fifth nav tab, equal-split shortcut, auto-extracted booking prices from the capture flow, any offline-write behavior, co-pilot expense tools.

## 2. Data shape (target for W1; refine names in implementation, not semantics)

- `expenses`: id, trip_id (FK, CASCADE), booking_id (nullable FK, SET NULL on booking delete — the expense record survives), payer_user_id (FK users), title/note (nullable), category (fixed set: lodging, transport, food, activity, shopping, other), amount (integer minor units), currency (ISO 4217), expense_date, summary_amount (nullable, minor units), summary_currency, fx_rate (nullable REAL), fx_rate_date (nullable), fx_source ('provider' | 'manual' | NULL), created_at/updated_at.
- `expense_owed`: id, expense_id (FK, CASCADE), name TEXT, amount (minor units, same currency as parent expense), settled INTEGER 0/1. CHECK/service-enforced: SUM(owed) ≤ expense amount.
- `fx_rates`: base_currency, quote_currency, rate_date, rate, fetched_at — UNIQUE(base, quote, rate_date).
- `trips` gains `summary_currency` (nullable TEXT; prompt on first Expenses open if unset).
- **Store money as integer minor units** (cents/yen), never REAL — JPY/KRW/VND have 0 decimal places; carry a per-currency minor-unit map alongside `currencyForCountry`.

## 3. Wave plan

Max two coding subagents in flight; W1 and W2 are file-disjoint (backend vs frontend) and MAY run in parallel **only after** the orchestrator freezes the API contract (routes, JSON field names, totals payload shape) in writing at wave start. W3 is sequential after both.

### W1 — Backend foundation
**Model: Sonnet** — schema + CRUD + a small HTTP-fetch service over locked decisions; well-trodden pattern work with no open product judgment.

1. Migration `031_expenses.sql` (+ `.js` only if backfill logic is needed — expected pure SQL): tables per §2, indexes on `expenses(trip_id, expense_date)` and `expense_owed(expense_id)`.
2. `currencyForCountry(code)` + `minorUnitsFor(currency)` in `backend/src/utils/` (static maps; cover at minimum all countries currently derivable in owner trips plus TWD/VND).
3. `backend/src/services/fx.js`: `getRate(base, quote, date)` — cache-first from `fx_rates`, then jsDelivr, then pages.dev fallback; store on success; return null on total failure. Respect the never-block rule: called only from the async stamping path, with a bounded timeout.
4. `backend/src/services/expenses.js`: CRUD in transactions (expense + owed rows atomic), owed-sum validation, async FX stamping after create/update (and a lazy re-stamp attempt on read for rows with null estimate), totals computation (spent / awaiting repayment / net share / unestimated-by-currency), settled toggle, manual-rate override path (recomputes summary_amount, sets fx_source='manual').
5. `backend/src/routes/expenses.js` under `/api/trips/:tripId/expenses`, behind `requireAuth` + `requireTripAccess`; expense-belongs-to-trip ownership check on item routes (follow the existing day/stop/booking helper pattern).
6. Trip edit accepts `summary_currency`.
7. Tests: CRUD + access (non-collaborator 403), owed-sum rejection, totals math incl. mixed currencies and unestimated rows, fx cache hit/miss with mocked fetch, **share-exclusion regression test** (share payload for a trip with expenses contains no expense/amount fields), migration applies on a disposable DB copy.

### W2 — Frontend expenses experience
**Model: Sonnet** — composition over existing primitives (ModalShell, TopBar actions, services/hooks conventions) against a frozen API contract and a fixed design language; no novel interaction model.

1. `frontend/src/services/expenses.js` (HTTP client) + `hooks/useExpenses.js` (list, totals, mutations, optimistic settled-toggle).
2. Wallet icon (lucide `Wallet`, size 18, same 40px circular button styling) leftmost in TripPage's `actions` group. Verify at 375px with the owner's 4-icon case (wallet + Users + Edit2 + AdminSettingsPanel); title truncation accepted, but the ← Trips link and all four 40px targets must remain tappable.
3. Expenses view — route under `/trips/:tripId/expenses` inside the TripPage outlet (keeps TopBar/BottomNav shell; BottomNav shows no active tab there): summary block (Spent headline in DM Mono w/ gold accent on the single primary figure; secondary lines per D1; unestimated note per D5e; rate-wording footer), recent-entries list (category, amount w/ "est." conversion, payer initial, booking-link glyph when linked), open-repayments list grouped by payer ("Sarah owes you S$80") with settled toggle, prominent add action.
4. Add/edit sheet on ModalShell: amount + currency chip (day-derived default per D3, tap opens a short common-currencies picker + search) + category row → Save enabled immediately; visible-but-defaulted date row (D2); collapsed "More" section: payer, note, booking link (picker over existing bookings), manual rate, "someone owes me" named-amount rows with client-side sum validation. Offline/failed save: loud ErrorBanner-style inline error, entry preserved in the form.
5. First-open summary-currency prompt when trip has none (small ModalShell sheet, one select, sensible default SGD).
6. Empty state in product voice (no filler copy); reduced-motion respected; all amounts DM Mono; gold used once per component.
7. Frontend tests for totals rendering, owed-sum validation, currency-chip default; `npm run build` clean.

### W3 — Integration QA, live FX verification, polish
**Model: orchestrator (Fable) QAs and directs; Sonnet for fix-up commits** — this wave is judgment and verification (real browser at 375px, live provider behavior, design-floor calls), which is orchestrator work; code changes are small corrections.

1. Live FX check against the real CDN from dev backend: historical date fetch, fallback host path (simulate primary failure), TWD/VND coverage, cache row written once per pair-date.
2. Browser pass at 375px and desktop (dev servers via launch.json, minted-session login per established QA method): full capture flow in ≤4 taps, post-trip dated entry, currency chip change, owed flow incl. settle after trip end date, booking-linked expense from the sheet, header layout with all four owner icons, keyboard-open reachability of Save.
3. Failure drills: FX unreachable (entry saves, shows unestimated, totals note correct), offline save (loud failure, no silent queue), owed sum > amount rejected in UI and API.
4. Share regression re-check against a running server (public link for an expense-bearing trip).
5. Owner click-script for production QA post-deploy (per standing practice); update this plan's status line; commit.

## 4. Verification expectations

- `cd backend; npm test` and `cd frontend; npm test` + `npm run build` green per wave.
- Migration 031 proven on a disposable copy of a real DB before merge.
- No wave is "done" from tests alone: W3's browser pass is the completion gate (standing rule — paid external provider + behavior involved).
- Deployment via `/deploy` only after owner reviews W3 evidence; owner runs the production click-script.

## 5. Out of scope / guardrails

- Do not touch Plan 18 surfaces (TripShareModal, AdminSettingsPanel, UserAccountButton, DocumentViewer, ErrorBanner recolor) beyond mounting order in TripPage's actions row.
- No ModalShell modifications expected; if one proves necessary, stop and get orchestrator review first.
- No co-pilot awareness of expenses (no tools, no serialization into trip context) in this plan.
- No price extraction in the capture/import flow.
- No new frontend dependencies; lucide + framer + ModalShell cover the UI.
