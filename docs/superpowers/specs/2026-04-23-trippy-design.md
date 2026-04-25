# Trippy — Design Specification
**Date:** 2026-04-23
**Status:** Approved for implementation planning

---

## 1. Problem Statement

Travel bookings are scattered across multiple platforms (Singapore Airlines, Booking.com, Agoda, Trip.com, hotel loyalty sites). There is no single place that consolidates logistics AND helps plan the experience around those bookings. Existing AI travel tools only organise what the user already knows — they don't proactively surface what the user *didn't know to ask for*.

Trippy solves both: a **logistics consolidation hub** (one place for all booking confirmations) and an **intelligent planning co-pilot** (discovery layer + contextual NL editing).

---

## 2. Target Users

- Small, invite-only user base (personal use + close circle)
- Admin controls who has access via invite code system
- Multi-user with trip collaboration (co-travelers can co-edit; read-only share links for others)
- Primary device: mobile (PWA, installed to home screen via Safari/Chrome)
- Secondary: desktop browser

---

## 3. Technical Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | React (Vite) + Tailwind CSS | As specified; Vite for fast dev/build |
| Backend | Node.js (Express) | Full JS stack, consistent with frontend |
| Database | SQLite (better-sqlite3) | Sufficient for small user base, file-based backup, proven pattern |
| Auth | Invite-code + username/password | Same pattern as AI-HTML-Builder (Python→Node port) |
| AI | Anthropic Claude Sonnet 4.6 | Web search tool for discovery; streaming for co-pilot chat |
| Maps | Leaflet + react-leaflet | Provider-agnostic; Amap tiles for China, OSM/MapTiler elsewhere |
| Photos | Unsplash API | Free, high quality, searched by stop/city name |
| Deployment | Docker container on Debian server | PWA served via HTTPS; single-file SQLite volume mount |

---

## 4. Authentication

Identical pattern to AI-HTML-Builder, ported to Node.js/Express:

- **First launch:** Admin setup page (creates first user + generates invite code)
- **Registration:** Username + password + shared invite code (8-char alphanumeric)
- **Login:** Username + password → httpOnly cookie session (30-day expiry)
- **Admin panel:** View/regenerate invite code; list and remove users
- **Session validation:** Middleware checks cookie on all protected routes

---

## 5. Navigation Architecture

### 5.1 Two-level navigation

**Level 1 — Trips Home** (bottom tab: Trips active)
- Lists all trips grouped by status: Active, Upcoming, Past
- Each trip is a full-bleed photo card with trip name, dates, status badge
- "Active" trip has gold border + ACTIVE badge
- "+ New Trip" button at bottom of list
- On app launch: if an active trip exists (dates overlap today), open directly to that trip's Plan view on today's day — skipping Trips Home

**Level 2 — Inside a Trip** (bottom tabs: Plan / Logistics / Map active; Trips tab dimmed but tappable)
- Top bar: `← Trips` back button + trip name
- All three inner tabs are scoped to the open trip's data
- Floating co-pilot chat button (bottom-right FAB) available on all inner tabs

### 5.2 Bottom navigation tabs

| Tab | Where active | Content |
|---|---|---|
| Trips | Trips Home | All trips list |
| Plan | Inside trip | Day timeline view |
| Logistics | Inside trip | Bookings dashboard |
| Map | Inside trip | Per-day map |
| 💬 FAB | Inside trip (all) | Co-pilot chat slide-up |

---

## 6. Data Architecture

### 6.1 SQLite schema (key tables)

```
users               id, username, password_hash, display_name, is_admin, created_at
auth_sessions       id, user_id, token, created_at, expires_at
settings            key, value  (invite_code, etc.)

trips               id, title, owner_id, start_date, end_date, travellers, status, created_at
trip_collaborators  trip_id, user_id, role (editor | viewer)
share_links         id, trip_id, token, created_at (read-only public links)

days                id, trip_id, date, city, phase, hotel, theme, color_code
stops               id, day_id, booking_id (nullable FK), time, title, type, note, lat, lng,
                    unsplash_photo_url, estimated_cost, booking_required, best_time,
                    duration, sort_order, is_featured (bool)

bookings            id, trip_id, type (flight|hotel|train|ferry|car), title,
                    confirmation_ref, booking_source, start_datetime, end_datetime,
                    origin, destination, terminal_or_station, details_json, created_at

discovery_cache     id, trip_id, destination, interest_tags, pace, result_json,
                    fetched_at  (TTL: 48 hours)

copilot_messages    id, trip_id, user_id, role (user|assistant), content, created_at
```

