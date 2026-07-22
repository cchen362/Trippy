# Trippy — Claude Code Guidelines

## What This Is

Trippy is a private, mobile-first travel planning PWA for consolidating bookings, building a day-by-day itinerary, discovering places, navigating during a trip, and collaborating with an AI planning co-pilot.

Stack: React 18 + Vite 5 + Tailwind frontend · Node.js + Express backend · SQLite via `better-sqlite3` · Docker on Debian.

Living product and architecture spec: `docs/superpowers/specs/2026-04-23-trippy-design.md`

## Source-of-Truth Order

When documents disagree, use this order:

1. Live code, migrations, tests, and runtime configuration.
2. This file for engineering constraints and repository conventions.
3. The living design/architecture spec for product boundaries and system shape.
4. Completed implementation plans for decision history and feature-specific detail.
5. Open implementation plans for intended future behavior only.

Do not describe planned work as shipped. Plans 1–14 are historical implementation records; always read their status headers.

---

## Non-Negotiable Engineering Rules

**No bandaiding. Ever.**
If something is broken, find the root cause and fix it. Do not patch symptoms, suppress errors, add try/catch to hide failures, or work around a bug without understanding it. Tech debt compounds — leave the codebase cleaner than you found it.

**No `// TODO` or `// FIXME` left in committed code.**
If it's not implemented, don't commit it. If it needs doing, do it now or create a tracked issue.

**Check before you assume.**
Before adding a new utility, component, or helper — grep for existing ones. Before adding a dependency — check if the existing stack already handles it.

**Fail loudly in development, gracefully in production.**
Never swallow errors silently. `console.error` at minimum; throw where appropriate in dev. User-facing errors get a clean message, not a stack trace.

**SQLite discipline.**
Always use parameterised queries (never string interpolation). Run migrations in order. Never modify existing migration files — add new ones.

---

## Current Architecture

### Frontend

- `frontend/src/App.jsx` owns React Router. Public sharing lives at `/share/:token`; authenticated routes live under `/trips` and `/trips/:tripId`.
- The four-slot bottom-navigation mental model is stable: Trips (or Today while a trip is live), Plan, Logistics, and Map. Discovery is a panel inside Plan, not a route or fifth tab.
- `TripPage.jsx` is the authenticated trip shell. It owns trip, stop, booking, discovery, and co-pilot state and supplies tab pages through outlet context.
- **Outlet-context and error-channel contract (Plan 21).** Trip *data* (`useTrip`) is flat-spread into the outlet context; *action hooks* (`useStops`, `useBookings`) are namespaced as `stopActions`/`bookingActions` and must never be flat-spread — two hooks return identically-shaped `{ saving, error }`, so a later spread silently clobbers an earlier one. Do not namespace as `stops`/`bookings`; `bookings` is already the trip data array. A mutation failure has exactly one owner: pass `onError` at hook construction to route it to `TripPage`'s shared page banner, or handle the rejection locally to own it — never both. `useStops` opts in (`onError: reportError`); `useBookings` does not (its three modals render their own inline errors). Hooks keep rethrowing from `run()` so `await`/`catch` call sites still work; they do not hold latched `error` state for something else to read.
- Server communication belongs in `frontend/src/services/`; reusable stateful behavior belongs in `hooks/`; route-level composition belongs in `pages/`; shared UI belongs in domain folders under `components/`.
- The app is JavaScript/JSX, not TypeScript. Do not invent a `types/` layer unless a deliberate TypeScript migration is approved.
- The PWA uses `vite-plugin-pwa`. Treat cached reads as a resilience layer, not as a separate offline-write architecture.

### Backend

