# Implementation Plan 17 — Modal System: Dossier Sheet Primitive & Five-Flow Refit

**Status: W2 COMPLETE (2026-07-19) — NewTripModal + AddBookingModal migrated; W3 (CaptureFlow + full matrix) pending**
**Date:** 2026-07-19
**Baseline:** Independent design/QA review of the five modal flows (2026-07-19 session), Luxury Dark Design System archive (AUDIT.md is the reconciled token authority where it agrees with `frontend/src/index.css`), spec §12.
**Scope:** Frontend only. No backend, no data-shape, no route changes. No changes to extraction, provider lookup, session-token, or payload logic — presentation, semantics, and shell structure only.

---

## 0. Verified facts (do not re-derive)

- The five flows are: `NewTripModal.jsx`, `EditTripModal.jsx` (trips/), `AddPlaceModal.jsx` (timeline/), `CaptureFlow.jsx` + `CaptureInput.jsx` + `ExtractionReview.jsx` (import/), `AddBookingModal.jsx` (logistics/). All hand-copy the same overlay/panel shell: `fixed inset-0 bg-black/60 backdrop-blur-sm items-end sm:items-center` + `rounded-[22px]` panel on `--ink-surface`, `max-h-[85vh] overflow-y-auto` inner scroller.
- **None** of the five has `role="dialog"`, `aria-modal`, focus trap, focus return, Escape handling, or background scroll lock. (CopilotPanel, DiscoveryPanel, SuggestionCard, DayPicker *do* handle Escape — modals lag the rest of the product.)
- Accidental drift between copies: z-index 40 everywhere except AddPlace (50); max-w-xl (AddPlace) / 2xl (NewTrip, EditTrip) / 3xl (CaptureFlow, AddBooking); text "Close" button in four flows vs a 40px round X icon in AddPlace (below the 44px floor); `.modal-label` class in three flows vs inline label styles in EditTripModal; sticky bottom action bar in CaptureInput/ExtractionReview only — NewTrip details, EditTrip, AddPlace, AddBooking have non-sticky footers that scroll below the fold at 375px.
- CaptureFlow **stacks** AddBookingModal (`mode="draft"`) on top of itself while open — the primitive must support two live instances (scroll lock refcount, stacked z-index, focus trap on the topmost).
- CaptureFlow's discard protection is a two-step header-corner confirm (`confirmClose` state) with off-palette `#f8b4b4`; EditTrip delete uses off-palette `#c0392b`/white. Sanctioned semantic states (AUDIT §1): gold, `#e08a3a` estimated/stale, `#e05a5a` destructive/error. Field errors already use `#e05a5a`.
- Shared form classes live in `frontend/src/index.css:77–108` (`.modal-label`, `.modal-input`, `.modal-action`). Panel `rounded-[22px]` and CTA `rounded-2xl` exist nowhere in the sanctioned radius scale (6/12/16/pill).
- `Loader2` spin is used in CaptureInput and ExtractionReview; the DS loading idiom is a gold pulse-dot (`forms-status.html` specimen), no spinners.
- AddPlaceModal autofocuses the search field; suggestion rows render place name in mono and address in Cormorant (inverted type roles — place names are Playfair territory per §12.3).
- Honest-constraint copy that must survive verbatim: EditTrip locked start date + note, shorten-end warning, chip-removal note ("days keep their identity…"); CaptureFlow duplicate pre-exclusion and extend-trip warnings; AddBooking draft-mode type remapping (`draftFormForType`).
- Owner UX rules already in force: no gesture porting to desktop, no drag-to-dismiss requirement, no uninitiated motion, reduced-motion support mandatory. Browser-pane rAF freeze means agents verify settled states; motion is owner-verified.

---

## 1. Owner-approved decisions (2026-07-19, all locked)

