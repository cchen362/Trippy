# Discovery Catalogue Quality Review — unverified suggestions, dedupe blind spot, and country capture

**Status:** FINDINGS ONLY — 2026-07-26. Nothing implemented, nothing decided. Investigation triggered by the Plan 24 owner production QA pass (see [Plan 24](../plans/Implementation%20Plan%2024%20Google%20Maps%20Deep%20Link%20Place%20Identity.md) Appendix B), where a Discovery-added stop opened coordinate-only and the owner recognised odd naming and apparent duplicates in Discovery suggestions.

**Scope boundary.** This reviews the **Discovery catalogue's data quality** — what gets generated, what gets verified, what gets served. It is **not** a Discovery redesign, and it does **not** revisit deep links: the owner decided 2026-07-26 that **precision beats polish**, so the Nominatim-first resolver ordering stays and Plan 24's behaviour is final. See "Explicitly out of scope" below.

**All figures measured read-only against production on 2026-07-25/26** (`docker exec trippy-trippy-1`, `/app/data/trippy.db`). They are inputs to any plan that follows — do not re-derive them.

---

## Production baseline

2,014 `discovery_places` across 11 `discovery_destinations` (~183/city), all generated in 2026-07.

| status | provenance | n |
|---|---|---|
| active | verified | 881 |
| active | **unverified** | **706** |
| active | pending | 11 |
| archived | verified | 336 |
| archived | unverified | 78 |
| suppressed | verified | 2 |

**User-visible (`status='active'`) = 1,598, of which 706 (44%) were never confirmed to exist.**

| destination | cc | active | verified | **unverified** |
|---|---|---|---|---|
| Taipei | TW | 298 | 158 | **140** |
| Shanghai | CN | 259 | 110 | **149** |
| kualalumpur | MY | 214 | 119 | **95** |
| Denpasar | ID | 148 | 128 | 20 |
| ChengDu | CN | 143 | 94 | **49** |
| Hangzhou | CN | 121 | 68 | **53** |
| Kaohsiung | TW | 96 | 68 | 28 |
| 南疆 | *(empty)* | 92 | **0** | **92** |
| Chong Qing | CN | 79 | 68 | 11 |
| Bali | ID | 78 | 68 | 10 |
| 北京 | *(empty)* | 70 | **0** | **70** |

---

## Findings

### F1 — Unverified suggestions are served to users with no signal (severity: HIGH)

`backend/src/db/discoveryCatalogue.js:82` selects on `status = 'active'` **with no `provenance` filter**. Verified and unverified rows are returned identically; the client has no way to distinguish them.

An unverified row means the resolver never confirmed the place exists: `provider_place_id`, `lat`, and `lng` are all NULL. **44% of what a user browses has never been checked against any geocoder.**

This is the trust question the owner raised. A suggestion that doesn't exist is a worse failure than a pin without a name — and it is the same trust argument that decided the Plan 24 precision-over-polish call.

**Not a bug, exactly** — it is an unstated product default. It needs an explicit decision (D1).

### F2 — Dedupe is identity-based, so it structurally cannot see the 44% (severity: HIGH)

The category-cap logic (`discoveryCatalogue.js:222-238`) archives the unverified tier before the verified tier, and among rows that *have* an identity it works perfectly: **881 active rows with a `provider_place_id` → 881 distinct places, zero duplicate slots.**

But identity is exactly what unverified rows lack. They cannot be grouped by `provider_place_id`, so **duplicate real-world places among the 706 are undetectable by the current mechanism.**

Confirmed live. Three *active* rows for the same Kaohsiung lake, all unverified, none deduplicated:

- `Lotus Pond`
- `Dragon and Tiger Pagodas (Lotus Pond)`
- `Zuoying Scenic Area (Lotus Pond Watershed) – Ecology Overview`

(The verified sibling `Zuoying Scenic Area (Lotus Pond Watershed)` carries `google:ChIJa9QbdXUFbjQRH2EPZEFWJKs`.)

This validates the owner's observation of "seemingly duplicated suggestions for the same place." An earlier measurement in the QA session reported zero duplication; that measurement only covered identified rows and understated the problem. **Any dedupe that runs pre-verification must key on normalized/fuzzy name, not `provider_place_id`.**

### F3 — The display name is also the geocoder query (severity: HIGH — likely root cause of much of F1)

`backend/src/services/discoveryVerify.js:184` calls `budgetedResolve({ queryText: row.name, … })`, falling back to `row.local_name` at L188. **`name` does double duty: card headline and geocoder input.**

Generation emits descriptive qualifiers into `name`. Real active-unverified samples:

```
Chuan Wei Small Eat (Xinyi)
Jianguo Jade and Flower Market (weekends only)
M50 Creative Park (Textile factory typology)
Pomegranate and Mulberry Seasonal Wellness (summer-autumn)
Muddy's Cafe Quiet Morning Work Space
```

