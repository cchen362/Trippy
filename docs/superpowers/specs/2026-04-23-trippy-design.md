# Trippy — Living Product and Architecture Specification

**Originally approved:** 2026-04-23

**Architecture baseline updated:** 2026-07-14

**Status:** Living specification of the implemented product; future work is labelled explicitly

---

## 1. Purpose and Document Contract

Trippy turns scattered travel plans into one private, shared working itinerary. It combines:

- a logistics hub for bookings, confirmations, source documents, and time-sensitive travel details;
- a day-by-day plan with places, notes, timing, photos, and map context;
- a grounded discovery catalogue for ideas the traveller did not know to ask for; and
- an AI co-pilot that can reason about a trip and propose, but never silently apply, itinerary changes.

This document describes the product and architecture that exist in the repository. It is not a backlog and it does not make an unfinished implementation plan true.

When evidence conflicts, use this order:

1. Live code, database migrations, tests, and runtime configuration.
2. `AGENTS.md` for engineering constraints and repository conventions.
3. This specification for system boundaries and product behavior.
4. Completed implementation plans for historical decisions and detailed acceptance evidence.
5. Open plan waves and review documents as future intent only.

The dated filename is retained for stable links. The status and baseline date above indicate freshness.

---

## 2. Product Boundaries and Users

### 2.1 Users

- A small, invite-only group: the owner and a close circle of travellers.
- Multiple authenticated users can collaborate on a trip asynchronously.
- Anyone with a valid public share token can read a deliberately reduced itinerary without an account.
- Primary device: an installed or browser-based mobile PWA.
- Secondary device: desktop browser using the same information architecture.

### 2.2 Product principles

- **Trip truth is shared.** Plan, logistics, map, discovery, and co-pilot operate on the same trip data rather than maintaining parallel copies.
- **Flexible itinerary, not rigid schedule.** Untimed stops, mixed-density days, route changes, and evolving destination scope are normal.
- **Evidence over inference.** Explicit day overrides, bookings, resolved places, and user-confirmed pins outrank guessed geography.
- **Human confirmation for destructive or structural AI work.** The co-pilot can recommend and prepare changes; a user applies or rejects them.
- **Private by default.** Public sharing exposes an itinerary view, not the private planning workspace.
- **Cost-aware enrichment.** Reuse catalogues, cached resolutions, persisted photos, autocomplete sessions, and prompt caching before calling paid providers again.

### 2.3 Current exclusions

The following are not implemented product capabilities unless a newer plan ships them:

- real-time multi-user editing or conflict-free replication;
- offline writes or offline map tiles;
- automatic background flight monitoring and proactive alerts;
- weather, currency conversion, expense tracking, or settlement;
- PDF/JSON trip export;
- route-time or distance-matrix reasoning in the co-pilot;
- automatic co-pilot actions without a persisted proposal and explicit apply;
- durable per-message screen context and selective trip-context assembly described by Plan 13/follow-up architecture reviews.

---

## 3. Implemented Technical Stack

| Layer | Implemented choice | Notes |
|---|---|---|
| Frontend | React 18, React Router 6, Vite 5, Tailwind CSS 3 | JavaScript/JSX; Vitest + Testing Library |
| Motion | Framer Motion 11 | Used for sheets, cards, and interaction transitions |
| Maps | Leaflet 1 + React Leaflet 4 | OSM/MapTiler/Amap tiles selected from geography |
| PWA | `vite-plugin-pwa` | Standalone manifest and runtime caching |
| Backend | Node.js ESM + Express 4 | JSON REST plus SSE streams |
| Database | SQLite + `better-sqlite3` | WAL, foreign keys, ordered SQL/JS migrations |
| Authentication | Invite-code registration + opaque cookie sessions | bcrypt passwords; 30-day httpOnly session cookie |
| AI | Anthropic Claude | Sonnet 4.6 for extraction/co-pilot; Haiku 4.5 for discovery/descriptors |
| Places/geocoding | Google Places + Nominatim | Cached, language-normalized place resolution |
| Photos | Unsplash | Persisted selection, attribution, download tracking |
| Flight lookup | AeroDataBox through RapidAPI, optional | Manual normalized fallback when unconfigured |
| Deployment | Docker on Debian | Express serves the built SPA and uses a mounted SQLite volume |

