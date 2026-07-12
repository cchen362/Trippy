import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { getTripDetail } from '../services/trips.js';
import { streamCopilotResponse } from '../services/claude.js';
import { copilotTripContext } from '../services/copilotTools.js';
import { searchDiscoveryCatalogue } from '../services/copilotGrounding.js';
import { runTripHealthChecks } from '../services/tripHealth.js';
import {
  createProposal,
  applyProposal,
  rejectProposal,
  listProposalsForTrip,
} from '../services/copilotProposals.js';

const router = Router();

router.use(requireAuth);

// GET /trips/:tripId/copilot/history
router.get('/:tripId/copilot/history', requireTripAccess, (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, role, content, created_at, author_name FROM (
        SELECT cm.id, cm.role, cm.content, cm.created_at, u.display_name AS author_name
        FROM copilot_messages cm
        LEFT JOIN users u ON u.id = cm.user_id
        WHERE cm.trip_id = ?
        ORDER BY cm.created_at DESC
        LIMIT 50
      ) ORDER BY created_at ASC
    `).all(req.params.tripId);

    res.json({
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
        authorName: r.author_name,
      })),
      // Wave 2: expose recent proposals so the panel can restore a pending preview and render
      // applied/rejected/stale states on the thread after a refresh (Wave 3 consumes this).
      proposals: listProposalsForTrip(req.params.tripId),
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /trips/:tripId/copilot/history — owner-only (D8)
router.delete('/:tripId/copilot/history', requireTripAccess, (req, res, next) => {
  try {
    if (req.trip.owner_id !== req.user.id) {
      throw Object.assign(new Error('Only the trip owner can clear the conversation.'), { status: 403 });
    }
    const db = getDb();
    const info = db.prepare('DELETE FROM copilot_messages WHERE trip_id = ?').run(req.params.tripId);
    res.json({ ok: true, deleted: info.changes });
  } catch (error) {
    next(error);
  }
});

// POST /trips/:tripId/copilot — SSE streaming
router.post('/:tripId/copilot', requireTripAccess, async (req, res, next) => {
  const { tripId } = req.params;
  const userId = req.user.id;
  const db = getDb();

  // Validate before any SSE headers are sent
  if (!req.body.message || typeof req.body.message !== 'string') {
    return next(Object.assign(new Error('message is required'), { status: 400 }));
  }

  // Load trip detail BEFORE saving user message — if this fails we can return a clean error
  let tripDetail;
  try {
    tripDetail = getTripDetail(tripId, userId);
  } catch (error) {
    return next(error);
  }

  // Now save the user message (trip access confirmed above)
  db.prepare(`
    INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, 'user', ?, datetime('now'))
  `).run(tripId, userId, req.body.message);

  // Load the most recent 20 messages for conversation context, re-ordered chronologically
  const contextRows = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at FROM copilot_messages
      WHERE trip_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    ) ORDER BY created_at ASC
  `).all(tripId);

  const conversationMessages = contextRows.map((r) => ({
    role: r.role,
    content: r.content,
  }));

  // persistTurn — invoked once when the model turn completes, before the proposal/done SSE
  // events. Saves the assistant message, and (when the model called the tool) creates the
  // validated + fingerprinted proposal record linked to that message. Returns the proposal
  // SSE payload, or null when there is nothing to propose.
  const persistTurn = async ({ assistantText, operations }) => {
    let messageId = null;
    if (assistantText || operations) {
      const msg = db.prepare(`
        INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
        VALUES (lower(hex(randomblob(16))), ?, NULL, 'assistant', ?, datetime('now'))
        RETURNING id
      `).get(tripId, assistantText || '');
      messageId = msg.id;
    }
    if (!operations) return null;

    const proposal = createProposal({ tripId, userId, messageId, operations });
    return {
      proposalId: proposal.proposalId,
      operations: proposal.operations,
      warnings: proposal.warnings,
      status: proposal.status,
      statusReason: proposal.statusReason,
    };
  };

  // Query tools the agentic loop (claude.js) may call mid-turn — the route owns what each one
  // actually does (DB/catalogue reads) so claude.js stays DB-free, same pattern as persistTurn.
  const toolExecutors = {
    search_discovery_catalogue: (input) => searchDiscoveryCatalogue(tripDetail, input),
    check_trip_health: (input) => ({ findings: runTripHealthChecks(tripDetail, input || {}) }),
  };

  // Stream response — SSE headers are set inside streamCopilotResponse. Errors during
  // streaming (and inside persistTurn) are handled there; nothing to persist afterwards.
  await streamCopilotResponse(conversationMessages, copilotTripContext(tripDetail), res, req, persistTurn, toolExecutors);
});

// POST /trips/:tripId/copilot/apply — applies a persisted proposal by id (never raw ops)
router.post('/:tripId/copilot/apply', requireTripAccess, async (req, res, next) => {
  try {
    const { tripId } = req.params;
    const userId = req.user.id;
    const { proposalId } = req.body;

    // Wave 2: raw client-authored operations are no longer accepted (fact 2 / D3). The only
    // input is a proposal id the server itself created and validated.
    if (!proposalId || typeof proposalId !== 'string') {
      throw Object.assign(new Error('proposalId is required'), { status: 400 });
    }

    await applyProposal({ tripId, userId, proposalId });

    const updatedDetail = getTripDetail(tripId, userId);
    res.json({ trip: updatedDetail, proposalId, status: 'applied' });
  } catch (error) {
    next(error);
  }
});

// POST /trips/:tripId/copilot/proposals/:id/reject — records an explicit rejection
router.post('/:tripId/copilot/proposals/:id/reject', requireTripAccess, (req, res, next) => {
  try {
    const { tripId, id } = req.params;
    rejectProposal({ tripId, userId: req.user.id, proposalId: id });
    res.json({ ok: true, proposalId: id, status: 'rejected' });
  } catch (error) {
    next(error);
  }
});

export default router;
