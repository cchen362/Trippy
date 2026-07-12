---
name: deploy
description: Deploy Trippy to the Debian production server. Use when the user says "push to live", "deploy", "deploy to production", "merge and deploy", or invokes /deploy. Covers pre-flight checks, merge/push, server pull, container rebuild, and post-deploy verification.
---

# Deploy Trippy to Production

OPS procedure — no app code changes in a deploy session. If the working tree has uncommitted changes, stop and resolve that first (commit or explicitly set aside with the user).

## Server facts (verified 2026-07-09; re-verify if anything looks off)
- SSH: `ssh chee@100.94.82.35` (key auth works from this machine; run from `C:\Users\cchen362`)
- Project dir on server: `~/Trippy` (capital T), a git clone of this repo
- Container: `trippy-trippy-1` (hyphens, `docker compose` v2 naming — not `trippy_trippy_1`)
- Rebuild command: `docker compose up -d --build` (v2 syntax, no dash)
- App port: host port **6768** — verify with `curl http://localhost:6768/api/health` on the server. Host port 3001 is a *different* app (medical-companion); hitting it returns a misleading "Authentication required" response that looks like Trippy but isn't.
- DB volume: `~/Trippy/data/trippy.db` — SQLite WAL mode, `-shm`/`-wal` files present. The DB lives OUTSIDE the container; a rebuild must never touch it.
- Daily backup cron exists on the server — confirm it's still active while you're there.

## 1. Pre-flight (local)
1. Full test suite + build green. Fix root causes if not — never deploy red.
2. `git status` clean; review `.gitignore` — `.env`, `data/`, DB files, logs must not be tracked. Grep the diff being deployed for secrets/API keys.
3. Confirm which branch is being deployed. If not on `main`: merge the feature branch into `main` locally (ask before merging if the user didn't explicitly say to).
4. Confirm server access works (`ssh chee@100.94.82.35 "echo ok"`) BEFORE pushing — if Tailscale/VPN is down, stop and tell the user.

## 2. Push
- Push `main` to the remote (origin).

## 3. Server update
On the server (via ssh):
1. Snapshot state first: current commit (`git -C ~/Trippy log -1 --oneline`), container status (`docker ps`), and confirm a fresh DB backup exists (or take one: copy `~/Trippy/data/trippy.db*` to the backups dir) BEFORE pulling.
2. `cd ~/Trippy && git pull`
3. If there are new DB migrations, verify how they run (app startup vs manual) and run them in order.
4. Rebuild + restart containers (check which compose command the server uses — `docker compose` vs `docker-compose` — and use the existing pattern; don't invent a new one).
5. Tail the container logs until startup is clean — watch specifically for migration errors and missing-env errors.

## 4. Post-deploy verification (do not skip)
1. Hit the production URL and log in as a real user.
2. Exercise at least: trip list loads, one trip's Plan/Map/Today tabs render, and whatever feature this deploy shipped.
3. Check the mobile viewport if UI changed.
4. Report: deployed commit hash, container status, what was manually verified, anything observed but not fixed (goes in the plan doc, not a hotfix).

## Rollback
If startup fails or verification breaks: `git -C ~/Trippy checkout <previous-commit>` + rebuild, restore the DB backup only if the DB was actually migrated/damaged, then report — root-cause the failure locally, never debug live on the server.
