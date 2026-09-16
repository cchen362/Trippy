// Plan 28 W3.3/W3.4: exercises PUT /mcp/uploads/:ticket end to end against a
// scratch Express app (F-28-15 — tests never import src/index.js), the same
// harness shape as tests/mcpClient.e2e.test.js. Tickets are issued directly
// through issueUploadTicket rather than through prepare_draft/apply_draft,
// since the draft/apply tool wiring belongs to the other Plan 28 W3 agent.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';

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
import { createBooking } from '../src/services/bookings.js';
import { inviteCollaborator } from '../src/services/collaboration.js';
import { createToken } from '../src/services/integrationTokens.js';
import { addAttachment, listAttachments } from '../src/services/attachments.js';
import { createMcpRouter } from '../src/routes/mcp.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { issueUploadTicket, uploadUrlFor, getUploadTicket } from '../src/services/mcp/uploads.js';

const FRONTEND_URL = 'http://localhost:5174';

let tmpDir;
let server;
let baseUrl;
let owner;
let tokenId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-mcp-uploads-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  owner = authService.setup('upl-owner', 'password123', 'Upload Owner').user;
  tokenId = createToken(owner.id, { name: 'uploads', scopes: ['documents:write'] }).record.id;

  const app = express();
  const mcp = createMcpRouter({ publicUrl: 'http://127.0.0.1/mcp', frontendUrl: FRONTEND_URL, appUrl: FRONTEND_URL });
  app.use('/mcp', mcp.router);
  app.use(errorHandler);
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

async function makeBooking() {
  const trip = createTrip(owner.id, {
    title: 'Upload test trip',
    destinations: ['Kobe'],
    destinationCountries: ['JP'],
    startDate: '2099-03-01',
    endDate: '2099-03-05',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
  const booking = await createBooking(owner.id, trip.trip.id, {
    type: 'hotel',
    title: 'Test hotel',
    confirmationRef: 'HOTEL-UP',
  });
  return { tripId: trip.trip.id, bookingId: booking.id };
}

function pngBuffer(payload = 'fake-png-bytes') {
  return Buffer.from(payload);
}

function expectThrows(fn, { code, status }) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  }
  expect(threw).toBe(true);
}

function issue(bookingId, { mediaType = 'image/png', body = pngBuffer(), sha256 } = {}) {
  const hash = sha256 || createHash('sha256').update(body).digest('hex');
  const ticket = issueUploadTicket({ userId: owner.id, tokenId, bookingId, mediaType, sizeBytes: body.length, sha256: hash });
  return { ticket, hash, body };
}

