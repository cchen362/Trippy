# Implementation Plan 1: Redesign Maps

> **For agentic workers:** Implement task-by-task. Keep coordinate correctness, manual place UX, booking interactions, and route visualization together; do not patch only the marker offset.

## Goal

Redesign the Maps feature so it reliably shows itinerary stops, supports manual places, handles China coordinate systems without Amap API, and visualizes day order with straight-line numbered connectors.

The current root cause is ambiguous coordinate handling: stops store plain `lat/lng`, while the frontend blindly converts all China coordinates from WGS-84 to GCJ-02 for Amap tiles. Some stored coordinates are already GCJ-02-like or AI-derived, causing a second offset of roughly 400-500m.

Amap API/geocoding is out of scope because API access/registration is not a dependable path. Use backend-cached no-key lookup and curated overrides instead.

Reference for no-key lookup limits: [OSMF Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/).

---

## Product Decisions

- Maps is a visual itinerary, not a navigation app.
- Route visualization is straight-line ordered connection only, not road/walking routing.
- Stop order on the map must match Plan timeline order.
- Users should not need to paste coordinates or map URLs in the normal flow.
- Manual place add should work by name, e.g. `Raffles City Chongqing`.
- Stops should not silently disappear from Map.
- Bookings and stops are different concepts:
  - **Stops** are itinerary/map items.
  - **Bookings** are logistics records.
  - A booking can optionally create or link to a stop.
- “Other” booking remains for logistics/reservations, not a replacement for manual place add.

---

## Data Model

Add a migration for stop location metadata.

- Add columns to `stops`:
  - `location_query TEXT`
  - `resolved_name TEXT`
  - `resolved_address TEXT`
  - `coordinate_system TEXT NOT NULL DEFAULT 'unknown'`
  - `coordinate_source TEXT`
  - `location_status TEXT NOT NULL DEFAULT 'unresolved'`
  - `location_confidence REAL`
  - `provider_id TEXT`
- Allowed `coordinate_system` values:
  - `wgs84`
  - `gcj02`
  - `unknown`
- Allowed `location_status` values:
  - `resolved`
  - `estimated`
  - `unresolved`
  - `user_confirmed`
- Allowed `coordinate_source` examples:
  - `seed`
  - `manual_lookup`
  - `discovery`
  - `copilot`
  - `booking`
  - `user_pin`
  - `cache`
  - `curated`

Add resolver cache table.

- `place_resolution_cache`
  - `id`
  - `query_key`
  - `query_text`
  - `city`
  - `country`
  - `provider`
  - `provider_id`
  - `name`
  - `address`
  - `lat`
  - `lng`
  - `coordinate_system`
  - `confidence`
  - `raw_json`
  - `created_at`
  - `updated_at`

Add curated place overrides.

- Store in code or DB seed initially.
- Include tested Chongqing places:
  - Hongya Cave / Hongyadong
  - Luohan Temple
  - Jiefangbei
  - Regent Chongqing
  - Raffles City Chongqing
  - Chaotianmen Dock
- Curated override coordinates must declare coordinate system explicitly.

---

## Backend Implementation

### Task 1: Coordinate Service — DONE

Create a backend coordinate service.

Responsibilities:
- `wgs84ToGcj02(lat, lng)`
- `gcj02ToWgs84(lat, lng)` using iterative approximation
- `toDisplayCoordinates(stop, mapConfig)`
- China bounds check
- never convert unknown coordinates blindly

Rules:
- For Amap display:
  - `wgs84` -> convert once to `gcj02`
  - `gcj02` -> passthrough
  - `unknown` -> passthrough only if `location_status === 'estimated'`, styled as estimated
- For non-China display:
  - `wgs84` -> passthrough
  - `gcj02` -> convert to WGS-84 if possible
  - `unknown` -> passthrough only as estimated

Remove frontend coordinate conversion from `TripMap.jsx`.

Progress:
- Implemented on branch `redesign-maps`.
- Commit: `ce4530e feat: add coordinate metadata foundation`.
- Added migration `008_stop_location_metadata.sql` with stop location metadata and `place_resolution_cache`.
- Added `backend/src/services/coordinates.js` with `isInChina`, `wgs84ToGcj02`, `gcj02ToWgs84`, and `toDisplayCoordinates`.
- Moved coordinate conversion out of `mapConfig.js`.
- Extended backend stop serialization to include location metadata fields.
- Commit: `1467005 fix: remove frontend map coordinate conversion`.
- Removed blind WGS-84 -> GCJ-02 conversion from `frontend/src/components/map/TripMap.jsx`.

