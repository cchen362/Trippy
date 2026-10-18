# Implementation Plan 32 — Remove a Stopped Exchange

**Status:** 2026-10-19 — **APPROVED by the owner (R1–R3 below). M1 COMPLETE (backend; migration 037 applied in dev only). M2 pending. Nothing deployed.** Written at `a44d867` as the follow-up the owner deferred when approving D-30-8 (Plan 30, commit `ab4e293`). M1 (backend) then M2 (frontend), each implemented via `/implement-milestone`, each updating its own status line and committing. Migration 037 ships with the next production deploy, after 036.

## Bottom line, in plain language

You ask the co-pilot the wrong thing (for example, "move Day 3 to Osaka" when you meant Day 4), press **Stop**, and then ask the right question. Under D-30-8 the half-finished reply stays in the thread as "This reply was stopped." The model is told to treat your next message as a new request. But the wrong question is still in what the co-pilot reads for the next 50 messages, and it can still colour later answers ("as you wanted Osaka on Day 3…"). The only way to take it out today is **Clear conversation**, which wipes everything and only the owner can use (Plan 11 D8).

This plan adds one quiet control. Under a stopped reply there is a link, **Remove**. One confirm, and the question and its partial reply leave the screen, the database and the co-pilot's memory of the conversation. Nothing else changes.

**Severity: low–medium.** It does not happen often, but when it does, the stray question is read on every later turn until it scrolls out of the 50-message window.

## Owner rulings — 2026-10-18 (do not reopen)

- **R1 — Who may remove:** the person who asked the question, or the trip owner. A collaborator can never remove someone else's question. Plan 11 D8, which makes Clear conversation owner-only, is unchanged; it governs the whole-thread clear, not this control.
- **R2 — Which exchanges:** only a **stopped** exchange (its reply carries `notice = 'stopped'`), and any such exchange inside the visible 50-message window, not just the latest one. A finished exchange is never removable. This keeps the control a way to take back a mistake, not a history editor, and it means a removed reply can never carry a proposal card (F-32-3).
- **R3 — Exact pairing:** add `copilot_messages.reply_to` (migration 037, additive, nullable). Each reply records which question it answers, so removal never relies on message order.

Cross-checked against meet-edweird Plan 042 "Remove a message" (shipped 2026-10-14). Adopted from it: the pair is the unit, removed means gone (not hidden), no Undo, a stale-page refusal in plain words, the button label **Keep** on the safe choice, a 36 px minimum touch target, and a check of the live data before a pairing rule ships. Trippy deliberately differs in four places: only stopped exchanges can be removed, the author-or-owner rule (Edward has one user), the control sits on the "stopped" line rather than as a bin on every bubble, and the server id arrives on the stream (F-32-5). The full comparison is in the session's findings note; the parts that bind are folded in below.

## Verified facts — established 2026-10-18 at `a44d867`, do not re-derive

- **F-32-1 — The model's context is rebuilt from `copilot_messages` on every turn.** `backend/src/routes/copilot.js` loads the latest `COPILOT_MESSAGE_WINDOW = 50` rows for the trip and maps them to model messages. A stopped assistant row gets `NOTICE_CONTEXT_LINES.stopped` appended (`assistantContextContent`). `GET /history` uses the same window (Plan 15 D4). So deleting the two rows is enough to take them out of both the screen and the model's view. No other code reads the transcript text: `copilot_turn_metrics` stores no message text, and the hosted MCP path never touches co-pilot history.
- **F-32-2 — A reply is tied to its question only by order today.** `copilot_messages` has no link column. `persistTurn` already holds `userMessage.id`, and its insert runs `… WHERE EXISTS (SELECT 1 FROM copilot_messages WHERE id = ?)`. So an assistant row is **never written once its question row is gone** (D-30-8). Removing the question therefore also blocks a stopped reply that has not yet been saved.
- **F-32-3 — A stopped reply never carries a proposal.** Both stopped paths in `backend/src/services/claude.js` call `persistEndedTurn({ operations: null, notice: 'stopped' })`: `recordClientAbort`, and the late-abort branch after `finalMessage()`. In the sliver where Stop lands after a proposal event, `useCopilot` saves the turn as a *normal* row (the "Stop arrived too late" branch), so it is not removable under R2. Dev DB check, 2026-10-18: 2 stopped rows, 0 proposals linked to any row that has a notice.
- **F-32-4 — `copilot_proposals.message_id` is `ON DELETE SET NULL`** (migration 028). Clear conversation already leaves orphan proposals: 6 in dev with `message_id IS NULL`. `/history` still returns them, and the panel never shows them because it groups proposals by `messageId`. **This plan does not fix that.** It is noted only so the server guard in M1 is understood.
- **F-32-5 — The panel does not know server ids for a turn sent live.** `useCopilot.send` gives the question and the stopped reply `crypto.randomUUID()` ids. The server never sends its ids back, and after Stop the socket is dead. Rows carry real ids only after a reload. There is also a race: the server saves the stopped row a moment *after* the client shows it. The `turn` SSE event (D-32-2) closes the gap: the question row is saved before `streamCopilotResponse` calls `flushHeaders()`, so its id is known while the stream is still open.
- **F-32-6 — Unknown SSE events are ignored on both sides.** `frontend/src/services/api.js` parses every `data:` line, and `useCopilot`'s chunk handler falls through on an unknown `type`. A new `turn` event is therefore backwards-compatible with a cached old client.
- **F-32-7 — Who's who on the client.** `CopilotPanel` gets `ownerId` from `TripPage` and `user` from `useAuth()`. `/history` rows expose `authorName`, not the author's user id. The author check (R1) needs `userId` added to user rows on `/history`. The server re-checks it either way.
- **F-32-8 — There is no shared confirm component in the frontend.** The only confirm is `window.confirm` on Clear conversation (`CopilotPanel.jsx`). The stopped notice line is DM Mono 11 px with a literal `rgba(240,234,216,0.45)` that matches no token (`--cream-dim` is 0.66, `--cream-mute` is 0.34).

