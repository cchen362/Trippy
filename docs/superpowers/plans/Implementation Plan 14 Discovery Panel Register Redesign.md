# Implementation Plan 14 — Discovery Panel “Register” Redesign (Option 1b)

**Status: COMPLETE — DEPLOYED (2026-07-15). All five waves, owner-authenticated production QA, and agent console/log/health verification passed. The three non-blocking follow-up observations recorded in §5.4 were subsequently resolved in the Wave 6 presentation follow-up.**

### Implementation progress

| Wave | Status | Record |
|---|---|---|
| 1 — Regression contract | **COMPLETE** | Committed as `c71142d` (`test: lock discovery register contract`). The focused Discovery baseline was 16/26 passing: the 10 failures were the newly locked Option 1b presentation contract. No production file changed. |
| 2 — Compact shell and controls | **COMPLETE** | Committed as `3319dda` (`feat: implement discovery register shell`). `DiscoveryPanel.jsx` and `index.css` provide the committed/edit destination header, header Surprise action, combined category/search controls, category scroll reset, and in-flow Show more. Focused result after Wave 2: 18/26 passing. |
| 3 — Bounded cards and Details | **COMPLETE** | Committed as `6b2627b` (`feat: implement discovery register details`). `SuggestionCard.jsx`, `DiscoveryPanel.jsx`, and `index.css` provide bounded Register summaries, always-visible insight, panel-owned Details selection, inline expansion below 1024px, the wide-desktop detail sheet, responsive one/two/three-column grids, bounded 236px desktop rows, and a matching Show more tile. |
| 4 — Hardening | **COMPLETE LOCALLY** | The two legacy setups now use explicit Search/Change interactions without weakening their assertions. Focused Discovery is 27/27, the full frontend suite is 133/133, the production build and `git diff --check` pass, and authenticated 375×812, 768px, and 1440×900 checks cover the full Register flow. Narrow fixes address mobile target sizing, destination focus, nested Escape/focus return, reduced motion, and safe error presentation. |
| 5 — Release | **COMPLETE** | Released and deployed exact commit `85f9102`. The clean local gate, owner-authenticated production matrix, kept-tab console inspection, production log review, and port-6768 health check all passed; see §5.4. |

**Origin:** owner-selected Option **1b — Register** from the committed,
self-contained [Discovery redesign exploration](../mockups/Discovery%20Redesign.dc.html)
(supplied 2026-07-15), reviewed against the source export's Luxury Dark Design
System and live `main` at `835b74d`.

**Goal:** replace the current tall, article-like Discovery presentation with the
compact Option 1b browsing hierarchy while preserving every shipped Discovery
behavior. The destination becomes a committed header with an explicit Change
mode; categories and search sit directly above results; cards become bounded,
scan-friendly summaries; secondary content moves behind Details; Show more joins
the scrolling result flow; and desktop uses a three-column register with a
right-side detail sheet. The implementation is mobile-first at 375px and has a
deliberate wide-screen treatment.

**Hard scope boundary:** this is a **frontend-only presentation refactor**.
Permitted production changes are limited to Discovery components and production
CSS. Frontend tests may change or be added. No backend file, migration, route,
service contract, provider integration, catalogue behavior, API payload, trip
mutation shape, co-pilot context shape, or navigation behavior may change.

**Explicitly NOT in this plan:** new Discovery functionality; new catalogue
categories; ranking or generation changes; search-provider changes; image/photo
work; a design-token migration; replacing production tokens with the bundled
design-system package; changing the four-tab navigation; changing Discovery from
a Plan panel into a route; changing Add-to-day, report, Surprise, or co-pilot
semantics; modifying `useDiscovery`; modifying `discoveryApi` or `bookingsApi`;
backend work of any kind.

---

## 0. Source-of-truth and interpretation rules

1. **Live behavior wins.** Option 1b specifies the new visual hierarchy, but live
   components, tests, and payloads define the behavior that must survive the
   redesign.
2. **Production tokens win.** Per the design spec §12 and repository guidance,
   `frontend/src/index.css` remains authoritative. The exploration uses nearby but
   non-production values such as `#c9a050`, `#f0ebe3`, and `#1a1410`; implementation
   must use the live variables (`--gold: #c9a84c`, `--cream: #f0ead8`,
   `--ink-mid: #1c1a17`, etc.) rather than importing or copying the external
   design-system tokens wholesale.
3. **Option 1b’s structure is binding.** Preserve its compact committed header,
   category/search control row, clamped summaries, inline mobile details,
   desktop detail sheet, in-flow Show more, and category-switch scroll reset.
4. **The design annotation completes the static frames.** The supplied mobile
   frame shows one collapsed card and one expanded card; the desktop frame shows
   collapsed cards and states that Details opens a right-side sheet. Those stated
   behaviors are part of Option 1b even where a second static frame is absent.
5. **No functionality may become hover-only.** Hover may refine border/text
   emphasis on pointer devices, but Details, Add to day, report, search, and
   co-pilot actions remain explicit and keyboard/touch reachable.

---

## 1. Verified live facts this plan is built on (traced 2026-07-15)

1. **Discovery is already a full-screen Plan panel.** `PlanTab.jsx` mounts
   `DiscoveryPanel` inside `AnimatePresence`; the panel owns its full-screen
   spring entrance/exit and calls the existing `onClose` callback. This mounting
   contract stays unchanged.
2. **The destination already has draft and committed state.** `destination` is
   the live input; `committedDestination`/`committedCountry` key catalogue reads.
   Typing does not blank results, and a manual Go clears country because the
   free-text control has no country field. The redesign exposes this existing
   distinction as committed-header and edit modes; it must not collapse the two
   states.
3. **Active-day changes already reset the default destination and trigger
   discovery.** The existing effect derives city/country from resolved day
   geography first. It must remain the only defaulting path; the redesign must
   not infer destination from the trip title or first scope ad hoc.
4. **Tabs are behavior-bearing, not decorative.** `buildTabs` combines
   Essentials, interest-mapped named categories, and a terminal More bucket.
   `categoriesForTabKey` makes every returned category reachable exactly once;
   the total curated count is derived from those reachable buckets.
