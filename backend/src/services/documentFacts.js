// Document facts (Plan 37): the conditions a booking's documents state, read once in the background.
//
// D-37-1 (Plan 37): a fact belongs to a document, and a document is read once per contract — the read key is content_hash + FACTS_MODEL + FACTS_PROMPT_VERSION, every attempt writes a document_fact_reads row, and a document is re-read only when that key changes or a previous attempt did not complete. A booking shows the facts of the documents it owns, resolved through importFileRowsOf (D-38-3), so one PDF backing two flights shows its baggage line under both.
//
// This module must not touch a claude.js export at load: eleven test files mock claude.js with a factory that
// defines only a few names, so FACTS_MODEL, FACTS_PROMPT_VERSION and readDocumentFacts are read inside functions.
// It queries the database directly and imports neither trips.js nor attachments.js (both import this module).

import { createHash } from 'crypto';
import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { FACTS_MODEL, FACTS_PROMPT_VERSION, readDocumentFacts } from './claude.js';
import { documentTextPages, findQuote, hasTextLayer } from './documentText.js';
import { artifactFileKey, attachmentKey, importFileRowsOf } from './documents.js';
import { bookingZone, isKnownZone } from './factZone.js';

const ARTIFACT_PREFIX = 'artifactFile:';
const ATTACHMENT_PREFIX = 'attachment:';

// ---------------------------------------------------------------------------
// Enumeration: every document of a trip
// ---------------------------------------------------------------------------

// An attachment's kind from its media type (attachments.js's attachmentKindFor, which this module cannot import).
const attachmentKind = (mediaType) => (mediaType === 'application/pdf' ? 'pdf' : 'image');

const parseDetails = (json) => JSON.parse(json || '{}');

// Every document of a trip's bookings: import files of all kinds through importFileRowsOf (one file
// backing two bookings is one document with two bookingIds), plus every attachment (one booking each).
export function listTripDocuments(tripId) {
  const db = getDb();
  const bookings = db.prepare('SELECT id, details_json FROM bookings WHERE trip_id = ? ORDER BY created_at, rowid').all(tripId);

  const documents = new Map();
  for (const booking of bookings) {
    for (const f of importFileRowsOf(parseDetails(booking.details_json))) {
      const key = artifactFileKey(f.id);
      const existing = documents.get(key);
      if (existing) {
        existing.bookingIds.push(booking.id);
        continue;
      }
      documents.set(key, {
        key,
        sourceType: 'artifactFile',
        artifactFileId: f.id,
        attachmentId: null,
        kind: f.kind,
        mediaType: f.media_type,
        filename: f.filename,
        contentHash: f.content_hash,
        bookingIds: [booking.id],
        url: f.kind === 'text' ? null : `/api/import/artifacts/${f.artifact_id}/files/${f.position}`,
      });
    }
  }

  const attachments = db.prepare(`
    SELECT a.id, a.booking_id, a.media_type, a.filename, a.content_hash
    FROM booking_attachments a
    JOIN bookings b ON b.id = a.booking_id
    WHERE b.trip_id = ?
    ORDER BY a.created_at, a.rowid
  `).all(tripId);
  for (const a of attachments) {
    const key = attachmentKey(a.id);
    documents.set(key, {
      key,
      sourceType: 'attachment',
      artifactFileId: null,
      attachmentId: a.id,
      kind: attachmentKind(a.media_type),
      mediaType: a.media_type,
      filename: a.filename,
      contentHash: a.content_hash,
      bookingIds: [a.booking_id],
      url: `/api/bookings/${a.booking_id}/attachments/${a.id}`,
    });
  }

  return [...documents.values()];
}

// ---------------------------------------------------------------------------
// The job: one registry, one FIFO, one read at a time
// ---------------------------------------------------------------------------

// key -> 'queued' | 'running'. Registered synchronously in kickDocumentReads (no await between the
// check and the set), the D-33-1 pattern, so two kicks of one document never read it twice.
const registry = new Map();
const queue = [];
let current = null; // { key, controller } while a read is in flight
let drainPromise = null;
let stopping = false;
let idleWaiters = [];
// Held waitForTripReads calls: { recheck, release }. drain's finally calls every recheck after a read settles.
const tripWaiters = new Set();

