# Model 5.5 — opportunity exploration brief

Date: 2026-10-18 (Asia/Singapore)

Reviewed and updated: 2026-10-19, after Plan 30 Deploy B.

Status: Open product discovery. No feature direction has been selected, no implementation plan is requested for these ideas yet, and no implementation is authorized by this brief.

Historical companion: [Sonnet and Haiku upgrade assessment](2026-10-18-sonnet-haiku-55-upgrade-assessment.md). The upgrade is deployed; that pre-migration review is rationale, not today's runtime baseline. This session is standalone product discovery and does not ask for another migration assessment or implementation plan.

## 1. Owner intent

Explore what Trippy could become with Sonnet 5.5 and Haiku 5.5. The owner explicitly invites a blank cheque for ideas: architecture, interface, product scope and previous assumptions can be challenged. Seek a surprising, complete traveller experience rather than excellent execution of the existing backlog.

This freedom applies to discovery. Identify which existing owner decisions a concept would reopen, and the reason, without treating them as adopted reversals or limits on imagination. Production data, private information and external-action authority remain real boundaries. An ambitious concept can describe a new authority model; it cannot assume that model is already granted.

## 2. Grounding before invention

Read current code, [ENGINEERING.md](../../ENGINEERING.md), [DECISIONS.md](../../DECISIONS.md) and [README](../../../README.md). Treat the living specification and historical plans according to their status; some older exclusions are stale. Distinguish existing capability, planned work and invention.

Today's product combines bookings/documents, a flexible daily itinerary, maps, shared expenses, catalogue discovery, collaboration and a proposal-based co-pilot. The current co-pilot has three tools: catalogue search, deterministic health checks and itinerary proposals. Its [trip context](../../../backend/src/services/copilotTools.js) intentionally omits coordinates, document metadata and booking `details_json`. Swapping models does not supply the evidence, tools or product state needed for richer experiences.

### Shipped baseline and existing follow-ups

The owner reports both model upgrades completed and deployed. The current constants and `MODEL_PROFILES` in [claude.js](../../../backend/src/services/claude.js) confirm the 5.5 configuration. [Plan 30](../plans/Implementation%20Plan%2030%20Model%205.5%20Migration.md), Deploy B at `a2c47d5`, records all four workloads live in production. This brief review checked repository evidence, not the live server. The owner's Deploy B production pass passed the same day, and Plan 30 is CLOSED (W6 close-out merged 2026-10-19).

| Workload | Current model | Current profile |
|---|---|---|
| Booking extraction | Sonnet 5.5 | Adaptive thinking; medium effort; 16,000-token allowance |
| Co-pilot | Sonnet 5.5 | Adaptive thinking; low effort; 16,000-token allowance per response |
| Photo descriptors | Haiku 5.5 | Adaptive thinking; low effort; 1,024-token allowance |
| Discovery | Haiku 5.5 | Thinking disabled; low effort; 48,000-token allowance |

These are measured profiles for existing workloads, not limits on what future features may use. Read the live profiles when starting discovery. In particular, Haiku discovery does not currently use adaptive thinking, and neither model currently gains web research or browser access merely from being upgraded.

Use Plan 30's evaluations and owner rulings as evidence. Discovery's recorded adaptive-low experiment delayed the first category and under-delivered the requested volume, motivating the deployed thinking-disabled profile. Co-pilot migration required D-30-9: acknowledge the proposal tool call, then obtain its explanation as final text in another model step. Thinking summaries are not forwarded as the answer. These results show why capabilities, response contracts and user experience must be assessed together; they do not establish that thinking is unsuitable for different discovery or research tasks.

