# Implementation Plan 36 — Discovery Catalogue Completeness

**Status:** 2026-10-20 — **APPROVED** (owner rulings of 2026-10-20, relayed by the Plan 35 orchestrator). **W1 COMPLETE and DEPLOYED 2026-10-20 at `a44f437`** (§6). It was merged by the orchestrator, the backend suite passed on main (1,263), and it was browser-verified on a dev-DB copy. It is backend only (no frontend bundle change, no migration). Pre-deploy backup `trippy-2026-10-20-022253.db`; health OK; the new freshness rule was confirmed in the container. **Owner production pass PASSED (2026-10-20):** Hanoi's open started a stale-refresh merge (`existingStops=37`), and a second open joined it. It ended `end_turn categories=8 items=89 complete=true deduped=0 unnamed=0`. Hanoi now has all 8 categories (essentials 18, culture 20, food 22, nature 20, nightlife 11, hidden_gems 10, architecture 12, wellness 11), with a daily count of 2 of 3. **W2 MEASURED: gate FAILED, NO-GO** (§6 W2, $0.518; harness and plan only, merged to main at `3c586d9`). The category-definitions prompt removes logistics from Essentials but makes small towns thinner and does not cure the collapse, so `claude.js` is unchanged. Q-36-1 is open for the owner. No migration in either wave.

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

### W2 — measured, gate FAILED, NO-GO (2026-10-20); `claude.js` unchanged

**What was measured.** Prompt variant `defined-categories` (`scripts/modelEval/lib/discoveryPromptVariants.mjs`) is Haiku 5.5's live prompt with three changes:
- one line defining each of the eight categories, inserted after the order line, with Essentials as "the city's must-see places";
- a closing line keeping practical logistics out of every category;
- the volume line without "say nothing about any shortfall".

It ran under two profiles, `v-defined-low` (the live settings) and `v-defined-medium` (effort `medium`, thinking still disabled), against a same-day `control`. Each profile covered two sets:
- the standard corpus: 6 destinations × {first, exclusions} = 12 generations;
- the small-town set: Hoi An and Da Nang, first generation × 4 repeats = 8 generations.

All three profiles ran at the same moment, so load was equal. D-30-7: every run reported the copy and the owner DB **UNCHANGED**.

The harness gained opt-in, first-only fixtures (`hoian`, `danang`), `--repeat`, and scorer rows for:
- collapse runs (< 12,000 output tokens with most categories under 8);
- the Essentials count;
- categories under 8 items;
- logistics entries (`LOGISTICS_RE`).

Logistics hits were hand-checked. Control's 52 were real logistics: airports, Didi ride-hailing, ATMs, pharmacies, tourist offices, bus terminals. `v-defined-medium`'s 6 were heritage buildings: KL Railway Station, Ipoh's colonial station, station ruins.

**Spend:** $0.518 (control $0.188, low $0.152, medium $0.179).

| measure | control | v-defined-low | v-defined-medium | gate |
|---|---|---|---|---|
| **Standard corpus (12 each)** | | | | |
| categories 8/8 | 12/12 | 12/12 | 12/12 | every run ✔ |
| collapse runs | 0/12 | 2/12 (Okinawa, Ipoh) | 0/12 | ≤ control |
| items per category, median of medians | 10.25 | 9.5 | 10 | ≥ control − 1 |
| categories under 8 items | 4/96 (4%) | 26/96 (27%) | 7/96 (7%) | — |
| Essentials median / min | 10 / 4 | 8.5 / 5 | 8.5 / 7 | — |
| logistics in Essentials (raw) | 40/121 (33%) | 2/109 (2%) | 3/113 (3%), all heritage | 0 real |
| dropped lines | 0 | 0 | 0 | 0 |
| duplicate-name drops | 1.7% | 3.9% | 2.9% | reported |
| alias identical to name | 3.0% | 2.4% | 2.0% | — |
| exclusion repeats | 34.3% | 41.2% | 26.4% | ≤ control |
| first category, median / max | 10.8 s / 16.2 s | 11.3 s / 17.3 s | 11.7 s / 19.8 s | median ≤ control + 2 s |
| **Small towns, Hoi An + Da Nang (8 each)** | | | | |
| collapse runs | 1/8 | 3/8 | **2/8** | ≤ control ✘ |
| Essentials median / min | 8.5 / 5 | 5.5 / 3 | **7 / 3** | median ≥ 8 ✘ |
| items per category, median of medians | 9.75 | 7.25 | **8.25** | ≥ control − 1 ✘ |
| categories under 8 items | 10/64 (16%) | 40/64 (63%) | **23/64 (36%)** | — |
| logistics in Essentials (raw) | 28/74 (38%) | 0/45 | 0/55 | 0 ✔ |

**Reading.**
1. **The definitions do exactly what D-36-4 asked for in quality.** Logistics leave Essentials (33–38% → 0 real) and exclusion repeats fall at effort `medium` (34% → 26%).
2. **They do not cure the collapse.** Control collapsed 1/8 on small towns here, and 4/16 in the same-day investigation replays (F-36-3), so about 5/24 on Hoi An and Da Nang. The candidate at `medium` collapsed 2/8, and at `low` 3/8 and 2/12 on the standard corpus as well. Dropping "say nothing about any shortfall" did not lower the rate, and effort `medium` did not either.
3. **On small towns the candidate is thinner across the board, not only in Essentials.** At `medium`, 36% of categories are under 8 against 16%. Essentials shrinks most, because the logistics entries that used to fill it are gone and the model does not replace them with more sights. At effort `low` the definitions cut volume everywhere.

**Verdict: NO-GO.** `v-defined-medium` passes the standard corpus but fails three small-town criteria. `v-defined-low` fails both sets. Adopting either would accept a measured regression on exactly the destinations this wave targets (Plan 36 / ENGINEERING "no meeting in the middle"). The live prompt, profile and pins are unchanged. D-36-4 stands as the owner's definition of Essentials, but it is **not yet expressed in the prompt**.

**Harness kept** (committed): the `defined-categories` variant, the `v-defined-low` / `v-defined-medium` profiles, the small-town fixtures, `--repeat`, and the Plan 36 scorer rows. Run files are under `backend/data/model-eval/runs/discovery/{control,v-defined-low,v-defined-medium}/2026-10-20T08-2*`.

**Open for the owner (Q-36-1).** The collapse is a model-side output-volume mode, about 1 in 5 small-town generations, and prompt wording and effort do not move it. A thin but complete catalogue still counts as fresh under D-36-1. Options, not run:
- (a) Measure a small-town-specific lever: an exact count line ("Return exactly 10 in every category"), or thinking on, which D-34-10 traded away for the 11 s first category.
- (b) Make thinness part of freshness: under 5 items in most categories → not fresh, so the next open merges.
- (c) Ship the definitions anyway for the quality gain, accepting thinner small-town catalogues. That is a measured regression, so it needs an explicit owner ruling.
