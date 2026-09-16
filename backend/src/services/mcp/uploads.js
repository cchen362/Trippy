// Plan 28 W3.3/W3.4: upload tickets let an MCP client PUT a booking attachment's
// bytes to Trippy without ever holding a bearer token on that request — the
// ticket id (32 random bytes, hex) issued by issueUploadTicket IS the
// credential, consumed exactly once by routes/mcp.js's PUT /mcp/uploads/:ticket
// handler via consumeUploadTicket. Mirrors services/mcp/drafts.js's lazy-sweep
// shape (sweepIfExpired) for the same reason: a background sweep job would be
// one more thing to run and monitor for a TTL this short.
import { createHash, randomBytes } from 'crypto';
import { getDb } from '../../db/database.js';
import { assertBookingAccess } from '../trips.js';
import {
  MAX_ATTACHMENTS,
  MEDIA_TYPE_WHITELIST,
  attachmentKindFor,
  findAttachmentByHash,
  maxBytesForMediaType,
  writeAttachment,
} from '../attachments.js';

// Same reasoning as the draft TTL in drafts.js: a ticket previews upload intent for one specific booking
// attachment, not a durable object — 15 minutes covers an MCP client fetching
// bytes and PUTting them right after prepare_draft/apply_draft, without a
// leaked ticket URL staying valid indefinitely.
export const TICKET_TTL_MS = 15 * 60 * 1000;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function uploadUrlFor(publicUrl, ticketId) {
  return `${publicUrl}/uploads/${ticketId}`;
}

function mapTicket(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tokenId: row.token_id,
    bookingId: row.booking_id,
    mediaType: row.media_type,
    maxBytes: row.max_bytes,
    requiredSha256: row.expected_sha256,
    status: row.status,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    attachmentId: row.attachment_id,
  };
}

function assertBookingAccessOr(userId, bookingId, code) {
  try {
    assertBookingAccess(userId, bookingId);
  } catch (error) {
    // Only the access helper's own 404 is remapped; anything else (a DB fault)
    // propagates. Never leak whether the booking exists — both "not found" and
    // "access revoked" collapse to the same not_found-shaped error for the caller.
    if (error.status !== 404) throw error;
    throw Object.assign(new Error('Booking not found'), { status: 404, code });
  }
}

export function issueUploadTicket({ userId, tokenId, bookingId, mediaType, sizeBytes, sha256 }) {
  assertBookingAccessOr(userId, bookingId, 'not_found');

  if (!MEDIA_TYPE_WHITELIST.includes(mediaType)) {
    throw Object.assign(new Error(`Unsupported mediaType "${mediaType}"`), { status: 415, code: 'unsupported_media_type' });
  }

  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw Object.assign(new Error('sha256 must be a 64-character hex string'), { status: 400, code: 'invalid_sha256' });
  }
  const requiredSha256 = sha256.toLowerCase();

  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw Object.assign(new Error('sizeBytes must be a positive integer'), { status: 400, code: 'invalid_size' });
  }
  const maxBytes = maxBytesForMediaType(mediaType);
  if (sizeBytes > maxBytes) {
    throw Object.assign(new Error(`sizeBytes exceeds the limit for ${mediaType}`), { status: 413, code: 'too_large' });
  }

  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) as count FROM booking_attachments WHERE booking_id = ?').get(bookingId);
  if (count >= MAX_ATTACHMENTS && !findAttachmentByHash(bookingId, requiredSha256)) {
    throw Object.assign(new Error(`At most ${MAX_ATTACHMENTS} attachments allowed per booking`), { status: 409, code: 'attachment_limit' });
  }

  const id = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO mcp_upload_tickets (
      id, user_id, token_id, booking_id, expected_sha256, media_type, max_bytes, status, created_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, userId, tokenId, bookingId, requiredSha256, mediaType, maxBytes, now.toISOString(), expiresAt);

  return {
    id,
    bookingId,
    mediaType,
    maxBytes,
    requiredSha256,
    expiresAt,
    status: 'pending',
  };
}

