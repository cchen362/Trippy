# Trippy — Engineering Guidelines

**This is the single authoritative engineering guide for this repository.** It is read by every coding agent: Claude Code loads it via `CLAUDE.md`, Codex via `AGENTS.md`. Edit this file, never a per-tool wrapper — the wrappers exist only so each tool finds its way here.

## What This Is

Trippy is a private, mobile-first travel planning PWA for consolidating bookings, building a day-by-day itinerary, discovering places, navigating during a trip, and collaborating with an AI planning co-pilot.

Living product and architecture spec: `docs/superpowers/specs/2026-04-23-trippy-design.md`

## Source-of-Truth Order

When documents disagree, use this order:

1. Live code, migrations, tests, and runtime configuration.
2. This file for engineering constraints and repository conventions.
3. `docs/DECISIONS.md` for settled cross-tool decisions (external service tiers, quotas, closed follow-ups).
4. The living design/architecture spec for product boundaries and system shape.
5. Completed implementation plans for decision history and feature-specific detail.
6. Open implementation plans for intended future behavior only.

Do not describe planned work as shipped. Plans 1–14 are historical implementation records; always read their status headers.

## Settled Decisions — how they are marked

Some behaviour in this codebase looks arbitrary and is not. Those choices are **owner decisions**, and they are marked in two places:

- **In the code they govern**, as a comment citing the decision by its own id — `D-<plan>-<n>` for Plans 24 onward (e.g. `D-26-2` in the `deriveDayGeo` JSDoc, `D-27-1` in the discovery display path), or the plan's own notation for earlier plans (e.g. `Plan 9 D4`, `Plan 6 owner decision 1`). The marker sits in the same file as the behaviour, so it cannot drift out of sync with it. **A citation is only useful if it names its plan** — a bare `(D4)` sends the reader nowhere, so always qualify it.
- **In `docs/DECISIONS.md`**, for decisions with no single code home — external service tiers, quotas, "do not re-propose" rulings.

**Before proposing a change to existing behaviour, grep for a decision marker near the code you would touch:**

```bash
grep -rnE "D-[0-9]{2}-[0-9]+|Plan [0-9]+[A-Z]?( Wave [0-9]+)? (D|G|P)[0-9]+|owner decision|Plan [0-9]+[A-Z]? decision" <the file or directory>
```

The pattern has four alternates because the notation is genuinely not uniform, and it cannot be made uniform without breaking the rule below. `D-<plan>-<n>` catches Plans 24–27. `Plan <n> [Wave <n>] D<n>` catches the plans that numbered their own decisions (`D`, and also `G` in Plan 12, `P` in Plan 13). `owner decision` and `Plan <n> decision` catch the plans that wrote them out in prose (Plans 6, 7, 20).

**Keep a citation on one line.** This grep is line-based, so a marker whose id wraps mid-citation (`… Plan 9 Wave 3` / `D5) …`) is invisible to it even though the comment is perfectly correct. When a citation would wrap, break the line before it instead.

If you find one, the decision **stands** until the owner reopens it. Surface it and ask; do not draft a plan that silently reverses it. Explaining *why* the decision was made is welcome — reversing it unasked is not.

Coverage is honest, not universal: markers span Plans 2A–27 — **74 marker lines across 38 of 179 source files**, measured 2026-07-30, after the Plan 1–23 backfill. Plans **2, 4, 5, 16, and 23** carry no code marker (their decisions were judged self-evident from the code, scope/process notes, or superseded), and the backfill deliberately marked only decisions where *behaviour looks arbitrary and is not* — roughly a third of the ~91 decision notations in Plans 1–23. So the absence of a marker is **not** evidence that a design is open — check the plan doc and `docs/DECISIONS.md` too. When a wave settles something new, stamp the marker as part of that wave.

