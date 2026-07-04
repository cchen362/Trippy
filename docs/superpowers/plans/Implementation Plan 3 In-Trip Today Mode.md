# Trippy — In-Trip Mode ("Today") + Housekeeping

## Context

A full-codebase review (2026-07-04) diagnosed why Trippy, despite being well built, went unused during the owner's last trip: **every surface is an editing tool for planning; none serves the moments that matter on the ground** — "what's next?", "show me the ticket QR", "navigate there", "works on flaky data". The trip instead lived in Xiaohongshu bookmarks (attractions), Trip.com (bookings with live status), and AMap (navigation) — three tools that share one property: they never fall out of date. Trippy is a mirror that must be maintained by hand, and a mirror that falls behind reality once loses trust permanently.

**Guiding principle (agreed):** *system of record vs. system of reference.* For anything with an authoritative upstream (flight ops, train ops, bookings made in Trip.com), Trippy is a **reference** — link out, don't replicate. Trippy is the **record** only for what has no other home: the day plan, cross-source consolidation, and the documents themselves. Features that respect this line stay cheap; features that cross it (live train status, booking sync) are permanent maintenance burdens and are explicitly out of scope.

**User's travel style (interview, confirmed):** logistics are hard timed anchors; activities are *intentionally untimed* — an ordered menu, not a schedule. The Today design derives entirely from this.

**Scope decisions (confirmed with user):**
1. Housekeeping milestone (M0) approved — all low-effort trust fixes.
2. Backups stay on the Debian server (not personal cloud). Server work waits on Tailscale re-auth.
3. Today mode: fourth tab replacing the Trips slot in the bottom nav during live trip days only; `← Trips` in the top bar remains the way home.
4. Progress is derived (clock + drag order), **no manual check-offs in v1**; tap-to-dim deferred to v2 pending field use.
5. Later-today rows are quiet (mono time + serif title + navigate icon), no photo cards.
6. Flight status refresh ships in v1 (AeroDataBox already integrated); trains deliberately deep-link out.
7. Collaboration untouched except share-link revoke.

**Verified codebase facts** (spot-checked):
- `todayIso()` uses `new Date().toISOString()` → **UTC** date (`frontend/src/hooks/useTrip.js:4-6`); same bug server-side in `toIsoDate`/`computeTripStatus` (`backend/src/services/trips.js:5-18`). In UTC+8, "today" is wrong until 08:00 local.
- AMap tiles load over plain `http://` (`backend/src/services/mapConfig.js:28`) — mixed content on the HTTPS production site; browsers may block, leaving blank China map tiles.
- Offline boot dead-ends at the login page: `authApi.status()` network failure is swallowed and treated like no session (`frontend/src/context/AuthContext.jsx:14-25`), so the service-worker-cached `/api/trips/:id/detail` (vite.config.js runtimeCaching) is unreachable.
- Share links: token is strong (24 random bytes) but permanent — no DELETE route (`backend/src/routes/share.js`), `createShareLink` always returns the first token.
- No rate limiting anywhere; login is exposed at a public domain.
- Import artifacts already store original files as BLOBs (`import_artifact_files.content`, migration 011) but no endpoint serves file content back — extraction JSON only (`backend/src/routes/imports.js`).
- Bookings created via import carry `detailsJson.importedFrom = { artifactId, model, extractedAt }` (`backend/src/services/importer.js:148`) → booking → artifact → files resolution needs no schema change.
- AeroDataBox flight lookup exists end-to-end: `GET /api/lookups/flights` → `lookupFlightDetails()` (`backend/src/services/lookups.js:300`); the same FIDS endpoint returns live fields (gate, terminal, status, actual times) when queried near departure. Full provider payload is already stored on flight bookings (`detailsJson.providerPayload`, see migration 010 backfill comment).
- Deep-link builder for AMap/Naver/Google exists (`backend/src/services/mapConfig.js:63-72`, `frontend/src/components/map/OpenInMapsButton.jsx`) — currently reachable only via Map tab marker popups.
- BottomNav is `Trips · Plan · Logistics · Map` (`frontend/src/components/nav/BottomNav.jsx:40-43`); TopBar has a permanent `← Trips` link (`frontend/src/components/nav/TopBar.jsx:10-16`).
- Trip detail already returns `bookings[]` and `days[].stops[]` with `bookingId` links and `sortOrder` — Today needs no new aggregate endpoint.
- `listTripsForUser` already accepts an injectable `{ today }` (`backend/src/services/trips.js:252`) but the route never passes one (`backend/src/routes/trips.js:10-12`).

