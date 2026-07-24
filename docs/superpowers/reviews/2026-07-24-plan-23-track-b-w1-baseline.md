# Plan 23 Track B — W1 Baseline Capture (pre-split)

**Captured:** 2026-07-24, before any W2 route-split work.
**Build:** `cd frontend; npm run build` (vite v5.4.21, vite-plugin-pwa v1.2.0).
**Tree state:** identical content hash to the review build family — graph unchanged since validation.

Purpose: the frozen "before" numbers W4 compares the post-split graph against. Per Track B
fact 1 the graph is **fully eager**, so all three representative routes fetch the identical
single chunk — per-route measurement is meaningless *before* the split and is deferred to W4,
where routes actually differ. This doc records what there is to record today: the single initial
JS artifact, the total, and the full precache manifest.

## Initial JS (the whole app, one chunk)

| Artifact | Raw | Gzip |
| --- | ---: | ---: |
| `dist/assets/index-ovjQUJlP.js` | 753.95 kB | 225.14 kB |
| `dist/assets/index-CDdzKwM3.css` | 56.71 kB | 15.07 kB |

Rollup emits **exactly one** JS chunk. Build prints "Some chunks are larger than 500 kB"
(eliminating this warning is explicitly **not** a Track B objective — fact 2).

## Representative-route request sets (all identical — fact 1)

Because `main.jsx` → `App.jsx:5-13` static-imports every page, the cold-load JS request set is
the same for every entry. Recording it once, not five times:

| Route | Initial JS request set |
| --- | --- |
| `/share/:token` | `index-ovjQUJlP.js` (the entire authenticated app ships to the public share route) |
| `/trips` | `index-ovjQUJlP.js` (every trip tab, Leaflet, all modals) |
| `/trips/:id/plan` (deep-link) | `index-ovjQUJlP.js` (same single chunk) |

There is no route-exclusive chunk to isolate today — that is the whole problem W2 addresses.
Leaflet + react-leaflet are inside this one chunk, so they load on `/share` and `/trips` even
though only Map uses them.

## Precache manifest (Workbox `generateSW`)

Build reports **`precache 9 entries (1151.32 KiB)`**. Entries in `dist/sw.js`:

| URL | revision |
| --- | --- |
| `index.html` | hashed |
| `assets/index-ovjQUJlP.js` | `null` (Vite content-hashed filename) |
| `assets/index-CDdzKwM3.css` | `null` |
| `assets/mobile-vignette-v2.webp` | `null` (Track C) |
| `assets/illustration-login-v2.webp` | `null` (Track C) |
| `manifest.webmanifest` | hashed |
| `registerSW.js` | hashed |
| `trippy-icon.svg` | hashed |
| `workbox-*.js` | (runtime) |

The `revision:null` entries are content-hashed by Vite, so a new build changes their filename
(new manifest entry) — this is what W3 must confirm still holds for the *lazy* chunks W2 adds
(fact 6: Workbox glob `**/*.{js,css,...}` auto-captures `assets/*.js`).

## What W4 will compare against this

- Post-split, `/share` / `/trips` / deep-link request sets **diverge** — record each separately.
- Compare **foreground initial-route transfer + parse/execute per entry route** (delivered/parsed
  bytes), NOT largest-chunk size and NOT warning presence (fact 2, acceptance "Outcome" row).
- Confirm every generated lazy JS/CSS asset is present in the post-split precache manifest.
