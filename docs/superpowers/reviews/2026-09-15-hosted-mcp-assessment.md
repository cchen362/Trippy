# Hosted Trippy MCP assessment

**Status: advisory assessment, 2026-09-15. Not an implementation plan or a claim that MCP is shipped.** Based on the local Trippy checkout at `07362f9` and the official MCP 2026-07-28 transport and authorization specifications linked below. No running MCP endpoint, third-party client handshake, production configuration, or external account was tested. Live code and `docs/ENGINEERING.md` take precedence if this assessment drifts.

## Purpose and boundary

Trippy should offer a hosted MCP service as a Trippy-owned external interface. Any compatible, authorized client should be able to find trips and perform approved travel actions; the service must not know or depend on Edward. A client acting for one Trippy user sees only the trips that user can access. Hosting an MCP endpoint does not make private trips public or grant another person access to the owner's data.

The owner wants a client to handle a common scenario: receive a screenshot of a flight or hotel booking, interpret its contents, show a reviewable draft, then create a booking in an existing trip or create a trip and add the booking. The original screenshot should remain with the booking when the client can transfer it. Pasted email text is input for interpreting a booking and need not be retained as a Trippy attachment. The client's choice of model, image handling, and approval UI belong to that client; Trippy owns validation, authorization, writes, and the resulting state.

For example, a client receives a hotel screenshot and asks Trippy which Tokyo trip is available. It proposes a stay with dates, address, and confirmation reference. Trippy identifies missing or conflicting fields and an apparent duplicate. The user reviews the proposal. Only an approved apply call saves the booking; a successful result names the booking and whether its image was attached. If no trip exists, the client can first prepare a new trip, but a single hotel or flight does not necessarily establish the whole trip's dates and destinations.

This is separate from every client's ability to connect to remote MCP. Trippy should be testable with a generic MCP client. A particular client may need client-side transport, authentication, file-access, and approval work; Trippy must supply the corresponding interoperable server contracts, not client-specific code.

## Verified Trippy baseline

| Area | Shipped behavior | Consequence for MCP |
|---|---|---|
| Hosting | Express mounts `/api` routes; production builds the frontend and runs the app in Docker (`backend/src/index.js`, `docker-compose.yml`). | A hosted Streamable HTTP endpoint can be deployed with Trippy. Whether it lives in the existing process or an adjacent service needs a lifecycle and isolation comparison. |
| Accounts | Login issues a 30-day opaque browser session in an httpOnly cookie; trip/day/stop/booking helpers check owner or collaborator membership (`backend/src/services/auth.js`, `middleware/auth.js`, `services/trips.js`). | External MCP needs an integration credential mapped to a real Trippy user, revocable without reusing a browser cookie. Existing object-access checks remain mandatory. |
| Trips | `createTrip` requires title and dates, creates days, and seeds destination scopes; `getTripDetail` and trip listing expose current state (`services/trips.js`, `routes/trips.js`). | The client can look up an existing trip or prepare a new one. Do not invent a complete itinerary from one booking. |
| Bookings | `createBooking` writes structured fields and calls `syncStopWithBooking`; importer accepts text, images, and PDFs, extracts drafts, and confirms them separately (`services/bookings.js`, `services/importer.js`). | A client-supplied structured draft can use Trippy's domain logic without paying for a second model extraction. Current direct booking creation is not itself a preview/apply contract. |
| Evidence | Booking attachments accept PNG/JPEG/WebP up to 5 MB and PDF up to 10 MB, at most four per booking; imported image/PDF artifacts also appear as booking documents (`services/attachments.js`, `services/documents.js`). | Screenshot retention has a Trippy storage path. Transferring a client's original bytes, associating them with the right booking, and reporting partial failure need an external contract. Plain email text need not be retained. |
| Stops and Discovery | Stop creation resolves location/photos; co-pilot proposals can ground a stop in an active in-scope catalogue place and require apply (`services/stops.js`, `services/copilotProposals.js`). | A later MCP stop tool should reuse trip/day membership and server-side catalogue evidence. Never accept a model's unsupported `verified` claim or raw coordinates as attestation. |