These are **real places wrapped in editorial framing**, not hallucinations — the sample also contains plainly real entries (`Jing'an Temple`, `Nanxiang Steamed Bun Restaurant`, `Jade Buddha Temple Art Museum`) that simply were not verified. The qualifier that makes a card readable is the same string that makes geocoding fail.

**Hypothesis to test in the dive** (not yet proven): stripping parenthetical/qualifier text, or splitting `name` (display) from a `search_name` (query), would convert a large share of the 706 into verified rows at **no additional per-call cost** — the resolver call already happens, it just currently asks a bad question.

### F4 — Free-text destination search yields an empty `country_code`, permanently (severity: MEDIUM)

Confirmed mechanism, answering the owner's question directly: **it is the free-text path, not the language.**

`frontend/src/components/discovery/DiscoveryPanel.jsx:376-378` — the manual "Go" search box has no country field, so a manually committed search **always clears** the committed country ("free-text search shouldn't force a country match"). `backend/src/routes/discovery.js:87` then sets `normalizedCountryCode = ''`.

There is a recovery path (D6, Plan 9 W5.1) at `discovery.js:112-125`: an empty-`countryCode` request adopts the country of existing rows **only if exactly one country-coded row already exists**. For a brand-new destination there is nothing to adopt, so the destination is created with `country_code = ''` and keeps it.

Non-English names are *correlated* but not causal — you reach for the free-text box when the picker has no entry for 北京 or 南疆. Language matters separately and downstream: geocoding a CJK name with no region bias is harder, and `searchGooglePlaces` only sets `body.regionCode` when the code matches `/^[A-Z]{2}$/` (`placeResolver.js:480`), so an empty country also strips region biasing from the provider call.

### F5 — 北京 and 南疆 are 162 permanently unverifiable active suggestions (severity: MEDIUM)

Both have `country_code = ''`, `generation_count = 1`, `last_generated_at = 2026-07-05` — the two oldest destinations, and the only two with an empty country. **0 of 162 active suggestions verified.**

`discoveryCatalogue.js:74` looks destinations up with `country_code != ''`, so these rows are likely unreachable by the normal lookup path while still occupying 10% of the served catalogue.

The owner's read — "generated way back, cleanup necessary" — is consistent with the dates. Whether they are stale-by-age, blocked by F4, or predate the verification pipeline entirely is **not yet determined** and should be settled before choosing between cleanup, backfill, and regeneration.

### F6 — The resolver budget is not the constraint (severity: LOW — rules out a tempting explanation)

`DISCOVERY_RESOLVER_DAILY_BUDGET` defaults to 500 (`config.js:55`). Peak observed daily verification was **421** (2026-07-07); every other day was 39–143. **The cap was never hit on any observed day**, so "budget exhaustion" does not explain the 44%.

Do not assume the budget is the cause. The drain loop's actual firing behaviour is unexamined.

---

## Decisions the owner must make before any implementation

- **D1 — Should unverified suggestions be served at all?** (a) hide them entirely; (b) serve with a visible "unconfirmed" affordance; (c) keep as-is. Everything else depends on this. Note (a) removes 44% of the catalogue overnight, including plainly real places, so it is not obviously the safe option.
- **D2 — Split `name` into display vs. search?** Additive schema change. Highest suspected yield per unit of work (F3), and it costs no extra API calls.
- **D3 — Add pre-verification dedupe on normalized name?** Directly addresses F2 and the owner's original observation.
- **D4 — What happens to 北京 / 南疆?** Delete, regenerate with a proper country, or leave dormant — decide only after F5's cause is established.
- **D5 — Should free-text search attempt country inference?** Backfilling a country for a typed destination conflicts with the deliberate "don't force a country match" behaviour at `DiscoveryPanel.jsx:376`. Any change must not regress that intent.

## Explicitly out of scope

- **Deep-link naming / resolver ordering.** Closed by owner decision 2026-07-26: precision over polish. Nominatim-first stays.
- **Discovery panel UI/IA redesign.** The pipeline shape looks sound; this is a data-quality review.
- **Plan 24 Appendix A (booking sync overwrites a user pin).** Separate, already spun out.
- **Generation model or prompt-cache changes**, unless D2 forces a prompt change.

## Verification notes for whoever picks this up

Read production read-only by heredoc-ing a `.mjs` to `/tmp`, `docker cp`-ing it in, and running it — import dependencies with `createRequire('/app/backend/')`, since a script in `/tmp` cannot resolve `better-sqlite3` by bare specifier. Nested PowerShell→ssh→bash→`node -e` mangles SQL string literals into column identifiers.

**Never run `docker exec trippy-trippy-1 printenv` unfiltered** — it prints `GOOGLE_PLACES_API_KEY` in cleartext. Read `config.js` defaults or evaluate a boolean instead.
