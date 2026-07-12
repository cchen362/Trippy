import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { discoverDestination } from '../services/claude.js';
import { countryNameFromCode } from '../utils/countries.js';
import { assertTripAccess } from '../services/trips.js';
import { enqueueForVerification } from '../services/discoveryVerify.js';
import {
  getOrCreateDestination,
  listActivePlaces,
  insertPlaces,
  listExclusionNames,
  enforceCategoryCap,
  getDailyGenerationCount,
  incrementDailyGenerationCount,
  listCountryCodedRows,
  CACHE_TTL_MS,
  cacheTimestampToEpochMs,
} from '../db/discoveryCatalogue.js';
import { rankPlaces, orderCategories, buildFitLine } from '../services/discoveryRank.js';
import { canonicalGeoKey } from '../utils/geoIdentity.js';

const router = Router();

const MAX_GENERATIONS_PER_DESTINATION_PER_DAY = 3;

router.use(requireAuth);

// Serializes a stored discovery_places row back into the wire item shape old
// and new clients both understand, plus the new Wave 3 additive fields.
// lat/lng are only surfaced for verified rows (real resolver coordinates) —
// unverified/pending rows still get null/null, replacing the previous
// blanket-null behavior that predated verification.
function serializePlaceRow(row, prefs) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    whyItFits: row.why_go,
    estimatedDuration: row.estimated_duration,
    openingHours: row.opening_hours,
    localName: row.local_name,
    aliases: JSON.parse(row.aliases_json || '[]'),
    photoQuery: row.photo_query || null,
    sceneType: row.scene_type || null,
    lat: row.provenance === 'verified' ? row.lat : null,
    lng: row.provenance === 'verified' ? row.lng : null,
    generatedAt: row.generated_at,
    whyGo: row.why_go,
    provenance: row.provenance,
    batch: row.batch,
    placeRef: row.provider_place_id,
    fitLine: buildFitLine(row, prefs),
  };
}

