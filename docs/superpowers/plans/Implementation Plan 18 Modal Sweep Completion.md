# Implementation Plan 18 — Modal Sweep Completion: Share/Admin/Account Sheets, DocumentViewer, ErrorBanner

**Status: OPEN — scoped 2026-07-19 (post-Plan-17 session), not started**
**Date:** 2026-07-19
**Baseline:** Plan 17 (CLOSED, deployed 43f83d7) built `ModalShell` and migrated the five form flows. This plan finishes the sweep for design coherence: the remaining hand-rolled overlays and the last off-palette `#f8b4b4` reds.
**Scope:** Frontend only. No backend, no data-shape changes, no new dependencies. No behavior changes beyond dialog semantics, palette, and one owner-approved affordance removal.

---

## 0. Verified facts (do not re-derive; file:line checked 2026-07-19)

- **TripShareModal** (`frontend/src/components/collaboration/TripShareModal.jsx`): hand-rolled framer overlay at z-[220], `--ink-mid` panel, `rounded-t-2xl sm:rounded-2xl`, 40px close button, no role/aria/trap/Escape/scroll-lock. Content = CollaboratorsPanel + ShareLinkCard via `useCollaboration`. Mounted conditionally by its parent (unmount-resets — no reset-on-open effect needed if the parent keeps conditional mounting, but ModalShell's `open` prop pattern is preferred; check the parent call site).
- **AdminSettingsPanel** (`frontend/src/components/admin/AdminSettingsPanel.jsx`): renders its own trigger button + `createPortal` overlay at z-[230]; same hand-rolled shell; owns invite-code + user-management state with a two-step remove-user confirm (`confirmUserId`). Loads data on open via `useEffect(open)`.
- **UserAccountButton** (`frontend/src/components/common/UserAccountButton.jsx`): trigger + portal overlay at z-[230]; **has overlay-click-to-close** (line ~52) — the only surface in the app that does.
- **DocumentViewer** (`frontend/src/components/documents/DocumentViewer.jsx`): full-screen viewer at z-[210], `--ink-deep` chrome over a deliberate near-white `#f5f3ee` content pane (QR/barcode scannability — a documented product decision, keep it). Close button has NO hit-area sizing (bare icon). No dialog semantics, no Escape, no scroll lock, no focus management.
- **ErrorBanner** (`frontend/src/components/common/ErrorBanner.jsx`): inline `role="alert"` banner (framer fade), all-`#f8b4b4` styling, `rounded-2xl`. Used by TripPage.jsx and LogisticsTab.jsx. Not a modal — do NOT put it on ModalShell.
- **LogisticsTab.jsx** stragglers: `#f8b4b4` at lines 226, 230 (attach/delete error text) and 277, 287 (detail-sheet delete-confirm buttons with `rgba(248,180,180,0.22)` borders).
- **Layering constraint:** CopilotPanel sits at z 199–200 and CopilotFab at z 100. Share/Admin/Account (220/230) and DocumentViewer (210) deliberately render **above** co-pilot chrome today. ModalShell's stack base is 40 — naive adoption would bury these sheets under an open co-pilot. Preserving current layering requires a `zBase` prop on ModalShell.
- Sanctioned tokens: `#e05a5a` destructive/error family (`.modal-danger-text/-border/-fill` in index.css:120–122); radius scale 6/12/16/pill; `.modal-shell-footer`, `.modal-loading-dots` exist. Escape/trap/scroll-lock/stack semantics all live in ModalShell (Plan 17 §2).

## 1. Owner-approved decisions (2026-07-19)

| # | Decision | Resolution |
|---|---|---|
| D1 | UserAccountButton overlay-click-to-close | **Removed.** All sheets close via explicit ✕ + Escape only, consistent with Plan 17. No `closeOnOverlay` prop is added to ModalShell. |
| D2 | DocumentViewer treatment | **Semantics only** (proposed by orchestrator, uncontested): role="dialog" + aria-label, Escape via a small local keydown (or ModalShell-less reuse of its scroll-lock/trap helpers if exported), scroll lock, focus in/return, 44px close hit area. Keep the full-screen chrome and the near-white pane exactly as-is — it must NOT become a sheet. |
| D3 | Layering | ModalShell gains an optional `zBase` prop (default 40). Share=220, Admin/Account=230, so they keep floating above co-pilot chrome. Stack-internal +10/level behavior unchanged. **ModalShell edits require orchestrator review** (unchanged Plan 17 rule). |
| D4 | ErrorBanner + LogisticsTab reds | Recolor to the `#e05a5a` family (text `#e05a5a`, borders `rgba(224,90,90,0.28)`-ish to match `.modal-danger-border`, fill tint `rgba(224,90,90,0.08)`); `rounded-2xl` → `rounded-xl`. Copy and behavior unchanged. |

## 2. Wave plan (single wave — W1)

**Model: Sonnet coders, orchestrator reviews the ModalShell diff and QAs.**

1. **ModalShell `zBase` prop** (orchestrator-reviewed): `zIndex = zBase + 10 * stackIndex`... careful — the stack is global across different zBase values; simplest correct form is `zIndex = Math.max(zBase, 40 + 10 * stackIndex)` or plain `zBase + 10 * stackIndex` with the caveat that a zBase-230 sheet stacked over a zBase-40 modal already wins. Keep it minimal; add/extend shell unit tests.
2. **Migrate TripShareModal, AdminSettingsPanel, UserAccountButton** onto ModalShell (`zBase` per D3; eyebrow/headline mapped from existing header copy; 44px close standard; footers: none needed — these are content sheets, actions stay in-body). AdminSettingsPanel keeps its trigger button and load-on-open effect; its remove-user confirm recolors to `.modal-danger-*`. UserAccountButton drops overlay-click (D1). Panels currently use `--ink-mid`; ModalShell uses `--ink-surface` — adopt `--ink-surface` for coherence (it's the sanctioned elevated tone).
3. **DocumentViewer semantics** per D2.
4. **ErrorBanner + LogisticsTab recolor** per D4.
5. **Sweep exit-check:** zero `#f8b4b4` / `rgba(248,180,180` anywhere in `frontend/src`; no hand-rolled `fixed inset-0` overlays outside ModalShell except DocumentViewer (justified full-screen) and CopilotPanel/DiscoveryPanel/DayPicker (out of scope).

**Verification:** `cd frontend; npx vitest run` + `npm run build`; 375px + desktop passes on all four surfaces; Escape/Tab on each; share sheet opened WITH the co-pilot panel open (layering per D3); DocumentViewer QR scannability pane unchanged; owner click-script for motion/feel.

## 3. Out of scope

- CopilotPanel, DiscoveryPanel, DayPicker, day/booking detail sheets (own interaction contracts).
- Any collaboration/share/link/token logic; admin API behavior; document storage or URLs.
- TypeScript, new dependencies, overlay-click-to-close anywhere.
