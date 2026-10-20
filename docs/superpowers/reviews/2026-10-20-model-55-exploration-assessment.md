# Model 5.5 — product exploration assessment: the living dossier

**Status: standalone discovery assessment, 2026-10-20 (Asia/Singapore). Nothing in it is implemented, planned, scheduled or authorized, and no paid call was made to write it.** Written against `main` at `c97b361` (the Plan 35 W0 commit), the deployed 5.5 profiles in `MODEL_PROFILES` (`backend/src/services/claude.js`), the measured results recorded in Plan 30 and Plan 34, [`docs/ENGINEERING.md`](../../ENGINEERING.md), [`docs/DECISIONS.md`](../../DECISIONS.md), the [living design spec](../specs/2026-04-23-trippy-design.md) and the [opportunity exploration brief](2026-10-18-model-55-opportunity-exploration-brief.md). It answers the brief. It does not reassess or replan the migration (Plan 30 is closed) and it does not draft a feature plan. Provider facts come from the `claude-api` reference bundled with Claude Code 2.1.299 and are flagged where they must be re-checked against official documentation before anything depends on them. Live code and `docs/ENGINEERING.md` take precedence if this document drifts.

**Owner rulings, 2026-10-20 (same day, after review).** R-1 ruled: bounded background compute is allowed; notifications and provider polling stay excluded. O-1 ruled: intake must not be designed around one phone platform; iOS and Android are served from the start, a platform-neutral channel (a token-authenticated `POST /api/inbox`, usable from an iOS Shortcut, an Android automation or a desktop) comes before any platform-specific one, and the PWA share target is additive. O-2 ruled: inbound email through the production zone is acceptable, staged last. O-3 ruled: Conditions + Due alone is worth shipping if the ledger disappoints, to be reviewed as the work proceeds. O-4 ruled: the Part A and Part B experiment is approved, harness-only, under $10, on the production export copy. O-5 ruled: ideas (C3) come after the first programme. **R-2 and R-3 were ruled later the same day, both yes**: MCP-uploaded documents are read for facts in the same deferred job as every other channel (the MCP tool itself never waits on or pays for a model call), and a booking-change proposal kind limited to field changes on an existing booking is added in Phase 3. Nothing is implemented; Implementation Plan 36 (W0 = the approved experiment; product scope P1) is the follow-on. The cross-tool record is `docs/DECISIONS.md`, "Living dossier direction".

