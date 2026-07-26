# Discovery Catalogue Quality — Assessment and Recommended Work

**Status:** FINDINGS ONLY — 2026-07-26. Nothing implemented. Four owner decisions settled, three open.

**Companion to** `2026-07-26-discovery-catalogue-quality-review.md`, which holds the production measurements and the first two review passes. That document is the evidence record; this one is the current assessment and supersedes it wherever they disagree. **Do not re-derive the production inventory** — it was measured read-only on 2026-07-25/26 and the figures there stand.

**How this document is written.** Findings lead with what a user would notice, then explain the mechanism, then cite code. That ordering is deliberate and applies to future reviews in this repo.

**Provenance of the findings below.** Three passes: the original production investigation (F1–F6), an independent follow-up by Codex (C1–C5, A1–A5), and a third audit that corrected both. The third audit's claims were then sent back to Codex for adversarial attack; six were returned as OVERSTATED and have since been verified line-by-line. **Codex returned verdicts without its supporting citations**, so every resolution below rests on direct code verification, not on its argument.

---

## What a user actually experiences

### 1. Adding a stop or saving a day city can stall behind background work

Every place lookup in Trippy queues through one shared gate that permits one lookup per second — a rule the free OpenStreetMap geocoder imposes, and honouring it is correct. The gate is a module-level variable (`placeResolver.js:15`) shared by *all* callers. Discovery's background checking is the only bulk user of it, and it never yields.

Interactive callers stuck behind it: adding a stop (`stops.js:189`), booking-linked stop resolution (`stops.js:831`), and day city-override country inference (`trips.js:1269`) — the last being an **awaited call inside the PUT that saves the override**, so the user watches a spinner.

**Verified duration.** Plan 7 §2.1 estimated "~240 items ≈ 4 min", assuming one item costs one request. It doesn't: `searchNominatim` (`placeResolver.js:426`) tries each query variant sequentially until one returns, and `verifyOne` may run the whole thing twice (name, then `local_name`). Measured variant counts on real catalogue names: parenthesised names produce 3 variants, unparenthesised names produce 1, plus one per alias. A successful lookup costs 1–2 requests; a failing one costs every variant. At the observed ~55% success rate, ~240 candidates lands near **700–800 requests ≈ 12 minutes** of continuously occupied gate.

So the plan under-estimated by roughly 3×, and an earlier draft of this assessment over-estimated at 15–25 minutes. **~12 minutes is the defensible figure.**

**Second-order finding, surfaced during verification.** The daily checking budget is 500 lookups (`config.js:55`), but one generation of ~240 candidates can consume up to ~480 of them once the `local_name` fallback fires. **A single "Show more" on a single city can exhaust the entire day's budget**, leaving every other city's suggestions stuck unchecked. The observed production peak of 421/day is consistent with exactly this. Finding F6 ("the budget is not the constraint") is therefore wrong twice over — wrong unit, and wrong conclusion.

### 2. A day can be filed under the wrong country, silently

Type a free-text city into a day and Trippy tries to work out its country. When that fails, the day inherits the country from **the previous day**, because `deriveDayGeo` (`trips.js:504-509`) picks city and country independently across its layer list. A free-text 冲绳 day following a Shanghai day resolves to *Okinawa, China*.

Everything downstream then trusts it: Discovery composes the AI prompt as "冲绳, China (CN)" (`discovery.js:141`), and genuine Okinawa results are rejected for having the wrong country.

**Adversarially challenged as OVERSTATED, and the challenge is fair on frequency.** Inference usually succeeds — `resolveOverrideCountry` accepts *any* country the geocoder returns regardless of confidence (`trips.js:1270`), so a null country is uncommon.

**But verification exposed an interaction that matters more than the frequency.** That missing confidence gate is itself a defect (a weak, low-confidence match stamps a durable country). **Fixing it in isolation would produce more nulls and therefore make the inheritance bug fire more often.** The two must be fixed together or the "fix" makes things worse. Neither review caught this.

