# Plan 23 Track B — Frontend Bundle Splitting Review

**Status:** REVIEW COMPLETE 2026-07-22 — awaiting independent orchestrator/QA validation before Track B is expanded into an implementation plan.

**Scope:** Review and documentation only. This document evaluates the open frontend bundle-splitting work in Plan 23 Track B against the current build, route graph, dependency ownership, and PWA configuration. It does not reopen completed Track A, approve a final chunking design, authorize implementation, or change Plan 23's status.

**Primary context:**

- [Implementation Plan 23 — Trips Home Route-Node Geography Correctness (+ bundle-split follow-up)](../plans/Implementation%20Plan%2023%20Trips%20Home%20Node%20Geography%20and%20Bundle%20Split.md)
- [Trippy design and architecture specification](../specs/2026-04-23-trippy-design.md)
- `frontend/src/App.jsx`
- `frontend/src/main.jsx`
- `frontend/src/pages/TripPage.jsx`
- `frontend/src/pages/MapTab.jsx`
- `frontend/src/hooks/useCopilot.js`
- `frontend/vite.config.js`

## Executive assessment

Track B is a valid but low-priority mobile startup and code-hygiene improvement. The current production build still ships all frontend JavaScript as one `753.94 kB` minified chunk (`225.14 kB` gzip), and the static route graph makes every surface pay for implementation it does not initially use. The clearest example is Leaflet: its JavaScript is map-specific, but it is included for Trips Home, public shares, login/setup, and every non-map trip tab.

The plan's broad direction is sound, but its two candidate mechanisms do not have equivalent outcomes. Route- or feature-level dynamic imports can remove unused code from the initial route's download and parse/execute path. `manualChunks` alone only reorganizes statically required code into more files; those files remain immediate dependencies and do not inherently improve first-route startup. Eliminating Vite's 500 kB warning is therefore not a sufficient objective.

The PWA also changes how benefits should be described. Workbox currently precaches every generated JavaScript file. Splitting the bundle can improve the foreground startup path while the service worker downloads remaining chunks in the background, but it will not by itself reduce the complete PWA installation download. The current precache is approximately `5.63 MiB`, and almost `4.95 MB` of that is two login images rather than JavaScript. Image optimization is outside Track B, but the implementation plan should not claim that JavaScript splitting materially reduces total precache weight.

The working recommendation is to establish meaningful dynamic boundaries first, measure the result per entry route, and add explicit vendor chunking only if the measured output shows a concrete remaining problem. The Map/Leaflet route and closed-by-default co-pilot panel are high-signal candidate boundaries. This is a review recommendation, not a prescribed solution: the orchestrator/QA pass should independently validate the dependency graph, test whether other boundaries provide better value, and reject any split whose runtime or PWA risks outweigh its startup benefit.

## 1. Measured baseline

A clean production build was run on 2026-07-22 with output directed to a temporary directory outside the repository:

```text
vite v5.4.21
2250 modules transformed

assets/index-CDdzKwM3.css   56.71 kB | gzip:  15.07 kB
assets/index-C-FW6pVU.js   753.94 kB | gzip: 225.14 kB

PWA precache: 9 entries (5628.51 KiB)
```

The build reproduces Plan 23's warning that a generated chunk exceeds `500 kB`. A source-map inventory was also generated in the temporary output to identify broad dependency weight. Source lengths are not minified bundle contribution measurements, but they show where the largest bodies of code originate:

| Source group | Approximate unminified source represented | Current ownership signal |
| --- | ---: | --- |
| Leaflet | 439.7 kB | Map only |
| Framer Motion | 408.9 kB across 229 modules | Shared across loading, home, share, Plan, Discovery, co-pilot, and timeline surfaces |
| Application components | 376.2 kB | Spread across routes and optional panels/modals |
| React Router internals | 308.7 kB combined | Core routing dependency |
| React DOM | 130.5 kB | Core rendering dependency |
| Application pages | 94.3 kB | All eagerly imported today |
| `qrcode.react` | 43.8 kB | Share modal only |

The worktree remained clean after the diagnostic builds; no repository artifact was generated or changed.

## 2. Findings

### F1 — The route graph is entirely eager

`frontend/src/App.jsx` statically imports:

- Login and setup.
- Public share.
- Trips Home.
- The authenticated trip shell.
- Today, Plan, Logistics, Map, and Expenses tabs.
- The trip index redirect.

The conditional `/share/:token` render does not create a bundle boundary: static imports mean the public route still ships the authenticated application implementation. Similarly, opening `/trips` includes every trip tab even when the user does not open a trip.