The backend requires session, database, Anthropic, Unsplash, and Google Places configuration outside tests. MapTiler and AeroDataBox are optional integrations.

---

## 4. Runtime Architecture

```text
React PWA
  ├─ authenticated REST requests ───────────────┐
  ├─ Discovery SSE stream ─────────────────────┤
  └─ Co-pilot SSE + proposal apply/reject ─────┤
                                                ▼
Express API
  ├─ routes: input, access, protocol shape
  ├─ services: domain logic and provider orchestration
  ├─ middleware: auth, trip access, rate limits, errors
  └─ db: connection, migrations, catalogue queries
                                                │
                  ┌─────────────────────────────┼──────────────────────┐
                  ▼                             ▼                      ▼
               SQLite                     Anthropic          External providers
      trips, bookings, days, stops,       extraction,         Google, Nominatim,
      catalogue, messages, proposals       discovery,          Unsplash, maps,
                                              co-pilot           AeroDataBox
```

### 4.1 Frontend composition

- `App.jsx` owns authentication gates and routes.
- `TripsHomePage` owns the all-trips surface.
- `TripPage` is the private trip shell and loads shared trip state for nested tabs.
- Domain hooks (`useTrip`, `useStops`, `useBookings`, `useDiscovery`, `useCopilot`, `useMapData`) own client orchestration.
- Service modules own HTTP/SSE details and payload mapping.
- Public `ShareViewPage` is outside the authenticated trip shell.

### 4.2 Backend composition

- `index.js` mounts route groups, production static assets, SPA fallback, and the terminal error handler.
- Routes authenticate and validate request boundaries; services implement workflows.
- Access helpers prove trip/day/stop/booking ownership before mutation.
- Provider integrations live behind backend services so API keys and normalization remain server-side.
- SQLite migrations are the durable data-model history. Existing migrations are immutable.

---

## 5. Navigation and Screen Architecture

### 5.1 Routes

| Route | Access | Surface |
|---|---|---|
| `/trips` | Authenticated | Trip dashboard, creation, capture, account/admin entry |
| `/trips/:tripId` | Authenticated trip access | Redirects to Today for a live trip, otherwise Plan |
| `/trips/:tripId/today` | Authenticated trip access | In-trip “what matters now” view |
| `/trips/:tripId/plan` | Authenticated trip access | Day timeline and Discovery panel |
| `/trips/:tripId/logistics` | Authenticated trip access | Bookings and documents |
| `/trips/:tripId/map` | Authenticated trip access | Day map, route sequence, pin correction |
| `/share/:token` | Public token | Reduced read-only itinerary |

### 5.2 Four-slot bottom navigation

The persistent mobile mental model has four slots:

1. **Trips** when outside a live trip, replaced by **Today** inside a trip whose dates include today.
2. **Plan**.
3. **Logistics**.
4. **Map**.

Discovery is a Plan panel. The co-pilot is a floating affordance and bottom sheet. Neither is a fifth navigation tab.

Desktop widens and recenters the same component tree; it does not introduce a separate desktop product.

### 5.3 Co-pilot presentation

- Opens at partial height with the trip visible behind it.
- Expands to a full-height state only by explicit user action.
- Mobile uses a handle-led vertical gesture; desktop uses explicit expand/collapse and close controls.
- Streaming content scrolls inside the current sheet height and never auto-expands the sheet.
- Escape closes on desktop. Mobile keyboard insets move the input, not the sheet’s top edge.

---

## 6. Current Data Architecture

This is the conceptual schema after migrations 001–028. Consult migration files for exact columns and constraints.