## Decisions — stamp each marker in its code home when its milestone lands

- **D-32-1 — The unit is the exchange, and only a stopped one.** It is the question row plus the one assistant row whose `reply_to` is that question (for legacy rows, see D-32-4). Both are removed in one transaction. The server refuses when the reply exists and its `notice` is not `'stopped'` (409), and when a proposal references the reply (409, a guard that F-32-3 says never fires). A question with no reply yet is removable, and F-32-2 guarantees its stopped reply will never land. *Home: the remove service function.*
- **D-32-2 — The server names the question on the stream.** The first SSE event of every co-pilot turn is `{ type: 'turn', messageId }`, the saved question's id. The route supplies it and `claude.js` writes it right after `flushHeaders()`, which keeps `claude.js` DB-free. *Home: `streamCopilotResponse` / the route.*
- **D-32-3 — Who may remove: the question's author or the trip owner (R1).** Any other user gets 403. Plan 11 D8 stands. *Home: the remove route.*
- **D-32-4 — Pairing.** `reply_to` is set by `persistTurn` for every new assistant row. For a row saved before 037 (`reply_to IS NULL`), the reply is the next assistant row after the question in `(created_at, rowid)` order, and only if no other user row comes between them. Otherwise the server refuses the remove (409) rather than guess. M1 first runs the read-only legacy check (M1 step 1) on the dev DB, and the owner runs it on prod at deploy, to show every existing stopped row passes that rule. *Home: the remove service function.*
- **D-32-5 — The control.** A quiet DM Mono text link, `Remove`, is appended to the "This reply was stopped." line, using the token `--cream-mute` (no gold, no icon, no new chrome). Tapping it swaps the line in place for "Remove question and reply? · Remove · Keep". Nothing opens a modal or uses `window.confirm`, and the sheet height never changes (Plan 13 P2). Touch targets are at least 36 px tall on a coarse pointer. It shows only to the question's author or the owner, never while a reply is streaming, and on an exchange sent live only after the `turn` id has arrived. Removal is optimistic: the rows leave at once. A failure restores them and shows the server's sentence inline under the notice. *Home: `CopilotPanel.jsx`.*
- **D-32-6 — No Undo, nothing else touched.** `copilot_turn_metrics` is kept (it holds no text) and so are any proposals. Removal is permanent, and the confirm sentence says so in its "Remove" wording. *Home: the remove service function.*

## Milestones

### M1 — The removal (backend)

**M1 status:** 2026-10-19 — **COMPLETE, not deployed** (branch `plan32-m1-remove-exchange`). Migration **037** (`copilot_messages.reply_to`) is applied in dev only. Production stays at 036 until Plan 30 Deploy B.
- **Legacy check (step 1), dev:** run before any code, on a `.backup()` copy of `backend/data/trippy.db`. It found 44 messages and **4 stopped rows: 4 pass, 0 fail**. No owner stop was needed.
- **Built:**
  - `removeStoppedExchange` in `backend/src/services/copilotMessages.js` (D-32-1, D-32-4 and D-32-6 markers).
  - `DELETE /trips/:tripId/copilot/exchanges/:messageId` (D-32-3).
  - `persistTurn` writes `reply_to`.
  - `streamCopilotResponse` takes a new `turnInfo` argument, placed before `profile`; the eval harness passes `null`. It writes `{type:'turn', messageId}` right after `flushHeaders()` (D-32-2).
  - `/history` rows carry `userId`.
