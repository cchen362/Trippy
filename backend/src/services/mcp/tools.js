// Plan 28 W1: read-only MCP tools backing the hosted /mcp server. Every tool
// here is a thin translation layer over the same trip services the REST API
// already uses — no parallel read path, no ad-hoc SQL (F-28-11).
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { assertTripAccess, getTripDetail, listTripsForUser } from '../trips.js';

function requireScope(scopes, needed) {
  if (scopes.includes(needed)) return null;
  return {
    isError: true,
    content: [{ type: 'text', text: `This token lacks the ${needed} scope.` }],
    structuredContent: { error: 'insufficient_scope', requiredScope: needed },
  };
}

function notFoundResult() {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Trip not found.' }],
    structuredContent: { error: 'not_found' },
  };
}

function tripSummary(trip, appUrl) {
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate,
    endDate: trip.endDate,
    status: trip.status,
    destinations: (trip.destinationsGeo || []).map((geo) => ({
      city: geo.name,
      countryCode: geo.countryCode,
    })),
    url: `${appUrl}/trips/${trip.id}`,
  };
}

function formatTripLine(trip) {
  return `"${trip.title}" (${trip.startDate} → ${trip.endDate}, ${trip.status})`;
}

export function registerReadTools(server, { userId, scopes, appUrl }) {
  server.registerTool(
    'list_trips',
    {
      title: 'List trips',
      description:
        'Lists the trips this user owns or collaborates on. Read-only. Past trips are ' +
        'excluded unless includePast is true. query filters case-insensitively by trip ' +
        'title or destination city name.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring match on title or destination city.' },
          // Q-28-2: past trips are noise for the common "what's next" ask, so they are
          // opt-in rather than opt-out.
          includePast: { type: 'boolean', description: 'Include trips that have already ended. Defaults to false.' },
        },
      }),
    },
    async (args) => {
      const scopeError = requireScope(scopes, 'trips:read');
      if (scopeError) return scopeError;

      const includePast = args?.includePast === true;
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';

      let trips = listTripsForUser(userId);
      if (!includePast) trips = trips.filter((trip) => trip.status !== 'past');
      if (query) {
        trips = trips.filter((trip) => {
          if (trip.title.toLowerCase().includes(query)) return true;
          return (trip.destinationsGeo || []).some((geo) => geo.name?.toLowerCase().includes(query));
        });
      }

      const summaries = trips.map((trip) => tripSummary(trip, appUrl));
      const text = summaries.length
        ? `${summaries.length} trip${summaries.length === 1 ? '' : 's'}: ${trips.map(formatTripLine).join('; ')}`
        : 'No trips found.';

      return {
        content: [{ type: 'text', text }],
        structuredContent: { trips: summaries },
      };
    },
  );

  server.registerTool(
    'get_trip',
    {
      title: 'Get trip detail',
      description:
        'Fetches one trip by id, including its status and destinations. Read-only. ' +
        'Pass include: ["days"] and/or ["bookings"] to also fetch the day-by-day ' +
        'itinerary (resolved city/country, stop count) and logistics bookings ' +
        '(confirmation ref, times, document count).',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          tripId: { type: 'string', description: 'The trip id.' },
          include: {
            type: 'array',
            items: { type: 'string', enum: ['days', 'bookings'] },
            description: 'Optional additional sections to include.',
          },
        },
        required: ['tripId'],
      }),
    },
    async (args) => {
      const scopeError = requireScope(scopes, 'trips:read');
      if (scopeError) return scopeError;

      const tripId = args?.tripId;
      const include = Array.isArray(args?.include) ? args.include : [];

      let detail;
      try {
        // D-28-7: userId from the token's authInfo is passed straight into the same
        // assertTripAccess() the REST API uses — a token can read exactly what its
        // owning user can read (owner or collaborator), no separate access rule.
        assertTripAccess(userId, tripId);
        detail = getTripDetail(tripId, userId);
      } catch (error) {
        if (error.status === 404) return notFoundResult();
        throw error;
      }

      const result = {
        trip: tripSummary(detail.trip, appUrl),
      };

      if (include.includes('days')) {
        result.days = detail.days.map((day) => ({
          id: day.id,
          date: day.date,
          resolvedCity: day.resolvedCity,
          resolvedCountry: day.resolvedCountry,
          stopCount: day.stopCount,
        }));
      }

      if (include.includes('bookings')) {
        result.bookings = detail.bookings.map((booking) => ({
          id: booking.id,
          type: booking.type,
          title: booking.title,
          confirmationRef: booking.confirmationRef,
          startDatetime: booking.startDatetime,
          endDatetime: booking.endDatetime,
          origin: booking.origin,
          destination: booking.destination,
          originTz: booking.originTz,
          destinationTz: booking.destinationTz,
          documentCount: booking.documents.length,
          url: `${appUrl}/trips/${tripId}/logistics`,
        }));
      }

      const text = `${formatTripLine(result.trip)}${result.days ? `, ${result.days.length} days` : ''}${result.bookings ? `, ${result.bookings.length} bookings` : ''}.`;

      return {
        content: [{ type: 'text', text }],
        structuredContent: result,
      };
    },
  );
}