| Domain | Durable tables | Responsibility |
|---|---|---|
| Auth | `users`, `auth_sessions`, `settings` | Accounts, sessions, invite code |
| Trips | `trips`, `trip_collaborators`, `share_links`, `trip_scopes` | Trip metadata, access, public token, planning scope |
| Itinerary | `days`, `stops` | Ordered daily plan, location/photo provenance |
| Logistics | `bookings`, `booking_attachments` | Structured reservations and private documents |
| Capture | `import_artifacts`, `import_artifact_files` | Uploaded evidence, extraction state, confirmation audit |
| Resolution | `place_resolution_cache` | Provider-normalized location cache |
| Discovery | `discovery_destinations`, `discovery_places`, `discovery_generation_daily` | Shared normalized catalogue and generation budgets |
| Co-pilot | `copilot_messages`, `copilot_proposals` | Conversation, typed proposal audit, apply state |
| Migrations | `schema_migrations` | Ordered migration ledger |

### 6.1 Retired data shapes

- Migration 015 removed persisted `trips.destinations` and `trips.destination_countries` arrays.
- Migration 018 retired `global_discovery_cache`.
- Migration 022 retired the original per-trip `discovery_cache`.

Do not reintroduce these as convenient duplicate truth. Compatibility response fields such as `trip.destinations` are derived at read time.

### 6.2 JSON fields

Flexible provider and domain detail remains in bounded JSON fields such as booking `details_json`, capture extraction JSON, photo attribution JSON, proposal operation/warning JSON, and trip scope bounds. Validate at the service boundary; do not use JSON as an excuse to bypass relational ownership or core invariants.

---

## 7. Geography, Identity, Maps, and Coordinates

### 7.1 Planning scope versus day locality

Trippy distinguishes four related concepts:

- **Scope:** a place the user intentionally includes in the trip’s planning/discovery boundary, persisted in `trip_scopes`.
- **Seed city:** the original `days.city` value used to create the day sequence.
- **Day locality:** the effective city/country for one day after evidence is applied.
- **Resolution anchor:** why that locality won, exposed for traceability.

Trip-level `destinations` and `destinationCountries` returned to clients are derived by merging persisted scopes with resolved day pairs.

### 7.2 Effective day geography

Use the shared `deriveDayGeo` pipeline. In precedence order, effective geography comes from:

1. explicit day city override and its resolved country;
2. an active hotel/booking whose date range covers the day;
3. seeded day city/country;
4. previous resolved day carry when evidence is otherwise absent.

This prevents a broad trip label or the first city from overriding stronger per-day evidence. Backend and frontend geography helpers must remain behaviorally aligned.

### 7.3 Place resolution

- Google Places supplies user-selected autocomplete/details results and English-normalized address evidence.
- Nominatim is the paced fallback resolver and must respect its one-request-per-second pipeline.
- Resolutions are cached with provider id, source, coordinate system, country, confidence, and status.
- A user-confirmed pin is authoritative. Unrelated stop edits must not erase or silently re-resolve it.

### 7.4 Map provider policy

| Day country | Tiles | Coordinate/display policy | Deep link |
|---|---|---|---|
| Mainland China (`CN`) | Amap | Convert WGS-84 storage/provider evidence as required for GCJ-02 display | Amap |
| South Korea (`KR`) | MapTiler if configured, otherwise OSM | WGS-84 | Naver Maps |
| Other/unknown | MapTiler if configured, otherwise OSM | WGS-84 | Google Maps |

Map config is selected per day where possible. Trip-level precedence is only a fallback for surfaces without a day context.

### 7.5 Map UX

- The active day controls map stops and route sequence.
- Resolved, estimated, unresolved, and user-confirmed locations remain distinguishable.
- Users can place an unresolved stop or correct an estimated pin.
- Map data converts to provider display coordinates once; deep links use the same displayed location logic.

---

## 8. Feature Architecture

> Historical plans that say “design spec §8” predate this document’s restructuring and mean the Visual Design Language now maintained in §12.

### 8.1 Trip creation and editing

- A trip has title, dates, traveller profile, interests, pace, and one or more destination scopes.
- Day rows are generated across the date range.
- Destination selection uses Google Places session-token autocomplete and persists scope identity/bounds.
- Editing scope reconciles stored scopes without rewriting unrelated day or booking evidence.
- Trip status (active/upcoming/past) is derived from dates rather than trusted as static client truth.

### 8.2 Plan timeline