- **Two corrections to the plan text below:**
  - (a) "Already removed" returns **404**, not 409. Once a question is removed, the server cannot tell its id from an unknown one. The 404 uses the same sentence: "This conversation changed — reload and try again."
  - (b) The D-32-4 legacy fallback pairs a question only with an assistant row whose `reply_to IS NULL`. Without that filter, a new question still waiting for its reply could be paired with another person's later reply, and its removal would be refused wrongly.
- **Tests:** backend 1,099 passed, 6 skipped (45 files). New cases: 14 route/service cases in `copilot.test.js` and 2 `turn`-event cases in `claude.test.js`. The golden request-body hashes are unchanged.
- **Live check (orchestrator):** on the dev server, verify trip `05b3c18d…`, real Sonnet 5.5. Three questions were asked and cut off with curl. Each stream's first event was `turn`, and each stopped row carried the right `reply_to`. Remove results:
  - the collaborator removing the owner's exchange → 403;
  - an assistant-row id → 404;
  - the owner removing the collaborator's exchange → 200 `{removed:2}`;
  - the collaborator removing their own → 200;
  - the owner removing their own → 200, then the same request again → 404;
  - a finished exchange → 409.

  Afterwards no QA rows were left. The next turn logged `stream opened messages=34` (33 rows plus the new question), and the model recalled the question from before the QA turns, not the removed ones.
- **Production legacy check, for the owner at Deploy B.** Run it on the server against the pre-deploy backup, before 037 is applied. Save the SQL below as `plan32-legacy-check.sql`, then run `sqlite3 ~/Trippy/backups/<pre-deploy-backup>.db < plan32-legacy-check.sql` (the host `sqlite3` CLI; the container has none). Every row must read `ok`; any `FAIL` row means stop and report before deploying. No rows at all means production has no stopped replies yet, which also passes. The SQL only reads, and it works on the pre-037 schema.

```sql
-- Plan 32 D-32-4 legacy-pairing check (read-only). Every stopped reply must pair with the
-- nearest earlier question in its trip, with no other reply between them.
WITH stopped AS (
  SELECT a.rowid AS a_seq, a.id AS a_id, a.trip_id, a.created_at AS a_at
  FROM copilot_messages a
  WHERE a.role = 'assistant' AND a.notice = 'stopped'
),
paired AS (
  SELECT s.*,
    (SELECT u.rowid FROM copilot_messages u
      WHERE u.trip_id = s.trip_id AND u.role = 'user'
        AND (u.created_at < s.a_at OR (u.created_at = s.a_at AND u.rowid < s.a_seq))
      ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1) AS u_seq
  FROM stopped s
)
SELECT p.a_id AS stopped_reply_id, p.trip_id, p.a_at AS stopped_at,
  CASE
    WHEN p.u_seq IS NULL THEN 'FAIL: no earlier question'
    WHEN EXISTS (
      SELECT 1 FROM copilot_messages x JOIN copilot_messages u ON u.rowid = p.u_seq
      WHERE x.trip_id = p.trip_id AND x.role = 'assistant' AND x.rowid <> p.a_seq
        AND (x.created_at > u.created_at OR (x.created_at = u.created_at AND x.rowid > u.rowid))
        AND (x.created_at < p.a_at OR (x.created_at = p.a_at AND x.rowid < p.a_seq))
    ) THEN 'FAIL: another reply in between'
    ELSE 'ok'
  END AS verdict
FROM paired p
ORDER BY p.a_at;
```