There is no MCP endpoint, integration credential, generic write-preview contract, or booking-create idempotency key in the inspected code. Import extraction warns about low confidence, duplicate references, and dates outside the trip, but `confirmArtifact` creates multiple bookings sequentially and only later marks the artifact confirmed; it is not an atomic batch or safe blind-retry operation. Direct booking creation checks type and title but does not itself perform all extraction-review checks. These differences matter before exposing writes to autonomous clients.

## Recommended shape to evaluate

```text
Any authorized MCP client
  → Trippy hosted Streamable HTTP endpoint
  → Trippy user identity and access checks
  → Trippy trip / booking / stop services
  → Trippy SQLite and existing document storage
```

Use the standard Streamable HTTP transport rather than a client-specific stdio process or an obsolete SSE-only endpoint. The 2026-07-28 revision removed protocol-level sessions and the GET stream endpoint; assess the protocol versions target clients support before selecting the server's compatibility range. Protect the MCP endpoint with user-bound authorization. The MCP specification's HTTP authorization model uses OAuth protected-resource metadata; a personal token might simplify an initial private test but would have a narrower interoperability and revocation story. Compare both explicitly before choosing. Trippy's invite-only accounts and per-trip owner/collaborator checks must continue to control data access, regardless of transport or token scope. Validate Origin where applicable, enforce request limits, keep secrets out of logs, and expose a visible connection/revocation path. These are server obligations, not promises from a client prompt. [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http); [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

The MCP should expose business actions rather than a database or generic HTTP proxy. A candidate first catalogue is:

| Tool intent | Why it exists | Write boundary |
|---|---|---|
| Find/list trips and read a trip's relevant days/bookings | Let a client select the right destination and avoid duplicate work. | Read-only, scoped to the connected user. |
| Prepare a trip or booking | Normalize fields and return missing details, likely duplicate/date conflicts, a review summary, and a short-lived draft reference. | No trip or booking write. The exact draft persistence design is open. |
| Apply an approved trip or booking draft | Save the precise reviewed values and return stable resource IDs and links. | Requires an explicit apply call; stale or changed drafts are refused. |
| Attach a source document to a booking | Keep the original screenshot or PDF available in Trippy. | Independently authorized, size/type limited, and bound to an accessible booking. |

`prepare` and `apply` describe Trippy's contract, not a claim that Trippy can prove a human clicked Approve in every possible client. The server can require an unexpired draft reference, recheck state at apply, and record who/which integration applied it. The client must present the preview and collect approval. If Trippy later wants server-enforced human approval independent of client trust, that is a larger product decision requiring a Trippy-hosted approval surface.

For files, do not ask a language model to place image or PDF base64 into a tool argument. Assess an authenticated binary upload or short-lived upload-ticket path usable by any MCP client, with the document linked only after a booking exists. The existing attachment endpoint proves Trippy can store the bytes; it does not solve how a remote client makes its local upload available. A client that cannot transfer the original may still save a structured booking, and the result must clearly say `sourceDocumentSaved: false`. Retaining pasted email text is not required. An optional Trippy-side extraction workflow can remain separate from the structured-input MCP path; clients should not have to call Trippy's model after doing their own interpretation.

## Correctness and operational questions

1. **One approval, several writes.** A new-trip screenshot can lead to trip creation, one or more bookings, and one or more attachments. Decide whether Trippy offers a combined apply operation or durable staged operations. A timeout after dispatch must be resolved by querying a stable request/draft ID, not by blindly retrying and creating duplicates. Return partial outcomes precisely if attachment storage fails after a booking succeeds.
2. **Duplicate and ambiguity checks.** Check confirmation reference, booking type, trip, route/stay dates, and source hash where present. A warning is not a uniqueness guarantee. The preview should identify local-time/time-zone uncertainty, missing dates, two-leg screenshots, and trips whose date range does not contain the booking.
3. **Account and grant model.** Decide whether initial credentials use OAuth, a dedicated personal token, or staged support for both. Tokens must map to users and be revocable. Broad access for one owner's bot must not imply access to another user's trips; destructive tools such as trip deletion, collaborator management, and expense changes should not appear in the initial catalogue merely because the credential can edit trips.
4. **Cost and load.** Read-only listing should not trigger paid discovery generation, flight lookup, photo selection, or extraction. Booking/stop writes may trigger existing network enrichment; give clients bounded timeouts and a way to learn the authoritative result after an uncertain response. Avoid a second model extraction when structured fields are already supplied.
5. **Deploy and protocol fit.** Compare mounting MCP in the existing Express process with a separate Trippy service using the same domain layer. Verify startup/shutdown, HTTPS/proxy behavior, version negotiation and older-client compatibility, auth failures, tool-schema compatibility, logging, and revocation with an independent MCP client. No live handshake was run for this assessment.