- Each day renders an ordered list of stops with optional time, note, duration, estimated cost, best-time hint, photo, and location metadata.
- Stops support add, update, remove, move, reorder, photo selection, and pin correction through authenticated backend operations.
- Booking-linked stops are synchronized from booking data and treated differently from ordinary editable stops where required.
- Dragging is mobile-safe: vertical page pan remains available except on the intentional drag handle.
- Transit is visually subordinate inline content; experience stops use photographic cards.

### 8.3 Today mode

Today is available only when the trip is live. It derives a “now/next/tonight” view from existing days and bookings:

- completed/current/upcoming itinerary rows;
- a hero item for the next relevant movement or stop;
- tonight’s accommodation;
- provider-correct navigation links; and
- manually refreshed, client-cached flight status when available.

Today does not maintain a separate itinerary or background polling system.

### 8.4 Logistics and booking capture

Bookings support flight, hotel, train, and flexible other records. Common columns hold lifecycle and route fields; `details_json` preserves type/provider detail.

- Flight lookup normalizes AeroDataBox results when configured and falls back to manual prefill.
- Hotel/place lookup uses Google autocomplete plus a completing details request under one session token.
- Origin/destination timezones are stored independently where available.
- A booking may opt out of itinerary insertion through `show_in_itinerary`.
- Creating/updating a visible booking synchronizes its linked stop through backend services.

Channel-agnostic capture accepts text, images, and PDFs:

1. store an immutable artifact and file evidence;
2. extract a normalized booking draft with Claude;
3. show the draft and assumptions for review;
4. create bookings only on confirmation; and
5. retain artifact/model/outcome metadata for traceability.

Booking attachments are private, authenticated binary data and are never exposed by public sharing.

### 8.5 Discovery catalogue

Discovery is catalogue-first, not a per-trip generated blob.

- `discovery_destinations` is keyed by canonical city identity plus country code.
- `discovery_places` holds categorized, normalized, ranked place rows with provenance, status, coordinates, photo descriptor, and optional rating evidence.
- A fresh catalogue (seven-day TTL) is returned without an Anthropic call.
- A stale catalogue is refreshed and merged so a refresh does not collapse visible breadth.
- “Show more” appends rather than replaces.
- Generation is limited per canonical destination/day; resolver verification has a separate daily cost budget.
- Places can be verified, ranked for the current trip, suppressed/reported, or found through the Google-backed “On the map” escape hatch.
- Adding a catalogue place to a day copies grounded identity/location/photo metadata into the stop creation path.

### 8.6 Stop photography

- AI generates a compact `photo_query` and `scene_type` for discovery places and manually created stops.
- Unsplash selection prefers semantic query fit and rejects unsuitable/duplicate candidates according to the live selection service.
- Stops persist URL, photo id, attribution, query, scene type, and `photo_source`.
- User-selected photos and user-confirmed pins survive unrelated edits.
- Rendering keeps required attribution; selection/display calls the required Unsplash download tracking endpoint.
- If lookup fails, stop creation still succeeds without disguising the provider failure.

### 8.7 Collaboration and public sharing

- Owners can add/remove authenticated collaborators by username.
- Private trip access is enforced on every nested object operation, not only at the trip route.
- A trip can have a revocable public token.
- The public payload contains trip identity, resolved day geography, and itinerary stops only.
- Public output excludes bookings, confirmation references, attachments, collaborators, co-pilot history/proposals, and all edit controls.

---

## 9. AI and Co-Pilot Architecture

### 9.1 Model assignments

| Workflow | Live model | Reasoning/cost posture |
|---|---|---|
| Booking/document extraction | Claude Sonnet 4.6 | High-accuracy structured extraction across text/image/PDF |
| Discovery generation | Claude Haiku 4.5 | High-volume categorized generation with SSE |
| Photo descriptors | Claude Haiku 4.5 | Small deterministic descriptor task |
| Co-pilot reasoning/actions | Claude Sonnet 4.6 | Conversational reasoning plus native tool use |

Model names in `backend/src/services/claude.js` are the live truth. A model upgrade is an architecture/cost change, not a documentation-only edit.

