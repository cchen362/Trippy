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

function authInfoFor(userId, scopes) {
  return { token: 'test', clientId: 'test-client-id', scopes, extra: { userId } };
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

      const withPast = await client.callTool({ name: 'list_trips', arguments: { includePast: true } });
      const withPastTitles = withPast.structuredContent.trips.map((t) => t.title);
      expect(withPastTitles).toContain('Upcoming Trip');
      expect(withPastTitles).toContain('Past Trip');
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

      const byCity = await client.callTool({ name: 'list_trips', arguments: { query: 'rome' } });
      expect(byCity.structuredContent.trips.map((t) => t.title)).toEqual(['Italy Autumn']);
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

      const resultB = await client.callTool({ name: 'get_trip', arguments: { tripId: sharedWithStranger.trip.id } });
      expect(resultB.isError).toBe(true);
      expect(resultB.structuredContent.error).toBe('not_found');
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
    } finally {
      await client.close();
      await server.close();
    }
  });
});
