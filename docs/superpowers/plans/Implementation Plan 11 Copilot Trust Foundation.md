# Implementation Plan 11 — Co-pilot Trust Foundation (Action Protocol, Server Proposals, Atomic Apply)

**Status: Wave 1 COMPLETE (2026-07-12). Waves 2–4 NOT STARTED.**

**Origin:** [Co-pilot Foundation and Integration Review](../reviews/2026-07-11-copilot-foundation-and-integration-review.md)
(2026-07-11) plus the independent orchestrator assessment and owner decision session of
2026-07-12. All product decisions below are owner-approved; implementation sessions must
not re-open them.

**Goal:** make the co-pilot's mutation path trustworthy *at its current four-operation
scope* before any capability expansion: a typed tool-use action protocol replaces fenced
JSON, proposals become persisted server-side objects with audit state, application is
atomic and staleness-protected, booking-linked stops are protected, and the prompt stops
pressuring the model to fabricate times. No new co-pilot capabilities, no UI redesign
(the bottom sheet is Stage 3 / a later plan), no Discovery grounding (Stage 2 / a later
plan).

**Staging context (owner-approved sequencing):**

- **Stage 1 — this plan:** trust foundation.
- **Stage 2 — future plan:** grounding (Discovery-catalogue search tool, deterministic
  trip-health checks).
- **Stage 3 — future plan:** integration (bottom sheet presentation, contextual entry
  points, context-aware seed prompts).

---

## 0. Verified facts this plan is built on (traced 2026-07-12)

Confirmed in current `main`; implementation sessions must not re-derive them.

1. **Fenced-JSON is the action protocol.** `streamCopilotResponse`
   (`backend/src/services/claude.js:384-482`) instructs the model to append a fenced
   JSON block, regex-extracts the *last* such block, and emits whatever parses as an
   SSE `mutation` event. No schema validation of action names or fields anywhere.
2. **`/apply` trusts the client.** `POST /trips/:tripId/copilot/apply`
   (`backend/src/routes/copilot.js:122-179`) accepts an arbitrary client-authored
   `mutation` body — it is never matched against anything the model proposed. The
   pending proposal exists only in browser state (`useCopilot.js` `pendingMutation`)
   and is lost on refresh.
3. **Cross-trip identifiers are accepted.** `assertDayAccess` / `assertStopAccess`
   (`backend/src/services/trips.js:703-740`) verify the *user* can access the record
   but never compare the record's `trip_id` against the `:tripId` in the URL.
4. **Unknown actions silently no-op.** The validation loop only branches on the four
   known actions; execution filters exclude everything else (`copilot.js:136-171`).
5. **Application is non-atomic.** remove/move run inside a transaction; add/update run
   concurrently *afterwards* (`copilot.js:149-172`). A mixed proposal can half-apply
   with no indication of which half.
6. **Two inconsistent move semantics.** `move_stop` runs raw SQL
   (`UPDATE stops SET day_id = ?, sort_order = ?`, `copilot.js:157`), bypassing the
   `updateStop` service; its `sortOrder ?? 0` collides with `reorderStops`' 1-based
   ordering (`stops.js:601-622` — display order is `sort_order ASC, created_at ASC`),
   so a moved stop can silently land first. Meanwhile `update_stop` passes `op.fields`
   verbatim into `updateStop` (`copilot.js:171`), which accepts *any* service field
   including `dayId` (a disguised move that DOES run the full service path),
   `unsplashPhotoUrl`, and `photoQuery`.
7. **History endpoint returns the oldest 50 messages** (`ORDER BY created_at ASC
   LIMIT 50`, `copilot.js:32-37`) while the model context correctly takes the newest
   20 (`copilot.js:89-96`). Conversations past 50 messages show a frozen prefix.
8. **Booking-linked stops have zero protection anywhere.** `stops.booking_id` exists
   (migration 004), but `deleteStop` deletes unconditionally (`stops.js:594-599`) and
   no route checks `booking_id`. Not just a co-pilot gap — noted for a future product
   decision on the regular stops routes; this plan only closes the co-pilot path.
9. **The prompt fabricates times.** The system prompt's `add_stop` example shows
   `time: "HH:MM"` (`claude.js:410`) even though `stops.time` is nullable and
   `createStop` stores `input.time || null` without format validation. The product's
   own `frontend/src/utils/todayModel.js:94-98` already encodes the
   anchors-vs-untimed contract (timed bookings/stops are anchors; untimed activities
   are never clock-judged) — the timing semantics this plan makes explicit are
   derived from existing product behavior, not invented.
