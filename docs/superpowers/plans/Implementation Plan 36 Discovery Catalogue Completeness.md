# Implementation Plan 36 — Discovery Catalogue Completeness

**Status:** 2026-10-20 — **APPROVED** (owner rulings of 2026-10-20, relayed by the Plan 35 orchestrator). **W1 COMPLETE and DEPLOYED 2026-10-20 at `a44f437`** (§6). It was merged by the orchestrator, the backend suite passed on main (1,263), and it was browser-verified on a dev-DB copy. It is backend only (no frontend bundle change, no migration). Pre-deploy backup `trippy-2026-10-20-022253.db`; health OK; the new freshness rule was confirmed in the container. **Owner production pass PASSED (2026-10-20):** Hanoi's open started a stale-refresh merge (`existingStops=37`), and a second open joined it. It ended `end_turn categories=8 items=89 complete=true deduped=0 unnamed=0`. Hanoi now has all 8 categories (essentials 18, culture 20, food 22, nature 20, nightlife 11, hidden_gems 10, architecture 12, wellness 11), with a daily count of 2 of 3. W2 (prompt wave) is in progress on `claude/hungry-hugle-78d2ea`. No migration in either wave.

**Origin.** Plan 35's production pass (2026-10-20, deploy `d5e9e3a`). Hanoi's pre-warm generation ended `end_turn` with 4 of 8 categories (37 items), passed the 4-category minimum, and was stored as a fresh 7-day catalogue. A separate investigation session established the facts below. It changed no code, did no production write, and spent $0.207 on 24 live Haiku 5.5 generations.

**Scope in one sentence:** a Discovery catalogue counts as fresh only when it is complete, so a short generation repairs itself on the next open instead of standing for a week (W1); and the prompt says what each category is, so small towns stop producing thin categories (W2).

**Not in scope.**
- No change to the 7-day TTL, the daily cap (`MAX_GENERATIONS_PER_DESTINATION_PER_DAY = 3`), D-33-1 single-flight, or the join path (D-33-2, D-33-3).
- No follow-up request inside the same wait to fill missing categories. It was considered and not chosen (§3, D-36-1).
- No production data write. Hanoi heals on its first open after W1 deploys (D-36-5).
- No frontend change in W1. Serving the stored catalogue at the cap uses the existing `done { cached: true }` event.

---

## Bottom line, in plain language

**What the traveller sees today.** Open Hanoi in Discovery and Essentials, Culture, Food and Nature are full, but Nightlife, Hidden Gems, Architecture and Wellness are empty. They stay empty for seven days, because Trippy marked that half catalogue as fresh. Separately, small towns sometimes get thin tabs. Hoi An's Essentials, the first tab anyone sees, held 3 places, one of them Da Nang airport.

**What changes.** After W1, a catalogue missing any category is shown at once but is not treated as fresh. The next open, from the traveller, the trip pre-warm or the co-pilot's search, runs the normal refresh: it excludes everything already stored and merges in the missing categories. After W2, the prompt defines each category, Essentials becomes the city's must-see places with logistics kept out, and the "say nothing about any shortfall" permission is gone.

**Cost.** A short catalogue costs at most the existing daily cap: three attempts a day at about $0.01 each. A place that genuinely has no nightlife would retry when opened, up to about $0.03 a day, while the traveller sees the stored catalogue.

---

## 1. Validated facts (do not re-derive)

**F-36-1 — Hanoi's 4 of 8 came from the model and was accepted by the code.** Production log: `[discover] end destination=Hanoi, Vietnam (VN) stop_reason=end_turn category=null output_tokens=9633 categories=4 items=37 dropped=0`, followed by `[discover] ok categories=[ all 8 names ]`. The parser therefore received **8 category lines, 4 of them with zero usable items**. The DB holds exactly 37 rows (essentials 8, culture 9, food 10, nature 10). Normal generations run 210–230 output tokens per item, so 9,633 tokens is about 40 items. Production does not keep the raw text, so an empty array cannot be told apart from items with no `name` (W1 logs `unnamed=` to settle it next time).