5. **Results stream incrementally.** `useDiscovery` retains partial results while
   category chunks arrive and while Show more appends de-duplicated places. The
   new fixed-height desktop cards must not imply fixed result counts or clear the
   grid during append.
6. **Search is a dual-source flow.** At two characters, the panel filters loaded
   catalogue places across name, local name, aliases, and description. At three
   characters, the same query also performs debounced Google Places autocomplete
   with a session token and renders an “On the map” fallback. Selecting a map
   result completes the details request with that token before adding it.
7. **Add to day has two payload paths.** Verified suggestions with coordinates
   use the trusted-coordinate payload; other suggestions use server-side
   resolution. Manually searching another city must not stamp the active day’s
   country onto the result. These payload branches are outside the visual refactor.
8. **Suggestion pending state is per card.** A card disables only its own Add
   action while the create/refresh chain is in flight. The redesign must preserve
   this local guard and its `Adding…` label.
9. **“In trip” is city-scoped and can represent multiple days.** Matching uses
   canonical destination identity plus normalized stop title. Current cards show
   every matched day, not only a boolean. Option 1b’s compact `In trip · Day 2`
   treatment must scale to multiple day references without losing information.
10. **Report is deliberately two-step.** The flag first reveals `Not real` and
    `Closed`; only a reason tap calls the suppress endpoint. Fresh streamed places
    without a catalogue id cannot be reported. Details may relocate this control,
    but cannot turn it into a one-tap report.
11. **Co-pilot context is already wired through every suggestion path.** Category,
    search, More, and Surprise cards forward
    `{ tab: 'discovery', discoveryName: name }`. Details must preserve that exact
    context and must not send or mutate anything by merely opening.
12. **Surprise is a spotlight flow, not simple sorting.** It excludes already
    added places, can wait for the initial catalogue load, and opens an overlay
    with Another and Dismiss. Option 1b moves the trigger into the compact header;
    the spotlight behavior stays intact.
13. **Show more has an honest loading state.** Existing results stay visible while
    the action changes to `Finding more places…`; it returns to Show more when the
    append finishes. Moving it into the scrolling list must preserve this state.
14. **The current grid stretches cards to the tallest item in a row.** Full
    descriptions and hover-revealed insight produce desktop dead space. The
    redesign fixes that by clamping summary fields and using bounded 236px rows at
    wide desktop, not by deleting content.
15. **Current Discovery tests protect the important data contracts.** They cover
    co-pilot forwarding, More/count honesty, Show more loading, trusted and
    unverified add payloads, cross-city country behavior, report confirmation,
    city-scoped In trip, and per-suggestion pending state. All remain mandatory.

---

## 2. Option 1b design contract

### 2.1 Panel shell and committed destination header

- Keep the full-screen dark-ink panel and its existing spatial slide transition.
- **Mobile (375px):** one compact 52px-ish header row: close control; Playfair
  italic destination; compact total place count; `Change`; and an icon-only
  Surprise control. The icon receives an accessible `Surprise me` name and a
  minimum 44px interaction box even though the glyph is visually small.
- **Desktop:** use the supplied wider hierarchy: 32px horizontal inset, 28px
  destination, `N curated places`, bordered Change action, and the text-labelled
  `Surprise me` action at the far right.
- Remove the separate `Discover` title bar and the large destination hero. The
  destination itself is the page identity.
- Clicking Change switches only the header’s identity region into the existing
  destination input + Go state. Existing results remain visible while the draft
  is edited. Successful Go commits the trimmed city, clears country exactly as it
  does today, starts/reuses discovery, restores committed-header mode, and resets
  to the first reachable tab.
- While loading, preserve the existing disabled/working Go state. Empty drafts
  remain non-submittable. Do not auto-commit on blur.

### 2.2 Category and search control row

- Place categories immediately below the header and directly above results.
- Preserve the exact tab list, tab order, More grouping, counts, loading dots,
  and active category logic.
- Mobile tabs use a horizontally scrollable, clipped strip. The active tab has
  the single gold underline; inactive tabs use muted cream. No category is
  removed merely because the 375px frame cannot display all labels at once.
- Mobile search starts as a dedicated 44px search control at the row’s right edge,
  separated by a hairline. Activation expands a real input in place and reduces
  the tab strip’s available width, matching “pushes the tab row aside.” The
  expanded state includes an explicit clear/collapse control; clearing returns to
  the active category view without changing the committed destination.
- Desktop keeps the full category row and renders the 260px search field at the
  far right as shown in Option 1b.
- Changing category performs two actions only: update the active category and
  synchronously return the Discovery results scroller to `scrollTop = 0`. It does
  not mutate search text, refetch, or change destination. If a search query is
  active, category switching may update the selected tab visually but the query’s
  search results remain authoritative until the query is cleared.

### 2.3 Result summaries

- Collapsed cards use the Option 1b register hierarchy:
  - Playfair italic place name, with local name included under the existing
    duplicate-suppression rule;
  - compact duration at the upper right when available, or an In trip state that
    also exposes its matched day reference(s);
  - description clamped to two lines;
  - one visible italic insight line clamped to one line, prefixed by a restrained
    gold mark;
  - bottom action row with Add to day / Added at left and Details at right.
- Preserve `fitLine` as a distinct honesty-gated field. Because Option 1b budgets
  one visible insight line, the collapsed card shows `fitLine` when present and
  otherwise falls back to `whyItFits`/`whyItMatches`. The full insight remains in
  Details. Do not concatenate both into an unclamped summary.
- **Mobile:** one-column cards use 16px/18px inset, 4px radius, restrained border,
  10px vertical rhythm, and content-derived height after clamping. The first card
  should begin at roughly 110px on a 375×812 viewport, matching the exploration.
- **Wide desktop (≥1024px):** three equal columns, 16px gaps, fixed 236px rows,
  20px/22px card inset, two-line title clamp, two-line description clamp, one-line
  insight clamp, and actions pinned to the bottom. A long title or translated
  local name must not increase the row height.