**How to read it.** §0 is the answer in plain language. §1 is the grounding (what exists, what the owner's own evidence says, what the models changed). §2 is the field of candidates, including four that are not in the brief. §3 compares them and picks one. §4 describes the chosen experience end to end. §5 lists every settled decision it touches. §6 is the experiment that could disprove it. §7 answers the brief's architecture questions. §8 says what happens next.

---

## 0. Bottom line, in plain language

**The flagship is the dossier that keeps itself current, reads everything you give it, and tells you what has to be true.** Working name: *the living dossier*. The traveller feels three things:

1. **Anything goes in with one gesture.** A Trip.com confirmation, a "your flight time has changed" notice, a hotel's PDF, a saved post, a receipt: share it to Trippy from the phone and it lands in the right trip, as the right thing: a new booking to confirm, a change to an existing booking to approve, a document on a booking, an idea, or simply kept. Nothing is applied silently.
2. **Trippy reads the whole document, not just the booking line.** Every confirmation carries conditions the traveller rereads the night before: check-in windows, free-cancellation deadlines, baggage allowances, "bring the card you paid with", "the key code is emailed two days before", pickup points, platform numbers. Trippy extracts each one as a fact with the exact quote and the page it came from, shows it on the booking as **Conditions**, and lines the deadlines up as **Due**.
3. **"Does it hold?"** Trippy checks the whole trip against those facts and the plan and answers in three kinds of line: **holds** (with the sources), **conflicts** (two sources disagree, or a source disagrees with the plan), and **open questions** (what Trippy cannot know from your documents, stated as a question). Today surfaces the conditions that apply now; a delayed flight re-evaluates everything downstream; the co-pilot can finally answer from the documents instead of from the booking skeleton.

**A concrete example.** Your Tokyo hotel's forwarding desk sends luggage to Kyoto "for next-day delivery when dropped by 11:00", and opens at 08:30. Your plan leaves the hotel at 07:40 for the 08:10 train to Hakone. Nobody notices until the morning. Trippy, having read the hotel's sheet and the plan, says: *send the bag on day 3 (it reaches Kyoto a day before you) or carry it to Hakone*, and cites page 2.

**Why this and not the others.** It attacks the owner's own diagnosis of why Trippy went unused on the ground (Plan 3: *a mirror that must be maintained by hand*, while the trip lived in Trip.com, Xiaohongshu and AMap). Its evidence is already in Trippy's hands, the traveller's private documents, so nothing depends on websites that block bots or on sources that are not on the web. Its value is the kind the brief asks for, *a previously unnoticed connection or decision*, and it can be demonstrated on the owner's real past trips before any intake channel is built. Every seed in the brief either becomes a later phase on this foundation (rehearsal, research, saved fragments) or is rejected for a stated reason (taste, group priorities, camera).

**What the models contribute, honestly.** Mostly economics and reliability, not impossibility. Haiku 5.5 at a tenth of Haiku 4.5's price makes reading every document in full, and re-reading it on every change, cost a fraction of a cent. Sonnet 5.5 at a third less than Sonnet 4.6 makes a whole-trip check at high effort cost cents. Structured outputs, measured in Plan 34, make a fact table reliable enough to persist. Sonnet 5.5's higher-resolution vision is a *hypothesis* for dense phone screenshots that the experiment tests rather than assumes. New API mechanisms (mid-conversation system messages, per-message effort, browser use) are options for the integration, not foundations. Nothing here was impossible on 4.x. The product choice was never made.

**The leading unresolved risk is trust.** A wrong deadline is worse than no deadline. If the owner still has to open the PDF to believe a line, the product reduces to a nicer document index.

**The experiment.** Run fact extraction and the readiness check over the owner's real trips' documents, as if the night before departure, and have the owner grade every line. The direction is **disproven** if fewer than half of the document-rich trips yield at least one new, true, action-changing line, or if more than one line in ten is false, or if deadline and time facts are wrong more than 3 % of the time on a hand-checked sample. Cost under $10 of paid calls on the production export copy; no production mutation.

**What is asked of the owner.** Read; rule on the three reopenings the flagship needs (§5: background compute without notifications, facts from MCP-uploaded documents, booking-change proposals); approve the experiment's spend and its use of the export copy; then, if the retrospective passes, ask for the numbered plan.

---

## 1. Grounding

### 1.1 What Trippy can do today

Facts from code at `c97b361`; `docs/ENGINEERING.md` has the architecture. This is the part that matters for what follows.

- **Capture.** `POST /api/trips/:id/imports` takes up to four files or a text paste (image ≤ 5 MB, PDF ≤ 10 MB, text ≤ 100 KB), stores them as `import_artifacts` + `import_artifact_files` (BLOB, `content_hash`), and runs **booking extraction** on Sonnet 5.5 under an API-enforced schema (D-34-1). The schema captures the booking *skeleton*: type, title, confirmation reference, source, start/end local datetimes, origin/destination, terminal or station, time zones, sixteen detail strings (cities, carrier, flight or train number, stations, seat class, address, local name, note), confidence, assumptions. **Nothing else in the document is read.** PDFs go to the model as base64 document blocks (`claude.js:569`); there is no server-side PDF text extraction.
- **Documents.** A booking holds up to four manual attachments (`booking_attachments`, migrations 012 and 035, with `content_hash` and `source` manual or MCP) plus the import files it came from. `DocumentViewer.jsx` shows an image or a PDF full-screen on a near-white pane so a QR stays scannable; it is reachable from the Today hero's **Ticket** button and from Logistics cards, and the files are `CacheFirst` so tickets open offline.
- **Today.** Clock-derived, 60 s tick: a hero (next timed booking or stop) with Navigate and Ticket, upcoming rows, a Tonight hotel card, and a flight-status pill fetched from AeroDataBox only when tapped (10-minute client cache). No check-offs, no notifications.
- **Co-pilot.** Sonnet 5.5 at `low`, SSE, three tools: `search_discovery_catalogue`, `check_trip_health`, `propose_itinerary_changes` (four stop operations; booking-linked stops refused, Plan 11 D6; one atomic apply guarded by a trip fingerprint). Its system block serializes the trip as title, dates, travellers, pace, tags, destinations, days with stops `{id, title, type, time, note, bookingLinked}`, and bookings as `{id, type, title, confirmationRef, start, end, origin, destination}`. **Coordinates, photos, `details_json`, attachments and expenses are not in it** (`copilotTools.js`). Per-message UI context (`context_json`, migration 029) names the tab, day, stop or discovery card being viewed.
- **Trip health.** Five deterministic checks in `tripHealth.js` (activity outside the trip's range, two stops at the same clock time, a night with no hotel, an unresolved location, a booking-linked stop whose time drifted from its booking). Reachable only as a co-pilot tool; no REST route, no UI.
- **Intake.** A file picker and drag-and-drop. The PWA manifest has no `share_target` (`frontend/vite.config.js`); there is no email, SMS, push or geolocation code anywhere.
- **MCP.** Seven tools behind personal tokens; writes go through 30-minute drafts; documents arrive by upload ticket; **no model call on any MCP path** (a recorded cost boundary).
- **Providers.** Anthropic, Unsplash, Google Places, Nominatim, AeroDataBox (optional), a currency API, tile servers. No routing, weather or travel-time provider.

### 1.2 What the owner's own evidence says

Three recorded findings matter more than any model property.

- **Plan 3's diagnosis (2026-07-04).** Trippy went unused during the owner's last trip because *"every surface is an editing tool for planning; none serves the moments that matter on the ground"*. The trip lived in Xiaohongshu (attractions), Trip.com (bookings with live status) and AMap (navigation), *"three tools that share one property: they never fall out of date. Trippy is a mirror that must be maintained by hand, and a mirror that falls behind reality once loses trust permanently."* Plan 3 built Today, the document vault and offline reads in response. It did not change how material reaches the mirror.
- **The price-search ruling (2026-09-30, `docs/DECISIONS.md`).** The owner declined hotel and flight price search, and recorded that it *"does not touch the gap Plan 3 found"*. The gap is still named as current.
- **The co-pilot context review (2026-07-13).** Retrieval tools should be added *"only if evidence supports it"*, and its open question 8 asks whether they are necessary at all. The whole-trip block is simple and works because the trip skeleton is small. Documents are not small.

And two measured facts from the migration: extraction on Sonnet 5.5 produced 0 critical errors on 23 fixtures (Plan 30 W4), and the structured-output contract lifted usable flight numbers from 6/21 to 21/21 (Plan 34 W1). Reliability of *structured reading of the traveller's own documents* is the one thing Trippy has actually measured at 5.5, and it is the thing the flagship stands on.

### 1.3 What the 5.5 models change, classified

The brief asks for four classes: a genuinely new API capability; an existing capability now reliable enough; improved economics; already feasible, mainly a product choice. Prices are list prices from the bundled reference; re-check before budgeting.

| Change | Before (Sonnet 4.6 / Haiku 4.5) | Now (Sonnet 5.5 / Haiku 5.5) | Class | Bearing on this assessment |
|---|---|---|---|---|
| Haiku price | $1 / $5 per MTok | $0.10 / $0.50 (prompt ≤ 100K; $0.50 / $2.50 above) | Economics, 10× | Reading every document in full, and again on every change, costs well under a cent each |
| Haiku context and output | 200K / 64K | 1M / 128K | New capacity | A whole trip's documents fit one call; not needed for the flagship's design, useful for cross-document dedupe |
| Haiku effort and adaptive thinking | manual `budget_tokens` only | `effort` low–max, adaptive | Newly viable | Cheap per-document judgment ("which booking does this belong to?") |
| Haiku instruction following and sub-agent use | — | vendor claim; Plan 30 discovery results (8/8 categories, about a tenth of the cost per place) corroborate | Newly reliable | "Quote verbatim, never paraphrase" must be obeyed for provenance to mean anything |
| Sonnet price | $3 / $15 | $2 / $10 | Economics | A whole-trip check at `high` effort costs cents |
| Sonnet vision resolution | 1568 px long edge | 2576 px (since Sonnet 5), up to about 3× image tokens at the limit | Existing capability, higher fidelity | A **hypothesis** for dense CJK phone screenshots; tested in §6 B1, not assumed |
| Structured outputs (`output_config.format`) | available | same; measured in Plan 34 | Already feasible; reliability now measured | A persisted fact table needs the contract; D-34-5's schema budget constrains its shape |
| Mid-conversation system messages | not on Sonnet 4.6 or Sonnet 5 | yes, no beta, on Sonnet 5.5 and Haiku 5.5 | New API capability | An option for "documents changed since your last turn" notices without touching the cached trip block |
| Per-message effort | no | beta | New | An option for a high-effort step inside a low-effort conversation; the flagship avoids needing it |
| Web search and web fetch (server tools) | available since 2025; `_20260209` dynamic filtering on 4.6+ | same on Sonnet 5.5; Haiku 5.5's exact variant to re-check | Already feasible; never wired in Trippy | Phase 4 only (research of open questions); about $10 per 1,000 searches at list |
| Browser use toolset | not on Haiku 4.5; Sonnet 4.6 not verified here | Sonnet 5.5 and Haiku 5.5 on the Claude API (re-check) | New API capability | Needs an application-operated browser environment; not a foundation for anything here |
| Citations on PDF document blocks | available | same; incompatible with `output_config.format` | Already feasible; never wired | One of two provenance mechanisms considered in §4.4 |
| Safety classifiers | none on Haiku 4.5 | refusal categories on both; Plan 34 met `reasoning_extraction` | New constraint | Every new workload branches on `stop_reason` (D-30-3) and keeps rule 10's "do not explain your reasoning in prose" |
| Preserved thinking (append-only history) | n/a | enforced on new accounts | New constraint | Any new multi-step harness is append-only from day one |

### 1.4 What an upgrade does not supply

The brief's warning stands and is sharpened by the inventory: a model swap supplies no evidence, no tools and no product state. In Trippy's terms the missing pieces are specific. No web tool is wired. No document is read beyond its booking line. No intake exists but a file picker. No travel-time provider exists, and the spec excludes one. The co-pilot cannot see `details_json` or a document. Every candidate below is judged on how much of that it needs.

---

## 2. The field

Eleven candidates: the brief's six seeds (C2–C7) and five of our own (C1, C8–C11), of which C8–C11 are absent from the brief. Each is treated against the brief's eight points, compactly; the flagship gets §4 in full. "Model" is given in the classes of §1.3.

### C1 — The living dossier (flagship; §4)

Inbox + conditions + readiness ledger, from the traveller's own documents. One line each here, the rest in §4. *Situation:* every confirmation is reread the night before and the connections between them are found by luck. *Why it matters:* it removes a chore every traveller does and finds the conflicts luck misses. *Model:* economics and reliability; vision is a hypothesis. *Evidence:* in hand, private, exact. *Architecture:* an evidence model, two new workloads, intake channels, three surfaces. *Hardest failure:* a confidently wrong deadline. *Effort:* a programme of three or four plans. *Falsifier:* §6.

### C2 — Rehearse a trip before committing (seed A)

*Situation and experience.* Before booking the last pieces, the traveller asks for two or three coherent versions of the same week around the fixed bookings, changes one assumption (a late arrival, a companion skipping the museum) and sees what each version gains, gives up and depends on. *Why it matters.* The interesting output is a dependency the traveller had not seen; the brief itself warns that three differently worded itineraries are worthless. *Model.* Pure reasoning; nothing new at 5.5 beyond cost. *Evidence and integration.* The dependencies ("depends on the 08:10 train", "depends on the pass being valid both days") are exactly the facts C1 extracts; without them the model invents them. Travel time is excluded from the product (spec §2.3) and no provider exists, so "feasible" claims are unfounded. *Architecture.* An alternatives object (a draft plan that is not the plan) and a comparison surface; the proposal protocol applies one unit, not a whole alternative. *Hardest failure.* Confident feasibility claims about times and distances the model cannot know; the traveller pays on the day. *Effort and cost.* Large (a second plan model); cents per rehearsal. *Experiment and falsifier.* Generate alternatives for a real past trip; the owner marks each stated dependency as real or invented. Disproven if invented dependencies are common or no alternative surfaces a dependency the owner missed. **Verdict:** valuable later, only on top of C1's facts; not a starting point.

### C3 — Saved fragments as raw material (seed B)

*Situation and experience.* The owner's attractions live in Xiaohongshu bookmarks. Screenshots of saved posts, menus and friends' recommendations go into the trip; Trippy keeps the source, extracts place candidates (name, local name, district, the poster's tip), resolves them, dedupes against the plan and catalogue, and shows "your saved ideas" as a personal layer that the co-pilot can compose into an afternoon near a free evening. *Why it matters.* It is the half of Plan 3's diagnosis that C1 does not reach: the ideas, not the bookings. *Model.* Sonnet 5.5's higher-resolution vision (hypothesis) on dense CJK posts; Haiku 5.5's price for per-screenshot triage. *Evidence and integration.* The material exists on the owner's phone, not in Trippy; intent is uncertain (saved is not decided); a post rarely carries a precise location. **Mainland-China resolution is unsolved:** Nominatim coverage of Chinese POIs is thin, Google is unreliable there, Amap's API is explicitly out of scope today, and the resolver strategy is CLOSED ("no resolver change"). *Architecture.* An idea object distinct from a stop and from the catalogue; Plan 12 G1 (new places only from the catalogue) would need extending to user-provided grounded sources. *Hardest failure.* A saved idea pinned to the wrong place in a city where the map provider is already a compromise; the traveller walks to the wrong address. *Effort and cost.* Medium for intake (shared with C1), large for China resolution; cents per fragment. *Experiment and falsifier.* Thirty of the owner's real saved screenshots; count correct name + district extraction and correct resolution. Disproven if resolution in mainland China stays under about 70 % without a new provider. **Verdict:** the intake half is C1's inbox pointed at ideas and ships with it; the composition half is Phase 5, gated on a resolver ruling.

### C4 — Investigate whether the trip is ready (seed C)

*Situation and experience.* "Does my 23:40 arrival still make the last airport train, and does the hotel take check-ins after midnight?" Trippy researches it and returns a dated, cited answer, an alternative, or a specific unanswered question. *Why it matters.* Research the traveller no longer performs; the brief's own framing. *Model.* Server-side web search and fetch (already existed; never wired), Sonnet 5.5's more reliable tool use, the vendor's "give the model today's date" guidance; browser use for pages search cannot read. *Evidence and integration.* The weak link. Official sources in East Asia are often not in English, not indexable, or behind bot walls; the 2026-09-30 probe recorded Booking.com and Expedia refusing, Tripadvisor blocking after eight requests. Opening hours change; a dated answer ages. Current training knowledge cannot establish current access facts (the brief says so and it is right). *Architecture.* A research workload with `allowed_domains`, dated findings as first-class objects, never auto-promoted to facts. *Hardest failure.* A confident, cited, stale answer about a closure or a timetable; the traveller plans a day around it. *Effort and cost.* Medium; about $0.15–0.25 per question at list. *Experiment and falsifier.* Twenty real open questions from the owner's past trips; grade answers against ground truth the owner knows. Disproven if fewer than two-thirds are correct and dated, or if the model answers from training when it should have searched. **Verdict:** it loses as a *starting point* because the question set is unbounded and the evidence is unreliable; it wins as Phase 4, where the ledger has already narrowed research to specific, checkable open questions.

### C5 — Learn taste through meaningful choices (seed D)

*Situation.* Compare two afternoons, say why one appeals, and let later suggestions reflect it. *Why it matters.* Less than it sounds; the owner's circle takes a few trips a year, so the signal is thin and the risk of inventing a personality from one trip is high. *Model.* Little; any model can ask "which and why". *Evidence.* Expressed preference only; inference from so few choices is guesswork. *Architecture.* A preferences object with provenance (expressed vs inferred) and expiry. *Hardest failure.* Trippy quietly stops showing a category because of one afternoon. *Effort.* Small to build, impossible to validate in under a year. *Falsifier.* Cannot be run in a useful time. **Verdict:** rejected as a flagship. The cheap, honest version, explicit preferences as user-stated facts with a source and a date, is subsumed by C1's user-asserted facts.

### C6 — Design around disagreement in a group (seed E)

*Situation.* Each traveller states priorities, optionally privately; Trippy proposes shared anchors, separate mornings and reunion points. *Why it matters.* Real for group trips, and Trippy already has collaborators and a shared co-pilot thread. *Model.* Synthesis; nothing 5.5-specific. *Evidence.* Needs several real people's private inputs; the collaboration model is asynchronous and editor-only (no viewer role, no invitations by email). *Architecture.* Private-to-Trippy inputs, a compromise surface, and a privacy rule for what a proposal may reveal. *Hardest failure.* A private preference exposed, or a "consensus" nobody holds. *Effort.* Medium. *Falsifier.* Needs a real group on a real trip; cannot be demonstrated by one person. **Verdict:** rejected as a flagship; its mechanism (questions answered by named people) can reuse C1's open questions later.

### C7 — Connect what the traveller sees to what the trip requires (seed F)

*Situation.* Photograph a station board, a sign, a ticket; Trippy links it to the booking and says the next step. *Why it matters.* The on-the-ground moments Plan 3 named; but each is narrow. *Model.* Vision; higher resolution helps dense boards (hypothesis). *Evidence.* The physical world at the moment of the photo; the brief's caution stands: visual plausibility is not navigation evidence. *Architecture.* A camera intake and a comparison against a known fact ("the board says platform 14; your e-ticket says 14"). *Hardest failure.* A misread board sends the traveller to the wrong platform. *Effort.* Small once C1's facts exist; medium without. *Falsifier.* Only a field test. **Verdict:** rejected as a flagship; a natural small extension of C1 (a photo is a dated, user-sourced fact compared against a document fact).

### C8 — Trippy as the system of record for the owner's other AIs (ours)

*Situation.* Instead of building research into Trippy, let the owner's Claude app (which already carries trivago, Kiwi and web search as connectors, per the 2026-09-30 note) do the thinking, and let Trippy be the memory and validator: MCP exposes the plan, the bookings and (once they exist) the facts; drafts bring results back. *Why it matters.* It uses tools the owner already pays for, keeps paid model calls off Trippy's bill, and respects "no model call on the MCP path". *Model.* None inside Trippy. *Evidence.* The private documents would have to leave Trippy for the external client to reason over them; attachments are not exposed today. *Architecture.* OAuth (D-28-1 says: reopen only if a connector-only client becomes wanted), a `get_trip` that returns facts, and nothing in the product itself. *Hardest failure.* The experience is composed outside Trippy; the dossier stays a mirror. *Effort.* Medium (OAuth is real work). *Falsifier.* Would the owner actually plan in Claude.ai and push into Trippy? Only a trial can say. **Verdict:** loses as a flagship because it is not a Trippy experience and it moves the evidence out of the product; kept as a cheap adjunct once facts exist (expose them read-only through `get_trip`).

### C9 — The morning page (ours)

*Situation.* On each day of a live trip, one prepared screen is waiting when Today opens: the day's shape, the conditions that apply today ("check-in until 24:00", "pickup 07:30 at the east entrance"), the transitions, the open questions, tonight's stay. Prepared overnight, never pushed. *Why it matters.* It is the in-trip moment Plan 3 named, made of facts rather than of what the traveller typed. *Model.* Composition on Haiku 5.5 (cheap), or deterministic selection from facts by date (no model at all, and the better first answer). *Evidence.* Needs C1's facts; without them it can only restate the plan. *Architecture.* A date-scoped selection over facts and a Today section. *Hardest failure.* A stale page on a changed day; mitigated by the ledger's fingerprint. *Effort.* Small on top of C1. **Verdict:** not a separate flagship; it is C1's in-trip surface and is folded into §4.

### C10 — Replan from here (ours)

*Situation.* The flight is delayed three hours. Trippy re-evaluates every downstream dependency from the facts (the timed ticket's entry window, the hotel's check-in cutoff, the pickup) and shows which still hold, which break, and which it cannot know; the co-pilot proposes the changes it is allowed to make. *Why it matters.* The connection the traveller did not notice, at the moment it costs the most. *Model.* Reasoning over facts; nothing 5.5-specific beyond cost. *Evidence.* C1's facts plus a status the traveller fetched (AeroDataBox, on demand) or asserted. *Architecture.* A user-asserted fact ("arrival now 18:20, from the airline at 12:05") that re-runs the ledger, and a booking-change proposal kind the protocol lacks today (bookings and booking-linked stops are untouchable by proposals). *Hardest failure.* A re-plan that quietly moves something the traveller had already handled by phone; mitigated by acknowledgements as user facts. *Effort.* Small on top of C1. **Verdict:** folded into §4 as the live-trip half of the flagship.

### C11 — Decisions from the group chat (ours)

*Situation.* Export the trip's WhatsApp or WeChat thread; Trippy finds the decisions ("night market Tuesday", "skip the aquarium") and proposes them. *Why it matters.* Decision history as a first-class object, which the brief's §5 asks about. *Evidence.* A private group conversation that is not Trippy's to read; consent from everyone in it; WeChat export is impractical. *Hardest failure.* A joke taken as a decision; a private aside stored. **Verdict:** rejected; the decision-history object is better served by C1's acknowledgements and user-asserted facts, which are explicit.

---

## 3. Comparison and selection

Reasoned judgments, not scores, on the brief's six criteria.

| | Traveller value | Differentiation | Evidence available | Model contribution | Operating economics | Can we demonstrate it? |
|---|---|---|---|---|---|---|
| **C1 living dossier** | High on any logistics-heavy trip; compounds with every document | High: cross-document conditions with quotes exist nowhere else | **Already in Trippy**, private, exact | Economics and reliability; vision is a hypothesis | Cents per trip | **Yes, on real past trips, before building intake** |
| C2 rehearsal | Medium; degrades to wording without dependencies | Medium | Weak: needs facts and travel time | Reasoning only | Cents | Subjective; depends on C1 |
| C3 fragments | High for the owner's actual habit | High | On the phone, not in Trippy; China resolution unsolved | Vision hypothesis, cheap triage | Cents | Needs a corpus and a resolver ruling |
| C4 readiness research | High when right | Medium (Claude.ai does it ad hoc) | **Weak**: bot walls, non-English sources, ageing | Web tools, tool reliability | $0.15–0.25 per question | Noisy; false answers hard to catch |
| C5 taste | Low (few trips a year) | Low | Thin | Little | — | Not within a year |
| C6 group | Medium | Medium | Several people's private inputs | Synthesis | — | Needs a real group |
| C7 camera | Medium, moment-bound | Medium | The physical world, now | Vision | — | Field test only |
| C8 record for other AIs | Medium, owner-specific | Low for Trippy | Would have to leave Trippy | None inside Trippy | — | Trial only |
| C9 morning page | Medium–high in trip | Medium | Needs facts | Little | Cents | In trip only |
| C10 replan from here | High at the moment it matters | High | Needs facts and a status | Reasoning | Cents | Simulated delays on past trips |
| C11 chat decisions | Low–medium | Medium | Not Trippy's to read | Extraction | — | Not without consent |

**Selection: C1, with C9 and C10 folded in as its in-trip surfaces.** The deciding criterion is the third column. C1 is the only candidate whose evidence is already inside the product, exact, private and dated, which means its hardest failure mode (a wrong fact) can be *measured* on real material before anything ships, and its value (a found connection) can be *shown* to the owner on their own trips. Every other high-value candidate either needs C1's facts first (C2, C7, C9, C10), needs evidence Trippy cannot reliably obtain (C4, C3 in mainland China), or cannot be demonstrated by one person in a useful time (C5, C6).

**Why the strongest rivals lose, specifically.**

- **C3 (fragments)** is the best alternative and the closest to the owner's behaviour. It loses on sequencing, not on worth: its intake is C1's inbox pointed at ideas (shared machinery), and its payoff needs a place-resolution capability for mainland China that a CLOSED ruling currently forbids. Building it first would spend the programme's first months on a resolver argument rather than on a demonstrable traveller outcome. It is Phase 5.
- **C4 (research)** loses because an unbounded research product stands on sources Trippy has already found hostile, and because a confident stale answer is the worst thing a travel companion can say. Narrowed to the ledger's open questions, with dated citations that never become facts by themselves, it is Phase 4 and its risk is contained.
- **C2 (rehearsal)** loses because without a dependency model it produces exactly the three wordings the brief warns against, and with one it is a later feature of the same model.
- **C8** loses because it is an architecture for leaving Trippy, not for improving it.

**The leading unresolved risk.** Trust in a line without opening the document. If the retrospective in §6 shows deadline or time facts wrong more than a few times in a hundred, or ledger lines false more than one in ten, the owner will verify every line by hand and the product is a document index with extra steps. A secondary risk is rarity: most trips may hold, so the "found connection" shows up only now and then; the Conditions and Due surfaces have to be worth having on a trip where nothing conflicts, and the owner should decide now whether they are (§8, O-3).

---

## 4. The flagship in full: the living dossier

### 4.1 The experience, and the contract

Three surfaces inside the existing four-slot navigation; no fifth tab.

- **Inbox** (reached from Logistics and from the trip's top bar). Where things arrive. Each item shows what Trippy thinks it is and where it belongs: *new booking* (opens the existing capture review), *change to a booking* (shows the before/after and asks to apply), *document for a booking* (attaches), *idea* (kept with the trip; Phase 5 makes it a candidate place), *expense* (Phase 5), *kept* (nothing to do). One tap confirms; nothing lands silently.
- **Conditions** and **Due** (in Logistics). Each booking card gains a quiet Conditions section: facts in DM Mono labels (CHECK-IN, CANCEL BY, BRING, ALLOWANCE, PICKUP, CONTACT) with the quoted sentence in Cormorant and a source tap ("p.2 · read from PDF", or "read from image") that opens the document viewer at the page. Due is a bare line per deadline across the trip, ordered by date, with the same countdown treatment Trips Home uses, and the single gold accent on the next one.
- **Does it hold?** (a Logistics action and a co-pilot quick action). The readiness ledger: **Holds** (muted lines, each with its sources), **Conflicts** (the one place gold is allowed, each line citing both sides), **Open questions** (a question, what would answer it, and two ways to answer: type it, which becomes a user-sourced fact, or share a document). Each line can be acknowledged with a note ("called the inn, they will hold dinner"), which is itself a dated fact with the traveller as source. The ledger carries the fingerprint of the facts, bookings and plan it was computed from and is marked stale, never silently rerun, when any of them change.
- **Today** reads the facts by date: tonight's check-in window under the Tonight card, tomorrow's pickup time and meeting point under "Tomorrow starts at", and a **Re-check from here** action when a flight status comes back late.

**What Trippy says, and never says.** It states only what a source says, and shows the source. It shows the time zone a time was read in, and says when none was stated. It dates every fact to its document and every ledger to its fingerprint. It states what it cannot know as a question. It never computes travel time (Phases 1–3), never treats the discovery catalogue's model-authored opening hours as a fact, never pushes a notification, never polls a provider, and never applies a change to a booking or the plan without the traveller's tap.

### 4.2 A day in the life

Eight nights in Japan in late November, two travellers, flying from Singapore on a budget airline. The documents are the usual pile: the airline's itinerary PDF, three hotel confirmations (a Tokyo hotel, an inn in Hakone, a townhouse in Kyoto), two train e-tickets, a timed-entry museum ticket, a two-day transport pass, and the Tokyo hotel's luggage-forwarding sheet, photographed at the desk on a previous stay.

**Three weeks out.** You share each confirmation to Trippy as it arrives: from the airline's app, from the booking site, from the inn's email. The bookings you already know show up in Logistics as today. What is new is underneath each card. The Tokyo hotel: *check-in from 15:00, check-out by 11:00*; *luggage forwarding desk 08:30–11:00, next-day delivery when dropped by 11:00* (p.2 of the forwarding sheet, read from image). The airline: *online check-in opens 48 h before departure*; *cabin 7 kg*; *checked baggage 20 kg, outbound segment only* (p.2). The Kyoto townhouse: *free cancellation until 14 November*; *check-in 15:00–18:00*; *the key box code is sent by email two days before arrival*; *check-out by 10:00, earlier on request*. The inn: *please arrive by 17:00; dinner is served at 18:30*. The pass: *valid for two consecutive days from first use*. Due lines them up: 14 Nov, cancel the townhouse free; 19 Nov 09:40, online check-in opens; 20 Nov, museum ticket date change closes.

**Ten days out, you tap Does it hold?** Nineteen lines. Most hold, with their sources. Two conflicts. *Your return flight has no checked bag: the booking shows 20 kg on the outbound only (airline PDF p.2), and your plan ends with a day in Kyoto buying ceramics.* And the one that would have cost a morning: *You leave the Tokyo hotel at 07:40 for the 08:10 train to Hakone (plan, day 4), but the forwarding desk opens at 08:30 (forwarding sheet p.2). Send the bag on day 3, so it reaches Kyoto a day before you, or carry it to Hakone.* Three open questions. *The open-air museum closes at 17:00 and the inn asks you to arrive by 17:00; Trippy does not know the travel time between them.* *Your flight leaves Kansai at 10:30; the townhouse's check-out is 10:00 "earlier on request". Have you asked?* *The townhouse key code should arrive by email on 23 November. Trippy has no document with it yet.* You answer the second by typing "asked, 06:30 agreed"; it becomes a fact with you as the source and the line turns to holds. You leave the first open.

**Two days out.** The key-code email arrives. You share it to Trippy; the inbox says *document for: Kyoto townhouse* and the open question closes itself: the code is now a Condition on the card, quoted, with the email as its source.

**Day 1.** At the gate you tap the flight status pill: three hours late. Today offers Re-check from here. The arrival becomes a fact (*18:20, from the airline at 09:05*), the ledger reruns, and one line turns to conflict: *the museum ticket's entry window is 19:00–19:30 (ticket p.1), date changes closed yesterday; your new arrival makes 19:00 unlikely.* Trippy does not move anything. The co-pilot, asked, says what the ticket allows and what it does not, and offers to move the evening's other stops; the ticket itself is a booking, so changing it is yours (or, with the booking-change proposal kind of §5 R-3, a reviewable proposal). You decide.

**That evening.** Tonight's card says the hotel, and under it: *check-in until 24:00; after that, use the phone at the entrance* (confirmation p.1). You did not have to find the PDF.

**After the trip.** The ledger and the facts stay as the record of what the trip depended on. Expenses are untouched. Nothing was pushed to your phone at any point.

### 4.3 What each model specifically improves, and what stays non-model

- **Haiku 5.5** reads every document in full at import and on every change. At list price a five-page PDF (roughly 8–15K input tokens as document blocks, 3K of schema and prompt, 1–2K of output) costs about $0.003; a phone screenshot about $0.002. Reading again after a change is the same. Its `effort` levels give per-document judgment, "this is a change to booking X, not a new booking", that Haiku 4.5's fixed thinking budget made clumsy; its better instruction following is what "quote verbatim" relies on.
- **Sonnet 5.5** runs the whole-trip check at `high` effort (a new workload with its own measured row; the deployed `low` co-pilot profile does not bind it). Its higher-resolution vision is the hypothesis that dense CJK confirmations are read more accurately than at 1568 px; §6 B1 tests it against Sonnet 4.6 on the same screenshots. Its measured reliability with tools (Plan 30: 20/20 tool sequences at `low`) is what the co-pilot's new evidence tools lean on. Mid-conversation system messages are an optional way to tell it "documents changed since your last turn" without touching the cached trip block.
- **Both** are cheap enough that the brief's hypothesis, *cheap breadth followed by selective judgment*, is literally this pipeline: Haiku per document, Sonnet over all the facts.
- **Non-model, and unavoidable:** intake channels (§4.7); server-side PDF text extraction for quote verification (no dependency exists today); time zones for facts (bookings carry `origin_tz`/`destination_tz`, and `geo-tz` can zone a hotel's country, but a time read from a document carries whatever zone the document stated, often none); the document viewer opening at a page (`#page=N` works in Chromium's embedded viewer and is unreliable on iOS, so the quote is always shown beside the reference); a bounded single-flight job runner for fact extraction (the D-33-1 registry pattern); fingerprint staleness (the `copilot_proposals` pattern); privacy (facts inherit attachment privacy and never reach the public share); the D-34-5 schema budget.

### 4.4 Evidence, provenance and freshness

- **Sources, in order of trust:** a document the traveller gave Trippy (import file, attachment, inbox item); a fact the traveller typed or acknowledged; a status the traveller fetched (flight status); a Phase 4 research finding (dated, cited, never promoted on its own). The discovery catalogue's `openingHours` is model-authored and displayed with "— verify" today; it is **not** a source.
- **Provenance, two mechanisms considered.** (a) The API's citations on PDF document blocks return page locations and the cited text, but citations are incompatible with `output_config.format`, so the fact schema would have to move to strict tool use and the harness changes shape. (b) The fact schema carries a verbatim `quote` and a `page`, and the server verifies the quote against text it extracted itself from the PDF or the pasted email; a verified quote is badged, an unverifiable one (image, scanned PDF) is shown as "read from image". (b) keeps the Plan 34 contract and gives a deterministic check that (a) does not; it is the recommendation, with (a) re-examined only if verification rates disappoint.
- **Freshness.** A fact belongs to a document version; a later document for the same booking supersedes, never overwrites, and the superseded fact stays visible as history. The ledger is dated by fingerprint. Phase 4 findings carry the fetch date and are re-asked, not trusted, when stale.
- **Unavailable sources.** Anything not in the traveller's documents is an open question in Phases 1–3. Phase 4 adds the web for the specific questions, with the constraints C4 recorded. Booking sites' APIs, social apps and messaging threads are not sources and are not assumed.

### 4.5 The hardest failure mode

**A confidently wrong fact that the traveller acts on, or fails to act on.** A misread cancellation date, a cutoff read in the wrong time zone, a condition taken from an old version of a booking, a fact attached to the wrong booking in a multi-booking PDF. The traveller bears the cost at the worst moment: a missed free-cancellation window is money; a false "reception closes at 23:00" is needless panic; a false "holds" is being stranded.

How the experience exposes rather than hides it:

- Every line shows its quote and its source; a quote the server verified against the document's own text is badged, and one it could not verify says so.
- Every time shows its zone, and "zone not stated" is a visible state, not a default.
- Conflicts show both sides; a conflict is never collapsed into one claim.
- Open questions are questions. Trippy never fills one in without a source.
- The ledger is stale-marked by fingerprint the moment a document, a booking or the plan changes, and it is never rerun silently.
- Acknowledgements and typed answers are facts with the traveller as source and a date; they can be wrong, and the record shows who said so.
- The experiment (§6) sets numeric trust thresholds before any product code exists, and the fact extractor's accuracy on the costly kinds (deadlines, times, requirements) is the first gate.

A second failure mode, **misrouting in the inbox** (a change notice treated as a new booking, an idea treated as a booking), is contained by design: triage proposes, the traveller confirms, the existing duplicate-confirmation rule (`findDuplicateConfirmationRef`, shared with the MCP validator) and the MCP draft's probable-duplicate check apply, and "kept, unplaced" is an ordinary outcome.

A third, **privacy**, is contained by channel design: a per-user forwarding address that the traveller chooses to send to, never a mailbox Trippy reads; `not_travel` items are not retained (the extraction contract already has that branch, D-34-3); facts inherit attachment privacy and are excluded from the public share.

### 4.6 Architecture and product-boundary changes

Sketch, not a plan. Table names are placeholders for the plan to settle.

**Objects (new, first-class).**
- *Inbox item:* channel (share, shortcut, email, upload, MCP), content or file, received at, triage result (kind, confidence, target booking), status (new, placed, kept, dismissed), what it became. Likely an extension of `import_artifacts` with a triage stage rather than a parallel table; the plan decides.
- *Fact:* trip, booking (nullable), source kind and id, page, verbatim quote, quote verified, kind (deadline, window, requirement, instruction, allowance, contact, restriction, cost condition), label, value text, value datetime and zone (nullable), applies-from/to dates, confidence, model, extracted at, superseded-by, status.
- *Open question:* trip, text, what would answer it, raised by (ledger run, user), related facts/stops/bookings, status, answered by (user, document, research), answer fact.
- *Readiness run and items:* trip, fingerprint, profile, created at; items of kind holds/conflict/question with evidence ids, severity, acknowledgement (user, note, date).
- *Research finding (Phase 4):* question, answer, sources with fetch dates and quotes, model, created at; never promoted automatically.

**Workloads (new rows in `MODEL_PROFILES`, each measured in its own W0; none bound by the four existing profiles).**
- `triage`: Haiku 5.5, `low`, small structured output. About 5K in, a few hundred out.
- `facts`: Haiku 5.5 at `medium` is the candidate; Sonnet 5.5 if the §6 B2 comparison shows Haiku missing the costly kinds. Structured output designed inside D-34-5: one object type, every property required, `""` for not given, no new unions. Input: the document as blocks, the booking it belongs to, the trip's dates and zones.
- `readiness`: Sonnet 5.5, `high` (measure `xhigh`), adaptive thinking, structured output for the ledger. Input: the deterministic `tripHealth.js` findings (run first, as evidence, so detection stays reproducible where it can be), the fact table, the trip detail. Roughly 30K in; thinking and output 8–20K; about $0.15–0.30 per run at list, with cache reads cutting re-runs to cents.
- `research` (Phase 4): Sonnet 5.5 with `web_search_20260209` and `web_fetch_20260209`, `max_uses` bounded, `allowed_domains` where the source is known, today's date and the vendor's "search for what may have changed" line in the prompt; output answer + sources + fetch dates.

**Pipelines.**
- Inbox → triage → route: new booking → the existing extraction and review; change → diff against the booking → a booking-change proposal (R-3); document → attach; idea → kept (Phase 5 resolves); other → kept or dismissed.
- Any new document (import file, attachment, inbox item, MCP upload under R-2) → `facts` job, single-flight per document, idempotent by `content_hash` → fact rows → ledger marked stale.
- Ledger: on demand; optionally auto-rerun when stale and the trip starts within N days, as a bounded background job with no notification (R-1).
- Today: deterministic selection of facts by date; no model call.

**Co-pilot.** Two read-only evidence tools, `search_trip_facts` and `get_readiness`, bounded like the existing query tools, instead of inflating the cached trip block with `details_json` (the 2026-07-13 review's Direction D, now with the evidence it asked for). Optional: a mid-conversation system message when documents changed since the last turn. The co-pilot stays at `low`; "check the trip" calls the `readiness` workload server-side rather than raising the conversation's effort. Quick actions gain "Does it hold?" beside the three deterministic seeds.

**MCP.** `get_trip` may later return facts under `trips:read`; drafts are unchanged; an `inbox:write` scope (or `documents:write`) lets a phone Shortcut post into the inbox with a personal token, which is how iOS gets a one-gesture channel.

**Privacy and share.** Facts, questions and ledgers are private trip data: never in `GET /share/:token`, never in the public payload, never exposed by MCP beyond the token's scope.

**Design floor.** Bare lines, not pills. DM Mono labels, Cormorant quotes, Playfair only for place names. One gold accent per surface: the next due date on Due, the conflict marker on the ledger. No new icons. 375 px first.

### 4.7 Intake channels: the non-model engineering, with device facts

The owner's phone decides the order (O-1).

| Channel | How | Works on | Notes |
|---|---|---|---|
| In-app upload | exists | both | Stays the fallback |
| PWA share target | `share_target` in the manifest; the service worker receives a `POST` with files or text and forwards to `/api/inbox` | Android Chrome: yes. iOS Safari PWAs: **no**, as far as this reference knows (re-verify on the owner's iOS version) | One gesture from Trip.com, the gallery, the browser |
| iOS Shortcut | a Share Sheet shortcut that `POST`s the image or text to `/api/inbox` with a personal integration token | iOS and Android | Reuses the token model (D-28-1); one new scope; a short setup once |
| Email forward | a per-user address; inbound mail → `/api/inbox` | both | **Heaviest.** Trippy has no inbound mail; Cloudflare Email Routing on the production zone (a Worker posting to the API) is the plausible path and needs the owner's ops ruling (O-2). Stage last |
| MCP | existing upload tickets and `prepare_draft` | agents | Documents arriving this way get facts only under R-2 |

### 4.8 Effort and operating cost

Rough, with assumptions stated; no false precision.

- **Effort.** P0 proof harness: about two sessions. P1 facts + Conditions + Due: four to five. P2 ledger + co-pilot tools + Today + Re-check from here: four. P3 inbox (share target, Shortcut endpoint, triage, change proposals; email last): four to six. P4 research of open questions: three to four plus measurement. P5 ideas and rehearsal: not estimated here. In Trippy's terms this is a programme of three or four numbered plans, each landing on its own branch as Plans 26–35 did, not one plan.
- **Operating cost at list.** Per document about $0.003; per inbox item under a cent; per ledger run $0.15–0.30, re-runs with cache reads a few cents; per researched question $0.15–0.25 including about $0.03–0.06 of searches. A document-rich trip over its whole life: under $10. For scale, the entire Plan 30 measurement spent $7.3.
- **Volume.** Production volume is low (the migration's observation windows were replaced by log checks for that reason), so none of this stresses any provider budget; daily caps follow the discovery pattern anyway.

### 4.9 Phases (a sequence, not a plan)

P0 proof (§6) → P1 facts, Conditions, Due on documents already in Trippy → P2 the ledger, co-pilot evidence tools, Today, Re-check from here → P3 the inbox and booking-change proposals → P4 research of open questions → P5 ideas (C3's composition, gated on a resolver ruling) and rehearsal (C2) on the dependency model.

The order is deliberate: P1–P2 prove the payoff on material Trippy already holds; P3 is only worth building if the payoff exists; P4 is only safe once questions are specific; P5 reopens closed rulings and should wait for evidence that the first four earned their keep.

---

## 5. Decisions and exclusions this direction touches

Stated explicitly, as the brief requires; none is changed by this document. "Needs a ruling" means the flagship cannot proceed past P1 without it.

| Id | Decision or exclusion | What it says | Relation |
|---|---|---|---|
| R-1 | Spec §2.3 exclusion; README "Deliberate by Design" | No automatic background flight monitoring, no proactive alerts, no continuous polling | **Needs a ruling.** The flagship needs bounded background *compute* (facts at import; a stale ledger rerun) and never a notification or a provider poll. Proposed ruling: compute yes, notifications no, polling no |
| R-2 | MCP cost boundary (`docs/DECISIONS.md`, Plan 28) | Never add a model call on the MCP path | **Needs a ruling.** Facts for an MCP-uploaded attachment would run as the same deferred import-time job the app's uploads get; the tool's response never waits on it. Either that is "not on the MCP path", or MCP uploads are excluded from facts |
| R-3 | Plan 11 D6; co-pilot cannot touch bookings | Booking-linked stops are untouchable by proposals; proposals carry only four stop operations | **Needs a ruling.** A *booking-change proposal* kind (from an inbox change notice, or from the ledger) that edits booking fields through the booking service and the existing stop sync (Plan 25: the pin still wins). D6 is not reversed: the stop keeps following its booking; the booking changes through a reviewable proposal |
| R-4 | Spec §2.3 exclusion | No route-time or distance-matrix reasoning in the co-pilot | Respected in P1–P3: a tight connection is an open question, never a claim. Reopened only if the owner later wants "can I make it" answered, which means a routing provider |
| R-5 | Plan 12 G1 | The co-pilot recommends new places only from the catalogue | Untouched until P5, which would extend the grounding set to user-provided sources with a kept original |
| R-6 | Place-naming / resolver strategy, CLOSED | Nominatim first, Google fallback, no resolver change | Untouched until P5; mainland-China ideas would need a new provider and an explicit reopening |
| R-7 | Plans 19/20 | Bookings never gain a price column | Respected: deposits and city taxes are *conditions*, never prices; expenses stay the traveller's |
| R-8 | D-34-5 | Never add an optional property to a structured-output schema | Constraint on the fact schema: one object type, all required, `""` for not given |
| R-9 | D-30-1, D-30-6 | Settings keyed by model; allowances from measurement | New workloads get their own measured rows; the four deployed profiles do not bind them |
| R-10 | Spec §9.3; 2026-07-13 review Direction D and Q8 | Retrieval tools only if evidence supports them; never move volatile context into the cached block | The fact table is that evidence; narrow tools for facts, the cached trip block unchanged |
| R-11 | D-27-1 and the catalogue's `openingHours` "— verify" | Model-authored hours are not verified | The ledger never treats them as facts; P4 may research them with dated sources |
| R-12 | Public share privacy rule | No bookings, documents, co-pilot history in the public payload | Extended: no facts, questions or ledgers either |
| R-13 | D-28-1 | Personal tokens, not OAuth; reopen only for a connector-only client | Untouched (C8 would have reopened it; not chosen) |
| R-14 | Plan 2A user decision | No per-provider integrations or booking APIs | Respected: the inbox is channel-agnostic (share sheet, Shortcut, a forwarding address), not a provider feed; said explicitly because "email ingestion" could be mistaken for one |
| R-15 | D-33-1 single-flight; in-process registries | One generation per destination; budgets in memory, one process | The facts job reuses the pattern; it stays in-process |
| R-16 | Plan 35 (CLOSED 2026-10-20, after this document was written) | Discovery wait architecture; closed the same day with W5 | No overlap; the shared checkout is free of it |

Open owner questions this document raises, with defaults:

- **O-1** Which phone? Decides whether the share target (Android) or the Shortcut (iOS) is the first one-gesture channel. Default: build the Shortcut endpoint first, since it works on both.
- **O-2** Is inbound email through the production Cloudflare zone acceptable, and when? Default: last channel, P3's final wave, after the one-gesture channel has proved itself.
- **O-3** If the retrospective finds few connections but accurate facts, is Conditions + Due alone worth shipping? Default: yes, as P1, with the ledger deferred; the owner should say now so the fallback is honest.
- **O-4** Approve the experiment's spend (under $10) and its use of the production export copy. Default: not assumed.
- **O-5** Are ideas (C3) in the first programme or after it? Default: after.

---

## 6. The experiment that could disprove it

Designing the experiment is separate from permission to run it: parts A and B spend paid Anthropic calls on private documents and need the owner's approval (O-4). No production system is touched; run files stay local and gitignored as in Plan 30; the unit suite stays network-free (`tests/setup/noNetwork.js`); live runs use the `LIVE_ANTHROPIC=1` pattern and the `backend/scripts/modelEval` harness with its `--max-usd` cap.

### Part A — the retrospective (does the value exist?)

- **Corpus.** Every trip in the production export copy that carries documents (import files and attachments), run as of the day before its departure using the trip detail as stored. If fewer than three trips carry eight or more documents, the owner supplies confirmations from the last two years as files; the harness reports the counts first.
- **Run.** `facts` on every document (Haiku 5.5 `medium` and Sonnet 5.5 `medium`, both), then `readiness` (Sonnet 5.5 `high`) per trip, with `tripHealth.js` findings as input.
- **Grading, by the owner, blind to model.** On a hand-checked sample of about 30 documents: each fact correct / wrong / missing, with deadlines, times and requirements as the costly kinds. On every ledger line: true / false; already known / new; would it have changed an action. Per trip: "would you have opened this the night before?"
- **Disproven if any of these holds:** deadline, time or requirement facts wrong in more than 3 % of the sample; fewer than half of the document-rich trips yield at least one new, true, action-changing line; more than one ledger line in ten is false. The first kills trust, the second kills the payoff (the fallback is O-3), the third kills both.
- **Cost and time.** Facts on about 60 documents × 2 models ≈ $0.50; ledgers on about 6 trips × 2 runs ≈ $3; under $5 at list. Two sessions plus an hour of the owner's grading.

### Part B — targeted old/new comparisons, only where a model claim matters

The migration sweep is not rerun; Plan 30's and Plan 34's numbers stand for extraction, the co-pilot, discovery and descriptors.

- **B1, the vision hypothesis.** The same 20 CJK-heavy phone screenshots (Trip.com and hotel confirmations) through `facts` on Sonnet 5.5 and Sonnet 4.6. If 4.6 matches 5.5 on the costly kinds, higher-resolution vision is not an enabler, the honesty record says so, and the direction stands on product value alone.
- **B2, who reads at import.** Haiku 5.5 against Sonnet 5.5 on the Part A sample. If Haiku is within one point of Sonnet on the costly kinds, Haiku carries the import-time read at a tenth of the cost; otherwise Sonnet does and §4.8's economics note changes.
- Not measured: web research (Phase 4 has its own W0), browser use, per-message effort.

### Part C — the inbox trial (does the mirror stop falling behind?)

After Part A passes and P1–P3 exist: on the next real trip's preparation, at least three weeks out, the owner sends every booking, change and document from the phone through the channel their device allows. Measured: items sent; triage placed correctly (target 90 %, disproven under 75 %); bookings that entered Trippy within a day of being made (disproven under 80 %, by the owner's own count against Trip.com); at departure, whether every booking's conditions were current. The owner's one-line verdict afterwards, "did the trip live here this time?", is the result that matters and the one Plan 3 would recognise.

---

## 7. The brief's architecture questions, answered for this direction

- **Should evidence, commitments, preferences, alternatives, dependencies and decision history be first-class objects?** Evidence (facts), commitments (bookings, already), dependencies (ledger items linking facts to plan items), open questions and decision history (acknowledgements and user-asserted facts): yes, as §4.6. Preferences: only as explicit, dated user facts; no inferred profile. Alternatives: not until P5, and only on top of the dependency model.
- **Do maps, timelines and comparison surfaces carry the experience better than chat?** Yes. Conditions, Due and the ledger are not chat; the co-pilot gets evidence tools so that chat can *answer from* them, but the experience lives on the trip's own surfaces.
- **Should bounded background jobs prepare reusable findings when data changes?** Yes, with R-1's line: compute on change (facts at import, a stale ledger), no notifications, no polling, in-process and single-flight like discovery.
- **Would narrow evidence tools outperform giving the model the whole trip on every turn?** Both, by workload. The readiness check gets everything in one call at high effort, because it is a one-shot synthesis over bounded input. The co-pilot keeps its small cached trip block and gains narrow fact tools, because the fact table is larger than the trip skeleton and mostly irrelevant to any one turn.
- **Conflicts with existing contracts** are in §5, explicitly, none silently revised.

---

## 8. What this assessment does not do, and what happens next

It does not implement, deploy, draft a plan, create a migration, change a profile, or reopen the migration. It does not claim the owner's phone, mail zone or past-trip corpus will cooperate; those are O-1, O-2 and Part A's first report.

Next, in order: the owner reads and rules on R-1, R-2, R-3 and O-1 to O-5; with O-4 approved, Part A and Part B run as a harness-only W0 under a numbered plan whose only product scope is P1 (facts, Conditions, Due), gated on Part A; the ledger, the inbox and research follow as their own plans if the gates pass. If Part A fails on trust, the honest outcome is to record why in `docs/DECISIONS.md` and not to build a document index with extra steps.
