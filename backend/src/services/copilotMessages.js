import { getDb } from '../db/database.js';

const CHANGED_MESSAGE = 'This conversation changed — reload and try again.';

function refusal(message, status) {
  return Object.assign(new Error(message), { status });
}

// Removes one stopped exchange — the question row and the assistant row that answers it — from
// a trip's co-pilot conversation. Everything is read and deleted inside one transaction, so the
// pairing cannot change between the check and the delete. The route has already proved the
// caller can open the trip; this decides whether they may remove this exchange.
//
// Failures all carry an HTTP status for the terminal error handler: 404 for a question that is
// unknown, belongs to another trip, is not a user row, or was already removed (those cases are
// indistinguishable by design), 403 for the wrong person, 409 for an exchange that may not be
// removed or whose pairing cannot be proved.
export function removeStoppedExchange({ tripId, userId, isOwner, messageId }) {
  const db = getDb();

  return db.transaction(() => {
    const question = db.prepare(`
      SELECT id, user_id, role, created_at, rowid AS seq
      FROM copilot_messages WHERE id = ? AND trip_id = ?
    `).get(messageId, tripId);
    if (!question || question.role !== 'user') throw refusal(CHANGED_MESSAGE, 404);

    // D-32-3 (Plan 32): the author or the trip owner; Plan 11 D8 (owner-only Clear) is separate.
    if (!isOwner && question.user_id !== userId) {
      throw refusal('Only the person who asked, or the trip owner, can remove this.', 403);
    }

    // D-32-4 (Plan 32): a reply is the row that names its question; a row written before
    // migration 037 is paired by order, and only when no other question comes between.
    let reply = db.prepare(`
      SELECT id, notice FROM copilot_messages
      WHERE trip_id = ? AND role = 'assistant' AND reply_to = ?
    `).get(tripId, question.id);

    if (!reply) {
      const legacy = db.prepare(`
        SELECT id, notice, created_at, rowid AS seq FROM copilot_messages
        WHERE trip_id = ? AND role = 'assistant' AND reply_to IS NULL
          AND (created_at > ? OR (created_at = ? AND rowid > ?))
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `).get(tripId, question.created_at, question.created_at, question.seq);

      if (legacy) {
        const between = db.prepare(`
          SELECT 1 FROM copilot_messages
          WHERE trip_id = ? AND role = 'user'
            AND (created_at > ? OR (created_at = ? AND rowid > ?))
            AND (created_at < ? OR (created_at = ? AND rowid < ?))
          LIMIT 1
        `).get(
          tripId,
          question.created_at, question.created_at, question.seq,
          legacy.created_at, legacy.created_at, legacy.seq,
        );
        if (between) throw refusal(CHANGED_MESSAGE, 409);
        reply = legacy;
      }
    }

    // D-32-1 (Plan 32): only a stopped reply, and never one a proposal points at. A question with
    // no reply yet is removable on its own; a late stopped reply is never inserted for it.
    if (reply) {
      if (reply.notice !== 'stopped') throw refusal(CHANGED_MESSAGE, 409);
      const proposal = db.prepare('SELECT 1 FROM copilot_proposals WHERE message_id = ? LIMIT 1').get(reply.id);
      if (proposal) throw refusal(CHANGED_MESSAGE, 409);
    }

    // D-32-6 (Plan 32): only the two message rows go; turn metrics (no text) and proposals stay.
    const ids = reply ? [question.id, reply.id] : [question.id];
    const info = db.prepare(
      `DELETE FROM copilot_messages WHERE trip_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    ).run(tripId, ...ids);
    return { removed: info.changes };
  })();
}
