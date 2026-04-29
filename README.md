# Trippy

Trippy is a private, mobile-first travel planner for turning a trip from scattered notes into a clear, shared itinerary.

It brings the day plan, bookings, map, destination ideas, and planning conversation into one place, so travellers can see what is happening next without digging through chats, confirmation emails, screenshots, and half-finished lists.

## What It Helps With

Trippy is built for the messy middle of travel planning: when dates are set, ideas are still moving, bookings are arriving from different places, and more than one person needs to stay aligned.

Use it to:

- Create trips with destinations, travel dates, traveller style, pace, and interests
- Plan each day as an editable timeline of places, meals, activities, transit, and notes
- Keep flights, trains, hotels, tickets, and other bookings next to the itinerary
- Browse destination suggestions by interest and add promising ideas directly into a day
- See each day's stops on a map, including booking-linked itinerary items
- Share plans with collaborators or publish a public itinerary view
- Ask the built-in co-pilot questions and preview suggested itinerary edits before applying them

## Main Experience

### Trip Dashboard

The home screen groups journeys into active, upcoming, and past trips. Each trip opens into a focused planning workspace with three primary views: Plan, Logistics, and Map.

### Day-By-Day Planning

The Plan view is the heart of Trippy. Each day has its own timeline, city context, and ordered stops. Stops can include time, duration, type, notes, estimated cost, best-time hints, and location metadata. Plans can be rearranged, moved between days, expanded for notes, or removed as the trip evolves.

### Discovery

The Discover panel helps fill the itinerary with destination ideas. Suggestions are grouped into categories such as essentials, culture, food, nature, nightlife, architecture, wellness, and hidden gems. A surprise picker can surface an unexpected option, and any suggestion can be added directly to a selected day.

### Logistics

The Logistics view keeps bookings organized by type:

- Flights, with schedule lookup and timezone-aware departure and arrival details
- Hotels, with place search, address details, check-in and check-out times
- Trains, with stations, cities, seat class, and timezone fields
- Other bookings, such as tickets, rentals, events, or reservations

Bookings can optionally appear in the itinerary so travel movements and reservations stay visible in the day plan.

### Map

The Map view shows the selected day's route sequence and pinned stops. It supports resolved, estimated, and manually confirmed locations, with controls to place unresolved stops or correct estimated pins.

### Collaboration And Sharing

Trips can be shared with collaborators for private planning. Trippy also supports public share links, giving others a clean read-only itinerary view without exposing the full planning workspace.

### Co-Pilot

The co-pilot is an in-app planning assistant. It can answer questions about the trip and propose itinerary changes. Suggested edits are shown as a preview first, so the traveller can apply or reject them deliberately.

## Product Feel

Trippy is intentionally mobile-first and app-like. It is designed for checking plans on the go, making small edits quickly, and keeping the full trip legible from a phone. The interface favors a quiet, cinematic travel mood while keeping the core workflows practical: plan the day, find the booking, check the map, share the plan.

It also includes PWA-friendly behavior, including a standalone app manifest and cached trip/share views for a smoother mobile experience.

## Project Shape

This repository contains the Trippy frontend and backend:

- `frontend/` contains the React app, routing, PWA setup, itinerary UI, map UI, logistics forms, discovery panel, collaboration views, and co-pilot interface.
- `backend/` contains the API, authentication, trip data, bookings, collaboration, sharing, map/location services, discovery, and co-pilot integration.

The README is intentionally product-focused. Setup details, environment variables, deployment choices, and service configuration should live in separate internal docs when needed.
