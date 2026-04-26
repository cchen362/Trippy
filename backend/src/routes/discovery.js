import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { discoverDestination } from '../services/claude.js';

const router = Router();

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

router.use(requireAuth);

router.post('/:tripId/discover', requireTripAccess, async (req, res, next) => {
  try {
    const { destination } = req.body;

    if (!destination || typeof destination !== 'string' || !destination.trim()) {
      throw Object.assign(new Error('destination is required'), { status: 400 });
    }

    // claudeDestination: human-readable, sent to Claude ("cheng du", "xi'an")
    // cacheKey: maximally normalized for DB matching ("chengdu", "xian")
    const claudeDestination = destination.trim().toLowerCase();
    const cacheKey = claudeDestination
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[\s'''\-\.]/g, '');

    const db = getDb();

    // SSE headers — set before any potential cache hit or miss
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const write = (data) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Check global destination cache (shared across all trips and users)
    const cached = db.prepare(
      'SELECT * FROM global_discovery_cache WHERE destination = ?',
    ).get(cacheKey);

    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      if (ageMs < CACHE_TTL_MS) {
        const categories = JSON.parse(cached.result_json);
        for (const cat of categories) {
          write({ type: 'category', category: cat.category, items: cat.items });
        }
        write({ type: 'done', cached: true });
        return res.end();
      }
    }

    // Cache miss — keep connection alive with pings while Claude generates
    const ping = setInterval(() => write({ type: 'thinking' }), 8000);

    try {
      const existingStopTitles = db.prepare(`
        SELECT s.title FROM stops s
        JOIN days d ON s.day_id = d.id
        WHERE d.trip_id = ?
      `).all(req.params.tripId).map((r) => r.title);

      const accumulated = await discoverDestination(
        claudeDestination,
        existingStopTitles,
        (categoryObj) => write({ type: 'category', ...categoryObj }),
      );

      clearInterval(ping);

      if (accumulated.length > 0) {
        db.prepare(`
          INSERT OR REPLACE INTO global_discovery_cache (destination, result_json, fetched_at)
          VALUES (?, ?, datetime('now'))
        `).run(cacheKey, JSON.stringify(accumulated));
      }

      write({ type: 'done', cached: false });
    } catch (err) {
      clearInterval(ping);
      write({ type: 'error', message: err.message || 'Discovery failed' });
    }

    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Discovery failed' })}\n\n`);
      return res.end();
    }
    next(err);
  }
});

// Clears the global destination cache for a specific destination (used by refresh button)
router.delete('/:tripId/discover/cache', requireTripAccess, (req, res, next) => {
  try {
    const { destination } = req.body;
    const db = getDb();
    if (destination) {
      const key = destination.trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[\s'''\-\.]/g, '');
      db.prepare('DELETE FROM global_discovery_cache WHERE destination = ?').run(key);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