### 9.2 Discovery generation

- The route resolves canonical destination identity and catalogue freshness before generation.
- Claude streams category results; the backend validates category shape and persists/merges rows.
- Verification and ranking are separate deterministic/provider-backed stages.
- Existing active catalogue rows remain usable if a stale refresh fails.

### 9.3 Co-pilot request context

Current behavior:

- The system block contains the serialized trip and is marked with Anthropic ephemeral prompt caching.
- The request includes the most recent 20 persisted messages, reordered chronologically.
- The UI and backend stream SSE events for text, tool activity, proposals, completion, and errors.
- The conversation can therefore grow indefinitely in storage while only a fixed recent window is sent.

Known limitation: the trip serialization is broad and the fixed message window has no durable summary or per-message screen context. The reviewed direction is incremental: preserve the existing tool/action loop, then add the Plan 13 task-shaped context channel and later durable/selective context assembly. Do not move volatile screen context into the cached system block.

### 9.4 Grounded query tools

The server exposes bounded query tools to Claude:

- `search_discovery_catalogue` searches active, trip-scoped catalogue rows and returns grounded place evidence.
- `check_trip_health` runs deterministic checks over the trip, optionally scoped to a day.

The backend owns execution and enforces a per-turn query-tool budget. Tool activity is surfaced to the user. Concrete place additions must be grounded in catalogue evidence; general destination conversation does not require a tool call.

### 9.5 Trusted action protocol

The only itinerary action channel is native tool use through `propose_itinerary_changes`.

1. Claude explains its reasoning and emits typed operations.
2. The backend validates membership, operation shape, booking-linked constraints, and recoverability warnings.
3. The backend persists a `copilot_proposals` row linked to the assistant message, including a fingerprint of the relevant trip state.
4. The UI renders a before/after or operation preview plus warnings.
5. The user applies or rejects the proposal.
6. Apply recomputes the fingerprint and rejects stale proposals.
7. All proposal operations and the status transition commit atomically or not at all.

Proposal states are `pending`, `applied`, `rejected`, `stale`, or `invalid`. Pending proposals survive refresh because the server, not browser-only state, is authoritative.

### 9.6 Plan 13 boundary as of this baseline

Implemented:

- Wave 1 approved the interaction mockups and entry-point set.
- Wave 2 shipped the partial/expanded co-pilot bottom sheet.

Not implemented:

- persisted `context_json` on co-pilot messages;
- validated tab/day/stop context injection into the user turn;
- context chips that survive history reload;
- stop/Discovery contextual entry points;
- deterministic trip-grounded seed prompts; and
- Plan 13 final QA/deployment close-out.

Do not write code against migration 029 or these message-context contracts until their implementation wave is actually taken on.

---

## 10. Authentication, Authorization, and Privacy

### 10.1 Authentication

- First-run setup creates the first admin and initializes the invite code.
- Registration requires the current invite code.
- Passwords are bcrypt-hashed.
- Login creates a random 30-day session token stored in `auth_sessions` and sent in an httpOnly cookie.
- Production cookies are `secure` and same-site `lax`.
- Authentication endpoints are rate-limited; admin endpoints require `requireAdmin`.

### 10.2 Authorization

- Trip owners and collaborators receive private trip access through shared access helpers.
- Owner-only operations remain explicit (for example trip deletion and owner-only co-pilot history clearing behavior).
- Day, stop, booking, attachment, import artifact, proposal, and collaborator ids must be checked through their parent trip/user relationship.
- A public token is read-only capability access to a reduced response, not authentication.

### 10.3 Error handling

- Development failures should be visible and attributable.
- Provider/database errors are logged server-side and returned as clean API messages.
- SSE handlers emit an error event when possible and abort upstream Anthropic work when the client disconnects.
- Recoverable enrichment failure must not corrupt or silently discard the underlying user-created trip data.

---

## 11. External Provider and Cost Policy

### 11.1 Anthropic

- Reuse fresh discovery catalogue rows before generation.
- Keep stable trip context in the cached system block; volatile turn context belongs in the message stream.
- Use deterministic services for health checks, ranking, seed generation, and validation where an LLM adds no value.
- Track model usage at workflow boundaries and make model changes explicit.