- `backend/src/index.js` is the composition root: middleware, `/api` route mounting, production static serving, SPA fallback, and the terminal error handler.
- Route files validate HTTP input and access; service files own business logic and orchestration; `db/` owns the connection, ordered migrations, and catalogue queries.
- Access is enforced through `requireAuth`, `requireAdmin`, `requireTripAccess`, and the day/stop/booking ownership helpers. Never trust an object id without proving it belongs to a trip the current user can access.
- SQLite uses WAL mode, foreign keys, and ordered `.sql`/`.js` migrations recorded in `schema_migrations`. The next migration must be additive and use the next free sequence number.
- External I/O is asynchronous, but database writes remain synchronous through `better-sqlite3`. Multi-row or proposal-apply changes that must succeed together belong in a transaction.

### Domain Model and Geography

- `trips` stores trip metadata, preferences, and dates. Persisted `destinations` and `destination_countries` arrays were retired by migration 015; never restore them as competing truth.
- `trip_scopes` stores user-selected planning scopes. Trip destination summaries are derived by merging those scopes with day-level geography.
- A day's effective geography is derived from explicit day override, active hotel/booking evidence, seeded city, and previous-day carry. Use the shared derivation in `backend/src/services/trips.js` and the mirrored frontend helpers; do not infer geography ad hoc from a trip title or the first destination.
- Stops carry resolution provenance, coordinate system, confidence/status, country, provider id, and photo provenance. Preserve user-confirmed pins and user-selected photos when updating unrelated fields.
- Mainland-China provider coordinates may be GCJ-02; stored/display coordinates and deep links must pass through the existing coordinate utilities. Map configuration is selected per day when country context exists, with a trip-level fallback.

### Bookings, Capture, and Documents

- Bookings support flight, hotel, train, and flexible other types through normalized columns plus `details_json`. Booking-linked timeline stops are synchronized by backend services.
- Channel-agnostic capture stores uploaded text/images/PDFs as `import_artifacts` and `import_artifact_files`, extracts structured bookings with Claude, then creates bookings only after confirmation.
- Booking attachments are private authenticated data. Public share responses deliberately omit logistics and attachment contents.
- Flight lookup may use AeroDataBox when configured; manual normalized prefill remains supported when it is not.

### Discovery and Photos

- Discovery is a normalized shared catalogue: `discovery_destinations` + `discovery_places`, keyed by canonical geography identity and country code. The old `discovery_cache` and `global_discovery_cache` tables are retired.
- Catalogue freshness is seven days. Fresh rows are reused; stale rows are refreshed and merged; explicit “show more” appends. Generation is daily-budgeted and place verification is resolver-budgeted.
- Discovery generation and photo descriptors use Haiku 4.5. Booking extraction and the co-pilot use Sonnet 4.6 unless a later, explicit model migration changes the live constants.
- Stop photos persist the Unsplash photo id, URL, attribution, query, scene type, and source. Displaying/selecting Unsplash results must retain attribution and download tracking. A stored photo is reused rather than fetched on every render.

### Co-Pilot

- The co-pilot streams over SSE from `POST /api/trips/:tripId/copilot` and persists conversation history.
- It can query the discovery catalogue and deterministic trip-health checks through a bounded server-side tool loop.
- It never mutates the itinerary directly from prose. Claude proposes typed operations; the server validates and persists a `copilot_proposals` record; the user explicitly applies or rejects it. Apply is atomic and protected by a trip fingerprint against stale changes.
- The UI is a partial/expanded bottom sheet. Preserve manual expand/dismiss behavior, internal scrolling, and the distinct mobile-drag versus desktop-control interaction.
- Current conversation context is the most recent 20 messages plus the serialized trip in an ephemeral-cached system block. Per-message UI context is persisted and injected into user turns; durable conversation summaries and selective trip serialization remain reviewed future work.

---

## Design & Aesthetic Rules

**Refer to:** `docs/superpowers/specs/2026-04-23-trippy-design.md` §12 for the implemented design language. `frontend/src/index.css` is the production token source. The external Luxury Dark Design System package and `docs/superpowers/mockups/` are design inputs for the upcoming revamp; do not silently replace production tokens or component behavior from a mockup.