Behaviour is documented at `trips.js:440-443` and pinned by `tests/trips.test.js:220`. **The owner has ruled the layer precedence out of scope** — it is the Plan 6/7/8 geography model and is load-bearing across day headers, maps, share, and geocoding bias. The agreed alternative is additive: record which layer city and country each came from, and have **Discovery alone** decline a country that came from a different layer than the city. No precedence change, one consumer affected.

### 3. "Verified" does not guarantee the right place — CONFIRMED under attack

Two paths produce the badge. The OpenStreetMap path checks that the returned name resembles what was searched (`classifyNominatimResult:343`). **The Google fallback does not** — it takes the first result and hardcodes `locationStatus:'resolved', confidence:0.9` (`placeResolver.js:548`).

Combined with `isConfidentHit` (`discoveryVerify.js:83-89`) accepting **any** resolved country when the destination's country is empty — pinned as intended by `discoveryVerify.test.js:174` — a vague editorial query can attach to an unrelated real place and receive the product's strongest trust label.

**Correction to the original review's A1:** an `estimated` OpenStreetMap result can *never* become verified; `isConfidentHit` requires `resolved` exactly. But a weak `estimated` hit **does** block the Google fallback, because `resolvePlace` returns any OSM result immediately (`placeResolver.js:618`). That is a false-negative source and was confirmed under attack.

### 4. New suggestions are discarded before anyone checks them

Each category holds 45 active places. New suggestions are inserted, then the cap runs, then checking is queued — `discoveryGeneration.js:59` before `:64`.

**Verified as deterministic, not merely likely.** `enforceCategoryCap` ranks victims with `NEUTRAL_PREFS`, under which the category-match and pace terms are always zero and the quality term is always zero (rating enrichment is off). The score therefore reduces to exactly `−0.75 × batch` (`discoveryRank.js:110`). Newest batch = lowest score = **always archived first**. Their names then join the permanent do-not-suggest-again list (`listExclusionNames:169`).

**An earlier draft called this an implementation deviation from Plan 7 §2.3 ("after insert+verification"). That was wrong and is withdrawn.** Plan 7 §2.1 line 282 specifies verification is "enqueued fire-and-forget from the route right after `insertPlaces`/`enforceCategoryCap` — never awaited." **The plan contradicts itself**, and the implementation followed the operative, mechanically achievable half. Codex's OVERSTATED verdict is correct.

This changes the fix, not the problem. There is no ordering that satisfies both halves. The options are to exempt never-checked rows from the cap until they've had a turn, or to re-run the cap once the queue drains. Either is a design change, not a reordering.

### 5. "Show more" churns on popular categories

At a full category, a tap spends one of three daily generations, buys ~30 AI suggestions, archives them before checking, and bars their names forever.

**Adversarially flagged as OVERSTATED, and correctly so:** `enforceCategoryCap` skips categories with no surplus (`discoveryCatalogue.js:219`), and the append path re-queries survivors before streaming (`discovery.js:278-284`). So a tap still delivers real value in categories under the cap — the waste is **per category, not per tap**. It concentrates in the categories users actually browse, which fill first.

With 8 categories × 45, a city ceilings at 360. Taipei sits at 298 (avg 37/category), so several categories are already there.

### 6. Chinese-character place names collide — CONFIRMED under attack

`normalizeName` (`claude.js:180`, mirrored at `DiscoveryPanel.jsx:39`) uses `[^\w\s]` with **no `/u` flag**, so `\w` is ASCII-only. Executed: `北京烤鸭`, `故宫博物院`, `喀什老城` all fold to `""`.

Consequences: the first pure-CJK-named item in a destination claims `normalized_name = ''` and **every subsequent one is silently skipped as a duplicate** (`insertPlaces:120`); on the frontend, one CJK stop title makes every CJK-named suggestion falsely read "In trip" and drop out of Surprise Me.

Limited today only because the prompt asks for romanized names — a convention, not an invariant. `canonicalGeoKey` (`utils/geoIdentity.js`) handles this correctly with `\p{L}` and `/u`; it is the fix template.

### 7. 44% of visible suggestions were never confirmed to exist

