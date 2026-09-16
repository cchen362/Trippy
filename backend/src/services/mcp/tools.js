// Plan 28 W1: read-only MCP tools backing the hosted /mcp server. Every tool
// here is a thin translation layer over the same trip services the REST API
// already uses — no parallel read path, no ad-hoc SQL (F-28-11).
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { assertTripAccess, getTripDetail, listTripsForUser } from '../trips.js';
import { validateBookingDraft, summarizeDraft } from './validate.js';
import { BOOKING_TYPES } from '../importer.js';
import { MEDIA_TYPE_WHITELIST } from '../attachments.js';
import { createDraft, getDraftForUser, findDraftByIdempotencyKey, computeBookingFingerprint } from './drafts.js';
import { applyDraft } from './apply.js';
import { issueUploadTicket, getUploadTicket, uploadUrlFor } from './uploads.js';
import { validateDelete, computeDeleteFingerprint, summarizeDelete } from './prepareDelete.js';

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

function draftNotFoundResult() {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Draft not found.' }],
    structuredContent: { error: 'not_found' },
  };
}

function bookingNotFoundResult() {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Booking not found.' }],
    structuredContent: { error: 'not_found' },
  };
}

function errorResult(text, structuredContent) {
  return { isError: true, content: [{ type: 'text', text }], structuredContent };
}

// Every thrown { code } from validate/drafts/apply becomes one of these shapes;
// not_found always reads as "Draft not found" here — the only not_found this
// maps is getDraftForUser's, never validateBookingDraft's (that one uses
// notFoundResult() directly at its own call site since it means "trip not found").
const APPLY_ERROR_CODES = new Set(['not_found', 'apply_refused', 'expired', 'stale', 'invalid', 'rejected', 'cancelled']);

function applyErrorResult(error) {
  // Only a deliberate refusal (one of validate/drafts/apply's own thrown { code }
  // values) becomes a graceful tool result. Anything else — a real provider/DB
  // failure with no code — is rethrown so the SDK reports it as a protocol-level
  // error instead of a normal (isError: true) result the client could mistake
  // for "the draft was refused" (it wasn't; the draft is left pending, and a
  // retry is expected to succeed once the underlying failure clears).
  if (!error.code || !APPLY_ERROR_CODES.has(error.code)) throw error;
  if (error.code === 'not_found') return draftNotFoundResult();
  const structuredContent = { error: error.code };
  if (error.issues) structuredContent.issues = error.issues;
  return errorResult(error.message, structuredContent);
}