---

## Design Decisions

**D1 — "Today" is local, client-supplied.** The device clock is ground truth for the traveler. Frontend computes local ISO date (`en-CA` locale trick or manual `getFullYear/Month/Date`) and sends it as `?today=` to `GET /api/trips` (validated `^\d{4}-\d{2}-\d{2}$`, server-local fallback). `pickDefaultDay` and trip-live checks use the same local-date helper. Booking "has passed" comparisons prefer the booking's own `originTz`/`destinationTz` wall-clock when present, else device time.

**D2 — Anchor-flow model (the core of Today).** Two kinds of items:
- *Anchors* — today's bookings (start or end datetime falls today) plus any stop with an explicit `time`. The clock only ever touches anchors.
- *Activities* — untimed stops, in the user's drag order (`sortOrder`).

Rules:
- **Hero = next anchor** whose relevant datetime hasn't passed. No anchors left today → tonight's hotel booking becomes the hero. No hotel either → no hero; the day header stands alone ("free day").
- **Activities never get clock-judged individually.** An activity collapses only when an anchor *after it in the day's stop order* has passed (booking-linked stops give bookings a position in that order; bookings hidden from the itinerary still count as anchors, positioned by time among timed stops). Activities after the last passed anchor remain visible as the current "menu".
- Collapsed items fold into a single dim "N earlier stops" row, expandable.
- No manual state anywhere (v1).

**D3 — Nav swap, trip-live only.** `tripIsLive = startDate ≤ localToday ≤ endDate`. When live, BottomNav renders `Today · Plan · Logistics · Map` and `TripPage`'s index redirect targets `today` instead of `plan`. Otherwise nav and redirect are unchanged, and `/trips/:tripId/today` outside live days redirects to `plan` (handles stale bookmarks/PWA resume).

**D4 — Vault = serve what's already stored + one small table for manual attachments.** New endpoint `GET /api/import/artifacts/:id/files/:position` (requireAuth + same `assertArtifactAccess` as detail) streams the BLOB with its stored `media_type` and `Content-Disposition: inline`. Imported bookings resolve documents via `detailsJson.importedFrom.artifactId`. Manual attachments (e.g. a Trip.com screenshot for a booking entered by hand) get migration `012_booking_attachments`: `id, booking_id FK CASCADE, media_type, filename, size_bytes, content BLOB, created_at`, same caps as import (image ≤ 5 MB, pdf ≤ 10 MB), max 4 per booking, endpoints `POST/GET/DELETE /api/bookings/:id/attachments(/:attachmentId)`. Reuses the import flow's base64-JSON transport (16 MB body limit already set).

**D5 — Document viewer is a full-screen overlay** (image or PDF via `<embed>`), near-white backdrop behind QR images so scanners can read the phone. Reachable from the Today hero (`Ticket`) and from booking cards in Logistics.

**D6 — Flight status is a refresh, not a feed.** `Status` on a flight hero calls the existing `/api/lookups/flights` with the booking's carrier/number/date; render `status`, `gate`, `terminal`, revised times from the response when present, with a "checked HH:MM" stamp. On-demand only — no polling, no storage beyond the tap. Trains/others: `Status` is absent; the hero links out (reference, not record). Failures degrade to the deep link, never block the card.