- **Intermediate widths (640–1023px):** use two columns when they fit; retain the
  bounded summary and open Details inline. The right-side sheet is reserved for
  widths that can keep useful catalogue context visible beside it.
- Replace the old hover-hidden Local insight behavior. The summary insight is
  always visible on touch and pointer devices. Hover may brighten the border and
  Details label, but must not change card height.

### 2.4 Details behavior

- Details is controlled selection owned by `DiscoveryPanel`, keyed by a stable
  suggestion identity. Only one suggestion may be expanded at a time. Closing
  Details returns focus to the triggering control when possible.
- **Mobile and intermediate widths:** expand within the selected card. Keep the
  card in the same list position; do not open a modal or move the user to a new
  route. The expanded border strengthens modestly and Details changes to an
  explicit collapse affordance.
- Inline detail reveals, in this order: full description; labelled Local insight
  with full text; fit line if it was not already the same visible summary; verified
  or unverified provenance; stale-hours hint with the existing `— verify` wording;
  all In trip day references; and the secondary action row.
- **Wide desktop:** Details opens a right-side sheet inside the Discovery panel,
  below the committed header/control chrome so destination and category context
  remain visible. Target width is 420–440px, bounded by the viewport. It has its
  own close control and internal scrolling, does not navigate, does not resize the
  grid, and does not add a modal scrim. The originating summary card remains in
  place with a selected-border state.
- The expanded secondary action row preserves `Ask co-pilot`, the report flag and
  its two-step confirmation, and collapse/close. `Add to day` / Added remains the
  primary action in both collapsed and detailed states and must share the same
  pending state—never render independent duplicate action state.
- Search, More, and Surprise results use the same Details behavior. If a selected
  item disappears after a successful report, clear the detail selection before or
  with the existing exit animation so no stale sheet remains.

### 2.5 In-flow Show more and preserved auxiliary states

- Remove the fixed gradient footer entirely.
- Keep Surprise solely in the committed header; do not render a second footer
  trigger.
- Mobile/intermediate Show more is a full-width in-flow control after the current
  list. Desktop Show more is the final dashed 236px grid tile, with a second muted
  line describing the remaining/category context only if that value is already
  derivable from current client state. Do not invent a backend “remaining count.”
- Preserve the existing disabled and `Finding more places…` state within the new
  in-flow control/tile. Existing cards stay visible during append.
- Search results keep both catalogue cards and the `On the map` section. Map
  prediction rows may remain compact rows; they are not forced into catalogue
  card anatomy because they have different evidence and Add behavior.
- Preserve loading skeletons, category-empty copy, no-results search copy, initial
  empty prompt, errors, Surprise overlay, Another, Dismiss, report exit animation,
  DayPicker positioning, and full panel close behavior. Restyle only where needed
  to fit the new spacing hierarchy.

### 2.6 Type, color, spacing, and interaction details

- Use only Playfair Display italic for destination/place names, Cormorant Garamond
  for narrative text, and DM Mono for labels/counts/actions/status.
- Use live CSS variables wherever a matching token exists. No raw exploration
  color should override a production variable merely to match the exported HTML.
- Gold appears once in each local component hierarchy: active underline or key
  status/action—not simultaneous gold title, border, icon, badge, and button.
- Body copy remains at least 16px. Compact tracked mono metadata may be 9–11px.
- Interactive targets are at least 44px at 375px, including close, Surprise,
  search, Change, Details, and report. Visual glyph size may remain 13–17px.
- Use CSS for clamping, hover/focus, and small state transitions; retain Framer
  Motion for panel entrance and report-card exit. Do not add decorative movement.
- Add explicit `:focus-visible` treatment through the existing gold focus idiom.
  Keep reduced-motion behavior intact; detail opening must be usable with
  transitions effectively disabled.

---

## 3. Implementation structure

### Files expected to change

- `frontend/src/components/discovery/DiscoveryPanel.jsx`
- `frontend/src/components/discovery/SuggestionCard.jsx`
- `frontend/src/components/discovery/DiscoveryPanel.test.jsx`
- `frontend/src/components/discovery/SuggestionCard.test.jsx`
- `frontend/src/index.css`

### Files expected to remain unchanged

- `frontend/src/hooks/useDiscovery.js`
- `frontend/src/services/discoveryApi.js`
- `frontend/src/services/bookingsApi.js`
- `frontend/src/pages/PlanTab.jsx` unless a test proves a presentation-only prop is
  strictly required; no routing, state ownership, or open/close semantics may move
- every file under `backend/`
- all migrations and runtime configuration

### Component/state approach

1. Keep catalogue/destination/search/business state in `DiscoveryPanel` where it
   lives today.
2. Add presentation state only: destination edit mode, mobile search-expanded
   mode, selected detail identity, and a results-scroller ref.
3. Pass controlled detail props into every `SuggestionCard` path through one
   shared grid/render helper so category, More, search, and Surprise cannot drift.
4. Keep per-suggestion add/report state in the existing card instance. Render one
   action owner and reposition its detail region responsively; do not mount a
   second independent Add/report controller in the desktop sheet.
5. Reuse `useMediaQuery` only if DOM behavior—not merely layout—must differ at the
   wide desktop detail-sheet breakpoint. Prefer CSS media queries for grid,
   spacing, clamping, and visibility.
6. Add narrowly named Discovery CSS classes for clamps, grid breakpoints, focus,
   selected/expanded state, and responsive detail positioning. Do not introduce a
   global token layer or copy the external `_ds/styles.css` into production.

---

## Wave 1 — Lock the regression contract in frontend tests (COMPLETE 2026-07-15)

**Scope: frontend tests only. No production behavior change.**

1. Retain every existing `DiscoveryPanel` and `SuggestionCard` test.
2. Add a committed/edit destination test proving:
   - results remain visible after Change and while typing;
   - Go commits the trimmed destination;
   - manual Go still calls discovery with `country = null`;
   - the committed header returns after submission.
3. Add category-switch scroller coverage by mocking the results element’s
   `scrollTop`/`scrollTo` contract and proving the switch returns it to top without
   calling `discover` or `showMore`.
