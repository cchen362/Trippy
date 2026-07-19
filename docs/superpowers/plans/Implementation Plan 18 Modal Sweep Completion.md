# Implementation Plan 18 — Modal Sweep Completion: Share/Admin/Account Sheets, DocumentViewer, ErrorBanner

**Status: COMPLETE. W1 deployed 2026-07-19 (owner prod QA PASSED). W2 (§2b) implemented 2026-07-19: navigateFallbackDenylist added to vite.config.js workbox block (W2-1) and per-chip ✕ + two-step Confirm? delete-attachment UI in the LogisticsTab detail sheet, attachment-sourced docs only (W2-2). Browser-verified at 375px + desktop in dev (attach → ✕ → Cancel and Confirm? → chip gone, sheet stays open, DB row deleted); denylist confirmed compiled into dist/sw.js. Not verifiable locally: SW-active PDF iframe behavior (W2-1) and the no-✕ import-chip branch (dev DB has no import-sourced bookings) — both covered by owner prod click-pass after deploy. No deviations from §2b scope; the client wrapper is named `bookingsApi.removeAttachment` (not deleteAttachment).**
**W1 deviations/additions:** (1) ModalShell now renders via `createPortal(document.body)` — required because the sticky `backdrop-blur-md` header hosting the admin/account triggers becomes the containing block for `position: fixed` descendants (this is why the old code portaled); orchestrator-reviewed. (2) ModalShell's body gets `pb-6 sm:pb-7` when no footer is passed — footer-less content sheets (share/admin/account) otherwise ended flush at the panel edge; footered Plan 17 modals unchanged. (3) DocumentViewer holds `onClose` in a ref so parent re-renders don't re-run the focus/scroll-lock effect. (4) Owner-flagged during QA: LogisticsTab booking detail sheet action row now wraps (`flex-wrap`) and the sheet moved z-40 → z-[110] so the CopilotFab (z-100) no longer floats over it (co-pilot panel at 199–200 still wins). (5) Owner-flagged extra scope, commit 7d27724: co-pilot FAB/panel were invisible and unreachable on the Map tab — Leaflet's internal z-indexes (panes 200–700, controls 1000) competed page-wide because the map wrapper created no stacking context, burying FAB (z-100) and panel (z-199/200). Fixed with `isolation: isolate` on the MapTab map wrapper; co-pilot stays available on Map by owner decision (same shared conversation on all four tabs). Browser-verified mobile + desktop: FAB visible, panel opens above tiles, closes via ✕.
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

## 2b. Post-deploy owner QA findings (2026-07-19, prod pass otherwise CLEAN) — follow-up wave W2

Owner prod QA passed all W1 surfaces. Two pre-existing attachment defects found (root causes verified this session; both small):

**W2-1 — PDF attachment renders Trippy-inside-Trippy (bug).** Root cause: `frontend/vite.config.js` VitePWA `workbox` block has NO `navigateFallback` denylist, so Workbox's default serves precached `index.html` for every navigation request — and an `<iframe>` load (how DocumentViewer embeds PDFs) is a navigation request. `<img>` loads are not, which is why PNGs work. Backend routes and the `/api` SPA-fallback exclusion in `backend/src/index.js` are correct; the service worker answers before the network. Only reproduces where the SW is active (prod/installed PWA). Fix: add `navigateFallbackDenylist: [/^\/api\//]` to the `workbox` config. Verify in a production build (`npm run build` + preview) — dev serves no SW.

**W2-2 — no delete-attachment UI (missing feature).** Backend `DELETE /api/bookings/:bookingId/attachments/:attachmentId` exists and is access-checked (`backend/src/services/attachments.js` `deleteAttachment`); the frontend wrapper exists (`frontend/src/services/bookingsApi.js:12` `deleteAttachment`) but no UI calls it. Fix: ✕ affordance on document chips in the LogisticsTab booking detail sheet (`frontend/src/pages/LogisticsTab.jsx` ~line 205–220), two-step Confirm? pattern matching the existing booking-delete, `#e05a5a` danger family. ONLY on `source: 'attachment'` docs — `documents[]` also contains `source: 'import'` files from import artifacts (`backend/src/services/documents.js`), which this route cannot delete; import chips get no ✕.

## 3. Out of scope

- CopilotPanel, DiscoveryPanel, DayPicker, day/booking detail sheets (own interaction contracts).
- Any collaboration/share/link/token logic; admin API behavior; document storage or URLs.
- TypeScript, new dependencies, overlay-click-to-close anywhere.
