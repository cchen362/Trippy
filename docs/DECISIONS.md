# Trippy — Settled Decisions

Owner decisions that any coding agent (Claude Code, Codex, or otherwise) must respect and must not re-litigate.

**Why this file exists.** Agent memory stores are per-tool and per-machine. When one agent settles something and records it only in its own memory, the next agent — a different tool, or the same tool on a different machine — cannot see it and will re-propose work that is already done or already declined. This file is in git, so every agent reads the same truth.

**How this file relates to code markers.** Decisions attached to specific behaviour are marked `D-<plan>-<n>` in the code they govern (see "Settled Decisions" in `docs/ENGINEERING.md`). Those get **one line here plus a pointer** — the reasoning stays next to the code, where it cannot drift. Decisions with **no single code home** — service tiers, quotas, cross-cutting rulings — keep their full reasoning here, because this file is their only home.

**How to use it.** Read before proposing changes to a paid provider, a resolver strategy, or anything marked CLOSED. Append when a session settles something durable. Never delete an entry — supersede it and mark the old one SUPERSEDED.

---

## Decisions anchored in code

One line each. The code marker is authoritative; follow the pointer for the reasoning.

| ID | Ruling | Reasoning lives in |
|---|---|---|
| **D-6/8/9 (geography ladder)** | A day's geography resolves through a fixed **five**-layer precedence — override → hotel → transit arrival → previous-day carry → seed — with city and country picked **independently**. Do not collapse or reorder it. | `deriveDayGeo` JSDoc, `backend/src/services/trips.js` (carries `D-26-2`); established by Plans 6, 8, and 9 W3 D5 |
| **D-26-2** | Plan 26 W4.1 must leave the geography precedence byte-identical; it adds layer-*source* signals only. | Same JSDoc |
| **D-27-1** | Show a "Verified" label when a place is verified; show **no label at all** otherwise. Never surface `pending`/`unverified` as user-facing words. Supersedes D-26-1's three-state split, which never shipped. | Discovery display path; Plan 27 |
| **D-25-1 (pin precedence)** | When booking sync and a user-confirmed pin disagree, the **pin wins, silently**. No conflict UI. | `syncStopWithBooking`; Plan 25 |
| **Plan 21 D3 (error channel)** | A mutation failure has exactly one owner. `useStops` opts into the shared page banner via `onError`; `useBookings` does not. Action hooks are namespaced, never flat-spread. | `// D3 CONTRACT:` comment, `frontend/src/pages/TripPage.jsx` |
| **Plan 20 (expenses store)** | The expenses store stays **per-route** and is never lifted into `TripPage` — a ~700ms FX budget would otherwise be paid on every trip screen. | Plan 20 review §9 |
| **Place-naming / resolver strategy — CLOSED** | **Precision over polish. No resolver change.** Nominatim first, Google Places only as fallback. Do not re-propose reordering the chain, a Google-first path, or wider naming coverage. ~28% named-card coverage is the intended output. | The `searchGooglePlaces` fallback comment, `backend/src/services/placeResolver.js`; owner, 2026-07-26 |
| **Co-pilot v1** | No undo. A loss-warning before applying is the chosen treatment. Booking-linked stops are untouchable by co-pilot proposals. A proposal applies as one unit — no selective per-operation apply. | Clause by clause: `Plan 11 D5` above `applyProposal` (no undo) and `Plan 11 D6` above the booking-linked guard, both `backend/src/services/copilotProposals.js`; `computeLossWarnings` in the same file (the loss warning); `Plan 11 D11` in `frontend/src/components/copilot/MutationPreview.jsx` (one unit) |
| **D-29-1 (MCP result shape)** | Every `/mcp` tool result's `content` carries the structured object as a second `TextContent` block, via one `toolResult()` constructor — no return site builds `content` by hand. A text-only host still gets ids/URLs/issue detail it can't reach in `structuredContent`. | `toolResult`, `backend/src/services/mcp/tools.js`; Plan 29 |
| **D-29-2 (MCP summary detail)** | `summarizeDraft`/`summarizeDelete` name every blocker, warning, and info issue (code + location + message; info omits the message but keeps `suggestion`) — never a bare count. Blockers first, then warnings, then info. | `summarizeIssues`, `backend/src/services/mcp/validate.js`; Plan 29 |
| **D-29-4 (MCP empty list states facts, not instructions)** | When `list_trips` returns nothing because the past-trip filter (Q-28-2) hid everything, the summary says how many past trips exist (`No upcoming trips. 5 past trips are on file.`, `hiddenPastCount` in the object) and nothing more. Offering "want to see past trips instead?" and re-calling with `includePast` is the client model's job — Trippy surfaces the fact a text-only host would otherwise never see, and never scripts the conversation. | `formatEmptyTripList`, `backend/src/services/mcp/tools.js`; Plan 29 W2 |
| **D-29-3 (MCP nullable optionals)** | Every optional property in every `/mcp` tool's `inputSchema` accepts `null` as "absent" (`withNullableOptionals`, applied at schema-definition time so a new tool can't opt out); every handler already treats `null` as omitted. Required properties are never made nullable. | `withNullableOptionals`, `backend/src/services/mcp/tools.js`; Plan 29 |

