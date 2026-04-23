# Plan 3: Map View + Discovery Panel + Co-pilot Chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map view with region-aware tile provider (Amap for China, OSM elsewhere), AI-powered discovery panel (Claude + web search), and the co-pilot chat (FAB → slide-up panel with streaming responses and itinerary mutation).

**Prerequisite:** Plan 2 complete and verified.

**Architecture:** Leaflet + react-leaflet for maps; `Leaflet.ChineseTmsProviders` for Amap tiles in China. Claude API via backend proxy (never expose API key to frontend) with SSE streaming for co-pilot. Discovery results cached in `discovery_cache` table (48h TTL keyed by destination + interest hash).

**Tech Stack:** react-leaflet, leaflet, leaflet-providers, @anthropic-ai/sdk (backend), eventsource (SSE streaming)

**Design spec:** `docs/superpowers/specs/2026-04-23-trippy-design.md` — §7.5 Map, §7.6 Co-pilot, §7.7 Discovery, §9 API Integration, §10 Map Strategy

---

## File Map

```
/backend/src/
  routes/
    map.js              # GET /api/trips/:id/map-config (tile provider, region)
    discovery.js        # POST /api/trips/:id/discover (Claude + web search, cached)
    copilot.js          # POST /api/trips/:id/copilot (streaming SSE)
  services/
    claude.js           # Anthropic SDK wrapper — discovery + copilot
    mapConfig.js        # region → tile provider resolver

/frontend/src/
  pages/
    MapTab.jsx          # full implementation replacing Plan 2 placeholder
  components/
    map/
      TripMap.jsx           # react-leaflet map with region-aware tiles
      StopMarker.jsx        # custom gold pin marker
      OpenInMapsButton.jsx  # deep-link to Google Maps / Amap / Naver
    discovery/
      DiscoveryPanel.jsx    # slide-up panel with grouped suggestions
      SuggestionCard.jsx    # drag-to-timeline card
    copilot/
      CopilotFab.jsx        # floating action button
      CopilotPanel.jsx      # full-height slide-up chat
      CopilotMessage.jsx    # message bubble (user/assistant)
  hooks/
    useDiscovery.js
    useCopilot.js
    useMapConfig.js
```

---

## Tasks (to be expanded by executing agent)

### Task 1: Backend — map config API (region resolver)
### Task 2: Backend — Claude service (shared Anthropic SDK wrapper)
### Task 3: Backend — Discovery API with caching
### Task 4: Backend — Co-pilot API with SSE streaming + itinerary mutation
### Task 5: Frontend — Map tab with Leaflet + region-aware tiles
### Task 6: Frontend — Stop markers + deep-link buttons
### Task 7: Frontend — Discovery panel + suggestion cards
### Task 8: Frontend — Co-pilot FAB + slide-up chat panel
### Task 9: Frontend — Streaming message rendering

**Verification checklist:**
- [ ] Map shows correct tiles for China destinations (Amap, not OSM)
- [ ] Map shows OSM tiles for non-China destinations
- [ ] "Open in Amap" deep-link opens correct coordinates in Amap
- [ ] Discovery panel loads suggestions grouped by category
- [ ] Discovery results for same destination+tags served from cache on second request
- [ ] Co-pilot chat streams responses character-by-character
- [ ] "It's raining, adjust today to indoor" mutates the itinerary correctly
- [ ] Confirmed changes persist after page refresh
- [ ] FAB visible on Plan, Logistics, and Map tabs

**Next:** [Plan 4 — Collaboration, PWA, Polish](./2026-04-23-plan-4-pwa-polish.md)