export function getUploadTicket(ticketId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_upload_tickets WHERE id = ?').get(ticketId);
  if (!row) return null;

  if (row.status === 'pending' && row.expires_at < new Date().toISOString()) {
    const expired = db.prepare(`
      UPDATE mcp_upload_tickets SET status = 'expired' WHERE id = ? RETURNING *
    `).get(ticketId);
    return mapTicket(expired);
  }

  return mapTicket(row);
}

export function consumeUploadTicket(ticketId, { body, contentType }) {
  if (!Buffer.isBuffer(body)) {
    throw Object.assign(new Error('Request body must be one of the supported attachment media types'), { status: 415, code: 'unsupported_media_type' });
  }

  const ticket = getUploadTicket(ticketId);
  if (!ticket) {
    throw Object.assign(new Error('Upload ticket not found'), { status: 404, code: 'ticket_not_found' });
  }
  if (ticket.status === 'expired') {
    throw Object.assign(new Error('Upload ticket has expired'), { status: 410, code: 'ticket_expired' });
  }

  // Re-assert access at consume time, not just at issue time: the booking may
  // have been deleted, or the issuing user's collaborator access revoked,
  // between prepare and PUT.
  assertBookingAccessOr(ticket.userId, ticket.bookingId, 'ticket_not_found');

  if (attachmentKindFor(contentType) !== attachmentKindFor(ticket.mediaType)) {
    throw Object.assign(new Error(`Unsupported mediaType "${contentType}"`), { status: 415, code: 'unsupported_media_type' });
  }
  if (body.length === 0) {
    throw Object.assign(new Error('Attachment is empty'), { status: 400, code: 'empty' });
  }
  if (body.length > ticket.maxBytes) {
    throw Object.assign(new Error('Exceeds max size for this ticket'), { status: 413, code: 'too_large' });
  }

  const hash = createHash('sha256').update(body).digest('hex');
  if (hash !== ticket.requiredSha256) {
    throw Object.assign(new Error('Uploaded bytes do not match the expected sha256'), { status: 422, code: 'sha256_mismatch' });
  }

  const db = getDb();

  // Idempotent replay: the same bytes PUT twice (pending ticket re-sent, or
  // already-used ticket re-sent after a client retry) resolve to the same
  // attachment id rather than a duplicate row or an error.
  const existing = findAttachmentByHash(ticket.bookingId, hash);
  if (existing) {
    if (ticket.status === 'pending' || !ticket.attachmentId) {
      db.prepare(`
        UPDATE mcp_upload_tickets SET status = 'used', used_at = ?, attachment_id = COALESCE(attachment_id, ?) WHERE id = ?
      `).run(new Date().toISOString(), existing.id, ticketId);
    }
    return { httpStatus: 200, attachment: existing, alreadyAttached: true };
  }

  if (ticket.status === 'used') {
    throw Object.assign(new Error('Upload ticket has already been used'), { status: 410, code: 'ticket_used' });
  }

  const writeAndMarkUsed = db.transaction((body_) => {
    let attachment;
    try {
      attachment = writeAttachment(ticket.bookingId, {
        mediaType: contentType,
        filename: null,
        contentBuffer: body_,
        source: 'mcp',
      });
    } catch (err) {
      if (err.code === 'attachment_limit') {
        throw Object.assign(new Error(err.message), { status: 409, code: 'attachment_limit' });
      }
      throw err;
    }

    db.prepare(`
      UPDATE mcp_upload_tickets SET status = 'used', used_at = ?, attachment_id = ? WHERE id = ?
    `).run(new Date().toISOString(), attachment.id, ticketId);

    return attachment;
  });

  const attachment = writeAndMarkUsed(body);
  return { httpStatus: 201, attachment, alreadyAttached: false };
}
