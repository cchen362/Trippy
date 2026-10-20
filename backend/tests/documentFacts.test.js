import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { config } from '../src/config.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking } from '../src/services/bookings.js';
import { writeAttachment } from '../src/services/attachments.js';
import * as claudeService from '../src/services/claude.js';
import { resolvePlace } from '../src/services/placeResolver.js';
import { selectPhoto } from '../src/services/unsplash.js';
import {
  __resetDocumentFactsForTests,
  documentReadsIdle,
  kickDocumentReads,
  listTripDocuments,
  listTripFacts,
  requeueUnreadDocuments,
  stopDocumentReads,
} from '../src/services/documentFacts.js';

// Plan 37 W1: the document-read job (D-37-1, D-37-3), run against the real module. The suite-wide stub
// (tests/setup/noDocumentFacts.js) makes the kick a no-op for every other unit file; this file tests the
// real one, so it opts back in. The model call is the one thing stubbed: readDocumentFacts.
vi.unmock('../src/services/documentFacts.js');

// A hotel booking with dates syncs a timeline stop, which resolves the place and picks a photo: stub both providers.
vi.mock('../src/services/placeResolver.js', () => ({ resolvePlace: vi.fn() }));
vi.mock('../src/services/unsplash.js', () => ({
  selectPhoto: vi.fn().mockResolvedValue(null),
  trackDownload: vi.fn(),
}));

const FIXTURES = join(import.meta.dirname, 'fixtures', 'documentText');
const HOTEL_PDF = readFileSync(join(FIXTURES, 'hotel-kanade-2p.pdf'));
const CHECKIN_PNG = readFileSync(join(FIXTURES, 'checkin-screenshot.png'));

const CHECKIN_QUOTE = 'Check-in is available from 15:00 to 23:00 on the day of arrival.';
const BREAKFAST_QUOTE = 'Breakfast is served from 07:00 to 10:00 and is included for 2 guests.';
const LEAK = 'SECRET-DOCUMENT-TEXT-9f3a';

let tmpDir;
let owner;
let tripId;
let readSpy;

function fact(over = {}) {
  return {
    kind: 'window', label: 'Check-in from', value: '15:00 to 23:00', quote: CHECKIN_QUOTE, page: '1',
    at: '', tz: '', tzSource: 'none', appliesFrom: '', appliesTo: '', confidence: 'high', ...over,
  };
}

function completeResult(facts) {
  return {
    outcome: 'complete', stopReason: 'end_turn', category: 'complete', error: null, detail: null,
    value: { documentSummary: 'Hotel confirmation', language: 'en', facts },
    usage: { inputTokens: 120, outputTokens: 60 }, totalMs: 17, model: claudeService.FACTS_MODEL,
  };
}

function failedResult(outcome, error = null) {
  return {
    outcome, stopReason: outcome === 'refused' ? 'refusal' : 'end_turn', category: outcome, error,
    detail: `the model said ${LEAK}`, value: null,
    usage: { inputTokens: 80, outputTokens: 5 }, totalMs: 9, model: claudeService.FACTS_MODEL,
  };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-document-facts-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  __resetDocumentFactsForTests();
  config.documentFactsEnabled = true;
  config.documentReadsDailyBudget = 300;
  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
  tripId = createTrip(owner.id, {
    title: 'Kyoto trip',
    destinations: ['Kyoto'],
    destinationCountries: ['JP'],
    startDate: '2026-11-14',
    endDate: '2026-11-17',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  }).trip.id;
  // restoreAllMocks in afterEach also resets these factory mocks, so each test sets them again.
  vi.mocked(resolvePlace).mockResolvedValue({
    lat: 35.0116, lng: 135.7681, resolvedName: 'Resolved Place', resolvedAddress: 'Some Address',
    coordinateSystem: 'wgs84', coordinateSource: 'nominatim', locationStatus: 'resolved',
    confidence: 0.9, providerId: 'osm:1', countryCode: 'JP',
  });
  vi.mocked(selectPhoto).mockResolvedValue(null);
  vi.spyOn(claudeService, 'generatePhotoDescriptor').mockResolvedValue(null);
  readSpy = vi.spyOn(claudeService, 'readDocumentFacts').mockResolvedValue(completeResult([fact()]));
});