This is the primary cause of the single application chunk and the strongest evidence that dynamic route boundaries could improve initial-route cost.

### F2 — Leaflet is an unusually clean heavy boundary

Leaflet and React Leaflet are imported only by `TripMap` and `StopMarker`, reached through `MapTab`. The JavaScript dependency therefore has a single product owner and need not be part of non-map startup.

However, `frontend/src/main.jsx` imports `leaflet/dist/leaflet.css` globally. A complete Map boundary may therefore need to consider both JavaScript and CSS placement. That should be verified through the generated asset graph and browser rendering rather than assumed: moving the stylesheet is useful only if Vite loads it before the lazy map renders without a flash or broken marker layout.

### F3 — `manualChunks` and dynamic imports solve different problems

An explicit React/Router/Leaflet vendor layout can produce tidier output and more stable browser caching between app-only releases. It does not automatically reduce foreground work when the entry chunk still statically depends on every vendor chunk.

The implementation plan should therefore avoid treating any of these as synonymous success:

- Vite no longer prints the 500 kB warning.
- The same startup payload is divided into several files.
- Initial route transfer, parse, and execution are actually reduced.

Rollup will derive shared chunks once meaningful dynamic boundaries exist. Explicit `manualChunks` should be justified by the measured post-split graph, not added reflexively at the start.

### F4 — Co-pilot UI loading and co-pilot data loading are separate decisions

`TripPage` statically imports `CopilotPanel`, although the panel is closed by default. Deferring its UI implementation until the user opens it is a plausible bundle boundary.

`TripPage` also calls `useCopilot(tripId)` on mount, and that hook immediately requests stored co-pilot history. Deferring the component does not defer that request. Conversely, changing the hook lifecycle would alter existing responsiveness, state availability, error timing, and possibly perceived open latency.

Track B should not silently combine code delivery optimization with a co-pilot behavior change. If the implementation plan proposes deferring history/state initialization, it must identify that as a separate product and runtime decision with its own evidence.

### F5 — Other closed-by-default UI is present, but expanding scope has diminishing returns

The current entry paths also include optional surfaces such as:

- `NewTripModal` from Trips Home.
- `TripShareModal`, including `qrcode.react`, from the trip shell.
- `EditTripModal` from the trip shell.
- Admin settings.

These may be reasonable follow-on boundaries, especially when their triggers are already visible while the body remains closed. They should not automatically be included in the first split wave. Too many small chunks increase requests, fallback states, dependency factoring complexity, and upgrade/offline paths. The orchestrator should identify the smallest set that captures most of the real startup benefit.

### F6 — PWA precaching preserves offline potential but not zero-cost splitting

`frontend/vite.config.js` precaches `**/*.{js,css,html,ico,svg,woff2}`. Generated lazy JavaScript and CSS should therefore enter the Workbox manifest automatically and be available after service-worker installation.

That behavior has two implications:

1. Dynamic imports can reduce the foreground initial-route payload while the PWA still downloads all chunks during installation.
2. Correctness now depends on every generated lazy asset appearing in the precache and on navigation continuing to work during offline use and service-worker upgrades.

The current precache report is dominated by two files included through `assets/*.png`:

| Asset | Raw size |
| --- | ---: |
| `assets/illustration-login.png` | 2,543,549 bytes |
| `assets/mobile-vignette.png` | 2,407,446 bytes |

Both remain under the configured `3 MiB` per-file Workbox limit and are therefore precached. Their optimization is an adjacent opportunity, not part of Track B unless the owner deliberately broadens scope.

### F7 — The main regression risk is runtime delivery, not application semantics

The existing app has focused component and hook tests but no automated service-worker/offline route suite. Dynamic imports introduce additional runtime requests and fallback states. The most important failure cases are therefore not established by a normal unit-test pass:

- Directly loading each route online.
- Navigating to a not-yet-opened lazy route.
- Starting the installed PWA offline after a complete precache.
- Deep-link refresh behavior offline.
- An already-open client navigating to an unloaded route while or after a new service worker activates.
- A rejected or unavailable chunk producing an honest recoverable failure rather than a blank screen.

`registerType: 'autoUpdate'` makes the upgrade scenario particularly worth testing. The implementation must rely on observed Workbox behavior rather than assuming that hashed assets and an activating worker cannot race.

### F8 — Loading treatment needs to preserve the trip shell