10. **Context payload:** the full `getTripDetail` JSON sits in the system prompt with
    `cache_control: { type: 'ephemeral' }` (`claude.js:430`) — cached across turns
    while the trip is unchanged. Booking serialization includes `confirmationRef` and
    resolved document metadata (`trips.js:86,98` via `resolveBookingDocuments`).
11. **`createStop`/`updateStop` are async** because they await the location resolver
    and the Unsplash photo pipeline — they cannot sit inside a better-sqlite3
    synchronous transaction as currently shaped. Atomic apply requires splitting
    external resolution from DB writes.
12. **Attribution is a join away.** `copilot_messages.user_id` is stored for user
    messages (NULL for assistant, migration `005_ai.sql`); `users.display_name`
    exists (migration `001_auth.sql`). `trips.owner_id` supports owner-only clear.
13. **Co-pilot model is `claude-sonnet-4-6`** via `@anthropic-ai/sdk` streaming; the
    SDK version in use supports typed `tools` with streaming (`tool_use` content
    blocks arrive as `input_json_delta` events).
14. **Coordinate distrust already works** — keep it: `enrichCopilotStop`
    (`copilot.js:17-26`) tags model coordinates `coordinateSource: 'copilot'` and the
    resolver verifies or discards them. The photo pipeline runs for co-pilot stops.
15. **Test baseline:** `npm test -- copilot.test.js claude.test.js` → 2 files,
    37 tests, all passing (2026-07-12).
16. **Next migration number is 028** (latest is `027_stop_photo_source.sql`).

---

## 1. Design decisions (owner-approved 2026-07-12 — encode, don't re-open)

- **D1 — v1 product role** is explain-the-trip, improve-a-day, add-from-Discovery-
  catalogue. This plan builds the foundation those jobs need; the catalogue tool
  itself is Stage 2.
- **D2 — Native tool use replaces fenced JSON.** The model gets one tool,
  `propose_itinerary_changes`, with a strict input schema covering the four
  operations. Prose keeps streaming over SSE exactly as today; when the tool block
  completes, the server validates + persists the proposal and emits a `proposal` SSE
  event carrying the proposal id and its validated payload. The regex extraction and
  the fenced-JSON prompt instructions are **deleted**. (The extraction and
  photo-descriptor paths keep their fenced-JSON conventions — single-shot and already
  validated; out of scope.)
- **D3 — Proposals are server-side records.** A `copilot_proposals` row is created
  the moment a valid tool call arrives, with a trip-state fingerprint. `/apply` takes
  a proposal id (never raw operations), transitions status
  `pending → applied | rejected | stale | invalid`, and the record is the audit
  trail. Proposals survive refresh and are re-openable from history.
- **D4 — Atomic apply.** All external resolution (geocoding, photos) happens *before*
  the transaction; all DB writes for a proposal commit in **one** transaction or none.
- **D5 — No undo in v1.** Preview + explicit confirm + audit record is the safety
  net. The one real loss case is mitigated instead: the server computes **loss
  warnings** into the proposal (removal/update targets a stop with user notes or a
  user-pinned photo `photo_source = 'user'` — unrecoverable by re-adding) and the UI
  must show them.
- **D6 — Booking-linked stops are off-limits to the co-pilot.** Any operation whose
  target stop has a non-null `booking_id` makes the whole proposal invalid; the
  refusal reason is surfaced to the user (and stated in the system prompt so the
  model avoids proposing it). Bookings are managed in Logistics.
- **D7 — Explicit timing semantics, derived not stored.** The prompt defines four
  meanings — booking-linked timed commitment / explicitly timed manual stop / untimed
  flexible stop / soft duration-or-bestTime hint — and mandates `time: null` unless
  the user's request is specifically about timing. No new user-facing
  fixed/preferred/optional vocabulary (rejected for v1). Server-side, `add_stop.time`
  and `update_stop.fields.time` must match `HH:MM` or be null.
- **D8 — History stays trip-shared**, gains attribution (display who wrote each user
  message), and clearing the conversation becomes **owner-only**.
- **D9 — Context minimization:** the co-pilot gets a purpose-built serialization
  derived from `getTripDetail` that **keeps** `confirmationRef` and drops booking
  document metadata and `details_json` noise. Trip data stays in the system prompt
  (cache economics favor it); no query layer for trip data.
- **D10 — UI scope for this plan:** the existing full-screen panel remains. The
  bottom sheet (partial-height, drag-to-expand full screen on mobile, distinct
  pointer-native expand control on desktop, no auto-expand on long replies) is
  Stage 3 and needs a design pass against the design spec §8 at 375px first.
