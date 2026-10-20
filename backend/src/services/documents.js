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

// D-37-8 (Plan 37): a pasted confirmation is a source too — text files are read for facts (their quotes verify by definition) though Documents never lists them (Q-38-3).
// The files an import booking owns, as rows, through importFilesOf (D-38-3, D-38-5): positions null = a
// pre-Plan-38 booking that owns every file of its artifact, an empty list = none. `kinds` narrows to
// the given file kinds (documents lists image and pdf; document facts read all three). Documents and
// facts both enumerate through here so they can never disagree about which files a booking owns.
export function importFileRowsOf(detailsJson, { kinds = ['text', 'image', 'pdf'] } = {}) {
  const imported = importFilesOf(detailsJson);
  if (!imported || kinds.length === 0) return [];
  const { artifactId, positions } = imported;
  // An empty list names no file, so it yields no rows (and no `IN ()` SQL).
  if (positions && positions.length === 0) return [];
  return getDb().prepare(`
    SELECT id, artifact_id, position, kind, media_type, filename, content_hash
    FROM import_artifact_files
    WHERE artifact_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})
      ${positions ? `AND position IN (${positions.map(() => '?').join(', ')})` : ''}
    ORDER BY position ASC
  `).all(artifactId, ...kinds, ...(positions ?? []));
}

// The `documents[]` key a fact pairs on: which stored file a document is.
export const artifactFileKey = (id) => `artifactFile:${id}`;
export const attachmentKey = (id) => `attachment:${id}`;

// Resolves the `documents[]` field for a booking row from its two possible sources:
// the import artifact it was extracted from (if any) and any manually attached files.
// Shared by bookings.js (single/list booking reads) and trips.js (trip detail reads) —
// both need the same shape, and duplicating this logic previously let the two drift.
export function resolveBookingDocuments(bookingId, detailsJson) {
  const db = getDb();
  const docs = [];

  for (const f of importFileRowsOf(detailsJson, { kinds: ['image', 'pdf'] })) {
    docs.push({
      key: artifactFileKey(f.id),
      source: 'import',
      url: `/api/import/artifacts/${f.artifact_id}/files/${f.position}`,
      mediaType: f.media_type,
      filename: f.filename,
    });
  }

  const attachments = db.prepare(`
    SELECT id, media_type, filename FROM booking_attachments
    WHERE booking_id = ? ORDER BY created_at ASC
  `).all(bookingId);
  for (const a of attachments) {
    docs.push({
      key: attachmentKey(a.id),
      source: 'attachment',
      url: `/api/bookings/${bookingId}/attachments/${a.id}`,
      mediaType: a.media_type,
      filename: a.filename,
    });
  }

  return docs;
}
