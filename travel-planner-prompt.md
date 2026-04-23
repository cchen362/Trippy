# Travel Planner App — Claude Code Build Brief

## Context
I want to build a full travel planning web app in Claude Code (React + Node/JS stack). 
This brief is the result of a detailed planning conversation where two core pain points 
were identified. The app should solve both.

---

## Pain Point 1 — The Discovery Gap

Most AI travel tools only organise what the user already knows. If I ask for a 
Chengdu itinerary and I already know about Wuhou Shrine, Wide & Narrow Alleys, 
and the Panda Base — I get those back, organised. But a first-time traveller who 
hasn't done any research gets a thin, generic output because they don't know what 
to ask for.

**The app needs a proactive discovery layer.** Given:
- Destination city/region
- Travel dates and duration
- Traveller profile (couple, family, solo, group)
- Interest tags (food, history, nature, nightlife, temples, art, etc.)
- Pace preference (packed vs relaxed)

The app should surface attractions, neighbourhoods, and experiences the user 
*didn't know to ask for* — ranked by relevance to their profile. The user then 
accepts, rejects, or modifies suggestions to build their itinerary. This shifts 
the UX from "input organiser" to "intelligent travel co-pilot."

The discovery layer should use the Claude API (claude sonnet 4.6) with 
web search tool enabled to pull current, real information — not just training data. 
This is important because attractions open/close, new spots emerge, and seasonal 
factors matter.

---

## Pain Point 2 — Map Provider Fragmentation

Google Maps is the default choice for most apps, but it performs poorly or is 
restricted in several major travel destinations:

| Country/Region | Recommended Provider | Notes |
|---|---|---|
| China (Mainland) | Amap (Gaode) / Baidu Maps | Google Maps severely limited; Amap is the most accurate |
| South Korea | Naver Maps or Kakao Maps | Google Maps lacks detailed Korean transit/POI data |
| Japan | Google Maps is OK, but Yahoo Japan Maps / Navitime better for transit | |
| Russia | Yandex Maps | Google limited in some areas |
| Most other destinations | Google Maps | Standard |

The app needs a **region-aware map abstraction layer** — a routing module that 
detects the destination country and selects the appropriate map provider or embed 
strategy. The map component should be provider-agnostic at the UI level, with the 
provider resolved at runtime based on destination.

For countries where embedded interactive maps are restricted (e.g. Baidu requires 
API key registration in China), the fallback should be a clean static map with 
deep-link buttons that open the correct native app (Amap, Naver, etc.) on mobile.

For China, if API registration is too much of a hassle due to regulation, it seems like Apple Maps works OK too? Research and confirm this. 
---

## Core Feature Set (v1)

### 1. Trip Setup Flow
- Input: destination(s), dates, traveller profile, interest tags, pace preference
- Output: skeleton itinerary with AI-suggested stops, grouped by day and proximity

### 2. Discovery Panel
- Sidebar or modal that shows AI-generated attraction recommendations
- Grouped by category: Culture & History, Food & Drink, Nature, Nightlife, Hidden Gems
- Each suggestion has: name, short description, why it matches the traveller profile, 
  estimated duration, opening hours if known
- User can drag suggestions into the day timeline or dismiss them
- "Surprise me" button that surfaces lesser-known spots beyond the obvious

### 3. Day Timeline View
- Day-by-day tab navigation
- Each stop shows: time, icon, title, type badge (Food / Explore / Transit / Experience)
- Expandable stop cards with full notes
- Stops grouped intelligently by geographic proximity (not just dumped in order)
- Visual indicator for transit time between stops
- City/phase colour coding (useful for multi-city trips)

### 4. Natural Language Edit Interface
- A command bar where the user types plain English instructions:
  - "Move Wenshu Monastery to June 16 morning"
  - "Replace the river cruise with something more low-key"
  - "Add a good hotpot dinner after Wuhou Shrine"
  - "What's near Ciqikou that I haven't added yet?"
- The Claude API interprets the command, modifies the itinerary JSON, and re-renders
- Edit history with undo support

### 5. Map View
- Per-day map showing all stops for that day
- Region-aware provider (see Pain Point 2)
- Deep-link buttons per stop: "Open in Google Maps / Amap / Naver Maps"
- Metro/transit line overlay where available

### 6. Practical Info Layer
- Per-stop: estimated cost, booking required (yes/no), best time to visit
- Per-day: estimated total spend, total walking distance
- Trip-level: packing suggestions based on activities, weather note for travel month