- **D11 — Proposals are one coherent unit.** No selective per-operation apply
  (cross-operation dependencies make partial application hazardous).
- **D12 — Unknown or malformed anything fails loudly.** Unknown action names,
  schema-violating fields, cross-trip records, and stale fingerprints all produce an
  explicit, user-visible error — never a silent no-op.

---

## Wave 1 — Typed action protocol and prompt contract (backend)

**Status: COMPLETE (2026-07-12).** Native tool use replaces fenced JSON; prompt rewritten
(D6 booking-linked rule + D7 timing semantics); D9 minimized context serializer added;
history endpoint fixed to newest-50. New module `backend/src/services/copilotTools.js`
(`PROPOSE_ITINERARY_CHANGES_TOOL` + `copilotTripContext`). Full suite green (484 tests, 26
files); new `copilotTools.test.js` + rewritten `claude.test.js` tool-protocol suite.
**Live-verified** against the real Anthropic API (throwaway smoke, SDK unmocked): change
request → prose + `proposal` event with `time: null` (no fabrication, D7); pure question →
no proposal; "move my booked flight to 9am" → no proposal, prose redirects to Logistics
(D6). Measurement (Wave 1.6): tiny-trip context ≈676 chars, TTFD ≈1–2s, tool use does not
delay prose streaming.

**Deviations / intermediate state:** the `proposal` SSE event carries `{ operations }` only
— `proposalId` + `warnings` require persistence (Wave 2). `POST /apply` still on the raw
`{ mutation }` path and the frontend still listens for the old `mutation` event
(`useCopilot.js:40`), so the browser apply flow is **intentionally unwired until Wave 3**;
the co-pilot chats/reasons but the apply preview will not light up between waves. This is the
plan's owner-approved backend-first sequencing, not a regression.

Replace the fenced-JSON convention with native tool use and rewrite the system prompt.

1. Define `propose_itinerary_changes` as a typed tool (name, description, strict
   `input_schema`): `operations` array where each item is exactly one of
   - `add_stop { dayId, stop: { title, type, time (HH:MM|null), note?, lat?, lng? } }`
   - `remove_stop { stopId }`
   - `move_stop { stopId, toDayId, position }` — `position` is an ordinal intent
     (e.g. index within the target day), translated server-side into consistent
     `sort_order` values via the `reorderStops` semantics; the raw-SQL path is deleted.
   - `update_stop { stopId, fields }` — `fields` restricted to an explicit allowlist
     (`title, type, time, note, duration, estimatedCost, bestTime`); photo fields,
     `dayId`, and anything else are rejected (moves go through `move_stop` only).
2. Wire `tools` into the streaming call. Text deltas stream to SSE as today. When the
   `tool_use` block completes, hand the parsed input to the Wave 2 validation +
   persistence path and emit a `proposal` SSE event (`{ proposalId, operations,
   warnings }`). No tool_result round-trip — the tool is a terminal proposal, not a
   query.
