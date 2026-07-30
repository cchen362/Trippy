# Trippy — Settled Decisions

Owner decisions that any coding agent (Claude Code, Codex, or otherwise) must respect and must not re-litigate.

**Why this file exists.** Agent memory stores are per-tool and per-machine. When one agent settles something and records it only in its own memory, the next agent — a different tool, or the same tool on a different machine — cannot see it and will re-propose work that is already done or already declined. This file is in git, so every agent reads the same truth.

**How this file relates to code markers.** Decisions attached to specific behaviour are marked `D-<plan>-<n>` in the code they govern (see "Settled Decisions" in `docs/ENGINEERING.md`). Those get **one line here plus a pointer** — the reasoning stays next to the code, where it cannot drift. Decisions with **no single code home** — service tiers, quotas, cross-cutting rulings — keep their full reasoning here, because this file is their only home.

**How to use it.** Read before proposing changes to a paid provider, a resolver strategy, or anything marked CLOSED. Append when a session settles something durable. Never delete an entry — supersede it and mark the old one SUPERSEDED.

---

## Decisions anchored in code

One line each. The code marker is authoritative; follow the pointer for the reasoning.

| ID | Ruling | Reasoning lives in |
|---|---|---|
| **D-6/8/9 (geography ladder)** | A day's geography resolves through a fixed **five**-layer precedence — override → hotel → transit arrival → previous-day carry → seed — with city and country picked **independently**. Do not collapse or reorder it. | `deriveDayGeo` JSDoc, `backend/src/services/trips.js` (carries `D-26-2`); established by Plans 6, 8, and 9 W3 D5 |
| **D-26-2** | Plan 26 W4.1 must leave the geography precedence byte-identical; it adds layer-*source* signals only. | Same JSDoc |
| **D-27-1** | Show a "Verified" label when a place is verified; show **no label at all** otherwise. Never surface `pending`/`unverified` as user-facing words. Supersedes D-26-1's three-state split, which never shipped. | Discovery display path; Plan 27 |
| **D-25-1 (pin precedence)** | When booking sync and a user-confirmed pin disagree, the **pin wins, silently**. No conflict UI. | `syncStopWithBooking`; Plan 25 |
| **Plan 21 D3 (error channel)** | A mutation failure has exactly one owner. `useStops` opts into the shared page banner via `onError`; `useBookings` does not. Action hooks are namespaced, never flat-spread. | `// D3 CONTRACT:` comment, `frontend/src/pages/TripPage.jsx` |
| **Plan 20 (expenses store)** | The expenses store stays **per-route** and is never lifted into `TripPage` — a ~700ms FX budget would otherwise be paid on every trip screen. | Plan 20 review §9 |
| **Co-pilot v1** | No undo. A loss-warning before applying is the chosen treatment. Booking-linked stops are untouchable by co-pilot proposals. | Plan 11 / co-pilot v1 decisions |

## Decisions with no code home

These live here because nothing in the codebase records them.

### Unsplash API tier — CLOSED

**2026-07-28, owner.** Production tier is **granted at 1,000 requests/hour**. This is no longer a pending application or a constraint to design around. Do not re-propose applying for production access, and do not add rate-limit workarounds premised on the demo tier.

Standing constraints (how it works, not a decision): a single app-wide key is shared with agent diagnostics; each photo action costs a fetch; a throttled fetch leaves the photo `NULL`, recoverable via `backfillTripPhotos`.

### Place-naming coverage / resolver strategy — CLOSED

**2026-07-26, owner.** Ruling: **precision over polish. No resolver change.** Do not re-propose reordering the resolver, adding a Google-first path, or widening naming coverage.

Reason: the resolver tries Nominatim first and Google Places only as a fallback, so only ~28% of production stops get a named card — by design, not a defect. Discovery already pays Google (~96% Nominatim miss rate), so a "Discovery-first" reordering measures out as a +3.8% no-op. Coordinate-only Google links are the correct output for OSM and `user_pin` stops.

### Discovery catalogue — no rebuild

**2026-07-26 → 2026-07-28, Plan 26.** The catalogue is repaired incrementally, never rebuilt. The verified corpus is large (880+ active verified rows) and a rebuild would spend real provider money to regress it. Repair work is bounded and idempotent.

### Production server facts

Not a decision, but facts agents keep re-deriving: the app runs on port **6768** (not 3001), in container `trippy-trippy-1`. Production `~/Trippy/data` is root-owned with no passwordless sudo — take backups with the **host** `/usr/bin/sqlite3` (the container has none) into chee-owned `~/Trippy/backups/`. The production migrations table is `_migrations`.
