import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { inviteCollaborator } from '../src/services/collaboration.js';
import { createToken } from '../src/services/integrationTokens.js';
import { createTrippyMcpServer } from '../src/services/mcp/server.js';

const APP_URL = 'http://localhost:5174';

let tmpDir;
let owner;
let collaborator;
let stranger;

const PUBLIC_URL = 'http://localhost:3002/mcp';

async function connectClient(authInfo) {
  const server = createTrippyMcpServer({ authInfo, appUrl: APP_URL, publicUrl: PUBLIC_URL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

// tokenId is optional because it's only load-bearing for the write tools (a real
// mcp_drafts row has a NOT NULL FK to integration_tokens) — the read-only tests
// below never create a draft, so they keep the placeholder clientId.
function authInfoFor(userId, scopes, tokenId) {
  return { token: 'test', clientId: tokenId || 'test-client-id', scopes, extra: { userId } };
}

function tokenFor(userId, scopes) {
  return createToken(userId, { name: 'test-token', scopes }).record.id;
}

// D-29-1: shared assertion for every result this suite checks — a text-only host
// (F-29-1/G-29-1) reads only content[].text, so the structured object must also be
// present there, byte-for-byte, as the second text block. Applied after every
// existing result assertion below so the contract is checked wherever a result is
// checked, not just in one dedicated test.
function expectTextMirrorsStructured(result) {
  expect(result.content.length).toBe(2);
  expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent);
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-mcp-tools-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('mcp-owner', 'password123', 'MCP Owner').user;
  const { value: inviteCode } = getDb().prepare("SELECT value FROM settings WHERE key='invite_code'").get();
  collaborator = authService.register('mcp-collab', 'password123', 'MCP Collab', inviteCode).user;
  stranger = authService.register('mcp-stranger', 'password123', 'MCP Stranger', inviteCode).user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('createTrippyMcpServer', () => {
  it('throws when authInfo has no userId', () => {
    expect(() => createTrippyMcpServer({ authInfo: { scopes: ['trips:read'] }, appUrl: APP_URL })).toThrow();
    expect(() => createTrippyMcpServer({ authInfo: null, appUrl: APP_URL })).toThrow();
  });
});

describe('tools/list', () => {
  it('lists list_trips and get_trip with their input schemas', async () => {
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read']));
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['apply_draft', 'get_apply_status', 'get_trip', 'list_trips', 'prepare_delete', 'prepare_draft', 'request_upload_ticket']);

      const listTrips = tools.find((t) => t.name === 'list_trips');
      expect(listTrips.inputSchema.properties).toHaveProperty('query');
      expect(listTrips.inputSchema.properties).toHaveProperty('includePast');

      const getTrip = tools.find((t) => t.name === 'get_trip');
      expect(getTrip.inputSchema.required).toEqual(['tripId']);
      expect(getTrip.inputSchema.properties).toHaveProperty('tripId');
      expect(getTrip.inputSchema.properties).toHaveProperty('include');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('list_trips', () => {
  it('excludes past trips by default and includes them when includePast is true', async () => {
    await createTrip(owner.id, { title: 'Upcoming Trip', startDate: '2099-01-01', endDate: '2099-01-05' });
    await createTrip(owner.id, { title: 'Past Trip', startDate: '2000-01-01', endDate: '2000-01-05' });

    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read']));
    try {
      const defaultResult = await client.callTool({ name: 'list_trips', arguments: {} });
      const defaultTitles = defaultResult.structuredContent.trips.map((t) => t.title);
      expect(defaultTitles).toContain('Upcoming Trip');
      expect(defaultTitles).not.toContain('Past Trip');
      expectTextMirrorsStructured(defaultResult);

      const withPast = await client.callTool({ name: 'list_trips', arguments: { includePast: true } });
      const withPastTitles = withPast.structuredContent.trips.map((t) => t.title);
      expect(withPastTitles).toContain('Upcoming Trip');
      expect(withPastTitles).toContain('Past Trip');
      expectTextMirrorsStructured(withPast);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('filters by query on title and destination city', async () => {
    await createTrip(owner.id, {
      title: 'Japan Spring', startDate: '2099-04-01', endDate: '2099-04-10',
      destinations: [{ city: 'Tokyo', countryCode: 'JP' }],
    });
    await createTrip(owner.id, {
      title: 'Italy Autumn', startDate: '2099-09-01', endDate: '2099-09-10',
      destinations: [{ city: 'Rome', countryCode: 'IT' }],
    });

    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read']));
    try {
      const byTitle = await client.callTool({ name: 'list_trips', arguments: { query: 'japan' } });
      expect(byTitle.structuredContent.trips.map((t) => t.title)).toEqual(['Japan Spring']);
      expectTextMirrorsStructured(byTitle);

      const byCity = await client.callTool({ name: 'list_trips', arguments: { query: 'rome' } });
      expect(byCity.structuredContent.trips.map((t) => t.title)).toEqual(['Italy Autumn']);
      expectTextMirrorsStructured(byCity);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // D-29-4: an empty upcoming list states how many past trips the filter hid — the
  // fact only, never an instruction — so a text-only host can offer them.
  it('names hidden past trips when the upcoming list is empty, and says nothing more', async () => {
    await createTrip(owner.id, {
      title: 'Tokyo 2000', startDate: '2000-01-01', endDate: '2000-01-05',
      destinations: [{ city: 'Tokyo', countryCode: 'JP' }],
    });
    await createTrip(owner.id, { title: 'Rome 2001', startDate: '2001-01-01', endDate: '2001-01-05' });

    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read']));
    try {
      const empty = await client.callTool({ name: 'list_trips', arguments: { query: null, includePast: false } });
      expect(empty.structuredContent).toEqual({ trips: [], hiddenPastCount: 2 });
      expect(empty.content[0].text).toBe('No upcoming trips. 2 past trips are on file.');
      expect(empty.content[0].text).not.toMatch(/includePast|ask/i);
      expectTextMirrorsStructured(empty);

      const byQuery = await client.callTool({ name: 'list_trips', arguments: { query: 'tokyo' } });
      expect(byQuery.structuredContent).toEqual({ trips: [], hiddenPastCount: 1 });
      expect(byQuery.content[0].text).toBe('No upcoming trips match "tokyo". 1 past trip does.');
      expectTextMirrorsStructured(byQuery);

      const noMatch = await client.callTool({ name: 'list_trips', arguments: { query: 'lisbon' } });
      expect(noMatch.structuredContent).toEqual({ trips: [], hiddenPastCount: 0 });
      expect(noMatch.content[0].text).toBe('No trips match "lisbon".');
      expectTextMirrorsStructured(noMatch);

      const withPast = await client.callTool({ name: 'list_trips', arguments: { includePast: true } });
      expect(withPast.structuredContent.hiddenPastCount).toBe(0);
      expect(withPast.structuredContent.trips).toHaveLength(2);
      expectTextMirrorsStructured(withPast);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('says "No trips yet." for an account with no trips at all', async () => {
    const { client, server } = await connectClient(authInfoFor(stranger.id, ['trips:read']));
    try {
      const result = await client.callTool({ name: 'list_trips', arguments: {} });
      expect(result.structuredContent).toEqual({ trips: [], hiddenPastCount: 0 });
      expect(result.content[0].text).toBe('No trips yet.');
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns insufficient_scope for a token without trips:read', async () => {
    const { client, server } = await connectClient(authInfoFor(owner.id, ['documents:write']));
    try {
      const result = await client.callTool({ name: 'list_trips', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toBe('insufficient_scope');
      expect(result.structuredContent.requiredScope).toBe('trips:read');
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('get_trip', () => {
  it('returns days and bookings when included', async () => {
    const detail = await createTrip(owner.id, { title: 'Detail Trip', startDate: '2099-05-01', endDate: '2099-05-03' });
    const tripId = detail.trip.id;
    await createBooking(owner.id, tripId, { type: 'hotel', title: 'Hotel Stay' });

    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read']));
    try {
      const result = await client.callTool({
        name: 'get_trip',
        arguments: { tripId, include: ['days', 'bookings'] },
      });
      expect(result.structuredContent.trip.id).toBe(tripId);
      expect(Array.isArray(result.structuredContent.days)).toBe(true);
      expect(result.structuredContent.days[0]).toHaveProperty('resolvedCity');
      expect(result.structuredContent.days[0]).toHaveProperty('stopCount');
      expect(result.structuredContent.bookings).toHaveLength(1);
      expect(result.structuredContent.bookings[0]).toHaveProperty('documentCount', 0);
      expect(result.structuredContent.bookings[0].title).toBe('Hotel Stay');
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('isolates trips a token owner cannot access, including a shared-but-not-with-them trip', async () => {
    const ownerOnly = await createTrip(owner.id, { title: 'Owner Only', startDate: '2099-06-01', endDate: '2099-06-03' });
    const sharedWithStranger = await createTrip(owner.id, { title: 'Shared With Stranger', startDate: '2099-07-01', endDate: '2099-07-03' });
    inviteCollaborator(owner.id, sharedWithStranger.trip.id, stranger.username);

    const { client, server } = await connectClient(authInfoFor(collaborator.id, ['trips:read']));
    try {
      const resultA = await client.callTool({ name: 'get_trip', arguments: { tripId: ownerOnly.trip.id } });
      expect(resultA.isError).toBe(true);
      expect(resultA.structuredContent.error).toBe('not_found');
      expectTextMirrorsStructured(resultA);

      const resultB = await client.callTool({ name: 'get_trip', arguments: { tripId: sharedWithStranger.trip.id } });
      expect(resultB.isError).toBe(true);
      expect(resultB.structuredContent.error).toBe('not_found');
      expectTextMirrorsStructured(resultB);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lets a collaborator read a trip shared with them', async () => {
    const shared = await createTrip(owner.id, { title: 'Shared Trip', startDate: '2099-08-01', endDate: '2099-08-03' });
    inviteCollaborator(owner.id, shared.trip.id, collaborator.username);

    const { client, server } = await connectClient(authInfoFor(collaborator.id, ['trips:read']));
    try {
      const result = await client.callTool({ name: 'get_trip', arguments: { tripId: shared.trip.id } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.trip.id).toBe(shared.trip.id);
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns insufficient_scope for a documents:write-only token', async () => {
    const trip = await createTrip(owner.id, { title: 'Scoped Trip', startDate: '2099-10-01', endDate: '2099-10-03' });
    const { client, server } = await connectClient(authInfoFor(owner.id, ['documents:write']));
    try {
      const result = await client.callTool({ name: 'get_trip', arguments: { tripId: trip.trip.id } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toBe('insufficient_scope');
      expect(result.structuredContent.requiredScope).toBe('trips:read');
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Plan 29 W1 step 5(b): the originating case — a text-only host cannot see
// structuredContent.issues, so the blocker must be named in content[0].text itself.
describe('prepare_draft named blocker in text (D-29-2)', () => {
  it('names a missing destination for a hotel with address instead', async () => {
    const trip = await createTrip(owner.id, { title: 'Singapore Trip', startDate: '2099-09-24', endDate: '2099-09-27' });
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const result = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'named-blocker-1',
          target: { tripId: trip.trip.id },
          bookings: [{
            type: 'hotel',
            title: 'Frasers House, a Luxury Collection Hotel, Singapore',
            address: '1 Beach Road, Singapore',
            startDatetime: '2099-09-25T15:00:00',
            endDatetime: '2099-09-26T12:00:00',
          }],
          source: { kind: 'manual' },
        },
      });
      expect(result.structuredContent.applyAllowed).toBe(false);
      expect(result.content[0].text).toContain('missing_required_field at bookings[0].destination');
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Plan 29 W1 step 5(c): the originating case's second defect — a schema converter
// that presents optional fields as nullable sends draftId: null. Before D-29-3, ajv
// refused this before the handler ever ran; it must now reach the handler and behave
// exactly as if draftId were omitted.
describe('get_apply_status with an explicit null optional (D-29-3)', () => {
  it('treats draftId: null the same as omitting it when idempotencyKey is given', async () => {
    const trip = await createTrip(owner.id, { title: 'Null Optional Trip', startDate: '2099-09-24', endDate: '2099-09-27' });
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'null-optional-status-1',
          target: { tripId: trip.trip.id },
          bookings: [{
            type: 'hotel', title: 'Hotel Null', startDatetime: '2099-09-25T15:00:00',
            endDatetime: '2099-09-26T12:00:00', destination: 'Singapore',
          }],
          source: { kind: 'manual' },
        },
      });
      expect(prepared.isError).toBeFalsy();

      const status = await client.callTool({
        name: 'get_apply_status',
        arguments: { draftId: null, idempotencyKey: 'null-optional-status-1' },
      });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent.draftStatus).toBe('pending');
      expect(status.structuredContent.draftId).toBe(prepared.structuredContent.draftId);
      expectTextMirrorsStructured(status);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Plan 29 W1 step 5(d): every optional field a model might send as null validates
// exactly as if it had been omitted, never as a blocker.
describe('prepare_draft with explicit nulls on optional fields (D-29-3)', () => {
  it('validates confirmationRef, originTz, and source sub-fields as if omitted', async () => {
    const trip = await createTrip(owner.id, { title: 'Nulls Trip', startDate: '2099-09-24', endDate: '2099-09-27' });
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const result = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'nulls-1',
          target: { tripId: trip.trip.id },
          bookings: [{
            type: 'flight',
            title: 'JL123',
            confirmationRef: null,
            startDatetime: '2099-09-25T10:00:00',
            origin: 'Tokyo',
            destination: 'Singapore',
            originTz: null,
            showInItinerary: null,
          }],
          source: { kind: 'screenshot', sha256: null, sourceBookingIndex: null },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.applyAllowed).toBe(true);
      expect(result.structuredContent.issues.some((i) => i.severity === 'blocker')).toBe(false);
      expect(result.structuredContent.bookings[0].confirmationRef).toBeNull();
      // showInItinerary: null means "use the type default" (a flight shows), never "hide".
      expect(result.structuredContent.bookings[0].showInItinerary).toBe(true);
      expect(result.structuredContent.plannedEffects[0].stop.willCreate).toBe(true);
      expectTextMirrorsStructured(result);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Plan 29 W1 step 5(e): the schema walker — every optional property in every
// registered tool's inputSchema lists null in its type, and no required property does.
describe('schema walker: optional properties are nullable, required properties are not (D-29-3)', () => {
  function walk(schema, result, path) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object' && schema.properties) {
      const required = new Set(schema.required || []);
      for (const [key, prop] of Object.entries(schema.properties)) {
        const propPath = path ? `${path}.${key}` : key;
        const types = Array.isArray(prop.type) ? prop.type : [prop.type];
        if (prop.type !== undefined) {
          if (required.has(key)) {
            if (types.includes('null')) result.requiredWithNull.push(propPath);
          } else if (!types.includes('null')) {
            result.optionalMissingNull.push(propPath);
          }
        }
        walk(prop, result, propPath);
      }
    }
    const typeList = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (typeList.includes('array') && schema.items) {
      walk(schema.items, result, `${path}[]`);
    }
  }

  it('holds for every tool', async () => {
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write', 'documents:write']));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        const result = { optionalMissingNull: [], requiredWithNull: [] };
        walk(tool.inputSchema, result, '');
        expect({ tool: tool.name, ...result }).toEqual({ tool: tool.name, optionalMissingNull: [], requiredWithNull: [] });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
