import { getDb } from '../db/database.js';
import { assertBookingAccess } from './trips.js';

const SIZE_CAPS = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024 };
const MEDIA_TYPE_WHITELIST = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const MAX_ATTACHMENTS = 4;

function mapAttachmentMetadata(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    mediaType: row.media_type,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

export function listAttachments(userId, bookingId) {
  assertBookingAccess(userId, bookingId);
  const db = getDb();
  return db.prepare(`
    SELECT id, booking_id, media_type, filename, size_bytes, created_at
    FROM booking_attachments WHERE booking_id = ? ORDER BY created_at ASC
  `).all(bookingId).map(mapAttachmentMetadata);
}

export function addAttachment(userId, bookingId, { mediaType, filename, content }) {
  assertBookingAccess(userId, bookingId);
  const db = getDb();

  const { count } = db.prepare('SELECT COUNT(*) as count FROM booking_attachments WHERE booking_id = ?').get(bookingId);
  if (count >= MAX_ATTACHMENTS) {
    throw Object.assign(new Error(`At most ${MAX_ATTACHMENTS} attachments allowed per booking`), { status: 400 });
  }

  if (!MEDIA_TYPE_WHITELIST.includes(mediaType)) {
    throw Object.assign(new Error(`Unsupported mediaType "${mediaType}"`), { status: 400 });
  }
  if (!content || typeof content !== 'string') {
    throw Object.assign(new Error('content is required'), { status: 400 });
  }

  const kind = mediaType === 'application/pdf' ? 'pdf' : 'image';
  const contentBuffer = Buffer.from(content, 'base64');
  const sizeBytes = contentBuffer.length;

  if (sizeBytes === 0) {
    throw Object.assign(new Error('Attachment is empty'), { status: 400 });
  }
  if (sizeBytes > SIZE_CAPS[kind]) {
    throw Object.assign(new Error(`Exceeds max size for ${kind}`), { status: 400 });
  }

  const row = db.prepare(`
    INSERT INTO booking_attachments (booking_id, media_type, filename, size_bytes, content)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id, booking_id, media_type, filename, size_bytes, created_at
  `).get(bookingId, mediaType, filename || null, sizeBytes, contentBuffer);

  return mapAttachmentMetadata(row);
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