4. Add search-control coverage for collapsed mobile search, expanded input,
   catalogue filtering, three-character Google fallback, clear/collapse, and no
   destination mutation.
5. Add Details coverage for collapsed clamps/summary fields and expanded full
   fields. Prove opening Details causes no Add, report, or co-pilot callback.
6. Add interaction preservation tests from Details: exact co-pilot context,
   two-step report, Add DayPicker and pending guard, and In trip multi-day labels.
7. Add Show more placement/state coverage: one reachable in-flow action, disabled
   working label during append, and no fixed duplicate footer trigger.
8. Add selected-item cleanup coverage after report and after category/search state
   makes the selected item unavailable.

**Acceptance:** the new assertions accurately describe Option 1b and initially
fail only on missing presentation behavior; all pre-existing behavioral tests
still pass before production edits begin.

**Completion record:** committed as `c71142d` (`test: lock discovery register
contract`). Both existing component test files were retained and expanded without
production changes. The focused command reported **16/26 passing, 10 failing**;
the failures described the unimplemented committed/edit header, scroll reset,
mobile search, in-flow Show more, bounded card summary, and Details behavior.

---

## Wave 2 — Compact panel shell, destination header, and controls (COMPLETE LOCALLY 2026-07-15)

**Scope: frontend presentation only.**

1. Replace the separate title row, always-visible destination form, and hero with
   the responsive committed destination header.
2. Implement Change as a view-state transition over the existing draft/commit
   logic; do not rewrite default geography or discovery calls.
3. Move Surprise into the header and keep the existing spotlight handler.
4. Merge categories and search into the Option 1b control row. Implement the
   mobile expanding search field and desktop persistent field without changing
   query thresholds, debounce, session-token, or Google details behavior.
5. Add a dedicated results-scroller ref and reset it on category selection.
6. Remove the fixed footer and place the existing Show more action in normal
   result flow, retaining its working state.
7. Preserve panel entrance/exit, loading, error, empty, search, and Surprise
   states throughout the shell change.

**Acceptance:** at 375px the first card begins around the exploration’s ~110px
target when results exist; destination editing never blanks committed results;
tabs/search remain reachable; category switching returns results to top; no footer
obscures content; all Wave 1 and existing tests pass.

**Completion record:** implemented only in `DiscoveryPanel.jsx` and `index.css`.
The old title/input/hero stack is replaced by the responsive committed header;
Change reuses the existing draft/commit path; Surprise is in the header; mobile
search expands within the category row while wide desktop keeps a 260px field;
category selection synchronously resets the labelled results scroller; and Show
more now appears once in normal result flow with its existing loading state. No
hook, service, API, backend, navigation, catalogue, or card-detail behavior was
changed.

Focused verification after Wave 2: **18/26 passing, 8 failing**. The following
five Wave 1 shell contracts now pass:

- committed destination edit/trim/Go while results stay visible;
- category switch resets scroll without `discover` or `showMore`;
- mobile search expands, filters, clears, and preserves destination state;
- two-character catalogue filtering plus three-character Google fallback;
- exactly one in-flow Show more action with the honest working label.

Six failures correctly remain for Wave 3: four `SuggestionCard` bounded-summary /
Details cases and the two `DiscoveryPanel` selected-Details cleanup cases. Two
additional failures expose a contradiction between retained legacy assertions and
the new Wave 1 contract: the old co-pilot test expects `Find a place…` to exist on
initial render while the mobile contract requires it absent until Search is
activated; the old cross-city test expects `Destination` on initial render while
the committed-header contract requires it absent until Change. Production was not
branched around test identity and the tests were not weakened or rewritten. Wave 3
must preserve the behavioral intent by exercising those legacy flows through the
new explicit Search and Change controls.

`npm run build` and `git diff --check` pass. An attempted 375px browser pass reached
the unauthenticated login screen, so the authenticated first-card position and
interaction check remain outstanding for Wave 4 rather than being claimed complete.

---

## Wave 3 — Bounded cards and responsive Details

**Scope: `SuggestionCard`, Discovery layout/CSS, and tests only.**

1. Recompose the collapsed card to the Register summary hierarchy and add
   two-line/one-line clamps with full text retained in Details and accessible DOM.
2. Replace hover-only insight reveal with the always-visible summary insight.
3. Preserve duration, provenance, hours, fit-line honesty, In trip city scoping,
   all matched days, Add/Added, DayPicker, per-card pending, report, and co-pilot.
4. Lift only detail selection to `DiscoveryPanel`; keep one selected suggestion and
   one action-state owner.
5. Implement inline mobile/intermediate expansion and the ≥1024px right-side
   detail sheet, including focus return, internal scroll, explicit close, selected
   card state, and no grid resizing.
6. Apply the responsive grid: one column at mobile, two where space permits, three
   bounded 236px rows at wide desktop. Convert desktop Show more into the final
   matching grid tile.
7. Ensure category, More, filtered search, and Surprise paths all share the same
   card/detail implementation rather than branching markup.

**Acceptance:** long translated titles, descriptions, insights, hours, and multiple
In trip days do not change desktop row height; no information is lost; opening or
closing Details has no data side effect; all actions retain their exact callbacks
and pending/report semantics.

**Completion record (2026-07-15):** implemented only in
`frontend/src/components/discovery/SuggestionCard.jsx`,
`frontend/src/components/discovery/DiscoveryPanel.jsx`, and
`frontend/src/index.css`. Collapsed cards use two-line title/description clamps and
a one-line, always-visible insight while full description, insight, fit line,
provenance, duration, hours, and matched trip days remain available in Details.
`DiscoveryPanel` owns one selected detail identity and passes the same controlled
behavior through category, More, filtered search, and Surprise paths. Details are
inline below 1024px and become an internally scrolling right-side sheet at the
wide breakpoint without resizing the three-column, 236px-row grid. The existing
Add/Added, DayPicker, per-card pending guard, report confirmation, co-pilot
context, city-scoped multi-day In trip, and report-removal behavior remain intact.

The six intended Wave 3 failures now pass:

