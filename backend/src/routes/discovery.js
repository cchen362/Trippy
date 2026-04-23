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

    const rawTags = interestTags ?? JSON.parse(req.trip.interest_tags || '[]');
    const tags = Array.isArray(rawTags) ? rawTags : [];

    const hash = createHash('sha256')
      .update(JSON.stringify([destination.toLowerCase(), ...[...tags].sort()]))
      .digest('hex');

    const db = getDb();

    const cached = db.prepare(`
      SELECT * FROM discovery_cache
      WHERE trip_id = ? AND destination = ? AND interest_hash = ?
    `).get(req.params.tripId, destination, hash);

    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      if (ageMs < 48 * 60 * 60 * 1000) {
        return res.json({ discovery: { ...JSON.parse(cached.result_json), cached: true } });
      }
    }

    const { results, source } = await discoverDestination(
      destination,
      tags,
      req.trip.pace,
      req.trip.travellers,
    );

    db.prepare(`
      INSERT OR REPLACE INTO discovery_cache (id, trip_id, destination, interest_hash, result_json, fetched_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
    `).run(req.params.tripId, destination, hash, JSON.stringify({ results, source }));

    res.json({ discovery: { results, source, cached: false } });
  } catch (err) {
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
