// Plan 37 W0 — the documents of a database, enumerated the way W1 will read them.
//
// resolveBookingDocuments (src/services/documents.js) returns URLs only and skips pasted text
// (F-37-16), so the harness enumerates the two sources itself, read straight from SQLite on a
// readonly handle (lib/sourceDb.mjs openSourceReadonly):
//
//   import files   import_artifact_files of every kind (text | image | pdf, D-37-8), joined to the
//                  bookings whose details_json.importedFrom.artifactId names their artifact — one
//                  artifact can back several bookings (outbound and return in one PDF, F-37-14)
//   attachments    booking_attachments (manual and MCP, F-37-15), one booking each
//
// A document is read once per content (D-37-1: the read key is content_hash + model + prompt
// version), so dedupeByContent() folds documents of one trip with the same content_hash into one
// read whose facts belong to every booking any copy backs.

const kindFromMediaType = (mediaType) => {
  if (mediaType === 'application/pdf') return 'pdf';
  if (typeof mediaType === 'string' && mediaType.startsWith('image/')) return 'image';
  throw new Error(`attachment media type "${mediaType}" is neither a PDF nor an image`);
};

const bookingContextRow = (b) => ({
  id: b.id,
  type: b.type,
  title: b.title,
  startDatetime: b.start_datetime ?? null,
  endDatetime: b.end_datetime ?? null,
  originTz: b.origin_tz ?? null,
  destinationTz: b.destination_tz ?? null,
});

// Returns { documents, orphanImportFiles } where each document is
//   { key, source: 'import' | 'attachment', tripId, tripTitle, tripStartDate, tripEndDate, ownerId,
//     bookingIds, bookings: [{ id, type, title, startDatetime, endDatetime, originTz, destinationTz }],
//     artifactId, artifactFileId, attachmentId, position, kind, mediaType, filename, sizeBytes,
//     contentHash, attachmentSource }
// and orphanImportFiles counts import files whose artifact backs no booking (never confirmed, or
// every booking deleted), by artifact status — they are not documents of any booking.
export function listCorpusDocuments(db) {
  const trips = new Map(
    db.prepare('SELECT id, title, owner_id, start_date, end_date FROM trips').all().map((t) => [t.id, t]),
  );
  const bookings = db.prepare(`
    SELECT id, trip_id, type, title, start_datetime, end_datetime, origin_tz, destination_tz,
           json_extract(details_json, '$.importedFrom.artifactId') AS artifact_id
    FROM bookings
    ORDER BY start_datetime, id
  `).all();
  const bookingsById = new Map(bookings.map((b) => [b.id, b]));
  const bookingsByArtifact = new Map();
  for (const b of bookings) {
    if (!b.artifact_id) continue;
    if (!bookingsByArtifact.has(b.artifact_id)) bookingsByArtifact.set(b.artifact_id, []);
    bookingsByArtifact.get(b.artifact_id).push(b);
  }

  const tripFields = (tripId) => {
    const trip = trips.get(tripId);
    if (!trip) throw new Error(`booking points at trip ${tripId}, which does not exist`);
    return { tripId, tripTitle: trip.title, tripStartDate: trip.start_date, tripEndDate: trip.end_date, ownerId: trip.owner_id };
  };

  const documents = [];
  const orphanImportFiles = {};

  const files = db.prepare(`
    SELECT f.id, f.artifact_id, f.position, f.kind, f.media_type, f.filename, f.size_bytes, f.content_hash,
           a.status AS artifact_status
    FROM import_artifact_files f
    JOIN import_artifacts a ON a.id = f.artifact_id
    ORDER BY f.artifact_id, f.position
  `).all();
  for (const f of files) {
    const backed = bookingsByArtifact.get(f.artifact_id) ?? [];
    if (!backed.length) {
      orphanImportFiles[f.artifact_status] = (orphanImportFiles[f.artifact_status] ?? 0) + 1;
      continue;
    }
    // One artifact belongs to one trip in practice; if its bookings ever span trips, each trip gets
    // its own document (the booking context differs), keyed apart so no key collides.
    const byTrip = new Map();
    for (const b of backed) {
      if (!byTrip.has(b.trip_id)) byTrip.set(b.trip_id, []);
      byTrip.get(b.trip_id).push(b);
    }
    for (const [tripId, tripBookings] of byTrip) {
      documents.push({
        key: byTrip.size === 1 ? `artifactFile:${f.id}` : `artifactFile:${f.id}@${tripId}`,
        source: 'import',
        ...tripFields(tripId),
        bookingIds: tripBookings.map((b) => b.id),
        bookings: tripBookings.map(bookingContextRow),
        artifactId: f.artifact_id,
        artifactFileId: f.id,
        attachmentId: null,
        position: f.position,
        kind: f.kind,
        mediaType: f.media_type,
        filename: f.filename ?? null,
        sizeBytes: f.size_bytes ?? null,
        contentHash: f.content_hash,
        attachmentSource: null,
      });
    }
  }

  const attachments = db.prepare(`
    SELECT id, booking_id, media_type, filename, size_bytes, content_hash, source
    FROM booking_attachments
    ORDER BY booking_id, created_at, id
  `).all();
  for (const a of attachments) {
    const booking = bookingsById.get(a.booking_id);
    if (!booking) throw new Error(`attachment ${a.id} points at booking ${a.booking_id}, which does not exist`);
    documents.push({
      key: `attachment:${a.id}`,
      source: 'attachment',
      ...tripFields(booking.trip_id),
      bookingIds: [booking.id],
      bookings: [bookingContextRow(booking)],
      artifactId: null,
      artifactFileId: null,
      attachmentId: a.id,
      position: null,
      kind: kindFromMediaType(a.media_type),
      mediaType: a.media_type,
      filename: a.filename ?? null,
      sizeBytes: a.size_bytes ?? null,
      contentHash: a.content_hash,
      attachmentSource: a.source ?? null,
    });
  }

  return { documents, orphanImportFiles };
}

