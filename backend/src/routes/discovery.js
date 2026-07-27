import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getDb } from '../db/database.js';
import { countryNameFromCode } from '../utils/countries.js';
import { assertTripAccess } from '../services/trips.js';
import { runCatalogueGeneration } from '../services/discoveryGeneration.js';
import { DISCOVERY_CATEGORIES } from '../services/claude.js';
import {
  getOrCreateDestination,
  findDestination,
  listActivePlaces,
  getDailyGenerationCount,
  listCountryCodedRows,
  countActivePlacesByCategory,
  CACHE_TTL_MS,
  CATEGORY_ACTIVE_CAP,
  cacheTimestampToEpochMs,
  MAX_GENERATIONS_PER_DESTINATION_PER_DAY,
} from '../db/discoveryCatalogue.js';
import { rankPlaces, orderCategories, buildFitLine } from '../services/discoveryRank.js';
import { canonicalGeoKey } from '../utils/geoIdentity.js';

const router = Router();

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
    const normalizedCountryCode = countryCode ?? '';

    // db handle has no side effects — obtained early so the country_required guard
    // below (which needs to query the catalogue) can run before it's otherwise
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

    // Plan 26 W4.4: the old D6 single-row country adoption (Plan 9 W5.1) was removed
    // here. It silently set normalizedCountryCode to whichever country-coded row shared
    // this city key, on the theory that one prior row was strong-enough identity evidence
    // about a newly typed label. Per F-26-14 that's wrong: canonicalGeoKey folds homonyms
    // together (a second, genuinely different Georgetown collapses to the same cacheKey
    // as the first), so "one row shares the key" is not proof they're the same place — it
    // silently mis-assigned a country to an unrelated destination. W4.5 below replaces
    // silent adoption with an explicit decline-and-ask, still using the single-row case
    // only as a *suggestion* the user can accept or override.

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

    // Plan 26 W4.5 (F-26-26): never mint a NEW empty-country destination row. A '' bucket
    // can never verify its places — classifyHit in discoveryVerify.js returns
    // 'empty_destination_country' for every hit, so the row is permanently stuck
    // unverified/terminal (production already holds three such rows, one 62 places deep,
    // 0 verified, created 2026-07-27 through ordinary use). Decline honestly and ask the
    // user to confirm a country instead of guessing one (that guess is exactly what W4.4
    // just removed) or silently creating an unverifiable row.
    //
    // Scoped to CREATION only: an empty-country row that already exists keeps serving its
    // existing places untouched — W5.1 is the wave that deletes the three that exist, and
    // blocking reads here would break them before that ships. `findDestination` is the
    // read-only counterpart of getOrCreateDestination, so checking existence never mints
    // the row it's checking for.
    if (normalizedCountryCode === '') {
      const existingEmpty = findDestination(db, cacheKey, '');
      if (!existingEmpty) {
        // Pre-fill only: when exactly one country-coded row already shares this city key,
        // suggest it rather than adopting it (that's the D6 behavior W4.4 removed) — the
        // common case becomes one tap to confirm, but the decision stays the user's.
        const countryCodedRows = listCountryCodedRows(db, cacheKey);
        const suggestedCountryCode = countryCodedRows.length === 1 ? countryCodedRows[0].country_code : null;
        console.error(
          '[discover] country_required city_key=%s suggested=%s',
          cacheKey, suggestedCountryCode,
        );
        write({
          type: 'error',
          code: 'country_required',
          message: `We don't know which country ${destination.trim()} is in — confirm it and we'll start its catalogue.`,
          destination: destination.trim(),
          suggestedCountryCode,
        });
        return res.end();
      }
    }

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

    // W1.5 (F-26-2, F-26-16): "Show more" against a catalogue with no headroom
    // in ANY category would spend a daily generation and a Claude call only to
    // insert rows enforceCategoryCap immediately archives — new rows are always
    // the cap's first victim (score() reduces to exactly -0.75*batch under
    // neutral prefs), so nothing the user asked for would ever become visible.
    // Decline honestly before calling Claude at all, and before touching the
    // daily generation counter. Scoped to "no category anywhere has room"
    // (not per-category) deliberately: a generation still adds real value to
    // whichever categories aren't full, and a per-category decline would need
    // the client to say which category it's viewing, which Q-26-1 defers.
    if (isAppend) {
      const activeCounts = countActivePlacesByCategory(db, destinationRow.id);
      const countByCategory = new Map(activeCounts.map((row) => [row.category, row.count]));
      const hasHeadroom = DISCOVERY_CATEGORIES.some(
        (category) => (countByCategory.get(category) ?? 0) < CATEGORY_ACTIVE_CAP,
      );
      if (!hasHeadroom) {
        console.error(
          '[discover] catalogue_full destination=%s',
          destinationRow.id,
        );
        write({
          type: 'error',
          code: 'catalogue_full',
          message: "Every category here is already full. There's nothing new to surface right now — try again once some of these places have had time to prove themselves.",
        });
        return res.end();
      }
    }

    // A stale refresh regenerates only a delta (stored names are excluded), but
    // the client's non-append protocol REPLACES each category it receives.
    // Streaming the stored breadth up front keeps the grid instant while
    // generation runs — the alternative is a blank screen until the first
    // category lands, which is a worse experience than briefly showing what's
    // already known to be there.
    if (isStaleRefresh) {
      for (const cat of groupPlaceRowsByCategory(activeRows, prefs)) {
        write({ type: 'category', category: cat.category, items: cat.items });
      }
    }

    // Cache miss (or append/refresh) — keep connection alive with pings while Claude generates
    const ping = setInterval(() => write({ type: 'thinking' }), 8000);

    try {
      await runCatalogueGeneration(db, {
        destinationRow,
        claudeDestination,
        useExclusions: isMerge,
        // W1.4 (Q-26-2): runCatalogueGeneration now inserts/caps/enqueues per
        // category BEFORE calling this back, so `inserted` here is already a
        // set of real, persisted discovery_places rows (id/provenance/batch
        // all real) — not raw Claude items (F-26-11). That's what makes it
        // safe to stream live on every path, restoring progressive reveal on
        // the merge paths Plan 7 §1.4 had traded away.
        onCategory: ({ category, inserted }) => {
          if (isStaleRefresh) {
            // The client replaces the whole category on every chunk, so
            // stream the MERGED set (stored + this generation's new rows for
            // this category), re-read from the DB, rather than the delta
            // alone — a delta-only chunk would shrink the visible grid to
            // just what's new while the DB holds the full breadth.
            const mergedRows = listActivePlaces(db, destinationRow.id)
              .filter((row) => row.category === category);
            const [merged] = groupPlaceRowsByCategory(mergedRows, prefs);
            if (merged) write({ type: 'category', category: merged.category, items: merged.items });
            return;
          }

          // True cache-miss and append both stream only the rows just
          // inserted for this category — but enforceCategoryCap (already run
          // for this category by the time this fires) may have archived one
          // of them as category surplus, so recheck status rather than
          // trusting insertPlaces's return snapshot.
          // ORDER BY id is load-bearing, not decoration: rankPlaces is a stable
          // sort, so score ties fall back to the input order and that order is
          // meant to be generation order (services/discoveryRank.js) — leaving
          // it to whatever order `IN (...)` happens to return would make tie
          // ordering an implementation detail of SQLite.
          const insertedIds = inserted.map((row) => row.id);
          const stillActive = insertedIds.length
            ? db.prepare(`
                SELECT * FROM discovery_places
                WHERE status = 'active' AND id IN (${insertedIds.map(() => '?').join(',')})
                ORDER BY id
              `).all(...insertedIds)
            : [];
          if (stillActive.length === 0) return;
          const [ranked] = groupPlaceRowsByCategory(stillActive, prefs);
          if (!ranked) return;
          write({
            type: 'category',
            category: ranked.category,
            items: ranked.items,
            ...(isAppend ? { append: true } : {}),
          });
        },
      });

      clearInterval(ping);
      // Every path already streamed its final per-category state live from
      // the onCategory callback above (true miss, append) or up front plus
      // live merges (stale refresh) — nothing left to re-read/re-stream here.

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
          // Stale-refresh already streamed the stored breadth up front. A
          // true cache-miss/append path may already have streamed some
          // categories live (W1.4 — onCategory now fires per completed
          // category, so a mid-generation throw can leave some categories
          // already sent). Re-streaming the full current active set here is
          // harmless rather than wrong: the client replaces a category
          // outright on a plain chunk, and merges/dedupes by name on an
          // append chunk, so a category arriving twice with the same content
          // is a no-op either way — this just guarantees every active
          // category is shown even if generation died before reaching it.
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