**No AI Slop.**
- No Inter, Roboto, Arial, or system-ui as the primary font
- No purple gradients on white/dark backgrounds as a default reach
- No generic card layouts that could belong to any SaaS dashboard
- No clichéd color schemes — commit to the defined palette below

**The palette is fixed. Do not deviate:**
```css
--ink-deep:   #0d0b09;  /* primary background */
--ink-mid:    #1c1a17;  /* cards */
--ink-surface:#232018;  /* elevated */
--gold:       #c9a84c;  /* single accent — once per component */
--cream:      #f0ead8;  /* primary text */
```

**Typography is fixed. Three fonts only:**
- `Playfair Display` italic — city/place names and section titles only
- `Cormorant Garamond` — body text, notes, narrative
- `DM Mono` — all UI labels, times, badges, confirmation refs

**Photography treatment:**
- Full-bleed `object-fit: cover` within card bounds
- Gradient overlay: `linear-gradient(100deg, rgba(13,11,9,0.92) 0%, rgba(13,11,9,0.30) 65%, rgba(13,11,9,0.05) 100%)`
- Transit stops: no card and no photo; render as subordinate inline itinerary text

**Gold accent discipline:**
Used once per component. On type badges, active indicators, confirmation refs. Never as a background fill.

---

## Mobile-First and Interaction Rules

- Design and verify at 375px first. Desktop is a wider treatment of the same information architecture, not a separate product.
- Touch targets must remain usable on a phone. Forms and sheets must keep critical actions reachable with the software keyboard open.
- Do not port touch gestures to desktop. Provide explicit pointer/keyboard controls.
- Avoid uninitiated motion. Content growth must not resize the co-pilot sheet, switch tabs, or move the user unexpectedly.
- Preserve reduced-motion support for new animation work.

## API Cost and Provider Discipline

- Anthropic: reuse a fresh discovery catalogue; preserve prompt-cache stability; do not add model calls for deterministic work.
- Unsplash: persist selected photo metadata, retain attribution, and call the required download-tracking endpoint. Never re-fetch a stored selection merely to render it.
- Google Places: use one session token across autocomplete and the completing details request. Request only fields the workflow needs.
- Place resolution: use the shared cache and resolver pipeline. Respect Nominatim pacing and discovery resolver budgets.
- AeroDataBox: do not poll flight status on render. Preserve the existing client cache/manual refresh behavior.
- MapTiler is optional; OSM is the default fallback, Amap is used for mainland China, and Naver is the Korean deep-link provider.

## File Conventions

```text
/frontend/src/
  components/     Domain-grouped shared UI
  pages/          Route-level components
  hooks/          Reusable state and orchestration
  services/       HTTP/SSE API clients and payload mapping
  context/        React providers
  utils/          Pure cross-component helpers

/backend/src/
  routes/         HTTP validation, access middleware, response/SSE shape
  services/       Business logic, provider integration, orchestration
  db/             Connection, ordered migrations, DB-specific catalogue access
  middleware/     Auth, access, rate limiting, error handling
  utils/          Pure shared helpers
```

Keep one primary exported component per component file. Before creating a helper, search both frontend and backend for an existing domain equivalent.

## Authentication and Sharing

- First-run setup creates the first admin and invite code.
- Registration is invite-code gated. Login uses a random 30-day opaque session token stored in `auth_sessions` and sent in an httpOnly cookie.
- Auth routes are rate-limited. Production cookies are secure and same-site.
- Owners and collaborators may edit private trips according to existing access rules. Public share tokens return a deliberately reduced, read-only itinerary without bookings, confirmation references, documents, co-pilot history, or edit controls.

## Verification Expectations

- Backend: `cd backend; npm test`
- Frontend: `cd frontend; npm test` and `npm run build`
- UI changes: verify the affected flow at 375px and desktop; exercise touch/pointer distinctions where relevant.
- Migration changes: prove ordered application on a disposable/copy database and keep existing migration files unchanged.
- Documentation changes: run `git diff --check` and verify links/status claims against live files.

Never call work complete from a build alone when behavior, data migration, or a paid external provider is involved.
