# Implementation Plan 28 — Hosted MCP

**Status:** 2026-09-16 — **WRITTEN, NOT STARTED. Nothing in this plan is implemented.** No MCP endpoint, no `integration_tokens` / `mcp_drafts` / `mcp_upload_tickets` table, no migration, no dependency, no env var, no Integrations UI, and no deploy exist. Highest applied migration remains **032** (`_migrations` id 32). Written at `c8e8f1c` from the settled planning recommendation; all ten owner rulings D-28-1 … D-28-10 are taken, so no wave is blocked on a product question. One plan-level interpretation (I-28-2) and two non-blocking questions (Q-28-1, Q-28-2) are recorded below with the default each wave will follow unless the owner says otherwise; I-28-1 (Integrations UI in the Account modal) was confirmed by the owner the same day. Waves are implemented later via `/implement-milestone`; each wave updates its own status line and commits. **W0 (the SDK v2 handshake spike) completed 2026-09-16 with a GO — see its status line; it merged no code.**

**Origin:** the owner's 2026-09-15 ruling that a Trippy MCP is a hosted, client-independent Trippy feature owned by this repository (`docs/DECISIONS.md` → "Hosted MCP ownership"), the [2026-09-15 assessment](../reviews/2026-09-15-hosted-mcp-assessment.md) (background; its 2026-09-16 addendum lists what it got wrong), and the [2026-09-16 planning recommendation](../reviews/2026-09-16-hosted-mcp-planning-recommendation.md) — **the source of every design choice here**. Where this plan and the recommendation disagree, this plan is the later document and wins; where this plan and live code disagree, code wins.

**Scope in one sentence:** let an MCP client that holds a personal Trippy token read that one user's trips, preview a booking (or a booking deletion, or a new trip with bookings) as a durable draft, apply it atomically with the same stop inference the app uses, and hand the original screenshot/PDF to Trippy through a one-time upload address — never through a model.

**What this plan deliberately does NOT do.** It does not build OAuth 2.1 or any authorization server (D-28-1 — W4 is listed only so the numbering survives). It does not add discovery, add-stop, stop-editing, expense, collaborator, share-link, trip-deletion, co-pilot, or admin tools. It does not run a second model extraction over a screenshot — the client interprets, Trippy validates structured fields. It does not retain pasted email text. It does not move provider budgets out of memory (F-28-4 is *why* the MCP runs in-process, not a reason to refactor budgets). It does not widen `computeTripFingerprint` (Plan 11 D3). It does not change `deriveDayGeo`, the booking-sync pin precedence (D-25-1), or any UI write path — the resolve/write split of `syncStopWithBooking` in W2 is behaviour-preserving for the app. It does not touch Edward; Edward's remote-MCP capability is a separate assessment in a separate repo.

---

## Validated facts — established 2026-09-16 at `c8e8f1c`, do not re-derive

Facts F-28-1 … F-28-19 are the recommendation's F1–F17 and X1–X6 (read from live code and official sources on 2026-09-16), restated with the consequence each one has for this plan. F-28-20 … F-28-26 were established while writing this plan and are **new** — the recommendation did not record them.

**F-28-1 — One Express process, cookie auth only, no bearer path.** `backend/src/index.js`: `app.set('trust proxy', 1)`, CORS pinned to `FRONTEND_URL`, `express.json({ limit: '16mb' })` mounted globally at `index.js:39` (Plan 2A D2 — base64 capture uploads), no request logging, no SIGTERM/SIGINT handler, `app.listen` reference not kept. `middleware/auth.js:4` reads **only** `req.cookies?.auth_token`; sessions are `auth_sessions` rows (`services/auth.js:56-63`, token compared in plaintext). Consequence: W1 adds a bearer verifier that is a *separate* credential path; the cookie path is untouched.

**F-28-2 — Membership is owner-or-collaborator; `role` is never checked.** `services/trips.js:786-860` — `assertTripAccess`/`assertDayAccess`/`assertStopAccess`/`assertBookingAccess` test `owner_id` or a `trip_collaborators` row; the stored `role` (`'editor'` default) is read by nothing. Collaborators have full write parity. Consequence: D-28-7 is "no new rule" — every MCP tool calls these helpers and inherits exactly this.

**F-28-3 — Rate limiting exists only on `/api/auth`** (`middleware/rateLimit.js`, `express-rate-limit` 8.x, keyed by IP, `AUTH_RATE_LIMIT` = 5 under test / 20 otherwise). Consequence: W1 adds a per-token limiter for `/mcp` and a per-IP limiter for its 401 path, using the same library.

**F-28-4 — Provider daily budgets are in-memory per process.** `config.js:53-82` (`discoveryResolverDailyRequestBudget` 1000, `discoveryEscalationDailyBudget` 50, `discoveryReverifyDailyRequestBudget` 150, per-destination cap), reset per UTC day — Plan 26 W2.3/W3.2/W3.3. **This forces the MCP into the existing process**; an adjacent service would silently double every ceiling. Not a preference — a constraint.

**F-28-5 — Booking and stop are not atomic today.** `createBooking` (`services/bookings.js:101-160`) validates, runs **one** transaction (booking + optional expense), then `await syncStopWithBooking(row)` (`services/stops.js:937-1057`) does Nominatim/Google/Unsplash I/O and writes the stop **outside any transaction**. A crash between them leaves a booking with no stop. `stops.js` already has the resolve/write split for plain stops — `resolveCreateStopData` (`:431`) / `writeCreateStop` (`:460`). `applyProposal` (`services/copilotProposals.js:484-548`) is the model: re-validate → re-fingerprint → resolve phase (all external I/O) → one write transaction including the status flip. Consequence: W2.2 splits `syncStopWithBooking` the same way; the app path keeps calling the composed function and stays behaviourally identical.

**F-28-6 — Stop creation can silently not happen.** `inferBookingStop` (`stops.js:687-723`, called at `:947-952`) returns `null` when `show_in_itinerary` is off *or* the trip has no `days` row for the booking's start date — no error, no message. Consequence: `prepare_draft` must surface `no_day_for_date` as a planned effect *before* apply, and `apply_draft` must return `stopId: null` with `stopReason`.

**F-28-7 — `confirmArtifact` is not a reusable write path.** `services/importer.js:352-397` loops `createBooking` sequentially, then updates the artifact: not atomic, not idempotent (a retry re-creates every booking), and it pays for a model extraction the MCP client already did. Consequence: rejected as the apply path (recommendation §7).

**F-28-8 — What the importer exports and what it does not.** `normalizeExtractedBooking` (`importer.js:139`) **is** exported (datetime/tz normalizers). `computeWarnings` (`importer.js:172-216` — `lowConfidence`, `duplicate` = same trip + type + case-insensitive `confirmation_ref`, `beforeTripStart`, `afterTripEnd`, `notTravelRelated`, `empty`) is **not** exported. Consequence: W2.1 exports the warning logic (or lifts its rules into a shared module both callers import) — **never copies it**.

**F-28-9 — Attachment limits and the missing hash.** `services/attachments.js:4-6, 33-52`: PNG/JPEG/WebP ≤ 5 MB, PDF ≤ 10 MB, `MAX_ATTACHMENTS = 4` per booking, base64 JSON body, BLOB storage. `booking_attachments` (migration 012) has **no `content_hash`** column; `import_artifact_files` (011) does. Consequence: idempotent re-upload after a timeout needs a hash → additive columns in W3's migration, with a backfill.

**F-28-10 — `copilot_proposals` is the durable preview/apply precedent, and its fingerprint does not cover bookings.** Migration 028; `status pending|applied|rejected|stale|invalid`, `status_reason`, `resolved_by_user_id`. `computeTripFingerprint` (`copilotProposals.js:293-304`) hashes day ids + per-day `stop.id|time|booking_id` — **not** bookings. A draft fingerprinted with it would not go stale when the user adds the same hotel by hand between preview and apply. Consequence: `mcp_drafts` carries its **own** `booking_fingerprint` (§ Schema); the co-pilot's is not widened (Plan 11 D3).

