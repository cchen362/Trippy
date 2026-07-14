# Implementation Plan 14 — Discovery Panel “Register” Redesign (Option 1b)

**Status: READY FOR IMPLEMENTATION (2026-07-15). Planning only; no application code changed.**

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

## Wave 1 — Lock the regression contract in frontend tests

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

---

## Wave 2 — Compact panel shell, destination header, and controls

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

1. Open production and sign in as a real user. Confirm the trip list loads and one
   representative trip’s Plan, Map, and Today views still render before focusing
   on Discovery.
2. On a designated test trip at 375px, verify:
   - Discovery opens and closes with the existing spatial transition;
   - compact committed destination, count, Change, and Surprise controls render;
   - Change/edit/Go preserves current results while typing;
   - category selection resets the results scroller;
   - expanding search filters catalogue results and exposes the map fallback;
   - collapsed cards clamp correctly and inline Details reveals the full content;
   - Add to day opens DayPicker and its pending/Added state works on an owner-safe
     test suggestion; remove the test stop afterward through the existing Plan UI;
   - report reveals the two reasons but is cancelled before suppressing a real
     place;
   - Ask co-pilot opens with the selected discovery context without sending a
     message;
   - Show more is in-flow and no fixed footer obscures the last result.
3. Repeat the presentation-specific checks at desktop width: three bounded columns,
   236px rows, full search control, labelled Surprise, selected-card state, and the
   internally scrolling right-side detail sheet with focus restoration.
4. Check browser console and container logs for new errors during the exercised
   flow. Record observations; do not patch production in place.

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

**Acceptance:** verified `main` is pushed and deployed; `trippy-trippy-1` is healthy
on port 6768; authenticated baseline and Option 1b checks pass at mobile and
desktop widths; no production-only hotfix was made; the plan contains an auditable
release and verification record.

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
