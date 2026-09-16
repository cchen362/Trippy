// Plan 28 W5.2: structured tool-call logging. Harness mirrors tests/mcpTools.test.js
// (in-memory transport, no HTTP) but injects a vi.fn() logSink so the log lines
// themselves can be asserted, and mints a real token so a plaintext value exists
// to assert is never logged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createToken, TOKEN_PREFIX_LENGTH } from '../src/services/integrationTokens.js';
import { createTrippyMcpServer } from '../src/services/mcp/server.js';
import { formatToolLogLine, withToolLog } from '../src/services/mcp/log.js';

const APP_URL = 'http://localhost:5174';
const PUBLIC_URL = 'http://localhost:3002/mcp';

let tmpDir;
let owner;

async function connectClient(authInfo, logSink) {
  const server = createTrippyMcpServer({ authInfo, appUrl: APP_URL, publicUrl: PUBLIC_URL, logSink });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-mcp-log-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('mcp-log-owner', 'password123', 'MCP Log Owner').user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('formatToolLogLine', () => {
  it('formats every field and omits draft= when draftId is null', () => {
    const line = formatToolLogLine({
      ts: '2026-09-16T10:00:00.000Z',
      tokenPrefix: 'trp_ab12cd34',
      userId: 'user-1',
      tool: 'prepare_draft',
      durationMs: 12,
      outcome: 'ok',
      draftId: null,
    });
    expect(line).toBe('[mcp] ts=2026-09-16T10:00:00.000Z token=trp_ab12cd34 user=user-1 tool=prepare_draft ms=12 outcome=ok');
    expect(line).not.toContain('draft=');
  });

  it('includes draft= when draftId is present', () => {
    const line = formatToolLogLine({
      ts: '2026-09-16T10:00:00.000Z',
      tokenPrefix: 'trp_ab12cd34',
      userId: 'user-1',
      tool: 'apply_draft',
      durationMs: 5,
      outcome: 'ok',
      draftId: 'draft-1',
    });
    expect(line).toContain('draft=draft-1');
  });
});

describe('withToolLog', () => {
  it('logs outcome=threw and rethrows without swallowing the error', async () => {
    const sink = vi.fn();
    const handler = async () => {
      throw new Error('boom');
    };
    const wrapped = withToolLog(handler, { tool: 'exploding_tool', tokenPrefix: 'trp_deadbeef', userId: 'user-1', sink });

    await expect(wrapped({}, {})).rejects.toThrow('boom');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain('outcome=threw');
    expect(sink.mock.calls[0][0]).toContain('tool=exploding_tool');
  });
});

describe('createTrippyMcpServer tool-call logging', () => {
  it('logs prepare_draft with token prefix and draft id, and never the plaintext token or booking content', async () => {
    const { token: plaintext, record: tokenRecord } = createToken(owner.id, {
      name: 'log-write',
      scopes: ['trips:read', 'trips:write'],
    });
    const trip = await createTrip(owner.id, {
      title: 'Log Test Trip', startDate: '2099-11-01', endDate: '2099-11-05',
    });

    const sink = vi.fn();
    const authInfo = {
      token: plaintext,
      clientId: tokenRecord.id,
      scopes: ['trips:read', 'trips:write'],
      extra: { userId: owner.id, tokenPrefix: plaintext.slice(0, TOKEN_PREFIX_LENGTH) },
    };
    const { client, server } = await connectClient(authInfo, sink);
    try {
      const result = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'log-test-1',
          target: { tripId: trip.trip.id },
          bookings: [{
            type: 'hotel',
            title: 'SENTINEL_TITLE_9f3',
            confirmationRef: 'SENTINEL_CONF_a1b',
            origin: 'SENTINEL_ORIGIN_c2d',
            destination: 'SENTINEL_DEST_e3f',
            terminalOrStation: 'SENTINEL_TERMINAL_g4h',
            notes: 'SENTINEL_NOTES_i5j',
            startDatetime: '2099-11-02T15:00:00',
            endDatetime: '2099-11-04T11:00:00',
            destinationTz: 'Asia/Tokyo',
          }],
          source: { kind: 'manual' },
        },
      });
      expect(result.isError).toBeFalsy();
      const draftId = result.structuredContent.draftId;

      expect(sink).toHaveBeenCalledTimes(1);
      const line = sink.mock.calls[0][0];
      expect(line).toContain('tool=prepare_draft');
      expect(line).toContain(`token=${plaintext.slice(0, TOKEN_PREFIX_LENGTH)}`);
      expect(line).toContain(`draft=${draftId}`);

      // Never the full plaintext token.
      expect(line).not.toContain(plaintext);
      // Never the 8 characters immediately after the legitimately-logged prefix.
      const afterPrefix = plaintext.slice(TOKEN_PREFIX_LENGTH, TOKEN_PREFIX_LENGTH + 8);
      expect(line).not.toContain(afterPrefix);
      // Never any booking content.
      for (const sentinel of [
        'SENTINEL_TITLE_9f3', 'SENTINEL_CONF_a1b', 'SENTINEL_ORIGIN_c2d',
        'SENTINEL_DEST_e3f', 'SENTINEL_TERMINAL_g4h', 'SENTINEL_NOTES_i5j',
      ]) {
        expect(line).not.toContain(sentinel);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('logs one line for list_trips with outcome=ok and no draft=', async () => {
    const sink = vi.fn();
    const authInfo = {
      token: 'irrelevant',
      clientId: 'client-1',
      scopes: ['trips:read'],
      extra: { userId: owner.id, tokenPrefix: 'trp_abcdefgh' },
    };
    const { client, server } = await connectClient(authInfo, sink);
    try {
      const result = await client.callTool({ name: 'list_trips', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(sink).toHaveBeenCalledTimes(1);
      const line = sink.mock.calls[0][0];
      expect(line).toContain('tool=list_trips');
      expect(line).toContain('outcome=ok');
      expect(line).not.toContain('draft=');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('logs outcome=error:insufficient_scope for a scope failure', async () => {
    const sink = vi.fn();
    const authInfo = {
      token: 'irrelevant',
      clientId: 'client-1',
      scopes: ['documents:write'],
      extra: { userId: owner.id, tokenPrefix: 'trp_abcdefgh' },
    };
    const { client, server } = await connectClient(authInfo, sink);
    try {
      const result = await client.callTool({ name: 'list_trips', arguments: {} });
      expect(result.isError).toBe(true);
      expect(sink).toHaveBeenCalledTimes(1);
      const line = sink.mock.calls[0][0];
      expect(line).toContain('tool=list_trips');
      expect(line).toContain('outcome=error:insufficient_scope');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
