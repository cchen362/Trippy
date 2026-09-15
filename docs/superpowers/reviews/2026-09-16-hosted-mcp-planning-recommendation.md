# Hosted Trippy MCP — planning recommendation

**Status: planning recommendation, 2026-09-16. Nothing in this document is shipped. No MCP endpoint, token table, draft table, migration, dependency, or deployment exists.** It reviews `docs/superpowers/reviews/2026-09-15-hosted-mcp-assessment.md` (committed locally as `8cfe009`, not pushed) against the checkout at `8cfe009`, the published MCP specification revision 2026-07-28, and the published TypeScript SDK v2.0.0. An implementation plan (Plan 28) may be written only after the owner decisions in §9 are settled. Live code and `docs/ENGINEERING.md` win if this document drifts.

Settled product boundary (owner, recorded in `docs/DECISIONS.md` → "Hosted MCP ownership"): Trippy-owned, client-independent, developed in this repo, never dependent on Edward; every connection maps to one Trippy user and sees only that user's owned/collaborated trips; business actions only; preview before any trip/booking write; client-side interpretation of screenshots with Trippy validating structured fields (no second model extraction); original screenshot/PDF retained when transferable, structured booking still saved otherwise with the result saying so; pasted email text is input, not an attachment.

---

## 1. Bottom line

**Proceed — as a phased plan with a decision gate after the first read-only release, not as one build.** The capability is real and most of the hard parts already exist in Trippy as patterns (`copilot_proposals` for preview/apply with a fingerprint, `applyProposal` for resolve-then-write atomicity, `booking_attachments` for evidence storage, `assertTripAccess` for membership). The genuinely new work is, in order of risk: **(1) a credential that is not a browser cookie, (2) a durable, idempotent draft/apply contract for bookings, (3) a file-transfer contract that never goes through a model, and (4) — only if the owner needs Claude.ai/Desktop-style connectors — a small OAuth 2.1 authorization server, which the SDK does not provide.**

In plain terms: you get "send a screenshot to your bot, review, approve, it lands in Trippy with the stop and the image" in three waves of work, using tokens you create in Trippy's settings. If you also want to add Trippy as a connector inside Claude.ai or Claude Desktop, that is a fourth wave of its own and roughly doubles the auth work.

---

## 2. Verified facts (current Trippy code at `8cfe009`)

Everything here was read from live code, not inferred.

| # | Fact | Where |
|---|---|---|
| F1 | One Express process, `app.set('trust proxy', 1)`, CORS pinned to `FRONTEND_URL`, `express.json({ limit: '16mb' })`, cookie auth only. No request-logging middleware, no SIGTERM/SIGINT handler, `app.listen` with no reference kept. | `backend/src/index.js` |
| F2 | Auth = 30-day opaque token in `auth_sessions`, httpOnly cookie, `secure: isProd`, `sameSite: 'lax'`. `requireAuth` reads **only** `req.cookies.auth_token`. No bearer path exists. | `services/auth.js`, `middleware/auth.js`, `routes/auth.js:13` |
| F3 | Membership = `owner_id` or a `trip_collaborators` row. The `role` column is stored (`'editor'` default) but **never checked** by `assertTripAccess`/`assertDayAccess`/`assertStopAccess`/`assertBookingAccess` — collaborators have full write parity with owners. | `services/trips.js:786-860`, `002_trips.sql` |
| F4 | Rate limiting exists only on `/api/auth` (`express-rate-limit` 8.x). | `middleware/rateLimit.js` |
| F5 | `createBooking` = validate (type+title only) → optional cost prepare → **one transaction** (booking + expense) → **then** `await syncStopWithBooking(row)` outside any transaction, which does Nominatim/Google/Unsplash I/O and then writes the stop. Booking and stop are **not** atomic today; a crash between them leaves a booking with no stop. | `services/bookings.js:111-170`, `services/stops.js:937-1057` |
| F6 | `inferBookingStop` creates a stop only if `show_in_itinerary` (default 1 for flight/hotel/train) **and** the trip has a `days` row for the booking's start date. Otherwise no stop, silently (`return null`). | `services/stops.js:687-723, 947-952` |
| F7 | `confirmArtifact` loops `createBooking` sequentially, then updates the artifact. Not atomic, not idempotent — a retry re-creates every booking. | `services/importer.js:352-397` |
| F8 | Import warnings computed server-side: `lowConfidence`, `duplicate` (same trip + type + case-insensitive `confirmation_ref`), `beforeTripStart`, `afterTripEnd`, `notTravelRelated`, `empty`. `computeWarnings` is **not exported**; `normalizeExtractedBooking` is. | `services/importer.js:172-216` |
| F9 | Attachments: PNG/JPEG/WebP ≤ 5 MB, PDF ≤ 10 MB, max 4 per booking, base64 JSON body, stored as BLOB. **No `content_hash` column** on `booking_attachments` (import files do have one). | `services/attachments.js`, `012_booking_attachments.sql`, `011_import_artifacts.sql` |
| F10 | `copilot_proposals` already models durable preview/apply: `trip_fingerprint`, `status pending|applied|rejected|stale|invalid`, `status_reason`, `resolved_by_user_id`. `applyProposal` = re-validate → re-fingerprint → **resolve phase (all external I/O) → one write transaction** including the status flip. `computeTripFingerprint` hashes days + stop ids/times/booking_ids — **not bookings themselves**. | `028_copilot_proposals.sql`, `services/copilotProposals.js:293-304, 484-548` |
| F11 | `createTrip` is one transaction (trip + days + scopes), requires title/startDate/endDate, seeds every day from chip #1 (Plan 9 D4). `listTripsForUser` and `getTripDetail` are DB-only — no provider calls. | `services/trips.js:913-997, 862-911, 1261` |
| F12 | Provider daily budgets (`discoveryResolverDailyRequestBudget`, `discoveryEscalationDailyBudget`, `discoveryReverifyDailyRequestBudget`, per-destination cap) are **in-memory per process, reset per UTC day**. | `config.js` comments, Plan 26 W2.3/W3.2/W3.3 |
| F13 | `better-sqlite3` 9.6.0 nests `db.transaction()` calls as savepoints: an inner service transaction rolls back with the outer one (proved with a throwaway script, 2026-09-16). | dependency behaviour |
| F14 | Highest applied migration is 032; the runner applies `.sql` and `.js` in name order into `_migrations`. Next free number: **033**. | `db/migrations/`, `db/migrations.js` |
| F15 | Production: Docker `node:20-alpine`, container port 3001 → host 6768, DB volume outside the container. A public HTTPS host `https://trippy.zyroi.com` is referenced by `.env.example` and the Plan 20 click-script; **how TLS terminates (which proxy, where) is not recorded anywhere in the repo.** | `Dockerfile`, `docker-compose.yml`, `.env.example`, `docs/superpowers/plans/2026-07-21-plan20-wave1-owner-click-script.md` |
| F16 | Backend tests: vitest, real SQLite in a temp dir with migrations, Anthropic SDK mocked. 36 test files. | `backend/tests/` |
| F17 | Express is 4.22.2 (`^4.19.2`); Node 20 in Docker. | `backend/package.json`, `node_modules/express/package.json`, `Dockerfile` |

