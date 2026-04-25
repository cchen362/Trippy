import { Router } from 'express';
import { createHash } from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { discoverDestination } from '../services/claude.js';

const router = Router();

router.use(requireAuth);

router.post('/:tripId/discover', requireTripAccess, async (req, res, next) => {
  try {
    const { destination, interestTags } = req.body;

    if (!destination || typeof destination !== 'string' || !destination.trim()) {
      throw Object.assign(new Error('destination is required'), { status: 400 });
    }

    const normalizedDestination = destination.trim().toLowerCase();
    const rawTags = interestTags ?? JSON.parse(req.trip.interest_tags || '[]');
    // Normalize tags to lowercase for consistent cache keys across capitalisation variants
    const tags = (Array.isArray(rawTags) ? rawTags : []).map((t) => t.toLowerCase().trim());

    const hash = createHash('sha256')
      .update(JSON.stringify([normalizedDestination, ...[...tags].sort()]))
      .digest('hex');

    const db = getDb();

    const cached = db.prepare(`
      SELECT * FROM discovery_cache
      WHERE trip_id = ? AND destination = ? AND interest_hash = ?
    `).get(req.params.tripId, normalizedDestination, hash);

    // SSE headers — used for both cache hits (instant) and cache misses (streamed)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const write = (data) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      if (ageMs < 48 * 60 * 60 * 1000) {
        write({ type: 'results', ...JSON.parse(cached.result_json), cached: true });
        write({ type: 'done' });
        return res.end();
      }
    }

    // Cache miss — keep connection alive with pings while Claude generates
    const ping = setInterval(() => write({ type: 'thinking' }), 8000);

    try {
      // Pass existing stop titles so Claude avoids re-suggesting them
      const existingStopTitles = db.prepare(`
        SELECT s.title FROM stops s
        JOIN days d ON s.day_id = d.id
        WHERE d.trip_id = ?
      `).all(req.params.tripId).map((r) => r.title);

      const { results, source } = await discoverDestination(
        normalizedDestination,
        tags,
        req.trip.pace,
        req.trip.travellers,
        existingStopTitles,
        req.trip.start_date ?? null,
        req.trip.end_date ?? null,
      );

      clearInterval(ping);

      db.prepare(`
        INSERT OR REPLACE INTO discovery_cache (id, trip_id, destination, interest_hash, result_json, fetched_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
      `).run(req.params.tripId, normalizedDestination, hash, JSON.stringify({ results, source }));

      write({ type: 'results', results, source, cached: false });
      write({ type: 'done' });
    } catch (err) {
      clearInterval(ping);
      write({ type: 'error', message: err.message || 'Discovery failed' });
    }

    res.end();
  } catch (err) {
    // If SSE headers already sent we can't use next(err) — write the error and close
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Discovery failed' })}\n\n`);
      return res.end();
    }
    next(err);
  }
});

router.delete('/:tripId/discover/cache', requireTripAccess, (req, res, next) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM discovery_cache WHERE trip_id = ?').run(req.params.tripId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
