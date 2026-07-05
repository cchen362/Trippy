# Implementation Plan 5 — Q2 Geography Investigation + Q1 Draft-Correction Fix

**Status:** BOTH WORKSTREAMS COMPLETE (2026-07-06). Workstream B — draft-mode type correction shipped, tests green (frontend 28, backend 197), 375px selector states verified. Workstream A — Q2 review completed (10-section review, findings Q2-04/05/06 added to parent register, Gate A recommendation appended); awaiting owner sign-off on Gate A before any implementation plan.
**Decision record:** [Product and Architecture Risk Review — Owner decisions 2026-07-06](../reviews/2026-07-06-product-architecture-risk-review.md#owner-decisions-and-orchestrator-verified-findings-2026-07-06)

Two independent workstreams. They share no files and can run in separate sessions in either
order or in parallel. Workstream B is a bounded implementation task; Workstream A is an
investigation that must NOT change code.

Out of scope by owner decision (do not let sessions drift into these): persisted booking-type
conversion, Q3 discovery personalization, co-pilot feature work, backup cron (ops task blocked
on Tailscale).

---

## Workstream A — Q2 geography investigation (Gate A)

**Session type:** investigation only. Read code, write the review document. Zero source changes.
**Model guidance:** run the analysis on Opus or Sonnet subagents; Fable orchestrates and QAs.
**Deliverable:** complete `docs/superpowers/reviews/2026-07-06-q2-trip-geography-and-map-architecture.md`
per the 10-section agent contract in the parent review, and append a Gate A recommendation to
the parent review for owner sign-off.

### Session handoff prompt (paste into a new session)

```
Complete the Q2 geography investigation for Trippy (this repo). This is an
INVESTIGATION session: no source-code changes, no schema changes, no fixes.
The deliverable is documentation.

Read first, in order:
1. docs/superpowers/reviews/2026-07-06-product-architecture-risk-review.md
   (parent — includes the agent review contract, the mixed-country nuance you
   must preserve, and the owner decisions of 2026-07-06)
2. docs/superpowers/reviews/2026-07-06-q2-trip-geography-and-map-architecture.md
   (the brief you are completing)
3. docs/superpowers/plans/Implementation Plan 5 Q2 Investigation and Q1 Draft
   Fix.md (this plan — verified facts below are pre-established; do not
   re-derive them, cite them)

Facts already verified by the orchestrator (build on these):
- trips.destinations and trips.destination_countries are independent JSON
  arrays (backend/src/db/migrations/002_trips.sql) — no positional pairing.
- Map config is trip-wide: any CN → AMap/GCJ-02 whole-trip, else any KR →
  Naver deep links, else Google/MapTiler (backend/src/services/mapConfig.js:21-61).
- A day-level city derivation already exists: deriveDayCity in
  backend/src/services/trips.js:147 resolves override → active hotel →
  same-day transit arrival → previous day → seeded day.city. It produces a
  city STRING only (no country) and the map layer ignores it entirely.

What remains for you to establish (the brief lists full detail):
- Trace every consumer of trip/day geography: geocoding country bias
  (placeResolver.js), coordinate conversion and its outside-China guard
  (coordinates.js, stops.js), frontend map rendering (TripMap, MapTab),
  deep-link construction, discovery destination selection, AI import context,
  share views, and PWA-cached map config. Answer the brief's "which source is
  authoritative for..." table with evidence.
- Run the brief's mixed-country scenarios (MY→SG→CN→MY, CN→KR, KR→CN, wrong
  CN inference, missing country) as code-trace analyses. Preserve the parent
  doc's nuance: verify actual coordinate behavior — the WGS-84→GCJ-02
  conversion has an outside-China guard, so do NOT claim non-China pins are
  offset without tracing it. Provider selection being wrong is a separate,
  already-confirmed failure.
- Work through the brief's Q2-03 edit-semantics scenarios (add/remove/reorder
  destination, date changes, booking-implied city, override removal).
- Evaluate the three options in the brief. Orchestrator's provisional view to
  pressure-test (agree or refute with evidence): Option A upgraded — make
  deriveDayCity's output a structured {city, countryCode} pair, keep the
  existing 5-layer precedence, derive trip destination summary from days, and
  select map/deep-link provider from day/place country (Option C for links).
  Option B (dated segments) replaces a working mechanism and needs stronger
  justification.
- Owner constraint (decision 3 in the parent doc): mixed-country trips are
  not near-term, but the MODEL must be clean — day-level city/country
  identity with provider selection derivable from it. No dominant-country
  shortcut in the data model. Phasing the UI is acceptable; debt is not.
- Migration analysis for existing trips (unpaired arrays, null countries,
  seeded days), share-link and PWA-cache compatibility, and the test matrix
  (China, Korea, mixed, missing-country fixtures).

Deliverable:
1. Rewrite the Q2 review doc into a COMPLETED review with the 10 sections
   required by the parent doc's agent review contract (current behavior with
   evidence, scenarios, severity, authoritative-data recommendation, options,
   recommendation + rejected alternatives, dependencies, migration risks,
   verification strategy, open owner questions).
2. Append a short "Gate A recommendation" section to the parent review doc
   summarizing the proposed canonical model in under a page, flagging any
   decision that needs the owner.
Do not write an implementation plan — that happens after owner sign-off.
```

### Exit criteria

- Q2 review doc status changes from "Investigation brief" to "Completed review".
- Gate A recommendation appended to the parent doc.
- Open questions for the owner are explicit and few.

---

## Workstream B — Q1 draft-correction fix (extraction review type change)

**Session type:** implementation. Bounded frontend fix + tests.
**Model guidance:** one Sonnet subagent under Fable orchestration is sufficient.
**Root cause (verified):** `AddBookingModal.jsx:316` derives `isEditing = Boolean(booking)` and
disables the booking-type selector (`disabled={isEditing}`, line ~536). `CaptureFlow.jsx:244`
passes the AI-extracted draft through that same `booking` prop, so the extraction-review step
inherits a lock that was designed for persisted bookings. A misclassified extraction cannot be
corrected before confirmation — the user's only options are accepting the wrong type or
excluding the item and re-entering it manually.

### Design

Distinguish the two modes explicitly instead of overloading the `booking` prop:

- Add a `mode` prop to `AddBookingModal`: `"create" | "edit" | "draft"` (default derived from
  current props for backward compatibility: `booking ? 'edit' : 'create'`). `CaptureFlow`
  passes `mode="draft"`.
- Type selector is enabled in `create` and `draft` modes, disabled only in `edit` (persisted)
  mode. Keep the persisted lock — that is owner-intended behavior.
- On type change within draft mode, reuse the existing `handleTypeChange` reset path, but
  carry over the type-agnostic fields the extraction already filled: `confirmationRef`,
  `bookingSource`, start/end datetimes, origin/destination text, and timezone fields where the
  target type has an equivalent slot (see `hydrateFormFromBooking`, AddBookingModal.jsx:238-303,
  for the per-type field map — the retention matrix falls out of it). Type-specific fields with
  no equivalent are cleared, never silently retained in `detailsJson`.
- Submission continues through the existing `handleDraftSubmit` → `normalizeForm` path so one
  canonical payload shape reaches confirmation. Verify `normalizeForm` output for a
  type-changed draft carries no stale keys from the previous type.

### Trust criteria (inherited from the Trust brief, scoped to this fix)

- A type-changed draft that is confirmed must produce exactly one booking of the new type —
  verify the confirm path does not also submit any remnant of the old draft shape.
- No change to persisted-edit behavior: regression-test that a saved booking still cannot
  change type.

### Verification

- Frontend: `npx vitest run` green (20-passing baseline) plus new tests for draft-mode type
  change (hotel↔other, train↔bus at minimum) asserting field retention/clearing.
- Backend: `npm test` green (186+ baseline) — should be untouched; run it to prove that.
- 375px preview pass on the capture flow: extract → review → open draft → change type →
  confirm; confirm the corrected type renders in Logistics.
- CLAUDE.md rules apply: no bandaids, no TODO/FIXME, fixed palette/typography, mobile-first.

### Session handoff prompt (paste into a new session)

```
Implement Workstream B of docs/superpowers/plans/Implementation Plan 5 Q2
Investigation and Q1 Draft Fix.md (this repo). Read that plan section fully
first — it contains the verified root cause, the design (mode prop on
AddBookingModal, draft-mode type change with field retention), trust criteria,
and the verification checklist. Also skim
docs/superpowers/reviews/2026-07-06-q1-booking-classification-and-correction.md
for context on what is deliberately OUT of scope (persisted conversion).
Delegate coding to a Sonnet subagent; orchestrate and QA per CLAUDE.md.
Update this plan's status line and commit when verified.
```

### Exit criteria

- Type change works during extraction review, persisted lock unchanged, tests green,
  375px preview verified, committed.

---

## Status

| Workstream | Status |
|---|---|
| A — Q2 investigation | **complete (2026-07-06)** — review doc rewritten per 10-section contract; recommendation: Option A upgraded (day-level `{city, countryCode}` via existing 5-layer precedence) + Option C for deep links; Option B rejected; 5 owner questions in Gate A section of parent doc |
| B — Q1 draft fix | **complete (2026-07-06)** — `mode` prop on `AddBookingModal`, `draftFormForType` retention via `normalizeForm`→`hydrateFormFromBooking`, pure logic extracted to `bookingForm.js`; 7 new tests; persisted-edit lock verified unchanged |