### 11.2 Unsplash

- Persist selected photo metadata on the stop/catalogue path.
- Keep photographer/Unsplash attribution in the rendered UI.
- Call `download_location` tracking as required by Unsplash when a photo is selected/displayed through the product flow.
- Never re-run search simply because a stored photo is being rendered.

### 11.3 Google Places

- Use one random session token from autocomplete through the completing details request.
- Request the minimum field mask required by the workflow.
- English-normalize address evidence used for canonical identity while preserving user-facing place names.
- Rating enrichment remains feature-flagged because it uses a more expensive field tier.

### 11.4 Nominatim and place resolution

- Cache first.
- Respect the centralized one-request-per-second pacing.
- Supply a real configured user agent in deployed environments.
- Keep discovery verification budgets separate from request pacing.

### 11.5 Maps and flight data

- MapTiler is optional and must fall back cleanly to OSM.
- Amap tiles require no application key in the current tile-only implementation.
- AeroDataBox is optional. Do not poll on component mount/render; the Today view caches checks and exposes deliberate refresh.

---

## 12. Visual Design Language

This section remains the implemented baseline while the broader design-system revamp is in progress. `frontend/src/index.css` is authoritative for production tokens. The external **Luxury Dark Design System** package and `docs/superpowers/mockups/trippy-revamped-system.css` are reference/exploration inputs; their differing surface, radius, and motion tokens do not silently override shipped components.

Historical implementation plans written before the 2026-07-14 restructure refer to the visual design language as “§8”; those references point to this section.

### 12.1 Theme: Dark Ink Wash × Luxury

Inspired by W Hotels’ typographic confidence and Waldorf Astoria restraint. The interface should feel like a private travel dossier, not a generic SaaS dashboard.

### 12.2 Colour palette

```css
--ink-deep:    #0d0b09;  /* primary background — warm near-black */
--ink-mid:     #1c1a17;  /* card backgrounds */
--ink-surface: #232018;  /* elevated surfaces */
--ink-border:  rgba(255,255,255,0.07);
--gold:        #c9a84c;  /* single accent — used once per component */
--gold-soft:   rgba(201,168,76,0.12);
--gold-line:   rgba(201,168,76,0.28);
--cream:       #f0ead8;  /* primary text */
--cream-dim:   rgba(240,234,216,0.60);
--cream-mute:  rgba(240,234,216,0.28);
```

No pure black, purple-gradient default, or unapproved accent palette.

### 12.3 Typography

| Role | Font | Weight/style |
|---|---|---|
| City/place names | Playfair Display | 400 italic |
| Section titles | Playfair Display | 400 italic |
| Body/notes/narrative | Cormorant Garamond | 300–500 |
| UI labels, times, codes, refs | DM Mono | 400–500 |
| Type/status badges | DM Mono | Uppercase with tracking |

No Inter, Roboto, Arial, or `system-ui` as the primary interface font.

### 12.4 Photography

- Use full-bleed `object-fit: cover` inside card bounds.
- Put text on the dense left side of: `linear-gradient(100deg, rgba(13,11,9,0.92) 0%, rgba(13,11,9,0.30) 65%, rgba(13,11,9,0.05) 100%)`.
- Keep attribution legible without competing with the content hierarchy.
- Transit stops have no card and no photo; they are subordinate inline itinerary text.
- Avoid repeating a visually irrelevant destination image merely to fill space.

### 12.5 Gold discipline

Gold is the single accent and should normally appear once per component: a type badge, active indicator, key reference, or deliberate hairline. Never use it as a broad background fill. A component with a gold eyebrow does not also need a gold confirmation reference, icon, border, and button.

### 12.6 Component character

- Booking types use distinct, domain-meaningful anatomy rather than one generic card.
- Flight and train cards may use the ticket-stub metaphor; accommodation uses a concierge/dossier structure.
- Cards should feel composed around travel information, imagery, and chronology, not like interchangeable dashboard widgets.
- Use restrained radii and hairlines. Preserve the live component’s established radius until the revamp explicitly migrates it; do not mix design-package 4px cards and current 10–16px production cards ad hoc.
- Utility icons use Lucide’s hairline language and remain paired with accessible text/labels where meaning is not obvious.

