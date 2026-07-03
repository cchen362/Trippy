# Implementation Plan 2: Redesign Onboarding Paths

## Purpose

This document captures the product workshop around Trippy's onboarding and capture experience. It is intentionally scenario-first, so future implementation planning can work backwards from real trip-planning situations instead of starting from database fields or isolated features.

The major UX pain point is setup friction before value. Today, creating a trip asks for internal-feeling inputs such as comma-separated destinations and country codes, and adding logistics requires users to manually classify and enter booking details one by one. That makes Trippy feel like a database the user has to populate, when the stronger product promise is:

> Dump your travel chaos here, and Trippy organizes it into a usable trip workspace.

## Agreed Product Direction

Trippy should support four primary onboarding and capture paths. These paths should cover most trip-planning situations without creating decision fatigue.

### Path 1: Booked-First

**User situation:** The user has already booked part or all of the trip.

Examples:
- They have flight confirmation emails.
- They have hotel PDFs or screenshots.
- They booked trains, ferries, car rentals, or event tickets.
- They may have only one anchor booking, such as flights, with the rest still undecided.

**UX goal:** Let the user paste/upload what they already have. Trippy extracts likely bookings, dates, cities, and confirmation details, then asks the user to review and confirm before creating or updating the trip.

**Experience principle:** The user should not need to decide "flight vs hotel vs train" first. The artifact should lead, and Trippy should classify it.

### Path 2: Plan-First

**User situation:** The user has not booked anything yet, but has a rough route, rough idea, or target trip shape.

Examples:
- "Shanghai -> Suzhou -> Hangzhou -> Shanghai."
- "Japan in November, maybe Tokyo/Kyoto/Osaka."
- "I want a 7-10 day trip, not sure exactly how many nights per city."

**UX goal:** Let the user sketch route, duration, and rough city allocation without requiring exact logistics or final dates.

**Experience principle:** Rough days are a core requirement. Trip planning changes constantly, so Trippy must allow cities, arrival/departure dates, and stop lengths to move without making the user feel like they are breaking the trip.

### Path 3: Hybrid

**User situation:** The user has some fixed anchors, but much of the trip remains flexible.

Examples:
- Flights are booked, but hotels and trains are not.
- Arrival/departure dates are fixed, but the middle route is not.
- One hotel is booked, but the user still needs to fill transport and extra cities.

**UX goal:** Use confirmed bookings as anchors, then help the user plan the flexible gaps around them.

**Experience principle:** The system should clearly distinguish between hard anchors and rough planning assumptions.

### Path 4: Ongoing Capture / Existing Trip Update

**User situation:** The trip already exists, and the user later books or decides something new.

Examples:
- They book a train after creating the rough route.
- They add a hotel after flights were already imported.
- They paste a restaurant reservation, event ticket, or transfer detail.
- A collaborator adds their own booking or stop to the existing trip.

**UX goal:** Make adding new artifacts feel like continuing the trip, not reopening setup.

**Experience principle:** Collaborators do not need a separate onboarding path. They are part of this existing-trip update flow, because the current access model already lets collaborators add logistics and stops.

## Core Product Rules

The future model should be:

```text
Route segments + bookings + manual overrides -> day shells
```

### Route Segments

Route segments are the planning source before bookings exist.

Example:

```text
Shanghai -> Suzhou -> Hangzhou -> Shanghai
```

Each segment should eventually support:
- City or place
- Rough number of days or nights
- Optional exact date range
- Planning status such as idea, planned, booked, or conflict
- Linked bookings when available

### Bookings

Confirmed logistics bookings are anchors.

When a booking implies a day city, the booking should shape the day shell. This preserves the current intuitive behavior where adding a logistics booking, such as a train from Shanghai to Suzhou, causes the relevant day shell title/city to update accordingly.

Default rule:

```text
Confirmed booking wins over rough route plan.
```

### Manual Overrides

Manual user overrides are locks.

If the user manually edits a day city, Trippy should respect that override above both rough route segments and inferred booking behavior.

Default rule:

```text
Manual override wins over confirmed booking and rough route plan.
```

### Conflicts

Conflicts should be visible and fixable, not mysterious.

Example:
- Planned route says Suzhou starts on Jun 3.
- Train booking says Shanghai -> Suzhou on Jun 4.

Trippy should show the mismatch and offer a suggested resolution, such as moving Suzhou's start to Jun 4. It should not silently hide the disagreement.

Default rule:

```text
Bookings can update the plan, but meaningful disagreements should be surfaced as suggestions or conflict notices.
```

## Multi-City Rough Planning

Multi-city planning should separate route order from date allocation.

For example:

```text
Route:
Shanghai -> Suzhou -> Hangzhou -> Shanghai

Rough allocation:
Shanghai: 2 days
Suzhou: 2 days
Hangzhou: 2 days
Shanghai: 1 day
```

If exact trip dates are known, Trippy can map this allocation onto calendar dates.

If exact trip dates are not known, Trippy should use relative day shells such as Day 1, Day 2, Day 3 instead of forcing fake calendar dates.

If bookings are later added, those bookings should anchor the relevant segments and may adjust the rough allocation.

## Current UX Issues To Address Later

### New Trip Creation

The current `NewTripModal.jsx` asks for:
- Trip title
- Destinations as comma-separated text
- Country codes as comma-separated text
- Dates
- Travellers
- Interests
- Pace

This feels schema-first. A normal user expects questions like:
- Where are you going?
- Roughly when?
- What do you already have?

Country codes should not be user-facing in the main flow. They should be inferred from city/place lookup where possible.

### Add Booking

The current `AddBookingModal.jsx` contains useful building blocks, including hotel search and flight lookup, but the primary flow is still manual and form-heavy.

The future experience should make paste/upload/capture the primary path and keep manual entry as a fallback or correction path.

## Open Questions For Future Planning

- What is the minimum v1 import surface: pasted text only, or pasted text plus screenshot/PDF upload?
- Should imported artifacts be stored as raw source records for later review, or only converted into bookings?
- How should the route segment model be represented in the database?
- Should rough trips without exact dates appear in the same Plan tab, or have a separate route-planning view until dates are known?
- What is the exact conflict UI for booking-vs-route disagreements?
- How much automatic city/date inference should happen before user confirmation?
- Should the first implementation redesign `NewTripModal.jsx`, `AddBookingModal.jsx`, or introduce a new capture inbox first?

## Decisions Captured

- Use four primary paths: booked-first, plan-first, hybrid, and ongoing capture.
- Do not add collaborator-first as a separate path; collaborators fit into ongoing capture for existing trips.
- Treat idea-first as part of plan-first, not as a separate path.
- Support rough days as a non-negotiable planning behavior.
- Preserve the intuitive booking-driven day-city behavior.
- Make manual overrides the strongest signal.
- Surface conflicts instead of hiding them.
- Keep future implementation planning grounded in user scenarios and trip-planning use cases.