| # | Decision | Resolution |
|---|---|---|
| D1 | Mobile presentation | **True bottom sheet** at <sm: full-width, flush bottom, top corners only rounded (16px), `env(safe-area-inset-bottom)` padding, ~320ms slide-up (none under reduced-motion), **no drag-to-dismiss** — explicit Close + Escape only. Desktop (sm+) stays a centered dialog with per-flow max-width. |
| D2 | Panel radius | Migrate to sanctioned **radius-l 16px** (desktop dialog all corners; mobile sheet top corners). `rounded-2xl` CTAs normalize to 12px. No 22px anywhere. |
| D3 | AddBooking reference fields | **De-emphasized, always visible**: hairline divider + mono eyebrow `REFERENCE`, dimmer labels. No collapse/disclosure. |
| D4 | Delete Trip | Moves out of the footer into an **end-of-body danger block** (hairline-separated, `#e05a5a` family, keeps the two-step inline confirm). Footer holds only Cancel/Save. |
| D5 | AddPlace autofocus | **Keep** (single-job search modal — the keyboard *is* the guidance). Other four modals do not autofocus. Keyboard-inset behavior (D1) must keep the search field + suggestions visible with the keyboard open — verification requirement, not a design change. |

---

## 2. The primitive: `ModalShell`

New file `frontend/src/components/shell/ModalShell.jsx` (one primary export). It owns **overlay, geometry, semantics, and chrome slots — never content**. No form engine, no field schema, no phase machine; interiors stay per-flow.

Props (indicative): `open`, `onRequestClose`, `eyebrow`, `headline` (node — flows keep dynamic titles), `headerAccessory` (node — replaces the default close control when a flow needs custom closure UI, e.g. nothing extra for most flows), `maxWidth` ('xl' | '2xl' | '3xl'), `footer` (node — rendered in the sticky action bar), `initialFocusRef` (optional — D5), `children`.

Responsibilities:

1. **Geometry.** <sm: bottom sheet per D1 (`items-end`, w-full, `rounded-t-2xl` → 16px top radius, flush edges, safe-area bottom padding inside the footer). sm+: centered dialog, 16px radius, per-flow `maxWidth`, outer padding restored. Body scrolls (`max-h` respecting `100dvh` minus insets on mobile, ~85vh on desktop); header and footer do not scroll.
2. **Dialog semantics.** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the headline element.
3. **Focus management.** On open: move focus to `initialFocusRef` if given, else the first focusable (in practice the close control). Trap Tab/Shift-Tab within the topmost open shell. On close: return focus to the opener element.
4. **Escape.** Keydown Escape calls `onRequestClose` (not a hard close) — so CaptureFlow's discard protection intercepts it. Only the topmost shell in a stack responds.
5. **Scroll lock.** Lock `document.body` scroll while ≥1 shell is open; refcounted so the CaptureFlow → AddBookingModal stack unlocks only when both close.
6. **Stacking.** A module-level stack registry assigns z-index (base 40, +10 per level) and scopes Escape/trap to the top. Replaces the hardcoded 40/50 split.
7. **Header chrome.** Gold mono eyebrow + Playfair italic headline (the existing anatomy, standardized) + one **44px** close control (Lucide `X` in a 44px hit area, hairline ring) — replacing both the text "Close" buttons and AddPlace's 40px icon.
8. **Sticky footer slot.** Hairline-topped bar, `--ink-surface` background, always visible; on mobile it carries the safe-area padding. All five flows put their primary/secondary actions here.
9. **Motion.** Mobile: ~320ms slide-up (transform-only) on open; desktop: fast fade/settle (≤220ms). `prefers-reduced-motion` collapses both to instant. CSS transitions, not Framer (no coordinated multi-element choreography here — keep it cheap and immune to the known framer/CSS-transition conflicts).
10. **Overlay.** Existing `bg-black/60 backdrop-blur-sm`; overlay click does **not** close (unchanged from today — none of the five closes on overlay click, and accidental dismissal of long forms is worse than requiring the explicit control).

