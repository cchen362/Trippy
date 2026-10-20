import { getDb } from '../db/database.js';

// D-38-3 (Plan 38): the one reader of an import booking's link to its source files. `positions` is the
// validated 0-based list the reader named (D-38-1), or null for a booking imported before provenance
// existed (D-38-5: it owns every file of the artifact). Plan 37's documentFacts MUST enumerate a
// booking's files through this helper, never by reading `artifactId` alone, so documents and facts
// can never disagree about which files a booking owns.
export function importFilesOf(detailsJson) {
  const from = detailsJson?.importedFrom;
  if (!from?.artifactId) return null;
  const positions = Array.isArray(from.filePositions) ? from.filePositions : null;
  return { artifactId: from.artifactId, positions };
}

// Resolves the `documents[]` field for a booking row from its two possible sources:
// the import artifact it was extracted from (if any) and any manually attached files.
// Shared by bookings.js (single/list booking reads) and trips.js (trip detail reads) —
// both need the same shape, and duplicating this logic previously let the two drift.
export function resolveBookingDocuments(bookingId, detailsJson) {
  const db = getDb();
  const docs = [];

  const imported = importFilesOf(detailsJson);
  if (imported) {
    const { artifactId, positions } = imported;
    // An empty list names no file, so it yields no import document (and no `IN ()` SQL).
    const files = positions && positions.length === 0 ? [] : db.prepare(`
      SELECT position, media_type, filename
      FROM import_artifact_files
      WHERE artifact_id = ? AND kind IN ('image', 'pdf')
        ${positions ? `AND position IN (${positions.map(() => '?').join(', ')})` : ''}
      ORDER BY position ASC
    `).all(artifactId, ...(positions ?? []));
    for (const f of files) {
      docs.push({
        source: 'import',
        url: `/api/import/artifacts/${artifactId}/files/${f.position}`,
        mediaType: f.media_type,
        filename: f.filename,
      });
    }
  }

  const attachments = db.prepare(`
    SELECT id, media_type, filename FROM booking_attachments
    WHERE booking_id = ? ORDER BY created_at ASC
  `).all(bookingId);
  for (const a of attachments) {
    docs.push({
      source: 'attachment',
      url: `/api/bookings/${bookingId}/attachments/${a.id}`,
      mediaType: a.media_type,
      filename: a.filename,
    });
  }

  return docs;
}