A single application-level `Suspense` fallback may replace the entire screen during a child-tab chunk load. That would make routine tab navigation appear to leave the trip and could move global controls unexpectedly.

The implementation plan should define the fallback altitude rather than only naming `React.lazy`. Top-level route loading may reasonably use the full loading screen; nested trip routes should generally preserve the loaded trip shell, header, and navigation while only the outlet content waits. The final mechanism remains for the planning pass to determine.

## 3. Working recommendation to validate

Track B should proceed when maintenance capacity permits, but it should remain independent, optional, and lower priority than correctness or product work.

The smallest promising direction is:

1. Establish dynamic boundaries around top-level surfaces and authenticated child routes so each initial route loads only its required application code.
2. Confirm that Map/Leaflet is absent from non-map initial routes, including its CSS if moving the stylesheet proves safe.
3. Evaluate deferring the closed co-pilot panel while preserving the existing co-pilot state/history lifecycle unless a separate decision changes it.
4. Measure the resulting graph before deciding whether explicit vendor chunks or additional modal-level boundaries are justified.
5. Keep login-image optimization and service-worker policy changes outside Track B unless the owner explicitly expands the objective from JavaScript startup to total PWA installation weight.

This direction is preferred because it targets unused startup execution rather than the cosmetic shape of the output. It is not binding. An independent reviewer may conclude that fewer boundaries, different boundaries, or no immediate work provides the better risk/value balance.

## 4. Evidence and planning gates

A later implementation plan should define proof in terms of user-visible delivery and PWA correctness.

| Area | Required evidence before Track B can close |
| --- | --- |
| Baseline | Record current raw/gzip JavaScript, initial-route requests, and the complete Workbox precache size. |
| Per-route delivery | Show which JavaScript/CSS chunks load initially for `/share/:token`, `/trips`, and each authenticated trip route. |
| Heavy boundary | Demonstrate that Leaflet/React Leaflet are not fetched or executed before Map is opened. |
| Co-pilot | If its panel is split, show first-open loading behavior and confirm existing history/state semantics have not changed accidentally. |
| Fallbacks | Preserve the trip shell during nested route loading; provide an honest failure state for chunk-load failure. |
| PWA manifest | Verify every required lazy JavaScript and CSS asset is present in the generated Workbox precache manifest. |
| Offline | Exercise installed-PWA startup, route navigation, and deep-link behavior after a completed precache. |
| Upgrade | Test a running prior build navigating to a previously unopened route across a new service-worker deployment. |
| Mobile | Verify affected transitions at 375px, including slow-load behavior and touch navigation. |
| Regression | Run the full frontend tests and production build, plus focused route/co-pilot/map tests if the chosen boundaries affect them. |
| Outcome | Compare foreground initial-route transfer and parse/execute cost, not only largest-chunk size or warning output. |

The plan should set a bounded improvement objective only after the independent reviewer measures the candidate output. An arbitrary requirement that every chunk remain below `500 kB` is not, by itself, a product or performance requirement.

## 5. Questions for independent review

1. Does the current initial-route performance create a meaningful mobile delay, or is this primarily maintainability hygiene at `225.14 kB` gzip?
2. Which route or feature boundaries deliver most of the foreground benefit with the fewest loading and upgrade states?
3. Does moving Leaflet CSS into a dynamic boundary behave correctly in Vite production builds and installed-PWA offline use?
4. Should the co-pilot panel be split independently from its state hook, or is the resulting first-open trade-off worse than the saved startup cost?
5. Does Rollup's automatic shared-chunk output after route splitting make `manualChunks` unnecessary?
6. What service-worker update sequence must be protected so an open client never loses access to a not-yet-loaded hashed chunk?
7. Are the login images important enough to justify a separate follow-up, or is their precache weight acceptable for this private PWA?
8. Is Track B worth implementing now, or should Plan 23 remain open with the work explicitly deferred?

## 6. Review contract for the next orchestrator/QA pass

The next reviewer should treat this document as evidence and a challengeable recommendation, not as an approved architecture. It should:

- Re-run or independently inspect the build and current import graph.
- Validate or reject each finding with current-code evidence.
- Distinguish foreground startup, background precache installation, repeat navigation, and runtime execution costs.
- Identify correctness, offline, upgrade, accessibility, and mobile risks that this review missed.
- Recommend whether Track B should proceed and, if so, the smallest defensible boundary set.
- Only after completing that independent assessment, write a bounded implementation plan for Track B in Plan 23.

No application code, configuration, dependency, deployment, or production change is authorized by this review phase.