## Suggested first proof and decision gate

Start with one existing-trip flight or hotel screenshot interpreted by an independent client, then a new-trip case. Pass only if: the client can discover and authenticate to the hosted endpoint; account A cannot read or change account B's private trips; the preview shows the exact values later saved; ambiguous fields and duplicates are visible; an approved apply creates one booking and its intended itinerary stop; a repeated apply cannot duplicate it; the source image attaches or the result clearly reports why it did not; and the saved booking can be opened in Trippy. Repeat after a service restart and after credential revocation.

The capability is realistic but broader than protocol wiring. The principal work is authentication, preview/apply semantics, safe retries, and file transfer around Trippy's existing domain operations. If that scope is acceptable, write an implementation plan only after this assessment is reviewed and the open choices above are settled. No Trippy MCP or client integration is authorized by this document alone.

## Review addendum, 2026-09-16

Reviewed against the checkout at `8cfe009`, the published spec revision 2026-07-28, and the published TypeScript SDK v2.0.0. The full planning recommendation, verified-fact table, tool contract, and the owner decisions it needs are in `docs/superpowers/reviews/2026-09-16-hosted-mcp-planning-recommendation.md`. Corrections and clarifications to the text above:

1. **In-process vs adjacent service is decided by code, not preference.** Provider daily budgets (`discoveryResolverDailyRequestBudget`, escalation, re-verify, per-destination) are in-memory per process (`backend/src/config.js`). A second process would carry its own uncounted copies and could double real Nominatim/Google spend. Mount the MCP in the existing Express process.
2. **"OAuth vs personal token" is a client-support split, and OAuth is a build, not an import.** SDK v2 ships resource-server helpers only (`requireBearerAuth`, RFC 9728 metadata); its authorization-server helpers are frozen in `@modelcontextprotocol/server-legacy/auth` with guidance to use a dedicated identity provider. Claude Code accepts a static bearer header; the Claude.ai / Claude Desktop custom-connector UI accepts OAuth only. So "which clients must work in v1" is the auth decision.
3. **Booking + stop are already non-atomic in Trippy.** `createBooking` commits the booking, then `syncStopWithBooking` does network I/O and writes the stop outside any transaction (`services/bookings.js`, `services/stops.js:937`). An MCP apply must use the resolve-then-write pattern `applyProposal` already uses, which needs the stop sync split into resolve/write halves.
4. **The existing `computeTripFingerprint` does not cover bookings** — it hashes days and stop ids/times/booking links. A booking draft needs its own fingerprint; do not widen the co-pilot's (Plan 11 D3).
5. **A stop can silently not be created** when the trip has no `days` row for the booking date (`inferBookingStop` / `syncStopWithBooking`). The preview must surface this as a planned effect, and the apply result must report `stopId: null` with a reason.
6. **`booking_attachments` has no content hash** (import files do). Idempotent re-upload after a timeout needs one — additive column.
7. **The protocol-compatibility question is largely answered by the SDK**: v2's Streamable HTTP handler is stateless per request and documents serving 2025-era clients from the same handler. Verify with real clients in a spike rather than designing a compatibility layer.
8. **HTTPS exists (`https://trippy.zyroi.com`) but the TLS/proxy mechanism is not recorded in the repo.** SSE buffering, request timeouts, and body limits on that proxy are facts to collect before the plan is written.

Verified unchanged: the Trippy baseline table above, the spec statements about 2026-07-28 (sessions and the GET stream removed, Origin validation, required metadata headers), and the recommended catalogue shape. Nothing described here is shipped.
