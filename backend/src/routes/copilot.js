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

const COPILOT_TABS = new Set(['today', 'plan', 'logistics', 'map', 'discovery']);
const MAX_DISCOVERY_NAME_LENGTH = 160;

function dropContext(reason) {
  console.warn('[copilot] Dropping invalid message context: %s', reason);
  return null;
}

function resolveMessageContext(rawContext, tripDetail) {
  if (rawContext == null) return null;
  if (typeof rawContext !== 'object' || Array.isArray(rawContext)) {
    return dropContext('context must be an object');
  }
  if (!COPILOT_TABS.has(rawContext.tab)) {
    return dropContext('unknown tab');
  }

  const resolved = { tab: rawContext.tab };

  if (rawContext.tab === 'discovery') {
    if (typeof rawContext.discoveryName !== 'string') {
      return dropContext('discoveryName must be a string');
    }
    const discoveryName = rawContext.discoveryName.trim();
    if (!discoveryName) return dropContext('discoveryName must not be empty');
    if (discoveryName.length > MAX_DISCOVERY_NAME_LENGTH) {
      return dropContext('discoveryName is too long');
    }
    if (/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(discoveryName)) {
      return dropContext('discoveryName must be a single line without control characters');
    }
    resolved.discoveryName = discoveryName;
    return resolved;
  }

  if (rawContext.dayId != null) {
    if (typeof rawContext.dayId !== 'string') return dropContext('dayId must be a string');
    const dayIndex = tripDetail.days.findIndex((day) => day.id === rawContext.dayId);
    if (dayIndex === -1) return dropContext('dayId does not belong to trip');
    const day = tripDetail.days[dayIndex];
    resolved.dayId = day.id;
    resolved.dayNumber = dayIndex + 1;
    resolved.dayCity = day.resolvedCity ?? day.city ?? null;
  }

  if (rawContext.stopId != null) {
    if (typeof rawContext.stopId !== 'string') return dropContext('stopId must be a string');
    const stop = tripDetail.days
      .flatMap((day) => day.stops || [])
      .find((candidate) => candidate.id === rawContext.stopId);
    if (!stop) return dropContext('stopId does not belong to trip');
    resolved.stopId = stop.id;
    resolved.stopName = stop.title;
  }

  return resolved;
}

function contextLine(context) {
  if (context.tab === 'discovery') {
    return `[Viewing: Discovery, suggestion "${context.discoveryName}"]`;
  }
  const tabLabel = context.tab[0].toUpperCase() + context.tab.slice(1);
  const parts = [`${tabLabel} tab`];
  if (context.dayNumber) {
    parts.push(`Day ${context.dayNumber}${context.dayCity ? ` (${context.dayCity})` : ''}`);
  }
  if (context.stopName) parts.push(`stop "${context.stopName}"`);
  return `[Viewing: ${parts.join(', ')}]`;
}

function parseStoredContext(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error('[copilot] Could not parse stored message context:', error);
    return null;
  }
}

router.use(requireAuth);

// GET /trips/:tripId/copilot/history
router.get('/:tripId/copilot/history', requireTripAccess, (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, role, content, context_json, created_at, author_name FROM (
        SELECT cm.id, cm.role, cm.content, cm.context_json, cm.created_at,
          u.display_name AS author_name
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
        context: parseStoredContext(r.context_json),
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

  const messageContext = resolveMessageContext(req.body.context, tripDetail);

  // Now save the user message (trip access confirmed above)
  db.prepare(`
    INSERT INTO copilot_messages (id, trip_id, user_id, role, content, context_json, created_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, 'user', ?, ?, datetime('now'))
  `).run(tripId, userId, req.body.message, messageContext ? JSON.stringify(messageContext) : null);

  // Load the most recent 20 messages for conversation context, re-ordered chronologically
  const contextRows = db.prepare(`
    SELECT role, content, context_json FROM (
      SELECT role, content, context_json, created_at FROM copilot_messages
      WHERE trip_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    ) ORDER BY created_at ASC
  `).all(tripId);

  const conversationMessages = contextRows.map((r) => {
    const storedContext = r.role === 'user' ? parseStoredContext(r.context_json) : null;
    return {
      role: r.role,
      content: storedContext ? `${contextLine(storedContext)}\n\n${r.content}` : r.content,
    };
  });

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
