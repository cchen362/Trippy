import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { discoverDestination, normalizeName } from '../services/claude.js';

const router = Router();

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

router.use(requireAuth);

// SQLite datetime('now') writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker,
// but JS `new Date(...)` on that string parses it as LOCAL time — only correct when
// the server process itself runs in UTC. Explicitly mark the string as UTC before
// parsing so the TTL check is correct regardless of the server's TZ. Mirrors the
// same fix already applied to place_resolution_cache (see cacheTimestampToEpochMs
// in services/placeResolver.js).
function cacheTimestampToEpochMs(value) {
  if (!value) return null;
  const text = String(value);
  const iso = /[TZ]/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const epoch = Date.parse(iso);
  return Number.isFinite(epoch) ? epoch : null;
}

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
// Newly merged items are stamped with `generatedAt` (ISO string) so the payload
// records when each batch was added, enabling a future "refreshed N days ago"
// hint without a schema change — existing items keep whatever stamp they already
// carry. Pure function — does not touch the DB. Returns the merged categories array.
export function mergeDiscoveryCategories(existingCategories, newCategories, generatedAt = new Date().toISOString()) {
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
    }).map((item) => ({ ...item, generatedAt }));

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
    const cachedAtMs = cached ? cacheTimestampToEpochMs(cached.fetched_at) : null;
    const cacheIsFresh = cachedAtMs !== null
      ? (Date.now() - cachedAtMs) < CACHE_TTL_MS
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
    // everything already shown (cached items in the GLOBAL cache), then stream
    // ONLY the newly generated items back, merging them into the cache.
    //
    // Note: exclusions here are deliberately NOT built from the requesting trip's
    // stop titles. The global cache is shared across all trips/users — if we fed
    // one trip's itinerary in as exclusions, that trip would permanently shape
    // (and shrink) what every other trip sees for the same destination for the
    // life of the cache row. Trip-owned items are filtered at *display time* on
    // the frontend (normalizeName-based "In trip" matching), not baked into the
    // shared cache. Excluding items already present in the cache itself (below)
    // is a different, correct concern: it's de-duplication for "show more", not
    // per-trip pollution.
    const isAppend = Boolean(more) && Boolean(cached);
    // A stale cache row (TTL expired) that isn't an explicit "show more" request:
    // regenerate and MERGE into the existing row rather than replacing it wholesale,
    // so breadth accumulates across refreshes instead of resetting to whatever one
    // generation happened to return. Also excludes already-cached titles from the
    // Claude call for the same de-duplication reason "show more" does.
    const isStaleRefresh = !more && Boolean(cached) && !cacheIsFresh;
    const isMerge = isAppend || isStaleRefresh;

    // A stale refresh regenerates only a delta (cached titles are excluded), but
    // the client's non-append protocol REPLACES each category it receives — so
    // streaming the delta alone would shrink the visible grid to just-new items
    // while the DB holds the merged breadth. Instead: stream the cached breadth
    // up front (instant full grid), suppress the mid-generation delta chunks
    // (they'd clobber the cached categories), and stream the full merged set
    // once generation completes.
    if (isStaleRefresh) {
      for (const cat of sanitizeDiscoveryCategories(cachedCategories)) {
        write({ type: 'category', category: cat.category, items: cat.items });
      }
    }

    // Cache miss (or append/refresh) — keep connection alive with pings while Claude generates
    const ping = setInterval(() => write({ type: 'thinking' }), 8000);

    try {
      const exclusionTitles = isMerge
        ? (cachedCategories || []).flatMap((cat) => (cat.items || []).map((item) => item.name).filter(Boolean))
        : [];

      const accumulated = await discoverDestination(
        claudeDestination,
        exclusionTitles,
        (categoryObj) => {
          if (isStaleRefresh) return;
          const sanitizedCategory = sanitizeDiscoveryCategory(categoryObj);
          write({ type: 'category', ...sanitizedCategory, ...(isAppend ? { append: true } : {}) });
        },
      );
      const sanitized = sanitizeDiscoveryCategories(accumulated);

      clearInterval(ping);

      const generatedAt = new Date().toISOString();

      if (isMerge) {
        const merged = mergeDiscoveryCategories(cachedCategories, sanitized, generatedAt);
        db.prepare(`
          UPDATE global_discovery_cache SET result_json = ?, fetched_at = datetime('now')
          WHERE destination = ?
        `).run(JSON.stringify(merged), cacheKey);
        if (isStaleRefresh) {
          for (const cat of sanitizeDiscoveryCategories(merged)) {
            write({ type: 'category', category: cat.category, items: cat.items });
          }
        }
      } else if (sanitized.length > 0) {
        const stamped = sanitized.map((cat) => ({
          ...cat,
          items: (cat.items || []).map((item) => ({ ...item, generatedAt })),
        }));
        db.prepare(`
          INSERT OR REPLACE INTO global_discovery_cache (destination, result_json, fetched_at)
          VALUES (?, ?, datetime('now'))
        `).run(cacheKey, JSON.stringify(stamped));
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