**D7 — One-tap navigate everywhere.** Extract the deep-link URL builder into a shared frontend util (same logic as `OpenInMapsButton`, provider from trip's `mapConfig`). Today rows and hero use it directly when the linked stop has `lat/lng`; rows without coordinates show no navigate icon (no dead buttons).

**D8 — Offline fail-open auth.** Persist `{ user }` to `localStorage` on successful `me()`. On boot, distinguish failure modes: HTTP 401 → clear cache, show login; network error (fetch `TypeError`/timeout) → hydrate from cached user and proceed (reads hit the service-worker cache; writes fail loudly as they do now). The `auth:unauthorized` event still logs out on a real 401.

**D9 — Housekeeping fixes are root-cause, not patches.** UTC bug fixed at both call sites via one shared local-date approach (D1); AMap tiles switched to `https://` (verify tiles render in prod after deploy); share revoke = real DELETE (`share_links` row removed; re-share generates a fresh token); `express-rate-limit` (new dep) on `/api/auth` only (e.g. 20 attempts / 15 min / IP, `trust proxy` already set).

---

## Milestones (each independently executable + verifiable)

### M0 — Housekeeping (no server access needed except H1/H2)

- [ ] H1 *(server)* Re-auth Tailscale on the Debian box; deploy current `main` (booking capture reaches production for the first time). Verify `trippy.zyroi.com` shows the "+ Add bookings" capture flow.
- [ ] H2 *(server)* Nightly backup cron on the Debian host: `sqlite3 <data>/trippy.db ".backup <backups>/trippy-$(date +%F).db"` + 14-day rotation, backups on local disk per user decision (documented caveat: does not survive disk failure). Verify a backup file restores and opens.
- [x] H3 Local-date fix (D1): shared helper in frontend, `?today=` param on trips list, fix `pickDefaultDay`. Test: with system TZ Asia/Shanghai at 07:00 on a trip day, home groups the trip as active and Plan opens today. **Done 2026-07-04** — `frontend/src/utils/date.js` (`localIso`), `useTrip.js`/`TripsHomePage.jsx` use it, `GET /api/trips` validates and accepts `?today=`. Verified `?today=2026-07-04` round-trips correctly in the browser.
- [x] H4 AMap tile URL → `https://` (`mapConfig.js:28`); update `map.test.js` expectations. Verify tiles load over HTTPS. **Done 2026-07-04** — protocol switched, `map.test.js` asserts `tileUrl` starts with `https://`.
- [x] H5 Offline fail-open auth (D8). Test: load app once online, go offline (devtools), reload → cached trip renders instead of login page. **Done 2026-07-04** — `AuthContext.jsx` caches `{ user }` in `localStorage`, distinguishes 401 (real logout) from network failure (hydrate from cache). Verified live: killing the backend and reloading renders the authenticated shell, not the login page.
- [x] H6 Share-link revoke: `DELETE /api/trips/:tripId/share` (owner/editor via `assertTripAccess`), revoke + regenerate UI in `TripShareModal`. Test: revoked token returns 404 on `GET /api/share/:token`. **Done 2026-07-04** — `revokeShareLink` service + route, `useCollaboration`/`ShareLinkCard` revoke button. Verified live end-to-end: created a link, revoked it, UI fell back to "Create share link," old token 404s.
- [x] H7 `express-rate-limit` on `/api/auth` (D9) + test that the limiter doesn't catch normal login. **Done 2026-07-04** — `backend/src/middleware/rateLimit.js` (20/15min per IP), mounted on the auth router. New HTTP-level test in `auth.test.js` covers normal logins passing and the cap returning 429.
- [x] H8 *(optional, cost)* `cache_control: { type: 'ephemeral' }` on the copilot system prompt block for multi-turn savings. **Done 2026-07-04** — `claude.js` `streamCopilotResponse` system prompt now uses the ephemeral cache_control block form.

**M0 status:** H3–H8 shipped and verified (158 backend tests pass, frontend builds clean). H1 (deploy) and H2 (backup cron) remain blocked on the Tailscale re-auth on the Debian box — ready to run the moment SSH access is restored.

### M1 — Document vault (backend + Logistics surfacing)

- [x] Artifact file content endpoint (D4) + tests (auth, wrong-user 404, correct content-type round-trip). **Done 2026-07-04** — `getArtifactFile` in `importer.js`, `GET /api/import/artifacts/:id/files/:position`.
- [x] Migration `012_booking_attachments` + attachment endpoints (D4) + tests (caps, cascade delete with booking). **Done 2026-07-04** — `backend/src/services/attachments.js`, `POST/GET/DELETE /api/bookings/:id/attachments(/:attachmentId)`.
- [x] Booking → documents resolution in booking payloads: `documents: [{ source: 'import'|'attachment', url, mediaType, filename }]` assembled server-side (from `importedFrom.artifactId` files + attachments). **Done 2026-07-04** — shared `backend/src/services/documents.js::resolveBookingDocuments`, used by both `bookings.js::formatBooking` and `trips.js::mapBooking` (the latter powers `/api/trips/:id/detail`, which the frontend actually reads — initially missed, caught during live verification and fixed at the root by de-duplicating the two booking-mapping functions onto one shared resolver).
- [x] Full-screen document viewer component (D5). **Done 2026-07-04** — `frontend/src/components/documents/DocumentViewer.jsx`; dark chrome header, near-white content pane (image `<img>` / PDF `<embed>`) so an imported QR/barcode screenshot stays scannable.
- [x] Logistics booking cards: document chip(s) when present; "attach photo/PDF" action on the booking detail sheet (base64 JSON upload reusing `fileToInput` from `importApi.js`). **Done 2026-07-04** — passive gold paperclip chip on all 4 card types (`TicketStubCard.jsx` + `HotelBookingCard.jsx` + `OtherBookingCard.jsx`), Documents row + Attach button wired into `LogisticsTab.jsx`'s detail sheet.
- Verify: import a booking from a screenshot → open its card → original screenshot views full-screen; manually attach a PDF to a hand-entered hotel → persists, views, caps enforced. **Verified live 2026-07-04** — 175 backend tests pass; browser-driven pass confirmed chip rendering, image + PDF viewer, and the 5th-attachment cap rejection with the error surfaced in the sheet.

**M1 status:** Shipped and verified end-to-end. Backend: new migration, `attachments.js` service, shared `documents.js` resolver, extended `imports.js`/`bookings.js` routes, 3 new/extended test files (175 total passing). Frontend: `DocumentViewer.jsx`, booking-card chips, detail-sheet attach flow, `bookingsApi.js` additions. Ready for M2 (Today tab), which reuses this viewer for the hero's `Ticket` action.

### M2 — Today tab

- [x] `tripIsLive` helper + BottomNav swap + TripPage index redirect + `/today` route with off-day redirect (D3). **Done 2026-07-04** — `frontend/src/utils/tripStatus.js`, `TripPage.jsx` computes `isLive` and passes it to `BottomNav` + `Outlet` context, `TripIndexRedirect.jsx` picks `today`/`plan`, `TodayTab.jsx` redirects to `../plan` when not live.
- [x] Anchor derivation module (`frontend/src/utils/todayModel.js`): pure function `(days, bookings, now) → { collapsed, hero, upcoming, tonight, tomorrowFirst }` implementing D2 — unit-tested without UI (12 scenarios in `todayModel.test.js`: morning-activities-before-train collapse at departure, hotel-fallback hero including multi-night stays, checkout-day free-day framing, free day, overnight/cross-midnight bookings, hidden-from-itinerary booking anchoring by time (with and without a linked stop), same-time tie-break, tomorrow-preview present/absent, trailing activities staying upcoming). **Done 2026-07-04.**
- [x] TodayTab page per agreed mockup: day header ("Mon · Day 1 of 10", city in Playfair italic), collapsed-earlier row (expandable), hero card (single gold accent; `Navigate` / `Ticket` / `Status` pills — Status is an inert M3 extension point, flight-only), quiet later-today rows, Tonight slot (hotel + check-in ref + navigate; suppressed when the hotel is already the hero to avoid a duplicate card), tomorrow-preview footer. **Done 2026-07-04** — `frontend/src/pages/TodayTab.jsx` + `frontend/src/components/today/{HeroCard,UpcomingRow,TonightCard,CollapsedRow,NavigateIcon,StatusPill}.jsx`.
- [x] Shared deep-link util (D7); navigate icons only where coordinates exist. **Done 2026-07-04** — `frontend/src/utils/deepLink.js` (`buildDeepLink`, moved out of `OpenInMapsButton.jsx`, both now share it), `NavigateIcon.jsx` renders nothing without finite lat/lng, `useMapConfig.js` hook (already existed, previously unused) supplies `deepLinkProvider`.
- Verify: **Done 2026-07-04** — added a frontend `vitest` runner (none existed before M2; `npm test` in `frontend/`) and confirmed all 12 `todayModel` unit tests pass, `npm run build` succeeds, and the full backend suite (175 tests) is unaffected. Live-verified in the browser against the real Chengdu–Chongqing trip data by patching the page's `Date` to fall inside the trip's real date range (no DB writes): nav correctly swaps to "Today" only while live; hero correctly shows the day's flight anchor before departure, then collapses it (with the linked hotel check-in stop) and falls back to the hotel as hero after both pass; the "Tonight" card is correctly suppressed once the hotel is already the hero and correctly reappears next to a different hero; tomorrow-preview footer renders from tomorrow's first anchor; visiting `/today` directly on a non-live trip (real system date) redirects to `/plan`.

**M2 status:** Shipped and verified end-to-end. Frontend-only (no backend changes): `todayModel.js` anchor derivation + 12 unit tests, `tripStatus.js`, `deepLink.js`, `TodayTab.jsx` and 6 new `components/today/*` components, nav/routing wiring in `BottomNav.jsx`/`App.jsx`/`TripPage.jsx`/`TripIndexRedirect.jsx`, and a new frontend `vitest` runner (previously absent). Two design ambiguities were resolved with the user before implementation: the hotel is the hero every night of a multi-night stay (not just check-in night), and same-clock-time ties favor the stop-linked anchor. Ready for M3 (flight status refresh + entry polish), which wires the already-present inert `StatusPill` extension point to the AeroDataBox lookup.

### M3 — Flight status + entry polish

- [ ] `Status` pill on flight heroes → existing flights lookup, render live fields + "checked HH:MM"; absent for non-flights; graceful degrade to deep link on provider failure (D6).
- [ ] TripsHomePage: active-trip card deep-links to `/today`.
- [ ] PWA runtime cache for artifact/attachment GET responses (CacheFirst, they're immutable) so tickets open offline.
- Verify: flight day → status refresh shows provider data; airplane-mode reopen → Today renders from cache and the ticket still opens.

---

## Risks & Edge Cases

- **Anchor edge cases live in one pure function** (M2) — cross-midnight trains, hotels whose check-out anchors the *following* morning, same-time ties (order by sort position). Unit-test the module, not the UI.
- **Timezone honesty:** wall-clock booking datetimes + device clock can disagree the day you land after a red-eye. D1's rule (booking's own tz when present) covers the visible cases; do not attempt full tz reconciliation in v1.
- **BLOB growth:** vault encourages attachments; DB stays the single backup artifact (H2). Caps (D4) bound it. Revisit only if the file exceeds ~1 GB.
- **AeroDataBox live-field coverage varies** by airport/carrier; the UI must treat every live field as optional (D6).
- **Chinese networks:** `uri.amap.com` deep links and AutoNavi HTTPS tiles verified in-country only — flag for the first field test.

## Out of Scope (deliberate)

- Live train status of any kind (12306 has no public API — reference, not record).
- Notifications / morning digest, tap-to-dim on activities, XHS content ingest (screenshot-of-bookmark → stops) — all deferred until a field test of M0–M3 shows what's still missing.
- Collaboration changes beyond share revoke.
- Any booking-provider sync or email import (Plan 2A's channel-agnostic constraint stands).