**Notation for pre-Plan-24 decisions (owner ruling):** use **the plan's own notation verbatim** — `Plan 6 owner decision 3`, `Plan 17 D2`, `Plan 20 decision (c)`. Do **not** retrofit a `D-<plan>-<n>` id onto a plan that never used one: the marker's job is to send a reader to the real decision, and an invented id points at a reference the plan doesn't contain. This is why the grep above carries four alternates instead of one — the ragged notation is the cost of every marker resolving to something real, and it was paid deliberately.

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
- **Expenses is a real route that is deliberately not in the bottom nav.** `/trips/:tripId/expenses` (`ExpensesTab`, migration 031, Plans 19–20) is reached from within the trip, not from a nav slot — the four-slot count above is correct and expenses is the documented exception, not an oversight. Its store stays **per-route and is never lifted into `TripPage`** (owner decision, Plan 20: a ~700ms FX budget would otherwise be paid on every trip screen). See `docs/DECISIONS.md`.
- `TripPage.jsx` is the authenticated trip shell. It owns trip, stop, booking, discovery, and co-pilot state and supplies tab pages through outlet context.
- **Outlet-context and error-channel contract (Plan 21).** Trip *data* (`useTrip`) is flat-spread into the outlet context; *action hooks* (`useStops`, `useBookings`) are namespaced as `stopActions`/`bookingActions` and must never be flat-spread — two hooks return identically-shaped `{ saving, error }`, so a later spread silently clobbers an earlier one. Do not namespace as `stops`/`bookings`; `bookings` is already the trip data array. A mutation failure has exactly one owner: pass `onError` at hook construction to route it to `TripPage`'s shared page banner, or handle the rejection locally to own it — never both. `useStops` opts in (`onError: reportError`); `useBookings` does not (its three modals render their own inline errors). Hooks keep rethrowing from `run()` so `await`/`catch` call sites still work; they do not hold latched `error` state for something else to read.
- Server communication belongs in `frontend/src/services/`; reusable stateful behavior belongs in `hooks/`; route-level composition belongs in `pages/`; shared UI belongs in domain folders under `components/`.
- The app is JavaScript/JSX, not TypeScript. Do not invent a `types/` layer unless a deliberate TypeScript migration is approved.
- The PWA uses `vite-plugin-pwa`. Treat cached reads as a resilience layer, not as a separate offline-write architecture.
- **Trips Home covers and status (Plan 22).** Trip index cards are **cartographic, not photographic**: `TripCard` renders a `TripRouteCover` inline-SVG route diagram (faint graticule, one gold route, DM Mono city labels) from the trip's `destinationsGeo` — no photo, no map tiles, no raster, no external request, no API cost. Photography stays reserved for place/experience cards (discovery, stops). The cover degrades by located-node count: `≥2` → route, `1` → single node, `0` → a typographic fallback (the gold hairline lives in `TripCard`'s copy layer *above* the legibility overlay, since `TripRouteCover` returns `null` for zero geo). Air-vs-ground is inferred frontend from `countryCode` clustering (dashed lofted arc between clusters, solid curve within). Status is a **bare line, never a bordered pill**: active `● Active now` (gold pulse dot, reduced-motion-safe), upcoming a humane countdown computed from `startDate` via `formatCountdown` (never the server `status`), past **silent**. Past trips subordinate cartographically — the card dims and the route loses gold (muted cream), the only visual language carrying both which-trip and how-alive. On Trips Home (`!inTrip`) `BottomNav` renders **only the Trips slot** (the disabled-tab branch was removed as dead code); the full four-slot nav returns inside a trip. `destinationsGeo: [{ name, countryCode, lat, lng, coordinateSystem }]` is **additive read-only derived output** on `GET /api/trips`, ordered identically to `destinations` — `lat/lng` may be `null` (a handled value, never a render error) and coordinate-system provenance (GCJ-02 vs WGS-84) is preserved end to end. No migration; not persisted.

### Backend

- `backend/src/index.js` is the composition root: middleware, `/api` route mounting, production static serving, SPA fallback, and the terminal error handler.
- Route files validate HTTP input and access; service files own business logic and orchestration; `db/` owns the connection, ordered migrations, and catalogue queries.
- Access is enforced through `requireAuth`, `requireAdmin`, `requireTripAccess`, and the day/stop/booking ownership helpers. Never trust an object id without proving it belongs to a trip the current user can access.
- SQLite uses WAL mode, foreign keys, and ordered `.sql`/`.js` migrations recorded in **`_migrations`** (the table is `_migrations`, not `schema_migrations` — in dev and production alike). Both extensions run through the same ordered runner: several tables (`discovery_destinations`/`discovery_places` in 016, `trip_scopes` in 023) are created by `.js` migrations, so never conclude a table is missing by grepping `*.sql` alone. The next migration must be additive and use the next free sequence number — **033**, as 032 is the highest applied.
- External I/O is asynchronous, but database writes remain synchronous through `better-sqlite3`. Multi-row or proposal-apply changes that must succeed together belong in a transaction.

