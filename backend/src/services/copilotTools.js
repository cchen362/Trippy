// Native tool-use protocol for the co-pilot (Plan 11 Wave 1). The model proposes
// itinerary changes ONLY by calling this tool — never via prose or fenced JSON. The
// server re-validates and persists the proposal (Plan 11 Wave 2); this schema is the
// source of truth the Wave 2 validation mirrors.
export const PROPOSE_ITINERARY_CHANGES_TOOL = {
  name: 'propose_itinerary_changes',
  description:
    'Propose a set of changes to the trip itinerary for the traveller to review and confirm. ' +
    'Call this ONLY when the user wants to change the itinerary — never to answer a question or ' +
    'give advice. All operations are proposed together as one reviewable unit; the traveller sees ' +
    'a preview and explicitly applies or rejects them. Never propose changes to booking-linked ' +
    'stops (they are managed in Logistics).',
  input_schema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description: 'One or more itinerary operations to apply together as a single unit.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['add_stop', 'remove_stop', 'move_stop', 'update_stop'],
              description: 'Which kind of change this operation makes.',
            },
            dayId: {
              type: 'string',
              description: 'add_stop only: id of the day to add the stop to (use a real dayId from the itinerary).',
            },
            stop: {
              type: 'object',
              description: 'add_stop only: the new stop to create.',
              properties: {
                title: { type: 'string', description: 'Name of the place or activity.' },
                type: {
                  type: 'string',
                  enum: ['experience', 'food', 'explore', 'transit'],
                  description:
                    "Kind of stop: 'experience' for attractions/activities, 'food' for meals, " +
                    "'explore' for open-ended wandering, 'transit' for a short journey note. " +
                    'Hotels and booked flights/trains come from Logistics — never create them here.',
                },
                time: {
                  type: ['string', 'null'],
                  description:
                    'Clock time as 24-hour "HH:MM", or null. Use null unless the user explicitly asked ' +
                    'for a specific time. Never invent a time to fill a slot.',
                },
                note: { type: ['string', 'null'], description: 'Optional short note.' },
                lat: { type: ['number', 'null'], description: 'Optional latitude if confidently known; otherwise null.' },
                lng: { type: ['number', 'null'], description: 'Optional longitude if confidently known; otherwise null.' },
              },
              required: ['title', 'type'],
            },
            stopId: {
              type: 'string',
              description: 'remove_stop / move_stop / update_stop: id of the target stop (use a real stopId from the itinerary).',
            },
            toDayId: {
              type: 'string',
              description: 'move_stop only: id of the day to move the stop to.',
            },
            position: {
              type: 'integer',
              minimum: 0,
              description: "move_stop only: 0-based index for where the stop should sit within the target day's ordered stops.",
            },
            fields: {
              type: 'object',
              description:
                'update_stop only: the fields to change. Only these fields may be updated. To move a stop ' +
                'to another day use move_stop instead — dayId and photo fields cannot be changed here.',
              properties: {
                title: { type: 'string' },
                type: { type: 'string', enum: ['experience', 'food', 'explore', 'transit'] },
                time: { type: ['string', 'null'], description: '24-hour "HH:MM" or null. Same timing rules as add_stop.' },
                note: { type: ['string', 'null'] },
                duration: { type: ['string', 'null'], description: 'Soft duration hint, e.g. "~2h".' },
                estimatedCost: { type: ['string', 'null'] },
                bestTime: { type: ['string', 'null'], description: 'Best time of day, e.g. "morning".' },
              },
              additionalProperties: false,
            },
          },
          required: ['action'],
        },
      },
    },
    required: ['operations'],
  },
};

// Read-only query tool (Plan 12 Wave 1, G1/G2/G8). Executed server-side via a tool_result
// round-trip in the agentic loop (claude.js) — never terminal. destination is free text
// matched against the trip's own scopes; anything off-trip returns out_of_scope (G4) with
// no catalogue read and no generation.
export const SEARCH_DISCOVERY_CATALOGUE_TOOL = {
  name: 'search_discovery_catalogue',
  description:
    "Search Trippy's verified discovery catalogue for real places in a destination on this trip. " +
    'ALWAYS call this before recommending or naming any specific new place to add to the itinerary — ' +
    'never invent or recall places from general knowledge. Only works for destinations that are part ' +
    "of this trip (see the itinerary's destinations and day cities); for anywhere else it returns " +
    'catalogueState "out_of_scope" and you should suggest the traveller add that destination to the ' +
    "trip first. Results are capped and may be thin or empty for a destination Trippy hasn't built up " +
    'yet — always relay catalogueState honestly rather than filling gaps yourself.',
  input_schema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description: 'City or place name from this trip\'s itinerary, e.g. "Kyoto" or "Chengdu". Must be a destination already on the trip.',
      },
      query: {
        type: 'string',
        description: 'Optional free-text keyword filter matched against place name, local name, aliases, description, and why-go text. Use for specific keywords ("rooftop", "xiaolongbao"); for broad needs like "somewhere for dinner" prefer the category filter (e.g. category "food") so results are not over-narrowed.',
      },
      category: {
        type: 'string',
        enum: ['essentials', 'food', 'nature', 'culture', 'nightlife', 'architecture', 'wellness', 'hidden_gems'],
        description: 'Optional category filter.',
      },
    },
    required: ['destination'],
  },
};

// D9 minimized co-pilot context. Derived from getTripDetail(); KEEPS confirmationRef and
// marks booking-linked stops (so the model can honor the D6 off-limits rule), DROPS booking
// document metadata, details_json, coordinates, photo/resolution noise, and everything else
// the model does not need to reason about the itinerary. Trip data stays in the system prompt
// (cache economics favor it) — there is no query layer.
export function copilotTripContext(tripDetail) {
  const { trip, days, bookings } = tripDetail;
  return {
    trip: {
      title: trip.title,
      startDate: trip.startDate,
      endDate: trip.endDate,
      travellers: trip.travellers,
      pace: trip.pace,
      interestTags: trip.interestTags,
      destinations: trip.destinations,
      destinationCountries: trip.destinationCountries,
    },
    days: (days || []).map((day) => ({
      id: day.id,
      date: day.date,
      city: day.resolvedCity ?? day.city ?? null,
      stops: (day.stops || []).map((stop) => ({
        id: stop.id,
        title: stop.title,
        type: stop.type,
        time: stop.time ?? null,
        note: stop.note ?? null,
        bookingLinked: stop.bookingId != null,
      })),
    })),
    bookings: (bookings || []).map((b) => ({
      id: b.id,
      type: b.type,
      title: b.title,
      confirmationRef: b.confirmationRef ?? null,
      startDatetime: b.startDatetime ?? null,
      endDatetime: b.endDatetime ?? null,
      origin: b.origin ?? null,
      destination: b.destination ?? null,
    })),
  };
}