### 6.2 Booking types and key fields

| Type | Key fields |
|---|---|
| Flight | airline, flight_number, departure_time, arrival_time, origin_iata, dest_iata, terminal, booking_ref, booked_via |
| Hotel | hotel_name, check_in_date, check_out_date, nights, address, booking_ref, booked_via |
| Train | train_number, departure_time, arrival_time, origin_station, dest_station, seat_class, booking_ref, booked_via |
| Ferry / Car / Other | flexible via details_json |

---

## 7. Features

### 7.1 Trip Setup Flow

1. Create trip: name, destination(s), dates, traveller profile, interest tags, pace preference
2. Optionally add logistics bookings immediately (or add later)
3. Discovery layer runs (Claude API + web search) for each destination
4. Skeleton itinerary generated, grouped by day and geographic proximity
5. User refines via drag-and-drop or co-pilot chat

### 7.2 Trips Home Screen

- Full-bleed photo cards per trip (Unsplash: search `"${destination} travel"`)
- Status: Active (dates overlap today) / Upcoming / Past
- Past trips subtly dimmed (reduced opacity overlay)
- Active trip auto-opens on app launch to today's Plan view

### 7.3 Day Timeline View (Plan tab)

- Horizontal day tab strip: abbreviated date (e.g. `Wed 11`)
- Day header: eyebrow (city + day count), Playfair Display italic city name, date + stop count
- Timeline:
  - **Transit stops:** inline italic text only — no card, no photo. Subordinated visually (dim color, `font-style: italic`)
  - **All other stops:** full-bleed photo card with left-to-right gradient overlay (text on dense left, photo breathes right)
  - Node dots on timeline line: filled gold for experience stops, hollow for next, dim for transit
- Photo cards: two heights — standard (72px) and featured (100px, for key stops)
- Photo sourcing per stop:
  - Attraction/experience: search stop name (e.g. "Hongya Cave Chongqing")
  - Food: search stop name or fallback to city + cuisine
  - Hotel: search hotel name
  - Transit: search **destination** city/station — apply `filter: grayscale(1)` via CSS
  - Day variety: use day index as offset into Unsplash results array (same city, different photo per day)
- Stops can be reordered via drag-and-drop
- Tap stop card → expands to full detail view (notes, practical info, map pin, open-in-maps button)

### 7.4 Logistics Dashboard (Logistics tab)

- Header: "Your Bookings" + count + number of booking sources
- Booking type sections: Flights, Trains, Hotels, Other
- Each booking: mini card showing type icon, title, date, confirmation ref (gold), booked-via source
- Tap booking card → full detail view with all fields
- Add booking:
  - **Hotels/Attractions:** name search with autocomplete (Google Places API — sufficient for international hotels)
  - **Flights:** airline + flight number lookup, or manual entry
  - **Trains:** manual entry (origin, destination, train number, time)
  - **All types:** confirmation ref field always present
- Auto-insert into day timeline: when a booking is added, it's placed chronologically into the correct day by datetime. Ordering logic: sort by `start_datetime`, hotel check-in defaults to 15:00 if no time given.
- **Edit booking:** tapping a card opens a detail sheet; an "Edit Booking" button opens the Add Booking modal pre-populated with the existing data. Type cannot be changed during edit.

#### 7.4.1 Booking card anatomies

These define the bespoke per-type card designs. Do **not** revert to a single generic card.

