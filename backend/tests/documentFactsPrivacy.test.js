import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip, getTripDetail } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { createShareLink, getSharedTrip } from '../src/services/share.js';
import { copilotTripContext } from '../src/services/copilotTools.js';
import { createTrippyMcpServer } from '../src/services/mcp/server.js';

// D-37-7 (Plan 37): facts are private trip data. A fact row with a distinctive quote must not appear in
// the public share payload, in MCP get_trip, or in the co-pilot's trip context. (The /detail payload is
// held by tests/documentFactsRoute.test.js.)

const SECRET_QUOTE = 'Zebra-7731 cancellation lines must stay private';
const SECRET_LABEL = 'Zebra-7731 label';

let tmpDir;
let owner;
let tripId;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-document-facts-privacy-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('privacy-owner', 'password123', 'Privacy Owner').user;
  tripId = createTrip(owner.id, {
    title: 'Privacy trip', destinations: ['Kyoto'], destinationCountries: ['JP'],
    startDate: '2099-03-01', endDate: '2099-03-05', travellers: 'solo', interestTags: [], pace: 'moderate',
  }).trip.id;
  const booking = await createBooking(owner.id, tripId, { type: 'hotel', title: 'Privacy hotel' });

  const db = getDb();
  const attachmentId = db.prepare(`
    INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
    VALUES (?, 'application/pdf', 'conf.pdf', 1, ?, 'h', 'manual') RETURNING id
  `).get(booking.id, Buffer.from('x')).id;
  const readId = db.prepare(`
    INSERT INTO document_fact_reads (trip_id, booking_id, attachment_id, content_hash, model, prompt_version, status, fact_count, verified_count)
    VALUES (?, ?, ?, 'h', 'claude-haiku-5-5', '37.1', 'complete', 1, 1) RETURNING id
  `).get(tripId, booking.id, attachmentId).id;
  db.prepare(`
    INSERT INTO document_facts (read_id, trip_id, booking_id, attachment_id, kind, label, value, quote, page, verified_page, quote_verified, tz_source, confidence, position)
    VALUES (?, ?, ?, ?, 'deadline', ?, 'private value', ?, 1, 1, 1, 'none', 'high', 0)
  `).run(readId, tripId, booking.id, attachmentId, SECRET_LABEL, SECRET_QUOTE);
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

const expectNoFacts = (value) => {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('Zebra-7731');
  expect(serialized).not.toContain('private value');
};

describe('facts stay out of every other payload (D-37-7)', () => {
  it('the public share payload', () => {
    const { token } = createShareLink(owner.id, tripId);
    expectNoFacts(getSharedTrip(token));
  });

  it('MCP get_trip, with every optional section included', async () => {
    const server = createTrippyMcpServer({
      authInfo: { token: 'test', clientId: 'test-client-id', scopes: ['trips:read'], extra: { userId: owner.id } },
      appUrl: 'http://localhost:5174',
      publicUrl: 'http://localhost:3002/mcp',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'get_trip', arguments: { tripId, include: ['days', 'bookings'] } });
      expect(result.structuredContent.bookings).toHaveLength(1);
      expectNoFacts(result);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the co-pilot trip context', () => {
    const context = copilotTripContext(getTripDetail(tripId, owner.id));
    expect(context.bookings).toHaveLength(1);
    expectNoFacts(context);
  });
});
