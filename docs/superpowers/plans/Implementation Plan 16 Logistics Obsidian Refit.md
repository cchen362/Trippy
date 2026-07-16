# Implementation Plan 16 — Logistics Tab Obsidian Refit

**Status: COMPLETE — implemented 2026-07-16, single wave, D1–D5 defaults. Verified locally: 141 frontend tests + build green; browser-verified at 375px / 900px / 1280px (all four card types, lone-card rule, forced hover + real focus-visible states, notch geometry checked via computed styles). Deviation from §5: notch pseudo-elements are anchored to `.logistics-footer-line` (not the card at `top: 58%`) — the percentage anchor missed the perforation line on real card proportions; line-anchored notches self-align at any card height and correctly vanish on footerless tickets. Not exercised: real-device touch feel and motion (Browser pane rAF limitation) — owner pass recommended before deploy.**

**DEPLOYED 2026-07-16 at 374132e** (includes follow-up fix scoping the lone-card span rule to `:only-child` after owner QA caught odd-card misalignment in 3-card sections). Owner browser QA passed pre-deploy; production container rebuilt cleanly, `/api/health` ok, deployed bundle verified to contain the final CSS.
**Date:** 2026-07-16
**Baseline:** `docs/superpowers/mockups/booking-card-material-study.html`, Direction 3 ("Obsidian ink, warm concierge detail") — owner-selected.
**Scope:** Frontend only. No backend, no data-shape, no route changes.

---

## 0. Verified facts (do not re-derive)

- Live card anatomy already matches the mockup's: transit cards (flight/train) share `TicketStubCard.jsx` (eyebrow → route grid → time grid → footer); hotel/other use eyebrow → title → data rows. The refit is material, composition, and interaction — **not** a structural rebuild.
- Production styles live in `frontend/src/index.css` lines ~750–1047 (`.logistics-*` classes). Cards are `<button type="button">` with `focus-visible` rings already; no hover/active states, no transitions, no reduced-motion block for logistics.
- The flagged faux-emboss is three `text-shadow` rules: `.logistics-card-title` (:790), `.logistics-route-code` (:848), `.logistics-time` (:906).
- Production gold is `#c9a84c` (rgb 201,168,76). The mockup uses `#c6a357` (rgb 198,163,87). **The palette is fixed** — Direction 3 alphas are re-expressed on production gold. Direction 3 also uses two warm-brown supporting tones (border `rgba(145,115,60,…)`, mineral lift `rgba(79,65,45,…)`, shadow inset `rgba(120,92,43,…)`) that are darkened derivatives of gold, not new accents; they are admitted as material tokens only, never as text or icon color.
- Grid today: all sections 1-col on mobile; flight/hotel/other go 2-up at ≥760px (`.logistics-card-grid-standard`); trains stay 1-col capped at 860px (`.logistics-card-grid-wide`). No treatment for a lone card in a 2-up section.
- Header CTAs: filled-gold "+ Add bookings" (opens CaptureFlow) above a text-link "enter manually" (opens AddBookingModal), right-aligned column on desktop (`LogisticsTab.jsx:139–156`).
- Section headers: title left, bare count flushed to the far right of the full content width (`LogisticsTab.jsx:163–170`) — the "count too far from title" finding.
- Ticket notches do **not** exist in production. The footer line has two 5px gold dots (`.logistics-footer-line::before/::after`) standing in for them. Direction 3's notches are 10px rotated squares punched at the perforation line (`.obsidian .ticket::before/::after` in the mockup).

---

## 1. Keep / change / why

### Unchanged (deliberately)
- **Component anatomy and data mapping.** All five card components' props, graceful degradation (flight no-times fallback, hotel nights computation, station uppercase), paperclip document badge, and the `onOpen` → detail-sheet flow. The mockup itself declares "same content, same anatomy."
- **Per-type identity.** Flight = IATA route + boarding-pass labels; train = wide station-name card; hotel = concierge data rows; other = flexible rows. Section grouping order (flight, hotel, other, train).
- **Detail sheet, AddBookingModal, CaptureFlow internals.** Out of scope except the two CTA labels.
- **Typography scale and long-data defenses** (`overflow-wrap: anywhere`, `minmax(0,…)` grids, clamp() route codes). Direction 3 scored 4.7/5 mobile durability precisely because the anatomy survives compression — don't touch it.