### Domain Model and Geography

- `trips` stores trip metadata, preferences, and dates. Persisted `destinations` and `destination_countries` arrays were retired by migration 015; never restore them as competing truth.
- `trip_scopes` stores user-selected planning scopes. Trip destination summaries are derived by merging those scopes with day-level geography.
- **A day's effective geography resolves through a fixed five-layer precedence — this ladder is settled design, not an implementation detail to re-derive.** In order: (1) manual day override, (2) hotel booking active that night, (3) last same-day transit arrival, (4) previous day's resolved pair, (5) seeded `day.city`. City and country are picked **independently**, each taking the first layer that has a non-null value, so they legitimately come from different layers (override says "Melaka", hotel says `MY`). Owner decision D-26-2 (Plan 26 W4.1) re-affirmed the precedence as unchanged; Plans 6, 8, and 9 W3 D5 established and refined it. Before proposing any change to the layering, read the JSDoc block above `deriveDayGeo` in `backend/src/services/trips.js` — it documents each layer's tie-break rules and the reasoning, and it is the authority. Use that shared derivation and the mirrored frontend helpers; do not infer geography ad hoc from a trip title or the first destination.
- Stops carry resolution provenance, coordinate system, confidence/status, country, provider id, and photo provenance. Preserve user-confirmed pins and user-selected photos when updating unrelated fields.
- Mainland-China provider coordinates may be GCJ-02; stored/display coordinates and deep links must pass through the existing coordinate utilities. Map configuration is selected per day when country context exists, with a trip-level fallback.

### Bookings, Capture, and Documents

- Bookings support flight, hotel, train, and flexible other types through normalized columns plus `details_json`. Booking-linked timeline stops are synchronized by backend services.
- Channel-agnostic capture stores uploaded text/images/PDFs as `import_artifacts` and `import_artifact_files`, extracts structured bookings with Claude, then creates bookings only after confirmation.
- Booking attachments are private authenticated data. Public share responses deliberately omit logistics and attachment contents.
- Flight lookup may use AeroDataBox when configured; manual normalized prefill remains supported when it is not.

### Discovery and Photos

- Discovery is a normalized shared catalogue: `discovery_destinations` + `discovery_places`, keyed by canonical geography identity and country code. The old `discovery_cache` and `global_discovery_cache` tables are retired.
- Catalogue freshness is seven days. Fresh rows are reused; stale rows are refreshed and merged; explicit "show more" appends. Generation is daily-budgeted and place verification is resolver-budgeted.
- Discovery generation and photo descriptors use Haiku 4.5. Booking extraction and the co-pilot use Sonnet 4.6 unless a later, explicit model migration changes the live constants.
- Stop photos persist the Unsplash photo id, URL, attribution, query, scene type, and source. Displaying/selecting Unsplash results must retain attribution and download tracking. A stored photo is reused rather than fetched on every render.

### Co-Pilot

- The co-pilot streams over SSE from `POST /api/trips/:tripId/copilot` and persists conversation history.
- It can query the discovery catalogue and deterministic trip-health checks through a bounded server-side tool loop.
- It never mutates the itinerary directly from prose. Claude proposes typed operations; the server validates and persists a `copilot_proposals` record; the user explicitly applies or rejects it. Apply is atomic and protected by a trip fingerprint against stale changes.
- The UI is a partial/expanded bottom sheet. Preserve manual expand/dismiss behavior, internal scrolling, and the distinct mobile-drag versus desktop-control interaction.
- Current conversation context is the most recent **`COPILOT_MESSAGE_WINDOW = 50`** messages (`backend/src/routes/copilot.js:24`, used by both the history endpoint and the streaming turn) plus the serialized trip in an ephemeral-cached system block. Read the constant rather than quoting a number — it drives prompt-cache stability and per-turn cost. Per-message UI context is persisted and injected into user turns; durable conversation summaries and selective trip serialization remain reviewed future work.

