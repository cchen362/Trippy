# Trippy

Trippy is a private, mobile-first travel companion that turns scattered bookings, screenshots, ideas, and conversations into one clear trip.

It is built for the messy reality of travel planning: dates change, bookings arrive through different channels, good ideas appear halfway through planning, and the information you need at the airport is rarely in the same place as the plan for dinner.

Trippy brings those pieces together without forcing the trip into a rigid schedule.

Access is invite-only, keeping the planning workspace intentionally private.

## From Travel Chaos to a Usable Trip

With Trippy, travellers can:

- Create a trip around dates, destinations, interests, pace, and travel style
- Turn confirmation emails, pasted text, screenshots, and PDFs into reviewed booking drafts
- Keep flights, hotels, trains, tickets, rentals, and reservation documents together
- Build each day as a flexible timeline of places, meals, activities, transit, and notes
- Browse destination ideas and add promising places directly to a chosen day
- See the day's stops and travel sequence on a map
- Check what matters now while the trip is underway
- Plan privately with collaborators or share a clean public itinerary
- Ask the co-pilot for help and review every proposed itinerary change before applying it

## The Main Experience

### Trips

The Trips screen is the starting point for upcoming, active, and past journeys. A trip carries its dates, planning destinations, traveller preferences, collaborators, and the evolving day-by-day plan.

Destinations are not treated as a single fixed label. A trip can span cities, regions, and countries, while each day can reflect where the traveller is actually staying or exploring.

### Today

When a trip is in progress, Trippy shifts into a more immediate Today view. It brings forward what has already happened, what is happening now, what comes next, and where the traveller is staying tonight.

Flights can be checked deliberately for current status, important travel documents remain close to the relevant booking, and navigation opens in the appropriate map experience for the destination.

Today is a focused view of the same itinerary—not a separate schedule to maintain.

### Plan

Plan is the trip's editable day-by-day timeline. Each day can contain timed or untimed stops for places, meals, experiences, transit, and booking-linked movements.

Stops can include:

- Time and duration
- Notes and practical details
- Estimated cost and best-time guidance
- A representative photo
- A resolved, estimated, or manually confirmed map location

Stops can be reordered, moved between days, edited, or removed as the trip develops. An unsuitable photo can be replaced without rebuilding the stop. Transit remains visually subordinate so the experiences still define the character of the day.

Travellers can also add a place by searching for it directly, with its location carried into the itinerary and map.

### Discover

Discover helps answer the question, “What would I miss if I only planned from what I already know?”

Suggestions are organized around interests such as essentials, culture, food, nature, nightlife, architecture, wellness, and hidden gems. Results are grounded in the destination, ranked for the trip, and can be added directly to a selected day.

Returning to a destination brings back its existing collection instead of starting over. Travellers can ask for more ideas, try the surprise picker, search for a specific place, or report an unsuitable result without losing the rest of their suggestions.

### Logistics

Logistics keeps the trip's operational details in one place:

- Flights with route, schedule, terminal, timezone, and confirmation details
- Hotels with address, check-in, check-out, and stay length
- Trains with stations, timing, class, and booking information
- Tickets, events, ferries, car rentals, and other reservations

A booking can appear in the day plan when it belongs in the itinerary, or remain in Logistics when it is useful reference material only.

#### Capture bookings from what you already have

Travellers do not need to retype every reservation. Trippy can accept pasted text, images, and PDFs, extract the likely booking details, and present them for review before anything is added to the trip.

The original material stays attached to the import, making it possible to return to the actual ticket or confirmation instead of trusting an extraction blindly.

Booking documents can also be attached manually and opened again from Logistics or the relevant Today card.

### Map

The Map view shows the selected day's stops in itinerary order. It distinguishes places with confirmed locations from those that are estimated or still unresolved.

Travellers can place a missing stop, correct an estimated pin, and open navigation in Google Maps, Amap, or Naver Maps as appropriate. Multi-city trips can change map behavior from one day to the next without manual configuration.

### Co-Pilot

The co-pilot is a planning partner inside the trip, presented as a bottom sheet so the itinerary remains visible during the conversation.

It can:

- Answer questions using the current trip
- Search the trip's destination catalogue for grounded recommendations
- Check for practical itinerary problems such as unresolved places or awkward timing
- Propose adding, updating, moving, or removing stops

The co-pilot never applies itinerary changes silently. Every suggested change becomes a visible proposal that the traveller can inspect, apply, or reject. Proposals survive refresh, warn when user-authored details could be lost, and refuse to apply if the trip has changed enough to make the suggestion stale.

### Collaboration and Sharing

Invited collaborators can plan a private trip together. The owner controls who has access and can remove collaborators when needed.

For everyone else, Trippy can create a revocable public link with a clean, read-only itinerary. Public viewers see the trip plan without private booking confirmations, documents, co-pilot history, collaborator details, or editing controls.

## Designed for Travel, Not a Dashboard

Trippy is designed at phone width first and can be installed to a home screen like an app. The desktop experience gives the same trip more room rather than turning it into a different product.

The visual language combines warm near-black surfaces, cream typography, restrained gold accents, editorial photography, and travel-specific card treatments. City names and narrative details receive a different typographic voice from times, codes, labels, and confirmation references.

The intended feeling is a private travel dossier: calm enough to use during planning, fast enough to check while moving, and distinctive enough to feel connected to the trip itself.

## What Trippy Does Not Pretend to Be

Trippy currently favors deliberate planning over automation. It does not silently rearrange an itinerary, continuously poll flight data, provide offline editing, or attempt real-time simultaneous collaboration.

Weather, expense splitting, currency conversion, route-time analysis, and export formats are also outside the current product. When these capabilities are added, they should strengthen the shared trip rather than become disconnected mini-tools.

## Project Documentation

The repository's product and engineering references live here:

- [`AGENTS.md`](AGENTS.md) — engineering rules and current repository conventions
- [`docs/superpowers/specs/2026-04-23-trippy-design.md`](docs/superpowers/specs/2026-04-23-trippy-design.md) — living product and architecture specification
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — implementation history and explicitly unfinished work

The README intentionally stays focused on what Trippy does and how it behaves. Setup, deployment, provider configuration, and detailed architecture belong in the internal documentation above.