### Changed
1. **Material system → Obsidian.** Replace the current bright-white borders / radial gold washes / lacquer-ish gradient with Direction 3: mineral surface gradient, warm-brown outer border, inset gold keyline (7px inset, 1px, low alpha), left-edge warm inset shadow, top-left mineral lift only. Radius drops 16px → 10px (Direction 3 uses 9px; 10px keeps kinship with Trippy's other 10px surfaces).
2. **Remove all three text-shadows.** Contrast comes from the calmer surface, not embossing.
3. **Real ticket notches** on transit cards: rotated-square punches at the footer/perforation line, colored to the page background so they read as die-cuts; the gold footer dots retire (they were the stand-in). Perforation line becomes Direction 3's fading gold gradient.
4. **Concierge type-line dash**: `.logistics-eyebrow::before { content: '— '; }` in dim gold — the family signature from Direction 3. Eyebrow color moves from full gold to `--cream-mute` with the dash carrying the gold (restores accent discipline: gold appears once per card, on the confirmation ref).
5. **CTA hierarchy.** "Import confirmations" becomes the primary but *outlined* action (gold hairline border, gold text, transparent fill — no filled gold background); "Enter manually" becomes a same-height secondary ghost button beside/below it. Copy change per sweep finding.
6. **Section headers.** Count moves adjacent to the title (`Flights · 3` as one mono line, count in `--cream-dim`), not flushed to the far edge.
7. **Desktop lone-card fix** (see §2).
8. **Interaction states** (see §3).

---

## 2. Composition — mobile and desktop

### Mobile (375px) — unchanged structure, retuned material
Single column, all sections. Card internals identical to today. Verify with: a train card with `TOKYO STATION → SHIN-OSAKA STATION`, a flight with no lookup times (departure-date fallback), a hotel titled "Suiran, a Luxury Collection Hotel, Kyoto" with a `9874-ACQW-118390`-length ref, an other card with a long WHERE value. Header CTAs stack full-width under the heading (they already reflow via `flex-col sm:flex-row`).

### Desktop
- **≥760px:** flight/hotel/other stay 2-up; train stays 1-col ≤860px (station names need the width).
- **Lone card in a 2-up section:** the odd (or only) card spans a capped single column instead of hugging half the row against emptiness. CSS-only:
  ```css
  .logistics-card-grid-standard > .logistics-card:last-child:nth-child(odd) {
    grid-column: 1 / -1;
    max-width: 560px;
  }
  ```
  (Selector targets the card button, the grid's direct child.) One flight → one comfortable ~560px card; three hotels → 2-up + one capped full-row card. This is the recommended default over centering or stretching; a stretched full-width flight card distorts the route grid, and centering a half-width card looks accidental.
- **Section header:** `FLIGHTS · 3` inline; the standalone right-edge count span is removed.

### Mixed-count realism check (part of QA, §6)
Seed/verify against a trip with: 1 flight, 3 hotels, 2 others, 1 train — exercises lone-card, odd-count, and wide-card rules simultaneously.

---

## 3. Interaction behavior (shared across all five cards)

All states applied via `.logistics-card` so transit and data cards behave identically.

| Input | Behavior |
|---|---|
| Pointer hover | Border warms (`rgba(201,168,76,0.30)` outer border), inset keyline rises to `rgba(201,168,76,0.16)`, shadow deepens slightly, and a detail affordance appears (see below). `transition: border-color 160ms, box-shadow 160ms, transform 160ms;` no scale > 1.01, prefer `transform: translateY(-1px)` or none. |
| Keyboard focus | Existing `focus-visible` ring retained but retoken'd to the production gold line; identical affordance reveal as hover. Never remove the ring. |
| Active/touch press | `transform: translateY(0)`/brief surface darken via `:active`; no long-press behavior, no gestures (desktop-mobile affordance rule). |
| Touch | No hover-dependent information: the detail affordance must be *visible at rest* on coarse pointers (`@media (hover: none)` shows it at its resting opacity). |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` zeroes the transitions/transform for `.logistics-card` (extend the existing discovery reduced-motion block pattern). |

**Detail affordance (the "this opens" cue):** a small mono `VIEW →` (or single chevron glyph) pinned bottom-right of every card at `--cream-mute`, rising to `--cream-dim` on hover/focus. Consistent position across all four types; on transit cards it sits right of the footer row, on data cards after the last row. It must not collide with the confirmation ref — recommended: chevron only (`›` in DM Mono, 12px), which stays out of the text column. **Open decision D2 below.**

Accessibility additions while we're in the buttons:
- Each card button gets an explicit accessible name: `aria-label` composed as `"{type} booking: {title/route}. Opens details."` (today the name is the concatenated card text — long and noisy for screen readers).
- Section `<h3>` and count become one element so AT reads "Flights, 3".
- Paperclip keeps `aria-label="Documents attached"`.
- Contrast check: `--cream-mute` (0.28 alpha) on the new darker surface for labels — verify ≥ 3:1 for the 10px mono labels; if it fails on the obsidian surface, lift label alpha to 0.34 *within the logistics scope only* (do not touch the global token).

---

## 4. Reusable tokens → production

Add to `:root` in `index.css` (names scoped to the material system so other surfaces can adopt it later — the study recommends obsidian for the whole booking family and satin as a future dense-panel fallback):

```css
/* Obsidian material (booking cards) — Direction 3, re-based on --gold #c9a84c */
--obsidian-surface: radial-gradient(circle at 18% 8%, rgba(79,65,45,0.16), transparent 31%),
                    linear-gradient(163deg, #191510, #100e0c 65%, #181410);
--obsidian-surface-top: rgba(24,20,15,0.56);
--obsidian-border: rgba(145,115,60,0.34);
--obsidian-keyline: rgba(201,168,76,0.09);        /* inset 7px, radius 4px */
--obsidian-keyline-active: rgba(201,168,76,0.16);
--obsidian-divider: rgba(201,168,76,0.13);
--obsidian-shadow: 0 15px 42px rgba(0,0,0,0.35), inset 3px 0 rgba(120,92,43,0.13);
--foil: linear-gradient(90deg, #6f592c 0%, #aa8b49 14%, #d0b774 31%, #8c7138 46%,
                               #c4a25b 69%, #78602f 86%, #b0904b 100%);
```

Rules of use (mirrors the mockup's "material discipline" guardrail — record in the design spec §12 when shipped):
- Foil: hairlines and edge catches only, max 1–2px, never text, never glow. In this refit foil appears in exactly one place per card at most (candidate: none by default — the obsidian direction in the mockup uses no foil on the card itself; keep `--foil` tokenized for future hero states only). **Recommended default: no foil on booking cards.**
- Mineral lift stays top-left, never beneath the data rows.
- Warm-brown rgba values are material-only; text/icons keep the cream/gold system.
- Notch background must match the page background (`--ink-deep` / `#0d0b09`) so the die-cut illusion holds; the mockup used `#0b0a08` because its stage was darker — use the production page color.

---

## 5. Affected files and sequence

All frontend; one implementation session, sequenced so each step is independently verifiable:

1. **`frontend/src/index.css`** — add tokens (§4); rewrite `.logistics-card` material block; remove the three text-shadows; retune eyebrow/divider/perforation/footer; add notches; add hover/focus/active/reduced-motion; add lone-card grid rule; keep all layout/clamp/overflow rules byte-compatible where unchanged. (~80% of the diff lives here.)
2. **`frontend/src/pages/LogisticsTab.jsx`** — CTA copy + restyle ("Import confirmations" outlined primary, "Enter manually" ghost secondary); merge section title+count; no state/logic changes.
3. **`frontend/src/components/logistics/TicketStubCard.jsx`** — notch elements (two spans or CSS-only pseudo-elements on the card — prefer pseudo-elements, zero JSX change if achievable; JSX only if the inset keyline pseudo-element (`::before`) collides with the notch pseudo (`::after` handles one side only → likely needs one wrapper span or the keyline as an inset `box-shadow` instead of a pseudo — **decide in implementation: keyline via `outline-offset` or inset border-image is brittle; a single absolutely-positioned keyline `<span aria-hidden>` inside each card is the clean answer if both pseudos are spoken for**); add the chevron affordance + aria-label.
4. **`HotelBookingCard.jsx` / `OtherBookingCard.jsx`** — chevron affordance + aria-label (shared tiny helper in `bookingCardUtils.js` if the label composition repeats).
5. **`FlightBookingCard.jsx` / `TrainBookingCard.jsx`** — aria-label pass-through prop only.
6. Docs: update design spec §12 material tokens after owner sign-off.

No new dependencies. No new components (the affordance is a span, not a component). Delegation: single Sonnet subagent (CSS+JSX are too interleaved to split without collisions).

---

## 6. Verification

- `cd frontend; npm test` and `npm run build` (existing `bookingForm`/`hotelName`/`CityInput` tests must stay green — none touch styling, so failures would indicate accidental logic drift).
- **375px:** all four card types with the long-data fixtures from §2; keyboard focus ring visible; chevron visible at rest (coarse pointer); tap targets ≥ 44px unchanged; notches don't clip route text at `max-width: 420px` route-grid compression.
- **Resized desktop (760–1100px):** 2-up grid, lone-card rule with 1, 2, and 3 cards in a section; train card ≤ 860px; hover states; header CTA pair alignment.
- **Standard desktop (≥1280px):** full mixed trip (1 flight / 3 hotels / 2 others / 1 train); tab through every card and both CTAs; toggle `prefers-reduced-motion` (DevTools rendering emulation) and confirm zero transition/transform.
- Contrast spot-checks (DevTools) on: eyebrow, row labels, footer label, date italic — against the new obsidian surface.
- Visual QA is agent-run locally (dev servers via launch.json, fe :5174); owner gets a click-script for anything requiring real-device touch confirmation. Browser-pane rAF freeze applies: verify transition *end states* by forcing styles; owner confirms motion feel.
- No deploy in this plan; ship rides the next `/deploy`.

---

## 7. Open decisions (recommended defaults)

- **D1 — CTA visual weight.** Recommended: outlined-gold primary ("Import confirmations") + ghost secondary ("Enter manually"), equal height, side by side on desktop / stacked full-width on mobile. Alternative kept on the table: primary as `--gold-soft` fill with gold text. Default: outlined.
- **D2 — Detail affordance glyph.** Recommended: bare `›` chevron, DM Mono, bottom-right, `--cream-mute` at rest. Alternative: `VIEW` word-label (more explicit, more noise ×N cards). Default: chevron.
- **D3 — Notches on data cards?** Direction 3's mockup punches notches only on ticket-type cards (flight/train); hotel/other have none. Recommended: keep notches transit-only — they are *ticket* semantics, and giving hotels notches erodes per-type identity. Default: transit-only.
- **D4 — Foil usage.** Recommended: none on booking cards (token shipped but dormant, reserved for a future hero state per the study's verdict). Default: dormant.
- **D5 — Eyebrow color.** Moving eyebrow from gold → cream-mute (+gold dash) tightens accent discipline but is a visible identity change across the tab. Recommended: adopt it (it is what makes room for the confirmation ref to be *the* gold moment). Default: adopt; trivially reversible if it reads too quiet in the browser.

None of these block implementation under their defaults; flag disagreement before the build session.