## Superseded or hollowed-out — do not re-stamp

The 2026-07-30 Plan 1–23 marker backfill deliberately left these unmarked. They are recorded here so a future triage does not rediscover them in the plan docs, see no marker, and stamp a ruling that no longer holds.

| Decision | Status |
|---|---|
| **Plan 7 decision 1** — "show unverified items with an *Unverified* badge, rank-penalized" | **Half superseded.** The badge is dead: `D-27-1` shows "Verified" or no label at all, and never surfaces `pending`/`unverified` as user-facing words. The rank penalty is **still live** — `computeScore`'s `3.0 · verified` term in `backend/src/services/discoveryRank.js`. Do not stamp the badge half; it would contradict `D-27-1`. |
| **Plan 10 D5** — "no scene-pool caching initially" | **Behaviour stands, premise is gone.** There is still no scene pool. But the stated reason was the Unsplash *demo* tier, and production is now granted 1,000 req/hr, so this is no longer a settled decision — it is an unexamined default. Treat it as open, not closed, if it ever comes up. |

**Not superseded, despite looking it:** Plan 7 decision 3 (report ⇒ immediate global suppress + audit log) is live and already marked at `backend/src/routes/discovery.js` — Plan 26's archive/suppress split sits alongside it, it did not replace it.

## Decisions with no code home

These live here because nothing in the codebase records them — each is an external-service fact, a corpus-level policy, or an ops detail that no single file governs.

**This section is complete by design, not a backlog.** Prose here does not mean "not yet backfilled with a code marker"; it means a code marker would have nowhere honest to sit. Do not hunt for code homes for these entries. If a future change *gives* one of them a real code home, move it up to the table above and leave a marker at the anchor — that is what happened to the place-naming ruling on 2026-07-30.

### Unsplash API tier — CLOSED

**2026-07-28, owner.** Production tier is **granted at 1,000 requests/hour**. This is no longer a pending application or a constraint to design around. Do not re-propose applying for production access, and do not add rate-limit workarounds premised on the demo tier.

Standing constraints (how it works, not a decision): a single app-wide key is shared with agent diagnostics; each photo action costs a fetch; a throttled fetch leaves the photo `NULL`, recoverable via `backfillTripPhotos`.

The tier itself is an account fact with no code home, so it stays here — but the "no demo-tier workarounds" half of the ruling *does* govern code, and is marked above `search()` in `backend/src/services/unsplash.js`.

### Discovery catalogue — no rebuild

**2026-07-26 → 2026-07-28, Plan 26.** The catalogue is repaired incrementally, never rebuilt. The verified corpus is large (880+ active verified rows) and a rebuild would spend real provider money to regress it. Repair work is bounded and idempotent.

### Hosted MCP ownership — assessment direction

**2026-09-15, owner.** A future Trippy MCP is a hosted, client-independent Trippy feature developed in this repository. It must not depend on Edward or grant another client access to the owner's trips merely because that client can connect. Edward's ability to use a remote MCP belongs to Edward's separate capability assessment and implementation. This settles repository ownership and product boundary, not the MCP tool catalogue, authentication design, rollout, or permission to implement. The advisory assessment is `docs/superpowers/reviews/2026-09-15-hosted-mcp-assessment.md`.