- bounded summary content and expanded metadata without side effects;
- exact co-pilot context and two-step report behavior after opening Details;
- DayPicker and per-card pending behavior after opening Details;
- compact multi-day In trip rendering;
- selected Details cleanup after reporting the place;
- selected Details cleanup when category or search state makes it unavailable.

Focused verification is **24/26 passing** with
`npm test -- DiscoveryPanel.test.jsx SuggestionCard.test.jsx`. The two remaining
failures are the previously documented legacy interaction-setup contradictions,
not Wave 3 behavior failures:

1. The co-pilot forwarding test reads `Find a place…` on initial mobile render,
   while the Wave 1 contract requires Search to be collapsed initially. Wave 4
   must click the explicit `Search` control before entering the query.
2. The cross-city country test reads `Destination` on initial render, while the
   committed-header contract requires the editor to be closed initially. Wave 4
   must click `Change` before entering and committing the other city.

Those are interaction-setup reconciliations only: do not restore initially visible
inputs, branch production behavior for tests, remove assertions, or weaken the
payload/context expectations. `git diff --check` passes and Vite successfully
compiled and served the updated production CSS. An authenticated responsive pass
remains blocked at the login screen; Wave 4 must complete the 375px, 768px, and
1440px interaction matrix with an authenticated session rather than treating the
source-level breakpoint check as visual acceptance.

---

## Wave 4 — Interaction, accessibility, and regression hardening

**Scope: frontend verification and narrowly justified fixes only.**

1. Run focused Discovery component tests, then the full frontend test suite and
   production build.
2. Verify keyboard operation: logical tab order, visible focus, Enter/Space on
   actions, Escape behavior for existing DayPicker/report flows, and focus return
   from Details. Do not introduce a global Escape-to-close behavior that conflicts
   with nested controls.
3. Verify 375×812 with touch/coarse pointer:
   - all critical controls reachable at ≥44px;
   - tabs horizontally reachable;
   - search expansion does not push its clear control off-screen;
   - destination edit works with the software keyboard;
   - inline Details and DayPicker remain scrollable/reachable;
   - Show more is not covered by any fixed chrome.
4. Verify desktop at 1440×900 with pointer and keyboard:
   - three columns and 236px rows;
   - full search field and labelled Surprise;
   - right-side detail sheet leaves useful grid context visible;
   - sheet scroll is contained and closing restores focus;
   - card hover causes no layout shift.
5. Verify an intermediate 768px viewport to catch the intentional two-column /
   inline-detail handoff.
6. Verify reduced motion, long CJK/local names, missing optional fields, no
   catalogue id, multiple In trip days, streaming category arrival, Show more
   append, report removal, slow Add, search with and without Google results, error,
   and empty states.
7. Inspect the final git diff and prove the frontend-only boundary. Any backend,
   migration, hook, service, route, or configuration change is a stop condition,
   not something to fold into this plan.

**Acceptance:** focused and full frontend tests pass; `npm run build` passes; manual
375px, 768px, and 1440px checks match Option 1b; no existing behavior regresses;
the implementation diff against the committed Plan 14 baseline contains only the
approved frontend component/CSS/test files.

**Completion record (2026-07-15):** Wave 4 was completed from `6b2627b` with no
backend, migration, hook, service, API, dependency, or runtime-configuration
change. The two legacy contradictions were reconciled only in test setup: the
co-pilot forwarding test opens Search before reading `Find a place…`, and the
cross-city test opens Change before reading `Destination`.

Hardening found and narrowly fixed four presentation/accessibility regressions:

- mobile card actions and report controls now meet the 44×44 target floor;
- Change focuses the destination input, and closing Details or nested
  DayPicker/report Escape returns focus to the initiating control without adding
  a conflicting panel-wide Escape handler;
- Discovery motion respects the user's reduced-motion preference; and
- provider error payloads/request ids are no longer rendered to the user—the
  panel presents a clean retry message while the underlying failure remains
  available to logs.

Final local evidence:

- focused Discovery: **27/27**;
- full frontend: **133/133** across 23 files;
- production build: **PASS** (the existing Vite large-chunk warning remains);
- `git diff --check`: **PASS**;
- authenticated 375×812: one-column Register, no horizontal overflow, all visible
  Discovery actions at least 44×44, search clear reachable, category scroll reset
  measured `536 → 0`, Add observed `Adding… → Added`, nested Escape/focus return,
  multi-day In trip, report removal, Surprise, co-pilot, Show more, error, and
  empty states exercised;
- authenticated 768px: two 361px columns and inline Details;
- authenticated 1440×900: three 448px columns with 236px rows, full search,
  labelled Surprise, and a 440px right detail sheet. An extended-content fixture
  measured 3142px of sheet content inside a 499px internal scroller while the
  grid remained in place.

The local browser exposed a fine pointer and no media-preference override. The
44×44 touch contract, touch/outside handlers, `MotionConfig reducedMotion="user"`,
and reduced-motion CSS are implemented and covered by source/test/build review;
the final Wave 5 browser gate must still re-confirm coarse-pointer operation and
the OS/browser reduced-motion mode on a capable surface before deployment.

---

## Wave 5 — Final QA, production deployment, and post-deploy verification

**Scope: release validation and operations only. No application-code fixes are
made during the deployment session. If any gate fails, stop, return to the relevant
implementation wave, fix and re-verify locally, then begin Wave 5 again from a
clean commit.**

### 5.1 Final local release gate

1. Confirm the implementation is committed and the working tree is clean. Review
   the complete commit range intended for release, not only the latest commit.
2. Prove scope before merge/push:
   - production changes are confined to the approved Discovery frontend
     components and CSS;
   - frontend test changes cover those presentation contracts;
   - Plan 14 status/deployment notes are the only permitted documentation changes;
   - there are no backend, migration, service, hook-business-logic, runtime config,
     dependency-lock, database, `.env`, log, or generated-file changes.
3. Re-run at the exact release commit:
   - focused Discovery tests;
   - the full frontend test suite;
   - the frontend production build;
   - the full backend test suite as a deployment regression gate, even though no
     backend code changed;
   - `git diff --check` over the release range.