706 of 1,598. Most are real places wrapped in editorial phrasing. The trust signal exists (`SuggestionCard.jsx:250`) but **only inside an opened Details panel** — the browse card shows a positive for verified rows and nothing at all otherwise, so absence reads as *no claim made* rather than *unconfirmed*.

Correcting F1: "the client has no way to distinguish them" is false. The accurate finding is that the signal is buried.

### 8. Duplicate-looking suggestions

Three live Kaohsiung cards for one lake. Duplicate removal keys on the provider's place ID (`dedupeByProviderId:95`), which only exists after verification — so it is structurally blind to the 44% where duplicates live. **A place-ID-based duplication measure reports zero and is misleading.**

### 9. Failed checks never retry, and leave no trace

`enqueueForVerification:244` re-collects only `pending` rows; terminal `unverified` is never revisited. No record of when a check ran, which service answered, what came back, or what was searched. **Nobody can currently say whether the 44% is one problem or five.** The negative-result cache expires after an hour (`placeResolver.js:13`), so re-checking genuinely re-tries rather than replaying cached failures — the corpus is repairable.

---

## Ranking

| Rank | Problem | Severity |
|---|---|---|
| 1 | Interactive saves stall behind background checking (§1) | HIGH |
| 2 | "Verified" doesn't guarantee identity (§3) | HIGH |
| 3 | New suggestions binned before checking (§4) | HIGH |
| 4 | Wrong country on a free-text day (§2) | HIGH — low frequency, silent and confident when it fires |
| 5 | 44% unchecked with no browse-surface signal (§7) | MED-HIGH |
| 6 | Duplicates invisible to the dedupe mechanism (§8) | MED-HIGH |
| 7 | CJK name collisions (§6) | MED-HIGH |
| 8 | "Show more" churn on full categories (§5) | MED |
| 9 | No retry, no record of failures (§9) | MED — blocks measuring everything above |
| 10 | Nominatim usage policy / User-Agent (§1, `config.js:47`) | LOW-MED |

---

## Corrections to the prior review, consolidated

| Prior claim | Resolution |
|---|---|
| F1 — client can't distinguish verified/unverified | **Wrong.** Signal exists, buried in Details (§7) |
| F3 — display name doubles as geocoder query | **Partly mitigated, less than an earlier correction claimed.** Bracket-stripping catches parenthesised names (3 variants) but un-bracketed editorial names get **no cleaning at all** (1 variant, verified). Google receives the raw query only |
| F5 — Beijing/Xinjiang unreachable via `discoveryCatalogue.js:74` | **Wrong line.** That is the D6 adoption helper; `getOrCreateDestination:24` matches literally. Moot — owner has decided to delete them |
| F6 — budget is not the constraint | **Wrong unit and wrong conclusion** (§1) |
| A1 — an `estimated` hit can be labelled verified | **False.** But the fallback-blocking half is confirmed (§3) |
| A2 — cap-before-verify is a lifecycle flaw | **Confirmed and deterministic** (§4) |
| "Cap ordering is a deviation from Plan 7" | **Withdrawn** — the plan contradicts itself (§4) |
| "Background checking blocks 15–25 min" | **Over-estimated; ~12 min verified** (§1) |
| "Sending query variants to Google is worthwhile" | **Downgraded to measure-first.** Google is only reached after every variant already failed on OSM (`placeResolver.js:616-627`). Different corpora make it non-zero, but the upside is unproven |

---

## Recommended work

**Round 1 — no schema change.** Let interactive lookups pre-empt background checking. Stop the cap from discarding never-checked rows (design choice per §4). Fix CJK name folding forward-only. Add a confidence gate to day-override country inference **together with** the Discovery layer-source guard, never separately (§2).

**Round 2 — make "verified" mean something.** Name-similarity check on the Google path, matching what the OSM path already does. Record the resolved country for unknown-country destinations instead of waving it through.

**Round 3 — observability, then measurement.** Additive columns: when checked, by which service, outcome, query used, match score. Budget expressed in **provider requests, not lookups**. Then re-check the 706 in bounded batches — and only then decide whether name-splitting earns its place.

