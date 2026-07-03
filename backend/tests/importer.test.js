import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Mock @anthropic-ai/sdk before importing any service that touches claude.js ---
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

vi.mock('../src/config.js', () => ({
  config: { anthropicApiKey: 'test-key' },
}));

// Import after mocks are in place
const { initDb, getDb } = await import('../src/db/database.js');
const { runMigrations } = await import('../src/db/migrations.js');
const authService = await import('../src/services/auth.js');
const { createTrip } = await import('../src/services/trips.js');
const { inviteCollaborator } = await import('../src/services/collaboration.js');
const {
  createArtifactAndExtract,
  reextractArtifact,
  confirmArtifact,
  listArtifactsForTrip,
  getArtifactDetail,
  deleteArtifact,
  normalizeExtractedBooking,
} = await import('../src/services/importer.js');

const flightEmailText = readFileSync(join(__dirname, 'fixtures/flight-email.txt'), 'utf8');
const trainTicketBase64 = readFileSync(join(__dirname, 'fixtures/train-ticket.png')).toString('base64');

function claudeResponse(json) {
  return {
    content: [{ type: 'text', text: '```json\n' + JSON.stringify(json) + '\n```' }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function extractionWithBookings(bookings, overrides = {}) {
  return {
    isTravelRelated: true,
    summary: 'Test extraction',
    language: 'en',
    bookings,
    ...overrides,
  };
}

function flightBooking(overrides = {}) {
  return {
    type: 'flight',
    title: 'MU5401',
    confirmationRef: 'ABC123',
    bookingSource: 'Trip.com',
    startDatetime: '2026-09-14T08:35',
    endDatetime: '2026-09-14T11:50',
    origin: 'SHA - Shanghai Hongqiao',
    destination: 'CTU - Chengdu Tianfu',
    terminalOrStation: 'Terminal 2',
    originTz: 'Asia/Shanghai',
    destinationTz: 'Asia/Shanghai',
    details: {
      originCity: 'Shanghai', destinationCity: 'Chengdu',
      originCountryCode: 'CN', destinationCountryCode: 'CN',
      city: null, carrierCode: 'MU', flightNumber: '5401', airlineName: 'China Eastern',
      trainNumber: null, originStation: null, destinationStation: null,
      seatClass: null, address: null, localName: null, note: null,
    },
    confidence: { overall: 'high', fields: {} },
    assumptions: [],
    ...overrides,
  };
}

let tmpDir;
let owner;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-import-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();
  vi.clearAllMocks();

  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function makeTrip() {
  return createTrip(owner.id, {
    title: 'Sichuan Trip',
    destinations: ['Chengdu'],
    destinationCountries: ['CN'],
    startDate: '2026-09-10',
    endDate: '2026-09-20',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
}

describe('normalizeExtractedBooking', () => {
  it('appends :00 to a valid wall-clock datetime', () => {
    const result = normalizeExtractedBooking(flightBooking(), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    expect(result.startDatetime).toBe('2026-09-14T08:35:00');
    expect(result.endDatetime).toBe('2026-09-14T11:50:00');
  });

  it('normalizes a malformed datetime to null rather than padding it', () => {
    const result = normalizeExtractedBooking(flightBooking({ startDatetime: '2026-09-14' }), {
      artifactId: 'a1', model: 'm', extractedAt: 'now',
    });
    expect(result.startDatetime).toBeNull();
  });

  it('strips null-valued detail keys and stamps importedFrom server-side', () => {
    const result = normalizeExtractedBooking(flightBooking(), { artifactId: 'artifact-1', model: 'claude-sonnet-4-6', extractedAt: '2026-01-01T00:00:00.000Z' });
    expect(result.detailsJson.trainNumber).toBeUndefined();
    expect(result.detailsJson.destinationCity).toBe('Chengdu');
    expect(result.detailsJson.importedFrom).toEqual({
      artifactId: 'artifact-1', model: 'claude-sonnet-4-6', extractedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('coerces an unrecognized type to other', () => {
    const result = normalizeExtractedBooking(flightBooking({ type: 'monorail' }), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    expect(result.type).toBe('other');
  });

  it('falls back to a default title when missing', () => {
    const result = normalizeExtractedBooking(flightBooking({ title: '' }), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    expect(result.title).toBe('Untitled booking');
  });

  it('is idempotent when re-run on its own output (client-edited bookings sent back to confirm)', () => {
    const once = normalizeExtractedBooking(flightBooking(), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    const twice = normalizeExtractedBooking(once, { artifactId: 'a2', model: 'm2', extractedAt: 'later' });

    expect(twice.startDatetime).toBe('2026-09-14T08:35:00');
    expect(twice.endDatetime).toBe('2026-09-14T11:50:00');
    expect(twice.detailsJson.destinationCity).toBe('Chengdu');
    expect(twice.detailsJson.originCity).toBe('Shanghai');
    expect(twice.detailsJson.importedFrom).toEqual({ artifactId: 'a2', model: 'm2', extractedAt: 'later' });
  });
});

describe('timezone validation', () => {
  it('passes through a valid IANA timezone', () => {
    const result = normalizeExtractedBooking(flightBooking({ originTz: 'Asia/Shanghai' }), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    expect(result.originTz).toBe('Asia/Shanghai');
  });

  it('normalizes an invalid timezone string to null', () => {
    const result = normalizeExtractedBooking(flightBooking({ originTz: 'Mars/Colony' }), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    expect(result.originTz).toBeNull();
  });

  it('leaves a missing timezone as null', () => {
    const result = normalizeExtractedBooking(flightBooking({ originTz: null }), { artifactId: 'a1', model: 'm', extractedAt: 'now' });
    expect(result.originTz).toBeNull();
  });
});

describe('createArtifactAndExtract — hash dedupe', () => {
  it('returns cached:true and skips a second Claude call for an identical re-post', async () => {
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([flightBooking()])));

    const first = await createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: flightEmailText }] });
    expect(first.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledOnce();

    const second = await createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: flightEmailText }] });
    expect(second.cached).toBe(true);
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(second.extraction.bookings[0].confirmationRef).toBe('ABC123');

    const third = await createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: flightEmailText }], force: true });
    expect(third.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe('createArtifactAndExtract — warnings', () => {
  it('flags a duplicate booking against an existing trip booking by confirmationRef+type', async () => {
    const { createBooking } = await import('../src/services/bookings.js');
    const trip = makeTrip();
    await createBooking(owner.id, trip.trip.id, {
      type: 'flight', title: 'Existing', confirmationRef: 'abc123',
    });

    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([flightBooking({ confirmationRef: 'ABC123' })])));
    const result = await createArtifactAndExtract(owner.id, { tripId: trip.trip.id, inputs: [{ kind: 'text', content: flightEmailText }] });

    const dup = result.warnings.find((w) => w.type === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup.bookingIndex).toBe(0);
  });

  it('flags bookings before trip start and after trip end', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([
      flightBooking({ startDatetime: '2026-09-01T08:00', confirmationRef: 'BEFORE' }),
      flightBooking({ startDatetime: '2026-09-25T08:00', confirmationRef: 'AFTER' }),
    ])));

    const result = await createArtifactAndExtract(owner.id, { tripId: trip.trip.id, inputs: [{ kind: 'text', content: flightEmailText }] });

    const before = result.warnings.find((w) => w.type === 'beforeTripStart');
    const after = result.warnings.find((w) => w.type === 'afterTripEnd');
    expect(before).toBeDefined();
    expect(before.bookingIndex).toBe(0);
    expect(before.suggestedStartDate).toBe('2026-09-01');
    expect(after).toBeDefined();
    expect(after.bookingIndex).toBe(1);
    expect(after.suggestedEndDate).toBe('2026-09-25');
  });

  it('flags notTravelRelated and empty together for a non-booking capture', async () => {
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([], { isTravelRelated: false, summary: 'A photo of a cat' })));

    const result = await createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: 'a cat photo' }] });

    expect(result.warnings).toEqual(expect.arrayContaining([{ type: 'notTravelRelated' }, { type: 'empty' }]));
  });

  it('flags a low-confidence booking', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([
      flightBooking({ confidence: { overall: 'low', fields: {} } }),
    ])));

    const result = await createArtifactAndExtract(owner.id, { tripId: trip.trip.id, inputs: [{ kind: 'text', content: flightEmailText }] });

    const low = result.warnings.find((w) => w.type === 'lowConfidence');
    expect(low).toBeDefined();
    expect(low.bookingIndex).toBe(0);
  });
});

