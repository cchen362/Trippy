import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));
vi.mock('../src/config.js', () => ({
  config: { anthropicApiKey: 'test-key' },
}));

const { initDb, getDb } = await import('../src/db/database.js');
const { runMigrations } = await import('../src/db/migrations.js');
const authService = await import('../src/services/auth.js');
const { createTrip } = await import('../src/services/trips.js');
const { createBooking, listBookings } = await import('../src/services/bookings.js');
const { addAttachment } = await import('../src/services/attachments.js');
const { createArtifactAndExtract, deleteArtifact } = await import('../src/services/importer.js');

const trainTicketBase64 = readFileSync(join(__dirname, 'fixtures/train-ticket.png')).toString('base64');

function claudeResponse(json) {
  return {
    content: [{ type: 'text', text: '```json\n' + JSON.stringify(json) + '\n```' }],
    usage: { input_tokens: 100, output_tokens: 50 },
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
    details: {},
    confidence: { overall: 'high', fields: {} },
    assumptions: [],
    ...overrides,
  };
}

let tmpDir;
let owner;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-bookings-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
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

describe('booking documents resolution', () => {
  it('returns attachment-sourced documents for a hand-entered booking', async () => {
    const trip = makeTrip();
    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'hotel', title: 'Hand-entered hotel', confirmationRef: 'H1',
    });
    addAttachment(owner.id, booking.id, { mediaType: 'image/png', filename: 'a.png', content: Buffer.from('a').toString('base64') });
    addAttachment(owner.id, booking.id, { mediaType: 'application/pdf', filename: 'b.pdf', content: Buffer.from('b').toString('base64') });

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(2);
    expect(found.documents.every((d) => d.source === 'attachment')).toBe(true);
  });

  it('returns import-sourced documents for an artifact-linked booking', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse({
      isTravelRelated: true, summary: 'test', language: 'en', bookings: [flightBooking()],
    }));
    const extracted = await createArtifactAndExtract(owner.id, {
      tripId: trip.trip.id,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'flight',
      title: 'MU5401',
      detailsJson: { importedFrom: { artifactId: extracted.artifact.id, model: 'm', extractedAt: 'now' } },
    });

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(1);
    expect(found.documents[0].source).toBe('import');
    expect(found.documents[0].url).toBe(`/api/import/artifacts/${extracted.artifact.id}/files/0`);
  });

  it('combines import and attachment documents, import entries first', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse({
      isTravelRelated: true, summary: 'test', language: 'en', bookings: [flightBooking()],
    }));
    const extracted = await createArtifactAndExtract(owner.id, {
      tripId: trip.trip.id,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'flight',
      title: 'MU5401',
      detailsJson: { importedFrom: { artifactId: extracted.artifact.id, model: 'm', extractedAt: 'now' } },
    });
    addAttachment(owner.id, booking.id, { mediaType: 'image/png', filename: 'extra.png', content: Buffer.from('c').toString('base64') });

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(2);
    expect(found.documents[0].source).toBe('import');
    expect(found.documents[1].source).toBe('attachment');
  });

  it('gracefully drops import documents once the source artifact is deleted', async () => {
    const trip = makeTrip();
    mockCreate.mockResolvedValue(claudeResponse({
      isTravelRelated: true, summary: 'test', language: 'en', bookings: [flightBooking()],
    }));
    const extracted = await createArtifactAndExtract(owner.id, {
      tripId: trip.trip.id,
      inputs: [{ kind: 'image', mediaType: 'image/png', content: trainTicketBase64 }],
    });

    const booking = await createBooking(owner.id, trip.trip.id, {
      type: 'flight',
      title: 'MU5401',
      detailsJson: { importedFrom: { artifactId: extracted.artifact.id, model: 'm', extractedAt: 'now' } },
    });

    deleteArtifact(owner.id, extracted.artifact.id);

    const bookings = listBookings(owner.id, trip.trip.id);
    const found = bookings.find((b) => b.id === booking.id);
    expect(found.documents).toHaveLength(0);
  });
});