// One read per (trip, content_hash), D-37-1. The first document (enumeration order) is the one read;
// `aliasKeys` lists the others, and `bookingIds` / `bookings` are the union over all copies.
// A document with no content_hash is never folded.
export function dedupeByContent(documents) {
  const out = [];
  const byContent = new Map();
  for (const doc of documents) {
    const groupKey = doc.contentHash ? `${doc.tripId}|${doc.contentHash}` : null;
    const existing = groupKey ? byContent.get(groupKey) : null;
    if (!existing) {
      const copy = { ...doc, aliasKeys: [], bookingIds: [...doc.bookingIds], bookings: [...doc.bookings] };
      out.push(copy);
      if (groupKey) byContent.set(groupKey, copy);
      continue;
    }
    existing.aliasKeys.push(doc.key);
    for (const b of doc.bookings) {
      if (!existing.bookingIds.includes(b.id)) {
        existing.bookingIds.push(b.id);
        existing.bookings.push(b);
      }
    }
  }
  return out;
}

// The bytes of one document, as the request needs them: UTF-8 text for kind text, base64 otherwise.
// Returns { kind, mediaType, content, bytes }.
export function readDocumentContent(db, doc) {
  const row = doc.artifactFileId
    ? db.prepare('SELECT content FROM import_artifact_files WHERE id = ?').get(doc.artifactFileId)
    : db.prepare('SELECT content FROM booking_attachments WHERE id = ?').get(doc.attachmentId);
  if (!row || row.content == null) throw new Error(`${doc.key}: no content stored`);
  const bytes = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  const content = doc.kind === 'text' ? bytes.toString('utf8') : bytes.toString('base64');
  return { kind: doc.kind, mediaType: doc.mediaType, content, bytes };
}

// The facts context for one document (lib/factsContract.mjs buildFactsContextText).
export function factsContextFor(doc) {
  return {
    bookings: doc.bookings.map(({ id, ...rest }) => rest),
    trip: { startDate: doc.tripStartDate, endDate: doc.tripEndDate },
  };
}