**Round 4 — country capture** across trip chips, day headers, and Discovery. Retire the D6 single-row country adoption (`discovery.js:122-131`), which infers identity from catalogue coincidence.

**Round 5 — delete the two empty-country destinations.**

Rounds 1–2 need no migration. Round 3's is additive and nullable. Round 5 is a data operation — take a `sqlite3 .backup` into the chee-owned `~/Trippy/backups/` first; prod `~/Trippy/data` is root-owned with no passwordless sudo.

**Verification.** `cd backend; npm test` plus new coverage for the cap-then-check lifecycle, CJK folding, and interactive-vs-background pacing (none exists today — the suites cover capping and checking independently). The pacing fix cannot be asserted from unit tests; it needs a measured local drain. Production QA is an owner click-script, per convention.

**Plan 24 compatibility.** One item has any adjacency to the closed deep-link decision: letting Discovery escalate past a weak OSM hit to Google. It must be a per-call opt-in scoped to discovery verification, exactly as `includeRatingFields` is (`placeResolver.js:470`). Changing `resolvePlace`'s shared default would alter stop and booking resolution and regress that decision.

---

## Provider cost

Round 1 **reduces** spend — AI output is currently bought and discarded before checking. Rounds 1–3 add no paid calls. Re-checking the 706 costs ~2 days of the existing allowance. The only increase is the Google escalation, bounded by its own separate small daily sub-budget so the ceiling is structural rather than assumed. Plan 7 §2.2 noted usage sits inside Google's monthly free allowance; a sub-budget keeps that true.

**Unresolved operational question:** real OSM request volume is unmeasured and materially higher than the lookup counter implies. If Round 3 shows sustained bulk volume, the choice between a paid endpoint and self-hosting becomes real — decide on measured numbers. Also verify `NOMINATIM_USER_AGENT` is set in production; the default (`config.js:47`) carries a placeholder contact, which does not meet the policy's identifying-contact requirement. Check that single variable only — **never run `printenv` unfiltered**, it prints the Google API key in cleartext.

---

## Decisions

**Settled by the owner, 2026-07-26:**

- **Trust wording** — keep "Unverified"; renaming buys nothing. The fix is moving the signal onto the browse card and separating the three internal states (checked-and-failed, not-yet-checked, shown-before-any-check).
- **Layer precedence** — do not touch `deriveDayGeo`. Use the additive layer-source signal with a Discovery-only guard.
- **Empty-country destinations** — delete 北京 and 南疆 outright. They were the owner's own CJK free-text test destinations, not real demand. Do not regenerate.
- **Google escalation** — proceed, provided cost is bounded by construction (separate sub-budget).
- **Near-match duplicates** — no moderation queue; there is no reviewer in a single-owner app. Remove exact-name duplicates only. For genuinely different things at one place (the three Lotus Pond entries), **keep them adjacent within their category** rather than deleting or flagging: ranking unchanged, group position set by its strongest member. A sorting rule in the existing pure ranking module — no new grouping model, no visual redesign, nothing auto-deleted for looking similar.

**Open:**

- **Does 45 stay the cap?** Recommended: defer until Round 1 lands. A correctly enforced cap behaves differently enough that choosing a number now is guesswork.
- **Restore progressive reveal on "Show more"?** Plan 7 §1.4 deliberately traded it for consistency — mid-generation results have no database row, ID, or status, and some are about to be dropped as duplicates, so streaming them would show places that were never saved. Recommended: restore it by saving each category as it completes and streaming the *saved* rows. Progressive reveal returns, and every card is a real row that can be reported and added on the trusted path — strictly better than the pre-Plan-7 behaviour.
- **Name-splitting (display vs. search name)?** Recommended: defer to Round 3 measurement.

---

## Out of scope

- Deep-link naming and resolver ordering — closed by owner decision 2026-07-26, precision over polish.
- Discovery panel UI/IA redesign.
- Plan 24 Appendix A (booking sync overwriting a user pin) — separate, already spun out.
- User-submitted entries, voting, reputation, moderation queues, or any social surface.
