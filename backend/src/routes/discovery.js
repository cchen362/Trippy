import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { discoverDestination } from '../services/claude.js';
import { countryNameFromCode } from '../utils/countries.js';
import {
  getOrCreateDestination,
  listActivePlaces,
  insertPlaces,
  listExclusionNames,
} from '../db/discoveryCatalogue.js';

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

// Serializes a stored discovery_places row back into the wire item shape old
// and new clients both understand. lat/lng are forced null at serialize time
// even though insertPlaces already never stores a non-null value — belt and
// suspenders per the spec's "model coords are never shown" rule.
function serializePlaceRow(row) {
  return {
    name: row.name,
    description: row.description,
    whyItFits: row.why_go,
    estimatedDuration: row.estimated_duration,
    openingHours: row.opening_hours,
    localName: row.local_name,
    aliases: JSON.parse(row.aliases_json || '[]'),
    lat: null,
    lng: null,
    generatedAt: row.generated_at,
  };
}

// Groups active place rows (already ordered by category, id from
// listActivePlaces) into the {category, items} wire shape the SSE contract
// expects, preserving category order of first appearance.
function groupPlaceRowsByCategory(rows) {
  const order = [];
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) {
      byCategory.set(row.category, []);
      order.push(row.category);
    }
    byCategory.get(row.category).push(serializePlaceRow(row));
  }
  return order.map((category) => ({ category, items: byCategory.get(category) }));
}

