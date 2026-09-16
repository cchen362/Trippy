// Plan 28 W1.7: the real @modelcontextprotocol/client against routes/mcp.js on
// a scratch Express app (F-28-15 — tests never import src/index.js). Covers the
// HTTP edge (401/403/405/metadata/rate limit) with raw fetch and the MCP
// handshake + tool calls with the SDK client.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Plan 28 W2: same external-I/O mocks as tests/copilotProposals.test.js and
// tests/mcpDrafts.test.js — must precede the imports below so stops.js picks up
// the mocked modules. The real resolve/write split, validation, fingerprint, and
// transaction all run for real against this file's scratch Express app + DB.
vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: vi.fn().mockResolvedValue({
    lat: 35.0116, lng: 135.7681, resolvedName: 'Resolved Place', resolvedAddress: 'Some Address',
    coordinateSystem: 'wgs84', coordinateSource: 'nominatim', locationStatus: 'resolved',
    confidence: 0.9, providerId: 'osm:1', countryCode: 'JP',
  }),
}));
vi.mock('../src/services/unsplash.js', () => ({
  selectPhoto: vi.fn().mockResolvedValue(null),
  trackDownload: vi.fn(),
}));
vi.mock('../src/services/claude.js', () => ({
  generatePhotoDescriptor: vi.fn().mockResolvedValue(null),
}));

import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createToken } from '../src/services/integrationTokens.js';
import { createMcpRouter } from '../src/routes/mcp.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { MCP_ANON_RATE_LIMIT } from '../src/middleware/rateLimit.js';
import { shutdownServer } from '../src/shutdown.js';

const FRONTEND_URL = 'http://localhost:5174';

let tmpDir;
let server;
let baseUrl;
let owner;
let trip;
let readToken;
let docsOnlyToken;
let writeToken;

function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  return client.connect(transport).then(() => client);
}

// Plan 28 W5.1: pulled out of beforeAll so the restart test can rebuild an
// identical scratch app against the same (reopened) DB file after simulating
// a shutdown mid-apply.
async function startScratchServer() {
  const app = express();
  // publicUrl is patched once the ephemeral port is known; the router only
  // uses it for the metadata pointer, so a placeholder origin is fine to build with.
  const mcp = createMcpRouter({ publicUrl: 'http://127.0.0.1/mcp', frontendUrl: FRONTEND_URL, appUrl: FRONTEND_URL });
  app.use('/mcp', mcp.router);
  app.use(mcp.metadataRouter);
  app.use(errorHandler);
  const newServer = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server: newServer, baseUrl: `http://127.0.0.1:${newServer.address().port}` };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-mcp-e2e-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  owner = authService.setup('e2e-owner', 'password123', 'E2E Owner').user;
  trip = createTrip(owner.id, {
    title: 'Kyoto autumn',
    startDate: '2099-11-01',
    endDate: '2099-11-05',
    destinations: ['Kyoto'],
    destinationCountries: ['JP'],
  }).trip;
  readToken = createToken(owner.id, { name: 'read', scopes: ['trips:read'] }).token;
  docsOnlyToken = createToken(owner.id, { name: 'docs', scopes: ['documents:write'] }).token;
  writeToken = createToken(owner.id, { name: 'write', scopes: ['trips:read', 'trips:write'] }).token;

  ({ server, baseUrl } = await startScratchServer());
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('HTTP edge', () => {
  it('answers 401 with a resource_metadata challenge when no token is sent', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate');
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('answers 401 for a well-formed but unknown token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer trp_definitely-not-a-real-token-value-here-1234',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('answers 405 with Allow: POST on GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('refuses a foreign browser Origin with 403 before touching auth', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          Authorization: `Bearer ${readToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    }
  });

  it('serves the RFC 9728 protected-resource document at both well-known paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resource).toBe('http://127.0.0.1/mcp');
      expect(body.scopes_supported).toEqual(['trips:read', 'trips:write', 'documents:write']);
      expect(body.bearer_methods_supported).toEqual(['header']);
      expect(body).not.toHaveProperty('authorization_servers');
    }
  });
});