### Verified external facts (official sources, fetched 2026-09-16)

| # | Fact | Source |
|---|---|---|
| X1 | Spec revision 2026-07-28 exists. Streamable HTTP now: single POST endpoint; **no `Mcp-Session-Id`, no GET stream, no `Last-Event-ID` resumability**; `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers are **required** and must match the body (`-32020 HeaderMismatch`); closing the SSE response stream **is** cancellation; `X-Accel-Buffering: no` recommended; a server MAY treat a header-less request as 2025-03-26; GET/DELETE from old clients → 405. | [Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) |
| X2 | Authorization is **OPTIONAL**; when supported over HTTP the server **SHOULD** conform. Conformance = OAuth 2.1 resource server: RFC 9728 protected-resource metadata (**MUST**), audience validation per RFC 8707 (**MUST**), 401 with `WWW-Authenticate` (+ `scope`), 403 `insufficient_scope`, PKCE, Client ID Metadata Documents (**SHOULD**), DCR deprecated-but-allowed. "MCP servers MUST NOT accept or transit any other tokens." | [Authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) |
| X3 | TypeScript SDK **v2.0.0** is the stable line for 2026-07-28: `@modelcontextprotocol/server`, `/node`, `/express` (peer `express ^4.18 || ^5`), all `engines.node >= 20`. Legacy `@modelcontextprotocol/sdk` is at 1.30.0, supported ≥ 6 months. | `npm view`, [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| X4 | v2 Streamable HTTP handler is **stateless per request** and, per its docs, "serves 2025-era clients statelessly from the same factory by default"; it validates **no** Host/Origin/token itself — verification goes in front and is passed in as `authInfo`. | [SDK v2 serving/http](https://ts.sdk.modelcontextprotocol.io/v2/serving/http) |
| X5 | v2 ships **resource-server helpers only** (`requireBearerAuth`, `OAuthTokenVerifier` = `verifyAccessToken(token) → { token, clientId, scopes, expiresAt }`, `mcpAuthMetadataRouter`). The **authorization-server** helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`) are frozen in `@modelcontextprotocol/server-legacy/auth`; the docs say "use a dedicated identity provider for new servers". | [SDK v2 serving/authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization), `@modelcontextprotocol/express` README |
| X6 | Client landscape: **Claude.ai / Claude Desktop custom connectors accept OAuth only — no static bearer header** (open issues #112, #411, #693 on `anthropics/claude-ai-mcp`). **Claude Code accepts `--header "Authorization: Bearer …"`** for HTTP servers. | [claude-ai-mcp #693](https://github.com/anthropics/claude-ai-mcp/issues/693), [#112](https://github.com/anthropics/claude-ai-mcp/issues/112), [MCP auth in Claude Code](https://www.truefoundry.com/blog/mcp-authentication-in-claude-code) |

---

## 3. Where the assessment needs correcting or sharpening

The 2026-09-15 assessment is factually sound on Trippy and on the spec. These are the places where the evidence changes the *weight* of what it says.

1. **"Compare in-process vs adjacent service" is not an open comparison — F12 decides it.** An adjacent process gets its own copy of every in-memory provider budget, so two processes can spend 2× the intended Nominatim/Google budget per day without either noticing. The only way to keep budgets honest in a second process is to move them into SQLite first — real work with no MCP benefit. In-process is the answer unless that refactor is done for other reasons.
2. **"A personal token … narrower interoperability story" understates the split.** X6 shows the actual line: agentic/CLI clients (Claude Code, Cursor, Inspector, scripts) accept a static bearer; the Claude.ai/Desktop connector UI does not. So "which clients must work in v1" *is* the auth decision, and it is the owner's to make (§9, D-1).
3. **"OAuth 2.1" is not a checkbox — X5 makes it a build.** The assessment lists OAuth as one of two options without noting that the SDK provides no authorization server. Conforming means Trippy hosts `/authorize`, `/token`, PKCE, refresh, client-ID-metadata-document fetching, RFC 8414 metadata, audience-bound tokens — or runs an external IdP for a single-household app. Estimated as its own wave (§10, W4).
4. **Booking + stop are already non-atomic today (F5), and the assessment's "one approval, several writes" point is bigger than it reads.** The fix is not MCP-specific glue; it is splitting `syncStopWithBooking` into a resolve half and a write half the way `stops.js` already does for `createStop` (`resolveCreateStopData` / `writeCreateStop`), so the MCP apply can run every external call first and then commit trip + bookings + stops + draft status in one savepoint-nested transaction (F13). The UI path can keep its current behaviour or adopt the split later — that is a scope choice, not a blocker.
5. **The existing fingerprint does not cover bookings (F10).** A draft fingerprinted with `computeTripFingerprint` would *not* go stale if the user added the same hotel by hand in the app between preview and apply. The MCP draft needs its own fingerprint over bookings (ids, type, confirmation ref, dates) plus the day list; do not widen the co-pilot's — its semantics are pinned by Plan 11 D3.
6. **The assessment's "at most four per booking / import artifacts also appear as documents" is right, but omits that `booking_attachments` has no content hash (F9).** Idempotent re-upload after a timeout ("did my image land?") needs one. Additive column in 033.
7. **Stop creation can silently not happen (F6).** A booking outside the trip's date range gets no stop and the UI never says so. The MCP result must report `stopId: null` with a reason (`no_day_for_date`), and the preview must show it *before* apply — this is exactly the `afterTripEnd`/`beforeTripStart` warning family (F8), promoted from "warning" to "planned effect".
8. **HTTPS is not an open question but the mechanism is unrecorded (F15).** `trippy.zyroi.com` exists. The plan needs the owner to state where TLS terminates and whether that proxy can (a) pass SSE unbuffered and (b) hold a request open ≥ 60 s for an apply that resolves locations and photos. Not a decision — a fact to collect.
9. **Collaborators are full editors (F3).** "A client can access only trips that user owns or collaborates on" is already what the code does; but note it means an MCP token for a collaborator can create bookings on the owner's trip, exactly like the UI. If the owner wants MCP to be owner-only, that is a *new* rule (§9, D-7).

---

## 4. Inferences (reasoned, not read from code)

- I1. The SDK v2 "serves 2025-era clients statelessly" claim is documented, not exercised here. Whether Claude Code's current build speaks 2026-07-28 or 2025-11-25 was not tested. The W0 spike exists to turn this into a fact.
- I2. `trust proxy 1` + a public HTTPS hostname implies a reverse proxy in front of the container on the Debian box. Which one, and its buffering/timeouts, is unknown.
- I3. A model-driven client will not upload bytes itself; the *client host* (Claude Code's shell, a script) will. Claude.ai connectors cannot make arbitrary HTTP calls, so document retention will in practice only work from agentic clients. This is a product expectation to set, not a Trippy defect.
- I4. Real-world screenshots of a return flight or a two-leg itinerary are common; a draft therefore carries **N** bookings, and "all-or-nothing" apply is the only shape that makes a blind retry safe.

---

## 5. Recommendations by area

Each follows: plain language → concrete example → implications → recommendation → technical detail.

### 5.1 Hosting: inside the existing Express service

**Plain language.** Add the MCP endpoint to the app that already runs, as one more route, instead of a second server.

**Example.** Your bot applies a hotel booking at 23:50 UTC. Location lookup spends 3 Nominatim requests from the same daily budget the Discovery tab uses. With a second process, that spend would come from a *second* invisible budget, and the Plan 26 ceilings would be quietly doubled.

**Implications.** Gain: one deploy, one DB handle, one set of provider counters, one health check, zero new infrastructure. Give up: process isolation — a runaway MCP request shares CPU with the PWA. Cost: near zero. Risk: low; the endpoint is stateless and behind the same error handler.

**Recommendation.** In-process at `POST /mcp` (not under `/api`, so the SPA fallback and cookie CORS rules stay untouched), enabled by an env flag so rollback is "flip the flag". Revisit an adjacent service only if budgets are moved into SQLite for other reasons.

**Technical.** `backend/src/routes/mcp.js` (thin: bearer verify → `NodeStreamableHTTPServerTransport` per request) + `backend/src/services/mcp/` (tool handlers calling existing services). `@modelcontextprotocol/express`'s `createMcpExpressApp` is *not* used — Trippy already has its app; only `requireBearerAuth`, `mcpAuthMetadataRouter`, and the `/node` transport are needed. Body parsing for `/mcp` gets its own `express.json({ limit: '1mb' })` — the 16 MB limit exists for base64 capture uploads (Plan 2A D2) and must not apply to a model-driven endpoint. `Origin`: absent for non-browser clients; if present it must equal `FRONTEND_URL` or the request gets 403 (X1).

### 5.2 Protocol: 2026-07-28 via SDK v2, stateless, older-era fallback delegated to the SDK

**Plain language.** Speak the newest protocol; let the library handle older clients; keep no per-connection memory on the server.

**Example.** Claude Code connects, sends `MCP-Protocol-Version: 2026-07-28`, calls `list_trips`, gets JSON back — no session id, nothing to clean up on restart. An older Inspector build that still sends `initialize` is answered from the same handler.

**Implications.** Gain: restart-safe by construction; horizontal-scale-ready though irrelevant here. Give up: server-initiated notifications (list_changed) — Trippy doesn't need them. Risk: I1 — the "older-era" claim is untested until W0.

**Recommendation.** Depend on `@modelcontextprotocol/server@2`, `/node@2`, `/express@2`. Pin exact versions. Do **not** start on the legacy 1.x line — it would be a migration within six months. W0 verifies the handshake with three real clients before any Trippy code is written.

**Technical.** GET/DELETE `/mcp` → 405. Ignore `Mcp-Session-Id` and `Last-Event-ID` if sent. Emit `X-Accel-Buffering: no` on SSE. Long tool (`apply_draft`) streams `notifications/progress` per booking so proxies see traffic; treat stream close as cancel *only during the resolve phase* — once the write transaction begins it runs to completion (it is milliseconds) and the result is readable via `get_apply_status`.

### 5.3 Authentication: staged — personal integration tokens first, OAuth 2.1 as its own wave

**Plain language.** Stage A: you create a token in Trippy's settings, paste it into your client once, and can revoke it in the same place. Stage B: the "Connect Trippy" browser flow that Claude.ai-style connectors need.

**Example.** Stage A: Settings → Integrations → "New token" → name "Edward-bot", scopes `trips:read trips:write documents:write`, expiry 90 days → shown once as `trp_…`. `claude mcp add --transport http trippy https://trippy.zyroi.com/mcp --header "Authorization: Bearer trp_…"`. Revoke → next call is 401 within one request. Stage B: in Claude.ai you add `https://trippy.zyroi.com/mcp`, a Trippy login page opens, you approve scopes, done.

**Implications.** Stage A: one migration table, one settings screen, ~a wave; works with Claude Code, Cursor, Inspector, any script; **does not** work with the Claude.ai/Desktop connector UI (X6); is a deliberate, documented deviation from the spec's SHOULD (X2) — Trippy is its own issuer and tokens are audience-bound to `/mcp` by construction. Stage B: Trippy must host a small OAuth 2.1 authorization server (X5): `/.well-known/oauth-authorization-server`, `/oauth/authorize` (reuses the existing login + a consent page), `/oauth/token` (code + PKCE, refresh), client registration via Client ID Metadata Documents with a pre-registered allowlist fallback, RFC 8707 `resource` check, RFC 9207 `iss`. Roughly one full wave, plus a security review. An external IdP (Keycloak/Auth0/…) is possible but adds a service and a bill for a one-household app.

**Recommendation.** Stage A in W1; RFC 9728 metadata served from day one (cheap, and it is what future clients look for). Stage B (W4) only if the owner answers D-1 with "Claude.ai/Desktop connector is a must". Do not build both token kinds into the same table column semantics — separate `integration_tokens` (Stage A) from `oauth_*` tables (Stage B) so revocation UIs stay honest.

**Technical — connection, revocation, identity, scope.**
- Table `integration_tokens(id, user_id FK, name, token_hash UNIQUE, token_prefix, scopes_json, created_at, expires_at, last_used_at, revoked_at)`. Plaintext shown once; `sha256` stored; prefix (first 8 chars) shown in the list for recognition. Verification = constant-time hash compare + `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)` → `authInfo = { clientId: token.id, scopes, expiresAt, extra: { userId } }`.
- Every tool handler receives `userId` from `authInfo` and calls the existing `assert*Access(userId, …)` helpers — never a raw query. Account isolation is therefore the same code path the UI uses (F3).
- Scopes: `trips:read` (list/get), `trips:write` (prepare/apply, includes trip creation), `documents:write` (tickets/attach). Missing scope → 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` (X2). No `trips:delete`, no collaborator or expense tools in v1.
- Rotation: create new → update client → revoke old. `SESSION_SECRET` is uninvolved. Admin users see all tokens; non-admins see their own.
- Rate limit `/mcp` per token (e.g. 120 req/min) and per IP on the 401 path.

### 5.4 Tool catalogue and boundaries

**Plain language.** Six tools: two to look, one to prepare, one to apply, one to hand over a file, one to ask "what happened to my apply".

**Example.** Bot: `list_trips({query:"Tokyo"})` → one trip. `prepare_draft({tripId, bookings:[hotel…], source:{kind:"screenshot", sha256}})` → `draftId`, issues: `[{severity:"warning", code:"duplicate_confirmation_ref", existingBookingId}]`, `plannedEffects: [{bookingIndex:0, stop:{willCreate:true, date:"2026-11-03"}}]`. User approves. `apply_draft({draftId})` → `bookings:[{bookingId, stopId, url}]`, `sourceDocument:{status:"pending_upload", ticket:{uploadUrl, expiresAt}}`. Host runs one `curl -T shot.png`. Bot: `get_apply_status({draftId})` → `sourceDocument.status:"saved"`.

**Implications.** Gain: a model cannot write without a preview record existing first; every write is replayable by id. Give up: nothing the UI has — stop editing, discovery grounding, expenses stay out of v1 by design.

**Recommendation.** Exactly this catalogue for v1; each tool returns `structuredContent` plus a short text summary. Trippy URLs (`/trips/:id`, `/trips/:id/logistics`) in every write result.

| Tool | Scope | Input (exact) | Output (exact) | Side effects |
|---|---|---|---|---|
| `list_trips` | `trips:read` | `{ query?: string, includePast?: boolean }` | `{ trips: [{ id, title, startDate, endDate, status, destinations: [{city, countryCode}], url }] }` | none (F11) |
| `get_trip` | `trips:read` | `{ tripId, include?: ("days"\|"bookings")[] }` | `{ trip, days?: [{ id, date, resolvedCity, resolvedCountry, stopCount }], bookings?: [{ id, type, title, confirmationRef, startDatetime, endDatetime, origin, destination, originTz, destinationTz, documentCount, url }] }` | none |
| `prepare_draft` | `trips:write` | `{ idempotencyKey, target: { tripId } \| { newTrip: { title, startDate, endDate, destinations: [{city, countryCode?}] } }, bookings: [BookingInput], source: { kind: "screenshot"\|"pdf"\|"email_text"\|"manual", sha256?, mediaType?, sizeBytes? } }` | `{ draftId, expiresAt, target, bookings: [NormalizedBooking], issues: [Issue], plannedEffects: [{ bookingIndex, stop: { willCreate, date, reason? } }], applyAllowed: boolean, summary: string }` | inserts `mcp_drafts` row |
| `apply_draft` | `trips:write` | `{ draftId }` | `{ status: "applied"\|"already_applied", tripId, tripUrl, createdTrip: boolean, bookings: [{ bookingIndex, bookingId, stopId\|null, stopReason?, url }], sourceDocument: { status: "not_requested"\|"pending_upload"\|"saved"\|"failed"\|"unsupported", ticket?: {uploadUrl, expiresAt, maxBytes, requiredSha256} } }` | trip/bookings/stops/draft flip in one txn; provider I/O in resolve phase |
| `request_upload_ticket` | `documents:write` | `{ bookingId, mediaType, sizeBytes, sha256 }` | `{ ticket: { uploadUrl, expiresAt, maxBytes } }` | inserts `mcp_upload_tickets` row |
| `get_apply_status` | `trips:read` | `{ draftId } \| { idempotencyKey }` | same shape as `apply_draft` output plus `draftStatus` | none |

`BookingInput` = the existing `createBooking` payload minus `cost` (`type, title, confirmationRef, bookingSource, startDatetime, endDatetime, origin, destination, terminalOrStation, originTz, destinationTz, detailsJson, showInItinerary`). `Issue` = `{ severity: "blocker"\|"warning"\|"info", code, bookingIndex?, field?, message, suggestion? }`. `applyAllowed=false` whenever a blocker exists; `apply_draft` re-checks and refuses with 422.

Validation is deterministic, reusing `normalizeExtractedBooking`'s datetime/tz normalizers and the F8 warning logic (exported, not copied). Issue codes for v1: `missing_required_field` (per type: flight needs title+start+origin+destination; hotel needs title+start+end+destination; train like flight), `invalid_datetime`, `invalid_timezone`, `timezone_unknown` (info; suggest from `geo-tz` when a resolvable place exists — already a dependency), `end_before_start`, `outside_trip_dates` (blocker for existing trip unless `newTrip`), `duplicate_confirmation_ref` (F8 rule), `probable_duplicate` (same trip + type + start date + origin/destination, case-folded), `source_already_attached` (sha256 already on a booking in this trip), `multi_leg_detected` (info: ≥2 bookings of the same type and confirmation ref), `no_day_for_date` (stop will not be created — F6).

### 5.5 Durable drafts: yes

**Plain language.** The preview is a saved record with an expiry, not a number the bot remembers.

**Example.** Preview at 10:00, phone dies, bot restarts, user says "apply it" at 10:20 → `apply_draft` still works; at 10:45 it says "expired, prepare again". Meanwhile the user added the same hotel by hand at 10:10 → apply says "stale: the trip changed; prepare again".

**Implications.** One table, one lazy sweep. Without it, idempotency and "what happened after the timeout" are impossible.

**Recommendation.** `mcp_drafts(id, user_id, token_id, idempotency_key, target_json, bookings_json, issues_json, planned_effects_json, source_json, trip_id NULLABLE, booking_fingerprint, status pending|applied|expired|stale|invalid|rejected, status_reason, result_json, created_at, expires_at, applied_at)`, `UNIQUE(user_id, idempotency_key)`. TTL 30 minutes (D-4). `booking_fingerprint` = sha256 over the target trip's day dates + bookings `(id, type, confirmation_ref, start_datetime, end_datetime, origin, destination)`; `NULL` for `newTrip` targets. Audit: `token_id` names which integration wrote, `user_id` which person, `result_json` what was created.

### 5.6 Atomicity and idempotency

**Plain language.** Everything one approval implies happens together or not at all, and asking twice never creates twice.

**Example.** A two-leg flight screenshot → one draft with two bookings. Apply: resolve both stop locations and photos first (network), then one transaction inserts 2 bookings + 2 stops + flips the draft. Nominatim times out on leg 2 during resolve → nothing is written, draft stays `pending`, the bot retries the same `apply_draft` cleanly. Connection drops *after* the transaction → retry returns `already_applied` with the identical result.

**Implications.** Requires splitting `syncStopWithBooking` into resolve/write halves (a ~half-day refactor with tests; the UI path stays behaviourally identical). Gain: safe blind retry, no orphan bookings. Give up: per-booking partial success (D-3).

**Recommendation.**
- *Trip + bookings*: `createTrip` (already a txn) called **inside** the outer apply txn (F13) — days exist before stops are computed.
- *Multi-booking*: all-or-nothing per draft.
- *Booking + stop*: resolve phase → single txn; `stopId: null` + reason when F6 says no day.
- *Booking + document*: **not** in the same unit. Bytes arrive later, from the host; the result says `pending_upload`, and a ticket bound to `(bookingId, sha256, maxBytes)` makes the upload itself idempotent (same sha256 already attached → 200 with the existing attachment id, not a duplicate).
- *Timeout after dispatch*: the draft status flip is in the transaction; `get_apply_status` or a repeated `apply_draft` returns the stored `result_json`. `prepare_draft` with a seen `idempotencyKey` returns the existing draft.

### 5.7 Reuse of Trippy services and the rules they carry

**Plain language.** The MCP calls the same functions the app calls, so every existing rule applies automatically.

**Example.** A hotel booking applied via MCP goes through `syncStopWithBooking`'s resolver, so if the user later pins that stop, D-25-1 (pin wins silently) holds exactly as it does for the app.

**Recommendation and how each rule is preserved.**
- *Membership*: only `assert*Access(userId, …)` (F3).
- *Geography*: untouched — the five-layer ladder (D-6/8/9, D-26-2) runs on read; a hotel booking becomes layer 2 as today.
- *Discovery provenance*: no discovery tool in v1; nothing writes `discovery_*`. A future `add_stop` tool must reuse `copilotProposals`' grounded-place path, never accept a `verified` claim (assessment already says so).
- *Booking-linked stop*: created via the same inference (F6); `booking_required=1`; co-pilot's Plan 11 D6 guard continues to protect it.
- *Attachments*: `addAttachment` semantics (types, sizes, max 4) reused; the ticket path only changes *how bytes arrive*.
- *Cost*: read tools are DB-only (F11). Apply spends at most what the UI spends per booking (Nominatim ≤ 3 + Unsplash 1). No AeroDataBox, no discovery generation, no Anthropic call anywhere on the MCP path. In-process keeps budgets shared (F12).
- *Expenses*: `cost` is stripped from `BookingInput` in v1 (D-9).

### 5.8 File transfer: short-lived upload tickets (chosen) vs a plain authenticated endpoint

**Plain language.** After the booking exists, Trippy hands back a one-time upload address; the host uploads the file there. No base64 through the model, ever.

**Example.** `apply_draft` returns `uploadUrl: https://trippy.zyroi.com/mcp/uploads/tk_…`, valid 15 min, expects sha256 `ab12…`, ≤ 5 MB. Claude Code runs `curl -T hotel.png -H "Content-Type: image/png" <uploadUrl>`. Trippy verifies hash and size, stores via `addAttachment`, marks the ticket used. Same command run twice → second returns the same attachment id.

**Comparison.**

| | (A) `PUT /api/mcp/bookings/:id/source` with the bearer | (B) single-use ticket URL, no bearer |
|---|---|---|
| Who holds the secret at upload time | the host shell must know the bearer — often it is in the client's config, **not** available to the agent running `curl` | the ticket is in the tool result the agent already has |
| Blast radius if leaked | full token | one booking, one hash, 15 minutes |
| Idempotency | needs hash in a header + dedupe | hash is bound at ticket creation; dedupe is intrinsic |
| Complexity | lower (no table) | one small table + sweep |
| Works from non-agentic clients | no | no (I3) |

**Recommendation.** (B). It is the only shape that does not require exposing the long-lived token to whatever executes the upload. `mcp_upload_tickets(id, user_id, token_id, booking_id, expected_sha256, media_type, max_bytes, status pending|used|expired, created_at, expires_at, used_at, attachment_id)`. Raw-body route (`express.raw`, limit 10 MB), no JSON, no base64. `booking_attachments` gains `content_hash` and `source ('manual'|'import'|'mcp')` (additive). Pasted email text: `source.kind = "email_text"` recorded on the draft with a sha256 only — never stored.

### 5.9 Schema and migrations

One additive migration per wave that needs it; never edit 001–032.

- **033 (W1)**: `integration_tokens` + index on `user_id`.
- **034 (W2)**: `mcp_drafts` + `UNIQUE(user_id, idempotency_key)` + index on `(status, expires_at)`.
- **035 (W3)**: `mcp_upload_tickets`; `ALTER TABLE booking_attachments ADD COLUMN content_hash TEXT`; `ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`; backfill hash for existing rows in the same migration (`.js`, loops rows, SHA-256 of `content`).
- **036 (W4, conditional)**: `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens` (access + refresh, hashed, audience, scopes).

Numbers 034–036 are relative; if waves ship in a different order the *next free number at merge time* is used — the rule is "next free", not "these exact numbers".

### 5.10 Operational requirements

- **HTTPS/proxy**: owner records how `trippy.zyroi.com` terminates TLS (F15). Plan gate: proxy passes `text/event-stream` unbuffered (`X-Accel-Buffering: no` honoured or equivalent), read timeout ≥ 120 s on `/mcp`, body limit ≥ 10 MB on `/mcp/uploads/*`, and forwards `Authorization`.
- **Request limits**: `/mcp` JSON 1 MB; uploads 10 MB raw; per-token 120 req/min; per-IP 30 unauthenticated/min.
- **Logs without secrets**: one line per tool call — `ts, tokenPrefix, userId, tool, durationMs, outcome, draftId?` — never arguments, never bytes, never the token. Errors ≥ 500 through the existing `errorHandler`.
- **Startup/shutdown**: nothing to warm. Add a `SIGTERM` handler (keep the `http.Server` reference, `server.close()`, then `db.close()`) — absent today (F1) and worth having regardless; an in-flight apply that has not reached its transaction simply leaves the draft `pending`.
- **Health**: extend `/api/health` with `mcp: { enabled, protocolVersions: ["2026-07-28", …] }`.
- **Credential rotation**: token UI (5.3); OAuth refresh rotation in W4.
- **Cancellation**: stream close cancels during resolve (check an `AbortSignal` between bookings); never mid-transaction.
- **Recovery after restart**: stateless transport + durable drafts/tickets → no recovery step. Lazy sweep marks expired drafts/tickets on next touch; a daily sweep is optional.
- **Env**: `MCP_ENABLED=1`, `MCP_PUBLIC_URL=https://trippy.zyroi.com/mcp` (the RFC 8707 audience/canonical URI; must be exact, no trailing slash).

---

## 6. Initial authorization design (summary)

| Question | v1 answer |
|---|---|
| What identifies a connection | one `integration_tokens` row (name, prefix, scopes, expiry) |
| Who is the actor | `integration_tokens.user_id`; all access via `assert*Access` |
| What can the actor reach | every trip the user owns or collaborates on (F3) — D-7 asks whether to narrow |
| What can the actor do | only what the token's scopes allow, only through the six tools |
| What is never exposed | delete trip/booking/stop, collaborators, expenses, share links, discovery generation, co-pilot, admin/invite endpoints, raw SQL, generic HTTP |
| How is it stopped | revoke in settings → 401 on the next request; expiry; admin can revoke any |
| What is recorded | `token_id` + `user_id` on drafts and tickets; `last_used_at` on tokens |

---

## 7. Architecture chosen and alternatives considered

**Chosen.** Client → `https://trippy.zyroi.com/mcp` (Express route, SDK v2 stateless transport) → bearer verifier → tool handlers in `services/mcp/` → existing services → SQLite. Uploads → `/mcp/uploads/:ticket` raw body → `addAttachment`.

**Rejected.**
- *Adjacent service sharing the domain layer* — F12 (budget duplication) and a second SQLite writer/process for no isolation the household needs.
- *Legacy SDK 1.x* — would need re-migration inside its support window.
- *Reusing the browser cookie or `auth_sessions`* — cookie is `sameSite: lax`, browser-shaped, 30-day, not scoped; conflates revocation of a bot with logging out a person.
- *Base64 documents in tool arguments* — model cost, corruption risk, 5–10 MB through an LLM context; assessment already rejects it.
- *Reusing `import_artifacts` + `confirmArtifact` as the MCP write path* — F7: sequential, non-atomic, non-idempotent, and it pays for a model extraction the client already did.
- *Direct `createBooking` as an MCP tool* — no preview, no fingerprint, no retry safety; violates the settled "preview before write" boundary.

---

## 8. Proposed implementation-plan structure (Plan 28 — to be written after §9 is settled)

| Wave | Scope | Depends on | Validation (must pass) | Rollback | Deploy gate |
|---|---|---|---|---|---|
| **W0 Spike** (throwaway branch, not merged) | SDK v2 + Express 4.22 handshake in a scratch route; header-token auth; three clients: MCP Inspector, Claude Code, one hand-written client on the 2025-11-25 era | — | `tools/list` and one tool call succeed from all three; 2025-era client is served or the gap is named | delete branch | none — produces the go/no-go on SDK v2 and the era question (I1) |
| **W1 Tokens + read tools** | migration 033; settings → Integrations UI (create/revoke/list, 375px first); `requireBearerAuth` verifier; `/mcp` with `list_trips`, `get_trip`; RFC 9728 metadata; per-token rate limit; `MCP_ENABLED` flag; health field | W0 | unit: hash/verify, expiry, revoke→401, scope 403 shape; isolation: user B's token cannot read A's trip (404) or a shared trip A is not on; tools/list schema snapshot; real Claude Code lists the owner's trips on prod | `MCP_ENABLED=0` → 404; table is inert | tests green; `git diff --check`; owner click-script for the settings page; backup per deploy skill |
| **W2 Drafts + apply (existing trip)** | migration 034; `prepare_draft`, `apply_draft`, `get_apply_status`; validation issue codes; booking fingerprint; `syncStopWithBooking` resolve/write split; progress notifications | W1 | idempotent prepare (same key → same draft); apply twice → `already_applied`, one booking; stale after manual booking add; blocker refuses apply; resolve-phase failure writes nothing; `no_day_for_date` reported; real screenshot end-to-end via Claude Code creates booking + stop visible in the PWA | flag off; drafts inert; stop-sync split is behaviour-preserving (covered by existing `stops`/`bookings` tests) | plus: prod QA on a dedicated verify trip, then delete via UI |
| **W3 New trip, multi-booking, documents** | migration 035; `newTrip` target (client supplies title/dates/destinations — Trippy never infers a trip from one booking); N-booking all-or-nothing; `request_upload_ticket`; `/mcp/uploads/:ticket`; `sourceDocument` reporting; attachment hash dedupe | W2 | two-leg draft → 2 bookings + 2 stops or nothing; ticket expiry/size/hash mismatch rejected; re-upload same hash → same attachment; email_text never stored; document visible under the booking in Logistics | flag off; tickets inert | owner verifies the image opens in the PWA |
| **W4 OAuth 2.1** (conditional on D-1) | migration 036; AS endpoints, PKCE, CIMD + allowlist, refresh rotation, RFC 8707/9207; consent page; token list shows OAuth grants alongside PITs | W1 | conformance checklist from X2; Claude.ai custom connector connects, lists, prepares, applies; revocation from settings kills the grant | keep PIT path; disable AS routes | security review of the AS before public exposure |
| **W5 Hardening + docs** | SIGTERM handler; structured tool logs; proxy timeouts verified; `D-28-n` markers; `DECISIONS.md` rows; ENGINEERING.md "MCP" section; handoff click-script | W3 (and W4 if built) | restart mid-apply leaves draft pending and retry succeeds; logs contain no token/args | — | final owner QA |

Each wave ends with the plan status line updated and a commit. Test files: `tests/mcpTokens.test.js`, `tests/mcpTools.test.js`, `tests/mcpDrafts.test.js`, `tests/mcpUploads.test.js`, `tests/migration033.test.js` (+034/035), and a `tests/mcpClient.e2e.test.js` that drives the real SDK client against the Express app in-process.

---

## 9. Open owner decisions (concrete choices)

Answer these before Plan 28 is written. Recommended option first.

- **D-1 Auth stage.** (a) **Personal integration tokens in W1, OAuth 2.1 as conditional W4** — recommended; the owner's bot scenario works on day one, OAuth is bought only if needed. (b) OAuth 2.1 in v1 — needed only if the Claude.ai/Desktop connector is a must-have from the start (X6); adds a wave before anything ships. (c) Tokens only, never OAuth — fine until a connector-only client matters.
- **D-2 Must-work clients for v1.** (a) **Claude Code + MCP Inspector + scripts** — recommended, matches D-1(a). (b) Also Claude.ai / Claude Desktop connector — forces D-1(b).
- **D-3 Multi-booking apply.** (a) **All-or-nothing per draft** — recommended; retry safety and one result. (b) Per-booking partial success with per-item status — more code, ambiguous retries.
- **D-4 Draft TTL.** (a) **30 minutes** — recommended; a review is a short conversation. (b) 24 hours — friendlier to "approve later", more stale-state surprises.
- **D-5 New trip from one booking.** (a) **Client must supply title, dates, destinations; Trippy validates and never infers the range** — recommended (assessment and Plan 9 D4 agree). (b) Trippy proposes a range from the booking(s) as a pre-filled suggestion the client must echo back — helpful, slightly more surface.
- **D-6 Scopes.** (a) **Three coarse scopes** (`trips:read`, `trips:write`, `documents:write`) — recommended. (b) Add a per-token trip allowlist — real isolation for a shared household account, more UI.
- **D-7 Collaborator parity.** (a) **Same as the UI: a collaborator's token can write on shared trips** (F3) — recommended; no new rule. (b) MCP writes owner-only — new rule that the UI does not have; would need a marker and a DECISIONS row.
- **D-8 Destructive tools.** (a) **None in v1** — recommended; the assessment agrees. (b) Include `delete_booking` for bookings the token created — convenient, larger blast radius.
- **D-9 Cost/expense on booking drafts.** (a) **Out of v1** — recommended; expenses store is per-route by Plan 20 and FX costs time. (b) Accept `cost` and route through `prepareExpenseCreate` — reuse exists, adds FX latency to apply.
- **D-10 Time-zone handling when the client omits tz.** (a) **Accept, flag `timezone_unknown` as info, suggest via `geo-tz` when a place resolves, store NULL** — recommended; matches how the UI treats tz today. (b) Make tz a blocker for flights — stricter data, more friction.

Facts to collect (not decisions): how `trippy.zyroi.com` terminates TLS and what its SSE/timeout/body-size behaviour is (F15, 5.10).

---

## 10. Sources

- MCP spec 2026-07-28 — [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- TypeScript SDK v2 — [repository](https://github.com/modelcontextprotocol/typescript-sdk), [serving over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http), [authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization); `npm view @modelcontextprotocol/{server,node,express}@2.0.0`, `@modelcontextprotocol/sdk@1.30.0` (2026-09-16)
- Client auth support — [anthropics/claude-ai-mcp #693](https://github.com/anthropics/claude-ai-mcp/issues/693), [#411](https://github.com/anthropics/claude-ai-mcp/issues/411), [#112](https://github.com/anthropics/claude-ai-mcp/issues/112), [MCP authentication in Claude Code](https://www.truefoundry.com/blog/mcp-authentication-in-claude-code)
- Trippy — files cited per fact in §2; `docs/ENGINEERING.md`; `docs/DECISIONS.md`