Shared CSS in `index.css`: retoken `.modal-input`/`.modal-action` radius to 12px; add `.modal-section-label` (the de-emphasis eyebrow for D3/W2) and a `.modal-danger-*` group for D4; add the pulse-dot loading class (reuse if a discovery equivalent already exists — check first).

---

## 3. Waves

### W1 — Primitive + the two simplest migrations (Add Place, Edit Trip)

**Model: Sonnet — well-specified component construction with clear acceptance criteria; the design decisions are already made.**

1. Build `ModalShell` per §2, including the stack registry and refcounted scroll lock (needed by W3 but built once here).
2. Migrate **AddPlaceModal**: shell adoption; `initialFocusRef` on the search input (D5); place-selection-as-hero — search field first, then a hairline + `DETAILS — OPTIONAL` eyebrow above the time/duration/type/note group with dimmed labels (de-emphasis, not disclosure); fix suggestion-row type roles (place name gets the display treatment, secondary text stays Cormorant); footer (Cancel / Add Place) moves to the sticky slot.
3. Migrate **EditTripModal**: shell adoption; `.modal-label` class replaces inline label styles; danger block per D4 with `#e05a5a` tokens replacing `#c0392b`; footer = Cancel/Save only. All three honest-constraint notes preserved verbatim.
4. Unit tests: shell semantics (role/aria/labelledby), Escape → `onRequestClose`, focus trap + return, scroll-lock refcount, stacked Escape scoping. Flow tests updated for moved markup.

**Exit:** frontend tests + build green; both flows verified at 375px (sheet geometry, safe area, keyboard open on AddPlace search) and desktop (centered dialog, Tab cycle, Escape).

**W1 COMPLETE 2026-07-19.** ModalShell built per §2 (stack registry via `useSyncExternalStore`, refcounted scroll lock, trap intercepts only Tab/Escape); 11 shell tests + updated flow tests, suite 165/165, build green. Browser-verified in dev at 375px and desktop: sheet flush-bottom with 16px top corners, `aria-modal`/labelledby, D5 autofocus, Escape → close + focus return + lock release, Tab wrap, danger-block arm/disarm, footer `form=`-attribute Save (PATCH 200), live Places suggestions with corrected type roles (Playfair name / Cormorant secondary). Deviations: none from spec; orchestrator upgraded the mobile entrance from a 24px settle to a true `translateY(100%)` slide (D1). Deferred to owner/W3: motion feel (Browser-pane rAF freeze), real software-keyboard inset, notched safe-area. Noted pre-existing (not a W1 regression): CopilotFab (z-100) floats above modals (z-40+) as it always did.

### W2 — New Trip + Add Booking

**Model: Sonnet — mechanical shell adoption plus field regrouping; riskiest logic (prefill, lookups, draft remapping) is explicitly untouched.**

1. Migrate **NewTripModal**: shell adoption across both phases (capture/details — headline stays phase-dynamic via the `headline` prop); "Skip — start from scratch" promoted from underlined text link to a quiet 44px secondary button in the sticky footer beside Extract; details-phase footer = Back / Cancel / Create in the sticky slot. Capture/extraction logic unchanged.
2. Migrate **AddBookingModal** (all three modes): shell adoption; within each booking type, fields regroup as identity/route/times first, then hairline + `REFERENCE` eyebrow over Confirmation Ref, Booked Via, and timezone selects (D3 — visible, dimmed); footer (Cancel / Save) sticky; edit-mode disabled type pills gain one mono explainer line: "Type is fixed for saved bookings". `bookingForm.js`, lookups, and session-token behavior untouched.
3. CTA radius normalization (D2) across both flows.

**Exit:** tests + build green; 375px verification of both flows including flight and train forms with the keyboard open (reference group reachable, sticky footer never obscured by the keyboard).

