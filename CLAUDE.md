# Trippy — Claude Code

The authoritative engineering guide for this repository is `docs/ENGINEERING.md`, imported below. It is shared with every coding agent that works on Trippy — **make all guidance edits there, not in this file**, so Claude Code and Codex can never drift apart.

@docs/ENGINEERING.md

## Claude Code specifics

- Settled cross-tool decisions live in `docs/DECISIONS.md`. Read it before proposing work on a paid provider or anything marked CLOSED, and append there — not only to memory — when a session settles something durable. Memory is private to this tool and this machine; Codex cannot see it.
- Deploys go through the `deploy` skill (`.claude/skills/deploy/SKILL.md`), not ad-hoc ssh.
- Implementation plans live in `docs/superpowers/plans/`. Use the `implement-milestone`, `wrap-up`, and `handoff` skills when the request matches them.
