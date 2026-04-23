import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { getTripDetail, assertDayAccess, assertStopAccess } from '../services/trips.js';
import { createStop, deleteStop, updateStop } from '../services/stops.js';
import { streamCopilotResponse } from '../services/claude.js';

const router = Router();

router.use(requireAuth);

// GET /trips/:tripId/copilot/history
router.get('/:tripId/copilot/history', requireTripAccess, (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM copilot_messages
      WHERE trip_id = ?
      ORDER BY created_at ASC
      LIMIT 50
    `).all(req.params.tripId);

    res.json({
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      })),
    });
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

  // Save user message
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

  // Load full trip detail for itinerary context
  let tripDetail;
  try {
    tripDetail = getTripDetail(tripId, userId);
  } catch (error) {
    return next(error);
  }

  // Stream response — SSE headers are set inside streamCopilotResponse
  // Errors during streaming are handled inside the service (writes error SSE event)
  const fullText = await streamCopilotResponse(conversationMessages, tripDetail, res);

  // Save assistant response after streaming completes
  if (fullText) {
    db.prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
      VALUES (lower(hex(randomblob(16))), ?, NULL, 'assistant', ?, datetime('now'))
    `).run(tripId, fullText);
  }
});

// POST /trips/:tripId/copilot/apply
router.post('/:tripId/copilot/apply', requireTripAccess, async (req, res, next) => {
  try {
    const { tripId } = req.params;
    const userId = req.user.id;
    const { mutation } = req.body;

    if (!mutation || !Array.isArray(mutation.operations)) {
      throw Object.assign(new Error('mutation.operations must be an array'), { status: 400 });
    }

    const db = getDb();
    const ops = mutation.operations;

    // Validate all operations synchronously first — fail fast before modifying anything
    for (const op of ops) {
      if (op.action === 'add_stop') {
        assertDayAccess(userId, op.dayId);
      } else if (op.action === 'remove_stop') {
        assertStopAccess(userId, op.stopId);
      } else if (op.action === 'move_stop') {
        assertStopAccess(userId, op.stopId);
      } else if (op.action === 'update_stop') {
        assertStopAccess(userId, op.stopId);
      }
    }

    // Execute sync operations (remove_stop, move_stop) inside a transaction
    const syncOps = ops.filter((op) => op.action === 'remove_stop' || op.action === 'move_stop');
    if (syncOps.length > 0) {
      const runSyncOps = db.transaction(() => {
        for (const op of syncOps) {
          if (op.action === 'remove_stop') {
            deleteStop(userId, op.stopId);
          } else if (op.action === 'move_stop') {
            db.prepare('UPDATE stops SET day_id = ?, sort_order = ? WHERE id = ?')
              .run(op.toDayId, op.sortOrder ?? 0, op.stopId);
          }
        }
      });
      runSyncOps();
    }

    // Execute async operations (add_stop, update_stop) concurrently outside the transaction
    const addOps = ops.filter((op) => op.action === 'add_stop');
    const updateOps = ops.filter((op) => op.action === 'update_stop');

    await Promise.all([
      ...addOps.map((op) => createStop(userId, op.dayId, op.stop)),
      ...updateOps.map((op) => updateStop(userId, op.stopId, op.fields)),
    ]);

    const updatedDetail = getTripDetail(tripId, userId);
    res.json({ trip: updatedDetail });
  } catch (error) {
    next(error);
  }
});

export default router;