### 12.7 Motion and interaction

- Motion must communicate state or spatial relationship.
- Co-pilot sheet motion follows the implemented mobile-drag/desktop-control split.
- Content growth never initiates sheet expansion or navigation.
- Prefer CSS for small transitions and Framer Motion for coordinated state transitions.
- Respect `prefers-reduced-motion`.
- No decorative bounce, perpetual motion, or hover-only essential action.

### 12.8 Mobile-first rules

- Design at 375px first and verify actual reachable actions, not only screenshots.
- Touch targets should be at least 44px where practical.
- Modals, forms, and sheets need scroll containment and software-keyboard behavior.
- Desktop is a wider hierarchy with pointer/keyboard affordances; do not emulate touch gestures with a mouse.

### 12.9 Content voice

- Quiet confidence; concise, direct, and useful.
- Sentence case for normal chrome; tracked uppercase for compact mono metadata.
- No emoji in product chrome and no exclamation marks as personality.
- User-facing errors state what could not be done without exposing stack traces.

---

## 13. PWA, Deployment, and Operations

### 13.1 PWA behavior

- Standalone manifest uses the dark ink theme.
- The service worker caches the app shell and selected trip/share reads for resilience.
- API writes remain network-dependent; there is no offline mutation queue or merge protocol.
- New caching work must not expose one user’s private trip data to another browser session.

### 13.2 Deployment shape

- The frontend is built into the Docker image.
- Express serves `/api`, built static assets, and the SPA fallback on port 3001 in the container.
- Docker Compose maps the service to the host and mounts `./data` at `/app/data` for SQLite durability.
- Production configuration is supplied through `.env`; secrets are never committed.
- Schema migrations run in order at application startup before serving traffic.

### 13.3 Operational expectations

- Database backup is the SQLite data volume, not a copied live file without WAL awareness.
- Deployments require a clean scoped change, green relevant tests/build, migration review, service health verification, and feature-specific smoke checks.
- Paid-provider production readiness includes credential/quota verification and rendered behavior, not only a successful build.

---

## 14. Verification Baseline

Future implementation work should select tests proportional to risk:

- backend suite: `cd backend; npm test`;
- frontend suite: `cd frontend; npm test`;
- production frontend build: `cd frontend; npm run build`;
- 375px and desktop browser checks for affected UI;
- migration application on a disposable or copied database for schema work;
- public-share privacy check when changing trip serialization;
- cross-trip id/access tests for new nested resources;
- provider-cost/cache behavior for external integration changes; and
- `git diff --check` plus link/status review for documentation.

An implementation plan is complete only when its status and acceptance evidence match the live repository and, where required, deployed behavior.

---

## 15. Plan Ledger and Reading Guide

The implementation-plan directory is an architectural decision log, not a second current-state spec.

| Plan group | Current architectural contribution |
|---|---|
| Original plans 1–4 | Scaffold, core UI, maps/AI, collaboration/PWA foundation |
| Redesign Plan 1 | Coordinate metadata, resolver pipeline, map/provider correctness |
| Plans 2 and 2A | Booked-first/plan-first onboarding, channel-agnostic capture |
| Plan 3 | Today mode, document vault, flight-status entry points |
| Plan 4 | Cross-cutting UX/reliability fixes |
| Plans 5–6 | Geography investigation and evidence-based day geography |
| Plans 7–9 | Normalized discovery catalogue, destination identity/scopes, language/client-state integrity |
| Plan 10 | Descriptor-driven, attributed stop photography |
| Plan 11 | Native co-pilot action protocol, persisted proposals, atomic apply |
| Plan 12 | Catalogue grounding tools and deterministic trip-health checks; deployed/closed |
| Plan 13 | Bottom sheet shipped; context channel and contextual entry points still open |

Before implementing a feature named by a plan, read that plan’s top status line and the relevant live files. Never copy old file offsets, test counts, model assumptions, or “next migration” claims without re-verifying them.