describe('SDK client', () => {
  it('lists both read tools and calls list_trips for the token owner', async () => {
    const client = await connect(readToken);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['apply_draft', 'get_apply_status', 'get_trip', 'list_trips', 'prepare_delete', 'prepare_draft', 'request_upload_ticket']);

      const result = await client.callTool({ name: 'list_trips', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.trips).toHaveLength(1);
      expect(result.structuredContent.trips[0]).toMatchObject({
        id: trip.id,
        title: 'Kyoto autumn',
        startDate: '2099-11-01',
        endDate: '2099-11-05',
        status: 'upcoming',
        url: `${FRONTEND_URL}/trips/${trip.id}`,
      });
      expect(result.content[0].text).toContain('Kyoto autumn');
    } finally {
      await client.close();
    }
  });

  it('calls get_trip with days and returns the seeded day range', async () => {
    const client = await connect(readToken);
    try {
      const result = await client.callTool({ name: 'get_trip', arguments: { tripId: trip.id, include: ['days', 'bookings'] } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.trip.id).toBe(trip.id);
      expect(result.structuredContent.days).toHaveLength(5);
      expect(result.structuredContent.days[0]).toMatchObject({ date: '2099-11-01', resolvedCity: 'Kyoto' });
      expect(result.structuredContent.bookings).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('returns an insufficient_scope tool error for a token without trips:read', async () => {
    const client = await connect(docsOnlyToken);
    try {
      const result = await client.callTool({ name: 'list_trips', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: 'insufficient_scope', requiredScope: 'trips:read' });
      expect(result.content[0].text).toContain('trips:read');
    } finally {
      await client.close();
    }
  });
});

describe('anonymous rate limit', () => {
  it('returns 429 with Retry-After once the per-IP 401 budget is spent', async () => {
    // The earlier 401 tests in this file already consumed a few attempts from
    // the same window; spend the remainder and assert the boundary.
    let last;
    for (let i = 0; i < MCP_ANON_RATE_LIMIT + 1; i += 1) {
      last = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer trp_wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();

    // Authenticated calls are keyed separately (by token id) and stay unaffected.
    const client = await connect(readToken);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(7);
    } finally {
      await client.close();
    }
  });
});

// Plan 28 W2.6: full prepare -> apply -> status round trips through the real HTTP
// router, proving the progress notification (SDK client) and the
// notifications/message keep-alive fallback (a raw fetch tools/call with no
// progressToken) both work through the public wire, not just in-process.
async function rawFetchMcp(body) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${writeToken}`,
    },
    body: JSON.stringify(body),
  });
}

// Stateless legacy handshake (W0 finding: no Mcp-Session-Id is ever issued or
// expected) — this is the 2025-11-25 wire a hand-written client speaks, deliberately
// not going through the SDK Client class for this one call so the test proves the
// server serves a client that never sets the 2026-07-28 `_meta` envelope.
async function rawInitialize() {
  const initRes = await rawFetchMcp({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw-e2e-client', version: '1.0.0' },
    },
  });
  await initRes.text();
  await rawFetchMcp({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
}

describe('prepare_draft / apply_draft / get_apply_status round trip', () => {
  it('applies via the SDK client with onprogress, and get_apply_status agrees on the same booking id', async () => {
    const client = await connect(writeToken);
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'e2e-progress-1',
          target: { tripId: trip.id },
          bookings: [{
            type: 'hotel', title: 'Hotel Granvia', startDatetime: '2099-11-02T15:00:00',
            endDatetime: '2099-11-04T11:00:00', destination: 'Kyoto', destinationTz: 'Asia/Tokyo',
          }],
          source: { kind: 'manual' },
        },
      });
      expect(prepared.isError).toBeFalsy();
      expect(prepared.structuredContent.applyAllowed).toBe(true);
      const draftId = prepared.structuredContent.draftId;

      const progressEvents = [];
      const applied = await client.callTool(
        { name: 'apply_draft', arguments: { draftId } },
        { onprogress: (event) => progressEvents.push(event) },
      );
      expect(applied.isError).toBeFalsy();
      expect(applied.structuredContent.status).toBe('applied');
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);

      const bookingId = applied.structuredContent.bookings[0].bookingId;
      const status = await client.callTool({ name: 'get_apply_status', arguments: { draftId } });
      expect(status.structuredContent.draftStatus).toBe('applied');
      expect(status.structuredContent.bookings[0].bookingId).toBe(bookingId);
    } finally {
      await client.close();
    }
  });

  it('applies a second draft via a raw fetch tools/call with no progressToken, upgrading the response to SSE', async () => {
    const client = await connect(writeToken);
    let draftId;
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'e2e-raw-fetch-1',
          target: { tripId: trip.id },
          bookings: [{
            type: 'hotel', title: 'Second Hotel', startDatetime: '2099-11-03T15:00:00',
            endDatetime: '2099-11-04T11:00:00', destination: 'Kyoto', destinationTz: 'Asia/Tokyo',
          }],
          source: { kind: 'manual' },
        },
      });
      expect(prepared.isError).toBeFalsy();
      draftId = prepared.structuredContent.draftId;
    } finally {
      await client.close();
    }

    await rawInitialize();
    const callRes = await rawFetchMcp({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'apply_draft', arguments: { draftId } },
    });

    // The 'auto' responseMode only upgrades to SSE when a related notification
    // (here, apply_draft's notifications/message fallback for a client with no
    // progressToken) is sent before the result — proving the logging capability
    // and the fallback branch both work on the real wire, not just in-process.
    expect(callRes.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const text = await callRes.text();
    const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
    expect(dataLines.length).toBeGreaterThan(0);
    const lastPayload = dataLines[dataLines.length - 1].slice('data:'.length).trim();
    expect(lastPayload).toContain('"status":"applied"');
  });
});

// Plan 28 W5.1: proves shutdownServer's connection-destroying step is safe for
// apply_draft — an apply caught mid-resolve (before its write transaction opens)
// must leave the draft `pending` and write nothing, and must be cleanly retryable
// against a freshly restarted server against the same DB file. Put last so the
// other describes above run against the original server untouched.
describe('restart mid-apply (Plan 28 W5.1)', () => {
  it('destroys the in-flight apply before its write, and a fresh apply after restart succeeds exactly once', async () => {
    const dbPath = join(tmpDir, 'test.db');

    const prepClient = await connect(writeToken);
    let draftId;
    try {
      const prepared = await prepClient.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'e2e-restart-1',
          target: { tripId: trip.id },
          bookings: [{
            type: 'hotel', title: 'Restart Hotel', startDatetime: '2099-11-02T15:00:00',
            endDatetime: '2099-11-04T11:00:00', destination: 'Kyoto', destinationTz: 'Asia/Tokyo',
          }],
          source: { kind: 'manual' },
        },
      });
      expect(prepared.isError).toBeFalsy();
      draftId = prepared.structuredContent.draftId;
    } finally {
      await prepClient.close();
    }

    const bookingCountBefore = getDb().prepare('SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?').get(trip.id).n;

    const applyClient = await connect(writeToken);
    process.env.MCP_APPLY_RESOLVE_DELAY_MS = '1500';
    // The W5.2 tool log is the only observable trace of the orphaned apply once
    // its connection is gone — its outcome line is what proves the abort chain
    // (socket close → SDK abort → apply.js `cancelled`) actually fired.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const inFlight = applyClient.callTool({ name: 'apply_draft', arguments: { draftId } });
      // Swallow-and-record rather than let it reject unobserved before the
      // assertion below attaches — Node would otherwise warn/crash on an
      // unhandled rejection racing the shutdown.
      let inFlightError;
      const inFlightSettled = inFlight.then(
        (result) => ({ result }),
        (error) => { inFlightError = error; return { error }; },
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Destroys the server-side connection; apply.js's resolve loop observes
      // the resulting abort signal once its (test-seam-lengthened) resolve
      // delay elapses, and throws `cancelled` before its write transaction.
      // The client's own SSE-stream reader treats a dropped connection with
      // no response yet as reconnectable and retries rather than rejecting
      // (StreamableHTTPClientTransport's resumption behavior) — closing the
      // client below is what actually settles the pending call, exactly as a
      // real client giving up on a dead connection would.
      await shutdownServer({ server, closeDb: async () => getDb().close(), gracePeriodMs: 0 });
      await applyClient.close();

      const settled = await inFlightSettled;
      expect(settled.error).toBeTruthy();
      expect(settled.result).toBeUndefined();

      // Let the seam delay elapse while the DB is still CLOSED, so the orphaned
      // apply has fully terminated before anything is reopened — otherwise it
      // could race the retry below against the reopened file.
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const applyLines = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('tool=apply_draft'));
      expect(applyLines).toHaveLength(1);
      expect(applyLines[0]).toContain('outcome=error:cancelled');
    } finally {
      logSpy.mockRestore();
      delete process.env.MCP_APPLY_RESOLVE_DELAY_MS;
      await applyClient.close().catch(() => {});
    }

    // Reopen the same DB file — no migrations needed, it is the same file.
    initDb(dbPath);
    const draftRow = getDb().prepare('SELECT status FROM mcp_drafts WHERE id = ?').get(draftId);
    expect(draftRow.status).toBe('pending');
    const bookingCountAfterDestroy = getDb().prepare('SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?').get(trip.id).n;
    expect(bookingCountAfterDestroy).toBe(bookingCountBefore);

    ({ server, baseUrl } = await startScratchServer());

    const retryClient = await connect(writeToken);
    try {
      const retried = await retryClient.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(retried.isError).toBeFalsy();
      expect(retried.structuredContent.status).toBe('applied');
    } finally {
      await retryClient.close();
    }

    const bookingCountAfterRetry = getDb().prepare('SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?').get(trip.id).n;
    expect(bookingCountAfterRetry).toBe(bookingCountBefore + 1);
  });
});
