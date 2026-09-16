// Plan 28 W2.6: the durable MCP draft/apply flow, exercised against a temp
// SQLite DB with only external I/O mocked (mirrors tests/copilotProposals.test.js) —
// the real validate/draft/fingerprint/transaction code runs for every case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

vi.mock('../src/services/placeResolver.js', () => ({
  resolvePlace: vi.fn().mockResolvedValue({
    lat: 30.0, lng: 120.0, resolvedName: 'Resolved Place', resolvedAddress: 'Some Address',
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

import { resolvePlace } from '../src/services/placeResolver.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { createToken } from '../src/services/integrationTokens.js';
import { inviteCollaborator } from '../src/services/collaboration.js';
import { createTrippyMcpServer } from '../src/services/mcp/server.js';

const APP_URL = 'http://localhost:5174';

let tmpDir;
let owner;

function authInfoFor(userId, scopes, tokenRecordId) {
  return { token: 'test', clientId: tokenRecordId, scopes, extra: { userId, tokenId: tokenRecordId } };
}

async function connectClient(authInfo) {
  const server = createTrippyMcpServer({ authInfo, appUrl: APP_URL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function tokenFor(userId, scopes) {
  return createToken(userId, { name: 'test-token', scopes }).record.id;
}

async function futureTrip(userId, overrides = {}) {
  return createTrip(userId, {
    title: 'Kyoto autumn',
    startDate: '2099-11-01',
    endDate: '2099-11-05',
    destinations: [{ city: 'Kyoto', countryCode: 'JP' }],
    ...overrides,
  }).trip;
}

function hotelBooking(overrides = {}) {
  return {
    type: 'hotel',
    title: 'Hotel Granvia',
    startDatetime: '2099-11-02T15:00:00',
    endDatetime: '2099-11-04T11:00:00',
    destination: 'Kyoto',
    ...overrides,
  };
}

function manualSource() {
  return { kind: 'manual' };
}

function countBookingRows(tripId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ?').get(tripId).n;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-mcp-drafts-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('mcp-drafts-owner', 'password123', 'MCP Drafts Owner').user;
  resolvePlace.mockClear();
  resolvePlace.mockResolvedValue({
    lat: 30.0, lng: 120.0, resolvedName: 'Resolved Place', resolvedAddress: 'Some Address',
    coordinateSystem: 'wgs84', coordinateSource: 'nominatim', locationStatus: 'resolved',
    confidence: 0.9, providerId: 'osm:1', countryCode: 'JP',
  });
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('prepare_draft idempotency', () => {
  it('returns the same draftId for the same idempotencyKey and inserts exactly one row', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const args = { idempotencyKey: 'key-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() };
      const first = await client.callTool({ name: 'prepare_draft', arguments: args });
      const second = await client.callTool({ name: 'prepare_draft', arguments: args });
      expect(first.structuredContent.draftId).toBe(second.structuredContent.draftId);
      const count = getDb().prepare('SELECT COUNT(*) AS n FROM mcp_drafts WHERE idempotency_key = ?').get('key-1').n;
      expect(count).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('apply_draft happy path', () => {
  it('honours MCP_APPLY_RESOLVE_DELAY_MS during the resolve phase (Cloudflare timing seam)', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    process.env.MCP_APPLY_RESOLVE_DELAY_MS = '300';
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'apply-delay', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      const started = Date.now();
      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId: prepared.structuredContent.draftId } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(applied.structuredContent.status).toBe('applied');
      expect(countBookingRows(trip.id)).toBe(1);
    } finally {
      delete process.env.MCP_APPLY_RESOLVE_DELAY_MS;
      await client.close();
      await server.close();
    }
  });

  it('applies once, creates one booking and one stop, and is idempotent on retry', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'apply-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      expect(prepared.structuredContent.applyAllowed).toBe(true);
      const draftId = prepared.structuredContent.draftId;

      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(applied.isError).toBeFalsy();
      expect(applied.structuredContent.status).toBe('applied');
      expect(applied.structuredContent.bookings).toHaveLength(1);
      const bookingId = applied.structuredContent.bookings[0].bookingId;
      const stopId = applied.structuredContent.bookings[0].stopId;
      expect(bookingId).toBeTruthy();
      expect(stopId).toBeTruthy();
      expect(countBookingRows(trip.id)).toBe(1);
      const stopRow = getDb().prepare('SELECT * FROM stops WHERE id = ?').get(stopId);
      expect(stopRow.booking_id).toBe(bookingId);
      // A manual source has no document to hand over; W3 adds upload tickets.
      expect(applied.structuredContent.sourceDocument).toEqual({ status: 'not_requested' });

      const appliedAgain = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(appliedAgain.structuredContent.status).toBe('already_applied');
      expect(appliedAgain.structuredContent.bookings[0].bookingId).toBe(bookingId);
      expect(countBookingRows(trip.id)).toBe(1);
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM stops WHERE booking_id = ?').get(bookingId).n).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports a screenshot source as unsupported until W3 issues upload tickets', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'apply-shot',
          target: { tripId: trip.id },
          bookings: [hotelBooking()],
          source: { kind: 'screenshot', sha256: 'a'.repeat(64), mediaType: 'image/png', sizeBytes: 1234 },
        },
      });
      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId: prepared.structuredContent.draftId } });
      expect(applied.structuredContent.status).toBe('applied');
      expect(applied.structuredContent.sourceDocument).toEqual({ status: 'unsupported' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('stale detection', () => {
  it('goes stale when a manual booking is created on the trip between prepare and apply', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'stale-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      const draftId = prepared.structuredContent.draftId;

      await createBooking(owner.id, trip.id, { type: 'other', title: 'Manual add', startDatetime: '2099-11-03T09:00:00', destination: 'Kyoto' });

      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(applied.isError).toBe(true);
      expect(applied.structuredContent.error).toBe('stale');
      expect(countBookingRows(trip.id)).toBe(1); // only the manual one

      const status = await client.callTool({ name: 'get_apply_status', arguments: { draftId } });
      expect(status.structuredContent.draftStatus).toBe('stale');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('blocker refusal', () => {
  it('refuses a cost field with a blocker and writes nothing', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const booking = { ...hotelBooking(), cost: { amount: 100, currency: 'USD' } };
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'blocker-1', target: { tripId: trip.id }, bookings: [booking], source: manualSource() },
      });
      expect(prepared.structuredContent.applyAllowed).toBe(false);
      expect(prepared.structuredContent.issues.some((i) => i.code === 'cost_not_accepted')).toBe(true);
      const draftId = prepared.structuredContent.draftId;

      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(applied.isError).toBe(true);
      expect(applied.structuredContent.error).toBe('apply_refused');
      expect(countBookingRows(trip.id)).toBe(0);

      const status = await client.callTool({ name: 'get_apply_status', arguments: { draftId } });
      expect(status.structuredContent.draftStatus).toBe('invalid');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('resolver failure leaves the draft pending', () => {
  it('writes zero rows on a resolver rejection and succeeds on retry', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      // destinationTz is supplied so re-validation's timezone_unknown suggestion
      // lookup never calls resolvePlace — the mocked rejection below must be
      // consumed by the actual stop-geocode call in the resolve phase, not by
      // an unrelated tz-suggestion lookup during apply's re-validation step.
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'resolver-fail-1', target: { tripId: trip.id }, bookings: [hotelBooking({ destinationTz: 'Asia/Tokyo' })], source: manualSource() },
      });
      const draftId = prepared.structuredContent.draftId;

      // The MCP SDK converts an uncaught handler exception into an isError tool
      // result rather than a protocol-level rejection — this is standard
      // registerTool behavior, not something apply.js/tools.js opts into. What
      // matters here is that the failure was never one of validate/drafts/apply's
      // own deliberate refusal codes, and that nothing was written.
      resolvePlace.mockRejectedValueOnce(new Error('simulated resolver failure'));
      const failed = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toBeUndefined();
      expect(countBookingRows(trip.id)).toBe(0);

      const statusAfterFailure = await client.callTool({ name: 'get_apply_status', arguments: { draftId } });
      expect(statusAfterFailure.structuredContent.draftStatus).toBe('pending');

      const retried = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(retried.isError).toBeFalsy();
      expect(retried.structuredContent.status).toBe('applied');
      expect(countBookingRows(trip.id)).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('showInItinerary and outside_trip_dates', () => {
  it('plans no stop when showInItinerary is false and applies with stopId null', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const booking = hotelBooking({ showInItinerary: false });
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'noshow-1', target: { tripId: trip.id }, bookings: [booking], source: manualSource() },
      });
      expect(prepared.structuredContent.plannedEffects[0]).toMatchObject({ stop: { willCreate: false, reason: 'not_shown_in_itinerary' } });
      const draftId = prepared.structuredContent.draftId;

      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(applied.structuredContent.bookings[0].stopId).toBeNull();
      expect(applied.structuredContent.bookings[0].stopReason).toBe('not_shown_in_itinerary');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('flags outside_trip_dates as a blocker', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const booking = hotelBooking({ startDatetime: '2099-12-01T15:00:00', endDatetime: '2099-12-02T11:00:00' });
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'outside-1', target: { tripId: trip.id }, bookings: [booking], source: manualSource() },
      });
      expect(prepared.structuredContent.applyAllowed).toBe(false);
      expect(prepared.structuredContent.issues.some((i) => i.code === 'outside_trip_dates')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('no_day_for_date', () => {
  it('flags an info issue and applies with stopReason no_day_for_date when the day row is missing', async () => {
    const trip = await futureTrip(owner.id);
    getDb().prepare('DELETE FROM days WHERE trip_id = ? AND date = ?').run(trip.id, '2099-11-02');

    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'noday-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      expect(prepared.structuredContent.issues.some((i) => i.code === 'no_day_for_date')).toBe(true);
      expect(prepared.structuredContent.applyAllowed).toBe(true);
      const draftId = prepared.structuredContent.draftId;

      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(applied.structuredContent.bookings[0].stopId).toBeNull();
      expect(applied.structuredContent.bookings[0].stopReason).toBe('no_day_for_date');
      expect(countBookingRows(trip.id)).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('timezone suggestions', () => {
  it('is an info issue that does not block apply when tz is omitted', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const flight = { type: 'flight', title: 'JL123', startDatetime: '2099-11-01T10:00:00', origin: 'Tokyo', destination: 'Kyoto' };
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'tz-1', target: { tripId: trip.id }, bookings: [flight], source: manualSource() },
      });
      const tzIssues = prepared.structuredContent.issues.filter((i) => i.code === 'timezone_unknown');
      expect(tzIssues.length).toBe(2); // originTz + destinationTz
      expect(prepared.structuredContent.applyAllowed).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('suggests a valid IANA zone when detailsJson carries lat/lng', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const flight = {
        type: 'flight', title: 'JL123', startDatetime: '2099-11-01T10:00:00', origin: 'Tokyo', destination: 'Kyoto',
        detailsJson: { lat: 35.0, lng: 135.7 },
      };
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'tz-2', target: { tripId: trip.id }, bookings: [flight], source: manualSource() },
      });
      const tzIssue = prepared.structuredContent.issues.find((i) => i.code === 'timezone_unknown' && i.field === 'destinationTz');
      expect(tzIssue.suggestion).toBe('Asia/Tokyo');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('field validation blockers', () => {
  async function prepareAndGetIssues(client, booking, key) {
    const trip = await futureTrip(owner.id, { title: `Trip ${key}` });
    const result = await client.callTool({
      name: 'prepare_draft',
      arguments: { idempotencyKey: key, target: { tripId: trip.id }, bookings: [booking], source: manualSource() },
    });
    return result.structuredContent.issues;
  }

  it('flags invalid_datetime, end_before_start, invalid_timezone, and missing_required_field', async () => {
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const badDatetime = await prepareAndGetIssues(client, hotelBooking({ startDatetime: 'not-a-date' }), 'bad-dt');
      expect(badDatetime.some((i) => i.code === 'invalid_datetime' && i.field === 'startDatetime')).toBe(true);

      const reversed = await prepareAndGetIssues(client, hotelBooking({ startDatetime: '2099-11-04T10:00:00', endDatetime: '2099-11-02T10:00:00' }), 'reversed');
      expect(reversed.some((i) => i.code === 'end_before_start')).toBe(true);

      const badTz = await prepareAndGetIssues(client, hotelBooking({ destinationTz: 'Not/AZone' }), 'bad-tz');
      expect(badTz.some((i) => i.code === 'invalid_timezone' && i.field === 'destinationTz')).toBe(true);

      const missingEnd = await prepareAndGetIssues(client, { type: 'hotel', title: 'No End Hotel', startDatetime: '2099-11-02T15:00:00', destination: 'Kyoto' }, 'missing-end');
      expect(missingEnd.some((i) => i.code === 'missing_required_field' && i.field === 'endDatetime')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('duplicate detection', () => {
  it('flags duplicate_confirmation_ref and probable_duplicate', async () => {
    const trip = await futureTrip(owner.id);
    await createBooking(owner.id, trip.id, {
      type: 'hotel', title: 'Existing Hotel', confirmationRef: 'ABC123',
      startDatetime: '2099-11-02T15:00:00', endDatetime: '2099-11-04T11:00:00', destination: 'Kyoto',
    });
    await createBooking(owner.id, trip.id, {
      type: 'flight', title: 'Existing Flight',
      startDatetime: '2099-11-03T09:00:00', origin: 'Tokyo', destination: 'Osaka',
    });

    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const dupRef = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'dup-ref', target: { tripId: trip.id },
          bookings: [hotelBooking({ confirmationRef: 'abc123' })], source: manualSource(),
        },
      });
      const dupIssue = dupRef.structuredContent.issues.find((i) => i.code === 'duplicate_confirmation_ref');
      expect(dupIssue).toBeTruthy();
      expect(dupIssue.existingBookingId).toBeTruthy();

      const probable = await client.callTool({
        name: 'prepare_draft',
        arguments: {
          idempotencyKey: 'dup-probable', target: { tripId: trip.id },
          bookings: [{ type: 'flight', title: 'Different title', startDatetime: '2099-11-03T09:00:00', origin: 'Tokyo', destination: 'Osaka' }],
          source: manualSource(),
        },
      });
      const probableIssue = probable.structuredContent.issues.find((i) => i.code === 'probable_duplicate');
      expect(probableIssue).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('cross-user isolation and collaborator access', () => {
  it('returns not_found for a stranger and allows a collaborator to prepare and apply', async () => {
    const trip = await futureTrip(owner.id);
    const { value: inviteCode } = getDb().prepare("SELECT value FROM settings WHERE key='invite_code'").get();
    const stranger = authService.register('mcp-drafts-stranger', 'password123', 'Stranger', inviteCode).user;
    const collaborator = authService.register('mcp-drafts-collab', 'password123', 'Collaborator', inviteCode).user;
    inviteCollaborator(owner.id, trip.id, collaborator.username);

    const ownerTokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client: ownerClient, server: ownerServer } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], ownerTokenId));
    let draftId;
    try {
      const prepared = await ownerClient.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'isolation-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      draftId = prepared.structuredContent.draftId;
    } finally {
      await ownerClient.close();
      await ownerServer.close();
    }

    const strangerTokenId = tokenFor(stranger.id, ['trips:read', 'trips:write']);
    const { client: strangerClient, server: strangerServer } = await connectClient(authInfoFor(stranger.id, ['trips:read', 'trips:write'], strangerTokenId));
    try {
      const strangerApply = await strangerClient.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(strangerApply.isError).toBe(true);
      expect(strangerApply.structuredContent.error).toBe('not_found');

      const strangerStatus = await strangerClient.callTool({ name: 'get_apply_status', arguments: { draftId } });
      expect(strangerStatus.isError).toBe(true);
      expect(strangerStatus.structuredContent.error).toBe('not_found');
    } finally {
      await strangerClient.close();
      await strangerServer.close();
    }

    const collabTokenId = tokenFor(collaborator.id, ['trips:read', 'trips:write']);
    const { client: collabClient, server: collabServer } = await connectClient(authInfoFor(collaborator.id, ['trips:read', 'trips:write'], collabTokenId));
    try {
      const collabPrepared = await collabClient.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'isolation-collab', target: { tripId: trip.id }, bookings: [hotelBooking({ confirmationRef: 'COLLAB1' })], source: manualSource() },
      });
      expect(collabPrepared.isError).toBeFalsy();
      const collabApplied = await collabClient.callTool({ name: 'apply_draft', arguments: { draftId: collabPrepared.structuredContent.draftId } });
      expect(collabApplied.isError).toBeFalsy();
      expect(collabApplied.structuredContent.status).toBe('applied');
    } finally {
      await collabClient.close();
      await collabServer.close();
    }
  });
});

describe('expiry', () => {
  it('expires a pending draft past its expires_at and refuses apply', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'expiry-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      const draftId = prepared.structuredContent.draftId;
      getDb().prepare("UPDATE mcp_drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(draftId);

      const applied = await client.callTool({ name: 'apply_draft', arguments: { draftId } });
      expect(applied.isError).toBe(true);
      expect(applied.structuredContent.error).toBe('expired');

      const row = getDb().prepare('SELECT status FROM mcp_drafts WHERE id = ?').get(draftId);
      expect(row.status).toBe('expired');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('get_apply_status by idempotencyKey', () => {
  it('returns the stored result after apply', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read', 'trips:write']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read', 'trips:write'], tokenId));
    try {
      const prepared = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'status-by-key', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      const draftId = prepared.structuredContent.draftId;
      await client.callTool({ name: 'apply_draft', arguments: { draftId } });

      const status = await client.callTool({ name: 'get_apply_status', arguments: { idempotencyKey: 'status-by-key' } });
      expect(status.structuredContent.draftStatus).toBe('applied');
      expect(status.structuredContent.bookings).toHaveLength(1);
      expect(status.structuredContent.bookings[0].url).toBe(`${APP_URL}/trips/${trip.id}/logistics`);
      expect(status.structuredContent.tripUrl).toBe(`${APP_URL}/trips/${trip.id}`);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('scope enforcement', () => {
  it('refuses prepare_draft for a token without trips:write', async () => {
    const trip = await futureTrip(owner.id);
    const tokenId = tokenFor(owner.id, ['trips:read']);
    const { client, server } = await connectClient(authInfoFor(owner.id, ['trips:read'], tokenId));
    try {
      const result = await client.callTool({
        name: 'prepare_draft',
        arguments: { idempotencyKey: 'scope-1', target: { tripId: trip.id }, bookings: [hotelBooking()], source: manualSource() },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toBe('insufficient_scope');
      expect(result.structuredContent.requiredScope).toBe('trips:write');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