async function putBody(ticketId, body, contentType) {
  return fetch(`${baseUrl}/mcp/uploads/${ticketId}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  });
}

describe('uploadUrlFor', () => {
  it('appends /uploads/:id to the public MCP url', () => {
    expect(uploadUrlFor('http://localhost:3002/mcp', 'abc123')).toBe('http://localhost:3002/mcp/uploads/abc123');
  });
});

describe('issueUploadTicket validation', () => {
  it('rejects a bad sha256', async () => {
    const { bookingId } = await makeBooking();
    expectThrows(() => issueUploadTicket({
      userId: owner.id, tokenId, bookingId, mediaType: 'image/png', sizeBytes: 10, sha256: 'not-hex',
    }), { code: 'invalid_sha256', status: 400 });
  });

  it('rejects an unsupported mediaType', async () => {
    const { bookingId } = await makeBooking();
    expectThrows(() => issueUploadTicket({
      userId: owner.id, tokenId, bookingId, mediaType: 'text/plain', sizeBytes: 10, sha256: 'a'.repeat(64),
    }), { code: 'unsupported_media_type', status: 415 });
  });

  it('rejects sizeBytes over the media type cap', async () => {
    const { bookingId } = await makeBooking();
    expectThrows(() => issueUploadTicket({
      userId: owner.id, tokenId, bookingId, mediaType: 'image/png', sizeBytes: 5 * 1024 * 1024 + 1, sha256: 'a'.repeat(64),
    }), { code: 'too_large', status: 413 });
  });

  it('rejects a missing/non-integer sizeBytes', async () => {
    const { bookingId } = await makeBooking();
    expectThrows(() => issueUploadTicket({
      userId: owner.id, tokenId, bookingId, mediaType: 'image/png', sizeBytes: 1.5, sha256: 'a'.repeat(64),
    }), { code: 'invalid_size', status: 400 });
  });

  it('404s (not_found) for a booking the user cannot access', async () => {
    const { bookingId } = await makeBooking();
    const inviteCode = authService.getInviteCode();
    const stranger = authService.register('upl-stranger', 'password123', 'Stranger', inviteCode).user;
    expectThrows(() => issueUploadTicket({
      userId: stranger.id, tokenId, bookingId, mediaType: 'image/png', sizeBytes: 10, sha256: 'a'.repeat(64),
    }), { code: 'not_found', status: 404 });
  });
});

describe('happy path', () => {
  it('PUTs bytes matching the ticket and creates an mcp-sourced attachment', async () => {
    const { bookingId } = await makeBooking();
    const { ticket, body } = issue(bookingId);

    const res = await putBody(ticket.id, body, 'image/png');
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.attachmentId).toBeTruthy();
    expect(json.alreadyAttached).toBe(false);

    const list = listAttachments(owner.id, bookingId);
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('mcp');
    expect(list[0].contentHash).toBe(createHash('sha256').update(body).digest('hex'));

    const updatedTicket = getUploadTicket(ticket.id);
    expect(updatedTicket.status).toBe('used');
    expect(updatedTicket.attachmentId).toBe(json.attachmentId);
  });

  it('replaying the same bytes to the same ticket returns the same attachment, alreadyAttached true', async () => {
    const { bookingId } = await makeBooking();
    const { ticket, body } = issue(bookingId);

    const first = await putBody(ticket.id, body, 'image/png');
    const firstJson = await first.json();

    const second = await putBody(ticket.id, body, 'image/png');
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.attachmentId).toBe(firstJson.attachmentId);
    expect(secondJson.alreadyAttached).toBe(true);

    expect(listAttachments(owner.id, bookingId)).toHaveLength(1);
  });
});

describe('expired ticket', () => {
  it('returns 410 ticket_expired and marks the ticket expired', async () => {
    const { bookingId } = await makeBooking();
    const { ticket, body } = issue(bookingId);
    getDb().prepare("UPDATE mcp_upload_tickets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ticket.id);

    const res = await putBody(ticket.id, body, 'image/png');
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe('ticket_expired');

    expect(getUploadTicket(ticket.id).status).toBe('expired');
  });
});

describe('size limits', () => {
  it('413s a body over max_bytes but under the 10MB route cap', async () => {
    const { bookingId } = await makeBooking();
    const oversizedButUnder10mb = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    // Ticket issued for the true (smaller) size so issueUploadTicket itself
    // succeeds; the mismatch is caught at consume time against ticket.maxBytes.
    const small = pngBuffer('small');
    const { ticket } = issue(bookingId, { body: small });

    const res = await putBody(ticket.id, oversizedButUnder10mb, 'image/png');
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe('too_large');
    expect(listAttachments(owner.id, bookingId)).toHaveLength(0);
  });

  it('413s a body over the route-level 10MB cap (body-parser)', async () => {
    const { bookingId } = await makeBooking();
    const { ticket } = issue(bookingId, { body: pngBuffer('small') });
    const over10mb = Buffer.alloc(10 * 1024 * 1024 + 1, 1);

    const res = await putBody(ticket.id, over10mb, 'image/png');
    expect(res.status).toBe(413);
    expect(listAttachments(owner.id, bookingId)).toHaveLength(0);
  });
});

describe('hash mismatch', () => {
  it('422s and leaves the ticket pending', async () => {
    const { bookingId } = await makeBooking();
    const { ticket } = issue(bookingId, { body: pngBuffer('expected-bytes') });

    const res = await putBody(ticket.id, pngBuffer('different-bytes'), 'image/png');
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('sha256_mismatch');
    expect(getUploadTicket(ticket.id).status).toBe('pending');
  });
});

describe('media class mismatch', () => {
  it('415s a PDF body against an image ticket', async () => {
    const { bookingId } = await makeBooking();
    const body = pngBuffer('actually-a-pdf');
    const hash = createHash('sha256').update(body).digest('hex');
    const { ticket } = issue(bookingId, { mediaType: 'image/png', body, sha256: hash });

    const res = await putBody(ticket.id, body, 'application/pdf');
    expect(res.status).toBe(415);
  });
});

describe('MAX_ATTACHMENTS = 4', () => {
  it('issueUploadTicket 409s when the booking already has 4 attachments and this hash is new', async () => {
    const { bookingId } = await makeBooking();
    for (let i = 0; i < 4; i += 1) {
      addAttachment(owner.id, bookingId, { mediaType: 'image/png', filename: `p${i}.png`, content: Buffer.from(`p${i}`).toString('base64') });
    }
    expectThrows(() => issueUploadTicket({
      userId: owner.id, tokenId, bookingId, mediaType: 'image/png', sizeBytes: 5, sha256: 'b'.repeat(64),
    }), { code: 'attachment_limit', status: 409 });
  });

  it('PUT 409s attachment_limit when the 4th attachment landed after the ticket was issued', async () => {
    const { bookingId } = await makeBooking();
    for (let i = 0; i < 3; i += 1) {
      addAttachment(owner.id, bookingId, { mediaType: 'image/png', filename: `q${i}.png`, content: Buffer.from(`q${i}`).toString('base64') });
    }
    const { ticket, body } = issue(bookingId, { body: pngBuffer('the-4th-slot-taken') });
    // A 4th attachment lands through the normal UI path after the ticket was issued.
    addAttachment(owner.id, bookingId, { mediaType: 'image/png', filename: 'q3.png', content: Buffer.from('q3').toString('base64') });

    const res = await putBody(ticket.id, body, 'image/png');
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('attachment_limit');
  });
});

describe('unknown / access-revoked tickets', () => {
  it('404s ticket_not_found for an unknown ticket id', async () => {
    const res = await putBody('a'.repeat(64), pngBuffer(), 'image/png');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('ticket_not_found');
  });

  it('404s ticket_not_found when access was revoked after the ticket was issued', async () => {
    const { tripId, bookingId } = await makeBooking();
    const inviteCode = authService.getInviteCode();
    const collaborator = authService.register('upl-collab', 'password123', 'Collaborator', inviteCode).user;
    inviteCollaborator(owner.id, tripId, 'upl-collab');
    const collabTokenId = createToken(collaborator.id, { name: 'collab', scopes: ['documents:write'] }).record.id;

    const body = pngBuffer('revoked-access-bytes');
    const hash = createHash('sha256').update(body).digest('hex');
    const ticket = issueUploadTicket({
      userId: collaborator.id, tokenId: collabTokenId, bookingId, mediaType: 'image/png', sizeBytes: body.length, sha256: hash,
    });

    getDb().prepare('DELETE FROM trip_collaborators WHERE trip_id = ? AND user_id = ?').run(tripId, collaborator.id);

    const res = await putBody(ticket.id, body, 'image/png');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('ticket_not_found');
  });
});
