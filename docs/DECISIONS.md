# Trippy — Settled Decisions

Append-only log of durable decisions that any coding agent (Claude Code, Codex, or otherwise) must respect and must not re-litigate.

**Why this file exists.** Agent memory stores are per-tool and per-machine. When one agent settles something and records it only in its own memory, the next agent — a different tool, or the same tool on a different machine — cannot see it and will re-propose work that is already done or already declined. This file is in git, so every agent reads the same truth.

**How to use it.** Read this before proposing changes to a paid provider, a resolver strategy, or anything marked CLOSED below. Append a new entry, with a date and who decided, whenever a session settles something durable. Never delete an entry — supersede it with a newer one and mark the old one SUPERSEDED.

Entry format: `### <topic> — <STATUS>` then date, decision, and the reason it is closed.

---

### Unsplash API tier — CLOSED

**2026-07-28, owner.** Production tier is **granted at 1,000 requests/hour**. This is no longer a pending application or a constraint to design around. Do not re-propose applying for production access, and do not add rate-limit workarounds premised on the demo tier.

Related standing constraints (not decisions, just how it works): a single app-wide key is shared with agent diagnostics; each photo action costs a fetch; a throttled fetch leaves the photo `NULL`, which is recoverable via `backfillTripPhotos`.

### Place-naming coverage / resolver strategy — CLOSED

**2026-07-26, owner.** Ruling: **precision over polish. No resolver change.** Do not re-propose reordering the resolver, adding a Google-first path, or widening naming coverage.

Reason: the resolver tries Nominatim first and Google Places only as a fallback, so only ~28% of production stops get a named card — this is by design, not a defect. Discovery already pays Google (~96% Nominatim miss rate), so a "Discovery-first" reordering measures out as a +3.8% no-op. Coordinate-only Google links are the correct output for OSM and `user_pin` stops.

### Discovery catalogue — no rebuild

**2026-07-26 → 2026-07-28, Plan 26.** The catalogue is repaired incrementally, never rebuilt. The verified corpus is large (880+ active verified rows) and a rebuild would spend real provider money to regress it. Repair work is bounded and idempotent.

### Booking-linked stop pins — user pin always wins, silently

**2026-07-26, owner (Plan 25).** When booking sync and a user-confirmed pin disagree, the user's pin wins, with no notification and no prompt. Do not add a conflict UI.

### Co-pilot itinerary changes — no undo

**2026-07-12, owner (co-pilot v1).** The co-pilot has no undo. A loss-warning before applying is the chosen treatment instead. Booking-linked stops are untouchable by co-pilot proposals. Do not propose an undo stack.

### Expenses store — stays per-route

**2026-07-21, owner (Plan 20).** The expenses store is deliberately scoped per-route and is **never** lifted into `TripPage`. Reason: a ~700ms FX budget would be paid on every trip screen. Do not propose hoisting it into shared trip state.

### Place verification labelling — "Verified" only

**2026-07-28 (D-27-1, Plan 27).** Show a "Verified" label when a place is verified; show **no label at all** otherwise. Do not surface `pending` or `unverified` as user-facing words. This supersedes the earlier three-state split (D-26-1), which was never shipped.

### Production server facts

Not a decision, but the facts agents keep re-deriving: the app runs on port **6768** (not 3001), in container `trippy-trippy-1`. The production `~/Trippy/data` directory is root-owned with no passwordless sudo — take backups with the **host** `/usr/bin/sqlite3` (the container has none) into the chee-owned `~/Trippy/backups/`. The production migrations table is `_migrations`.
