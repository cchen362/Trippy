import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { inviteCollaborator } from '../src/services/collaboration.js';
import tripRoutes from '../src/routes/trips.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

// Plan 37 W1: GET /api/trips/:tripId/facts, mounted the way index.js mounts the trips router, on a
// scratch Express app (tests never import src/index.js, F-28-15). The rows are inserted directly: the
// route's job is access and shape, and the read job has its own file (documentFacts.test.js).

let tmpDir;
let server;
let baseUrl;
let tripId;
let bookingId;
let attachmentId;
let tokens;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-document-facts-route-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  const owner = authService.setup('facts-owner', 'password123', 'Facts Owner').user;
  const inviteCode = authService.getInviteCode();
  const collaborator = authService.register('facts-collab', 'password123', 'Facts Collab', inviteCode).user;
  authService.register('facts-stranger', 'password123', 'Facts Stranger', inviteCode);

  tripId = createTrip(owner.id, {
    title: 'Facts route trip', destinations: ['Kyoto'], destinationCountries: ['JP'],
    startDate: '2099-03-01', endDate: '2099-03-05', travellers: 'solo', interestTags: [], pace: 'moderate',
  }).trip.id;
  inviteCollaborator(owner.id, tripId, collaborator.username);
  bookingId = (await createBooking(owner.id, tripId, { type: 'hotel', title: 'Route hotel' })).id;

  const db = getDb();
  attachmentId = db.prepare(`
    INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
    VALUES (?, 'application/pdf', 'conf.pdf', 1, ?, 'h', 'manual') RETURNING id
  `).get(bookingId, Buffer.from('x')).id;
  const readId = db.prepare(`
    INSERT INTO document_fact_reads (trip_id, booking_id, attachment_id, content_hash, model, prompt_version, status, fact_count, verified_count)
    VALUES (?, ?, ?, 'h', 'claude-haiku-5-5', '37.1', 'complete', 1, 1) RETURNING id
  `).get(tripId, bookingId, attachmentId).id;
  db.prepare(`
    INSERT INTO document_facts (read_id, trip_id, booking_id, attachment_id, kind, label, value, quote, page, verified_page, quote_verified, tz_source, confidence, position)
    VALUES (?, ?, ?, ?, 'window', 'Check-in from', '15:00', 'Check-in from 15:00', 1, 1, 1, 'none', 'high', 0)
  `).run(readId, tripId, bookingId, attachmentId);

  tokens = {
    owner: authService.login('facts-owner', 'password123').token,
    collaborator: authService.login('facts-collab', 'password123').token,
    stranger: authService.login('facts-stranger', 'password123').token,
  };

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/trips', tripRoutes);
  app.use(errorHandler);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

const get = (token, query = '') => fetch(`${baseUrl}/api/trips/${tripId}/facts${query}`, { headers: token ? { Cookie: `auth_token=${token}` } : {} });