**W2 COMPLETE 2026-07-19.** Both flows migrated per spec; suite 165/165, build green. NewTripModal: shell adoption with phase-dynamic headline and phase-switched sticky footer (capture: Skip promoted to bordered 44px secondary + gold Extract with `modal-loading-dots` while reading; details: Back / Cancel / Create via `form=` attribute); reset-on-open effect added (old flow reset by unmounting). CaptureInput gained one opt-out prop (`showExtractAction`, default true) so NewTrip's footer owns Extract while CaptureFlow (W3) keeps its inline button unchanged. AddBookingModal: shell adoption across all three modes; D3 Reference group (hairline + `REFERENCE` eyebrow, `opacity-70` dimming) at the end of each of the four type grids — TzSelects included for train/bus/ferry and other; edit-mode pill explainer "Type is fixed for saved bookings"; D2 CTAs at rounded-xl, no 22px/2xl remain in either file. Logic untouched: prefill, extraction, bookingForm.js, lookups, session tokens, draft remapping. Browser-verified in dev at 375px and desktop: sheet flush-bottom 16px top corners / centered 16px dialog, Escape → close + focus return + scroll-lock release, reset-on-reopen (details → capture), 30-Tab trap wrap inside panel, hotel/flight/train Reference groups above the always-visible sticky footer, edit-mode footer Save via `form=` (PATCH 200), Extract disabled↔enabled on pasted text. Deferred to owner/W3 (Browser-pane rAF freeze): motion feel, real software-keyboard inset, notched safe-area.

### W3 — CaptureFlow + full verification pass

**Model: Sonnet for implementation; Fable orchestrates the final QA pass — the stacked-dialog + Escape-routing + keyboard matrix is where cross-flow regressions would hide, and judgment about "feels right at 375px" sits with the orchestrator/owner, not the coder.**

1. Migrate **CaptureFlow**: shell adoption with stacked AddBookingModal on top (stack registry exercises for real); discard protection moves from header-corner text buttons into an in-body confirm bar with proper 44px targets and `#e05a5a` line/soft tokens; Escape routes through `onRequestClose` → same confirm (a reviewed extraction can never be silently dropped); phase-dynamic eyebrow/headline preserved.
2. Replace `Loader2` spinners in CaptureInput/ExtractionReview with the gold pulse-dot idiom ("Reading…" keeps its copy).
3. Sweep for leftovers: no `rounded-[22px]`, no `#c0392b`/`#f8b4b4`, no raw `fixed inset-0` modal shells outside ModalShell in the five flows.
4. **Verification matrix** (final gate): all five flows × 375px + desktop; software keyboard open on every text-entry step; Tab-cycle + Escape on each; stacked CaptureFlow→AddBooking (trap on top, lock persists, Escape closes top only); reduced-motion (instant, state still legible); safe-area padding on a notched viewport. Motion feel is owner-verified (Browser-pane rAF limitation) — provide a short owner click-script.

**Exit:** matrix green, owner click-script delivered, plan status updated, committed.

---

## 4. Out of scope

- CopilotPanel, DiscoveryPanel, DayPicker, detail sheets — they have their own interaction contracts; a later plan may adopt ModalShell where it fits.
- Any change to extraction prompts, provider calls, payload mapping, or booking form logic.
- Overlay-click-to-close (deliberately not introduced).
- TypeScript, new dependencies (no focus-trap lib — the trap is ~30 lines and the app is JSX-only).

## 5. Risks

- **Keyboard-inset + sticky footer + dvh at 375px** is the fiddliest CSS in the plan; must be verified with the keyboard actually open, not screenshots.
- **Focus trap vs. Places autocomplete**: suggestion buttons use `onMouseDown preventDefault` to keep input focus — the trap must not fight this (trap only intercepts Tab and Escape, never click/focus events).
- **Stacked shells**: a regression here breaks import draft editing, the highest-value flow. W3's matrix is the guard.
- **Browser-pane rAF freeze**: agents cannot see the slide-up; verify settled geometry programmatically and hand motion to the owner.
