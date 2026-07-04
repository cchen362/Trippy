import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { discoverDestination, normalizeName } from '../services/claude.js';

const router = Router();

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

router.use(requireAuth);

function sanitizeDiscoveryCategory(categoryObj) {
  return {
    ...categoryObj,
    items: (categoryObj.items || []).map((item) => ({
      ...item,
      lat: null,
      lng: null,
    })),
  };
}

function sanitizeDiscoveryCategories(categories) {
  return (categories || []).map(sanitizeDiscoveryCategory);
}

// Merges freshly-generated categories into a cached category list, appending new
// items to their matching category (creating the category if it didn't exist yet)
// and de-duplicating by the same normalizeName logic discoverDestination uses.
// Pure function — does not touch the DB. Returns the merged categories array.
export function mergeDiscoveryCategories(existingCategories, newCategories) {
  const merged = (existingCategories || []).map((cat) => ({
    category: cat.category,
    items: [...(cat.items || [])],
  }));

  const seen = new Set();
  for (const cat of merged) {
    for (const item of cat.items) {
      if (item?.name) seen.add(normalizeName(item.name));
    }
  }

  for (const newCat of (newCategories || [])) {
    const dedupedNewItems = (newCat.items || []).filter((item) => {
      if (!item?.name) return false;
      const n = normalizeName(item.name);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });

    if (dedupedNewItems.length === 0) continue;

    const existing = merged.find((c) => c.category === newCat.category);
    if (existing) {
      existing.items = [...existing.items, ...dedupedNewItems];
    } else {
      merged.push({ category: newCat.category, items: dedupedNewItems });
    }
  }

  return merged;
}

router.post('/:tripId/discover', requireTripAccess, async (req, res, next) => {
  try {
    const { destination, more } = req.body;

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

    const cachedCategories = cached ? JSON.parse(cached.result_json) : null;
    const cacheIsFresh = cached
      ? (Date.now() - new Date(cached.fetched_at).getTime()) < CACHE_TTL_MS
      : false;

    if (!more && cached && cacheIsFresh) {
      const categories = sanitizeDiscoveryCategories(cachedCategories);
      for (const cat of categories) {
        write({ type: 'category', category: cat.category, items: cat.items });
      }
      write({ type: 'done', cached: true });
      return res.end();
    }

    // "Show more" against an existing cache row: build the exclusion list from
    // everything already shown (cached items) plus stops already in the trip,
    // then stream ONLY the newly generated items back, merging them into the cache.
    const isAppend = Boolean(more) && Boolean(cached);

    // Cache miss (or append) — keep connection alive with pings while Claude generates
    const ping = setInterval(() => write({ type: 'thinking' }), 8000);

    try {
      const existingStopTitles = db.prepare(`
        SELECT s.title FROM stops s
        JOIN days d ON s.day_id = d.id
        WHERE d.trip_id = ?
      `).all(req.params.tripId).map((r) => r.title);

      const exclusionTitles = isAppend
        ? [
          ...(cachedCategories || []).flatMap((cat) => (cat.items || []).map((item) => item.name).filter(Boolean)),
          ...existingStopTitles,
        ]
        : existingStopTitles;

      const accumulated = await discoverDestination(
        claudeDestination,
        exclusionTitles,
        (categoryObj) => {
          const sanitizedCategory = sanitizeDiscoveryCategory(categoryObj);
          write({ type: 'category', ...sanitizedCategory, ...(isAppend ? { append: true } : {}) });
        },
      );
      const sanitized = sanitizeDiscoveryCategories(accumulated);

      clearInterval(ping);

      if (isAppend) {
        const merged = mergeDiscoveryCategories(cachedCategories, sanitized);
        db.prepare(`
          UPDATE global_discovery_cache SET result_json = ?, fetched_at = datetime('now')
          WHERE destination = ?
        `).run(JSON.stringify(merged), cacheKey);
      } else if (sanitized.length > 0) {
        db.prepare(`
          INSERT OR REPLACE INTO global_discovery_cache (destination, result_json, fetched_at)
          VALUES (?, ?, datetime('now'))
        `).run(cacheKey, JSON.stringify(sanitized));
      }

      write({ type: 'done', cached: false, ...(isAppend ? { append: true } : {}) });
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

export default router;