4. Perform one final interactive pass at 375×812, 768px, and 1440×900 against the
   release commit. Recheck the full Wave 4 matrix, including keyboard, coarse
   pointer, reduced motion, long content, Details, DayPicker, search, category
   reset, Show more, Surprise, report confirmation, and co-pilot entry context.
5. Review the release diff for secrets and confirm `.env`, `data/`, SQLite files,
   logs, and local artifacts are not tracked.
6. Confirm the deployment branch. If implementation occurred on a feature branch,
   merge that branch into `main` only after all gates pass and resolve conflicts by
   preserving the tested Option 1b behavior—never by dropping tests or unrelated
   shipped functionality.
7. Verify production-server access before pushing:
   `ssh chee@100.94.82.35 "echo ok"`. If access fails, stop before changing the
   remote repository or production state.

### 5.2 Push and production update

1. Push the verified `main` commit to `origin`.
2. Before pulling on the Debian server, record:
   - the currently deployed commit;
   - `docker ps` / current `trippy-trippy-1` container state;
   - the latest database backup time;
   - confirmation that the daily backup cron is still active.
3. Confirm a fresh backup of `~/Trippy/data/trippy.db*` exists, or create one in the
   established backup location before updating. The database is outside the
   container and must not be moved, deleted, or recreated by this release.
4. Pull `main` in `~/Trippy`. Confirm the pulled commit matches the locally verified
   release hash and confirm again that this frontend-only release contains no new
   migration.
5. Rebuild and restart with the server’s established Compose v2 command:
   `docker compose up -d --build`.
6. Tail `trippy-trippy-1` logs until startup is clean. Stop on build, missing-env,
   startup, or migration errors; do not improvise a production hotfix.
7. Verify the server-local health endpoint at
   `http://localhost:6768/api/health`. Port 3001 belongs to another application and
   is not a valid Trippy health check.

### 5.3 Authenticated post-deploy product QA

The owner performs the authenticated/mutating browser pass. The deployment agent
must not request credentials or perform those mutations on the owner's behalf.

**Owner click script:**

1. Open production, sign in, and keep this tab open after the pass so the agent can
   inspect its captured browser console. Confirm Trips loads, then open one safe
   representative trip and briefly visit Today, Plan, Map, and Logistics.
2. At **375×812** in Plan, open Discovery and verify the compact destination,
   count, Change, and icon-only Surprise header. Close and reopen it once.
3. Tap Change, edit the destination without submitting, confirm current cards stay
   visible, restore the original destination, and submit Go. Open Search, enter a
   two-character catalogue match, extend it to three characters, confirm the map
   fallback behaves honestly, then clear Search.
4. Scroll the results, switch category, and confirm results return to the top.
   Open More and Surprise; use Another once, then Dismiss.
5. Open Details on a long/local-name card. Confirm full content is reachable and
   closing returns focus. Open Add to day, cancel it with Escape, reopen it, add
   one owner-safe suggestion to a chosen day, observe Adding/Added, then remove
   that test stop through Plan before finishing.
6. Open report on a real catalogue place, confirm `Not real` and `Closed` appear,
   then cancel—do **not** submit either reason. Open Ask co-pilot and confirm the
   selected place context appears without sending a message; close co-pilot.
7. Scroll to Show more, activate it once, confirm existing cards remain while its
   working label is shown, and verify the final result/action is not covered by
   fixed chrome.
8. At **768px**, confirm two columns and inline Details. At **1440×900**, confirm
   three bounded 236px rows, full Search, labelled Surprise, stable hover, and the
   internally scrolling 440px right-side detail sheet with useful grid context.
9. With OS/browser **reduced motion enabled**, reopen/close Discovery and Details;
   confirm they remain usable without spatial animation. If the browser supports
   touch/coarse-pointer emulation, repeat Search, Details, DayPicker Escape, and
   the last-result reachability check at 375×812.
10. Report `PASS` or `FAIL` for each step, the trip/day used, viewport/browser,
    approximate test time, any visible error text, and whether the test stop was
    removed. Do not include credentials, cookies, tokens, or confirmation data.

After the owner reports back, the deployment agent inspects the kept production
tab's browser console and checks `trippy-trippy-1` logs plus the port-6768 health
endpoint for the reported time window. Record console/log findings separately
from the owner's product observations. Do not patch production in place; any
abnormality returns to local root-cause analysis and the appropriate wave.

### 5.4 Completion record and rollback

1. Record in this plan: implementation commit, merge/release commit, deployed
   commit, container status, health result, local test/build results, authenticated
   mobile/desktop checks, and any non-blocking observation.
2. Mark Plan 14 closed in production only after every required local and production
   gate passes. “Container is running” or “build is green” alone is not completion.
3. If startup or feature verification fails, roll back to the recorded previous
   commit and rebuild. Restore the database backup only if the database was
   actually migrated or damaged; this frontend-only release should never require a
   database restore. Report the failure and root-cause it locally before attempting
   another deployment.

### Wave 5 completion record (2026-07-15)

**Commits and scope**

- Implementation commits: `c71142d` (regression contract), `3319dda` (Register
  shell), `6b2627b` (bounded cards and Details), and `85f9102` (hardening).
- Release and deployed commit: `85f91021726f62271cbcfea0d201fd36e7acc5ab`
  on `main`. There was no merge commit.
- The audited Plan 14 release range was `835b74d..85f9102`. Production changes
  were confined to the approved Discovery components and `index.css`; test and
  Plan/mockup documentation files were the only other changes. No backend,
  migration, hook-business-logic, service, runtime configuration, dependency
  lock, database, `.env`, log, secret, or generated-file change shipped.

**Final local gate**

- Working tree clean at the exact release commit; release-range scope, secret,
  tracked-artifact, and `git diff --check` reviews passed.
- Focused Discovery tests: **27/27 PASS**.
- Full frontend suite: **133/133 PASS** across 23 files.
- Frontend production build: **PASS**; only the existing large-chunk advisory was
  emitted.
