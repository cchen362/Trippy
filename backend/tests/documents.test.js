import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { addAttachment } from '../src/services/attachments.js';
import { importFileRowsOf, importFilesOf, resolveBookingDocuments } from '../src/services/documents.js';

let tmpDir;
let owner;
let bookingId;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-documents-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
  const trip = createTrip(owner.id, {
    title: 'Sichuan Trip',
    destinations: ['Chengdu'],
    destinationCountries: ['CN'],
    startDate: '2026-09-10',
    endDate: '2026-09-20',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
  bookingId = (await createBooking(owner.id, trip.trip.id, { type: 'hotel', title: 'Hand-entered hotel', confirmationRef: 'H1' })).id;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

// Position 0 image, 1 pdf, 2 pasted text, 3 image.
function makeArtifact() {
  const db = getDb();
  const { id } = db.prepare("INSERT INTO import_artifacts (user_id, status) VALUES (?, 'extracted') RETURNING id").get(owner.id);
  const files = [
    ['image', 'image/png', 'a.png'],
    ['pdf', 'application/pdf', 'b.pdf'],
    ['text', 'text/plain', null],
    ['image', 'image/jpeg', 'd.jpg'],
  ];
  const insert = db.prepare(`
    INSERT INTO import_artifact_files (artifact_id, position, kind, media_type, filename, size_bytes, content_hash, content)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  files.forEach(([kind, mediaType, filename], position) => {
    insert.run(id, position, kind, mediaType, filename, `hash-${id}-${position}`, Buffer.from('x'));
  });
  return id;
}

const imported = (artifactId, filePositions) => ({
  importedFrom: { artifactId, model: 'm', extractedAt: 'now', ...(filePositions ? { filePositions } : {}) },
});
const importDocs = (docs) => docs.filter((d) => d.source === 'import');

describe('importFilesOf (D-38-3)', () => {
  it('returns the artifact and the positions, or null positions for a legacy booking', () => {
    expect(importFilesOf(imported('a1', [0, 2]))).toEqual({ artifactId: 'a1', positions: [0, 2] });
    expect(importFilesOf(imported('a1'))).toEqual({ artifactId: 'a1', positions: null });
    expect(importFilesOf(imported('a1', []))).toEqual({ artifactId: 'a1', positions: [] });
  });

  it('returns null when the booking was not imported', () => {
    expect(importFilesOf(undefined)).toBeNull();
    expect(importFilesOf({})).toBeNull();
    expect(importFilesOf({ importedFrom: {} })).toBeNull();
  });
});

describe('resolveBookingDocuments — import documents (D-38-3, D-38-5)', () => {
  it('lists only the files the booking names', () => {
    const artifactId = makeArtifact();
    const docs = importDocs(resolveBookingDocuments(bookingId, imported(artifactId, [3])));
    const fileId = getDb().prepare('SELECT id FROM import_artifact_files WHERE artifact_id = ? AND position = 3').get(artifactId).id;
    expect(docs).toEqual([{
      key: `artifactFile:${fileId}`,
      source: 'import',
      url: `/api/import/artifacts/${artifactId}/files/3`,
      mediaType: 'image/jpeg',
      filename: 'd.jpg',
    }]);
  });

  it('lists named files in position order', () => {
    const artifactId = makeArtifact();
    const docs = importDocs(resolveBookingDocuments(bookingId, imported(artifactId, [3, 0])));
    expect(docs.map((d) => d.filename)).toEqual(['a.png', 'd.jpg']);
  });

  it('a legacy booking (no positions) lists every image and pdf, and no pasted text', () => {
    const artifactId = makeArtifact();
    const docs = importDocs(resolveBookingDocuments(bookingId, imported(artifactId)));
    expect(docs.map((d) => d.filename)).toEqual(['a.png', 'b.pdf', 'd.jpg']);
  });

  it('a pasted-text position yields no import document', () => {
    const artifactId = makeArtifact();
    expect(importDocs(resolveBookingDocuments(bookingId, imported(artifactId, [2])))).toEqual([]);
    expect(importDocs(resolveBookingDocuments(bookingId, imported(artifactId, [1, 2]))).map((d) => d.filename)).toEqual(['b.pdf']);
  });

  it('an empty positions array yields no import documents', () => {
    const artifactId = makeArtifact();
    expect(importDocs(resolveBookingDocuments(bookingId, imported(artifactId, [])))).toEqual([]);
  });

  it('a position the artifact does not hold yields nothing', () => {
    const artifactId = makeArtifact();
    expect(importDocs(resolveBookingDocuments(bookingId, imported(artifactId, [9])))).toEqual([]);
  });

  it('one pdf shared by two bookings shows under both', () => {
    const artifactId = makeArtifact();
    const flight = importDocs(resolveBookingDocuments('b-flight', imported(artifactId, [1])));
    const hotel = importDocs(resolveBookingDocuments('b-hotel', imported(artifactId, [1, 0])));
    expect(flight.map((d) => d.filename)).toEqual(['b.pdf']);
    expect(hotel.map((d) => d.filename)).toEqual(['a.png', 'b.pdf']);
  });

  it('does not read another artifact\'s files', () => {
    const mine = makeArtifact();
    makeArtifact();
    const docs = importDocs(resolveBookingDocuments(bookingId, imported(mine, [0])));
    expect(docs).toHaveLength(1);
    expect(docs[0].url).toContain(`/artifacts/${mine}/`);
  });
});

describe('importFileRowsOf (D-38-3, D-37-8)', () => {
  it('returns every file of every kind for a legacy booking, pasted text included', () => {
    const artifactId = makeArtifact();
    const rows = importFileRowsOf(imported(artifactId));
    expect(rows.map((r) => [r.position, r.kind])).toEqual([[0, 'image'], [1, 'pdf'], [2, 'text'], [3, 'image']]);
    expect(rows[0]).toMatchObject({ artifact_id: artifactId, media_type: 'image/png', filename: 'a.png' });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].content_hash).toBe(`hash-${artifactId}-0`);
  });

  it('honours positions, an empty list, kinds and a booking that was not imported', () => {
    const artifactId = makeArtifact();
    expect(importFileRowsOf(imported(artifactId, [2, 1])).map((r) => r.position)).toEqual([1, 2]);
    expect(importFileRowsOf(imported(artifactId, []))).toEqual([]);
    expect(importFileRowsOf(imported(artifactId), { kinds: ['pdf'] }).map((r) => r.position)).toEqual([1]);
    expect(importFileRowsOf(imported(artifactId), { kinds: [] })).toEqual([]);
    expect(importFileRowsOf({})).toEqual([]);
  });
});

describe('resolveBookingDocuments — manual attachments', () => {
  it('are listed after the import documents and are unaffected by positions', async () => {
    const artifactId = makeArtifact();
    await addAttachment(owner.id, bookingId, {
      mediaType: 'image/png', filename: 'manual.png', content: Buffer.from('fake-image-bytes').toString('base64'),
    });

    for (const positions of [undefined, [], [1]]) {
      const docs = resolveBookingDocuments(bookingId, imported(artifactId, positions));
      const manual = docs.filter((d) => d.source === 'attachment');
      expect(manual.map((d) => d.filename)).toEqual(['manual.png']);
      expect(manual[0].key).toMatch(/^attachment:[0-9a-f]{32}$/);
      expect(docs.at(-1).source).toBe('attachment');
    }
  });

  it('a booking that was not imported lists only its attachments', async () => {
    await addAttachment(owner.id, bookingId, {
      mediaType: 'image/png', filename: 'manual.png', content: Buffer.from('fake-image-bytes').toString('base64'),
    });
    expect(resolveBookingDocuments(bookingId, {}).map((d) => d.source)).toEqual(['attachment']);
  });
});