**Flight card — ticket-stub metaphor**
- Outer shape: `ticket-stub` CSS class for left/right semicircular notch cut-outs (CSS mask). No border — surface contrast against `--ink-deep` body provides the edge.
- Eyebrow (gold, mono 11px): `{AIRLINE NAME} · {CARRIER}{NUMBER}` (e.g. `SINGAPORE AIRLINES · SQ848`). This is the **one gold element** on this card.
- Dashed fold line below eyebrow (`ticket-fold` class, gold at 22% alpha).
- Hero row: left IATA code / right IATA code in Playfair Display italic (`text-4xl sm:text-5xl lg:text-6xl`), center flight number in DM Mono. ◆ diamonds flanking the center glyph are hidden below `sm` breakpoint to fit 375px.
- Time row: departure time left / arrival time right in DM Mono (`text-2xl sm:text-3xl`). Label below each time: `DEPART · {IATA}` / `ARRIVE · {IATA}` in DM Mono 11px cream-mute. Date below that in Cormorant Garamond italic small.
- Footer (dashed fold line above): `BOOKING REF` label left (cream-mute) / confirmation ref right (cream). The confirmation ref is **cream, not gold** — the eyebrow airline line is already the gold usage.
- IATA codes derived from: `detailsJson.providerPayload.departure.airport.iata` → fallback `iataFromOriginString(booking.origin)`.

**Hotel / Accommodation card — concierge card metaphor**
- Shape: standard `rounded-xl` with 1px `--ink-border` hairline. No notch mask.
- Eyebrow (cream-mute, mono 11px): literal `ACCOMMODATION`.
- Title: hotel name in Playfair Display italic (`text-2xl sm:text-3xl`), cream.
- Labeled rows below title, each separated by `.hairline-row` (gold at 12% alpha):
  - `CHECK-IN` / formatted date (e.g. `Wed 11 Jun`)
  - `CHECK-OUT` / formatted date + computed nights (e.g. `Mon 16 Jun · 5 nights`)
  - `BOOKED VIA` / booking source — row hidden if empty
  - `CONFIRMATION` / confirmation ref in **gold** (the one gold element on this card) — row hidden if empty
- Nights computed client-side from `startDatetime`/`endDatetime` via `computeNights()`.

**Train card — ticket-stub metaphor (same primitive as flight)**
- Uses `TicketStubCard` primitive. Eyebrow: `{ORIGIN CITY} → {DEST CITY} · {TRAIN NUMBER}`.
- Left/right codes are abbreviated station names (`CHENGDU E.`) at `text-2xl sm:text-3xl lg:text-4xl` — station names are longer than IATA codes.
- Center glyph: train number only (no ◆ diamonds, since station abbreviations already carry meaning).
- Footer: seat class left (if present) / booking ref right in **gold** (the one gold element).

**Other card — minimal concierge card**
- Same shape as hotel. Eyebrow: `booking.type.toUpperCase()` (e.g. `FERRY`, `CAR RENTAL`).
- Rows: `WHEN` (date range or start), `WHERE` (destination), `CONFIRMATION` (gold). All optional.

**Implementation files:** `TicketStubCard.jsx` (primitive), `FlightBookingCard.jsx`, `TrainBookingCard.jsx`, `HotelBookingCard.jsx`, `OtherBookingCard.jsx`, `bookingCardUtils.js` (helpers: `formatShortDate`, `formatTime`, `computeNights`, `iataFromOriginString`).

**🚩 NEXT-SESSION PRIORITY:** Times currently render in the viewer's local timezone. Correct fix requires storing `origin_tz` / `destination_tz` per booking (IANA zone), sourced from AeroDataBox payload for flights and Google Places for hotels. The `formatTime`/`formatShortDate` helpers already accept an optional `tz` param for this upgrade. See migration `007_booking_timezones.sql`.

### 7.5 Map View (Map tab)

- Per-day map: all stops for the active day shown as pins
- Region-aware tile provider via `Leaflet.ChineseTmsProviders`:
  - China (CN): Amap tile layer (no API key needed for tiles, GCJ-02 coordinate system handled)
  - All other regions: OpenStreetMap or MapTiler tiles
- Region detection: based on trip destination country code
- Per-stop deep-link buttons: "Open in Google Maps" / "Open in Amap" / "Open in Naver" based on region
- Metro/transit overlay: future enhancement (v2)