// D-37-3 (Plan 37): the one kick. Reads are channel-blind (a manual attachment, an MCP upload and an import confirm all come here), deferred (setImmediate, so a kick made inside a caller's transaction runs only after it commits, and a rolled-back one finds no source row), single-flight (the registry), serial (one read at a time, so a boot backfill never bursts the provider) and capped (documentReadsDailyBudget). It returns at once and never throws; nothing awaits a model call (R-2).
export function kickDocumentReads(keys) {
  if (!config.documentFactsEnabled || stopping) return;
  let added = false;
  for (const key of keys) {
    if (registry.has(key)) continue;
    registry.set(key, 'queued');
    queue.push(key);
    added = true;
  }
  if (added) scheduleDrain();
}

function scheduleDrain() {
  if (drainPromise) return;
  drainPromise = new Promise((resolve) => {
    setImmediate(() => { drain().then(resolve); });
  });
}

async function drain() {
  while (queue.length && !stopping) {
    const key = queue.shift();
    registry.set(key, 'running');
    const controller = new AbortController();
    current = { key, controller };
    try {
      await readOne(key, controller.signal);
    } catch (err) {
      console.error('[facts] read failed key=%s: %s', key, err.message);
    } finally {
      current = null;
      registry.delete(key);
      for (const waiter of [...tripWaiters]) waiter.recheck();
    }
  }
  // Cleared in the same synchronous stretch as the loop condition: a kick that lands after this
  // point sees no drain in flight and schedules its own.
  drainPromise = null;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

// Resolves once nothing is queued or in flight. For tests and the shutdown path.
export function documentReadsIdle() {
  if (!drainPromise && queue.length === 0 && registry.size === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

// D-37-15 (Plan 37)
// Holds until none of the trip's documents is queued or in flight, or timeoutMs passes, or signal aborts.
// Resolves { timedOut } (plus aborted: true on an abort) and never rejects. After each settled read it works the trip's
// documents out again, because a document can have been kicked while it waited. Its timer, its abort listener and its
// place in tripWaiters are always released when it settles.
export function waitForTripReads(tripId, { timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    let timer = null;
    const waiter = { recheck: null, release: null };
    const finish = (result) => {
      clearTimeout(timer);
      tripWaiters.delete(waiter);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ timedOut: false, aborted: true });
    waiter.release = () => finish({ timedOut: false });
    waiter.recheck = () => {
      try {
        if (!listTripDocuments(tripId).some((doc) => registry.has(doc.key))) finish({ timedOut: false });
      } catch (err) {
        // The caller reads the trip next and meets the same failure there, with a response to carry it.
        console.error('[facts] wait for trip reads failed trip=%s: %s', tripId, err.message);
        finish({ timedOut: false });
      }
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    tripWaiters.add(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    waiter.recheck();
  });
}

// Marks the module stopping (no new kicks), drops the queue, aborts the read in flight and resolves
// once it has settled. A read that settles after this began writes nothing: the database is about to
// close, and the boot pass reads the document again at the next start (F-37-19).
export async function stopDocumentReads() {
  stopping = true;
  for (const key of queue) registry.delete(key);
  queue.length = 0;
  current?.controller.abort();
  for (const waiter of [...tripWaiters]) waiter.release();
  if (drainPromise) await drainPromise;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

// Test-only: returns the module to its initial state between tests (the registry, the cap, the stop flag).
export function __resetDocumentFactsForTests() {
  registry.clear();
  queue.length = 0;
  current = null;
  drainPromise = null;
  stopping = false;
  idleWaiters = [];
  for (const waiter of [...tripWaiters]) waiter.release();
  cap.day = null;
  cap.count = 0;
  cap.logged = false;
}

// ---------------------------------------------------------------------------
// The daily cap
// ---------------------------------------------------------------------------

// D-37-3: in-memory per UTC day against config.documentReadsDailyBudget, re-read on every check so tests
// can change it, like the discovery budgets.
const cap = { day: null, count: 0, logged: false };

function spendRead() {
  const today = new Date().toISOString().slice(0, 10);
  if (cap.day !== today) {
    cap.day = today;
    cap.count = 0;
    cap.logged = false;
  }
  if (cap.count >= config.documentReadsDailyBudget) {
    if (!cap.logged) {
      cap.logged = true;
      console.warn('[facts] daily cap reached budget=%d', config.documentReadsDailyBudget);
    }
    return false;
  }
  cap.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// One read
// ---------------------------------------------------------------------------

// Loads the source row, or null when it is gone.
function loadSource(key) {
  const db = getDb();
  if (key.startsWith(ARTIFACT_PREFIX)) {
    const id = key.slice(ARTIFACT_PREFIX.length);
    const row = db.prepare(`
      SELECT id, artifact_id, kind, media_type, content_hash, content
      FROM import_artifact_files WHERE id = ?
    `).get(id);
    if (!row) return null;
    // One artifact can back several bookings (D-38-3): the owners are the bookings whose provenance names this file.
    const owners = db.prepare(`
      SELECT id, trip_id, type, title, start_datetime, end_datetime, origin_tz, destination_tz, details_json
      FROM bookings
      WHERE json_extract(details_json, '$.importedFrom.artifactId') = ?
      ORDER BY created_at, rowid
    `).all(row.artifact_id).filter((b) => importFileRowsOf(parseDetails(b.details_json)).some((f) => f.id === row.id));
    return {
      column: 'artifact_file_id', id, kind: row.kind, mediaType: row.media_type, bytes: row.content,
      contentHash: row.content_hash, owners, bookingId: null,
    };
  }
  if (key.startsWith(ATTACHMENT_PREFIX)) {
    const id = key.slice(ATTACHMENT_PREFIX.length);
    const row = db.prepare('SELECT id, booking_id, media_type, content_hash, content FROM booking_attachments WHERE id = ?').get(id);
    if (!row) return null;
    const owners = db.prepare(`
      SELECT id, trip_id, type, title, start_datetime, end_datetime, origin_tz, destination_tz
      FROM bookings WHERE id = ?
    `).all(row.booking_id);
    return {
      column: 'attachment_id', id, kind: attachmentKind(row.media_type), mediaType: row.media_type, bytes: row.content,
      contentHash: row.content_hash || createHash('sha256').update(row.content).digest('hex'),
      owners, bookingId: row.booking_id,
    };
  }
  throw new Error(`unknown document key "${key}"`);
}

const hasCompleteRead = (column, id, contentHash) => Boolean(getDb().prepare(`
  SELECT 1 FROM document_fact_reads
  WHERE ${column} = ? AND status = 'complete' AND content_hash = ? AND model = ? AND prompt_version = ?
  LIMIT 1
`).get(id, contentHash, FACTS_MODEL, FACTS_PROMPT_VERSION));

// Reads one document and records the attempt. Returns without a row when the source is gone or nothing
// owns it, or when a complete read already exists for this read key. Exported for tests.
export async function readOne(key, signal) {
  const source = loadSource(key);
  if (!source || source.owners.length === 0) return;
  if (hasCompleteRead(source.column, source.id, source.contentHash)) return;

  const db = getDb();
  const tripId = source.owners[0].trip_id;
  const record = (fields) => insertRead(source, tripId, fields);

  if (!spendRead()) {
    record({ model: FACTS_MODEL, status: 'skipped', error: 'daily_cap', facts: [] });
    console.log('[facts] read key=%s status=skipped facts=0 verified=0 ms=0', key);
    return;
  }

  const trip = db.prepare('SELECT start_date, end_date FROM trips WHERE id = ?').get(tripId);
  const result = await readDocumentFacts({
    document: {
      kind: source.kind,
      mediaType: source.mediaType,
      content: source.kind === 'text' ? Buffer.from(source.bytes).toString('utf8') : Buffer.from(source.bytes).toString('base64'),
    },
    context: {
      bookings: source.owners.map((b) => ({
        type: b.type,
        title: b.title,
        startDatetime: b.start_datetime,
        endDatetime: b.end_datetime,
        originTz: b.origin_tz,
        destinationTz: b.destination_tz,
      })),
      trip: { startDate: trip?.start_date, endDate: trip?.end_date },
    },
    signal,
  });

  const facts = [];
  if (result.outcome === 'complete' && result.value.facts.length > 0) {
    // D-37-2: a quote is verified only against text Trippy extracted itself. An image, or a PDF with
    // no text layer, has none, so its facts are stored unverified.
    let pages = null;
    try {
      pages = (await documentTextPages({ kind: source.kind, bytes: source.bytes }))?.pages ?? null;
    } catch {
      console.warn('[facts] text layer unreadable key=%s', key);
    }
    const searchable = hasTextLayer(pages) ? pages : null;
    for (const fact of result.value.facts) {
      const found = searchable ? findQuote(searchable, fact.quote) : { found: false, page: null };
      facts.push({ fact, verified: found.found, verifiedPage: found.found ? found.page : null });
    }
  }

  // A stop that began while the model was answering: write nothing, the boot pass reads it again.
  if (signal?.aborted) return;

  const written = record({
    model: result.model || FACTS_MODEL,
    status: result.outcome,
    error: result.error,
    stopReason: result.stopReason,
    usage: result.usage,
    totalMs: result.totalMs,
    facts,
  });
  if (written) {
    console.log(
      '[facts] read key=%s status=%s facts=%d verified=%d ms=%d',
      key, result.outcome, written.factCount, written.verifiedCount, result.totalMs,
    );
  }
}

// One transaction: the read row and, for a complete read, every fact. The source row is checked again
// inside it, because a document can be deleted while the model is reading it and the foreign key would
// otherwise fail the insert. Returns { factCount, verifiedCount } or null when the source is gone.
function insertRead(source, tripId, { model, status, error = null, stopReason = null, usage = null, totalMs = null, facts }) {
  const db = getDb();
  const table = source.column === 'artifact_file_id' ? 'import_artifact_files' : 'booking_attachments';
  const verifiedCount = facts.filter((f) => f.verified).length;

  return db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(source.id)) return null;
    if (!db.prepare('SELECT 1 FROM trips WHERE id = ?').get(tripId)) return null;

    const read = db.prepare(`
      INSERT INTO document_fact_reads
        (trip_id, booking_id, ${source.column}, content_hash, model, prompt_version, status, fact_count, verified_count,
         input_tokens, output_tokens, total_ms, stop_reason, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      tripId, source.bookingId, source.id, source.contentHash, model, FACTS_PROMPT_VERSION, status, facts.length, verifiedCount,
      usage?.inputTokens ?? null, usage?.outputTokens ?? null, totalMs, stopReason, error,
    );

    const insertFact = db.prepare(`
      INSERT INTO document_facts
        (read_id, trip_id, booking_id, ${source.column}, kind, label, value, quote, page, verified_page, quote_verified,
         value_at, value_tz, tz_source, applies_from, applies_to, confidence, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    facts.forEach(({ fact, verified, verifiedPage }, position) => {
      insertFact.run(
        read.id, tripId, source.bookingId, source.id, fact.kind, fact.label, fact.value, fact.quote,
        fact.page ? Number.parseInt(fact.page, 10) : null, verifiedPage, verified ? 1 : 0,
        fact.at || null, fact.tz || null, fact.tzSource, fact.appliesFrom || null, fact.appliesTo || null,
        fact.confidence, position,
      );
    });
    return { factCount: facts.length, verifiedCount };
  })();
}

// ---------------------------------------------------------------------------
// Boot pass
// ---------------------------------------------------------------------------

// Every document of every trip with no complete read for its current read key, kicked through the one
// kick. A document whose last read failed is included: D-37-1 re-reads a failed read, and this once-per-
// process-start pass is the only retry. A restart mid-read heals the same way, and so does a backfill.
export function requeueUnreadDocuments() {
  if (!config.documentFactsEnabled) return 0;
  const keys = [];
  for (const { id } of getDb().prepare('SELECT id FROM trips').all()) {
    for (const doc of listTripDocuments(id)) {
      const column = doc.sourceType === 'artifactFile' ? 'artifact_file_id' : 'attachment_id';
      const sourceId = doc.artifactFileId ?? doc.attachmentId;
      if (!doc.contentHash || !hasCompleteRead(column, sourceId, doc.contentHash)) keys.push(doc.key);
    }
  }
  kickDocumentReads(keys);
  console.log('[facts] boot pass queued=%d', keys.length);
  return keys.length;
}

// ---------------------------------------------------------------------------
// Reading facts back
// ---------------------------------------------------------------------------

// The facts of a trip, grouped by booking. A document shows the facts of its LATEST complete read under
// any model or prompt version, so facts do not vanish while a re-read is pending (D-37-1), and each
// fact shows under every booking that owns its document (D-38-3). Bookings with no facts are omitted.
// `readsPending` counts this trip's documents queued or in flight right now.
//
// A fact whose document names no zone is served with its booking's zone (tzSource 'booking', D-37-10),
// derived here and never stored; each booking gets its own copy of the fact because one document can back
// bookings in different zones. `days` is the trip's days ({ date, resolvedCountry }, listDaysForTrip), the
// caller's to load because this module cannot import trips.js; without it the day-country step is skipped.
export function listTripFacts(tripId, { days = [] } = {}) {
  const db = getDb();
  const latestRead = {
    artifact_file_id: db.prepare(`
      SELECT id FROM document_fact_reads WHERE artifact_file_id = ? AND status = 'complete'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `),
    attachment_id: db.prepare(`
      SELECT id FROM document_fact_reads WHERE attachment_id = ? AND status = 'complete'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `),
  };
  const factsOf = db.prepare('SELECT * FROM document_facts WHERE read_id = ? ORDER BY position');

  const bookingRows = new Map(db.prepare(
    'SELECT id, type, origin_tz, destination_tz, details_json, start_datetime FROM bookings WHERE trip_id = ?',
  ).all(tripId).map((row) => [row.id, row]));
  const dayCountry = new Map(days.map((d) => [d.date, d.resolvedCountry]));
  const zoneMemo = new Map();
  const zoneOf = (bookingId, at) => {
    const key = `${bookingId}|${at ?? ''}`;
    if (!zoneMemo.has(key)) {
      const booking = bookingRows.get(bookingId);
      zoneMemo.set(key, booking
        ? bookingZone(booking, { at, dayCountry: dayCountry.get(booking.start_datetime?.slice(0, 10)) ?? null })
        : null);
    }
    return zoneMemo.get(key);
  };

  const byBooking = new Map();
  let readsPending = 0;
  for (const doc of listTripDocuments(tripId)) {
    if (registry.has(doc.key)) readsPending += 1;
    const column = doc.sourceType === 'artifactFile' ? 'artifact_file_id' : 'attachment_id';
    const read = latestRead[column].get(doc.artifactFileId ?? doc.attachmentId);
    if (!read) continue;
    const document = { key: doc.key, kind: doc.kind, mediaType: doc.mediaType, filename: doc.filename, url: doc.url };
    const facts = factsOf.all(read.id).map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      value: row.value,
      quote: row.quote,
      page: row.verified_page ?? row.page,
      modelPage: row.page,
      quoteVerified: row.quote_verified === 1,
      at: row.value_at,
      tz: row.value_tz,
      tzSource: row.tz_source,
      appliesFrom: row.applies_from,
      appliesTo: row.applies_to,
      confidence: row.confidence,
      document,
    }));
    if (facts.length === 0) continue;
    for (const bookingId of doc.bookingIds) {
      if (!byBooking.has(bookingId)) byBooking.set(bookingId, []);
      byBooking.get(bookingId).push(...facts.map((fact) => {
        // A stored zone is only the shape-checked name the reader returned; one the platform rejects is absent.
        if (isKnownZone(fact.tz)) return { ...fact };
        const zone = zoneOf(bookingId, fact.at);
        return zone ? { ...fact, tz: zone, tzSource: 'booking' } : { ...fact, tz: null, tzSource: 'none' };
      }));
    }
  }

  return {
    bookings: [...byBooking].map(([bookingId, facts]) => ({ bookingId, facts })),
    readsPending,
  };
}
