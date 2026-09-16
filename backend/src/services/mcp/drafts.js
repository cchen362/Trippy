// Plan 28 W2.4: durable staging for a hosted-MCP booking draft between
// `prepare_draft` and `apply_draft` — mirrors copilot_proposals' propose/apply
// split (services/copilotProposals.js), but for an external MCP client instead
// of the in-app co-pilot, and with an idempotency key an MCP client can safely
// retry against.
import { createHash } from 'crypto';
import { getDb } from '../../db/database.js';

// D-28-4: a draft is a preview of external-client intent, not a saved document —
// 30 minutes is long enough for a human to read a chat preview and say "apply it"
// without the row lingering indefinitely if they never do.
export const DRAFT_TTL_MS = 30 * 60 * 1000;

// F-28-10 / Plan 11 D3: deliberately separate from computeTripFingerprint, which
// is trip-wide (every day's stop signature) and used by the co-pilot's proposal
// apply path. This fingerprint instead covers exactly what a booking draft can go
// stale over — the trip's day dates (so a re-seeded day range invalidates it) and
// every existing booking's identity/schedule fields, ordered by id for stability.
// Never widen computeTripFingerprint to also serve this case.
export function computeBookingFingerprint(tripId) {
  const db = getDb();
  const days = db.prepare('SELECT date FROM days WHERE trip_id = ? ORDER BY date ASC, id ASC').all(tripId);
  const dayPart = days.map((d) => d.date).join(',');

  const bookings = db.prepare(`
    SELECT id, type, confirmation_ref, start_datetime, end_datetime, origin, destination
    FROM bookings WHERE trip_id = ? ORDER BY id ASC
  `).all(tripId);
  const bookingPart = bookings
    .map((b) => `${b.id}|${b.type}|${b.confirmation_ref ?? ''}|${b.start_datetime ?? ''}|${b.end_datetime ?? ''}|${b.origin ?? ''}|${b.destination ?? ''}`)
    .join(';');

  return createHash('sha256').update(`${dayPart}::${bookingPart}`).digest('hex');
}

function sweepIfExpired(row) {
  if (!row) return row;
  if (row.status === 'pending' && row.expires_at < new Date().toISOString()) {
    return getDb().prepare(`
      UPDATE mcp_drafts SET status = 'expired', status_reason = ? WHERE id = ? RETURNING *
    `).get('Draft expired after 30 minutes', row.id);
  }
  return row;
}

export function createDraft({ userId, tokenId, idempotencyKey, kind = 'booking', target, bookings, issues, plannedEffects, source, tripId, fingerprint }) {
  const db = getDb();

  // UNIQUE(user_id, idempotency_key): an MCP client retrying the same prepare_draft
  // call (e.g. after a dropped response) must see the original draft, never a
  // second row — this lookup-before-insert is what makes prepare_draft idempotent.
  const existing = sweepIfExpired(
    db.prepare('SELECT * FROM mcp_drafts WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey),
  );
  if (existing) {
    return { ...draftToJson(existing), reused: true };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS).toISOString();

  const row = db.prepare(`
    INSERT INTO mcp_drafts (
      user_id, token_id, idempotency_key, kind, target_json, bookings_json, issues_json,
      planned_effects_json, source_json, trip_id, booking_fingerprint, status, created_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    RETURNING *
  `).get(
    userId,
    tokenId,
    idempotencyKey,
    kind,
    JSON.stringify(target),
    JSON.stringify(bookings),
    JSON.stringify(issues),
    JSON.stringify(plannedEffects),
    JSON.stringify(source),
    tripId ?? null,
    fingerprint ?? null,
    now.toISOString(),
    expiresAt,
  );

  return { ...draftToJson(row), reused: false };
}

export function getDraftForUser(userId, draftId) {
  const db = getDb();
  // Never distinguish "not yours" from "doesn't exist" — both read as null so the
  // tool layer can return the same not_found result either way (never leak existence).
  const row = db.prepare('SELECT * FROM mcp_drafts WHERE id = ? AND user_id = ?').get(draftId, userId);
  if (!row) return null;
  return draftToJson(sweepIfExpired(row));
}

export function findDraftByIdempotencyKey(userId, idempotencyKey) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_drafts WHERE user_id = ? AND idempotency_key = ?').get(userId, idempotencyKey);
  if (!row) return null;
  return draftToJson(sweepIfExpired(row));
}

export function markDraftStatus(draftId, status, reason = null, extra = {}) {
  const db = getDb();
  // COALESCE keeps the existing result_json/applied_at when extra doesn't supply
  // them (every non-apply status transition) — only the apply flip ever sets them.
  const row = db.prepare(`
    UPDATE mcp_drafts
    SET status = ?, status_reason = ?,
        result_json = COALESCE(?, result_json),
        applied_at = COALESCE(?, applied_at)
    WHERE id = ?
    RETURNING *
  `).get(
    status,
    reason,
    extra.resultJson ?? null,
    extra.appliedAt ?? null,
    draftId,
  );
  return draftToJson(row);
}

export function draftToJson(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tokenId: row.token_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    target: JSON.parse(row.target_json),
    bookings: JSON.parse(row.bookings_json),
    issues: JSON.parse(row.issues_json),
    plannedEffects: JSON.parse(row.planned_effects_json),
    source: JSON.parse(row.source_json),
    tripId: row.trip_id,
    bookingFingerprint: row.booking_fingerprint,
    status: row.status,
    statusReason: row.status_reason,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    appliedAt: row.applied_at,
  };
}