**F-28-11 — `createTrip` is one transaction; read paths are DB-only.** `services/trips.js:913-997` (trip + days + scopes, requires title/startDate/endDate, seeds every day from chip #1 — Plan 9 D4). `listTripsForUser` (`:862-911`) and `getTripDetail` (`:1261`) make no provider calls. Consequence: read tools cost nothing; `createTrip` can be called *inside* the apply transaction (F-28-12).

**F-28-12 — `better-sqlite3` 9.6.0 nests `db.transaction()` as savepoints.** Proved with a throwaway script on 2026-09-16: an inner service transaction (`createTrip`-shaped) rolls back with the outer one. Consequence: trip + N bookings + N stops + draft status flip can be **one** unit (D-28-3).

**F-28-13 — Next free migration is 033.** Highest applied is 032; the runner (`db/migrations.js`) applies `.sql` and `.js` in name order into `_migrations`. **Rule: "next free number at merge time."** This plan's waves need three migrations; they are referred to below as *the W1 migration*, *the W2 migration*, *the W3 migration*, expected to be 033/034/035 if the waves merge in order — but the number is assigned when the wave merges, not here.

**F-28-14 — Production is a Cloudflare Tunnel, no nginx in the path.** Docker `node:20-alpine`, container 3001 → host **6768**, DB volume outside the container. `https://trippy.zyroi.com` resolves to Cloudflare; TLS terminates at the edge; a host-level `trippy-cloudflared.service` forwards the whole hostname to the container's host port; the `nginx-proxy-manager` container serves *other* apps. Verified over SSH 2026-09-16. Consequences: (a) adding `/mcp` needs **no ingress change** — verify once in W1; (b) Cloudflare returns **524 after 100 s with no bytes**, so every long tool streams progress and an SSE keep-alive comment at least every 30 s, and this is **tested through the public host** in W2, not assumed; (c) request bodies to 100 MB pass on the free plan, so 10 MB uploads are fine; (d) bot-protection must not challenge non-browser clients on `/mcp` and `/mcp/uploads/*` — `curl /api/health` passes today, re-check after the W1 deploy.

**F-28-15 — Test harness.** vitest, real SQLite in a temp dir with migrations applied, Anthropic SDK mocked, 36 test files (`backend/tests/`). Tests do **not** import `src/index.js` (which listens at import); each test file builds its own scratch Express app and mounts the router under test — see `tests/auth.test.js:5-11`. Consequence: the SDK-client e2e test (W1.7) mounts `routes/mcp.js` on a scratch app on an ephemeral port and points the real `@modelcontextprotocol/client` at it. No app factory refactor is needed.

**F-28-16 — Versions.** Express 4.22.2 (`^4.19.2`), Node 20 in Docker, `geo-tz ^8.1.6` already a dependency (used for D-28-10's suggestion), `express-rate-limit ^8.5.2`.

**F-28-17 — MCP spec revision 2026-07-28 (official pages, fetched 2026-09-16).** Streamable HTTP: single POST endpoint; **no** `Mcp-Session-Id`, no GET stream, no `Last-Event-ID`; `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` request headers **required** and must match the body (`-32020 HeaderMismatch`); closing the SSE response stream **is** cancellation; `X-Accel-Buffering: no` recommended; a server MAY treat a header-less request as 2025-03-26; GET/DELETE → 405. Authorization is **OPTIONAL**; when supported it SHOULD be OAuth 2.1 resource-server conformant (RFC 9728 metadata, RFC 8707 audience, 401 + `WWW-Authenticate`, 403 `insufficient_scope`). D-28-1 deliberately deviates from that SHOULD; the RFC 9728 metadata document is still served from W1 because it is cheap and it is what future clients look for.

**F-28-18 — TypeScript SDK v2.0.0.** Packages `@modelcontextprotocol/server`, `/node`, `/express` (`engines.node >= 20`, express peer `^4.18 || ^5`). The Streamable HTTP handler is **stateless per request**, documented as serving 2025-era clients from the same handler by default (**untested here — I-28-A below; W0 exists to test it**), and validates **no** Host/Origin/token itself — verification goes in front and is passed in as `authInfo`. v2 ships **resource-server helpers only** (`requireBearerAuth`, `OAuthTokenVerifier` = `verifyAccessToken(token) → { token, clientId, scopes, expiresAt }`, `mcpAuthMetadataRouter`); the authorization-server helpers are frozen in `server-legacy`. Legacy `@modelcontextprotocol/sdk` 1.30.0 is supported ≥ 6 months — **not** used (would need re-migration inside its window).

**F-28-19 — Client landscape.** Claude.ai / Claude Desktop custom connectors accept **OAuth only** (no static bearer — `anthropics/claude-ai-mcp` #112, #411, #693). Claude Code accepts `--header "Authorization: Bearer …"` for HTTP servers. Consequence: D-28-2's client list is exactly the set a static token serves.

**F-28-20 — NEW: there is no settings page or settings route.** `frontend/src/App.jsx:41-51` routes are `/trips`, `/trips/:tripId/{today,plan,logistics,map,expenses}`, `/share/:token`. Account-level UI is two `ModalShell` modals: `components/common/UserAccountButton.jsx` (initials button → "Account" modal: username, sign out) and `components/admin/AdminSettingsPanel.jsx` (admin-only: invite code, user list). The recommendation's "Settings → Integrations" surface **does not exist yet**. Resolved by I-28-1.

**F-28-21 — NEW: `deleteBooking` keeps linked expenses unless told otherwise, and the UI defaults to keeping them.** `services/bookings.js:209-247`: expenses are deleted only for ids the caller passes in `deleteExpenseIds` (each validated for existence, trip membership, and linkage before the transaction); survivors are unlinked by the schema (`expenses.booking_id … ON DELETE SET NULL`, migration 031); the `booking_required = 1` stop is deleted; any other stop pointing at the booking is unlinked (`SET booking_id = NULL`). `BookingDeleteReview.jsx` starts with an **empty** selection — the user opts each expense *in* to deletion. Resolved by I-28-2: `prepare_delete` mirrors this exactly.

**F-28-22 — NEW: mount order decides whether `/mcp` gets the 16 MB parser and the SPA fallback.** The global `express.json({ limit: '16mb' })` at `index.js:39` runs before every route; a router mounted after it inherits 16 MB. The production SPA fallback `app.get('*')` (`index.js:61-64`) skips only paths starting with `/api`, so **with `MCP_ENABLED` off, `GET /mcp` serves `index.html` (200) and `POST /mcp` is Express's default 404**. Consequences: (a) the `/mcp` router with its own `express.json({ limit: '1mb' })` is mounted **before** line 39; (b) the RFC 9728 metadata route and `GET /mcp → 405` are mounted before the fallback (all `/api` mounts already are, so mounting alongside them suffices); (c) the W1 rollback gate reads "POST /mcp → 404", not "GET /mcp → 404".

**F-28-23 — NEW: `/api/health` returns `{ status, db }` only** (`routes/health.js`). W1 adds `mcp: { enabled, protocolVersions }`.

**F-28-24 — NEW: the raw-body upload route is unaffected by the global JSON parser.** `express.json` parses only `Content-Type: application/json`; an `image/png` or `application/pdf` body passes through untouched to `express.raw` on `/mcp/uploads/:ticket`. No parser reordering is needed for uploads — only for `/mcp` itself (F-28-22).

**F-28-25 — NEW: `auth_sessions` stores the session token in plaintext** (`services/auth.js:56-63, 88-94`). Integration tokens are stored **hashed** (sha256) — a deliberate difference, because a token is copied into client config files and lives up to a year, whereas a session cookie is httpOnly and 30 days. Do not "align" the two.

**F-28-26 — NEW: the admin surface is `requireAdmin` on `/api/auth/admin/*`** (`routes/auth.js:64-76`; `users.is_admin`, migration 001). Consequence: "admins see all tokens" (recommendation §5.3) is one extra `is_admin` branch in the list/revoke endpoints, not a new permission model.

### Inferences carried from the recommendation (reasoned, not read)

- **I-28-A.** Whether Claude Code's and Codex CLI's *current* builds speak 2026-07-28 or a 2025 revision is unknown. W0 turns this into a fact (D-28-2 names both as must-work). **Resolved by W0 (2026-09-16): Claude Code 2.1.2xx speaks 2026-07-28 with the `_meta` envelope; Codex 0.144.6 speaks 2025-06-18; Inspector 2.6.0 speaks 2025-11-25; SDK v2 served all three from one factory.**
- **I-28-B.** A model-driven client will not upload bytes itself; the *client host* (Claude Code's shell, Codex's shell, a script) will. Document retention therefore works only from agentic clients — a product expectation to set in the tool description, not a defect.
- **I-28-C.** Return flights and two-leg itineraries are common in one screenshot; a draft carries **N** bookings, so all-or-nothing apply (D-28-3) is the only shape that makes a blind retry safe.

---

## Owner decisions — SETTLED 2026-09-16, binding, and where each marker lands

The rulings are recorded in full in the recommendation §9 and in short form in `docs/DECISIONS.md`. **Nothing below is reopened.** The right-hand column is new: it names the file that will carry the one-line `D-28-n` citation when the governing code exists, so the ENGINEERING.md grep (`D-[0-9]{2}-[0-9]+`) finds it. Stamping the marker is part of the wave that writes the code.

| ID | Ruling (short) | Wave | Marker lands in |
|---|---|---|---|
| **D-28-1** | Auth = personal integration tokens, not OAuth. OAuth is an unplanned conditional wave, reopened only if a connector-only client (Claude.ai / Claude Desktop) becomes wanted. | W1 | `backend/src/routes/mcp.js` above the bearer verifier; `backend/src/services/integrationTokens.js` header |
| **D-28-2** | Must-work clients: Claude Code, Codex CLI, MCP Inspector, the owner's own bot/scripts. | W0, W1 | `backend/src/services/mcp/server.js` header (protocol-version handling) |
| **D-28-3** | Multi-booking apply is all-or-nothing per draft. | W2, W3 | `backend/src/services/mcp/apply.js` above the write transaction |
| **D-28-4** | Draft TTL 30 minutes. | W2 | `backend/src/services/mcp/drafts.js` at `DRAFT_TTL_MS` |
| **D-28-5** | New trip: client supplies title, dates, destinations; Trippy validates and never infers a range from a booking. | W3 | `backend/src/services/mcp/validate.js` in the `newTrip` branch |
| **D-28-6** | Three coarse scopes: `trips:read`, `trips:write`, `documents:write`. | W1 | `backend/src/services/integrationTokens.js` at the `SCOPES` constant |
| **D-28-7** | Collaborator parity with the UI: a collaborator's token may write on shared trips. | W1 | `backend/src/services/mcp/tools.js` where `userId` from `authInfo` meets `assert*Access` |
| **D-28-8** | `delete_booking` exists only as `prepare_delete` → `apply_draft`; sole destructive tool. | W3 | `backend/src/services/mcp/prepareDelete.js` header |
| **D-28-9** | No `cost`/expense on booking drafts. | W2 | `backend/src/services/mcp/validate.js` where `cost` is rejected |
| **D-28-10** | Missing time zone is an info issue, never a blocker; local wall-clock stored as the UI stores it; suggest via `geo-tz`/IATA when available. | W2 | `backend/src/services/mcp/validate.js` at the `timezone_unknown` issue |

### Plan-level interpretations (not owner rulings — the default each wave follows; the owner may override before the wave starts)

**I-28-1 — Where the Integrations UI lives (resolves F-28-20). CONFIRMED by owner 2026-09-16: the Account modal is the home — it currently shows only the username and Sign out, and the owner prefers extending that existing control over a new page or icon button. W1.3 does not re-ask.** *Plain language:* there is no settings page to put it on, so the plan puts it where the app already keeps account-level things. *Example:* tap your initials at the top of Trips Home → the Account modal now has an **Integrations** row under your username → it opens a panel listing your tokens with a **New token** action. *Implication:* zero new routes, reuses the `ModalShell` primitive (Plan 17/18) and the exact pattern `AdminSettingsPanel` already uses, works at 375px by construction; the give-up is that a token list is not a deep-linkable page. *Default:* `components/integrations/IntegrationsPanel.jsx` on `ModalShell`, opened from a new row in `UserAccountButton`'s modal. A dedicated `/account/integrations` route is the alternative if the owner wants a shareable link to the page; it costs one route and a page shell and can be added later without moving the panel.

**I-28-2 — What `prepare_delete` removes (resolves F-28-21 against D-28-8).** *Plain language:* D-28-8 says the preview "shows exactly what disappears (booking, linked stop, linked expenses)"; the app's own delete keeps linked costs unless you tick them. *Example:* you paid for the hotel and logged it as a cost; the bot prepares a delete of that hotel; the preview says "booking removed, its itinerary stop removed, 1 linked cost of MYR 420 will be **kept and unlinked**." If the client passes that cost's id in `deleteExpenseIds`, the preview says "… will be **deleted**" instead. *Implication:* the MCP deletes exactly what the app deletes with the same inputs (D-28-7's parity principle), and a bot cannot silently destroy expense history the user never chose to delete. *Default:* `prepare_delete` accepts an optional `deleteExpenseIds` and reports each linked expense as `willDelete` or `willUnlink`; with the field absent every linked expense is kept and unlinked — identical to the app's default.

### Questions deliberately left open (non-blocking)

- **Q-28-1 — Token expiry ceiling.** Default: the create form offers 30 / 90 / 365 days and "no expiry"; the recommendation's example used 90. If the owner wants to forbid non-expiring tokens, W1.3 drops the option — one line.
- **Q-28-2 — Should `list_trips` include past trips by default?** Default `includePast: false` (matches Trips Home's emphasis on live/upcoming). Reversible in W1.5 without a schema change.

---

## Architecture (settled — recommendation §5.1, §5.2, §7)

Client → `https://trippy.zyroi.com/mcp` (Express route in the **existing** process, SDK v2 stateless Streamable HTTP transport) → bearer verifier (`integration_tokens`) → tool handlers in `backend/src/services/mcp/` → **existing** services (`trips`, `bookings`, `stops`, `attachments`) → SQLite. Uploads → `PUT /mcp/uploads/:ticket` raw body → `addAttachment`. Enabled by `MCP_ENABLED=1`; canonical URI `MCP_PUBLIC_URL=https://trippy.zyroi.com/mcp` (exact, no trailing slash).

**Rejected (recommendation §7, do not re-propose):** adjacent service (F-28-4); legacy SDK 1.x; reusing the cookie / `auth_sessions`; base64 documents in tool arguments; `import_artifacts` + `confirmArtifact` as the write path (F-28-7); a direct `createBooking` tool without a draft.

**Files this plan creates or touches (all waves):**

| Path | Role |
|---|---|
| `backend/src/routes/mcp.js` | bearer verify → Origin check → SDK transport per request; `GET/DELETE → 405`; `/.well-known/oauth-protected-resource`; `/mcp/uploads/:ticket` raw route |
| `backend/src/services/integrationTokens.js` | create / list / revoke / verify (hash compare, expiry, `last_used_at`) |
| `backend/src/services/mcp/server.js` | builds the `McpServer`, registers tools, protocol-version handling |
| `backend/src/services/mcp/tools.js` | `list_trips`, `get_trip`, `get_apply_status`, `request_upload_ticket` |
| `backend/src/services/mcp/validate.js` | `BookingInput` → `NormalizedBooking` + issues; `newTrip` validation; planned effects |
| `backend/src/services/mcp/drafts.js` | `mcp_drafts` CRUD, TTL, booking fingerprint, lazy sweep |
| `backend/src/services/mcp/apply.js` | resolve phase → one write transaction; progress notifications; `already_applied` |
| `backend/src/services/mcp/prepareDelete.js` | delete preview (W3) |
| `backend/src/services/mcp/uploads.js` | tickets + raw-body handler (W3) |
| `backend/src/services/stops.js` | `syncStopWithBooking` split into `resolveBookingStopData` / `writeBookingStop` (W2.2) |
| `backend/src/services/importer.js` | export the warning rules (W2.1) |
| `backend/src/services/attachments.js` | `content_hash` + `source` on insert; hash-dedupe lookup (W3) |
| `backend/src/routes/health.js` | `mcp` field (W1) |
| `backend/src/routes/auth.js` or new `routes/integrations.js` | `/api/integrations/tokens` CRUD for the UI (W1) |
| `backend/src/index.js` | mount `/mcp` before the global JSON parser; SIGTERM (W5) |
| `backend/src/db/migrations/<next>_integration_tokens.sql` | W1 |
| `backend/src/db/migrations/<next>_mcp_drafts.sql` | W2 |
| `backend/src/db/migrations/<next>_mcp_upload_tickets.js` | W3 (`.js` — backfills `content_hash`) |
| `frontend/src/components/integrations/IntegrationsPanel.jsx` (+ test) | W1 (I-28-1) |
| `frontend/src/components/common/UserAccountButton.jsx` | Integrations row (W1) |
| `frontend/src/services/integrationsApi.js` | W1 |
| `backend/.env.example`, `docs/ENGINEERING.md`, `docs/DECISIONS.md` | W1 (env), W5 (docs) |

---

## Tool catalogue — exact contracts (recommendation §5.4, verbatim, plus `prepare_delete`)

Every tool returns `structuredContent` (the object below) **plus** a short text summary. Every write result carries Trippy URLs (`/trips/:id`, `/trips/:id/logistics`). `userId` always comes from `authInfo`; every handler goes through `assert*Access(userId, …)` (F-28-2) — never a raw query.

| Tool | Scope | Input (exact) | Output (exact) | Side effects |
|---|---|---|---|---|
| `list_trips` | `trips:read` | `{ query?: string, includePast?: boolean }` | `{ trips: [{ id, title, startDate, endDate, status, destinations: [{city, countryCode}], url }] }` | none (F-28-11) |
| `get_trip` | `trips:read` | `{ tripId, include?: ("days"\|"bookings")[] }` | `{ trip, days?: [{ id, date, resolvedCity, resolvedCountry, stopCount }], bookings?: [{ id, type, title, confirmationRef, startDatetime, endDatetime, origin, destination, originTz, destinationTz, documentCount, url }] }` | none |
| `prepare_draft` | `trips:write` | `{ idempotencyKey, target: { tripId } \| { newTrip: { title, startDate, endDate, destinations: [{city, countryCode?}] } }, bookings: [BookingInput], source: { kind: "screenshot"\|"pdf"\|"email_text"\|"manual", sha256?, mediaType?, sizeBytes? } }` | `{ draftId, expiresAt, target, bookings: [NormalizedBooking], issues: [Issue], plannedEffects: [{ bookingIndex, stop: { willCreate, date, reason? } }], applyAllowed: boolean, summary: string }` | inserts `mcp_drafts` row |
| `apply_draft` | `trips:write` | `{ draftId }` | `{ status: "applied"\|"already_applied", tripId, tripUrl, createdTrip: boolean, bookings: [{ bookingIndex, bookingId, stopId\|null, stopReason?, url }], sourceDocument: { status: "not_requested"\|"pending_upload"\|"saved"\|"failed"\|"unsupported", ticket?: {uploadUrl, expiresAt, maxBytes, requiredSha256} } }` | trip/bookings/stops/draft flip in one txn; provider I/O in resolve phase |
| `request_upload_ticket` | `documents:write` | `{ bookingId, mediaType, sizeBytes, sha256 }` | `{ ticket: { uploadUrl, expiresAt, maxBytes } }` | inserts `mcp_upload_tickets` row |
| `get_apply_status` | `trips:read` | `{ draftId } \| { idempotencyKey }` | same shape as `apply_draft` output plus `draftStatus` | none |
| `prepare_delete` | `trips:write` | `{ idempotencyKey, bookingId, deleteExpenseIds?: string[] }` | `{ draftId, expiresAt, kind: "delete", booking: { id, type, title, confirmationRef, startDatetime, url }, linkedStop: { id, title, dayDate, effect: "willDelete"\|"willUnlink" } \| null, linkedExpenses: [{ id, description, amountMinor, currency, effect: "willDelete"\|"willUnlink", openRepayments?: string }], issues: [Issue], applyAllowed: boolean, summary: string }` | inserts `mcp_drafts` row with `kind = 'delete'` |

`apply_draft` on a `kind = 'delete'` draft returns `{ status: "applied"|"already_applied", tripId, tripUrl, deleted: { bookingId, stopId|null, expenseIds: [] }, unlinked: { stopIds: [], expenseIds: [] } }` and performs exactly `deleteBooking(userId, bookingId, { deleteExpenseIds })` inside the draft transaction (I-28-2).

**`BookingInput`** = the existing `createBooking` payload minus `cost`: `type, title, confirmationRef, bookingSource, startDatetime, endDatetime, origin, destination, terminalOrStation, originTz, destinationTz, detailsJson, showInItinerary`. A `cost` key present → `Issue{ severity: "blocker", code: "cost_not_accepted" }` (D-28-9).

**`Issue`** = `{ severity: "blocker"|"warning"|"info", code, bookingIndex?, field?, message, suggestion? }`. `applyAllowed = false` whenever any blocker exists; `apply_draft` re-runs validation and refuses with 422 if a blocker remains.

**Issue codes (v1, closed list).** Validation is deterministic, reusing `normalizeExtractedBooking`'s datetime/tz normalizers and the exported F-28-8 warning rules.

| Code | Severity | Rule |
|---|---|---|
| `missing_required_field` | blocker | per type: flight needs `title+startDatetime+origin+destination`; hotel needs `title+startDatetime+endDatetime+destination`; train like flight; other needs `title+startDatetime` |
| `invalid_datetime` | blocker | not parseable by the shared normalizer |
| `invalid_timezone` | blocker | supplied tz not an IANA name |
| `timezone_unknown` | **info** | tz omitted; `suggestion` from `geo-tz` when the place resolves, else from IATA when `origin`/`destination` is a code (D-28-10) |
| `end_before_start` | blocker | |
| `outside_trip_dates` | blocker for `{ tripId }` targets; not raised for `newTrip` | from the exported `beforeTripStart` / `afterTripEnd` rules |
| `duplicate_confirmation_ref` | warning | same trip + type + case-insensitive `confirmation_ref` (F-28-8 rule); carries `existingBookingId` |
| `probable_duplicate` | warning | same trip + type + start date + case-folded origin/destination; carries `existingBookingId` |
| `source_already_attached` | warning | `source.sha256` already on a `booking_attachments.content_hash` in this trip (W3+) |
| `multi_leg_detected` | info | ≥ 2 bookings in the draft share type and confirmation ref |
| `no_day_for_date` | info, and a `plannedEffects` entry with `willCreate: false` | the trip has no `days` row for the booking's start date (F-28-6) |
| `cost_not_accepted` | blocker | D-28-9 |
| `new_trip_invalid` | blocker | `newTrip` missing title/startDate/endDate/≥1 destination, or `endDate < startDate` (D-28-5) |
| `booking_not_found` | blocker (`prepare_delete`) | `assertBookingAccess` fails — reported as not found, never as "exists but not yours" |
| `expense_not_linked` | blocker (`prepare_delete`) | a `deleteExpenseIds` entry is not linked to this booking — mirrors `deleteBooking`'s 400 |

**HTTP / JSON-RPC error semantics.** No token or bad token → `401` + `WWW-Authenticate: Bearer resource_metadata="<MCP_PUBLIC_URL origin>/.well-known/oauth-protected-resource"`. Valid token, missing scope → `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="trips:write"`. Browser `Origin` present and ≠ `FRONTEND_URL` → `403`. `GET`/`DELETE /mcp` → `405`. Draft not found / not yours / other user's trip → tool error `not_found` (404 semantics; never leak existence). Draft `expired` / `stale` / `invalid` → tool error with that code and `prepare again` guidance. Blocker at apply → tool error `apply_refused` (422 semantics) with the current issues. Rate limit → `429` with `Retry-After`.

---

## Schema (additive; numbers assigned at merge — F-28-13)

**W1 migration — `integration_tokens`.**
`id TEXT PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, scopes_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NULL, last_used_at TEXT NULL, revoked_at TEXT NULL`; index on `user_id`. Token format: `trp_` + 43 base64url chars (32 random bytes); `token_prefix` = first 12 characters (`trp_` + 8) for recognition in the list; `token_hash` = sha256 hex of the full plaintext; plaintext shown **once**.

**W2 migration — `mcp_drafts`.**
`id TEXT PK, user_id TEXT NOT NULL REFERENCES users(id), token_id TEXT NOT NULL REFERENCES integration_tokens(id), idempotency_key TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'booking' CHECK (kind IN ('booking','delete')), target_json TEXT NOT NULL, bookings_json TEXT NOT NULL, issues_json TEXT NOT NULL, planned_effects_json TEXT NOT NULL, source_json TEXT NOT NULL, trip_id TEXT NULL, booking_fingerprint TEXT NULL, status TEXT NOT NULL CHECK (status IN ('pending','applied','expired','stale','invalid','rejected')), status_reason TEXT NULL, result_json TEXT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, applied_at TEXT NULL`; `UNIQUE(user_id, idempotency_key)`; index on `(status, expires_at)`. `kind` is included from the start so W3's delete draft is not a second migration. `booking_fingerprint` = sha256 over the target trip's day dates + every booking's `(id, type, confirmation_ref, start_datetime, end_datetime, origin, destination)` ordered by id; `NULL` for `newTrip` targets. For `kind = 'delete'` it additionally covers the booking's linked stop id and linked expense ids, so a cost added after preview goes stale rather than silently surviving or dying.

**W3 migration (`.js`) — `mcp_upload_tickets` + attachment provenance.**
`mcp_upload_tickets(id TEXT PK, user_id, token_id, booking_id REFERENCES bookings(id) ON DELETE CASCADE, expected_sha256 TEXT NOT NULL, media_type TEXT NOT NULL, max_bytes INTEGER NOT NULL, status TEXT CHECK (status IN ('pending','used','expired')), created_at, expires_at, used_at NULL, attachment_id NULL)`; `ALTER TABLE booking_attachments ADD COLUMN content_hash TEXT`; `ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`; backfill `content_hash` for every existing row (SHA-256 of `content`) in the same migration; index on `(booking_id, content_hash)`. Ticket TTL 15 minutes.

Drafts and tickets are swept **lazily** — any touch of an expired row marks it `expired` first. No cron.

---

## W0 — SDK v2 handshake spike (throwaway branch, never merged)

**Status:** **COMPLETE — GO. 2026-09-16.** All four D-28-2 clients completed `tools/list` **and** `echo` against SDK v2.0.0 on Express 4.22.2, from one `createMcpHandler` factory, with **no session shim and no per-client code**. I-28-A is now a fact: the three real clients speak **three different protocol revisions** and the SDK's dual-era routing served all of them unchanged. Branch `spike/mcp-w0` (one commit, `25cae29`: `routes/mcpSpike.js`, the three exact-pinned packages, the F-28-22 mount, a branch-local `MCP_SPIKE`/`MCP_SPIKE_TOKEN` in `.claude/launch.json`) was deleted after this commit; `main` gained only this status line and Appendix B. No product code, migration, dependency, env var, or deploy exists. Baseline for W1: backend suite **35 files / 831 tests** green on `main` after `npm ci` (F-28-15's "36" counted a helper file); `npm audit` on `main` = 14 (5 moderate / 7 high / 2 critical) — **all pre-existing, the SDK added none**.

**W0.7 — per client, as observed in the spike's per-request wire log (`MCP-Protocol-Version` header, `Mcp-Method`, `Mcp-Name`, `Mcp-Session-Id`, body `_meta` claim, factory `era`):**

| Client | Revision on the wire | `Mcp-Method` / `Mcp-Name` | Session | Handshake sequence seen | `tools/list` | `echo` |
|---|---|---|---|---|---|---|
| **Claude Code** 2.1.221 (CLI, `claude mcp list`) and 2.1.271 (desktop session, the tool call) — `ua=claude-code/…` | **2026-07-28** header **and** `_meta` envelope; `era=modern` | `Mcp-Method` on every request; `Mcp-Name: echo` on `tools/call` | none issued, none sent | `server/discover` → `subscriptions/listen` (SSE, **held open for the session**) → `tools/list` → `tools/call`. **No `initialize` at all.** | PASS | PASS (`echo: claude-code-w0`, run by the owner in a fresh desktop session, confirmed in the server log) |
| **MCP Inspector** 2.6.0 (`--cli`, transport http; `ua=node`) | **2025-11-25** — `initialize` carries it in the body, later requests in the header; `era=legacy` | neither | none issued; none sent | `initialize` → `notifications/initialized` (202) → `GET /mcp` for the old notification stream (**405, tolerated**) → `tools/list` → `tools/call` | PASS | PASS (`echo: inspector-w0`) |
| **Codex CLI** 0.144.6 (`codex exec`; **no `User-Agent` header at all**) | **2025-06-18** (body on `initialize`, header afterwards); `era=legacy` | neither | none issued; none sent | `initialize` → `notifications/initialized` → `tools/list` → `tools/call` | PASS | PASS (`echo: codex-w0`) — **after** `default_tools_approval_mode = "approve"` on the server entry; see gap below |
| **Hand-written 2025-11-25 client** (`fetch`, ~50 lines, no SDK) | 2025-11-25; `era=legacy` | neither | server never returned `Mcp-Session-Id` | `initialize` (negotiated `2025-11-25`) → `initialized` (202) → `tools/list` → `tools/call`; every response SSE-framed (`text/event-stream`, `x-accel-buffering: no` set by the SDK) | PASS | PASS — **served, not refused** |

Also proven on the branch: (a) **Node 20.20.2** — the same `mcpSpike.js` run inside `node:20-alpine` served the 2025 client and a modern envelope request identically (Docker is the only Node 20 on this machine; local dev is 22.14); (b) `/express` peer range accepts 4.22.2 (deduped, no second Express); (c) mount order per F-28-22 — `/mcp` with its own `express.json({ limit: '1mb' })` before the global 16 MB parser; `GET /mcp` → 405 before auth; no/wrong bearer → 401 + `WWW-Authenticate`; (d) **raw modern wire**: a `tools/call` with `MCP-Protocol-Version: 2026-07-28` + `Mcp-Method` + `Mcp-Name` but **no `_meta` envelope is rejected** `-32602` "missing the required per-request envelope key(s): _meta"; with `params._meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }` it returns 200 `application/json` with `resultType: "complete"`. Appendix B's bot example was wrong on this point and is corrected below.

**SDK v2 facts W1 must build on (read from the installed 2.0.0, not the docs):**
- The v2 entry is **`createMcpHandler(factory, { legacy: 'stateless' })` from `/server`, wrapped once by `toNodeHandler(handler)` from `/node`**, called as `(req, res, req.body)`. The `/express` README's `NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` example is the *legacy* idiom the stateless fallback constructs internally per request — do not wire it by hand.
- Era routing is **body-primary**: "modern" means `params._meta` carries the protocol-version and client-capabilities keys; headers are cross-checked (`-32020` on mismatch) but never establish the era. A modern version header without the envelope is a hard 400. Header-less, claim-less requests are legacy.
- `LATEST_PROTOCOL_VERSION` exported by `/server` is **`2025-11-25`** and `SUPPORTED_PROTOCOL_VERSIONS` is the **legacy list only** (`2025-11-25 … 2024-10-07`); 2026-07-28 lives in an internal `MODERN_WIRE_REVISION`. W1's `/api/health` `protocolVersions` field must therefore be `['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS]`, not the constant alone.
- `createMcpHandler` defaults: `legacy: 'stateless'`, `responseMode: 'auto'` (JSON unless a related message precedes the result), SSE `keepAliveMs: 15000` on every stream it serves — this **already satisfies F-28-14(b)'s 30 s keep-alive requirement** for Cloudflare's 100 s no-bytes cut-off; W2 still tests it through the public host.
- Claude Code opens **one `subscriptions/listen` SSE stream per session and holds it** for as long as the session lives. W1's per-token rate limiter and any "hung request" accounting must not count that stream as a stuck call, and `handler.close()` on SIGTERM (F-28-1: none exists today) is what ends them cleanly.
- `zod` 4.6.5 is present only as a hoisted transitive of `@anthropic-ai/sdk` and `@modelcontextprotocol/core`. The spike used `fromJsonSchema()` from `/server` for the tool input schema; W1 either keeps doing that or declares `zod` explicitly — never imports an undeclared dependency.
- The handler verifies nothing: the spike's bearer middleware set `req.auth = { token, clientId, scopes }` and the factory received it as `ctx.authInfo` (logged `principal=spike-owner`). That is the exact seam W1's `integration_tokens` verifier plugs into.

**Gaps named (none blocks go):**
- **Codex approval gate, not a wire gap.** Codex's first `echo` attempt never reached the server: its log shows `ResolveElicitation { request_id: "mcp_tool_call_approval_exec-…", decision: Cancel }` — every MCP tool call needs user approval by default, and non-interactive `codex exec` auto-cancels it (surfaced as "user cancelled MCP tool call"). Interactive Codex would have prompted. Fix is client-side config (Appendix B); nothing for the server. Also: `codex exec` reads stdin — run it with `< /dev/null` or it hangs.
- **Claude Code's tool call needed the owner.** A child `claude -p` inside a desktop session cannot authenticate (the CLI has no login of its own on this machine; auth is host-supplied per session) and a running session does not reload MCP config. Registration with `claude mcp add --transport http … --header "Authorization: Bearer …"` at project scope works; the call was made from a fresh desktop session and verified in the server log. W1's real-client gate should be run the same way.
- Inspector was exercised in `--cli` mode (same client library as the web UI's proxy); the web UI itself was not opened. Inspector 2.6.0 declares `engines.node >= 22.19` (local 22.14 ran it with a warning).
- One `node --watch` restart during the first curl batch dropped one request before it reached the router — a dev-server artifact, not reproducible, not the SDK.

**Goal.** Turn I-28-A into a fact before any Trippy code is written: does SDK v2 on Express 4.22 / Node 20 serve `tools/list` and one tool call to each of the four D-28-2 clients, and what protocol revision does each client actually send?

**Files (on branch `spike/mcp-w0`, deleted afterwards):** a scratch `backend/src/routes/mcpSpike.js` with one `echo` tool, a hard-coded header token, mounted only when `MCP_SPIKE=1`; `backend/package.json` gains the three SDK v2 packages **on the branch only**. Findings go into this plan's W0 status line — the branch is the *only* thing deleted.

**Steps.**
- W0.1 Add `@modelcontextprotocol/server@2.0.0`, `/node@2.0.0`, `/express@2.0.0` (exact pins). Confirm install on Node 20 and that `/express`'s peer range accepts 4.22.2 (F-28-16).
- W0.2 Scratch route: `POST /mcp` → `NodeStreamableHTTPServerTransport`, `GET/DELETE → 405`, `X-Accel-Buffering: no`. Log the inbound `MCP-Protocol-Version` (or its absence) per request.
- W0.3 Connect **MCP Inspector** (`npx @modelcontextprotocol/inspector`, transport Streamable HTTP, header `Authorization: Bearer <spike token>`): `tools/list`, call `echo`.
- W0.4 Connect **Claude Code**: `claude mcp add --transport http trippy-spike http://localhost:3002/mcp --header "Authorization: Bearer <spike token>"`; `/mcp` shows connected; call `echo` from a prompt.
- W0.5 Connect **Codex CLI**: add the server to `~/.codex/config.toml` (`[mcp_servers.trippy-spike]` with `url` and the bearer via the version's supported header/env mechanism — **the exact key names are read from the installed Codex version's documentation during the spike, not assumed here**); call `echo`.
- W0.6 Hand-written client on the 2025-era wire (a ~40-line script sending `initialize` then `tools/call` with `MCP-Protocol-Version: 2025-11-25`): is it served or refused? Record which.
- W0.7 Record per client: protocol revision sent, whether headers `Mcp-Method`/`Mcp-Name` were present, whether the stateless handler needed any session shim.

**Validation gate.** `tools/list` and `echo` succeed from Inspector, Claude Code, and Codex CLI. The 2025-era client is either served or the gap is named with the exact SDK behaviour observed. **Go/no-go:** if Claude Code or Codex CLI cannot complete a tool call on SDK v2, the plan stops here and the owner decides between the legacy SDK line (F-28-18's re-migration cost) and waiting — that is a new decision, not one this plan pre-empts.

**Rollback.** Delete the branch. Nothing merges.

**Deploy gate.** None. Local only.

**Markers.** None (no product code).

---

## W1 — Integration tokens + read tools

**Status:** NOT STARTED. Depends on W0 go.

**Goal.** A user can mint, see, and revoke personal tokens in the app; a token holder can list and read that user's trips over MCP; the endpoint is flag-gated and rate-limited; production is verified to pass `/mcp` through the tunnel unchanged.

**Files.** W1 migration (`integration_tokens`); `services/integrationTokens.js`; `routes/integrations.js` (`GET/POST /api/integrations/tokens`, `DELETE /api/integrations/tokens/:id`, behind `requireAuth`; admins list/revoke all — F-28-26); `routes/mcp.js`; `services/mcp/server.js`, `services/mcp/tools.js`; `middleware/rateLimit.js` (two new limiters); `routes/health.js`; `index.js` (mount before the JSON parser — F-28-22; `MCP_ENABLED`); `config.js` (`mcpEnabled`, `mcpPublicUrl`); `.env.example`; `package.json` (three exact-pinned SDK packages); frontend `IntegrationsPanel.jsx` + test, `UserAccountButton.jsx`, `integrationsApi.js`.

**Steps.**
- W1.1 Migration + `integrationTokens.js`: `createToken(userId, { name, scopes, expiresInDays|null })` → `{ token (plaintext, once), record }`; `listTokens(userId, { all: isAdmin })`; `revokeToken(userId, id, { isAdmin })`; `verifyToken(plaintext)` → constant-time compare of sha256 against `token_hash`, checks `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`, bumps `last_used_at` (throttled to once per minute to avoid a write per request), returns `{ id, userId, scopes, expiresAt }` or `null`. Scopes validated against `SCOPES = ['trips:read','trips:write','documents:write']` (**stamp D-28-6**).
- W1.2 `routes/integrations.js` + `integrationsApi.js`. Errors through `friendlyError` conventions (Plan 23).
- W1.3 `IntegrationsPanel.jsx` on `ModalShell` (I-28-1): list (name, prefix, scopes, created, expires, last used, revoke), create form (name, scope checkboxes, expiry choice — Q-28-1), one-time plaintext reveal with copy button and "you will not see this again" copy in the product voice. Tokens: DM Mono; section title: Playfair italic; gold used once (the new-token reveal). 375px first. New row in `UserAccountButton`'s modal opens it.
- W1.4 `routes/mcp.js`: `express.json({ limit: '1mb' })` local to the router; Origin check (absent → ok; present and ≠ `FRONTEND_URL` → 403); `requireBearerAuth` with a verifier that wraps W1.1 and returns `authInfo = { token, clientId: token.id, scopes, expiresAt, extra: { userId } }` (**stamp D-28-1**); per-request `NodeStreamableHTTPServerTransport`; `GET/DELETE → 405`; ignore `Mcp-Session-Id` / `Last-Event-ID`; `X-Accel-Buffering: no`; `mcpAuthMetadataRouter` serving `/.well-known/oauth-protected-resource` with `resource = MCP_PUBLIC_URL` and the three scopes. Mounted in `index.js` **before** the global JSON parser and only when `config.mcpEnabled`.
- W1.5 `services/mcp/server.js` (**stamp D-28-2**) + `tools.js`: `list_trips` (`listTripsForUser`, filter by `query` on title/destination city, `includePast` per Q-28-2) and `get_trip` (`getTripDetail`; `days` via the existing `deriveDayGeo` output; `bookings` via `listBookings` + attachment count). Scope check per tool → 403 shape. `userId` from `authInfo.extra` into `assert*Access` (**stamp D-28-7**).
- W1.6 Rate limits: `mcpTokenLimiter` 120 req/min keyed by token id (after verification); `mcpAnonLimiter` 30 req/min keyed by IP on the 401 path. Health: `mcp: { enabled, protocolVersions: [...] }` (F-28-23).
- W1.7 Tests: `tests/migration<NNN>.test.js` (ordered application on a copy DB; existing files unchanged), `tests/mcpTokens.test.js` (hash/verify, expiry, revoke → `null`, scope validation, admin-sees-all, non-admin-sees-own, `last_used_at` throttle), `tests/mcpTools.test.js` (tools/list schema snapshot; `list_trips`/`get_trip` shapes; **isolation: user B's token gets `not_found` for A's trip and for a trip A shares with C but not B**; collaborator B reads A's shared trip), `tests/mcpClient.e2e.test.js` (real `@modelcontextprotocol/client` against `routes/mcp.js` on a scratch app + ephemeral port — F-28-15: 401 without token, 403 wrong scope, 405 on GET, 403 on foreign Origin, successful `tools/list` + `list_trips`), frontend `IntegrationsPanel.test.jsx` (create reveals once, list renders prefix not token, revoke removes).

**Validation gates (all must pass).** `cd backend; npm test` green (baseline count recorded in this status line when the wave opens); `cd frontend; npm test` and `npm run build` green; `git diff --check` clean; **`MCP_ENABLED` unset → `POST /mcp` 404 and `/api/health.mcp.enabled === false`** (F-28-22 wording); browser check of the Integrations panel at 375px and desktop with a real created → copied → revoked token; **real Claude Code lists the owner's trips against the local dev server** (`.claude/launch.json` backend :3002).

**Rollback.** `MCP_ENABLED=0` (or unset) → route not mounted; the table is inert; the Integrations panel still works (it is `/api`, not `/mcp`). No data to restore.

**Deploy gate (per `.claude/skills/deploy/SKILL.md`).** Pre-flight green; `.env` on the server gains `MCP_ENABLED=1` and `MCP_PUBLIC_URL=https://trippy.zyroi.com/mcp` (owner sets, agent verifies via `/api/health`); pre-deploy DB backup taken with the host `sqlite3` into `~/Trippy/backups/`; migration applies at container start (watch logs for `_migrations` row); post-deploy: `curl -X POST https://trippy.zyroi.com/mcp` → 401 with `WWW-Authenticate` (**proves the tunnel passes `/mcp` and bot-protection did not challenge — F-28-14 (a)(d)**), `curl https://trippy.zyroi.com/.well-known/oauth-protected-resource` → JSON, `GET /mcp` → 405; owner runs Appendix A §A; **real Claude Code on the owner's machine lists the owner's trips against the public host**.

**Markers stamped.** D-28-1 (`routes/mcp.js`, `services/integrationTokens.js`), D-28-2 (`services/mcp/server.js`), D-28-6 (`services/integrationTokens.js`), D-28-7 (`services/mcp/tools.js`).

**Cost.** Zero paid calls. Read tools are DB-only (F-28-11).

---

## W2 — Durable drafts + apply on an existing trip

**Status:** NOT STARTED. Depends on W1 deployed.

**Goal.** `prepare_draft` / `apply_draft` / `get_apply_status` for a single booking on an existing trip, with the full issue-code list, a booking fingerprint, all-or-nothing resolve-then-write, idempotent retry, and progress that keeps Cloudflare's 100 s timer alive — proven through the public host.

**Files.** W2 migration (`mcp_drafts`); `services/mcp/drafts.js`, `validate.js`, `apply.js`; `services/mcp/tools.js` (register the three tools); `services/stops.js` (W2.2 split); `services/importer.js` (W2.1 export); `services/bookings.js` (expose a `writeBookingRow` that `createBooking` itself uses, so the MCP write phase inserts the same row shape).

**Steps.**
- W2.1 Export the warning rules from `importer.js` (F-28-8) as pure functions over `(tripRow, existingBookings, candidate)` — `computeWarnings` keeps calling them, so the importer's behaviour is pinned by its existing tests. Never copy.
- W2.2 Split `syncStopWithBooking` into `resolveBookingStopData(booking)` (Nominatim/Google/Unsplash, returns a plain object or `null` with a `reason` — `no_day_for_date` / `not_shown_in_itinerary`) and `writeBookingStop(resolved)` (synchronous DB write); `syncStopWithBooking` becomes `writeBookingStop(await resolveBookingStopData(b))`, so `createBooking`/`updateBooking` and every existing `stops`/`bookings` test are unchanged. D-25-1 (pin wins) lives in the resolve half and is preserved verbatim.
- W2.3 `validate.js`: `BookingInput[]` → `NormalizedBooking[]` + `Issue[]` + `plannedEffects[]` using the shared normalizers, the W2.1 rules, and the F-28-6 day lookup. `cost` → `cost_not_accepted` (**stamp D-28-9**). tz omitted → `timezone_unknown` info with `geo-tz`/IATA suggestion; wall-clock stored exactly as the UI stores it (**stamp D-28-10**).
- W2.4 `drafts.js`: `DRAFT_TTL_MS = 30 * 60 * 1000` (**stamp D-28-4**); `computeBookingFingerprint(tripId)` (§ Schema); `createDraft` honours `UNIQUE(user_id, idempotency_key)` → returns the existing draft for a seen key; `getDraftForUser` sweeps expiry lazily.
- W2.5 `apply.js`: load draft → assert `pending` → re-validate (blocker → `apply_refused`) → re-fingerprint (mismatch → `stale`) → **resolve phase** (per booking: `resolveBookingStopData`, `notifications/progress` after each, SSE keep-alive comment every 20 s while waiting, `AbortSignal` checked between bookings) → **one `db.transaction`**: insert bookings via the shared row writer, `writeBookingStop` per resolved stop, set draft `applied` + `result_json` + `applied_at` (**stamp D-28-3**). Any throw before the transaction leaves the draft `pending`; the transaction itself is milliseconds and never observes the abort signal. A second `apply_draft` on an `applied` draft returns `already_applied` with the stored `result_json`. `get_apply_status` reads the same row.
- W2.6 Tests: `tests/migration<NNN>.test.js`; `tests/mcpDrafts.test.js` — same key → same draft; apply twice → `already_applied` and **one** booking row; manual `createBooking` between prepare and apply → `stale`; blocker → `apply_refused`, nothing written; resolver throw on booking 2 of 2 → zero rows written, draft still `pending`, retry succeeds; `no_day_for_date` in `plannedEffects` and `stopId: null` + `stopReason` in the result; `timezone_unknown` is info and apply is allowed; `cost` present → blocker; user B cannot `apply_draft` A's draft (`not_found`). Extend `tests/mcpClient.e2e.test.js` with a full prepare → apply → status round trip and a **progress-notification assertion**. Existing `stops.test.js` / `bookings.test.js` must pass unchanged (W2.2 gate).

**Validation gates.** All suites green; `git diff --check`; local end-to-end from **real Claude Code**: paste a real hotel screenshot, the client interprets it, `prepare_draft` shows the preview, `apply_draft` creates a booking whose stop is visible on the right day in the PWA at 375px; **Cloudflare timing test after deploy** — an apply whose resolve phase is artificially held ≥ 120 s (dev-only env delay, or a hotel in a place that forces the full resolver ladder) completes through `https://trippy.zyroi.com/mcp` without a 524, i.e. the keep-alive works (F-28-14 (b)); **retry-after-timeout** — kill the client mid-apply after the progress for the last booking, call `get_apply_status`, receive the stored result.

**Rollback.** Flag off; drafts inert. W2.2 is behaviour-preserving for the app and covered by the existing suites, so it stays even if the flag goes off.

**Deploy gate.** Deploy skill in full; backup; migration watched; prod QA on the **dedicated verify trip** (a trip created for QA, then deleted from the UI afterwards — never the owner's live trips); Appendix A §B steps 1–6 by the owner.

**Markers stamped.** D-28-3 (`apply.js`), D-28-4 (`drafts.js`), D-28-9 and D-28-10 (`validate.js`).

**Cost.** Apply spends at most what the UI spends per booking: Nominatim ≤ 3 + Unsplash 1, from the **shared** in-process budgets (F-28-4). No AeroDataBox, no discovery generation, no Anthropic call anywhere on the MCP path.

---

## W3 — New trip, multi-booking, documents, delete

**Status:** NOT STARTED. Depends on W2 deployed.

**Goal.** A draft may target a **new** trip (client-supplied title/dates/destinations), carry N bookings applied all-or-nothing, hand back a one-time upload address for the original screenshot/PDF, and — as the sole destructive tool — preview and apply a booking deletion.

**Files.** W3 migration (`.js`: `mcp_upload_tickets`, `booking_attachments.content_hash` + `source`, backfill); `services/mcp/uploads.js`; `services/mcp/prepareDelete.js`; `services/mcp/validate.js` (`newTrip` branch); `services/mcp/apply.js` (createTrip-inside-txn, N bookings, delete kind, ticket issuance); `services/attachments.js` (`content_hash`/`source` on insert, `findAttachmentByHash`); `routes/mcp.js` (`PUT /mcp/uploads/:ticket` with `express.raw({ limit: '10mb', type: ['image/png','image/jpeg','image/webp','application/pdf'] })`); `services/mcp/tools.js` (`request_upload_ticket`, `prepare_delete`).

**Steps.**
- W3.1 `newTrip` validation (**stamp D-28-5**): title, `startDate ≤ endDate`, ≥ 1 destination with `city`; `outside_trip_dates` is *not* raised; `plannedEffects` computed against the *proposed* day range so `no_day_for_date` still surfaces when a booking falls outside the client-supplied dates. Apply: `createTrip(userId, …)` **inside** the outer transaction (F-28-12) so days exist before `writeBookingStop`; `createdTrip: true` in the result. Trippy never derives dates from a booking — if the client omits them, `new_trip_invalid`.
- W3.2 N bookings: resolve all, then one transaction (already the W2.5 shape — the change is only that `bookings.length > 1` is allowed and `multi_leg_detected` is raised). Progress notification per booking.
- W3.3 Migration + `attachments.js`: compute `content_hash` on every insert; `source` `'manual'` (UI), `'import'` (importer), `'mcp'` (tickets); backfill existing rows. `addAttachment` semantics (types, sizes, max 4) unchanged — the ticket path changes *how bytes arrive*, nothing else.
- W3.4 Tickets: `apply_draft` with `source.kind ∈ {screenshot, pdf}` and a `sha256` issues one ticket bound to `(bookingId of booking 0 — or the booking the client names via a `sourceBookingIndex` it may add to `source`, default 0)`, `expected_sha256`, `max_bytes` by media type, 15-min expiry → `sourceDocument: { status: "pending_upload", ticket }`. `source.kind = "email_text"` → `status: "unsupported"`, sha256 recorded on the draft only, **text never stored**. `source.kind = "manual"` → `not_requested`. `request_upload_ticket` issues a ticket for any booking the user can access (scope `documents:write`). `PUT /mcp/uploads/:ticket`: no bearer; ticket must be `pending` and unexpired; body length ≤ `max_bytes`; sha256 of body must equal `expected_sha256` else 422; if a `booking_attachments` row with that hash already exists on the booking → 200 with the existing attachment id (idempotent), else `addAttachment` with `source: 'mcp'` → 201; ticket → `used`. Max-4 rule still applies (→ 409 with a message). `get_apply_status.sourceDocument.status` flips to `saved`.
- W3.5 `prepare_delete` (**stamp D-28-8**; I-28-2): `assertBookingAccess`; load the `booking_required = 1` stop (effect `willDelete`) or a non-required linked stop (effect `willUnlink`); load linked expenses, mark `willDelete` for ids in `deleteExpenseIds` (validated exactly as `deleteBooking` validates them) and `willUnlink` otherwise, surface open repayments in `openRepayments` using the same aggregate `BookingDeleteReview` shows; fingerprint over booking + stop id + expense ids; draft `kind = 'delete'`. Apply: `deleteBooking(userId, bookingId, { deleteExpenseIds })` inside the draft transaction; stale if the fingerprint moved.
- W3.6 Tests: `tests/migration<NNN>.test.js` (backfill produces a hash for every pre-existing attachment; `source` defaults `'manual'`); `tests/mcpUploads.test.js` — ticket expiry → 410, size over → 413, hash mismatch → 422, same hash twice → same attachment id, fifth attachment → 409, `email_text` never stored (assert no BLOB and no text column anywhere), foreign ticket id → 404; `tests/mcpDrafts.test.js` additions — two-leg draft → 2 bookings + 2 stops or nothing (inject a resolver failure on leg 2 → zero rows); `newTrip` → trip + days + bookings + stops in one transaction, failure → no trip row; `newTrip` without dates → `new_trip_invalid`; `prepare_delete` default → expenses kept and unlinked, with ids → deleted; expense added after preview → `stale`; apply delete twice → `already_applied`; user B → `not_found`.

**Validation gates.** All suites green; `git diff --check`; local end-to-end from Claude Code: a two-leg flight screenshot → one draft → two bookings on the right days; then the host runs `curl -T shot.png -H "Content-Type: image/png" <uploadUrl>` and the image opens under the booking in **Logistics** in the PWA; the same `curl` again returns the same attachment id; `prepare_delete` on a QA booking with one linked cost shows `willUnlink`, apply leaves the cost visible in Expenses with no booking link.

**Rollback.** Flag off; tickets inert; the `content_hash`/`source` columns are additive and harmless.

**Deploy gate.** Deploy skill; backup (this migration rewrites every `booking_attachments` row's hash column — the backup is not optional); Appendix A §B steps 7–10 and §C by the owner **through the public host**, including the upload.

**Markers stamped.** D-28-5 (`validate.js`), D-28-8 (`prepareDelete.js`).

**Cost.** Per booking as W2; uploads are free; no new provider.

---

## W4 — OAuth 2.1 authorization server — **NOT PLANNED (D-28-1)**

**Status:** NOT PLANNED. Kept so the wave numbering in the recommendation survives. Reopened only if the owner wants a connector-only client (Claude.ai / Claude Desktop — F-28-19). If reopened it is its own plan: AS endpoints, PKCE, Client ID Metadata Documents + allowlist, refresh rotation, RFC 8707/9207, consent page, a security review before public exposure, and a separate `oauth_*` table set so the token list stays honest (recommendation §5.3).

---

## W5 — Hardening + docs

**Status:** NOT STARTED. Depends on W3 deployed.

**Goal.** Make the endpoint boring to operate: clean shutdown, secret-free logs, verified proxy behaviour, every marker stamped, every durable fact promoted out of this plan.

**Files.** `index.js` (keep the `http.Server` reference; `SIGTERM`/`SIGINT` → `server.close()` → `db.close()` → exit); `services/mcp/log.js` (one line per tool call: `ts, tokenPrefix, userId, tool, durationMs, outcome, draftId?` — never arguments, never bytes, never the token); `docs/ENGINEERING.md` (new "MCP" subsection under Current Architecture: in-process, flag, tokens-not-OAuth, tool list, "never add a model call on the MCP path", mount-order rule F-28-22); `docs/DECISIONS.md` (rows: I-28-1 and I-28-2 as adopted, the mount-order fact, the Cloudflare keep-alive requirement as a tested fact); `docs/superpowers/specs/2026-04-23-trippy-design.md` (one paragraph in the architecture section); this plan (final status).

**Steps.**
- W5.1 SIGTERM handler; test that an apply interrupted **before** its transaction leaves the draft `pending` and a retry after restart succeeds (restart the scratch server in the e2e test).
- W5.2 Structured tool log; test asserts the log line for a `prepare_draft` call contains the token prefix and no substring of the plaintext token or of any booking field.
- W5.3 Marker audit: run the ENGINEERING.md grep; every `D-28-n` in the table above resolves to one line in the named file.
- W5.4 Docs as listed; `git diff --check`.
- W5.5 Handoff: Appendix B refreshed with the exact client-config keys W0 verified.

**Validation gates.** Suites green; grep audit clean; restart test passes; log test passes; owner reads the ENGINEERING.md section and confirms it says nothing is shipped that is not.

**Rollback.** None needed (no behaviour change for clients).

**Deploy gate.** Deploy skill; final owner QA = re-run Appendix A §A1–A3 and §B1–B3 after the deploy (regression smoke), plus the **revocation** step (§A4) against production.

**Markers stamped.** None new — W5 verifies the ten already placed.

---

## Releases and sequencing

**Release 1 — W1 alone.** Carries a migration and the first public surface (`/mcp` 401s and the metadata document). It is the decision gate the recommendation asked for: if `/mcp` through the tunnel, the Integrations panel, and Claude Code listing trips all behave, W2 is authorised by that evidence; if not, nothing has been written that a flag cannot switch off.

**Release 2 — W2 alone.** Carries a migration, the stop-sync split (app-path change, behaviour-preserving), and the first write path. Its production QA includes the only timing test that cannot be run locally (Cloudflare 100 s).

**Release 3 — W3 alone.** Carries the `.js` migration that rewrites an existing table's rows (hash backfill) — it must not share a release with anything else, per the rule Plan 26 set for row-rewriting migrations.

**Release 4 — W5.** Docs and hardening; no migration.

Each release: plan status line updated, `DECISIONS.md` touched only if the wave settled something new, one commit per wave, deploy through the skill, owner click-script, then the next wave.

---

## Verification

- Backend: `cd backend; npm test` — record the plan-open baseline (files / tests) in W1's status line when the wave opens; every wave states its delta. The Windows teardown segfault after results print is not a failure (Plan 27 F-27-31).
- Frontend: `cd frontend; npm test` and `npm run build` — W1 is the only wave with frontend changes.
- Migrations: prove ordered application on a **copy** of the dev DB before each wave's first run (`tests/migration<NNN>.test.js` does it against a fresh DB; the copy run proves it against real rows — mandatory for W3's backfill).
- UI: Integrations panel at 375px first, then desktop. Use the Chrome extension against a logged-in localhost tab if the in-app Browser pane's cookie-mint auth 401s (known — memory `trippy-browser-qa-use-chrome-extension`).
- MCP: **never call a wave complete from a green suite.** Each wave's gate names the real client that must succeed (W1: Inspector + Claude Code; W2: Claude Code end-to-end + Cloudflare timing; W3: Claude Code + `curl` upload + Codex CLI at least once so D-28-2's fourth client is exercised before W5).
- Dev servers: `.claude/launch.json` entries `frontend` (:5174) and `backend` (:3002). Add `MCP_ENABLED=1` and `MCP_PUBLIC_URL=http://localhost:3002/mcp` to the **local** env when W1 starts (a launch.json/env change is part of W1, not of this planning session).
- Paid-provider caution: apply spends Nominatim/Unsplash. Use a booking whose stop is already cached where possible; never QA against a destination whose discovery catalogue is stale (opening Discovery is what bills Haiku — Plan 27's cost trap; the MCP itself never calls Anthropic).

## Real-client verification matrix

| Check | Client | Where | Wave |
|---|---|---|---|
| Connect, `tools/list`, `list_trips` | MCP Inspector | local, then public host | W1 |
| `claude mcp add --transport http trippy https://trippy.zyroi.com/mcp --header "Authorization: Bearer trp_…"` → `/mcp` connected → "list my trips" | Claude Code | public host | W1 |
| Codex CLI config → "list my trips" | Codex CLI | local (W0), public host | W1 (or W3 at latest) |
| Owner's bot: raw JSON-RPC `POST /mcp` with the bearer and the three required headers | script (`curl`) | public host | W1 |
| Screenshot → `prepare_draft` → `apply_draft` → booking + stop visible in PWA | Claude Code | local, then public host on the verify trip | W2 |
| Apply held ≥ 120 s completes, no 524 | `curl` / Inspector | **public host only** | W2 |
| Kill client after last progress → `get_apply_status` returns result; `apply_draft` again → `already_applied` | Claude Code or script | public host | W2 |
| Revoke token in panel → next call 401 | Claude Code | public host | W1, re-run W5 |
| Restart container mid-resolve → draft `pending`, retry succeeds | script + `docker compose restart` | **local docker or the server during a QA window only** | W5 |
| Account-B token → A's trip is `not_found`; A's draft is `not_found` | script with a second user's token | local (two test users), then public host with a second household account | W1, W2 |
| Two-leg screenshot → 2 bookings; `curl -T` upload → image in Logistics; second upload → same id | Claude Code + shell | public host | W3 |
| `prepare_delete` → apply → cost kept and unlinked | Claude Code | public host, verify trip | W3 |

## Cost

**W0, W1, W5 add no paid calls.** **W2/W3 apply** spends per booking exactly what the app spends when the user creates that booking by hand (Nominatim ≤ 3 requests, Unsplash 1), from the same in-process daily budgets — the MCP cannot exceed a ceiling the app respects. **No Anthropic call exists on the MCP path** — interpretation is the client's cost. Uploads are free. The SDK adds three dependencies and no runtime service.

---

## Appendix A — Owner production QA click-script

Standing convention: the agent verifies locally; the owner verifies production. Steps are grouped by the wave that ships them — run only the section for the release just deployed, plus §A as a smoke test on every later release.

**What actually changes for you, in three sentences.** Your Account modal gets an **Integrations** row where you create tokens for your own tools and revoke them. A tool holding a token can read your trips and — after showing you a preview — add bookings (and their itinerary stops), attach the original screenshot, or delete a booking. Nothing a tool does bypasses the same trip-membership rules the app already enforces.

**Things that look like bugs and are not — do not report:**
- A booking added by MCP with **no stop** on the map: the result told the client `no_day_for_date`; the booking's date is outside the trip's days (same as adding it by hand).
- A **missing time zone** on an MCP-added flight: allowed by D-28-10; the client was told and may fix it with an edit.
- A cost that survives deleting its booking: intended (I-28-2) unless the client explicitly asked to delete it.

### A — Integrations panel and read access (Release 1 / W1)

1. Trips Home → tap your initials → **Integrations**. **Expect** an empty list with a **New token** action, readable at 375px with no horizontal scroll.
2. **New token** → name `qa-phone`, tick `trips:read` only, expiry 30 days → create. **Expect** the full token shown **once** with a copy button and a warning it won't be shown again; after closing, the list shows the name, a prefix like `trp_ab12cd34…`, the scope, and no full token anywhere.
3. On your machine: `claude mcp add --transport http trippy https://trippy.zyroi.com/mcp --header "Authorization: Bearer <token>"`, then ask Claude Code to list your trips. **Expect** your real trip titles and dates. Ask it to add a booking. **Expect** a refusal that names the missing `trips:write` scope — not a crash, not a silent success.
4. Back in the panel, **Revoke** `qa-phone`. Ask Claude Code again. **Expect** an authentication failure on the very next call. **Report if** it still answers.
5. Create a second token with all three scopes and expiry **none**; keep it for §B/§C. Sign out and back in. **Expect** both tokens still listed (tokens are not sessions).

### B — Bookings end to end (Release 2 / W2, steps 1–6; Release 3 / W3, steps 7–10)

Use the **verify trip** (create one named `MCP QA` spanning any 3 days; delete it from the UI when done). Never a live trip.

1. Screenshot a real hotel confirmation you already have. In Claude Code: "add this to my MCP QA trip". **Expect** a preview *before* anything is written: hotel name, dates, any warnings, and "a stop will be created on <date>" or "no stop: date outside the trip".
2. Approve. **Expect** the booking in **Logistics** and, if the date is inside the trip, a stop on that day in **Plan** and **Map** at the hotel's location — same as if you had typed it.
3. Ask to add the **same** screenshot again. **Expect** the preview to warn `duplicate confirmation ref` (or `probable duplicate`) and, if you approve anyway, a second booking — the warning is advisory, exactly like the importer.
4. Ask to add a booking dated **outside** the trip. **Expect** the preview to refuse (`outside_trip_dates`) — for an existing trip that is a blocker.
5. Add a booking by hand in the app *between* a preview and its approval (prepare, then open the PWA and add any booking, then approve). **Expect** "stale — the trip changed, prepare again". **Report if** it applies.
6. Ask for the same apply twice in quick succession (or approve, wait, and say "apply it again"). **Expect** the second answer to say it was already applied and to show the *same* booking id — **not** a second booking.
7. *(W3)* Screenshot with **two flight legs**. **Expect** one preview listing two bookings, `multi-leg detected`, and after approval **two** bookings and their stops — or none at all if anything failed.
8. *(W3)* After a screenshot-based apply, the client is told to upload the file. **Expect** Claude Code to run a `curl` upload, then the screenshot to appear under that booking in **Logistics** (tap the booking → attachments). Ask it to upload again. **Expect** "already attached" and still one attachment.
9. *(W3)* "Create a new trip called `MCP New` from 2027-03-01 to 2027-03-04 in Osaka and add this hotel". **Expect** the trip on Trips Home with a route cover, its days, the booking, and its stop. Then try the same request **without dates**. **Expect** a refusal asking for dates — Trippy never guesses them (D-28-5).
10. *(W3)* Log a cost against a QA booking in **Expenses**. Ask Claude Code to delete that booking. **Expect** a preview that names the booking, its stop, and says the cost will be **kept and unlinked**. Approve. **Expect** the booking and stop gone, the cost still in Expenses with no booking link. **Report if** the cost vanished.

### C — Isolation (any release after W1)

1. From the second household account, create a token and connect a client. Ask for the first account's `MCP QA` trip by name and by id. **Expect** "not found" both ways — never "you don't have access" (existence must not leak). Share the trip with the second account as a collaborator; ask again. **Expect** it appears, and (W2+) that account can add a booking to it — collaborator parity (D-28-7).

### Known-and-accepted, do not report as bugs

- `GET https://trippy.zyroi.com/mcp` in a browser returns **405** (after W1) — the endpoint is POST-only by spec.
- Claude.ai / Claude Desktop's "add custom connector" **cannot** connect — they require OAuth, which is not built (D-28-1).
- Time-zone info notes on flights without a tz — see above.

---

## Appendix B — Client configuration reference (verified keys to be confirmed in W0)

**Claude Code**
```bash
claude mcp add --transport http trippy https://trippy.zyroi.com/mcp --header "Authorization: Bearer trp_…"
```

**MCP Inspector** — `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL `https://trippy.zyroi.com/mcp`, add header `Authorization: Bearer trp_…`.

**Codex CLI** — verified in W0 against **Codex 0.144.6** (keys are exactly what `codex mcp add … --url … --bearer-token-env-var …` wrote, and what `codex mcp get` reads back):
```toml
[mcp_servers.trippy]
url = "https://trippy.zyroi.com/mcp"
bearer_token_env_var = "TRIPPY_MCP_TOKEN"      # Codex reads the bearer from this env var at launch
default_tools_approval_mode = "approve"        # otherwise every tool call prompts; codex exec auto-cancels the prompt
```
`bearer_token_env_var` is the only bearer mechanism this version's `codex mcp add` offers; the same table also accepts `http_headers` / `env_http_headers` sub-tables (shown by `codex mcp get`). Accepted `default_tools_approval_mode` values, from the CLI's own parser: `auto`, `prompt`, `writes`, `approve`. Re-verify against `codex --version` when W5 refreshes this appendix.

**Owner's bot (raw)** — two working shapes, both verified in W0:
- *2025 wire (simplest — no envelope, no extra headers):* `POST https://trippy.zyroi.com/mcp` with `Authorization: Bearer trp_…`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, body `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_trips","arguments":{}}}`. No `initialize` is required by the stateless server (Codex and Inspector send one anyway; the spike's raw calls without it were served). Responses come back SSE-framed (`text/event-stream`, one `data:` line) — parse that, not bare JSON.
- *2026-07-28 wire:* the headers above plus `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: tools/call`, `Mcp-Name: list_trips`, **and** the body must carry the envelope: `"params":{"name":"list_trips","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`. Without `_meta` the server answers `-32602` (W0 finding). Responses are plain `application/json` with `resultType`.

Uploads (W3): `curl -T file.png -H "Content-Type: image/png" <uploadUrl>` — no bearer on the upload.
