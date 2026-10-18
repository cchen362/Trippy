# Stop-photo fallback investigation — why one manual stop in three gets a generic photo

**Date:** 2026-10-18 · **Type:** investigation (findings only — nothing implemented) · **Origin:** found while verifying Plan 30 W2 (`6664f4f`); out of Plan 30's scope.

**Spend:** 166 live Unsplash search calls (budget 300), 0 Anthropic calls (descriptor queries were reused from the W2 harness runs already on disk), 0 download-tracking calls. The dev DB was read from a copy in a scratch folder; the owner DB was never opened. Throwaway scripts lived in the session scratchpad and were not committed.

---

## Headline

**Most generic photos are not the relevance gate rejecting a photo — they are Unsplash returning nothing at all.** In 22 of the 36 measured fallbacks (61%), the 6–8-word descriptor query returned **zero** results, so the gate never saw a photo. In plain terms: the query is so specific ("Gwangjang Market Seoul food stalls bindaetteok") that no photo on Unsplash matches every word, and Trippy jumps straight to "food drink South Korea".

The second cause (10 of 36, 28%) is a gap between the plan and the code: the gate was specified to read a photo's alt text, **description**, and tags, but the code reads the description only when the alt text is empty — which never happens (640 of 640 results carried alt text). The human-written description is exactly where place names live ("Berghain Berlin during Covid Closing Period", "Nanxiang Xiaolongbao, Shanghai"). Tags are also dead: the search endpoint returned tags on **0 of 640** results.

A short-query retry on empty results plus a gate that reads the description cut the fallback rate on the live model from **15 / 50 (30%) to 5 / 50 (10%)**, measured on cached results with no extra calls beyond the retry itself — at the cost of two or three recovered photos showing a related-but-wrong place.

---

## 1. The gate, and the Plan 10 decisions it implements

### The code

`backend/src/services/unsplash.js`:

| Lines | What it does |
|---|---|
| `:15-28` `mapPhoto` | `alt: photo.alt_description \|\| photo.description` — description is used **only as a fallback for a missing alt**. `tags` is mapped from `photo.tags`. |
| `:58-62` `search` | `per_page=10`, `orientation=landscape`, `content_filter=high`. |
| `:92-96` `STOPWORDS` | 24 words (articles, "travel", "best", "famous", …). |
| `:98-103` `tokenize` | lower-cases, splits on anything not `[a-z0-9]`, keeps tokens ≥ 3 chars. |
| `:105-108` `significantTokens` | query tokens minus city tokens, country tokens and stopwords. |
| `:110-114` `passesGate` | passes if no significant tokens remain, or if **any** significant token is a **substring** of `alt + tags`. |
| `:122-131` `selectPhoto` primary | walks the 10 results in Unsplash relevance order; the first one that is not already used in the trip (`excludeIds`) **and** passes the gate wins. |
| `:133-148` fallback | if none qualifies: one search for `"{sceneType words} {country}"` (or `"{city} travel"` for `generic`/null), gate **off**, trip exclusion still applied; first unused result wins. |
| `:150` | both tiers empty → `null` (styled no-image card). |

The caller, `resolvePhotoUrl` (`backend/src/services/stops.js:352-409`), builds the query as stored/incoming `photoQuery` → Haiku descriptor → `resolvedName + city` → `title + city`, and passes the country **name** (`countryNameFromCode`) and the resolved city. `excludeIds` comes from `getTripPhotoIds` (`stops.js:325-340`) — every photo id on **this trip's** stops, nothing wider.

### The decisions it implements (`docs/superpowers/plans/Implementation Plan 10 Stop Card Image System.md`)

