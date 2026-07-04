import { getDb } from '../db/database.js';

// Resolves the `documents[]` field for a booking row from its two possible sources:
// the import artifact it was extracted from (if any) and any manually attached files.
// Shared by bookings.js (single/list booking reads) and trips.js (trip detail reads) —
// both need the same shape, and duplicating this logic previously let the two drift.
export function resolveBookingDocuments(bookingId, detailsJson) {
  const db = getDb();
  const docs = [];

  const artifactId = detailsJson?.importedFrom?.artifactId;
  if (artifactId) {
    const files = db.prepare(`
      SELECT position, media_type, filename
      FROM import_artifact_files
      WHERE artifact_id = ? AND kind IN ('image', 'pdf')
      ORDER BY position ASC
    `).all(artifactId);
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