// Plan 28 W3.4: a stored sourceDocument only ever freezes what apply_draft learned at
// apply time — a ticket's status can move on (used/expired) after that, so both
// apply_draft (already_applied replay) and get_apply_status read the ticket's LIVE
// status through this one place rather than trusting the frozen result_json.
function presentSourceDocument(stored, publicUrl) {
  if (!stored || stored.status !== 'pending_upload' || !stored.ticket) return stored;
  const live = getUploadTicket(stored.ticket.id);
  if (!live) return { status: 'failed', reason: 'ticket_not_found' };
  if (live.status === 'used') return { status: 'saved', attachmentId: live.attachmentId };
  if (live.status === 'expired') return { status: 'failed', reason: 'ticket_expired' };
  return {
    status: 'pending_upload',
    ticket: { ...stored.ticket, uploadUrl: uploadUrlFor(publicUrl, stored.ticket.id) },
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

// Plan 28 W2: durable-draft write tools. Every write goes through
// validateBookingDraft/createDraft/applyDraft in services/mcp/ — never a
// second copy of the normalization, fingerprint, or transaction logic here.
export function registerWriteTools(server, { userId, tokenId, scopes, appUrl, publicUrl }) {
  server.registerTool(
    'prepare_draft',
    {
      title: 'Preview one or more bookings before they are saved',
      description:
        'Preview only — prepare_draft never writes anything. It validates the booking(s) ' +
        'against the target trip and returns a draftId, a plain-language summary, and any ' +
        'issues found. Call apply_draft with that draftId only after the user has reviewed ' +
        'the preview and explicitly confirmed. Multiple bookings per draft are allowed (e.g. ' +
        'a two-leg flight screenshot); bookings sharing type and confirmationRef are flagged ' +
        'as a probable multi-leg itinerary. target is either { tripId } for an existing trip, ' +
        'or { newTrip: { title, startDate, endDate, destinations: [{ city, countryCode? }] } } ' +
        'to create a trip in the same apply — Trippy NEVER infers a new trip\'s dates from a ' +
        'booking; the client must supply title/startDate/endDate/destinations explicitly, or ' +
        'the draft is refused. A `cost` field is never accepted on a booking — costs are added ' +
        'in the app. A missing origin/destination time zone is allowed and only produces an ' +
        'informational note: pass the wall-clock time exactly as printed on the confirmation, ' +
        'with no conversion. source describes where the booking came from; for a screenshot or ' +
        'PDF, sha256/mediaType/sizeBytes let apply_draft issue an upload ticket afterward.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          idempotencyKey: {
            type: 'string', minLength: 1, maxLength: 200,
            description: 'A client-generated key. Calling prepare_draft again with the same key returns the original draft rather than creating a second one.',
          },
          target: {
            type: 'object',
            description: 'Either { tripId } for an existing trip, or { newTrip: { title, startDate, endDate, destinations: [{ city, countryCode? }] } } to create the trip on apply. Dates are never inferred — both are required for newTrip.',
          },
          bookings: {
            type: 'array',
            minItems: 1,
            description: 'One or more BookingInput objects. Bookings sharing type and confirmationRef are treated as one multi-leg itinerary.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: BOOKING_TYPES },
                title: { type: 'string', description: 'Hotel name, flight number, train service, or a short label.' },
                confirmationRef: { type: 'string' },
                bookingSource: { type: 'string', description: 'Who issued it, e.g. Booking.com, Trip.com, the airline.' },
                startDatetime: { type: 'string', description: 'Local wall-clock time as printed, YYYY-MM-DDTHH:MM (check-in / departure).' },
                endDatetime: { type: 'string', description: 'Local wall-clock time as printed, YYYY-MM-DDTHH:MM (check-out / arrival).' },
                origin: { type: 'string', description: 'Departure airport/station/city (flight, train, bus, ferry).' },
                destination: { type: 'string', description: 'Arrival airport/station/city, or the hotel city/address.' },
                terminalOrStation: { type: 'string' },
                originTz: { type: 'string', description: 'IANA zone, optional.' },
                destinationTz: { type: 'string', description: 'IANA zone, optional.' },
                detailsJson: { type: 'object', description: 'Free-form extras (seat, room type, lat/lng if known).' },
                showInItinerary: { type: 'boolean' },
              },
              required: ['type', 'title', 'startDatetime'],
            },
          },
          source: {
            type: 'object',
            description: '{ kind: "screenshot" | "pdf" | "email_text" | "manual", sha256?, mediaType?, sizeBytes?, sourceBookingIndex? }. sourceBookingIndex (default 0) names which booking in this draft the document belongs to.',
          },
        },
        required: ['idempotencyKey', 'target', 'bookings', 'source'],
      }),
    },
    async (args) => {
      const scopeError = requireScope(scopes, 'trips:write');
      if (scopeError) return scopeError;

      const idempotencyKey = args?.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        return errorResult('idempotencyKey is required.', { error: 'missing_required_field', field: 'idempotencyKey' });
      }

      let validation;
      try {
        validation = await validateBookingDraft({
          userId, target: args?.target, bookings: args?.bookings, source: args?.source,
        });
      } catch (error) {
        if (error.code === 'not_found') return notFoundResult();
        throw error;
      }

      // Only a fully-valid draft against a real trip gets a fingerprint — a blocked
      // draft (e.g. cost_not_accepted, or the newTrip refusal) is never eligible to
      // apply anyway, and apply.js's own re-validation is what actually refuses it.
      const fingerprint = validation.applyAllowed && validation.tripRow
        ? computeBookingFingerprint(validation.tripRow.id)
        : null;

      const draft = createDraft({
        userId,
        tokenId,
        idempotencyKey,
        target: validation.target,
        bookings: validation.bookings,
        issues: validation.issues,
        plannedEffects: validation.plannedEffects,
        source: validation.source,
        tripId: validation.tripRow?.id ?? null,
        fingerprint,
      });

      const summary = summarizeDraft(validation);

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: {
          draftId: draft.id,
          expiresAt: draft.expiresAt,
          draftStatus: draft.status,
          target: draft.target,
          bookings: draft.bookings,
          issues: draft.issues,
          plannedEffects: draft.plannedEffects,
          applyAllowed: validation.applyAllowed,
          summary,
        },
      };
    },
  );

  server.registerTool(
    'apply_draft',
    {
      title: 'Apply a previously prepared booking draft',
      description:
        'Writes the booking (and its itinerary stop, when applicable) for a draft created by ' +
        'prepare_draft. Only call this after the user has seen the prepare_draft preview and ' +
        'explicitly confirmed. Calling apply_draft again on an already-applied draft is safe ' +
        'and returns the same result rather than creating a duplicate booking.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: { draftId: { type: 'string' } },
        required: ['draftId'],
      }),
    },
    async (args, ctx) => {
      const scopeError = requireScope(scopes, 'trips:write');
      if (scopeError) return scopeError;

      const draftId = args?.draftId;
      const mcpReq = ctx?.mcpReq;
      const progressToken = mcpReq?._meta?.progressToken;

      // Either notification upgrades an 'auto' responseMode transport to SSE the
      // moment it is sent — before any slow provider call in apply.js's resolve
      // phase — which is what keeps Cloudflare's 100s no-bytes timer from firing
      // (F-28-14(b)). A client with no progressToken still gets the keep-alive via
      // notifications/message, which is why McpServer declares { logging: {} }.
      const report = ({ progress, total, message }) => {
        if (!mcpReq?.notify) return Promise.resolve();
        if (progressToken !== undefined) {
          return mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress, total, message } });
        }
        return mcpReq.notify({ method: 'notifications/message', params: { level: 'info', logger: 'trippy.apply', data: message } });
      };

      let result;
      try {
        result = await applyDraft({ userId, draftId, signal: mcpReq?.signal, report });
      } catch (error) {
        return applyErrorResult(error);
      }

      const draft = getDraftForUser(userId, draftId);
      const tripUrl = `${appUrl}/trips/${result.tripId}`;

      // A delete-kind result carries `deleted`/`unlinked`, never `bookings` — branch on
      // that shape rather than draft.kind, since get_apply_status's stored result_json
      // for an already-applied draft carries the same distinction.
      if (result.deleted) {
        const stopPart = result.deleted.stopId ? '1 stop removed' : 'no stop removed';
        const unlinkedPart = result.unlinked.expenseIds.length
          ? `${result.unlinked.expenseIds.length} linked cost${result.unlinked.expenseIds.length === 1 ? '' : 's'} kept and unlinked`
          : null;
        const deletedPart = result.deleted.expenseIds.length
          ? `${result.deleted.expenseIds.length} linked cost${result.deleted.expenseIds.length === 1 ? '' : 's'} deleted`
          : null;
        const text = result.status === 'already_applied'
          ? `Already deleted earlier — booking ${result.deleted.bookingId}.`
          : `Deleted booking ${result.deleted.bookingId} (${[stopPart, unlinkedPart, deletedPart].filter(Boolean).join('; ')}).`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ...result, tripUrl },
        };
      }

      const bookings = result.bookings.map((booking) => ({ ...booking, url: `${tripUrl}/logistics` }));
      const sourceDocument = presentSourceDocument(result.sourceDocument, publicUrl);

      const lines = bookings.map((booking, index) => {
        const source = draft?.bookings?.[index];
        const label = source?.title ? `"${source.title}"` : 'the booking';
        const date = source?.startDatetime?.slice(0, 10);
        const stopPart = booking.stopId
          ? `stop created on ${date || 'the linked day'}`
          : `no stop created${booking.stopReason ? ` (${booking.stopReason})` : ''}`;
        return `${label} (${stopPart})`;
      });
      const createdTripPart = result.createdTrip ? 'Created the trip. ' : '';
      let text = result.status === 'already_applied'
        ? `Already applied earlier — same booking id${bookings.length === 1 ? '' : 's'} ${bookings.map((b) => b.bookingId).join(', ')}.`
        : `${createdTripPart}Applied: ${lines.join('; ')}.`;
      if (sourceDocument?.status === 'pending_upload') {
        text += ` Document pending: upload with curl -T <file> -H "Content-Type: <type>" ${sourceDocument.ticket.uploadUrl} within 15 minutes.`;
      } else if (sourceDocument?.status === 'failed') {
        text += ` The document could not be transferred (${sourceDocument.reason}); the booking was saved regardless.`;
      }

      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...result, tripUrl, bookings, sourceDocument },
      };
    },
  );

  server.registerTool(
    'get_apply_status',
    {
      title: 'Check a draft or apply status',
      description:
        'Looks up a draft by draftId or idempotencyKey and reports whether it is still ' +
        'pending, was applied, or failed (expired/stale/invalid/rejected). Use this to recover ' +
        'the result of an apply_draft call whose response was lost (e.g. a dropped connection).',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          draftId: { type: 'string' },
          idempotencyKey: { type: 'string' },
        },
      }),
    },
    async (args) => {
      const scopeError = requireScope(scopes, 'trips:read');
      if (scopeError) return scopeError;

      const draftId = args?.draftId;
      const idempotencyKey = args?.idempotencyKey;
      if ((draftId && idempotencyKey) || (!draftId && !idempotencyKey)) {
        return errorResult('Pass exactly one of draftId or idempotencyKey.', {
          error: 'missing_required_field', field: 'draftId|idempotencyKey',
        });
      }

      const draft = draftId
        ? getDraftForUser(userId, draftId)
        : findDraftByIdempotencyKey(userId, idempotencyKey);
      if (!draft) return draftNotFoundResult();

      if (draft.status === 'pending') {
        return {
          content: [{ type: 'text', text: `Draft ${draft.id} is still pending (expires ${draft.expiresAt}).` }],
          structuredContent: { draftStatus: 'pending', draftId: draft.id, expiresAt: draft.expiresAt },
        };
      }

      // Same shape as apply_draft's output (URLs included) so a client recovering
      // from a dropped apply response can act on either identically. A delete-kind
      // result has no `bookings` array to attach a logistics URL to — guard on its
      // presence rather than draft.kind, matching apply_draft's own branch.
      const tripUrl = draft.tripId ? `${appUrl}/trips/${draft.tripId}` : undefined;
      let result = {};
      if (draft.result?.bookings) {
        result = {
          ...draft.result,
          bookings: draft.result.bookings.map((booking) => ({ ...booking, url: `${tripUrl}/logistics` })),
          sourceDocument: presentSourceDocument(draft.result.sourceDocument, publicUrl),
        };
      } else if (draft.result) {
        result = { ...draft.result };
      }
      return {
        content: [{ type: 'text', text: `Draft ${draft.id} is ${draft.status}.` }],
        structuredContent: {
          draftStatus: draft.status,
          draftId: draft.id,
          tripId: draft.tripId,
          ...(tripUrl ? { tripUrl } : {}),
          ...result,
        },
      };
    },
  );

  server.registerTool(
    'request_upload_ticket',
    {
      title: 'Request an upload ticket for a booking attachment',
      description:
        'Issues a one-time upload ticket for a booking the user can access. The HOST — not ' +
        'this tool — must then PUT the file bytes directly to the returned uploadUrl with ' +
        '`curl -T <file> -H "Content-Type: <mediaType>" <uploadUrl>`: no bearer token on that ' +
        'request, the ticket id in the URL is the credential. The ticket expires after 15 ' +
        'minutes; mediaType, sizeBytes, and sha256 must match the actual file exactly, or the ' +
        'upload is refused. Uploading the same bytes twice is safe and returns the same ' +
        'attachment rather than a duplicate.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          bookingId: { type: 'string' },
          mediaType: { type: 'string', enum: MEDIA_TYPE_WHITELIST },
          sizeBytes: { type: 'integer', minimum: 1, description: 'Exact file size in bytes.' },
          sha256: { type: 'string', description: '64-character hex SHA-256 of the file bytes.' },
        },
        required: ['bookingId', 'mediaType', 'sizeBytes', 'sha256'],
      }),
    },
    async (args) => {
      const scopeError = requireScope(scopes, 'documents:write');
      if (scopeError) return scopeError;

      let ticket;
      try {
        ticket = issueUploadTicket({
          userId, tokenId, bookingId: args?.bookingId, mediaType: args?.mediaType,
          sizeBytes: args?.sizeBytes, sha256: args?.sha256,
        });
      } catch (error) {
        if (error.code === 'not_found') return bookingNotFoundResult();
        if (error.code) return errorResult(error.message, { error: error.code });
        throw error;
      }

      const uploadUrl = uploadUrlFor(publicUrl, ticket.id);
      return {
        content: [{
          type: 'text',
          text: `Upload with: curl -T <file> -H "Content-Type: ${ticket.mediaType}" ${uploadUrl} (expires ${ticket.expiresAt}).`,
        }],
        structuredContent: {
          ticket: { uploadUrl, expiresAt: ticket.expiresAt, maxBytes: ticket.maxBytes },
        },
      };
    },
  );

  server.registerTool(
    'prepare_delete',
    {
      title: 'Preview deleting a booking',
      description:
        'Preview only — prepare_delete never deletes anything, and this pair is the ONLY way ' +
        'to delete a booking over MCP. Shows exactly what disappears: the booking, its ' +
        'itinerary stop (if any), and any linked costs. Linked costs are KEPT and unlinked ' +
        'from the booking by default, exactly like the app\'s own delete review — pass their ' +
        'ids in deleteExpenseIds to delete them too. Call apply_draft with the returned ' +
        'draftId only after the user has reviewed this preview and explicitly confirmed.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          idempotencyKey: {
            type: 'string', minLength: 1, maxLength: 200,
            description: 'A client-generated key. Calling prepare_delete again with the same key returns the original draft rather than creating a second one.',
          },
          bookingId: { type: 'string' },
          deleteExpenseIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Linked expense ids to delete along with the booking. Omitted or empty keeps every linked cost, unlinked from the booking.',
          },
        },
        required: ['idempotencyKey', 'bookingId'],
      }),
    },
    async (args) => {
      const scopeError = requireScope(scopes, 'trips:write');
      if (scopeError) return scopeError;

      const idempotencyKey = args?.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        return errorResult('idempotencyKey is required.', { error: 'missing_required_field', field: 'idempotencyKey' });
      }

      let validation;
      try {
        validation = validateDelete({ userId, bookingId: args?.bookingId, deleteExpenseIds: args?.deleteExpenseIds });
      } catch (error) {
        if (error.code === 'not_found') return bookingNotFoundResult();
        if (error.code === 'invalid_argument') {
          return errorResult(error.message, { error: error.code, field: 'deleteExpenseIds' });
        }
        throw error;
      }

      const fingerprint = validation.applyAllowed
        ? computeDeleteFingerprint(validation.booking, validation.linkedStopIds, validation.linkedExpenseIds)
        : null;

      const draft = createDraft({
        userId,
        tokenId,
        idempotencyKey,
        kind: 'delete',
        target: { tripId: validation.booking.tripId, bookingId: validation.booking.id, deleteExpenseIds: validation.deleteExpenseIds },
        bookings: [validation.booking],
        issues: validation.issues,
        plannedEffects: { linkedStop: validation.linkedStop, linkedExpenses: validation.linkedExpenses },
        source: { kind: 'manual' },
        tripId: validation.booking.tripId,
        fingerprint,
      });

      const summary = summarizeDelete(validation);
      const bookingUrl = `${appUrl}/trips/${validation.booking.tripId}/logistics`;

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: {
          draftId: draft.id,
          expiresAt: draft.expiresAt,
          draftStatus: draft.status,
          kind: 'delete',
          booking: {
            id: validation.booking.id,
            type: validation.booking.type,
            title: validation.booking.title,
            confirmationRef: validation.booking.confirmationRef,
            startDatetime: validation.booking.startDatetime,
            url: bookingUrl,
          },
          linkedStop: validation.linkedStop,
          linkedExpenses: validation.linkedExpenses,
          issues: validation.issues,
          applyAllowed: validation.applyAllowed,
          summary,
        },
      };
    },
  );
}
