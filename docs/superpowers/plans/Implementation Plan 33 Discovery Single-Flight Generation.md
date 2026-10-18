# Implementation Plan 33 — Discovery Single-Flight Generation

**Status:** 2026-10-19 — **APPROVED by the owner (R1–R3 below).** M1 (backend): **COMPLETE 2026-10-19, not deployed** (record under "M1 record" below). M2 (frontend): **COMPLETE 2026-10-19, not deployed** (record under "M2 record" below; started once Plan 32 M2 and the co-pilot "Drafting…" badge had merged, per R3). Nothing deployed: M1 ships with Plan 30 Deploy B, and M2 ships with whichever deploy follows its merge. Written at `a46b38a` from the defect recorded in Plan 30's Deploy A owner QA (Bangkok, 2026-10-18), merged as findings in PR #15. No migration.

## Owner rulings — 2026-10-19 (do not reopen)

Relayed by the Plan 30 orchestrator; the owner's words were "Plan 33 - Ok to the recommendation."

- **R1 (Q1) — A second request joins the generation already running.** It gets everything already saved at once, then each remaining category as it finishes. It never waits on a "still building" note. Code marker `D-33-2`; the single-generation rule underneath it is `D-33-1`.
- **R2 (Q2) — "Show more" pressed while a generation is running joins that generation.** It does not start a second one in parallel. Code marker `D-33-3`.
- **R3 (Q3) — M2 is included, sequenced after Plan 32 M2 and the co-pilot "Drafting…" badge.** Those touch `api.js` `requestStream` and the co-pilot files, and M2 edits the same `requestStream`.

## Bottom line, in plain language

When you open Discovery on a city Trippy has never catalogued, the server spends about 90 seconds asking the model for places and streams them to you as each category finishes. If a **second** request for the same city arrives during those 90 seconds, the server does not notice that the first one is already running. It starts a second, full generation. Both run side by side and save into the same catalogue. The screen that made the second request shows **only the places the first generation had not already saved**, so the city looks half-empty until you reload.

**Example — what happened on 2026-10-18.** You created "BKK - 30 W3 Deploy A". Discovery for Bangkok started generating at 16:06:41. Five seconds later a second Bangkok request arrived and started its own generation. The two together saved 156 places. Your screen showed 67 (food: 5), because the screen was attached to the second stream, and the second generation's famous picks (Grand Palace, Wat Pho, Jay Fai, Thip Samai …) had already been saved by the first, so they were skipped and never sent to you. A reload showed the full catalogue.

**What it costs you:**
- **First impression.** A big city looks thin, which is exactly what you wanted Haiku 5.5's larger catalogues to fix.
- **The daily cap.** Each city gets 3 generations a day (`MAX_GENERATIONS_PER_DESTINATION_PER_DAY`). The duplicate used one, so after one "show more" Bangkok was capped for the rest of the day.
- **Money.** One wasted model call per collision (about 21k output tokens on Haiku 5.5, a few cents). The real cost is the cap and the screen, not the bill.

**Severity: medium.** It is not data loss: the catalogue is correct and complete; only the first view is wrong. But it happens on the very first open of a new city, the moment that sets your impression, and nothing in the app hints that a reload would help.

**Recommendation: fix it on the server (M1), with a small client tidy-up (M2).** When a generation for a city is already running, a second request should **join it** rather than start another. The joiner gets everything already saved straight away, then each remaining category as it finishes. This is the only fix that also covers a page reload or the PWA being relaunched, because the server is the only place that still knows a generation is in progress after the browser forgets.

## What triggers the second request (reproduced 2026-10-19)

Reproduced locally on a copy of the dev database, with a freshly created trip "BKK race repro" (Bangkok, picked from the destination picker, so the trip carries TH). The Discovery request was held open for 150 s in the browser to stand in for a real generation, and every request was recorded with its call stack.