---

## Design & Aesthetic Rules

**Refer to:** `docs/superpowers/specs/2026-04-23-trippy-design.md` §12 for the implemented design language.

**`frontend/src/index.css` is the single source of truth for design tokens** — it is the only stylesheet the running app loads, so its `:root` values are what ship. **Read that file directly for every token value; no other file, this one included, carries a copy.** `docs/superpowers/mockups/trippy-revamped-system.css` is a design **input**, not loaded by the app; it is the owner-blessed reference the shared tokens were reconciled *toward*. As of the 2026-07-22 token-reconciliation session the two files agree on shared tokens. When they next diverge, index.css wins for anything that ships — never copy a mockup value into production without verifying it in the app at 375px and desktop. The external Luxury Dark Design System package and other files under `docs/superpowers/mockups/` remain design inputs only; do not silently replace production tokens or component behavior from a mockup.

**No AI Slop.**
- No Inter, Roboto, Arial, or system-ui as the primary font
- No purple gradients on white/dark backgrounds as a default reach
- No generic card layouts that could belong to any SaaS dashboard
- No clichéd color schemes — commit to the palette defined in `index.css`

**The palette is fixed. Do not deviate.** The token *inventory* — read `frontend/src/index.css` `:root` for the values:

- Surfaces: `--ink-deep` (primary background), `--ink-mid` (cards), `--ink-surface` (elevated)
- Hairlines: `--ink-border` (cream-based, **not** white)
- Accent: `--gold` (single accent, once per component), `--gold-soft` (gold fill), `--gold-line` (gold border)
- Text: `--cream` (primary), `--cream-dim` (secondary), `--cream-mute` (muted/label)
- Route-cover material: `--ink-border-strong`, `--ink-satin`, `--shadow-deep`, `--radius-l`
- Obsidian booking-card material: `--obsidian-*`, `--foil`

The five alpha tokens (`--ink-border`, `--gold-soft`, `--gold-line`, `--cream-dim`, `--cream-mute`) were reconciled to the revamped values on 2026-07-22; flipping any of them restyles every screen.

**Consume tokens via `var(--token)`, never a baked rgba literal** (this holds for JSX inline styles too — `style={{ color: 'var(--cream-dim)' }}` works). Hardcoding a token's current value forks it: when the token flips, the literal diverges and drifts off-palette. Deliberate one-off alphas that are *not* a shared token (e.g. discovery's local gold ramp, a component's tuned fill/border pairing) may stay literal — but anything serving a shared token's role must reference the token.

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

Check `docs/DECISIONS.md` before proposing any change to a paid provider's tier, quota, or resolver strategy — several of these are settled and explicitly closed.

- Anthropic: reuse a fresh discovery catalogue; preserve prompt-cache stability; do not add model calls for deterministic work.
- Unsplash: persist selected photo metadata, retain attribution, and call the required download-tracking endpoint. Never re-fetch a stored selection merely to render it.
- Google Places: use one session token across autocomplete and the completing details request. Request only fields the workflow needs.
- Place resolution: use the shared cache and resolver pipeline. Respect Nominatim pacing and discovery resolver budgets.
- AeroDataBox: do not poll flight status on render. Preserve the existing client cache/manual refresh behavior.
- MapTiler is optional; OSM is the default fallback, Amap is used for mainland China, and Naver is the Korean deep-link provider.

## File Conventions

Directory roles are documented where they live — read `frontend/src/` and `backend/src/` for the layout. The conventions that the layout alone would not teach:

- Keep one primary exported component per component file.
- Before creating a helper, search both frontend and backend for an existing domain equivalent.
- Route files validate; service files decide; `db/` owns schema access. Do not let business logic leak into a route handler.

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

## Recording Decisions

When a session settles something durable that another agent could otherwise re-litigate — an external service tier or quota, a "do not re-propose" ruling, a resolved follow-up, a deliberate non-fix — append it to `docs/DECISIONS.md` in the same commit. Agent-private memory stores are not shared between tools; anything only recorded there is invisible to the next agent and will drift.
