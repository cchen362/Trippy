import { createHash } from 'crypto';
import { getDb } from '../db/database.js';
import { assertBookingAccess } from './trips.js';

export const SIZE_CAPS = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024 };
export const MEDIA_TYPE_WHITELIST = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
export const MAX_ATTACHMENTS = 4;

// Plan 28 W3.3: only two `source` values are ever written — 'manual' (the UI's
// addAttachment path) and 'mcp' (services/mcp/uploads.js, once a ticket's body
// is consumed). The channel-agnostic importer never writes booking_attachments
// at all — its files live in import_artifact_files and are surfaced through
// services/documents.js — so there is no 'import' writer to account for here.

export function attachmentKindFor(mediaType) {
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp') return 'image';
  return null;
}

export function maxBytesForMediaType(mediaType) {
  const kind = attachmentKindFor(mediaType);
  return kind ? SIZE_CAPS[kind] : undefined;
}

function mapAttachmentMetadata(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    mediaType: row.media_type,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    source: row.source,
    createdAt: row.created_at,
  };
}

export function listAttachments(userId, bookingId) {
  assertBookingAccess(userId, bookingId);
  const db = getDb();
  return db.prepare(`
    SELECT id, booking_id, media_type, filename, size_bytes, content_hash, source, created_at
    FROM booking_attachments WHERE booking_id = ? ORDER BY created_at ASC
  `).all(bookingId).map(mapAttachmentMetadata);
}

// Plan 28 W3.3: the shared write path for both the manual UI upload (addAttachment,
// below) and the MCP ticket-consumption flow (services/mcp/uploads.js). Callers are
// responsible for their own access check — this function does not call
// assertBookingAccess, since the MCP path re-asserts access itself against the
// ticket's stored userId rather than a request-scoped one.
export function writeAttachment(bookingId, { mediaType, filename, contentBuffer, source }) {
  const db = getDb();

  const { count } = db.prepare('SELECT COUNT(*) as count FROM booking_attachments WHERE booking_id = ?').get(bookingId);
  if (count >= MAX_ATTACHMENTS) {
    throw Object.assign(new Error(`At most ${MAX_ATTACHMENTS} attachments allowed per booking`), { status: 400, code: 'attachment_limit' });
  }

  const kind = attachmentKindFor(mediaType);
  if (!kind) {
    throw Object.assign(new Error(`Unsupported mediaType "${mediaType}"`), { status: 400, code: 'unsupported_media_type' });
  }

  if (!Buffer.isBuffer(contentBuffer)) {
    throw Object.assign(new Error('content is required'), { status: 400, code: 'empty' });
  }

  const sizeBytes = contentBuffer.length;
  if (sizeBytes === 0) {
    throw Object.assign(new Error('Attachment is empty'), { status: 400, code: 'empty' });
  }
  if (sizeBytes > SIZE_CAPS[kind]) {
    throw Object.assign(new Error(`Exceeds max size for ${kind}`), { status: 400, code: 'too_large' });
  }

  const contentHash = createHash('sha256').update(contentBuffer).digest('hex');

  const row = db.prepare(`
    INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content, content_hash, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id, booking_id, media_type, filename, size_bytes, content_hash, source, created_at
  `).get(bookingId, mediaType, filename || null, sizeBytes, contentBuffer, contentHash, source);

  return mapAttachmentMetadata(row);
}

export function addAttachment(userId, bookingId, { mediaType, filename, content }) {
  assertBookingAccess(userId, bookingId);

  if (!content || typeof content !== 'string') {
    throw Object.assign(new Error('content is required'), { status: 400, code: 'empty' });
  }

  const contentBuffer = Buffer.from(content, 'base64');
  return writeAttachment(bookingId, { mediaType, filename, contentBuffer, source: 'manual' });
}

export function findAttachmentByHash(bookingId, contentHash) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, booking_id, media_type, filename, size_bytes, content_hash, source, created_at
    FROM booking_attachments WHERE booking_id = ? AND content_hash = ?
  `).get(bookingId, contentHash);
  return row ? mapAttachmentMetadata(row) : null;
}

export function getAttachmentFile(userId, bookingId, attachmentId) {
  assertBookingAccess(userId, bookingId);
  const db = getDb();
  const file = db.prepare(`
    SELECT media_type, filename, content
    FROM booking_attachments WHERE id = ? AND booking_id = ?
  `).get(attachmentId, bookingId);
  if (!file) {
    throw Object.assign(new Error('Attachment not found'), { status: 404 });
  }
  return file;
}

export function deleteAttachment(userId, bookingId, attachmentId) {
  assertBookingAccess(userId, bookingId);
  const db = getDb();
  const result = db.prepare('DELETE FROM booking_attachments WHERE id = ? AND booking_id = ?').run(attachmentId, bookingId);
  if (result.changes === 0) {
    throw Object.assign(new Error('Attachment not found'), { status: 404 });
  }
  return { ok: true };
}