describe('GET /api/trips/:tripId/facts', () => {
  it('returns the trip facts to its owner', async () => {
    const res = await get(tokens.owner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readsPending).toBe(0);
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0].bookingId).toBe(bookingId);
    expect(body.bookings[0].facts[0]).toMatchObject({
      kind: 'window', label: 'Check-in from', quote: 'Check-in from 15:00', page: 1, quoteVerified: true,
      document: { key: `attachment:${attachmentId}`, url: `/api/bookings/${bookingId}/attachments/${attachmentId}` },
    });
  });

  it('?wait=1 with nothing pending answers at once with the same body', async () => {
    const plain = await (await get(tokens.owner)).json();
    const held = await get(tokens.owner, '?wait=1');
    expect(held.status).toBe(200);
    expect(await held.json()).toEqual(plain);
  });

  it('?wait=1 keeps the access rules: a stranger gets a 404 and no session a 401', async () => {
    expect((await get(tokens.stranger, '?wait=1')).status).toBe(404);
    expect((await get(null, '?wait=1')).status).toBe(401);
  });

  it('returns them to a collaborator', async () => {
    const res = await get(tokens.collaborator);
    expect(res.status).toBe(200);
    expect((await res.json()).bookings).toHaveLength(1);
  });

  it('is a 404 for a user with no access to the trip, and a 401 without a session', async () => {
    expect((await get(tokens.stranger)).status).toBe(404);
    expect((await get(null)).status).toBe(401);
  });

  it('is not part of the trip detail payload', async () => {
    const res = await fetch(`${baseUrl}/api/trips/${tripId}/detail`, { headers: { Cookie: `auth_token=${tokens.owner}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('Check-in from 15:00');
    expect(text).not.toContain('quoteVerified');
  });
});

// D-37-10 (Plan 37): a zone-less fact is served with its booking's zone, derived at read time.
describe('GET /api/trips/:tripId/facts: the booking zone', () => {
  let zoneTripId;
  const ids = {};
  const fetchFacts = async () => (await fetch(`${baseUrl}/api/trips/${zoneTripId}/facts`, { headers: { Cookie: `auth_token=${tokens.owner}` } })).json();
  const factsOf = (body, bookingId) => body.bookings.find((b) => b.bookingId === bookingId).facts;

  beforeAll(async () => {
    const db = getDb();
    const ownerId = db.prepare("SELECT id FROM users WHERE username = 'facts-owner'").get().id;
    zoneTripId = createTrip(ownerId, {
      title: 'Zone trip', destinations: ['Kuala Lumpur'], destinationCountries: ['MY'],
      startDate: '2099-04-01', endDate: '2099-04-05', travellers: 'solo', interestTags: [], pace: 'moderate',
    }).trip.id;

    const makeBooking = async (title, type, columns, details = {}) => {
      const id = (await createBooking(ownerId, zoneTripId, { type, title })).id;
      db.prepare('UPDATE bookings SET origin_tz = ?, destination_tz = ?, start_datetime = ?, details_json = ? WHERE id = ?')
        .run(columns.origin ?? null, columns.destination ?? null, columns.start ?? null, JSON.stringify(details), id);
      return id;
    };
    // One PDF backs both flights, which sit in different zones.
    const artifactId = db.prepare("INSERT INTO import_artifacts (user_id, status) VALUES (?, 'extracted') RETURNING id").get(ownerId).id;
    const fileId = db.prepare(`
      INSERT INTO import_artifact_files (artifact_id, position, kind, media_type, filename, size_bytes, content_hash, content)
      VALUES (?, 0, 'pdf', 'application/pdf', 'two.pdf', 1, 'hz', ?) RETURNING id
    `).get(artifactId, Buffer.from('x')).id;
    const imported = { importedFrom: { artifactId, model: 'm', extractedAt: 'now', filePositions: [0] } };
    ids.tokyo = await makeBooking('Out', 'flight', { origin: 'Asia/Tokyo', destination: 'Europe/London' }, imported);
    ids.london = await makeBooking('Back', 'flight', { origin: 'Europe/London' }, imported);
    ids.dayCountry = await makeBooking('Day hotel', 'hotel', { start: '2099-04-02T14:00' });
    ids.none = await makeBooking('Nowhere', 'other', { start: '2098-01-01T10:00' });

    const readId = db.prepare(`
      INSERT INTO document_fact_reads (trip_id, booking_id, artifact_file_id, content_hash, model, prompt_version, status, fact_count, verified_count)
      VALUES (?, ?, ?, 'hz', 'claude-haiku-5-5', '37.1', 'complete', 2, 2) RETURNING id
    `).get(zoneTripId, ids.tokyo, fileId).id;
    const insertFact = db.prepare(`
      INSERT INTO document_facts (read_id, trip_id, booking_id, artifact_file_id, kind, label, value, quote, page, verified_page, quote_verified, value_at, value_tz, tz_source, confidence, position)
      VALUES (?, ?, ?, ?, 'deadline', ?, 'x', ?, 1, 1, 1, ?, ?, ?, 'high', ?)
    `);
    insertFact.run(readId, zoneTripId, ids.tokyo, fileId, 'Written zone', 'q1', '2099-04-02T10:00', 'Asia/Seoul', 'document', 0);
    insertFact.run(readId, zoneTripId, ids.tokyo, fileId, 'No zone', 'q2', '2099-04-02T11:00', null, 'none', 1);
    insertFact.run(readId, zoneTripId, ids.tokyo, fileId, 'Bad zone', 'q3', '2099-04-02T12:00', 'Asia/Nowhere', 'document', 2);

    // The two single-booking cases each own an attachment with one zone-less fact.
    for (const key of ['dayCountry', 'none']) {
      const attachment = db.prepare(`
        INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
        VALUES (?, 'application/pdf', ?, 1, ?, ?, 'manual') RETURNING id
      `).get(ids[key], `${key}.pdf`, Buffer.from('x'), `h-${key}`).id;
      const read = db.prepare(`
        INSERT INTO document_fact_reads (trip_id, booking_id, attachment_id, content_hash, model, prompt_version, status, fact_count, verified_count)
        VALUES (?, ?, ?, ?, 'claude-haiku-5-5', '37.1', 'complete', 1, 1) RETURNING id
      `).get(zoneTripId, ids[key], attachment, `h-${key}`).id;
      db.prepare(`
        INSERT INTO document_facts (read_id, trip_id, booking_id, attachment_id, kind, label, value, quote, page, verified_page, quote_verified, value_at, tz_source, confidence, position)
        VALUES (?, ?, ?, ?, 'deadline', 'No zone', 'x', 'q', 1, 1, 1, '2099-04-02T09:00', 'none', 'high', 0)
      `).run(read, zoneTripId, ids[key], attachment);
    }
  });

  it('keeps a stored document zone and derives the rest from the booking', async () => {
    const [written, derived] = factsOf(await fetchFacts(), ids.tokyo);
    expect(written).toMatchObject({ tz: 'Asia/Seoul', tzSource: 'document' });
    expect(derived).toMatchObject({ tz: 'Asia/Tokyo', tzSource: 'booking' });
  });

  it("gives one document backing two bookings each booking's own zone", async () => {
    const body = await fetchFacts();
    expect(factsOf(body, ids.london).find((f) => f.label === 'No zone')).toMatchObject({ tz: 'Europe/London', tzSource: 'booking' });
    expect(factsOf(body, ids.london).find((f) => f.label === 'Written zone')).toMatchObject({ tz: 'Asia/Seoul', tzSource: 'document' });
    expect(factsOf(body, ids.tokyo).find((f) => f.label === 'No zone').tz).toBe('Asia/Tokyo');
  });

  it('treats a stored zone the platform rejects as absent', async () => {
    const body = await fetchFacts();
    expect(factsOf(body, ids.tokyo).find((f) => f.label === 'Bad zone')).toMatchObject({ tz: 'Asia/Tokyo', tzSource: 'booking' });
    expect(factsOf(body, ids.london).find((f) => f.label === 'Bad zone')).toMatchObject({ tz: 'Europe/London', tzSource: 'booking' });
  });

  it('falls back to the zone of the country of the day the booking starts on', async () => {
    expect(factsOf(await fetchFacts(), ids.dayCountry)[0]).toMatchObject({ tz: 'Asia/Kuala_Lumpur', tzSource: 'booking' });
  });

  it('leaves a booking with no zone evidence at none', async () => {
    expect(factsOf(await fetchFacts(), ids.none)[0]).toMatchObject({ tz: null, tzSource: 'none' });
  });
});
