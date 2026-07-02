import { createHash } from 'crypto';
import { getDb } from '../db/database.js';
import { extractBookings } from './claude.js';
import { createBooking } from './bookings.js';
import { assertTripAccess } from './trips.js';

const SIZE_CAPS = { text: 100 * 1024, image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024 };
const MEDIA_TYPE_WHITELIST = {
  text: ['text/plain'],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  pdf: ['application/pdf'],
};
const MAX_INPUTS = 4;
const VALID_TYPES = ['flight', 'train', 'bus', 'ferry', 'hotel', 'other'];
// Accepts Claude's wall-clock "YYYY-MM-DDTHH:MM" as well as the already-normalized
// "YYYY-MM-DDTHH:MM:SS" form, so re-running this on the extraction API's own output
// (as confirmArtifact does for client-edited bookings) is idempotent.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function validateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw Object.assign(new Error('At least one input is required'), { status: 400 });
  }
  if (inputs.length > MAX_INPUTS) {
    throw Object.assign(new Error(`At most ${MAX_INPUTS} inputs allowed`), { status: 400 });
  }

  return inputs.map((input, i) => {
    const kind = input.kind;
    if (!['text', 'image', 'pdf'].includes(kind)) {
      throw Object.assign(new Error(`Input ${i}: invalid kind "${kind}"`), { status: 400 });
    }
    if (!input.content || typeof input.content !== 'string') {
      throw Object.assign(new Error(`Input ${i}: content is required`), { status: 400 });
    }

    let mediaType = input.mediaType;
    if (kind === 'text') {
      mediaType = mediaType || 'text/plain';
    }
    if (!mediaType || !MEDIA_TYPE_WHITELIST[kind].includes(mediaType)) {
      throw Object.assign(new Error(`Input ${i}: unsupported mediaType "${mediaType}" for kind "${kind}"`), { status: 400 });
    }

    // Text content arrives as a raw UTF-8 string; image/pdf arrive as base64.
    const sizeBytes = kind === 'text'
      ? Buffer.byteLength(input.content, 'utf8')
      : Buffer.from(input.content, 'base64').length;

    if (sizeBytes === 0) {
      throw Object.assign(new Error(`Input ${i}: empty content`), { status: 400 });
    }
    if (sizeBytes > SIZE_CAPS[kind]) {
      throw Object.assign(new Error(`Input ${i}: exceeds max size for ${kind}`), { status: 400 });
    }

    const contentBuffer = kind === 'text'
      ? Buffer.from(input.content, 'utf8')
      : Buffer.from(input.content, 'base64');
    const contentHash = createHash('sha256').update(contentBuffer).digest('hex');

    return {
      kind,
      mediaType,
      filename: input.filename || null,
      sizeBytes,
      contentHash,
      contentBuffer,
      base64: kind === 'text' ? null : input.content,
      text: kind === 'text' ? input.content : null,
    };
  });
}

function assertArtifactAccess(userId, artifactId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM import_artifacts WHERE id = ?').get(artifactId);
  if (!row) {
    throw Object.assign(new Error('Import artifact not found'), { status: 404 });
  }
  if (row.user_id === userId) return row;
  if (row.trip_id) {
    try {
      assertTripAccess(userId, row.trip_id);
      return row;
    } catch {
      // fall through to the generic 404 below
    }
  }
  throw Object.assign(new Error('Import artifact not found'), { status: 404 });
}

function findCachedArtifact(userId, tripId, fileHashes) {
  const db = getDb();
  const sortedHashes = [...fileHashes].sort();

  const candidates = db.prepare(`
    SELECT id FROM import_artifacts
    WHERE user_id = ?
      AND (trip_id IS ? OR trip_id = ?)
      AND status IN ('extracted', 'confirmed')
    ORDER BY created_at DESC
  `).all(userId, tripId ?? null, tripId ?? null);

  const fileHashStmt = db.prepare(`
    SELECT content_hash FROM import_artifact_files WHERE artifact_id = ? ORDER BY position
  `);

  for (const candidate of candidates) {
    const hashes = fileHashStmt.all(candidate.id).map((r) => r.content_hash).sort();
    if (hashes.length === sortedHashes.length && hashes.every((h, i) => h === sortedHashes[i])) {
      return candidate.id;
    }
  }
  return null;
}

function normalizeDatetime(value) {
  if (!value || typeof value !== 'string') return null;
  if (!DATETIME_RE.test(value)) return null;
  return value.length === 16 ? `${value}:00` : value;
}

function normalizeTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// Maps one extracted-booking object (Claude's schema) into createBooking()'s payload shape.
// Exported so confirmArtifact() can re-run it on client-edited bookings before persisting.
export function normalizeExtractedBooking(raw, { artifactId, model, extractedAt }) {
  const type = VALID_TYPES.includes(raw.type) ? raw.type : 'other';
  const title = (raw.title || '').trim() || 'Untitled booking';

  // raw.details is Claude's extraction schema; raw.detailsJson is this function's own
  // output shape (present when re-normalizing client-edited bookings sent back to confirm).
  const rawDetails = raw.details || raw.detailsJson || {};
  const detailsJson = {};
  for (const [key, value] of Object.entries(rawDetails)) {
    if (value !== null && value !== undefined && value !== '') detailsJson[key] = value;
  }
  // Server-stamped — never trust a client-supplied importedFrom.
  detailsJson.importedFrom = { artifactId, model, extractedAt };

  return {
    type,
    title,
    confirmationRef: raw.confirmationRef || null,
    bookingSource: raw.bookingSource || null,
    startDatetime: normalizeDatetime(raw.startDatetime),
    endDatetime: normalizeDatetime(raw.endDatetime),
    origin: raw.origin || null,
    destination: raw.destination || null,
    terminalOrStation: raw.terminalOrStation || null,
    originTz: normalizeTz(raw.originTz),
    destinationTz: normalizeTz(raw.destinationTz),
    detailsJson,
    // Extraction metadata for the review UI — not part of createBooking's payload shape.
    confidence: raw.confidence || null,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions : [],
  };
}

function computeWarnings(tripId, extraction) {
  const warnings = [];

  if (!extraction.isTravelRelated) {
    warnings.push({ type: 'notTravelRelated' });
  }
  if (extraction.bookings.length === 0) {
    warnings.push({ type: 'empty' });
  }

  if (!tripId) return warnings;

  const db = getDb();
  const trip = db.prepare('SELECT start_date, end_date FROM trips WHERE id = ?').get(tripId);
  if (!trip) return warnings;

  const existingBookings = db.prepare(`
    SELECT id, type, confirmation_ref FROM bookings WHERE trip_id = ?
  `).all(tripId);

  extraction.bookings.forEach((b, index) => {
    if (b.confidence?.overall === 'low') {
      warnings.push({ type: 'lowConfidence', bookingIndex: index });
    }

    if (b.confirmationRef) {
      const match = existingBookings.find((eb) =>
        eb.type === b.type &&
        eb.confirmation_ref &&
        eb.confirmation_ref.toLowerCase() === b.confirmationRef.toLowerCase());
      if (match) {
        warnings.push({ type: 'duplicate', bookingIndex: index, existingBookingId: match.id });
      }
    }

    const startDate = b.startDatetime?.slice(0, 10);
    if (startDate && startDate < trip.start_date) {
      warnings.push({ type: 'beforeTripStart', bookingIndex: index });
    }
    if (startDate && startDate > trip.end_date) {
      warnings.push({ type: 'afterTripEnd', bookingIndex: index, suggestedEndDate: startDate });
    }
  });

  return warnings;
}

function mapArtifactMetadata(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tripId: row.trip_id,
    status: row.status,
    model: row.model,
    error: row.error,
    createdBookingIds: JSON.parse(row.created_booking_ids || '[]'),
    createdAt: row.created_at,
    extractedAt: row.extracted_at,
    confirmedAt: row.confirmed_at,
  };
}

async function runExtraction(userId, artifactId, validatedFiles, tripId) {
  const db = getDb();

  let tripContext = null;
  if (tripId) {
    const trip = db.prepare('SELECT start_date, end_date, destinations FROM trips WHERE id = ?').get(tripId);
    if (trip) {
      tripContext = {
        startDate: trip.start_date,
        endDate: trip.end_date,
        destinations: JSON.parse(trip.destinations || '[]'),
      };
    }
  }

  const filesForClaude = validatedFiles.map((f) => ({
    kind: f.kind,
    mediaType: f.mediaType,
    content: f.kind === 'text' ? f.text : f.base64,
  }));

  try {
    const { extraction, model } = await extractBookings({ files: filesForClaude, tripContext });

    const normalizedBookings = extraction.bookings.map((b) =>
      normalizeExtractedBooking(b, { artifactId, model, extractedAt: new Date().toISOString() }));
    const normalizedExtraction = { ...extraction, bookings: normalizedBookings };

    db.prepare(`
      UPDATE import_artifacts
      SET status = 'extracted', model = ?, extracted_json = ?, extracted_at = datetime('now'), error = NULL
      WHERE id = ?
    `).run(model, JSON.stringify(normalizedExtraction), artifactId);

    const detail = getArtifactDetail(userId, artifactId);
    const warnings = computeWarnings(tripId, normalizedExtraction);
    return { artifact: detail.artifact, extraction: normalizedExtraction, warnings, cached: false };
  } catch (err) {
    db.prepare('UPDATE import_artifacts SET status = ?, error = ? WHERE id = ?')
      .run('failed', err.message, artifactId);
    console.error('[import] extraction failed artifactId=%s:', artifactId, err);
    throw err;
  }
}