| Step | Discovery requests sent | Call site | Body |
|---|---|---|---|
| Create the trip → land on Plan | 1 (at +1.4 s) | `TripPage.jsx` pre-warm effect → `useDiscovery.discover` | `{ destination: "Bangkok", countryCode: "TH" }` |
| Open Discovery 3–5 s later | **0 new** — deduplicated | `DiscoveryPanel.jsx` mount effect → `discover` | same key `bangkok|TH`, still loading, skipped |
| "← Trips", then tap the trip again | **1 new** (at +14.5 s) | `TripPage.jsx` pre-warm effect again | identical body |

So the **first suspicion in the brief is not it**: on a fresh trip the pre-warm and the panel compute the same key (`bangkok|TH`), and `useDiscovery` correctly skips the panel's call. **What does send a second request is anything that rebuilds `TripPage`** while a generation is still running:

- leaving the trip and coming back (reproduced above);
- reloading the page, or the phone reloading the PWA after it was backgrounded;
- saving trip settings, whose `discovery.reset()` deliberately wipes and aborts the cache (`TripPage.jsx` `handleEditSave`);
- a second tab or device open on the same trip.

The production log fits this exactly: both requests carried TH (`[discover] destination=Bangkok, Thailand (TH)` twice, and no `country_required` line, which a null-country request would have logged before any row existed). **What is not recoverable** is which of those four the owner did at 16:06:46. Trippy keeps no HTTP request log, so the container log shows only what the discovery code itself prints. It does not change the fix: all four are closed by the same server change.

## Verified facts — established 2026-10-19 at `a46b38a`, do not re-derive

- **F-33-1 — The client deduplicates only within one `TripPage` instance.** `useDiscovery` keeps its cache and in-flight state in `useRef` inside the hook, and `TripPage` owns the hook ("state lives here so it survives tab navigation", from `571594d`). Tab switches keep it; a remount, reload or `reset()` loses it. The skip rule is `current?.loading` or "already has results" for the key `canonicalGeoKey(city)|CC`. The hook has **no unmount cleanup**, so an abandoned instance's stream keeps reading until the server finishes.
- **F-33-2 — The route has no single-flight.** `POST /api/trips/:tripId/discover` (`backend/src/routes/discovery.js`) decides between "serve fresh", "true miss", "stale refresh" and "append" purely from the DB. `last_generated_at` and `generation_count` are bumped only **after** `discoverDestination` resolves (`runCatalogueGeneration`, `services/discoveryGeneration.js`). So for the whole generation (92 s for Bangkok: 16:06:41 → 16:08:13):
  - before the first category is saved, a second request sees 0 active places → a **second true miss**;
  - after it, it sees active places but no `last_generated_at` → `cacheIsFresh` is false → a **stale refresh**, which also generates.
  Either way the daily cap check passes (it counts only finished generations), and a second `discoverDestination` call starts.