describe('confirmArtifact', () => {
  it('creates bookings sequentially, stamps importedFrom server-side, and marks the artifact confirmed', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([
      flightBooking({ confirmationRef: 'LEG1' }),
      flightBooking({ confirmationRef: 'LEG2', title: 'MU5402' }),
    ])));

    const extracted = await createArtifactAndExtract(owner.id, { tripId: trip.trip.id, inputs: [{ kind: 'text', content: flightEmailText }] });

    // Realistic client round-trip: send back the actual extraction response shape
    // (detailsJson, already-normalized datetimes), with importedFrom tampered — server
    // must overwrite it regardless.
    const tamperedBookings = extracted.extraction.bookings.map((b) => ({
      ...b,
      detailsJson: { ...b.detailsJson, importedFrom: { artifactId: 'malicious', model: 'fake', extractedAt: 'fake' } },
    }));

    const result = await confirmArtifact(owner.id, extracted.artifact.id, { tripId: trip.trip.id, bookings: tamperedBookings });

    expect(result.bookings).toHaveLength(2);
    for (const booking of result.bookings) {
      expect(booking.detailsJson.importedFrom.artifactId).toBe(extracted.artifact.id);
      // Round-tripping through confirm must not drop the extracted fields or datetimes.
      expect(booking.startDatetime).toBe('2026-09-14T08:35:00');
      expect(booking.detailsJson.destinationCity).toBe('Chengdu');
    }

    const detail = getArtifactDetail(owner.id, extracted.artifact.id);
    expect(detail.artifact.status).toBe('confirmed');
    expect(detail.artifact.createdBookingIds).toHaveLength(2);
  });
});