Verification:
- `cmd /c npm test -- map.test.js migrations.test.js placeResolver.test.js` passed.
- `cmd /c npm run build` in `frontend` passed.

Rollback note:
- Development DB backup created before migration work: `backend/data/trippy.pre-redesign-maps.20260428-183955.db`.

### Task 2: Place Resolver — DONE

Create a backend place resolver used by manual add, Discovery, Copilot, and booking-linked stops.

Lookup order:
1. Curated overrides.
2. Existing `place_resolution_cache`.
3. Existing Discovery cache exact/near-exact place-name match.
4. Nominatim search from backend.
5. Unresolved fallback.

Nominatim requirements:
- Backend only.
- Add identifying User-Agent.
- Cache all successful and failed lookups.
- Rate limit to max 1 request/second across the app.
- Include attribution where map/place data is shown if OSM/Nominatim result is used.
- Use city context in query: `"{place}, {resolvedCity}, {country}"`.

Resolver output:
- `lat`
- `lng`
- `coordinateSystem`
- `coordinateSource`
- `locationStatus`
- `confidence`
- `resolvedName`
- `resolvedAddress`
- `providerId`

Confidence rules:
- curated exact match: `user_confirmed` or `resolved`, high confidence
- cache exact match: `resolved`
- Nominatim strong name/city match: `resolved`
- Nominatim weaker match: `estimated`
- no match: `unresolved`

Progress:
- Implemented on branch `redesign-maps`.
- Commit: `a1d15ae feat: add cached place resolver`.
- Added `backend/src/services/placeResolver.js`.
- Implemented lookup order: curated overrides -> `place_resolution_cache` -> `global_discovery_cache` exact/near-exact match -> backend Nominatim -> unresolved fallback.
- Added curated Chongqing overrides for Hongya Cave / Hongyadong, Luohan Temple, Jiefangbei, Regent Chongqing, Raffles City Chongqing, and Chaotianmen Dock, each with explicit `gcj02` coordinate metadata.
- Added `NOMINATIM_USER_AGENT` config with a local development fallback.
- Added backend-only Nominatim lookup with city/country query context, one-request-per-second process throttle, and caching for both successful and failed lookups.
- Added resolver tests for curated priority, cache hits avoiding network, Discovery cache reuse, failed lookup caching, and rate limiting.

Notes for later tasks:
- Task 2 created the resolver service but did not wire it into stop create/update, Discovery, Copilot, or bookings yet. That integration remains Task 3 and Task 6 scope.
- OSM/Nominatim attribution still needs to be surfaced wherever Nominatim-backed map/place data is displayed in later frontend/map-data tasks.

### Task 3: Stop Create/Update Integration — DONE

Update `createStop` and `updateStop`.

When creating a stop:
- If explicit coordinates are supplied with coordinate metadata, preserve them.
- If title/location query is supplied without coordinates, run resolver.
- For Discovery/Copilot coordinates, do not trust blindly:
  - if resolver confirms same/similar place, use resolver result;
  - otherwise mark as `estimated`, not `resolved`.
- Save `location_query` from the user-facing place text.

When updating title/location fields:
- Re-resolve only if the location query changed.
- Do not overwrite `user_confirmed` coordinates unless user explicitly requests re-resolve.

Progress:
- Implemented on branch `redesign-maps`.
- Stop create/update now writes location metadata and uses the backend place resolver instead of trusting raw coordinates.
- Explicit coordinates are preserved only when trusted coordinate metadata is supplied.
- Discovery/Copilot coordinates remain conservative: backend confirmation can replace them; otherwise they are marked `estimated`.
- User-confirmed coordinates are protected from normal title/note edits unless `reResolveLocation` is explicitly requested.
- Added `allowNetwork` control to the resolver so title-only itinerary creation can use curated/cache/discovery results without turning every generic stop into a live Nominatim lookup.

Verification:
- `cmd /c npm test -- map.test.js migrations.test.js placeResolver.test.js locationIntegration.test.js` passed.
- Covered manual curated place resolution, trusted coordinate preservation, untrusted generated coordinates, query re-resolution, and user-confirmed coordinate protection.

### Task 4: Map API — DONE

Add a map data endpoint, or extend existing map config API, so frontend receives map-ready stops.