### 7. Export
- Export full itinerary as PDF (print-friendly)
- Export as JSON (for re-importing or sharing)
- Share link (read-only view)

---

## Data Architecture

```
/data
  itinerary.json     — source of truth for all trip data
  user-profile.json  — traveller preferences and profile
  
itinerary.json schema:
{
  "trip": {
    "title": "string",
    "destinations": ["string"],
    "dates": { "start": "ISO date", "end": "ISO date" },
    "travellers": "string"
  },
  "days": [
    {
      "date": "string",
      "city": "string",
      "phase": "string",  // for colour coding
      "hotel": "string",
      "theme": "string",
      "stops": [
        {
          "id": "string",
          "time": "string",
          "icon": "string",
          "title": "string",
          "type": "transit|food|explore|experience|hotel|rest",
          "note": "string",
          "location": { "lat": number, "lng": number },
          "practical": {
            "estimatedCost": "string",
            "bookingRequired": boolean,
            "bestTime": "string",
            "duration": "string"
          }
        }
      ]
    }
  ]
}
```

---

## Technical Stack

- **Frontend**: React (Vite), Tailwind CSS
- **AI Layer**: Anthropic Claude API (Claude Sonnet 4.6) with web search tool
- **Map abstraction**: Provider-agnostic MapView component, region resolver utility
- **State**: React state + JSON file as data layer (no database needed for v1)
- **Export**: react-pdf or html2canvas for PDF export

---

## Design Direction

Reference aesthetic: dark theme, editorial/refined, clear typographic hierarchy. The app should feel like a premium travel tool, not a generic CRUD app.

<frontend_aesthetics>
You tend to converge toward generic, "on distribution" outputs. In frontend design, this creates what users call the "AI slop" aesthetic. Avoid this: make creative, distinctive frontends that surprise and delight. Focus on:
 
Typography: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics.
 
Color & Theme: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.
 
Motion: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions.
 
Backgrounds: Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.
 
Avoid generic AI-generated aesthetics:
- Overused font families (Inter, Roboto, Arial, system fonts)
- Clichéd color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character
 
Interpret creatively and make unexpected choices that feel genuinely designed for the context. Vary between light and dark themes, different fonts, different aesthetics. You still tend to converge on common choices (Space Grotesk, for example) across generations. Avoid this: it is critical that you think outside the box!
</frontend_aesthetics>
"""

---

## Build Approach

Start with this sequence:
1. Project scaffold (Vite + React + Tailwind)
2. Data layer — itinerary.json schema + sample data (use the Chengdu/Chongqing 
   trip from this brief as seed data)
3. Core UI — Day tabs + Stop card timeline
4. Map abstraction layer — MapView component + region resolver
5. Discovery panel — Claude API integration with web search
6. Natural language edit bar — Claude API command interpreter
7. Practical info layer
8. Export

Tackle one layer at a time, confirm it works before moving to the next.

---

## Reference: Seed Data (Chengdu + Chongqing Trip)

Use this trip as the sample dataset to build and test against:

- **Trip**: Kuala Lumpur → Chengdu → Chongqing → Chengdu → KL
- **Dates**: June 8–17, 2025
- **Travellers**: Couple, not early risers (start ~11am most days), mid-range budget, 
  love spice, first time in both cities, interests: food, culture, history, nature, 
  city vibes
- **Hotels**: Waldorf Astoria Chengdu (Jun 8), Regent Chongqing (Jun 9–13), 
  W Chengdu (Jun 13–17)
- **Key itinerary logic already established**:
  - Chongqing attractions grouped around Jiefangbei/Hongya Cave (city center), 
    Ciqikou (west), Chaotianmen (east), Nanshan (south)
  - Chengdu grouped into metro clusters: Line 1 (Wenshu), Line 3 N/S 
    (Panda Base ↔ Wuhou), Line 4 W (Du Fu + Wide & Narrow Alleys), 
    Jinjiang zone (Taikoo Li + Dongmen Pier + Jiu Yan Bridge near W Hotel)
  - June 15 is Dujiangyan day trip: early departure, Panda Valley AM, 
    Irrigation System PM into night lights, late train back (21:22 or 21:55)
  - China = use Amap as map provider, not Google Maps

---

## What I Want From This Conversation

I want to build this end-to-end in Claude Code. Start by confirming you understand 
the full scope, ask any clarifying questions upfront, then propose the exact file 
structure and component breakdown before writing any code. We build layer by layer, 
confirm each one works, then move to the next.