1. **Legacy check (read-only, first).** A throwaway script against a **copy** of the dev DB (the `initDb(copy)` pattern from Plan 30 W0). For every stopped row, confirm that the nearest preceding user row has no other assistant row between them, and report any row that fails. If any row fails, stop and report to the owner before step 3.
2. **Migration 037** `backend/src/db/migrations/037_copilot_message_reply_to.sql`: `ALTER TABLE copilot_messages ADD COLUMN reply_to TEXT;`. It is additive, has no backfill, and changes no existing migration. Update `docs/ENGINEERING.md`'s "next migration" line to 038.
3. **`persistTurn`** inserts `reply_to = userMessage.id`.
4. **`turn` event (D-32-2).** `streamCopilotResponse` gains an optional `turnInfo` argument (or a field on an existing options object, whichever is cleaner in place). After `flushHeaders()` it writes `{ type: 'turn', messageId }`.
5. **Service.** `removeStoppedExchange({ tripId, userId, isOwner, messageId })` lives in a co-pilot service file (route validates, service decides). The question row must belong to `tripId` and have `role = 'user'`, otherwise 404. Then the author-or-owner check (D-32-3), then pairing (D-32-4), the stopped and proposal guards (D-32-1), and one `DELETE` of both ids in a transaction. It returns `{ removed: n }`.
6. **Route.** `DELETE /trips/:tripId/copilot/exchanges/:messageId`, behind `requireTripAccess`. Status codes: 404 unknown / other trip; 403 not author or owner ("Only the person who asked, or the trip owner, can remove this."); 409 not stopped / proposal linked / ambiguous legacy pair / already removed ("This conversation changed — reload and try again."). On success, 200 `{ removed }`.
7. **`/history`** adds `userId` to each row.
8. **Tests** in `backend/tests/copilot.test.js`:
   - the author removes their own stopped exchange: both rows are gone, and the next turn's `conversationMessages` lacks them;
   - the owner removes a collaborator's exchange;
   - a collaborator trying to remove another user's exchange gets 403;
   - a finished reply gets 409;
   - a reply with a proposal attached (fixture) gets 409;
   - another trip's id gets 404;
   - removing before the stopped reply lands means the reply is never inserted;
   - a legacy row without `reply_to` pairs correctly, and an ambiguous legacy pair gets 409;
   - `turn` is the first event on the stream;
   - `/history` carries `userId`.

   Then run `cd backend; npm test`.

**Verify (the orchestrator, not a subagent report):** on the dev server with a dedicated verify trip, ask a question and Stop it, call DELETE, then read the rows back with sqlite. Send a fresh question and log the `conversationMessages` length to confirm the removed pair is absent. Exercise the 403 path with a collaborator account.

### M2 — The control (frontend)

1. **`copilotApi.removeExchange(tripId, messageId)`.**
2. **`useCopilot`.** On a `turn` chunk, stamp `serverId` on the live user row. Once that is set, the user row from `send` and its stopped assistant row become removable. History rows use their real `id`/`userId`. Add `removeExchange(serverQuestionId)`, which drops the question and the assistant row right after it from local state, restores them on failure, and rethrows.
3. **`CopilotPanel`.** Add the inline control and confirm (D-32-5). The removable test is: the row has `notice === 'stopped'`, the question before it has a server id, `user.id` is the question's `userId` (or the session's own user for a live row) or equals `ownerId`, and nothing is streaming. Move the notice line's literal colour to `var(--cream-mute)` in the same change, which removes the token fork F-32-8 names.
4. **Tests.**
   - `useCopilot.test.js`: the `turn` event stamps the id; remove after Stop works with no reload; a failure restores the rows.
   - `CopilotPanel.test.jsx`: the link shows for the author and the owner, is hidden for another collaborator and while streaming, and Keep cancels.

   Then run `cd frontend; npm test`, `npm run build`.

**Verify in a real browser (Chrome extension per the QA memory) at 375 px and desktop:**
1. Ask, Stop, Remove, Keep: nothing changes.
2. Remove, then Remove again: the exchange is gone with no reload.
3. Reload: it is still gone.
4. Ask a follow-up: the answer makes no reference to the removed question.
5. Log in as a collaborator: there is no Remove link on the owner's stopped turn.
6. Check that the sheet height never moves during the confirm.
7. Check that the touch targets are at least 36 px at 375 px.

Take screenshots of both widths.

### Close-out (part of M2's commit)

Add `docs/DECISIONS.md` rows for D-32-1 … D-32-6. Update this status line. Production: migration 037 ships with the next deploy, alongside 036. The owner runs the prod legacy check (M1 step 1) against a backup before that deploy, and does a prod click-through using the M2 browser steps.

## Not in scope

- Removing finished exchanges, or any single message on its own.
- Hiding a message instead of removing it.
- An Undo.
- Fixing the orphan proposals Clear conversation leaves behind (F-32-4). That is a separate follow-up if wanted.
- Any change to Plan 11 D8, D-30-8's context lines, or the 50-message window.

## Session model

One session can carry M1 then M2. Orchestrator: Opus 5.5, which reads this plan, briefs, reviews diffs against the facts above and runs the live and browser checks itself. Each milestone gets one Sonnet 5.5 coding subagent:
- **M1:** `backend/src/routes/copilot.js`, `backend/src/services/claude.js` (`turn` write only), the new service function, migration 037, `backend/tests/copilot.test.js`.
- **M2:** `copilotApi.js`, `useCopilot.js`, `CopilotPanel.jsx` and their tests.

M2 depends on M1's `turn` event and route, so the two never run at once. No Fable subagent.