Return:
- `mapConfig`
- `segments`
- `stops` with:
  - canonical `lat/lng`
  - `displayLat/displayLng`
  - `displayCoordinateSystem`
  - `locationStatus`
  - `locationConfidence`
  - `routeNumber`
  - `routeSegmentId`
  - `canRenderMarker`
  - `isEstimated`
  - `bookingId`
  - `sortOrder`
  - `time`

Sort exactly like Plan timeline:
- `COALESCE(time, '99:99') ASC`
- `sort_order ASC`
- `created_at ASC`

Progress:
- Implemented on branch `redesign-maps`.
- Added `/api/trips/:tripId/map-data`.
- Added backend map-data service returning `mapConfig`, minimal day-level `segments`, and map-ready `stops`.
- Map stops now include canonical coordinates, backend display coordinates, renderability flags, estimated status, route number, route segment id, booking id, sort order, and time.
- Frontend `MapTab` now fetches map data and `TripMap`/`StopMarker` render backend `displayLat/displayLng`.
- Mixed-city segment splitting, segment chips, connector rendering, and correction UI remain intentionally deferred to tasks 5, 8, 9, and 10.

Verification:
- `cmd /c npm test -- map.test.js migrations.test.js placeResolver.test.js locationIntegration.test.js` passed.
- `cmd /c npm run build` in `frontend` passed.
- Covered map display coordinate output, route numbering, timeline sort order, and non-renderable unknown coordinates.

### Task 5: Mixed-City Day Segments

Build day route segments from ordered stops and transit bookings.

Example: Chongqing morning -> train -> Chengdu afternoon.

Segment behavior:
- Local placed stops before transit become one local segment.
- Transit stop becomes a transit segment.
- Local placed stops after transit become another local segment.
- Full-day map shows all placed stops by default.
- Segment chips allow focusing map bounds:
  - `Chongqing AM`
  - `Transit`
  - `Chengdu PM`

Do not require a day to have only one city.

### Task 6: Booking Integration — DONE

Clarify booking-to-stop behavior.

For Add Booking:
- Add `Show in itinerary` toggle for timed/location bookings.
- Default:
  - hotel/train/flight: enabled as currently useful
  - other: enabled if it has start time and location, otherwise off
- If enabled, create or update booking-linked stop.
- If disabled, booking remains Logistics-only.

For “Other” booking:
- Keep as logistics/reservation flow.
- Use same place resolver on `destination/location`.
- Before creating a linked stop, check for matching stop on same day.
- If a match exists, link booking to that stop instead of creating duplicate.

Manual “Add place”:
- Creates ordinary stop, no booking.
- Best for unbooked activities, restaurants, viewpoints, shops, shows.

Progress:
- Implemented on branch `redesign-maps`.
- Added migration `009_booking_itinerary_visibility.sql` with persisted `bookings.show_in_itinerary`.
- Booking create/update responses now expose `showInItinerary`.
- Add/edit booking UI includes a `Show in itinerary` toggle.
- Defaults are persisted: hotel/train/flight on; other on only when it has start time and location.
- Booking-linked stop sync now uses the same resolver path and respects disabled itinerary visibility.
- Disabling visibility removes booking-created stops and unlinks existing manual stops instead of deleting them.
- “Other” bookings conservatively link to a matching same-day manual stop instead of creating a duplicate.

Verification:
- `cmd /c npm test -- map.test.js migrations.test.js placeResolver.test.js locationIntegration.test.js` passed.
- `cmd /c npm run build` in `frontend` passed.
- Covered booking visibility defaults, disabled booking behavior, visibility-off cleanup, and duplicate prevention for matching same-day “Other” bookings.

---

## Frontend Implementation

### Task 7: Manual Add Place In Plan — DONE

Add an “Add place” action for active day.

Fields:
- place/name
- optional time
- type
- optional note
- optional duration

Primary UX:
- user types place name only;
- backend resolves automatically;
- result appears in timeline and Map.

Do not ask for coordinates in primary flow.

Optional correction UX:
- “Place on map”
- “Move pin”
- “Search again”

Progress:
- Implemented on branch `redesign-maps`.
- Added active-day `Add place` action in Plan.
- Added a focused manual place form with place/name, optional time, type, note, and duration.
- Manual place creation sends `location_query` through existing stop create flow so backend resolution works by place name.
- Primary flow does not ask for coordinates.
- Correction actions remain intentionally deferred to Task 10.