describe('access control', () => {
  it('returns a 404-style error for a user with no relationship to the artifact', async () => {
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([flightBooking()])));
    const extracted = await createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: flightEmailText }] });

    const inviteCode = authService.getInviteCode();
    const stranger = authService.register('stranger', 'password123', 'Stranger', inviteCode).user;

    expect(() => getArtifactDetail(stranger.id, extracted.artifact.id)).toThrow();
    try {
      getArtifactDetail(stranger.id, extracted.artifact.id);
    } catch (err) {
      expect(err.status).toBe(404);
    }
  });

  it('allows a trip collaborator to access an artifact linked to that trip', async () => {
    const trip = makeTrip();
    const inviteCode = authService.getInviteCode();
    const collaborator = authService.register('collab', 'password123', 'Collaborator', inviteCode).user;
    inviteCollaborator(owner.id, trip.trip.id, 'collab');

    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([flightBooking()])));
    const extracted = await createArtifactAndExtract(owner.id, { tripId: trip.trip.id, inputs: [{ kind: 'text', content: flightEmailText }] });

    expect(() => getArtifactDetail(collaborator.id, extracted.artifact.id)).not.toThrow();
  });
});

describe('malformed Claude output', () => {
  it('marks the artifact failed when no fenced JSON block is returned', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }], usage: {} });

    await expect(createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: flightEmailText }] })).rejects.toThrow();

    const db = getDb();
    const row = db.prepare('SELECT status, error FROM import_artifacts').get();
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();
  });

  it('marks the artifact failed when the fenced block contains invalid JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '```json\n{not valid\n```' }], usage: {} });

    await expect(createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: flightEmailText }] })).rejects.toThrow();

    const db = getDb();
    const row = db.prepare('SELECT status, error FROM import_artifacts').get();
    expect(row.status).toBe('failed');
  });
});

describe('input validation', () => {
  it('rejects zero inputs', async () => {
    await expect(createArtifactAndExtract(owner.id, { tripId: null, inputs: [] })).rejects.toThrow();
  });

  it('rejects more than 4 inputs', async () => {
    const inputs = Array.from({ length: 5 }, () => ({ kind: 'text', content: 'hi' }));
    await expect(createArtifactAndExtract(owner.id, { tripId: null, inputs })).rejects.toThrow();
  });

  it('rejects text content over the 100KB cap', async () => {
    const huge = 'x'.repeat(101 * 1024);
    await expect(createArtifactAndExtract(owner.id, { tripId: null, inputs: [{ kind: 'text', content: huge }] })).rejects.toThrow();
  });

  it('rejects a mediaType that does not match the declared kind', async () => {
    await expect(createArtifactAndExtract(owner.id, {
      tripId: null,
      inputs: [{ kind: 'image', mediaType: 'application/pdf', content: trainTicketBase64 }],
    })).rejects.toThrow();
  });
});

describe('image input path', () => {
  it('sends a correctly-shaped image content block to Claude', async () => {
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([flightBooking()])));

    await createArtifactAndExtract(owner.id, {
      tripId: null,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const imageBlock = callArgs.messages[0].content.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.type).toBe('base64');
    expect(imageBlock.source.media_type).toBe('image/png');
  });
});

describe('reextractArtifact and listArtifactsForTrip and deleteArtifact', () => {
  it('re-extracts stored files and lists/deletes artifacts scoped to a trip', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse(extractionWithBookings([flightBooking()])));

    const extracted = await createArtifactAndExtract(owner.id, { tripId: trip.trip.id, inputs: [{ kind: 'text', content: flightEmailText }] });
    expect(mockCreate).toHaveBeenCalledOnce();

    const reextracted = await reextractArtifact(owner.id, extracted.artifact.id);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(reextracted.artifact.id).toBe(extracted.artifact.id);

    const list = listArtifactsForTrip(owner.id, trip.trip.id);
    expect(list.map((a) => a.id)).toContain(extracted.artifact.id);

    const deleted = deleteArtifact(owner.id, extracted.artifact.id);
    expect(deleted).toEqual({ ok: true });
    expect(() => getArtifactDetail(owner.id, extracted.artifact.id)).toThrow();
  });
});