### 7.6 Co-pilot Chat (FAB → slide-up panel)

- Full-height slide-up panel from bottom
- Persistent chat history per trip, stored in `copilot_messages` table
- Context injected automatically: full trip itinerary JSON + current day
- Handles contextual, multi-day requests:
  - "I visited Wenshu Monastery today — give me alternatives for tomorrow"
  - "It's raining, adjust today to mostly indoor"
  - "Add a good hotpot dinner after Wuhou Shrine"
  - "What's near Ciqikou I haven't added yet?"
- Claude interprets request → responds with explanation + proposed itinerary changes
- User confirms changes → itinerary JSON updated → timeline re-renders
- Streaming responses for perceived speed
- Undo support: last N itinerary states stored in memory per session

### 7.7 Discovery Panel

- Triggered during trip creation OR via "Discover" button inside Plan view
- Claude API + web search tool: queries for current, real information per destination
- Results grouped: Culture & History / Food & Drink / Nature / Nightlife / Hidden Gems
- Each suggestion: name, short description, why it matches traveller profile, estimated duration, opening hours
- "Surprise me" button: surfaces lesser-known spots
- User can: drag suggestion into timeline, dismiss, or save for later
- Results cached in `discovery_cache` table (TTL: 48 hours per destination + interest tag combination)

### 7.8 Collaboration & Sharing

- Trip owner can invite collaborators by username → they get editor access to that trip
- Read-only share link: generates a token URL → anyone with link can view (no account needed)
- Share link view: read-only itinerary, no edit controls, no logistics details (privacy)

### 7.9 Export (v1 scope)

- Read-only share link only (as above)
- PDF and JSON export: v2

---

## 8. Visual Design Language

### 8.1 Theme: Dark Ink Wash × Luxury

Inspired by: W Hotels typographic confidence × Waldorf Astoria restraint.

### 8.2 Colour palette

```css
--ink-deep:    #0d0b09   /* primary background — warm near-black, not pure black */
--ink-mid:     #1c1a17   /* card backgrounds */
--ink-surface: #232018   /* elevated surfaces */
--ink-border:  rgba(255,255,255,0.07)
--gold:        #c9a84c   /* single accent — used once per component */
--gold-soft:   rgba(201,168,76,0.12)
--gold-line:   rgba(201,168,76,0.28)
--cream:       #f0ead8   /* primary text */
--cream-dim:   rgba(240,234,216,0.60)
--cream-mute:  rgba(240,234,216,0.28)
```

### 8.3 Typography

| Role | Font | Weight/Style |
|---|---|---|
| City / place names | Playfair Display | 400 Italic |
| Section titles | Playfair Display | 400 Italic |
| Body / notes | Cormorant Garamond | 400, 300 |
| All UI labels, times, refs | DM Mono | 400 |
| Stop type badges | DM Mono | 400, uppercase, letter-spacing |

All three fonts loaded via Google Fonts. No system fonts in the UI chrome.

### 8.4 Photography treatment

- Full-bleed within card bounds — `object-fit: cover`
- Gradient overlay: `linear-gradient(100deg, rgba(13,11,9,0.92) 0%, rgba(13,11,9,0.30) 65%, rgba(13,11,9,0.05) 100%)`
- Text always on the dense (left) side of gradient
- Transit stops: same gradient but `filter: grayscale(1)` on photo + denser overlay
- Day-to-day variety: offset into Unsplash results array by day index

### 8.5 Stop card visual hierarchy

1. **Transit** — no card, no photo. Inline italic text, dim colour. Journey between experiences.
2. **Standard stop** — compact card (72px), full-bleed photo, type badge + name + detail
3. **Featured stop** — tall card (100px), same treatment, used for key experiences

### 8.6 Art Deco micro-details

- Gold horizontal rule (20px wide) above day city name
- `◆` dividers on flight cards between departure/arrival sections
- Corner radius: cards use 10–12px (never 0, never >16px)
- Thin rule lines (`1px solid var(--ink-border)`) between timeline sections
- Gold dot (3px) beneath active nav item