3. Rewrite the system prompt: remove the fenced-JSON instructions and the
   `time: "HH:MM"` example; add the D7 timing-semantics definitions and the D6
   booking-linked rule ("never propose changes to stops marked booking-linked; tell
   the user to manage them in Logistics"); instruct that flexible answers are framed
   as density/order/flexibility, never fabricated timetables (review §1).
4. Build the D9 minimized context serializer (`copilotTripContext(tripDetail)`), and
   mark booking-linked stops in the serialization so the model can honor D6.
5. Fix the history endpoint to return the **newest** 50 messages in chronological
   order (fact 7).
6. **Measurement task (informs Stage 2/3, not a gate):** log per-turn input/output
   tokens and time-to-first-delta before and after; confirm tool-use streaming does
   not visibly delay prose streaming; record real trip context token size.

Acceptance: model proposals arrive only via the tool; a turn with no changes produces
no proposal event; prose streaming latency unchanged within noise; tests updated to
the tool protocol; history returns newest 50.

## Wave 2 — Persisted proposals and atomic apply (backend)

**Status: NOT STARTED.**

1. Migration `028_copilot_proposals.sql`: `copilot_proposals` (`id`, `trip_id` FK,
   `message_id` FK to the assistant `copilot_messages` row, `created_by_user_id`,
   `operations_json`, `warnings_json`, `trip_fingerprint`, `status`
   (`pending|applied|rejected|stale|invalid`), `status_reason`, `created_at`,
   `resolved_at`, `resolved_by_user_id`).
2. Validation module (used at proposal creation AND re-checked at apply):
   - schema conformance (mirrors the tool schema; unknown actions/fields → invalid);
   - every referenced day/stop belongs to `:tripId` (closes fact 3) and is
     accessible to the user;
   - `booking_id` guard (D6);
   - `time` format (D7);
   - whole-proposal semantics: all-or-nothing — any invalid operation invalidates
     the proposal with a stated reason (D12).
3. Trip fingerprint: deterministic hash over the trip's structural state (ordered
   day ids + per-day ordered stop ids + each stop's `time` + `booking_id`). Computed
   at proposal creation; recomputed at apply; mismatch → status `stale`, HTTP 409
   with a clear message (UI invites the user to re-ask).
4. Loss warnings (D5): computed at proposal creation for `remove_stop`/`update_stop`
   targets with non-empty `note` or `photo_source = 'user'`; stored in
   `warnings_json` and included in the `proposal` SSE event.
5. Rework `/apply` to take `{ proposalId }`: load proposal (must be `pending`,
   belong to `:tripId`), re-validate, re-fingerprint, then execute atomically:
   - **resolve phase (outside transaction):** for `add_stop` and photo-relevant
     `update_stop` fields, run location/photo resolution to produce ready-to-insert
     row data — requires factoring `createStop`/`updateStop` into
     `resolveStopData()` (async, external calls) + `writeStop()` (sync, DB only)
     without changing their behavior for existing callers;
   - **write phase (one transaction):** all inserts/updates/deletes/moves plus the
     proposal status transition to `applied` commit together or not at all.
6. Reject endpoint (`POST .../proposals/:id/reject`) records `rejected`; expose
   pending/most-recent proposals in the history response so the UI can restore them.
7. Owner-only conversation clear (D8): `DELETE .../copilot/history` requires
   `trips.owner_id === userId`.

Acceptance: a proposal with one bad operation applies nothing and reports why; a
concurrent trip edit between proposal and apply yields 409/stale; applied/rejected
states persist and survive refresh; move ordering lands where intended (no
`sort_order` 0-vs-1 collision); direct POSTs of raw operations are rejected; new
tests cover cross-trip rejection, unknown-action rejection, booking-linked refusal,
atomic rollback (simulated mid-proposal failure), staleness, and time-format
validation.

## Wave 3 — Proposal experience in the panel (frontend)

**Status: NOT STARTED.**

Within the existing full-screen panel and design language (no new chrome, gold stays
accent-only):

1. Drive `MutationPreview` from the server proposal object (id + validated
   operations + warnings). Pending proposals restore after refresh and reopen from
   history; Apply sends `proposalId`; applied/rejected/stale states render on the
   message thread.
2. Preview comprehension (review Direction E, minimum useful set):
   - `update_stop`: field-level before → after values;
   - `add_stop` with `time: null`: an explicit "no time — flexible" label (DM Mono
     badge idiom), never a fabricated slot;
   - loss warnings rendered prominently before Apply ("This stop has your notes —
     they'll be deleted");
   - stale (409) response invites re-asking rather than failing silently.
3. Attribution (D8): show the author's `display_name` on user messages (data from
   the history endpoint join); hide the Clear action for non-owners and handle the
   403.
4. Error surfacing per D12: invalid/stale proposal reasons appear as readable panel
   copy in the product voice, not raw errors.

Acceptance: verified in a real browser at 375px — propose → refresh page → proposal
still pending → apply → stop appears in the plan with correct order and null time;
warning shown when removing a stop with notes; second browser edits the trip between
propose and apply → stale message.

## Wave 4 — QA, verification, deploy

**Status: NOT STARTED.**

1. Full backend test run + the new protocol/validation suites green.
2. Agent browser verification locally (owner session flow per
   `trippy-local-photo-verification` conventions where applicable); exercise all
   Wave 3 acceptance flows plus a long conversation (>50 messages) to confirm the
   history fix.
3. Owner click-script for the production pass (per standing owner preference —
   agent does not run prod browser loops).
4. `/deploy` per the deploy skill; post-deploy: confirm proposals table exists,
   propose/apply one change on a test trip in production, verify audit row.
5. Update this plan's status lines; wrap-up commit.

---

## Open items deliberately NOT in this plan

- Discovery-catalogue search tool + empty-catalogue policy (generation cost decision) — Stage 2.
- Deterministic trip-health checks — Stage 2.
- Bottom sheet + contextual entry points + design mockups (mobile drag / desktop pointer treatments) — Stage 3.
- Booking-linked stop protection on the *regular* stops routes — separate product decision.
- Undo/restore — revisit only if post-v1 usage shows confirm+warnings is insufficient.
- Live/proactive data (weather, flight status, location) — explicitly deferred (review Direction G).
