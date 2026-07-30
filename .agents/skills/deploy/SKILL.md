---
name: deploy
description: Deploy Trippy to the Debian production server. Use when the user says "push to live", "deploy", "deploy to production", "merge and deploy", or invokes /deploy. Covers pre-flight checks, merge/push, server pull, container rebuild, and post-deploy verification.
---

# Deploy Trippy to Production

**The procedure lives in `.claude/skills/deploy/SKILL.md`. Read that file and follow it exactly.**

This file used to be a byte-identical copy, which meant every change to the deploy procedure had to be made twice or the two would silently diverge. It is now a pointer so there is one deploy procedure, not two.