export async function createArtifactAndExtract(userId, { tripId, inputs, force = false }) {
  if (tripId) assertTripAccess(userId, tripId);

  const validated = validateInputs(inputs);
  const fileHashes = validated.map((f) => f.contentHash);

  if (!force) {
    const cachedId = findCachedArtifact(userId, tripId, fileHashes);
    if (cachedId) {
      const detail = getArtifactDetail(userId, cachedId);
      const warnings = computeWarnings(detail.artifact.tripId, detail.extraction);
      return { artifact: detail.artifact, extraction: detail.extraction, warnings, cached: true };
    }
  }

  const db = getDb();

  const artifactId = db.transaction(() => {
    const artifact = db.prepare(`
      INSERT INTO import_artifacts (user_id, trip_id, status)
      VALUES (?, ?, 'extracting')
      RETURNING id
    `).get(userId, tripId || null);

    const insertFile = db.prepare(`
      INSERT INTO import_artifact_files
        (artifact_id, position, kind, media_type, filename, size_bytes, content_hash, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    validated.forEach((f, i) => {
      insertFile.run(artifact.id, i, f.kind, f.mediaType, f.filename, f.sizeBytes, f.contentHash, f.contentBuffer);
    });

    return artifact.id;
  })();

  return runExtraction(userId, artifactId, validated, tripId);
}

export async function reextractArtifact(userId, artifactId) {
  const artifactRow = assertArtifactAccess(userId, artifactId);
  const db = getDb();

  const fileRows = db.prepare(`
    SELECT * FROM import_artifact_files WHERE artifact_id = ? ORDER BY position
  `).all(artifactId);

  const validatedFiles = fileRows.map((row) => ({
    kind: row.kind,
    mediaType: row.media_type,
    text: row.kind === 'text' ? row.content.toString('utf8') : null,
    base64: row.kind !== 'text' ? row.content.toString('base64') : null,
  }));

  db.prepare("UPDATE import_artifacts SET status = 'extracting' WHERE id = ?").run(artifactId);

  return runExtraction(userId, artifactId, validatedFiles, artifactRow.trip_id);
}

export async function confirmArtifact(userId, artifactId, { tripId, bookings }) {
  const artifactRow = assertArtifactAccess(userId, artifactId);
  if (!tripId) {
    throw Object.assign(new Error('tripId is required to confirm an import'), { status: 400 });
  }
  assertTripAccess(userId, tripId);

  if (!Array.isArray(bookings) || bookings.length === 0) {
    throw Object.assign(new Error('At least one booking is required to confirm'), { status: 400 });
  }

  const extractedAt = new Date().toISOString();
  const model = artifactRow.model || 'unknown';

  const created = [];
  // Sequential — each createBooking() triggers Nominatim/Unsplash network calls downstream
  // via syncStopWithBooking; do not Promise.all to avoid stampeding external APIs.
  for (const clientBooking of bookings) {
    const normalized = normalizeExtractedBooking(clientBooking, { artifactId, model, extractedAt });
    const payload = {
      type: normalized.type,
      title: normalized.title,
      confirmationRef: normalized.confirmationRef,
      bookingSource: normalized.bookingSource,
      startDatetime: normalized.startDatetime,
      endDatetime: normalized.endDatetime,
      origin: normalized.origin,
      destination: normalized.destination,
      terminalOrStation: normalized.terminalOrStation,
      originTz: normalized.originTz,
      destinationTz: normalized.destinationTz,
      detailsJson: normalized.detailsJson,
    };
    const booking = await createBooking(userId, tripId, payload);
    created.push(booking);
  }

  const db = getDb();
  db.prepare(`
    UPDATE import_artifacts
    SET trip_id = ?, created_booking_ids = ?, status = 'confirmed', confirmed_at = datetime('now')
    WHERE id = ?
  `).run(tripId, JSON.stringify(created.map((b) => b.id)), artifactId);

  return { bookings: created };
}

export function listArtifactsForTrip(userId, tripId) {
  assertTripAccess(userId, tripId);
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, user_id, trip_id, status, model, error, created_booking_ids, created_at, extracted_at, confirmed_at
    FROM import_artifacts
    WHERE trip_id = ?
    ORDER BY created_at DESC
  `).all(tripId);
  return rows.map(mapArtifactMetadata);
}

export function getArtifactDetail(userId, artifactId) {
  const row = assertArtifactAccess(userId, artifactId);
  const extraction = row.extracted_json ? JSON.parse(row.extracted_json) : null;
  return { artifact: mapArtifactMetadata(row), extraction };
}

export function deleteArtifact(userId, artifactId) {
  assertArtifactAccess(userId, artifactId);
  const db = getDb();
  db.prepare('DELETE FROM import_artifacts WHERE id = ?').run(artifactId);
  return { ok: true };
}