- **F-33-3 — Why the second screen is thin.** On a true miss the route streams only the rows **this** request's `insertPlaces` returned (`onCategory` → `stillActive`). `insertPlaces` silently skips any name already in the catalogue (`[discoveryCatalogue] skipped duplicate …`, 25 such lines for Bangkok). So whichever generation saves a famous name second never streams it. Proven with a throwaway route-level test (two concurrent `callDiscover` calls against a fake generator, 5 ms apart, deleted after the run): `discoverDestination` called **2×**; both generations stamped **batch 0** (each reads `generation_count = 0` before either bumps it); `discovery_generation_daily.count = 2`; the later stream showed 9 of its 13 items while the DB held the 23-item union. That is the production signature: 156 batch-0 rows, a "show more" stamped batch 2, and the screen at 67.
- **F-33-4 — The co-pilot already has a single-flight, but a private one.** `services/copilotGrounding.js` keeps `inFlightGenerationKeys` (a module `Set`, key `${cityKey}|${countryCode}`, Plan 12 G3) so its own background kicks never double up. The route does not consult it, and it does not consult the route. So a co-pilot search and a Discovery open for the same new city can also double-generate today.
- **F-33-5 — One process, so an in-memory registry is correct.** The backend runs as a single Node process by design (ENGINEERING.md, Hosted MCP: provider budgets are in-memory per process, which is why `/mcp` is in-process, never a sidecar). A module-level registry in the generation service is therefore authoritative, the same assumption the co-pilot's `Set` and the resolver budgets already make.
- **F-33-6 — The server keeps generating after the client leaves, on purpose.** The route registers no `req.on('close')`; a generation always finishes and persists, because the catalogue is shared and the next visitor benefits. Joining (M1) relies on this, so it must stay.
- **F-33-7 — Decision markers checked.** The grep from ENGINEERING.md over the route, generation service, catalogue, co-pilot grounding, `useDiscovery`, `TripPage` and `DiscoveryPanel` finds Plan 12 G3/G4, Plan 7 decision 4 (archival) and Plan 21 D3/D4 (banners), none of which this touches. Plan 26 W4.8's no-country decision table (prose citation, not caught by the grep) is **unchanged**: the join is keyed on the destination row the table has already resolved, so a null-country request that case 2 adopts onto `bangkok|TH` simply joins the TH generation. The daily cap ("Trust criteria, decision 4") is unchanged; it now stops being spent twice. `docs/DECISIONS.md` has nothing on discovery concurrency.

## Proposed fix

### M1 — Backend: join an in-flight generation (one generation per destination)

1. **One shared registry in `services/discoveryGeneration.js`**, the module that is already the single home of the generation pipeline. Key: `destinationRow.id`. Value: the generation's promise plus a list of per-category listeners. `runCatalogueGeneration` registers itself on start and removes itself in `finally`; every completed category notifies the listeners after it is inserted and capped.
2. **The route joins instead of generating.** Right after the fresh-cache return and **before** the daily-cap check, if the registry holds a generation for this destination:
   - stream every category already saved (the same `groupPlaceRowsByCategory(listActivePlaces(…))` the stale-refresh path uses);
   - on each later category, stream that category's full active set re-read from the DB (the stale-refresh merge code, reused);
   - await the leader, then `done` (`cached: false`). If the leader fails, take the same fallback the route already has: stored rows if any, else the error.
   - A joiner never touches the daily counter, never calls the model, and never enqueues verification (the leader already did).
3. **The co-pilot kick uses the same registry**, and its private `inFlightGenerationKeys` set is removed (F-33-4), so there is one rule for "is this city already generating", not two.
4. **Tests** (route level, in `backend/tests/discovery.test.js` with the existing `callDiscover` helper):
   - two concurrent requests → one `discoverDestination` call, daily count 1, batch 0 once, and **both** streams end with the full catalogue;
   - a joiner arriving after categories have landed gets them immediately;
   - a null-country request adopted by case 2 joins the coded generation;
   - a co-pilot kick and a route request share one generation;
   - a leader failure reaches the joiner as the existing fallback or error;
   - "show more" during a generation (see Q2).

### M1 record — 2026-10-19

- **As built.**
  - `discoveryGeneration.js`:
    - `runCatalogueGeneration` registers itself synchronously in a module `Map` keyed by destination id, removes the entry in `finally`, and throws if a generation is already running for that destination (a caller bug).
    - `getRunningGeneration(id)` returns `{ settled, subscribe }`, where `settled` never rejects. A listener that throws is logged and dropped; it never aborts the leader.
  - `routes/discovery.js`: the join path sits right after the fresh-cache return and before the daily-cap check. It subscribes first, then streams every saved category, then streams each later category's full set through the new `activeCategoryChunk` helper (shared with stale refresh). "Show more" joiners get `append: true`. A leader failure gives the joiner the route's existing fallback.
  - `copilotGrounding.js`: its private set is gone. The kick checks the shared registry after `getOrCreateDestination`.
  - Markers `D-33-1`, `D-33-2` and `D-33-3` are stamped in code, with rows in `docs/DECISIONS.md`.