- Full backend suite: **PASS**.
- Authenticated 375×812, 768px, and 1440×900 passes covered keyboard/focus,
  search, categories and reset-to-top, More, Surprise, Details, DayPicker,
  Show more append/loading, report cancellation, co-pilot context entry, long
  local content, one/two/three-column layout, the wide detail sheet, and stable
  hover. The owner separately enabled Chrome coarse-pointer emulation and
  `prefers-reduced-motion: reduce` against localhost; both media queries and the
  required interaction subset passed before deployment.

**Deployment evidence**

- SSH access was verified before push. Previous production commit:
  `cd35e74894ded8f66e5db13791ab5ff9a0aab2c8`.
- Pre-update container: `trippy-trippy-1`, up on
  `0.0.0.0:6768->3001/tcp`. Daily backup and backup-health crons were active.
- Fresh integrity-checked backup:
  `/home/chee/backups/trippy-2026-07-14-132328.db` (server timezone `-06:00`).
- `~/Trippy` fast-forwarded to exact commit `85f9102`; the release contained no
  migration. `docker compose up -d --build` completed and recreated the container
  without a production hotfix.
- Startup log: `Trippy backend running on :3001 [production]`. Final server-local
  health on port 6768: `{"status":"ok","db":"connected"}`.

**Owner-authenticated production observations**

- Owner reported the complete §5.3 matrix **PASS** using trip
  `Shanghai - Hangzhou (W4 Test)`, including mobile, intermediate, desktop,
  reduced-motion, and coarse-pointer passes. The temporary Add-to-day stop was
  removed, report was cancelled without submission, and no co-pilot message was
  sent.
- The kept production tab was last active at approximately
  `2026-07-14T19:38:30Z`. Agent inspection found **no browser console warnings or
  errors**.

**Agent production log and health evidence**

- Logs were inspected separately for the complete post-deploy window from
  `2026-07-14T19:24:00Z` through approximately `19:41:28Z`. They showed the
  owner-safe Discovery add, Shanghai Show more generation, catalogue insert
  de-duplication, and asynchronous verification. There were no startup,
  migration, missing-environment, request, or unhandled runtime errors.
- At inspection, production remained at exact commit `85f9102`,
  `trippy-trippy-1` was up on port 6768, and the health response remained
  `{"status":"ok","db":"connected"}`.

**Deviations and remaining issues**

- The first local browser surface could not emulate coarse pointer or reduced
  motion, so deployment stopped. After the Chrome plugin became available, the
  owner performed those two localhost gates directly and reported both PASS;
  deployment resumed only afterward.
- Production had not yet pulled two already-pushed documentation-only commits
  (`f21a997`, `835b74d`). They arrived in the same fast-forward as Plan 14 but did
  not alter the audited Plan 14 release range or production runtime.
- Three non-blocking presentation follow-ups were observed in production and are
  deliberately not hotfixed in this ops-only wave: the desktop search input has
  an accessible name but no visible placeholder; destination Change mode has Go
  but no Cancel/Escape-to-cancel action; and at a narrowed desktop width the
  horizontally overflowing category strip hides its scrollbar while the fixed
  search field consumes 260px, leaving Architecture clipped and Wellness offscreen
  without an obvious pointer affordance. Search, destination submission, and the
  prescribed 375px/768px/1440px category gates still passed. These findings belong
  in a separately scoped presentation follow-up.

**Final status:** Plan 14 is closed in production. Every required local,
deployment, authenticated product, console, log, and health gate passed; the
remaining observations above are documented non-blocking follow-ups rather than
unreviewed production changes.

**Acceptance:** verified `main` is pushed and deployed; `trippy-trippy-1` is healthy
on port 6768; authenticated baseline and Option 1b checks pass at mobile and
desktop widths; no production-only hotfix was made; the plan contains an auditable
release and verification record.

---

## Wave 6 — Post-release presentation follow-up (COMPLETE 2026-07-15)

**Scope: frontend presentation only, same hard boundary as the original plan —
Discovery components and production CSS plus their tests. No backend, hook,
service, API, catalogue, provider, or navigation change.** This wave clears the
three non-blocking presentation observations recorded in §5.4.

### Observations, root causes, and fixes

1. **Desktop search field rendered visually empty.** Root cause: the desktop
   search `<input>` in `DiscoveryPanel.jsx` carried `aria-label="Search places"`
   but no `placeholder`, while the mobile field had `placeholder="Find a place…"`.
   Fix: added a visible placeholder to the desktop input. Per owner request the
   desktop hint matches the mobile copy exactly — both read **"Find a place…"** —
   while the desktop input keeps its descriptive `aria-label="Search places"`. The
   previously unlabeled mobile input was also given `aria-label="Find a place"`,
   closing a real accessible-name gap and keeping the two same-placeholder inputs
   uniquely addressable.

2. **Destination Change mode had no cancel path.** Root cause: the
   `destinationEditing` editor exposed only Go and an Enter handler, so the only
   exits were committing or closing the whole panel. Fix: added an explicit
   **Cancel** button (rendered only when a committed destination exists, never
   disabled while loading) and **Escape-to-cancel** scoped to the destination
   input's `onKeyDown` (no panel-wide handler, so nested DayPicker/report Escape
   and panel close are unaffected). Cancelling discards the draft, restores the
   committed destination, leaves committed results untouched (they are keyed on
   `committedDestination`, which cancel never mutates), fires no new lookup, and
   returns focus to the Change button via a deferred-focus effect that runs after
   the committed header re-mounts.

3. **Category strip clipped at intermediate desktop widths.** Root cause: at
   ≥1024px the fixed 260px `.discovery-desktop-search-field` (`flex-shrink:0`)
   plus the 32px horizontal insets squeezed the flex track, overflowing the ~9
   tabs between roughly 1024px and ~1350px; the strip kept the mobile touch idiom
   (`overflow-x:auto` with a hidden scrollbar), so a mouse user had no affordance
   to reach Architecture/Wellness. Fix (CSS only, desktop breakpoint): revealed a
   thin gold-tinted horizontal scrollbar on the tab strip so mouse users get a
   visible, draggable affordance (coarse pointer still swipes; keyboard focus
   still scrolls a focused tab into view), and made the desktop search field
   `width: clamp(200px, 18vw, 260px)` so it yields room to the tab strip at
   intermediate widths while restoring ~260px at wide desktop. No tab was removed,
   reordered, or wrapped; the compact single-row Register hierarchy is preserved.

