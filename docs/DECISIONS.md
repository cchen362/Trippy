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
| **Place-naming / resolver strategy — CLOSED** | **Precision over polish. No resolver change.** Nominatim first, Google Places only as fallback. Do not re-propose reordering the chain, a Google-first path, or wider naming coverage. ~28% named-card coverage is the intended output. | The `searchGooglePlaces` fallback comment, `backend/src/services/placeResolver.js`; owner, 2026-07-26 |
| **Co-pilot v1** | No undo. A loss-warning before applying is the chosen treatment. Booking-linked stops are untouchable by co-pilot proposals. A proposal applies as one unit — no selective per-operation apply. | Clause by clause: `Plan 11 D5` above `applyProposal` (no undo) and `Plan 11 D6` above the booking-linked guard, both `backend/src/services/copilotProposals.js`; `computeLossWarnings` in the same file (the loss warning); `Plan 11 D11` in `frontend/src/components/copilot/MutationPreview.jsx` (one unit) |

## Superseded or hollowed-out — do not re-stamp

The 2026-07-30 Plan 1–23 marker backfill deliberately left these unmarked. They are recorded here so a future triage does not rediscover them in the plan docs, see no marker, and stamp a ruling that no longer holds.

| Decision | Status |
|---|---|
| **Plan 7 decision 1** — "show unverified items with an *Unverified* badge, rank-penalized" | **Half superseded.** The badge is dead: `D-27-1` shows "Verified" or no label at all, and never surfaces `pending`/`unverified` as user-facing words. The rank penalty is **still live** — `computeScore`'s `3.0 · verified` term in `backend/src/services/discoveryRank.js`. Do not stamp the badge half; it would contradict `D-27-1`. |
| **Plan 10 D5** — "no scene-pool caching initially" | **Behaviour stands, premise is gone.** There is still no scene pool. But the stated reason was the Unsplash *demo* tier, and production is now granted 1,000 req/hr, so this is no longer a settled decision — it is an unexamined default. Treat it as open, not closed, if it ever comes up. |

**Not superseded, despite looking it:** Plan 7 decision 3 (report ⇒ immediate global suppress + audit log) is live and already marked at `backend/src/routes/discovery.js` — Plan 26's archive/suppress split sits alongside it, it did not replace it.

## Decisions with no code home

These live here because nothing in the codebase records them — each is an external-service fact, a corpus-level policy, or an ops detail that no single file governs.

**This section is complete by design, not a backlog.** Prose here does not mean "not yet backfilled with a code marker"; it means a code marker would have nowhere honest to sit. Do not hunt for code homes for these entries. If a future change *gives* one of them a real code home, move it up to the table above and leave a marker at the anchor — that is what happened to the place-naming ruling on 2026-07-30.

### Unsplash API tier — CLOSED

**2026-07-28, owner.** Production tier is **granted at 1,000 requests/hour**. This is no longer a pending application or a constraint to design around. Do not re-propose applying for production access, and do not add rate-limit workarounds premised on the demo tier.

Standing constraints (how it works, not a decision): a single app-wide key is shared with agent diagnostics; each photo action costs a fetch; a throttled fetch leaves the photo `NULL`, recoverable via `backfillTripPhotos`.

The tier itself is an account fact with no code home, so it stays here — but the "no demo-tier workarounds" half of the ruling *does* govern code, and is marked above `search()` in `backend/src/services/unsplash.js`.

### Discovery catalogue — no rebuild

**2026-07-26 → 2026-07-28, Plan 26.** The catalogue is repaired incrementally, never rebuilt. The verified corpus is large (880+ active verified rows) and a rebuild would spend real provider money to regress it. Repair work is bounded and idempotent.

### Production server facts

Not a decision, but facts agents keep re-deriving: the app runs on port **6768** (not 3001), in container `trippy-trippy-1`. Production `~/Trippy/data` is root-owned with no passwordless sudo — take backups with the **host** `/usr/bin/sqlite3` (the container has none) into chee-owned `~/Trippy/backups/`. The production migrations table is `_migrations`.