// Groups active place rows (already ordered by category, id from
// listActivePlaces — i.e. generation order) into the {category, items} wire
// shape the SSE contract expects. Category order comes from orderCategories
// (essentials, then interest-tag order, then the rest, family demotes
// nightlife) and items within each category are ranked by score(item, prefs)
// via rankPlaces before serialization.
function groupPlaceRowsByCategory(rows, prefs) {
  const categoriesPresent = [];
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) {
      byCategory.set(row.category, []);
      categoriesPresent.push(row.category);
    }
    byCategory.get(row.category).push(row);
  }

  const orderedCategories = orderCategories(categoriesPresent, prefs);
  return orderedCategories.map((category) => ({
    category,
    items: rankPlaces(byCategory.get(category), prefs).map((row) => serializePlaceRow(row, prefs)),
  }));
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
    let normalizedCountryCode = countryCode ?? '';

    // db handle has no side effects — obtained early so the D6 guard below
    // (which needs to query the catalogue) can run before it's otherwise
    // needed for getOrCreateDestination.
    const db = getDb();

    // Trip-fit preferences (Wave 3): computed once per request from the
    // access-checked trip row (req.trip, set by requireTripAccess). Never
    // written back to the shared catalogue — the global catalogue owns
    // place facts, the trip owns fit (review doc §5).
    const prefs = {
      interestTags: JSON.parse(req.trip.interest_tags || '[]'),
      pace: req.trip.pace,
      travellers: req.trip.travellers,
    };

    // claudeDestination: human-readable, sent to Claude ("cheng du", "xi'an")
    // cacheKey: maximally normalized for DB matching ("chengdu", "xian") via the
    // shared canonicalGeoKey util (Plan 8, utils/geoIdentity.js) — this stays
    // uncomposed with country even when countryCode is known, so the DB key
    // (and therefore the destination row identity) never changes shape.
    const claudeDestinationBase = destination.trim().toLowerCase();
    const cacheKey = canonicalGeoKey(destination);

    // D6 (Plan 9 W5.1): an EMPTY-countryCode Discovery request reuses the
    // single existing country-coded catalogue row for the same city key,
    // instead of minting a fresh ''-bucket twin (the bug that recreated the
    // kualalumpur|'' row on 2026-07-09, since the KL trip's days.city_country
    // is NULL). Zero or multiple country-coded rows keep today's ''-bucket
    // behavior exactly — multiple is genuinely ambiguous and must not be
    // guessed at. Adopting the code here (before getOrCreateDestination)
    // makes it the effective country for the whole request: the catalogue
    // row lookup, the Claude destination-string composition below, and
    // anything else keyed on the request's country.
    if (normalizedCountryCode === '') {
      const countryCodedRows = listCountryCodedRows(db, cacheKey);
      if (countryCodedRows.length === 1) {
        normalizedCountryCode = countryCodedRows[0].country_code;
        console.log(
          '[discovery] country-fallback city_key=%s -> %s',
          cacheKey, normalizedCountryCode,
        );
      }
    }

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
      for (const cat of groupPlaceRowsByCategory(activeRows, prefs)) {
        write({ type: 'category', category: cat.category, items: cat.items });
      }
      write({ type: 'done', cached: true });
      return res.end();
    }

    // Generation limit (Trust criteria, decision 4): every path past the fresh-cache
    // check below is about to trigger a Claude generation. generation_count is a
    // lifetime counter, not a daily one (see discoveryCatalogue.js), so the per-UTC-day
    // count is tracked separately and checked before any generation is attempted.
    const dailyGenerationCount = getDailyGenerationCount(db, destinationRow.id);
    if (dailyGenerationCount >= MAX_GENERATIONS_PER_DESTINATION_PER_DAY) {
      console.error(
        '[discover] generation_limit destination=%s dailyCount=%d',
        destinationRow.id, dailyGenerationCount,
      );
      write({
        type: 'error',
        code: 'generation_limit',
        message: 'This destination has already been refreshed the maximum number of times today. Try again tomorrow.',
      });
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
      for (const cat of groupPlaceRowsByCategory(activeRows, prefs)) {
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
          //
          // Wave 3 note: this callback intentionally is NOT run through
          // rankPlaces/serializePlaceRow. These are raw Claude items that
          // haven't been inserted into discovery_places yet — they have no
          // DB-assigned id, provenance, or batch, so there is nothing for
          // the scorer to rank on. They stream in Claude's own editorial
          // order, which becomes the "generation order" ranking ties fall
          // back to once these same items are re-read from the DB later.
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
      const insertedIds = inserted.map((row) => row.id);

      // Bounds enforcement (decision 4): archive category surplus immediately
      // after insert, using only provenance/batch (Wave 3's real scorer is out of
      // scope here) — verified rows are never archived while an unverified row in
      // the same category could be archived instead, so this is correct regardless
      // of whether the async verification worker below has run yet.
      enforceCategoryCap(db, destinationRow.id);

      // Verification is fire-and-forget: enqueue and move on. It must never block
      // or fail this SSE response — the queue drains after this request completes,
      // isolated from serving (see services/discoveryVerify.js).
      enqueueForVerification(db, destinationRow.id, insertedIds);

      db.prepare(`
        UPDATE discovery_destinations
        SET last_generated_at = datetime('now'), generation_count = generation_count + 1
        WHERE id = ?
      `).run(destinationRow.id);
      incrementDailyGenerationCount(db, destinationRow.id);

      if (isStaleRefresh) {
        // Re-read the full (now-merged) active set and stream it so the
        // client's replace-per-category protocol ends up showing the union.
        const mergedRows = listActivePlaces(db, destinationRow.id);
        for (const cat of groupPlaceRowsByCategory(mergedRows, prefs)) {
          write({ type: 'category', category: cat.category, items: cat.items });
        }
      } else if (isAppend) {
        // Stream only the newly inserted items still active — enforceCategoryCap
        // above may have already archived one of them as category surplus, so
        // re-check status rather than trusting insertPlaces's return snapshot.
        const stillActiveInserted = insertedIds.length
          ? db.prepare(`
              SELECT * FROM discovery_places
              WHERE destination_id = ? AND status = 'active' AND id IN (${insertedIds.map(() => '?').join(',')})
              ORDER BY category, id
            `).all(destinationRow.id, ...insertedIds)
          : [];
        for (const cat of groupPlaceRowsByCategory(stillActiveInserted, prefs)) {
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
          for (const cat of groupPlaceRowsByCategory(fallbackRows, prefs)) {
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

// Report/suppress endpoint (Plan 7 Wave 2, decision 3): report ⇒ immediate global
// suppression + audit log. Mounted separately (at /api/discovery, not /api/trips)
// since the trip identity for the access check arrives in the body, not the URL —
// requireTripAccess (middleware/tripAccess.js) expects req.params.tripId, so the
// access check is done inline here with the same assertTripAccess it wraps.
export const discoveryPlacesRouter = Router();
discoveryPlacesRouter.use(requireAuth);

discoveryPlacesRouter.post('/places/:placeId/report', (req, res, next) => {
  try {
    const { tripId } = req.body || {};
    if (!tripId) {
      throw Object.assign(new Error('tripId is required'), { status: 400 });
    }
    // Throws 404 if the trip doesn't exist or this user has no access to it.
    assertTripAccess(req.user.id, tripId);

    const placeId = Number(req.params.placeId);
    if (!Number.isInteger(placeId)) {
      throw Object.assign(new Error('placeId must be an integer'), { status: 400 });
    }

    const db = getDb();
    const place = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(placeId);
    if (!place) {
      throw Object.assign(new Error('Place not found'), { status: 404 });
    }

    db.prepare(`UPDATE discovery_places SET status = 'suppressed' WHERE id = ?`).run(placeId);

    console.error(
      '[discovery] suppressed place=%s name=%s by user=%s trip=%s',
      placeId, place.name, req.user.id, tripId,
    );

    res.json({ suppressed: true });
  } catch (err) {
    next(err);
  }
});

export default router;
