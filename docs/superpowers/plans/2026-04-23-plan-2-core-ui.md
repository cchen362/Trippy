# Plan 2: Core UI — Trips Home, Day Timeline, Logistics Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full working UI for the three primary views — Trips Home (trip cards), Day Timeline (stop cards with full-bleed Unsplash photos), and Logistics Dashboard (booking cards) — with REST API endpoints backing all views.

**Prerequisite:** Plan 1 complete and verified.

**Architecture:** React Router for navigation. Two-level nav: Trips Home (Trips tab active) → inside trip (Plan/Logistics/Map tabs). Express REST endpoints for trips, days, stops, bookings. Unsplash photo fetch on stop creation, URL cached in DB.

**Tech Stack:** React Router v6, react-beautiful-dnd (drag-to-reorder stops), Motion (framer-motion) for animations, Unsplash API, Google Places Autocomplete

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

**Verification checklist:**
- [ ] Trips home shows seed trip card with Unsplash photo
- [ ] Tapping trip → opens Plan tab on correct day
- [ ] Stop cards show full-bleed photos with gradient overlay
- [ ] Transit stops render as inline italic text (no card)
- [ ] Logistics tab lists all bookings with confirmation refs
- [ ] Adding a hotel booking auto-inserts it into the correct day timeline
- [ ] Drag-to-reorder stops persists after page refresh
- [ ] All views responsive at 375px (mobile) and 1280px (desktop)

**Next:** [Plan 3 — Map, Discovery Panel, Co-pilot Chat](./2026-04-23-plan-3-ai-maps.md)
