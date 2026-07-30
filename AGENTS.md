# Trippy — Codex

**Read `docs/ENGINEERING.md` first, in full, before writing any code.** It is the authoritative engineering guide for this repository — architecture, non-negotiable rules, the design system, provider cost discipline, and verification expectations. This file used to carry its own copy of that guidance and drifted out of date; it is now a pointer, deliberately. Do not reintroduce a copy here.

Then read `docs/DECISIONS.md` — settled cross-tool decisions that must not be re-litigated (external service tiers, closed follow-ups, deliberate non-fixes).

## Codex specifics

- Make all guidance edits in `docs/ENGINEERING.md`, never in this file or in `CLAUDE.md`. Those two are thin wrappers so that Codex and Claude Code always read identical rules.
- When you settle something durable — an external service tier or quota, a "do not do this" ruling, a resolved follow-up — append it to `docs/DECISIONS.md` in the same commit. Another agent will not see it otherwise.
- Deploy steps are in `.agents/skills/deploy/SKILL.md`.
