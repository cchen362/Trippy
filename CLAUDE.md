# Trippy — Claude Code Guidelines

## What This Is
A mobile-first travel planning PWA. Logistics consolidation hub + AI-powered itinerary co-pilot.
Stack: React (Vite) + Tailwind frontend · Node.js (Express) + SQLite backend · Docker on Debian.
Design spec: `docs/superpowers/specs/2026-04-23-trippy-design.md`

---

## Non-Negotiable Engineering Rules

**No bandaiding. Ever.**
If something is broken, find the root cause and fix it. Do not patch symptoms, suppress errors, add try/catch to hide failures, or work around a bug without understanding it. Tech debt compounds — leave the codebase cleaner than you found it.

**No `// TODO` or `// FIXME` left in committed code.**
If it's not implemented, don't commit it. If it needs doing, do it now or create a tracked issue.

**Check before you assume.**
Before adding a new utility, component, or helper — grep for existing ones. Before adding a dependency — check if the existing stack already handles it.

**Fail loudly in development, gracefully in production.**
Never swallow errors silently. `console.error` at minimum; throw where appropriate in dev. User-facing errors get a clean message, not a stack trace.

**SQLite discipline.**
Always use parameterised queries (never string interpolation). Run migrations in order. Never modify existing migration files — add new ones.

---

## Design & Aesthetic Rules

**Refer to:** `docs/superpowers/specs/2026-04-23-trippy-design.md` §8 for the full design language.

**No AI Slop.**
- No Inter, Roboto, Arial, or system-ui as the primary font
- No purple gradients on white/dark backgrounds as a default reach
- No generic card layouts that could belong to any SaaS dashboard
- No clichéd color schemes — commit to the defined palette below

**The palette is fixed. Do not deviate:**
```
--ink-deep:   #0d0b09   (primary background)
--ink-mid:    #1c1a17   (cards)
--ink-surface:#232018   (elevated)
--gold:       #c9a84c   (single accent — once per component)
--cream:      #f0ead8   (primary text)
```

**Typography is fixed. Three fonts only:**
- `Playfair Display` italic — city/place names and section titles only
- `Cormorant Garamond` — body text, notes, narrative
- `DM Mono` — all UI labels, times, badges, confirmation refs

**Photography treatment:**
- Full-bleed `object-fit: cover` within card bounds
- Gradient overlay: `linear-gradient(100deg, rgba(13,11,9,0.92) 0%, rgba(13,11,9,0.30) 65%, rgba(13,11,9,0.05) 100%)`
- Transit stops: grayscale via CSS `filter: grayscale(1)`, no card, inline italic text only

**Gold accent discipline:**
Used once per component. On type badges, active indicators, confirmation refs. Never as a background fill.

---

## Mobile-First
Every component is designed for 375px width first. Desktop is a wider layout of the same component — not a separate design. Test on mobile viewport before calling anything done.

---

## API Cost Discipline
- Claude API: cache discovery results in `discovery_cache` table (48h TTL). Never call Claude for data already in cache.
- Unsplash: store fetched photo URLs on the stop/trip record. Never re-fetch what's already in DB.
- Google Places: use session tokens for autocomplete to minimise billing.

---

## File Conventions
```
/frontend/src/
  components/     UI components (one file per component)
  pages/          Route-level page components
  hooks/          Custom React hooks
  services/       API client functions
  context/        React context providers
  types/          TypeScript interfaces

/backend/src/
  routes/         Express route handlers
  services/       Business logic (no DB calls here — use db/)
  db/             SQLite queries and migrations
  middleware/     Auth and error middleware
```

## Auth Pattern
Identical to AI-HTML-Builder. Invite-code registration, httpOnly cookie sessions, `requireAuth` and `requireAdmin` middleware on protected routes.