### 8.7 Motion

- Page load: staggered reveal of stop cards (`animation-delay` incrementing per stop)
- Co-pilot slide-up: spring easing via Motion library
- Day tab switch: cross-fade timeline content
- Stop card expand: smooth height animation
- All transitions: prefer CSS where possible; Motion library for complex sequences

---

## 9. API Integration

### 9.1 Claude API — Discovery

```
Model: claude-sonnet-4-6
Tools: web_search
System prompt: includes destination, dates, traveller profile, interest tags, pace
Caching: results stored in discovery_cache, keyed by (trip_id, destination, interest_hash)
TTL: 48 hours
```

### 9.2 Claude API — Co-pilot Chat

```
Model: claude-sonnet-4-6
Streaming: yes (SSE)
Context: full itinerary JSON + copilot_messages history (last 20 messages)
On confirmed change: backend updates stops table, returns updated day JSON
```

### 9.3 Unsplash API

```
Endpoint: /search/photos?query={stop_name}&per_page=10
Cache: photo URL stored on stop record in DB after first fetch
Day variety: result[dayIndex % results.length]
Fallback: search city name if stop name returns 0 results
Transit: add grayscale CSS class, no API change needed
```

### 9.4 Google Places Autocomplete

```
Used for: hotel name search when adding logistics bookings
Scope: hotel/establishment type filter
China coverage: sufficient for international brand hotels (Waldorf, Regent, W, etc.)
Cost: ~$0.003/session (autocomplete session token), acceptable for low usage
```

---

## 10. Map Strategy

| Region | Tile Provider | Coordinate System | Deep-link |
|---|---|---|---|
| China (CN) | Amap via Leaflet.ChineseTmsProviders | GCJ-02 (handled by plugin) | amap.com / Amap app |
| South Korea (KR) | OpenStreetMap (Naver deep-link only) | WGS-84 | Naver Maps |
| All others | OpenStreetMap or MapTiler | WGS-84 | Google Maps |

Region detection: `trip.destination_country` field set during trip creation.

Note: Amap JS API requires Chinese phone for registration. **Tile-only access via Leaflet.ChineseTmsProviders requires no API key** — tiles are consumed directly. Routing in China falls back to deep-link (open Amap app).

---

## 11. PWA Configuration

```json
manifest.json:
  name: "Trippy"
  display: "standalone"
  theme_color: "#0d0b09"
  background_color: "#0d0b09"
  icons: [192px, 512px]

Service Worker:
  - Cache app shell (HTML, JS, CSS, fonts) for offline
  - Cache itinerary JSON per trip for offline viewing
  - Network-first for API calls; cache fallback for read operations
```

---

## 12. Build Sequence (Layer by Layer)

1. **Project scaffold** — Vite + React + Tailwind, Express backend, SQLite, Docker setup
2. **Auth layer** — invite-code system, login/register, session middleware, admin panel
3. **Data layer** — SQLite schema, seed data (Chengdu/Chongqing trip), REST API endpoints
4. **Trips home + trip creation** — trips list UI, create trip flow, trip card design
5. **Day timeline** — stop cards with full-bleed photo treatment, Unsplash integration
6. **Logistics dashboard** — booking cards, add booking forms, auto-insert into timeline
7. **Map view** — Leaflet + react-leaflet, region-aware tile provider, deep-link buttons
8. **Discovery panel** — Claude API + web search, results UI, drag-to-timeline
9. **Co-pilot chat** — FAB, slide-up panel, streaming responses, itinerary mutation
10. **Collaboration** — trip invites, read-only share links
11. **PWA** — manifest, service worker, offline support
12. **Polish** — Motion animations, staggered reveals, micro-interactions

---

## 13. Out of Scope (v1)

- PDF / JSON export (v2)
- Metro/transit map overlay (v2)
- Real-time collaborative editing (async collaboration only in v1)
- Amap routing API (deep-link to native app instead)
- Weather integration
- Currency converter
- Offline map tiles (online-only map in v1; itinerary data cached offline)