### Files changed

- `frontend/src/components/discovery/DiscoveryPanel.jsx`
- `frontend/src/index.css`
- `frontend/src/components/discovery/DiscoveryPanel.test.jsx`

### Regression coverage added

- Desktop input shows the `"Find a place…"` placeholder and retains its
  `aria-label="Search places"`.
- Cancel restores the committed header and results without refetching and returns
  focus to Change.
- Escape in the destination input cancels the edit identically to Cancel.
- Every named category tab — including Architecture and Wellness — renders.
- Seven pre-existing mobile-search assertions were migrated from
  `getByPlaceholderText(/find a place/i)` to `getByRole('textbox', { name:
  /find a place/i })` because, once the two inputs share a placeholder, the mobile
  input is disambiguated by its accessible name rather than its placeholder. No
  existing assertion intent was weakened.

### Verification

- Focused Discovery (`DiscoveryPanel.test.jsx SuggestionCard.test.jsx`): **31/31
  PASS**.
- Full frontend suite: **137/137 PASS** across 23 files.
- Frontend production build: **PASS** (only the pre-existing large-chunk advisory).
- `git diff --check`: clean.
- Local dev servers recompiled with no console or server errors; the diff touches
  only the three approved frontend files.
- Owner-authenticated browser QA at 375×812, 768px, ~1243px, and 1440×900:
  reported **PASS** for placeholder visibility, Cancel/Escape with focus return,
  category reachability via mouse/keyboard/coarse pointer, horizontal overflow,
  reduced motion, and no layout regression.

### Deployment

- Release commit `ff222a7` ("fix(discovery): resolve Plan 14 presentation
  follow-ups"), fast-forwarded onto `main` from the prior production commit
  `f605788`. No merge commit.
- Server `~/Trippy` pulled to exact `ff222a7`; the release contained no
  migration and did not touch `~/Trippy/data/trippy.db*`. A fresh pre-deploy DB
  backup (with `-wal`/`-shm` sidecars) was taken before pulling, and the daily
  backup/health crons were confirmed active.
- `docker compose up -d --build` rebuilt and recreated `trippy-trippy-1` without
  a production hotfix. Startup log: `Trippy backend running on :3001
  [production]`. Server-local health on port 6768:
  `{"status":"ok","db":"connected"}`. Container up on
  `0.0.0.0:6768->3001/tcp`.
- Owner-authenticated **production** browser pass reported **PASS** across the
  full follow-up matrix (placeholder copy, Change Cancel/Escape with focus
  return, category reachability, overflow, reduced motion, no layout
  regression). No production-only hotfix was made.

**Final status:** Plan 14 is fully closed in production, including the Wave 6
presentation follow-up. Every required local, deployment, and owner-authenticated
production gate passed.

---

## 4. Mandatory verification commands

Run from `frontend/`:

```powershell
npm test -- DiscoveryPanel.test.jsx SuggestionCard.test.jsx
npm test
npm run build
```

Run from `backend/` during the final Wave 5 release gate:

```powershell
npm test
```

Run from the repository root:

```powershell
git diff --check
git diff --name-only <implementation-base>..HEAD
```

The feature implementation diff against the committed Plan 14 baseline must
contain frontend files only; subsequent Plan 14 status/deployment notes are the
only allowed documentation exception. A green build alone is not sufficient; the
375px and desktop interaction passes are required because the primary risk is
responsive behavior and action reachability, not compilation.

---

## 5. Regression matrix (must remain true)

| Existing behavior | Required proof after redesign |
|---|---|
| Active-day resolved city/country seeds Discovery | Existing defaulting test or focused panel test |
| Typing a destination does not blank committed results | New edit-mode test |
| Manual Go clears country context | Existing cross-city test + new edit-mode assertion |
| More exposes otherwise unmapped categories | Existing More test |
| Total count includes every reachable category exactly once | Existing honest-count test |
| Category chunks and Show more append without clearing cards | Hook contract unchanged + UI loading test |
| Category switch scrolls results to top | New scroller test + viewport check |
| Search filters catalogue at 2 chars | New search test |
| Google fallback starts at 3 chars and completes one session | New mocked search/details test; service unchanged |
| Verified coordinate Add payload stays trusted | Existing trusted-add test |
| Unverified Add uses resolver payload | Existing unverified-add test |
| Cross-city Add does not borrow active-day country | Existing cross-city test |
| Add pending is local to one suggestion | Existing pending tests |
| In trip is destination-scoped and shows matched days | Existing city-scope tests + new multi-day detail test |
| Report requires explicit reason | Existing report tests + detail-path test |
| Report removes card and any open detail | Existing removal test + new cleanup test |
| Co-pilot context is exact in category/search/More/Surprise | Existing forwarding test + detail-path assertion |
| Surprise excludes added places and retains Another/Dismiss | Existing handler logic unchanged + UI smoke check |
| Errors, empty states, skeletons, and working labels remain honest | Component tests + manual state matrix |
| Panel close and spring transition remain spatially consistent | Manual mobile/desktop check |

---

## 6. Stop conditions

Stop and return to the owner instead of expanding scope if implementation appears
to require any of the following:

- a backend response or schema change to render the supplied design;
- a new API endpoint or provider request;
- changing catalogue generation, category mapping, ranking, or remaining counts;
- modifying `useDiscovery` business behavior rather than presentation state;
- losing one of the existing actions/data fields to make 236px cards fit;
- importing the external design-system package into production or globally
  replacing current tokens;
- changing PlanTab navigation or the Discovery open/close contract;
- fixing an unrelated defect discovered during the work.

The correct response to any stop condition is a separate finding or follow-up
plan. It is not authorization to turn this frontend redesign into a broader
feature change.