**2026-09-16, owner-stated boundary (recorded, still pre-plan).** Every MCP connection maps to one Trippy user and reaches only that user's owned/collaborated trips; the MCP exposes Trippy business actions, never raw database or generic HTTP access; a preview precedes any trip or booking write; a client may submit structured fields it interpreted from a screenshot and Trippy validates them without a second model extraction; the original screenshot/PDF is retained with the booking when the client can transfer it, a structured booking may still be saved when it cannot and the result must say so; pasted email text is interpretation input and is not retained as an attachment. The planning recommendation that turns this into a proposed Plan 28 structure, with the owner decisions still open (auth stage, must-work clients, multi-booking atomicity, draft TTL, and others), is `docs/superpowers/reviews/2026-09-16-hosted-mcp-planning-recommendation.md` §9. **Nothing is implemented; no plan is authorized until those are answered.**

**2026-09-16, owner rulings D-28-1 … D-28-10 (pre-plan, binding on Plan 28).** Recorded in full in the recommendation's §9; the short form: auth is **personal integration tokens, not OAuth** (OAuth is re-opened only if a connector-only client such as Claude.ai/Desktop becomes wanted); must-work clients are Claude Code, Codex CLI, MCP Inspector, and the owner's own bot; multi-booking apply is all-or-nothing; drafts expire in 30 minutes; a new trip's title/dates/destinations come from the client, never inferred from a booking; three coarse scopes; collaborators keep UI write parity; `delete_booking` exists **only** as a preview→apply draft and is the sole destructive tool; no expense/cost on drafts; a missing time zone is an info note, never a blocker. These carry `D-28-n` ids so the code that implements them can cite them; until that code exists, this row and the recommendation are their only home.

One code-verified constraint from that review that any future plan must respect: provider daily budgets are **in-memory per process** (`backend/src/config.js`), so an MCP endpoint must run **inside the existing Express process** unless the budgets are first moved into SQLite. This is a consequence of Plan 26's budget design, not a new ruling.

**2026-09-16, Plan 28 W5 — adopted interpretations and tested facts (promoted out of the plan so they outlive it).**
- **I-28-1 adopted:** the Integrations UI lives in the Account modal (initials → Integrations), on `ModalShell`, not a route. A deep-linkable `/account/integrations` page can be added later without moving the panel.
- **I-28-2 adopted:** `prepare_delete` removes exactly what the app's own delete removes with the same inputs — linked expenses are **kept and unlinked** unless the client names them in `deleteExpenseIds`. The preview reports each as `willUnlink` / `willDelete`. Do not "fix" a cost that survives an MCP delete.
- **Mount order (F-28-22), a fact not a preference:** `/mcp` is mounted in `backend/src/index.js` *before* the global 16 MB `express.json()` because it owns its own 1 MB JSON parser and the upload route its own `express.raw`. Reordering breaks `PUT /mcp/uploads/:ticket` silently.
- **Cloudflare keep-alive is a tested requirement, not a hedge:** the public host is a Cloudflare Tunnel with a 100 s no-bytes origin timeout. `apply_draft` streams a notification before its first provider call and `: keepalive` every 15 s; a 153 s apply completed through `https://trippy.zyroi.com/mcp` on 2026-09-16. Any future long-running MCP tool must stream the same way.
- **Revoked tokens are deleted, not revealed (W5.6, owner request after Deploy A QA):** revoke stays the instant-kill-plus-audit step and revoked rows stay listed dimmed; `DELETE /api/integrations/tokens/:id` removes a **revoked** row only and answers 409 for a live token, so a row can never vanish while its hash still authenticates. Revoke moved to `POST /api/integrations/tokens/:id/revoke` so the verbs read honestly. Show-once plaintext remains unrecoverable (F-28-25) — do not propose a reveal.
- **The MCP path never calls Anthropic.** Client-side interpretation, server-side validation. A proposal to add an extraction or "clean-up" model call on `/mcp` reopens a closed cost boundary.

### Production server facts

Not a decision, but facts agents keep re-deriving: the app runs on port **6768** (not 3001), in container `trippy-trippy-1`. Production `~/Trippy/data` is root-owned with no passwordless sudo — take backups with the **host** `/usr/bin/sqlite3` (the container has none) into chee-owned `~/Trippy/backups/`. The production migrations table is `_migrations`.

Public ingress (verified 2026-09-16): `https://trippy.zyroi.com` is a **Cloudflare Tunnel** — TLS terminates at Cloudflare, a host-level `trippy-cloudflared.service` forwards to the container's host port, and no nginx/Caddy is in Trippy's path (the `nginx-proxy-manager` container on the box serves other apps). Consequences: Cloudflare's 100-second no-bytes origin timeout (HTTP 524) applies to any long response, so streamed endpoints must emit keep-alives; tunnel ingress lives in the Cloudflare dashboard, not on the server.