Read the status headers of [Plan 31: photo relevance](../plans/Implementation%20Plan%2031%20Stop%20Photo%20Relevance.md), [Plan 32: stopped exchanges](../plans/Implementation%20Plan%2032%20Remove%20a%20Stopped%20Exchange.md), [Plan 33: discovery single-flight](../plans/Implementation%20Plan%2033%20Discovery%20Single-Flight%20Generation.md) and [Plan 34: output contracts](../plans/Implementation%20Plan%2034%20Model%20Output%20Contracts.md). Plan 34 is in progress (W0 measurement complete 2026-10-19; W1 onward not yet shipped); it covers structured extraction/descriptor output and measured follow-ups. Distinguish shipped work from approved future work. Do not present migration hardening or these follow-ups as the new product discovery, or make finishing them a prerequisite to writing this assessment.

The interesting hypothesis is cheap breadth followed by selective judgment: Haiku investigates or structures many bounded questions; Sonnet synthesizes supported findings into useful choices. This is an application workflow hypothesis, not a requirement to build a multi-agent architecture or use Anthropic's advisor tool.

Published inputs, checked during the original assessment on 2026-10-18 (recheck official documentation for any capability on which a selected opportunity depends):

- [Haiku specifications](https://platform.claude.com/docs/en/models/haiku-5-5/overview): lower short-prompt pricing and adaptive effort support repeated preparatory work. Cheap tokens do not make browsing, retrieval, verification or external providers free.
- [Sonnet feature changes](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5): adaptive effort and richer conversation/tool management offer orchestration options. Advanced beta features are optional dependencies, not reasons to redesign by themselves.
- [Sonnet migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide): higher-resolution image input is relevant to dense visual material; better perception remains an evaluation hypothesis.
- [Browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool): supported browser interactions require an environment operated by the application. Search/fetch may suffice for simpler reading. Tool support does not guarantee website access or reliable actions.

For each opportunity distinguish: a genuinely new API capability; an existing capability now potentially reliable enough; improved economics; and a feature that was already feasible and is mainly a product choice. Do not claim something was impossible on 4.x without evidence.

## 3. Independent exploration assignment

Explore broadly before selecting a flagship. Include at least two materially different ideas absent from section 4, and be willing to reject every seed below. Do not make the exercise a contest to justify the earlier reviewer's preferred concept.

For each serious candidate explain:

1. A concrete traveller situation and the full end-to-end experience, including input, visible result and the decision/action that changes.
2. Why it matters enough to change how the owner travels or plans; novelty alone is insufficient.
3. What specifically improves with each model, and what remains dependent on evidence, tools or non-model engineering.
4. Data and integration requirements, freshness/provenance, uncertain claims and unavailable sources. No assumed universal access to social apps or booking websites.
5. Required changes to architecture, interaction and product boundaries. Existing architecture is a starting point, not the maximum ambition.
6. The hardest failure mode, who bears its cost and how the experience exposes uncertainty rather than hiding it.
7. Rough discovery/prototype/product effort and ongoing operating cost, with assumptions; avoid false precision.
8. A convincing experiment and a result that would falsify the opportunity. Reuse existing migration measurements for established claims. Propose a targeted old/new comparison with the same tools/evidence only where a genuinely unresolved model-enablement claim matters; do not rerun the migration sweep by default. Separate designing an experiment from permission to run paid calls or mutate external systems.

Compare candidates on traveller value, differentiation, evidence availability, model contribution, operating economics and ability to demonstrate the experience. Use reasoned judgments rather than arbitrary numerical scores. Choose one flagship, explain why alternatives lose, and state the leading unresolved risk.

Return a standalone discovery assessment in `docs/superpowers/reviews/`, with a day-in-the-life scenario and the smallest convincing proof of the selected experience. That proof may require substantial architectural work; it should not be reduced to a safe cosmetic enhancement. Defer its numbered implementation plan until the owner reviews the direction. This session does not implement, deploy or reopen the completed model migration.

## 4. Optional seeds, not a shortlist or specification

### A. Rehearse a trip before committing to one version

Explore several coherent trips built around the same bookings: neighbourhood immersion, architecture/night streets, or easy shared time. Let the traveller change an assumption and see the consequences: late departure, carrying luggage, a companion skipping a museum, or a disrupted connection. Show what each version gains, sacrifices and depends on.

The interesting outcome is a previously unnoticed connection or decision, not three differently worded itineraries. Haiku could investigate bounded dependencies; Sonnet could compose and critique alternatives. Calculations and confirmed constraints should have explicit, reproducible foundations. This is not a claim that an LLM can precisely simulate the real world.

### B. Turn saved fragments into the raw material of a trip

Accept user-provided screenshots, links, menus, exhibition posters and recommendations alongside confirmations. Preserve sources; distinguish reservation, tentative interest and unresolved location. Detect duplicates across names. Reveal that several saved ideas form a coherent afternoon near an existing free evening.

The leap is discovery from the traveller's material. Access restrictions and uncertain intent are central questions, not details to assume away.

### C. Investigate whether the trip is ready

Go beyond existing deterministic gap checks: investigate whether an arrival, baggage situation, access condition and later commitment actually fit together. Return a supported answer, a viable alternative or a specific unanswered question. Keep claims source-linked and dated.

The success criterion is research the traveller no longer needs to perform, not more warnings or a reassuring readiness score. Current model training knowledge alone cannot establish current opening/access/transport facts.

### D. Learn taste through meaningful choices

Compare two actual afternoons and learn why one appeals: fewer transitions, a particular atmosphere, spontaneous food stops or depth in one neighbourhood. Use explicit feedback to shape later possibilities. Separate expressed preference from inference and avoid assuming one trip defines a permanent personality.

### E. Design around disagreement in a group

Collect each traveller's priorities, optionally privately. Build shared anchors, separate mornings and sensible reunion points instead of forcing everyone into one schedule. Make compromises intelligible without exposing private responses or inventing consensus.

### F. Connect what the traveller sees to what the trip requires

A photographed sign, ticket or station board becomes a relevant next step linked to the actual booking. Explore multilingual interpretation and destination-specific context. Validate the physical-world reliability and timeliness required; visual plausibility is not adequate navigation evidence.

## 5. Architecture questions worth reopening in discovery

Would the useful product state include evidence, commitments, preferences, alternatives, dependencies and decision history as first-class objects? Would maps, timelines and comparison surfaces carry the experience better than chat? Should bounded background jobs prepare reusable findings when relevant data changes? Would narrow evidence tools outperform giving the model the whole trip on every turn?

These are questions, not an adopted graph database, agent framework, autonomy level or redesign. Preserve useful deterministic foundations when they remain the best answer. Identify conflicts with catalogue-only recommendations, provider strategies, route/weather/monitoring exclusions or external-action rules explicitly. The blank cheque permits proposing a different product; it does not silently revise today's contracts.

## 6. Pasteable orchestrator prompt

> Read `docs/ENGINEERING.md` in full, then `docs/DECISIONS.md` and this brief. Sonnet 5.5 and Haiku 5.5 are deployed across Trippy's four AI workloads. Ground the exploration in the current code, Plan 30's measured results and deployment record, and the status of Plans 31–34. Distinguish shipped capability, unfinished verification, approved follow-ups and new possibilities. Do not reassess or replan the migration.
>
> Explore what Trippy could become with this baseline. You have a blank cheque for ideation and may challenge architecture, interface and product scope. The deployed effort settings are not a ceiling for future features. Do not optimize for the smallest change or execute the backlog. Use this brief's concepts as optional stimuli, discover distinct alternatives of your own, and be willing to reject every seed. Seek a complete traveller experience that reveals value the owner has not already specified.
>
> Distinguish new capabilities, newly viable reliability/economics and ideas that were already feasible. Compare opportunities objectively, select a flagship, describe a day in the life, identify its evidence/integration requirements and hardest failure mode, and propose a convincing experiment that could disprove its value. Reuse existing evaluation evidence; identify targeted new tests only where needed. Existing decisions may be challenged explicitly in discovery, not silently changed in implementation. Produce a standalone exploration assessment in `docs/superpowers/reviews/`. Do not implement, deploy or draft the feature's implementation plan until its direction is reviewed.