- **Tests.**
  - New: 10 in `discoveryGeneration.test.js`, 11 in `discovery.test.js` (including co-pilot/route sharing in both orders) and 2 in `copilotGrounding.test.js`. That file's mock now wraps the real `runCatalogueGeneration`.
  - Full backend suite: **1140 passed, 12 skipped, 0 failed.**
  - Re-run after merging `origin/main` at `84adf10` (Plan 32 M2, plus `63bafdb`, which stops the stop-photo tests needing a real Unsplash key): **1140 passed, 12 skipped**, with no provider keys in the environment at all.
- **Route verification, real model, dev-DB copy** (Google off, owner DB untouched). A new trip "Chiang Mai single-flight QA" sent two first-time `POST /discover` requests for Chiang Mai/TH, 4 s apart:
  - The log shows one `[discover] destination=` line, one `joined running generation` line, and no `skipped duplicate` lines.
  - `generation_count` 1, daily count 1, every row batch 0.
  - **Both** streams ended with all 95 active places in all 8 categories, the joiner included. Both received their first category at +16 s and `done` at +80 s.
- **Not exercised in a browser.** No frontend file changed and the panel consumes the same stream, but the remount flow was not clicked through. Owner production click-script, after Deploy B:
  1. Create a trip for a city never opened before.
  2. Open Discover.
  3. Within a minute, tap "← Trips" and reopen the trip.
  4. Open Discover again.
  5. Check that the panel fills to the full catalogue with no reload.
  6. Check that the container log shows one `[discover] destination=` line and one `joined running generation` line for that city.

### M2 — Frontend: stop orphaned streams on unmount

`useDiscovery` aborts its in-flight requests when its owner unmounts, the same `abortRefs` loop `reset()` already uses. This is tidiness, not the fix: after M1, a remounted page joins the running generation whether or not the old stream was closed. It stops a dead page's stream from holding a connection for the rest of the 90 s. Aborting does **not** stop the server's generation (F-33-6).

Known side effect: `api.js` `requestStream` calls `reader.cancel()` in its `finally` without handling the promise, so every abort leaves an unhandled rejection (an AbortError in the console). This was seen on the co-pilot's Stop during Plan 30 D-30-8 QA and left alone there as out of scope. M2 would make it show up on Discovery too, so M2 should fix that one line at the same time rather than add more console noise.

### M2 record — 2026-10-19

- **As built.**
  - `useDiscovery.js`: an unmount-only effect aborts every in-flight controller and also wipes the cache. An aborted entry would otherwise stay `loading: true` (the AbortError branch writes no state), and StrictMode's dev mount → cleanup → mount would then skip the pre-warm for good.
  - `api.js` `requestStream`: the `try/finally { reader.cancel() }` is removed, with the reason as a comment. The loop ends only on `done`, when the stream is already closed, or on a rejected `read()`, when the stream is errored and `cancel()` can only reject unhandled. `parseChunk` already catches every `onChunk`/JSON failure, so no other path can leave the stream readable. The `read()` rejection still reaches callers unchanged, with `err.name === 'AbortError'`.
- **Tests.**
  - 4 new in `useDiscovery.test.js`: unmount aborts; unmount → remount fires again; a real `StrictMode` pre-warm ends live; idle unmount is a no-op.
  - 2 new in `api.test.js`: a normal stream still delivers every chunk, including a trailing one; an abort rejects with AbortError and fires no `unhandledRejection`.
  - 4 of the 6 fail against the old code.
  - Frontend suite **357 passed**; `npm run build` OK.
- **Browser QA**, on a dev-DB copy (owner DB untouched) with Playwright, at **375 px and at 1280 px**:
  - **Discovery unmount.** With a Discovery request held in flight, I opened Discover, then went "← Trips". The request was aborted (`net::ERR_ABORTED`), with 0 unhandled rejections, 0 console errors and 0 page errors. Re-entering the trip and opening Discover loaded Kyoto's 100 places from the real backend.
  - **Co-pilot Stop**, with a real model call. The partial text stayed, "This reply was stopped. · Remove" appeared, and the Stop button cleared. There were 0 unhandled rejections and 0 console errors; the old code logged an AbortError here on every Stop. The server saved each stopped turn as a `notice = 'stopped'` row.