Verification:
- `cmd /c npm run build` in `frontend` passed.
- `cmd /c npm test -- map.test.js migrations.test.js placeResolver.test.js locationIntegration.test.js` passed.

### Task 8: Map Rendering — DONE

Update `MapTab` and `TripMap`.

Render:
- numbered markers from `routeNumber`
- estimated markers with subtle visual distinction
- unresolved stops in day sequence panel/list
- straight-line connector arrows between coordinate-bearing stops in itinerary order
- dashed connector for intercity transit when both endpoints exist

Do not:
- sort by geographic distance
- call routing APIs
- imply travel time
- mutate stop coordinates in frontend

Progress:
- Implemented on branch `redesign-maps`.
- Added day sequence panel in Map so all active-day stops remain visible, including unresolved stops.
- Added numbered markers based on backend `routeNumber`.
- Added subtle estimated marker styling while still allowing estimated stops to participate in route lines.
- Added straight-line connector arrows between adjacent coordinate-bearing stops in itinerary order.
- Added conservative dashed transit connectors using existing `type === 'transit'` stops when renderable endpoints exist.
- Map rendering continues to use backend `displayLat/displayLng`; frontend does not mutate or convert coordinates.
- Mixed-city segment chips, full route polish, and correction UI remain deferred to Tasks 5, 9, and 10.

Verification:
- `cmd /c npm run build` in `frontend` passed.
- `cmd /c npm test -- map.test.js migrations.test.js placeResolver.test.js locationIntegration.test.js` passed.

### Task 9: Route Visualization

Route visualization rules:
- Numbers match Plan timeline order.
- Lines connect stop 1 -> 2 -> 3 using straight segments.
- Arrows show direction.
- Reordering in Plan updates marker numbers and connector direction after refresh.
- Adding a stop inserts it at its actual timeline position.
- Moving a stop to another day removes it from old route and adds it to new route.
- Estimated coordinates participate in route.
- Unresolved stops create a visible break in the route sequence panel, not silent omission.

Purpose:
- help users spot detours, backtracking, and bad ordering;
- not provide navigation.

### Task 10: Location Correction UI

For any marker:
- show status in popup:
  - resolved
  - estimated
  - user confirmed
- estimated marker popup includes “Check location” / “Move pin”.
- moving pin saves coordinates as:
  - `coordinate_source = 'user_pin'`
  - `location_status = 'user_confirmed'`
  - coordinate system matching current map display, e.g. GCJ-02 for Amap tiles.

For unresolved stop:
- show in Map side/day sequence with “Place on map”.
- placing pin confirms it.

---

## Data Repair

- Reclassify existing stops conservatively.
- Seed file coordinates that are known-good must be assigned explicit coordinate system.
- Existing ambiguous Discovery cache coordinates should not become trusted markers.
- Clear or reclassify stale Discovery cache entries for Chongqing if they caused current bad markers.
- Add curated overrides for known problematic/high-value Chongqing POIs before manual QA.

---

## Tests

Backend:
- coordinate conversion WGS-84 -> GCJ-02
- GCJ-02 -> WGS-84 approximation
- Amap display coordinate selection
- non-China display coordinate selection
- resolver priority order
- Nominatim cache hit avoids external request
- rate limiter behavior
- stop create resolves manual place by name
- Discovery/Copilot coordinates become estimated unless confirmed
- “Other” booking creates/links itinerary stop only when intended
- duplicate booking-linked stop prevention

Frontend/manual:
- June 9 Chongqing markers no longer shift into river.
- Manual add `Raffles City Chongqing` appears on Map without user-entered coordinates.
- Estimated marker appears and participates in route.
- Unresolved stop remains visible in Map sequence.
- Reordering stops changes marker numbers and connector direction.
- Moving stop to another day updates both days’ maps.
- Mixed Chongqing -> Chengdu day shows full-day route and segment chips.
- Non-China maps remain unchanged.

---

## Acceptance Criteria

- No frontend blind China coordinate conversion remains.
- All rendered markers use backend `displayLat/displayLng`.
- Manual place add works by place name.
- Add Booking “Other” does not conflict with manual place add.
- Map tab shows all active-day stops either as markers or visible unresolved sequence items.
- Route line is straight-line ordered visualization only.
- User can spot inefficient ordering from marker numbers and connectors.
- Amap API is not required.