router.post('/:tripId/discover', requireTripAccess, async (req, res, next) => {
  try {
    const { destination, more, countryCode } = req.body;

    if (!destination || typeof destination !== 'string' || !destination.trim()) {
      throw Object.assign(new Error('destination is required'), { status: 400 });
    }

    if (countryCode !== undefined && countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
      throw Object.assign(new Error('countryCode must be a 2-letter uppercase code'), { status: 400 });
    }
    const normalizedCountryCode = countryCode ?? '';

    // claudeDestination: human-readable, sent to Claude ("cheng du", "xi'an")
    // cacheKey: maximally normalized for DB matching ("chengdu", "xian") — this
    // stays uncomposed with country even when countryCode is known, so the DB
    // key (and therefore the destination row identity) never changes shape.
    const claudeDestinationBase = destination.trim().toLowerCase();
    const cacheKey = claudeDestinationBase
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[\s'''\-\.]/g, '');

    // When the country is known, disambiguate homonym cities (e.g. Chengdu,
    // multiple Georgetowns) by composing it into the STRING sent to Claude
    // only — discoverDestination's signature is untouched (backward
    // compatible with existing callers/tests) per the spec's explicit
    // guidance to keep the country context purely a route-side concern.
    const countryDisplayName = normalizedCountryCode
      ? countryNameFromCode(normalizedCountryCode)
      : null;
    const claudeDestination = countryDisplayName
      ? `${destination.trim()}, ${countryDisplayName} (${normalizedCountryCode})`
      : claudeDestinationBase;

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

    // Always get-or-create the destination row — this is the persistent,
    // global (non-trip-specific) catalogue entry for this city/country pair.
    const destinationRow = getOrCreateDestination(db, {
      cityKey: cacheKey,
      countryCode: normalizedCountryCode,
      displayName: destination.trim(),
    });

    const activeRows = listActivePlaces(db, destinationRow.id);
    const hasActivePlaces = activeRows.length > 0;
    const lastGeneratedAtMs = cacheTimestampToEpochMs(destinationRow.last_generated_at);
    const cacheIsFresh = hasActivePlaces && lastGeneratedAtMs !== null
      ? (Date.now() - lastGeneratedAtMs) < CACHE_TTL_MS
      : false;

    if (!more && hasActivePlaces && cacheIsFresh) {
      for (const cat of groupPlaceRowsByCategory(activeRows)) {
        write({ type: 'category', category: cat.category, items: cat.items });
      }
      write({ type: 'done', cached: true });
      return res.end();
    }

    // "Show more" against an existing catalogue: build the exclusion list from
    // everything already stored (this destination's own places), then stream
    // ONLY the newly generated items back, inserting them into the catalogue.
    //
    // Note: exclusions here are deliberately NOT built from the requesting trip's
    // stop titles. The catalogue is shared across all trips/users — if we fed
    // one trip's itinerary in as exclusions, that trip would permanently shape
    // (and shrink) what every other trip sees for the same destination for the
    // life of the catalogue. Trip-owned items are filtered at *display time* on
    // the frontend (normalizeName-based "In trip" matching), not baked into the
    // shared catalogue. Excluding items already present in the catalogue itself
    // (below) is a different, correct concern: it's de-duplication for "show
    // more", not per-trip pollution.
    const isAppend = Boolean(more) && hasActivePlaces;
    // A stale catalogue (TTL expired) that isn't an explicit "show more" request:
    // regenerate and ADD to the existing catalogue rather than replacing it
    // wholesale, so breadth accumulates across refreshes instead of resetting to
    // whatever one generation happened to return. Also excludes already-stored
    // names from the Claude call for the same de-duplication reason "show more" does.
    const isStaleRefresh = !more && hasActivePlaces && !cacheIsFresh;
    const isMerge = isAppend || isStaleRefresh;

    // A stale refresh regenerates only a delta (stored names are excluded), but
    // the client's non-append protocol REPLACES each category it receives — so
    // streaming the delta alone would shrink the visible grid to just-new items
    // while the DB holds the merged breadth. Instead: stream the stored breadth
    // up front (instant full grid), suppress the mid-generation delta chunks
    // (they'd clobber the stored categories), and stream the full merged set
    // (re-read from the DB) once generation completes.
    if (isStaleRefresh) {
      for (const cat of groupPlaceRowsByCategory(activeRows)) {
        write({ type: 'category', category: cat.category, items: cat.items });
      }
    }

    // Cache miss (or append/refresh) — keep connection alive with pings while Claude generates
    const ping = setInterval(() => write({ type: 'thinking' }), 8000);

    try {
      const exclusionTitles = isMerge
        ? listExclusionNames(db, destinationRow.id, 400)
        : [];

      const accumulated = await discoverDestination(
        claudeDestination,
        exclusionTitles,
        (categoryObj) => {
          // Both stale-refresh and append stream their post-insert, DB-derived
          // result once generation completes (see below) rather than the raw
          // mid-generation delta — a raw delta could contain items insertPlaces
          // will end up skipping as duplicates, which would desync what the
          // client displays from what's actually stored. Only a true cache-miss
          // (neither merge path) streams live as categories complete.
          if (isMerge) return;
          write({
            type: 'category',
            category: categoryObj.category,
            items: (categoryObj.items || []).map((item) => ({ ...item, lat: null, lng: null })),
          });
        },
      );

      clearInterval(ping);

      const generatedAt = new Date().toISOString();
      // Batch number for this generation: the destination's generation_count
      // BEFORE it's incremented below — first generation is batch 0 (matching
      // the Wave-1 backfill migration's batch=0 for pre-existing data), second
      // generation is batch 1, etc. This gives Wave 3's future recency-based
      // ranking a monotonically increasing "how recent is this batch" signal
      // without needing to build ranking now.
      const batch = destinationRow.generation_count;

      const flatItems = (accumulated || []).flatMap((cat) =>
        (cat.items || []).map((item) => ({ ...item, category: cat.category, generatedAt })),
      );
      const inserted = insertPlaces(db, destinationRow.id, flatItems, batch);

      db.prepare(`
        UPDATE discovery_destinations
        SET last_generated_at = datetime('now'), generation_count = generation_count + 1
        WHERE id = ?
      `).run(destinationRow.id);

      if (isStaleRefresh) {
        // Re-read the full (now-merged) active set and stream it so the
        // client's replace-per-category protocol ends up showing the union.
        const mergedRows = listActivePlaces(db, destinationRow.id);
        for (const cat of groupPlaceRowsByCategory(mergedRows)) {
          write({ type: 'category', category: cat.category, items: cat.items });
        }
      } else if (isAppend) {
        // Stream only the newly inserted items, grouped by category.
        for (const cat of groupPlaceRowsByCategory(inserted)) {
          write({ type: 'category', category: cat.category, items: cat.items, append: true });
        }
      }
      // True cache-miss (no isMerge): mid-generation deltas were already
      // streamed live from the onCategory callback above — nothing more to
      // stream here.

      write({ type: 'done', cached: false, ...(isAppend ? { append: true } : {}) });
    } catch (err) {
      clearInterval(ping);

      // Generation failed. If this destination already has a stored
      // catalogue, degrade gracefully: serve what's already there instead of
      // erroring out from under the user. Only surface an error when there
      // is truly nothing to show.
      const fallbackRows = listActivePlaces(db, destinationRow.id);
      if (fallbackRows.length > 0) {
        console.error('[discover] generation failed, serving existing catalogue:', err.message);
        if (!isStaleRefresh) {
          // Stale-refresh already streamed the stored breadth up front; a
          // true cache-miss/append path has not streamed anything yet.
          for (const cat of groupPlaceRowsByCategory(fallbackRows)) {
            write({ type: 'category', category: cat.category, items: cat.items });
          }
        }
        write({ type: 'done', cached: true, generationFailed: true });
      } else {
        console.error('[discover] generation failed, no existing catalogue:', err.message);
        write({ type: 'error', message: err.message || 'Discovery failed' });
      }
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