**F-36-2 — The only content gate was `MIN_CATEGORIES_WITH_ITEMS = 4`.** It is defined at `claude.js:736` and checked at `:957`. It came from commit `6daf588` (2026-07-08, Plan 7 production finding #4: Bali stored 10 items in a single category as a fresh catalogue). It was a guard against parse failures, chosen when Haiku 4.5 cutting off the last categories was routine. It has **no decision marker and no DECISIONS.md row**. `classifyStop` (`claude.js:142`) correctly treats `end_turn` as a complete *stop*, but nothing checked that the *content* was complete. `generate()` stamps `last_generated_at` and the daily count whenever `discoverDestination` returns (`discoveryGeneration.js:154–160`), and `isCatalogueFresh` (`discoveryCatalogue.js:70`) asked only for "recent, and more than 0 active rows". Plan 30's standing rollback trigger ("<8 categories on a destination that reached 8 on control") and Plan 35 §2 ("`end_turn` before eight categories is an incomplete generation", under D-30-3) both say 8; the code never caught up.

**F-36-3 — The model sometimes writes about half its normal output.** In 24 live replays (Hanoi, Hoi An, Da Nang, first generation; 12 run three at once like the D-35-3 pre-warm, 12 serial), **24/24 reached 8 categories and 0 emitted an empty category**. But **4/24 collapsed**: about 10–11k output tokens against about 18k normally, with 4–7 items in most categories. All four were Hoi An or Da Nang; Hanoi collapsed 0 times in 8. Hanoi's production run, at 9,633 tokens, is the same mode, with the output front-loaded into four categories.

**F-36-4 — Concurrency is not a cause.** A collapse happened in a serial run (Da Nang, serial round 3). Each request is an independent stream, and the code shares no state between generations.

**F-36-5 — The prompt sanctions silent short categories.** The Haiku 5.5 volume line is "Include at least 8 in every category unless the destination genuinely cannot support that many; never pad with mediocre places, and say nothing about any shortfall" (`DISCOVERY_SELECTION_RULES`, `claude.js:688`).

**F-36-6 — Essentials is undefined, so the model fills it with logistics.** The prompt names the eight categories but never says what any of them means. In the replays Essentials held Noi Bai and Da Nang airports, the Grab app, Vietcombank ATMs, hospitals, the visa-on-arrival office, SIM counters and bus stations. A small town has few of those, so its Essentials is thin (3, 3, 4, 5, 5, 6 and 6 across the misses). Essentials is the first tab and is always shown (`DiscoveryPanel.jsx:48`). It is also the first category written, so cross-category dedupe never touches it: an Essentials shortfall is the model's own output.

**F-36-7 — Cross-category dedupe drops repeats without a trace.** `processLine` drops any item whose normalized name already appeared in an earlier category (`claude.js:893–899`). Across 24 runs it dropped 24 items. In the worst case Hoi An's architecture went from 11 emitted to 5 kept, because 6 repeated culture places (Japanese Covered Bridge, Tan Ky Old House, Fujian Assembly Hall and others). There is no log line for it, and `dropped=` counts only unparseable lines.

**F-36-8 — At the daily cap, a stale catalogue serves nothing.** On a plain open of a non-fresh destination at `MAX_GENERATIONS_PER_DESTINATION_PER_DAY`, the route writes the `generation_limit` error and ends (`routes/discovery.js:326–336`), with no categories. With D-36-1, "not fresh" now includes "recent but incomplete", so this gap would bite more often.

**F-36-9 — Other production state (read-only, 2026-10-20).** On Haiku 5.5 since 2026-10-18, 1 of 9 production generations stored fewer than 8 categories (Hanoi, id 25). Chongqing (id 7) has held 6 of 8 since 2026-07-07, from the Haiku 4.5 era. It is already stale, so its next open merges. Hoi An (id 26) and Da Nang (id 27) have all 8 categories, with thin Essentials (3 and 5).

---

## 2. Decisions (owner rulings 2026-10-20)

- **D-36-1 — A catalogue is fresh only when it is recent AND every one of the eight categories has an active place.** This is judged at read time, in `isCatalogueFresh`, which the route, the trip-scope pre-warm and the co-pilot's kick all share. A short catalogue is shown at once and completed on the next open by the existing stale-refresh merge, which excludes the names already stored. **This replaces `MIN_CATEGORIES_WITH_ITEMS = 4`** (`6daf588`, Plan 7, unmarked). That threshold is retired: a generation that ends `end_turn` with at least one usable item is stored and stamped like any other, and completeness is no longer decided at write time. The Bali harm it guarded against, a one-category catalogue standing for a week, cannot happen under the read-time rule. A generation with **zero** usable items still throws, now as an "empty generation" error. That is not a short catalogue but no catalogue: there is nothing to store, and the traveller needs the error path. This is the one narrowing of "retire the <4 throw" (§5, flagged to the orchestrator). The "fill the missing categories in the same wait" alternative was considered and not chosen.
- **D-36-2 — A capped destination that is not fresh serves what it has.** On a plain open (not "show more") of a destination at its daily cap that holds active places, the route streams the stored catalogue and ends `done { cached: true }`, instead of the `generation_limit` error with nothing on screen. "Show more" at the cap keeps the `generation_limit` decline, because the traveller is already looking at the catalogue. A capped destination with no places at all keeps the error.
- **D-36-3 — Every generation's end line reports completeness and silent drops.** `[discover] end` gains `complete=<true|false>` (all eight categories have usable items), `deduped=<n>` (items dropped as a repeat of an earlier name) and `unnamed=<n>` (items dropped for having no `name`). The Plan 30 standing log check then reads `complete=false` directly.
- **D-36-4 — Essentials is the city's must-see places.** These are unmissable sights and experiences, with honest crowd notes. Practical logistics (airports, ride-hailing apps, ATMs, hospitals, visa offices, SIM counters, bus and train stations as transport) stay out of Discovery. W2 writes one line defining each of the eight categories.
- **D-36-5 — Hanoi gets no production write.** It heals on its first open after W1 deploys: not fresh under D-36-1, so the open runs a stale-refresh merge (its daily count was 1 of 3 on 2026-10-20).

---

## 3. Rejected alternatives

- **Write-time completeness** (do not stamp `last_generated_at` when fewer than 8 categories arrive). It would need a production write to repair Hanoi, and it would miss a catalogue that loses a category later. A generation that is not stamped also does not count against the daily cap, so a place that cannot fill a category would regenerate on every open with no bound. Read-time completeness has none of these problems.
- **Raising the minimum to 8 and throwing.** The same unbounded-retry problem, and it throws away a usable partial result's place in the freshness model.
- **An immediate fill request in the same wait.** Better UX for the one traveller who triggers it, but a new model call and a new prompt variant. Not chosen (D-36-1).

---

## 4. Waves

### W1 — Completeness is part of freshness (F1)

**Code.**
- `backend/src/db/discoveryCatalogue.js`: `isCatalogueFresh(destinationRow, activeRows, now)` takes the destination's active rows (not a count) and returns true only if the rows are non-empty, every one of `DISCOVERY_CATEGORIES` appears among their `category` values, and `last_generated_at` is within `CACHE_TTL_MS`. Marker `D-36-1`.
- Callers pass their active rows: `routes/discovery.js` (`activeRows`), `services/copilotGrounding.js` (`activeRows`), `services/discoveryPrewarm.js` (keeps `activeCount` for its `merge=` log and `useExclusions`).
- `backend/src/services/claude.js`: remove `MIN_CATEGORIES_WITH_ITEMS` and the insufficient-yield throw. Throw `[discover] empty generation …` only when no category has a usable item. Count `deduped` and `unnamed` in `processLine`. The end line gains `complete= deduped= unnamed=`. Markers `D-36-1` and `D-36-3`.
- `backend/src/routes/discovery.js`: at the daily cap, a plain open with stored active places streams them and ends `done { cached: true }`, logging `[discover] generation_limit destination=… dailyCount=… serving stored`. Marker `D-36-2`.
- `backend/src/services/discoveryGeneration.js`: the comment that cites the old guard is rewritten to the new rule.

**Tests.**
- `isCatalogueFresh`: recent and complete → true; recent with a missing category → false; stale and complete → false; no rows → false.
- `discoverDestination`: 3 categories with items → returns them, no throw, `complete=false`; zero usable items → throws "empty generation"; the end line carries `deduped` and `unnamed` counts for a fixture with a cross-category repeat and a nameless item.
- Route: a recently generated destination with 4 of 8 categories is treated as stale (stored breadth streamed first, generation with exclusions, merge); at the cap with stored places, a plain open serves the stored categories and `done cached:true` with no generation call; "show more" at the cap still gets `generation_limit`.
- Pre-warm and co-pilot kick: an incomplete recent destination is kicked (merge), and a complete recent one is skipped.
- The existing generation-limit tests that assumed an error on a plain open at the cap are updated to D-36-2.

**Verification.**
- `cd backend; npm test` green.
- Browser check on a **dev-DB copy**, never the owner's dev data. Pick a destination, cut its active places down to 4 of 8 categories in the copy, and stamp `last_generated_at` now. Opening Discover must show the 4 categories at once with the curation wait for the rest. The single paid generation (about $0.01, `--max-usd`-style care, D-30-7) must run as a merge with exclusions and leave all 8 categories filled. The next open must log `served fresh`.
- Docs: a `D-36-1/2/3` row group in `docs/DECISIONS.md`; the `docs/ENGINEERING.md` Discovery freshness bullet updated; `git diff --check`.

### W2 — The prompt defines the categories (F2)

Starts after W1 is merged.

**Code.** In `discoverSystemWith` (`claude.js`), one line defining each of the eight categories, with Essentials per D-36-4. Drop "say nothing about any shortfall" from the Haiku 5.5 volume line. The Haiku 4.5 rollback prompt stays byte-identical, because the category lines are keyed by model like D-30-1's selection rules. Marker `D-36-4`.

**Measurement (harness, D-30-7, `--max-usd` caps, budget about $0.50).** `scripts/modelEval/discovery.mjs` on its six destinations, plus Hanoi, Hoi An and Da Nang added as first-generation fixtures. Run three profiles: control (live), candidate (new prompt, effort `low`, thinking off), and candidate at effort `medium` with thinking still off.

**Gate.** Against control:
- 8/8 categories on every run.
- Collapse rate (runs under 12k output tokens with a majority of categories under 8) no worse than control, and reported per destination.
- Essentials median at least 8 on Hoi An and Da Nang, with zero logistics entries (airport, ride app, ATM, hospital, visa office, SIM, bus or train station as transport) across all runs.
- Items per category median at least control − 1.
- Dropped lines 0; `deduped` reported.
- First-category time no worse than control + 2 s.
- Exclusion repeats no worse than control's.

The effort `medium` variant is adopted only if it beats `low` on collapse rate without failing first-category time. Changing effort is a profile change (D-30-1), fixed for the workload, never per request.

**Verification.** Harness report in this plan; `discoveryRouteCheck.mjs` on one fresh destination; backend suite green; docs updated.

---

## 5. Open items

- **Zero-yield generations (D-36-1 narrowing).** A generation with no usable items still throws, so it is still not counted against the daily cap. That matches truncated and refused generations (D-30-3). If the orchestrator or owner wants the threshold gone completely, an empty `end_turn` would instead be stamped, counted and shown as an empty catalogue.

---

## 6. Results

### W1 — COMPLETE (2026-10-20, branch `claude/hungry-hugle-78d2ea`, not merged, not deployed)

**Code.** As specified in §4 W1. `isCatalogueFresh(destinationRow, activeRows, now)` requires every `DISCOVERY_CATEGORIES` entry among the active rows (`D-36-1`). All three callers pass rows. `MIN_CATEGORIES_WITH_ITEMS` is gone; only zero usable items throws "empty generation". `processLine` counts `deduped` and `unnamed`, and both `[discover] end` lines carry them, the success line with `complete=` too (`D-36-3`). The route's cap block serves the stored catalogue on a plain open (`D-36-2`). `discoveryGeneration.js` changed in comments only.

**Tests.** `cd backend; npm test`: 46 files passed, 2 skipped; **1,257 tests passed**, 12 skipped. Baseline was 1,241, so 16 tests were added. Pre-existing tests that encoded the old rule were updated to the new one, never weakened:
- **Fixtures that relied on "a recent 1-category catalogue is fresh"** now seed all eight categories, through a `completeCatalogue` helper in `discovery.test.js` and `copilotGrounding.test.js`, and through filler places in `discoveryFreshRequeue.test.js`.
- **The two cap tests that expected an error on a plain open** now assert D-36-2.
- **Mocks of `claude.js`** in `copilotGrounding.test.js` and `discoveryPrewarm.test.js` export `DISCOVERY_CATEGORIES`.

**Browser check, on a backup-API copy of the dev DB (the owner's dev DB was opened read-only for the backup and never written).**
- **Setup.** The worktree backend ran with `DB_PATH` pointing at the copy. In the copy only, Shanghai (dev id 9) had its nightlife, hidden_gems, architecture and wellness rows archived, leaving 4 of 8 categories, and was stamped `last_generated_at = now`. That is Hanoi's production state.
- **Open (375 px).** The panel showed the 4 stored categories at once (194 places; Essentials 45). The four missing tabs showed the curation manifest, `CURATING · 2 OF 8`. The backend logged `[discover] destination=Shanghai, China (CN) existingStops=400`: a stale-refresh merge with exclusions, not a fresh serve.
- **Merge.** It ended `stop_reason=end_turn output_tokens=23887 categories=8 items=102 dropped=0 complete=true deduped=1 unnamed=0`. All eight categories then held active places. The test setup made the missing categories fill thinly (nightlife 1, hidden_gems 3, architecture 1, wellness 6): their old rows still existed as archived, and `insertPlaces` skips a name that matches any stored row. Production Hanoi has no rows in its missing categories, so this does not apply there.
- **Reopen.** Logged `[discover] served fresh destination=9 places=191`, with all eight tabs carrying counts.
- **Cap (D-36-2).** In the copy, nightlife was archived again and today's count set to 3. A plain open logged `[discover] generation_limit destination=9 dailyCount=3 serving stored`. The panel showed the 190 stored places with no error, and no generation ran.
- **Spend:** one generation, about $0.013.

**Observation outside W1 (reported to the orchestrator, not fixed).** When a category has zero places after `done`, its tab body is blank: no copy and no manifest. That is what the owner saw on Hanoi. After D-36-1 a traveller meets it only on a day the destination is at its cap, or for a category the city truly cannot fill. Whether the empty tab should say something is a frontend product question.

**Docs.** DECISIONS rows D-36-1, D-36-2 and D-36-3; the ENGINEERING Discovery freshness bullet rewritten; `git diff --check` clean.