- **Plan 10 D2** — "One pipeline, not a resolver-style cascade … relevance-ordered pick with (a) trip-level photo-id exclusion and (b) a token-overlap relevance gate → country-scoped scene fallback query → styled no-image card … Tier count equals today's (primary → fallback → none)." This is the whole shape of `selectPhoto`.
- **Plan 10 W2.1** (the gate's specification) — "≥1 significant query token (stopwords/city/country stripped) present in `alt_description` / `description` / `tags`". **The code does not match this**: it reads `description` only when `alt_description` is empty.
- **Plan 10 W2.2** — fallback `"{sceneType words} {country}"`, "gate off (query is generic by construction)", dedup still applied.
- **Plan 10 D8** — the closed 14-member scene vocabulary and the fallback query shape (`generic` → `"{city} travel"`).
- **Plan 10 D3** — descriptors are authored by Claude; the descriptor prompt (`backend/src/services/claude.js:585-590`) asks for "at most 8 words", culturally specific. The long query is by design.
- **Plan 10 D5** — "no scene-pool caching initially". `docs/DECISIONS.md:39` records this as an **unexamined default**, not a closed decision, because its premise (the demo tier) is gone.
- **Unsplash tier — CLOSED** (`docs/DECISIONS.md:49`, marker above `search()` at `unsplash.js:47-50`): 1,000 req/hr in production. Nothing below proposes a tier change or a rate-limit workaround.

No `D-`/`Plan N D` marker sits in `unsplash.js` for D2 or W2.1 (only Plan 10 D1 at `:3-5` and the tier ruling at `:47`).

---

## 2. Why the gate rejects — measured on the 50 descriptor fixtures

**Method.** The descriptor queries come from the Plan 30 W2 harness runs already on disk (`backend/data/model-eval/runs/descriptor/control/2026-10-18T13-51-24-605Z.jsonl` for Haiku 5.5, `…/baseline-45/2026-10-18T13-52-11-048Z.jsonl` for Haiku 4.5), with each fixture's city and country from `backend/scripts/modelEval/fixtures/descriptor-places.json`. Every query was pushed through the **real, unmodified** `selectPhoto` (imported from `unsplash.js`) with `excludeIds: []` (one stop per trip), behind a caching `fetch` that kept the raw Unsplash payloads for classification. 125 calls. The fallback counts match the W2 measurement (Haiku 5.5: 15 here vs 15–20 there).

### Breakdown

A fallback is classified by the first rule that fits.

| Why the primary result was rejected | Haiku 5.5 | Haiku 4.5 | Both |
|---|---:|---:|---:|
| **Zero results** — Unsplash returned nothing for the query | 10 | 12 | **22 (61%)** |
| **Place name was in the description, which the gate never reads** — a significant token appears in `description` (or the alt-derived slug) of a result | 3 | 7 | **10 (28%)** |
| Near-miss spelling (plural / stem only) | 0 | 1 | 1 |
| No overlap anywhere | 2 | 1 | 3 |
| City / country-only overlap | 0 | 0 | 0 |
| **Total fallbacks** | **15 / 50** | **21 / 50** | 36 / 100 |

Supporting facts measured on the same 640 primary results:
- **Tags: 0 / 640.** The search endpoint does not return `tags`, so half of the gate's haystack is always empty.
- **Alt text: 640 / 640; description: 283 / 640.** Because alt is always present, `mapPhoto`'s `alt || description` never reaches the description.
- **Query length does not separate the two groups.** Zero-result queries ran 5–8 words; passing queries also ran 5–8 words. What sinks a query is one rare word (`bindaetteok`, `Thip Samai`, `Geunjeongjeon`, `Cemberlitas`) — Unsplash appears to need every word to match.
- City/country exclusion is **not** a cause: no fallback was a city-only match.

### The gate's "pass" is not "right place" either

Of the 64 primary passes with significant tokens, **10 passed only on a substring** (`night` inside "night**time**", `past` inside "**past**el", `mount` inside "**mount**ain", `hot` inside "p**hot**ography"), and most of the rest matched only a generic word (`temple`, `street`, `food`, `market`, `view`). Many of those photos are still correct — because Unsplash's own relevance order did the work, not the gate. In both directions the gate has little real power: it lets generic matches through and blocks photos whose captions name the exact place.

### Ten concrete examples

| # | Model / fixture | Query | Top primary result (alt // description) | Why rejected | Fallback photo chosen (alt) |
|---|---|---|---|---|---|
| 1 | 5.5 · `cjk-gwangjang` | Gwangjang Market Seoul food stalls bindaetteok | — (0 results) | zero results | man in white dress shirt … standing in front of food stall |
| 2 | 5.5 · `dish-pad-thai` | Pad Thai Thip Samai Bangkok street food | — (0 results) | zero results | pasta with vegetables near meat with cabbage and stewed food in bowl |
| 3 | 5.5 · `show-kabukiza` | Kabuki-za Theatre Ginza Tokyo facade night | — (0 results) | zero results | Cars driving through a neon-lit intersection in Shibuya, Tokyo, at night (`alY6_OpdwRQ`) |
| 4 | 5.5 · `museum-teamlab-planets` | teamLab Planets Tokyo digital art installation water room | — (0 results) | zero results | the **same** Shibuya intersection (`alY6_OpdwRQ`) |
| 5 | 5.5 · `dish-xiaolongbao` | xiaolongbao soup dumplings steaming bamboo basket Shanghai | "dim dim dim …" // **Nanxiang Xiaolongbao, Shanghai** | description unread | a wooden table topped with bowls of food (`3t04amJQ2N8`) |
| 6 | 5.5 · `dish-hotpot` | Chongqing hot pot spicy broth street dinner | — (0 results) | zero results | the **same** wooden table (`3t04amJQ2N8`) |
| 7 | 4.5 · `night-berghain` | Berghain Berlin industrial techno nightclub | blue and white graffiti on wall // **Berghain Berlin during Covid Closing Period.** | description unread | time-lapse photography of vehicle at the road … at nighttime |
| 8 | 4.5 · `museum-teamlab-planets` | teamLab Planets Tokyo digital art immersive experience | Vibrant field of purple, pink, and white blossoms // **Floating flower garden … at teamLab Planets** | description unread | Silhouettes of people looking out window at trees |
| 9 | 5.5 · `dish-dim-sum` | dim sum basket Tim Ho Wan Hong Kong | a person holding a spoon full of dumplings // Dumpling in Hong Kong. | no overlap (`dumplings` ≠ any query token) | Two people holding up drinks in front of a restaurant |
| 10 | 4.5 · `cjk-banpo-park` | Banpo Hangang Park Seoul riverside picnic sunset | a bridge over water (4 results; #2 is "City dwellers enjoying a night by the river") | near-miss: "river" in the caption, "riverside" in the query — a right-looking Han River photo rejected | a view of the mountains and valleys from the top of a mountain |

Examples 5 and 6 are the cross-trip duplication mechanism in miniature: two different stops, each in its own trip, get the identical photo because the fallback query (`"food drink China"`) is the same and its top result is the same. In the Haiku 4.5 run the same photo `3t04amJQ2N8` went to **three** fixtures (`cjk-quanjude`, `dish-hotpot`, `dish-xiaolongbao`). Across both runs the 36 fallbacks used only 25 distinct photos.

---

## 3. Shared fallback photos across trips in the dev DB

Read-only query on a copy of `backend/data/trippy.db` (+ WAL):

- **10 stops carry a photo**, across **4 trips**, 10 distinct photo ids. 9 of the 10 have a stored scene type. Photo sources: 5 `auto`, 1 `user`, 4 null (pre-W1 rows).
- **Photos shared between two or more stops: 0** (within a trip or across trips).

So the dev DB cannot show the effect: it holds too few photo stops, and few of them share a country and a scene. The duplication is a property of the algorithm, not of the data, and it is measured above on the fixtures. **Production is unmeasured** — that would need a read of a production backup copy (the owner's call; not done here).

---

## 4. Candidate remedies

All three are small, backend-only changes to `unsplash.js` (and, for R3, one query in `stops.js`). None changes the Unsplash tier, adds a model call, or touches the descriptor prompt (whose request body is sha-pinned by Plan 30 W2).

### R1 — Retry with a shorter query when Unsplash returns nothing

**Plain language.** When the detailed query finds no photos at all, try again with just its first few words (usually the place name) before giving up and using a generic scene photo.

**Example.** "Pad Thai Thip Samai Bangkok street food" finds nothing today, so you get a generic bowl of stewed food. The retry "Pad Thai Thip" finds "Delicious pad thai with fresh herbs and lime".

**Implication.**
- *Relevance:* on the live model alone (current gate), fallbacks drop **15 → 8 of 50**. Measured: of the 22 zero-result queries, 13 found a usable result on a 4- or 3-word retry.
- *Spend:* one or two extra Unsplash searches only on the ~20–24% of stops whose query returns nothing — roughly 0.3–0.5 extra calls per new stop. Negligible against 1,000/hr.
- *Wrong-place risk:* real, and worse with today's substring gate. "Din Tai Fung" as a retry passed the gate on `din` inside "buil**din**g" and on `tai` inside "s**tai**nless" — a high-rise and a bowl of garlic. "Tsukiji Outer Market Tokyo" found Nakamise-dōri at Sensō-ji (a different market) because `market` matched.
- *Effort:* ~half a day including tests.
- *Reopens:* **Plan 10 D2**'s "Tier count equals today's (primary → fallback → none)" — it adds a step between primary and fallback.

### R2 — Make the gate read what Unsplash actually returns, as whole words

**Plain language.** Let the relevance check read the photographer's own caption (where place names appear) and match whole words (plurals allowed) instead of fragments of words.

**Example.** The top result for the Berghain stop is captioned "Berghain Berlin during Covid Closing Period" — today it is thrown away because only the AI-generated "blue and white graffiti on wall" is read. Conversely, "Din Tai Fung" would no longer match "building".

**Implication.**
- *Relevance:* on its own, fallbacks drop **15 → 13** (Haiku 5.5) and **21 → 16** (Haiku 4.5). Smaller than R1, because it can't help a query with zero results. Its main value is **precision**: whole-word matching stops the substring accidents, which is what makes R1 safe to add.
- *Trade-off inside R2:* whole-word matching also rejects some photos that are right today by accident (`past` → "pastel de nata" for Pastéis de Belém; `mount` → "mountain" for Mount Batur). Those stops would fall back unless the word is also in the description. Reading the description but keeping substring matching avoids that loss (fallbacks 15 → 12) and keeps the accidents.
- *Spend:* zero extra calls.
- *Effort:* a few hours; also drop the dead `tags` mapping or keep it harmlessly — the search endpoint never fills it.
- *Reopens:* **nothing.** Plan 10 W2.1 already specifies `alt_description` / `description` / `tags`; the code reading description only when alt is missing is an implementation deviation. Whole-word matching is a refinement of the same gate.

### R3 — Stop handing the same fallback photo to every trip

**Plain language.** When a stop does fall back to a scene photo, skip scene photos you've already used anywhere in your trips, not just in this trip.

**Example.** Your Shanghai trip and your Chongqing trip both have a food stop that falls back to "food drink China"; today both show the same wooden table of bowls. With R3 the second trip gets the next photo down the list.

**Implication.**
- *Relevance:* none — the photo is still generic, just different. It fixes repetition, not wrongness.
- *Spend:* zero Unsplash calls; one extra DB read per fallback.
- *Wrong-place risk:* none.
- *Effort:* a couple of hours (an owner-wide or global used-ids set for the fallback tier only).
- *Reopens:* **Plan 10 D2(a)** ("trip-level photo-id exclusion") — widens its scope for the fallback tier. A per-`(country, sceneType)` pool would be the alternative, and that is **Plan 10 D5** (open per `docs/DECISIONS.md:39`); not recommended — it saves calls Trippy does not need to save and does nothing for relevance.

### Combined (measured on cached results)

| Gate | Haiku 5.5 fallbacks | Haiku 4.5 fallbacks |
|---|---:|---:|
| Today | 15 / 50 | 21 / 50 |
| R1 only | 8 | 15 |
| R2 only (description + whole word) | 13 | 16 |
| **R1 + R2** | **5** | **8** |

With R1 + R2 the recovered photos on Haiku 5.5 were: Gwangjang Market (right), Pad Thai (right dish), Chongqing hot pot (a packet of hot-pot base — right subject, weak photo), Blue Lagoon (right), teamLab Planets (right — the caption names it), Sichuan opera (right), Din Tai Fung → Nanxiang xiaolongbao (right dish, different restaurant), Kabuki-za → a kabuki costume at the Edo-Tokyo Museum (related, wrong place). On Haiku 4.5: Park Hyatt Tokyo, Raffles, Peak Tram (right, captions name them); Tsukiji → Sensō-ji's Nakamise (**wrong place**).

So roughly **one recovered photo in five is a related-but-wrong place**, against today's guaranteed-generic photo. Whether a plausible-but-wrong photo beats an obviously generic one is a product call.

---

## 5. Recommendation

**Do R1 and R2 together as one small change; leave R3 until production shows repeats.**

The one reason that matters most: **61% of generic photos come from Unsplash returning nothing, and only a retry addresses that** — but the retry is only safe with R2's whole-word gate, which stops "Din Tai Fung" matching "building". Together they cut generic photos on the live model from about one stop in three to about one in ten, for well under one extra Unsplash call per new stop.

R3 is cheap and risk-free but fixes repetition, not relevance, and the dev DB shows no repeats in 10 photos; a read of a production backup would say whether repeats are real for the owner before spending on it.

### Not verified

- Production behaviour (fallback rate, cross-trip repeats) — no production data was read.
- Discovery-added stops: their queries come from discovery generation, not the manual-stop descriptor, and were not measured; the same gate applies to them.
- The remedies are measured against cached Unsplash results for 50 fixtures and one run per model; Unsplash ranking drifts over time and descriptor queries vary run to run (the W2 runs ranged 14–20 fallbacks per model).
