# Plan 2: Core UI — Trips Home, Day Timeline, Logistics Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full working UI for the three primary views — Trips Home (trip cards), Day Timeline (stop cards with full-bleed Unsplash photos), and Logistics Dashboard (booking cards) — with REST API endpoints backing all views.

**Prerequisite:** Plan 1 complete and verified.

**Architecture:** React Router for navigation. Two-level nav: Trips Home (Trips tab active) → inside trip (Plan/Logistics/Map tabs). Express REST endpoints for trips, days, stops, bookings. Unsplash photo fetch on stop creation, URL cached in DB.

**Tech Stack:** React Router v6, Motion (framer-motion) for animations and drag-to-reorder, Unsplash API, Google Places Autocomplete

**Design spec:** `docs/superpowers/specs/2026-04-23-trippy-design.md` — §5 Navigation, §7.2–7.4, §8 Visual Design

---

## File Map

```
/backend/src/
  routes/
    trips.js          # CRUD for trips, collaborators, share links
    days.js           # GET days for a trip
    stops.js          # CRUD stops, reorder
    bookings.js       # CRUD bookings, auto-insert into timeline
  services/
    trips.js          # business logic
    stops.js          # stop ordering, booking auto-insert
    unsplash.js       # photo fetch + cache
  middleware/
    tripAccess.js     # verify user can access/edit trip

/frontend/src/
  pages/
    TripsHomePage.jsx         # trips list
    TripPage.jsx              # shell: top bar + tab nav
    PlanTab.jsx               # day timeline
    LogisticsTab.jsx          # bookings dashboard
    MapTab.jsx                # placeholder for Plan 3
  components/
    nav/
      BottomNav.jsx
      TopBar.jsx
    trips/
      TripCard.jsx            # full-bleed photo card for trips list
      NewTripModal.jsx        # create trip form
    timeline/
      DayTabs.jsx
      DayHeader.jsx
      StopCard.jsx            # full-bleed photo card
      TransitStop.jsx         # inline italic transit row
      Timeline.jsx            # ordered list of stops/transits
    logistics/
      BookingCard.jsx
      AddBookingModal.jsx
    common/
      GoldRule.jsx
      LoadingScreen.jsx
  hooks/
    useTrip.js
    useStops.js
    useBookings.js
  services/
    tripsApi.js
    stopsApi.js
    bookingsApi.js
    unsplashService.js        # client-side Unsplash search
```

---

## Tasks (to be expanded by executing agent)

### Task 1: Backend — Trips + Days REST API
### Task 2: Backend — Stops REST API + Unsplash service
### Task 3: Backend — Bookings REST API + timeline auto-insert
### Task 4: Frontend — Bottom nav + routing shell
### Task 5: Frontend — Trips Home page + TripCard
### Task 6: Frontend — New Trip modal
### Task 7: Frontend — Day Timeline + StopCard with photos
### Task 8: Frontend — Logistics Dashboard + AddBooking modal
### Task 9: Staggered load animations (Motion)

---

## Implementation Record (2026-04-24)

This plan has now been implemented in the repo. The items below record what shipped and where implementation intentionally diverged from the original markdown so future work can build on repo truth rather than the older draft.

### Implemented

- Added protected backend routes for trips, days, stops, bookings, and lookups.
- Added trip access middleware for trip/day-scoped authorization.
- Added aggregate trip detail read endpoint returning `trip`, ordered `days`, embedded ordered `stops`, and `bookings`.
- Added trip creation flow that creates a full day skeleton for every date in the selected range.
- Added stop reorder persistence and booking-to-timeline auto-insert/update behavior.
- Added frontend router shell for `/trips`, `/trips/:tripId/plan`, `/trips/:tripId/logistics`, and `/trips/:tripId/map`.
- Added Trips Home, Plan, Logistics, and placeholder Map screens.
- Added hotel lookup UI via backend-proxied Google Places autocomplete.
- Added flight lookup UI path through `/api/lookups/flights`.
- Added backend tests covering trip creation/status, trip detail, stop reorder, booking sync, and lookup validation.

### Recorded Deviations From Original Plan

- Real flight data provider is deferred.
  - Current `/api/lookups/flights` returns a normalized manual-prefill response, not live airline data.
  - A real provider can be added later behind the same backend endpoint without rebuilding the frontend flow.
- Drag-to-reorder is implemented with Motion `Reorder`, not `react-beautiful-dnd`.
  - This keeps the drag interaction inside the animation stack already used by the UI.
- The aggregate trip payload embeds `stops` on each `day`.
  - The original plan allowed either embedded stops or `stopsByDay`; implementation chose embedded stops to simplify frontend rendering.
- Unsplash and Google Places are backend-proxied.
  - The original file map mentioned a client-side `unsplashService.js`; implementation keeps external keys server-side and exposes internal `/api/lookups/*` endpoints.
- Trip status is computed dynamically from trip dates at read time.
  - The stored `trips.status` column is not treated as the UI source of truth for Active / Upcoming / Past grouping.
- The Map tab is routeable but intentionally remains a styled placeholder for Plan 3.
- Stop and booking detail views are implemented inline as expanders/modals within the current pages, not separate routes.
- The existing seed trip is historical relative to the current implementation date, so it should render under `Past` rather than auto-open.
- Backend config validation is relaxed in `NODE_ENV=test` so automated tests can run without live third-party API keys.

### File Map Notes

- Backend additions:
  - `backend/src/routes/lookups.js`
  - `backend/src/services/bookings.js`
  - `backend/src/services/lookups.js`
  - `backend/src/services/stops.js`
  - `backend/src/services/trips.js`
  - `backend/src/services/unsplash.js`
  - `backend/src/middleware/tripAccess.js`
  - `backend/tests/core-ui.test.js`
- Frontend additions:
  - `frontend/src/hooks/useTrip.js`
  - `frontend/src/hooks/useStops.js`
  - `frontend/src/hooks/useBookings.js`
  - `frontend/src/services/tripsApi.js`
  - `frontend/src/services/stopsApi.js`
  - `frontend/src/services/bookingsApi.js`
  - `frontend/src/components/common/*`
  - `frontend/src/components/nav/*`
  - `frontend/src/components/trips/*`
  - `frontend/src/components/timeline/*`
  - `frontend/src/components/logistics/*`

**Verification checklist:**
- [ ] Trips home shows seed trip card with Unsplash photo
- [ ] Tapping trip → opens Plan tab on correct day
- [ ] Stop cards show full-bleed photos with gradient overlay
- [ ] Transit stops render as inline italic text (no card)
- [ ] Logistics tab lists all bookings with confirmation refs
- [ ] Adding a hotel booking auto-inserts it into the correct day timeline
- [ ] Drag-to-reorder stops persists after page refresh
- [ ] Flight lookup returns normalized manual-prefill data until a real provider is added
- [ ] All views responsive at 375px (mobile) and 1280px (desktop)

**Next:** [Plan 3 — Map, Discovery Panel, Co-pilot Chat](./2026-04-23-plan-3-ai-maps.md)