**What this plan does not do.** It does not lift Discovery state out of `TripPage` into an app-wide store. A store would survive an in-app remount but not a reload or a PWA relaunch, so it would only fix part of the problem, and once M1 is in place it fixes nothing M1 doesn't. No catalogue repair is needed: Bangkok's 206 active rows are correct. The second generation's rows were stamped batch 0 instead of 1, so they skip the `−0.75 · batch` rank penalty (`services/discoveryRank.js`) a sequential run would have given them. That is a small reordering among real places, not worth a data fix.

## Owner questions

**Q1 — Should a second visitor join the running generation, or wait for it?**
- *Plain language:* a joiner either sees what is already found straight away, with the rest streaming in (join), or gets a "still building this city, try again in a minute" note (wait).
- *Example:* you reload 30 s into Bangkok's generation. With join, 4 of 8 categories appear instantly and the rest arrive over the next minute. With wait, you get a note and an empty panel.
- *Implication:* join costs a little more code (listeners, about 60 lines plus tests). Wait is simpler but makes a reload look broken.
- **Recommendation: join.** It is the only option where the screen ends up showing the full catalogue without you doing anything.

**Q2 — "Show more" pressed while that city is still generating?**
- *Plain language:* it can join the running generation (no extra model call), or start its own generation in parallel, as today.
- *Example:* a collaborator presses "Show more" on Bangkok while your first-ever open is still generating. Today that is a second generation, run without knowing which names the first will return, so it repeats them and spends a daily slot.
- *Implication:* joining means that press adds nothing beyond the running generation. A fresh "show more" works again once it finishes.
- **Recommendation: join.** A parallel "show more" cannot exclude names the running generation has not saved yet, so most of what it pays for is skipped as duplicates.

**Q3 — Include M2 (close orphaned streams on unmount)?**
- *Plain language:* when you leave a trip page, its Discovery download stops instead of running to the end in the background.
- *Example:* you open Bangkok, go back to Trips, and open another trip; the Bangkok stream stops. The server still finishes Bangkok's catalogue.
- *Implication:* about 10 lines plus the `reader.cancel()` fix. No visible change, no cost saving on the model side.
- **Recommendation: yes, but after M1**, and drop it if M1 runs long; it is hygiene.

## Not verified, and how to close it

- **Which owner action caused the 16:06:46 request** (leave and return, reload, settings save, or a second device). The logs cannot tell; the owner may remember. The fix covers all four.
- **Which generation's stream the screen showed.** The 67 matches "the second to save each famous name". A read-only query against production would settle it: each generation stamps its own `generated_at`, so grouping Bangkok's (`destination_id = 23`) batch-0 rows by `generated_at` and category gives each generation's own count and its food count. The automated permission check refused a production DB read from this session, so it was not run. The owner can run it, or approve it for a later session.

## Reproduction notes (for M1/M2 QA)

- Hold a request open in the browser rather than spending a generation: Playwright `page.route('**/api/trips/*/discover', …)` that waits ~150 s before fulfilling, plus an init script wrapping `window.fetch` to record each call's stack (that is how the `TripPage.jsx` call site was named). Keep the hit list on the `page` object; plain globals do not survive between `browser_run_code_unsafe` calls.
- Run the backend on a **copy** of the dev DB (`DB_PATH` in the worktree's `backend/.env`) so the new trip does not land in the owner's data.
- For the server side, a route-level test with a fake `discoverDestination` reproduces the whole thing in under a second, with no model or resolver spend.
- After M1, the browser acceptance is: create a new-city trip, open Discovery, go "← Trips" and back within a minute, and the panel ends with the full catalogue, with exactly one `[discover] destination=…` log line for that city.