afterEach(async () => {
  await documentReadsIdle();
  vi.restoreAllMocks();
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

const makeBooking = (detailsJson = {}, over = {}) => createBooking(owner.id, tripId, {
  type: 'hotel', title: 'Hotel Kanade', confirmationRef: 'KND-48213', detailsJson, ...over,
});

const attach = (bookingId, { mediaType = 'application/pdf', bytes = HOTEL_PDF, filename = 'hotel.pdf', source = 'manual' } = {}) =>
  writeAttachment(bookingId, { mediaType, filename, contentBuffer: bytes, source });

// files: [{ kind, mediaType, filename, bytes }] -> { artifactId, fileIds }
function makeArtifact(files) {
  const db = getDb();
  const { id: artifactId } = db.prepare("INSERT INTO import_artifacts (user_id, status) VALUES (?, 'extracted') RETURNING id").get(owner.id);
  const insert = db.prepare(`
    INSERT INTO import_artifact_files (artifact_id, position, kind, media_type, filename, size_bytes, content_hash, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);
  const fileIds = files.map((f, position) => insert.get(
    artifactId, position, f.kind, f.mediaType, f.filename ?? null, f.bytes.length,
    createHash('sha256').update(f.bytes).digest('hex'), f.bytes,
  ).id);
  return { artifactId, fileIds };
}

const imported = (artifactId, filePositions) => ({
  importedFrom: { artifactId, model: 'm', extractedAt: 'now', ...(filePositions ? { filePositions } : {}) },
});

const pdfFile = { kind: 'pdf', mediaType: 'application/pdf', filename: 'hotel.pdf', bytes: HOTEL_PDF };
const pngFile = { kind: 'image', mediaType: 'image/png', filename: 'shot.png', bytes: CHECKIN_PNG };
const textFile = (text) => ({ kind: 'text', mediaType: 'text/plain', filename: null, bytes: Buffer.from(text, 'utf8') });

const reads = () => getDb().prepare('SELECT * FROM document_fact_reads ORDER BY created_at, rowid').all();
const factRows = () => getDb().prepare('SELECT * FROM document_facts ORDER BY position').all();
const countRows = (table) => getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

describe('enumeration (D-38-3, D-37-8)', () => {
  it('gives each booking only the file it names', async () => {
    const { artifactId, fileIds } = makeArtifact([pdfFile, pngFile]);
    const a = await makeBooking(imported(artifactId, [0]), { title: 'A' });
    const b = await makeBooking(imported(artifactId, [1]), { title: 'B' });

    const docs = listTripDocuments(tripId);
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.artifactFileId === fileIds[0]).bookingIds).toEqual([a.id]);
    expect(docs.find((d) => d.artifactFileId === fileIds[1]).bookingIds).toEqual([b.id]);
  });

  it('lists a file that backs two bookings once, with both booking ids', async () => {
    const { artifactId, fileIds } = makeArtifact([pdfFile]);
    const out = await makeBooking(imported(artifactId, [0]), { title: 'Out' });
    const back = await makeBooking(imported(artifactId, [0]), { title: 'Back' });

    const docs = listTripDocuments(tripId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      key: `artifactFile:${fileIds[0]}`, sourceType: 'artifactFile', kind: 'pdf', mediaType: 'application/pdf',
      filename: 'hotel.pdf', url: `/api/import/artifacts/${artifactId}/files/0`,
    });
    expect(docs[0].bookingIds).toEqual([out.id, back.id]);
  });

  it('a booking imported before Plan 38 (no filePositions) owns every file, pasted text included', async () => {
    const { artifactId } = makeArtifact([pdfFile, pngFile, textFile('Pasted confirmation')]);
    await makeBooking(imported(artifactId));

    const docs = listTripDocuments(tripId);
    expect(docs.map((d) => d.kind)).toEqual(['pdf', 'image', 'text']);
    expect(docs.find((d) => d.kind === 'text').url).toBeNull();
  });

  it('lists manual and MCP attachments, one booking each', async () => {
    const booking = await makeBooking();
    const manual = attach(booking.id, { source: 'manual', filename: 'm.pdf' });
    const mcp = attach(booking.id, { mediaType: 'image/png', bytes: CHECKIN_PNG, filename: 'p.png', source: 'mcp' });

    const docs = listTripDocuments(tripId);
    expect(docs.map((d) => [d.key, d.kind, d.bookingIds])).toEqual([
      [`attachment:${manual.id}`, 'pdf', [booking.id]],
      [`attachment:${mcp.id}`, 'image', [booking.id]],
    ]);
    expect(docs[0].url).toBe(`/api/bookings/${booking.id}/attachments/${manual.id}`);
    expect(docs[0].contentHash).toBe(createHash('sha256').update(HOTEL_PDF).digest('hex'));
  });

  it('an empty positions list owns nothing', async () => {
    const { artifactId } = makeArtifact([pdfFile]);
    await makeBooking(imported(artifactId, []));
    expect(listTripDocuments(tripId)).toEqual([]);
  });
});

describe('the kick: single-flight, serial, deferred', () => {
  it('two kicks of one document make one model call', async () => {
    const booking = await makeBooking();
    const att = attach(booking.id);
    await documentReadsIdle();
    readSpy.mockClear();
    getDb().prepare('DELETE FROM document_fact_reads').run();

    kickDocumentReads([`attachment:${att.id}`]);
    kickDocumentReads([`attachment:${att.id}`]);
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(reads()).toHaveLength(1);
  });

  it('reads different documents one at a time', async () => {
    const booking = await makeBooking();
    let active = 0;
    let maxActive = 0;
    readSpy.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return completeResult([fact()]);
    });

    attach(booking.id, { bytes: Buffer.from('%PDF-one') });
    attach(booking.id, { bytes: Buffer.from('%PDF-two') });
    attach(booking.id, { bytes: Buffer.from('%PDF-three') });
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it('a kick made inside a transaction that rolls back reads nothing', async () => {
    const booking = await makeBooking();
    const db = getDb();
    expect(() => db.transaction(() => {
      attach(booking.id);
      throw new Error('rollback');
    })()).toThrow('rollback');
    await documentReadsIdle();

    expect(readSpy).not.toHaveBeenCalled();
    expect(reads()).toEqual([]);
  });

  it('a document deleted before its turn comes leaves no row and no call', async () => {
    const booking = await makeBooking();
    const att = attach(booking.id);
    getDb().prepare('DELETE FROM booking_attachments WHERE id = ?').run(att.id);
    await documentReadsIdle();

    expect(readSpy).not.toHaveBeenCalled();
    expect(reads()).toEqual([]);
  });

  it('a document deleted while the model reads it leaves no row and no error', async () => {
    const booking = await makeBooking();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let started;
    const startedSignal = new Promise((resolve) => { started = resolve; });
    readSpy.mockImplementation(async () => {
      started();
      await gate;
      return completeResult([fact()]);
    });
    const att = attach(booking.id);
    await startedSignal;

    getDb().prepare('DELETE FROM booking_attachments WHERE id = ?').run(att.id);
    release();
    await documentReadsIdle();

    expect(reads()).toEqual([]);
    expect(factRows()).toEqual([]);
  });

  it('a document no booking owns is not read', async () => {
    const { fileIds } = makeArtifact([pdfFile]);
    kickDocumentReads([`artifactFile:${fileIds[0]}`]);
    await documentReadsIdle();
    expect(readSpy).not.toHaveBeenCalled();
    expect(reads()).toEqual([]);
  });
});

describe('the daily cap (D-37-3)', () => {
  it('stops the model calls at the budget and records a skipped read', async () => {
    config.documentReadsDailyBudget = 1;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const booking = await makeBooking();
    attach(booking.id, { bytes: Buffer.from('%PDF-one') });
    attach(booking.id, { bytes: Buffer.from('%PDF-two') });
    attach(booking.id, { bytes: Buffer.from('%PDF-three') });
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(reads().map((r) => [r.status, r.error])).toEqual([
      ['complete', null], ['skipped', 'daily_cap'], ['skipped', 'daily_cap'],
    ]);
    expect(reads()[1]).toMatchObject({ fact_count: 0, input_tokens: null, total_ms: null });
    expect(warn.mock.calls.filter(([m]) => String(m).includes('daily cap reached'))).toHaveLength(1);
  });

  it('a skipped read is picked up by the next boot pass', async () => {
    config.documentReadsDailyBudget = 0;
    const booking = await makeBooking();
    attach(booking.id);
    await documentReadsIdle();
    expect(readSpy).not.toHaveBeenCalled();

    config.documentReadsDailyBudget = 300;
    expect(requeueUnreadDocuments()).toBe(1);
    await documentReadsIdle();
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe('persistence (D-37-2)', () => {
  it('stores the read and its facts, with verification and the page the text layer found', async () => {
    readSpy.mockResolvedValue(completeResult([
      // Printed on page 2; the model said page 1, so verified_page differs from page.
      fact({ kind: 'allowance', label: 'Breakfast', value: 'included for 2 guests', quote: BREAKFAST_QUOTE, page: '1', at: '2026-11-15T07:00', tz: 'Asia/Tokyo', tzSource: 'document', appliesFrom: '2026-11-14', appliesTo: '2026-11-17' }),
      // Not in the document at all: stored, unverified.
      fact({ kind: 'deadline', label: 'Pay by', value: 'invented', quote: 'Pay in full by 1 January 2030.', page: '' }),
    ]));
    const booking = await makeBooking();
    const att = attach(booking.id);
    await documentReadsIdle();

    const [read] = reads();
    expect(read).toMatchObject({
      trip_id: tripId, booking_id: booking.id, attachment_id: att.id, artifact_file_id: null,
      content_hash: createHash('sha256').update(HOTEL_PDF).digest('hex'),
      model: claudeService.FACTS_MODEL, prompt_version: claudeService.FACTS_PROMPT_VERSION,
      status: 'complete', fact_count: 2, verified_count: 1, input_tokens: 120, output_tokens: 60,
      total_ms: 17, stop_reason: 'end_turn', error: null,
    });

    const [breakfast, pay] = factRows();
    expect(breakfast).toMatchObject({
      read_id: read.id, trip_id: tripId, booking_id: booking.id, attachment_id: att.id, artifact_file_id: null,
      kind: 'allowance', quote: BREAKFAST_QUOTE, page: 1, verified_page: 2, quote_verified: 1,
      value_at: '2026-11-15T07:00', value_tz: 'Asia/Tokyo', tz_source: 'document',
      applies_from: '2026-11-14', applies_to: '2026-11-17', confidence: 'high', position: 0,
    });
    expect(pay).toMatchObject({ page: null, verified_page: null, quote_verified: 0, value_at: null, value_tz: null, applies_from: null, applies_to: null, position: 1 });
  });

  it('an image has no text layer, so its facts are stored unverified', async () => {
    const booking = await makeBooking();
    attach(booking.id, { mediaType: 'image/png', bytes: CHECKIN_PNG, filename: 'shot.png' });
    await documentReadsIdle();

    expect(reads()[0]).toMatchObject({ status: 'complete', fact_count: 1, verified_count: 0 });
    expect(factRows()[0]).toMatchObject({ quote_verified: 0, verified_page: null, page: 1 });
  });

  it('a pasted confirmation is read and its quote verifies (D-37-8)', async () => {
    const { artifactId, fileIds } = makeArtifact([textFile(`Dear guest,\n${CHECKIN_QUOTE}\nSee you soon.`)]);
    const booking = await makeBooking(imported(artifactId, [0]));
    kickDocumentReads([`artifactFile:${fileIds[0]}`]);
    await documentReadsIdle();

    expect(readSpy.mock.calls[0][0].document).toMatchObject({ kind: 'text', mediaType: 'text/plain' });
    expect(readSpy.mock.calls[0][0].document.content).toContain(CHECKIN_QUOTE);
    expect(reads()[0]).toMatchObject({ artifact_file_id: fileIds[0], attachment_id: null, booking_id: null, verified_count: 1 });
    expect(factRows()[0]).toMatchObject({ quote_verified: 1, verified_page: 1, booking_id: null });
    expect(listTripFacts(tripId).bookings.map((b) => b.bookingId)).toEqual([booking.id]);
  });

  it('sends the document and the booking context the model needs', async () => {
    const booking = await makeBooking({}, {
      type: 'hotel', title: 'Hotel Kanade', startDatetime: '2026-11-14T15:00:00', endDatetime: '2026-11-17T11:00:00',
      originTz: null, destinationTz: 'Asia/Tokyo',
    });
    attach(booking.id);
    await documentReadsIdle();

    const request = readSpy.mock.calls[0][0];
    expect(request.document).toEqual({ kind: 'pdf', mediaType: 'application/pdf', content: HOTEL_PDF.toString('base64') });
    expect(request.context).toEqual({
      bookings: [{
        type: 'hotel', title: 'Hotel Kanade', startDatetime: '2026-11-14T15:00:00', endDatetime: '2026-11-17T11:00:00',
        originTz: null, destinationTz: 'Asia/Tokyo',
      }],
      trip: { startDate: '2026-11-14', endDate: '2026-11-17' },
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('a file backing two bookings sends both in the context, and its facts show under both', async () => {
    const { artifactId, fileIds } = makeArtifact([pdfFile]);
    const out = await makeBooking(imported(artifactId, [0]), { type: 'flight', title: 'Outbound' });
    const back = await makeBooking(imported(artifactId, [0]), { type: 'flight', title: 'Return' });
    kickDocumentReads([`artifactFile:${fileIds[0]}`]);
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0][0].context.bookings.map((b) => b.title)).toEqual(['Outbound', 'Return']);
    const { bookings } = listTripFacts(tripId);
    expect(bookings.map((b) => b.bookingId)).toEqual([out.id, back.id]);
    expect(bookings[0].facts[0].id).toBe(bookings[1].facts[0].id);
  });

  it.each([
    ['refused', null],
    ['truncated', null],
    ['invalid', 'schema_mismatch'],
    ['error', 'api_529'],
  ])('a %s read is recorded with its status and a short code, and nothing the model said', async (outcome, code) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readSpy.mockResolvedValue(failedResult(outcome, code));
    const booking = await makeBooking();
    attach(booking.id);
    await documentReadsIdle();

    const [read] = reads();
    expect(read).toMatchObject({ status: outcome, error: code, fact_count: 0, verified_count: 0, input_tokens: 80, output_tokens: 5, total_ms: 9 });
    expect(factRows()).toEqual([]);
    const everything = JSON.stringify({
      reads: getDb().prepare('SELECT * FROM document_fact_reads').all(),
      facts: getDb().prepare('SELECT * FROM document_facts').all(),
      log: log.mock.calls,
      warn: warn.mock.calls,
    });
    expect(everything).not.toContain(LEAK);
    expect(log.mock.calls.some(([m]) => String(m).startsWith('[facts] read key='))).toBe(true);
  });

  it('the read log line carries counts only, never a quote or a label', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const booking = await makeBooking();
    attach(booking.id);
    await documentReadsIdle();

    const line = log.mock.calls.find(([m]) => String(m).startsWith('[facts] read key='));
    expect(line).toBeTruthy();
    expect(JSON.stringify(line)).not.toContain('Check-in');
    expect(JSON.stringify(line)).not.toContain('15:00');
  });

  it('an unreadable PDF still reads, with its facts unverified, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const booking = await makeBooking();
    attach(booking.id, { bytes: Buffer.from('this is not a pdf') });
    await documentReadsIdle();

    expect(reads()[0]).toMatchObject({ status: 'complete', fact_count: 1, verified_count: 0 });
    expect(warn.mock.calls.some(([m]) => String(m).includes('text layer unreadable'))).toBe(true);
  });

  it('a provider call that throws is logged and the queue carries on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    readSpy.mockRejectedValueOnce(new Error('request could not be built'));
    const booking = await makeBooking();
    attach(booking.id, { bytes: Buffer.from('%PDF-one') });
    attach(booking.id, { bytes: Buffer.from('%PDF-two') });
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(reads().map((r) => r.status)).toEqual(['complete']);
  });
});

describe('the read key (D-37-1)', () => {
  it('a document with a complete read under the current key is not read again', async () => {
    const booking = await makeBooking();
    const att = attach(booking.id);
    await documentReadsIdle();
    expect(readSpy).toHaveBeenCalledTimes(1);

    kickDocumentReads([`attachment:${att.id}`]);
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(reads()).toHaveLength(1);
  });

  it('a document last read under another prompt version is read again, and keeps showing its old facts meanwhile', async () => {
    const booking = await makeBooking();
    const att = attach(booking.id);
    await documentReadsIdle();
    getDb().prepare("UPDATE document_fact_reads SET prompt_version = '36.9'").run();
    readSpy.mockClear();

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let started;
    const startedSignal = new Promise((resolve) => { started = resolve; });
    readSpy.mockImplementation(async () => {
      started();
      await gate;
      return completeResult([fact({ label: 'New label' })]);
    });
    kickDocumentReads([`attachment:${att.id}`]);
    await startedSignal;

    const during = listTripFacts(tripId);
    expect(during.readsPending).toBe(1);
    expect(during.bookings[0].facts[0].label).toBe('Check-in from');

    release();
    await documentReadsIdle();
    const after = listTripFacts(tripId);
    expect(after.readsPending).toBe(0);
    expect(after.bookings[0].facts.map((f) => f.label)).toEqual(['New label']);
    expect(reads().map((r) => r.prompt_version)).toEqual(['36.9', claudeService.FACTS_PROMPT_VERSION]);
  });

  it('a document whose content changed under the same key slot is read again', async () => {
    const booking = await makeBooking();
    const att = attach(booking.id);
    await documentReadsIdle();
    getDb().prepare('UPDATE document_fact_reads SET content_hash = ?').run('different-hash');
    readSpy.mockClear();

    kickDocumentReads([`attachment:${att.id}`]);
    await documentReadsIdle();
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe('listTripFacts', () => {
  it('returns each booking its facts in order, with the document, verified flag and preferred page', async () => {
    readSpy.mockResolvedValue(completeResult([
      fact({ kind: 'allowance', label: 'Breakfast', value: 'included for 2 guests', quote: BREAKFAST_QUOTE, page: '1' }),
      fact({ kind: 'deadline', label: 'Pay by', value: 'x', quote: 'No such line anywhere.', page: '2', at: '2026-11-12', tz: 'Asia/Tokyo', tzSource: 'booking' }),
    ]));
    const booking = await makeBooking();
    const att = attach(booking.id, { filename: 'hotel.pdf' });
    await makeBooking({}, { title: 'No documents' });
    await documentReadsIdle();

    const result = listTripFacts(tripId);
    expect(result.readsPending).toBe(0);
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0].bookingId).toBe(booking.id);
    const [breakfast, pay] = result.bookings[0].facts;
    expect(breakfast).toMatchObject({
      kind: 'allowance', label: 'Breakfast', quote: BREAKFAST_QUOTE, page: 2, modelPage: 1, quoteVerified: true,
      at: null, tz: null, tzSource: 'none', appliesFrom: null, appliesTo: null, confidence: 'high',
      document: {
        key: `attachment:${att.id}`, kind: 'pdf', mediaType: 'application/pdf', filename: 'hotel.pdf',
        url: `/api/bookings/${booking.id}/attachments/${att.id}`,
      },
    });
    expect(breakfast.id).toMatch(/^[0-9a-f]{32}$/);
    expect(pay).toMatchObject({ page: 2, modelPage: 2, quoteVerified: false, at: '2026-11-12', tz: 'Asia/Tokyo', tzSource: 'booking' });
  });

  it('is empty for a trip with no reads', async () => {
    expect(listTripFacts(tripId)).toEqual({ bookings: [], readsPending: 0 });
  });

  it('shows nothing from a document whose read did not complete', async () => {
    readSpy.mockResolvedValue(failedResult('invalid', 'schema_mismatch'));
    const booking = await makeBooking();
    attach(booking.id);
    await documentReadsIdle();
    expect(listTripFacts(tripId).bookings).toEqual([]);
  });
});

describe('cascades', () => {
  it('deleting an attachment or its booking removes its facts', async () => {
    const booking = await makeBooking();
    const att = attach(booking.id);
    await documentReadsIdle();
    expect(countRows('document_facts')).toBe(1);

    getDb().prepare('DELETE FROM booking_attachments WHERE id = ?').run(att.id);
    expect(countRows('document_facts')).toBe(0);
    expect(countRows('document_fact_reads')).toBe(0);

    attach(booking.id, { bytes: Buffer.from('%PDF-again') });
    await documentReadsIdle();
    expect(countRows('document_facts')).toBe(1);
    getDb().prepare('DELETE FROM bookings WHERE id = ?').run(booking.id);
    expect(countRows('document_facts')).toBe(0);
    expect(countRows('document_fact_reads')).toBe(0);
  });

  it('deleting an import artifact removes its facts', async () => {
    const { artifactId, fileIds } = makeArtifact([pdfFile]);
    await makeBooking(imported(artifactId, [0]));
    kickDocumentReads([`artifactFile:${fileIds[0]}`]);
    await documentReadsIdle();
    expect(countRows('document_facts')).toBe(1);

    getDb().prepare('DELETE FROM import_artifacts WHERE id = ?').run(artifactId);
    expect(countRows('document_facts')).toBe(0);
    expect(countRows('document_fact_reads')).toBe(0);
  });
});

describe('the boot pass (D-37-3)', () => {
  it('queues documents that were never read or whose last read failed, not those already complete', async () => {
    const booking = await makeBooking();
    const unread = attach(booking.id, { bytes: Buffer.from('%PDF-unread') });
    const failed = attach(booking.id, { bytes: Buffer.from('%PDF-failed') });
    const done = attach(booking.id, { bytes: Buffer.from('%PDF-done') });
    await documentReadsIdle();
    // Rewind history: one never read, one read and failed, one complete under the current key.
    const db = getDb();
    db.prepare('DELETE FROM document_fact_reads WHERE attachment_id = ?').run(unread.id);
    db.prepare("UPDATE document_fact_reads SET status = 'error', error = 'api_529', fact_count = 0 WHERE attachment_id = ?").run(failed.id);
    db.prepare('DELETE FROM document_facts WHERE attachment_id = ?').run(failed.id);
    readSpy.mockClear();

    expect(requeueUnreadDocuments()).toBe(2);
    await documentReadsIdle();

    expect(readSpy).toHaveBeenCalledTimes(2);
    const reread = db.prepare("SELECT attachment_id FROM document_fact_reads WHERE status = 'complete' ORDER BY rowid").all().map((r) => r.attachment_id);
    expect(reread).toEqual(expect.arrayContaining([unread.id, failed.id, done.id]));
    expect(reread).toHaveLength(3);
  });

  it('covers every trip, import files included', async () => {
    const { artifactId } = makeArtifact([pdfFile, textFile('Pasted')]);
    await makeBooking(imported(artifactId));
    const otherTrip = createTrip(owner.id, {
      title: 'Other', destinations: ['Osaka'], destinationCountries: ['JP'], startDate: '2026-12-01', endDate: '2026-12-03',
      travellers: 'solo', interestTags: [], pace: 'moderate',
    }).trip.id;
    const other = await createBooking(owner.id, otherTrip, { type: 'hotel', title: 'Other hotel' });
    attach(other.id);
    await documentReadsIdle();
    readSpy.mockClear();
    getDb().prepare('DELETE FROM document_fact_reads').run();

    expect(requeueUnreadDocuments()).toBe(3);
    await documentReadsIdle();
    expect(readSpy).toHaveBeenCalledTimes(3);
  });
});

describe('the switch (D-37-12)', () => {
  it('with the flag off, nothing kicks, the boot pass is a no-op and no model call is made', async () => {
    config.documentFactsEnabled = false;
    const booking = await makeBooking();
    const att = attach(booking.id);
    kickDocumentReads([`attachment:${att.id}`]);
    await documentReadsIdle();

    expect(requeueUnreadDocuments()).toBe(0);
    await documentReadsIdle();
    expect(readSpy).not.toHaveBeenCalled();
    expect(reads()).toEqual([]);
  });
});

describe('shutdown (F-37-19)', () => {
  it('stopping aborts the read in flight, writes nothing, resolves, and refuses new kicks', async () => {
    let started;
    const startedSignal = new Promise((resolve) => { started = resolve; });
    readSpy.mockImplementation(({ signal }) => new Promise((resolve) => {
      started();
      signal.addEventListener('abort', () => resolve({
        outcome: 'error', stopReason: null, category: null, error: 'aborted', detail: 'aborted', value: null, usage: null, totalMs: 1, model: claudeService.FACTS_MODEL,
      }));
    }));
    const booking = await makeBooking();
    const first = attach(booking.id, { bytes: Buffer.from('%PDF-one') });
    attach(booking.id, { bytes: Buffer.from('%PDF-two') });
    await startedSignal;

    await stopDocumentReads();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(reads()).toEqual([]);
    kickDocumentReads([`attachment:${first.id}`]);
    await documentReadsIdle();
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('stopping with nothing running resolves at once', async () => {
    await expect(stopDocumentReads()).resolves.toBeUndefined();
  });
});
