// Co-pilot grounding executor (Plan 12 Wave 1, G1/G3/G4/G8). Backs the
// search_discovery_catalogue tool (services/copilotTools.js): the model proposes a
// destination/query/category, and this module answers strictly from what is already
// stored in the discovery catalogue — it never calls Claude directly and the READ
// path here never mints a new discovery_destinations row itself. Wave 2 (G3) adds
// the background-generation kick: when the catalogue for an in-scope destination is
// empty or stale, this module fires runCatalogueGeneration in the background (never
// awaited by the search) and answers with whatever it already has plus a
// 'generating'/'generation_capped' state — it never lets the model see raw
// 'empty'/'stale' anymore. Row creation for the kick's own destination is legitimately
// generation's job (getOrCreateDestination), not a violation of the read path staying
// read-only for every OTHER outcome ('fresh', 'out_of_scope', 'generation_capped').
import { getDb } from '../db/database.js';
import {
  findDestination,
  getOrCreateDestination,
  listActivePlaces,
  listCountryCodedRows,
  getDailyGenerationCount,
  MAX_GENERATIONS_PER_DESTINATION_PER_DAY,
  CACHE_TTL_MS,
  cacheTimestampToEpochMs,
} from '../db/discoveryCatalogue.js';
import { runCatalogueGeneration } from './discoveryGeneration.js';
import { rankPlaces, buildFitLine } from './discoveryRank.js';
import { buildTripScopes, listTripScopes } from './trips.js';
import { scopesMatch } from '../utils/geoIdentity.js';
import { countryNameFromCode } from '../utils/countries.js';

// Destinations with a background generation currently in flight, keyed
// `${cityKey}|${countryCode}` — guards against firing a second kick for the
// same destination while one is already running (concurrent searches for the
// same empty/stale city within a turn, or across turns before the first kick
// finishes). Cleared in the kick's `finally`, regardless of success/failure.
const inFlightGenerationKeys = new Set();

// Test-only escape hatch: vitest's module registry is shared across test
// files unless explicitly reset, so a kick left in-flight (or a key never
// cleared because its promise is still pending at test end) would otherwise
// leak between tests.
export function resetInFlightGenerations() {
  inFlightGenerationKeys.clear();
}

// Fires the exact generation pipeline routes/discovery.js's /discover handler
// uses (via services/discoveryGeneration.js), detached from the search call
// that triggered it — the SSE-less co-pilot turn must never await this. Errors
// are logged, never thrown back at anything, since nothing is awaiting.
function kickBackgroundGeneration(db, { cityKey, countryCode, label, useExclusions }) {
  const key = `${cityKey}|${countryCode}`;
  if (inFlightGenerationKeys.has(key)) return;
  inFlightGenerationKeys.add(key);

  (async () => {
    // Row creation is legitimately generation's job (see module header) — the
    // kick is the one place in this file allowed to mint a destination row.
    const destinationRow = getOrCreateDestination(db, {
      cityKey,
      countryCode,
      displayName: label,
    });

    // Mirrors routes/discovery.js's claudeDestination composition exactly: country
    // context (when known) is composed into the STRING sent to Claude only.
    const claudeDestination = countryCode
      ? `${label}, ${countryNameFromCode(countryCode)} (${countryCode})`
      : label.trim().toLowerCase();

    await runCatalogueGeneration(db, {
      destinationRow,
      claudeDestination,
      useExclusions,
      onCategory: undefined,
    });
  })()
    .catch((err) => {
      console.error(
        '[copilotGrounding] background generation failed destination=%s: %s',
        key, err.message,
      );
    })
    .finally(() => inFlightGenerationKeys.delete(key));
}

// Maps a stored, active discovery_places row into the bounded G8 compact shape the
// model sees: no lat/lng, no photo fields — just enough to talk about and reference
// a real place. tripDetail is the exact getTripDetail() return shape.
function toCompactPlace(row, prefs) {
  return {
    placeId: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    whyGo: row.why_go,
    duration: row.estimated_duration,
    openingHours: row.opening_hours,
    provenance: row.provenance,
    fitLine: buildFitLine(row, prefs),
  };
}

export async function searchDiscoveryCatalogue(tripDetail, input) {
  const { trip, days } = tripDetail;
  const destinationQuery = String(input?.destination ?? '').trim();

  const db = getDb();

  // Resolve the free-text destination against this trip's own scopes (stored
  // trip_scopes rows plus any day-derived label buildTripScopes appends). Anything
  // that doesn't match a scope is out of scope for this trip — no catalogue read,
  // no row creation (G4).
  const storedScopes = listTripScopes(trip.id);
  const scopes = buildTripScopes(days, storedScopes);
  const matchedScope = scopes.find((scope) => scopesMatch(scope.label, destinationQuery));

  if (!matchedScope) {
    return { catalogueState: 'out_of_scope', places: [] };
  }

  // buildTripScopes only carries {label, canonicalKey, boundsJson} forward — it
  // deliberately drops countryCode (see trips.js). Look the match back up in the
  // raw listTripScopes result (by canonicalKey) to recover it: a stored scope
  // carries a real countryCode, a day-derived scope (appended by buildTripScopes,
  // never present in storedScopes) has none.
  const storedMatch = storedScopes.find((scope) => scope.canonicalKey === matchedScope.canonicalKey);
  let countryCode = storedMatch?.countryCode ?? '';

  // Same country-fallback idiom as routes/discovery.js's D6 guard: an
  // empty-countryCode scope adopts the single existing country-coded catalogue
  // row for this city key, but only when exactly one such row exists — zero or
  // multiple stays at the ''-bucket, never guessed at.
  if (countryCode === '') {
    const countryCodedRows = listCountryCodedRows(db, matchedScope.canonicalKey);
    if (countryCodedRows.length === 1) {
      countryCode = countryCodedRows[0].country_code;
    }
  }

  // A destination with NO row has, by construction, had zero generations today —
  // it can never be capped. Only a row that exists gets a real freshness/daily-count
  // read; everything below defaults activeRows/cacheIsFresh/dailyCount to the "never
  // generated" values when there's no row at all.
  const destinationRow = findDestination(db, matchedScope.canonicalKey, countryCode);

  let activeRows = [];
  let cacheIsFresh = false;
  let dailyGenerationCount = 0;
  if (destinationRow) {
    activeRows = listActivePlaces(db, destinationRow.id);
    const lastGeneratedAtMs = cacheTimestampToEpochMs(destinationRow.last_generated_at);
    cacheIsFresh = activeRows.length > 0 && lastGeneratedAtMs !== null
      ? (Date.now() - lastGeneratedAtMs) < CACHE_TTL_MS
      : false;
    dailyGenerationCount = getDailyGenerationCount(db, destinationRow.id);
  }

  // G3 (Wave 2, owner decision): the model never sees raw 'empty'/'stale' — both
  // resolve to either 'generation_capped' (today's generation budget for this
  // destination is spent — no kick fires) or 'generating' (a background kick just
  // fired, or one for this same destination was already in flight). Both still
  // return whatever the stale catalogue had; 'generation_capped' with no row is
  // impossible per the invariant above.
  let catalogueState;
  if (cacheIsFresh) {
    catalogueState = 'fresh';
  } else if (dailyGenerationCount >= MAX_GENERATIONS_PER_DESTINATION_PER_DAY) {
    catalogueState = 'generation_capped';
  } else {
    catalogueState = 'generating';
    kickBackgroundGeneration(db, {
      cityKey: matchedScope.canonicalKey,
      countryCode,
      label: matchedScope.label,
      // Stale (some active places already stored) uses merge/exclusion semantics
      // like the route's stale-refresh path; empty (no row, or a row with zero
      // active places) has nothing to exclude yet.
      useExclusions: activeRows.length > 0,
    });
  }

  if (activeRows.length === 0) {
    return { catalogueState, places: [] };
  }

  const category = typeof input?.category === 'string' ? input.category : null;
  const query = typeof input?.query === 'string' && input.query.trim()
    ? input.query.trim().toLowerCase()
    : null;

  const filtered = activeRows.filter((row) => {
    if (category && row.category !== category) return false;
    if (query) {
      const aliases = JSON.parse(row.aliases_json || '[]');
      // why_go is part of the haystack deliberately: meal/occasion language ("dinner",
      // "sunset", "rainy day") tends to live there rather than in the description.
      const haystack = [row.name, row.local_name, row.description, row.why_go, ...aliases]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      if (!haystack.some((s) => s.includes(query))) return false;
    }
    return true;
  });

  const prefs = {
    interestTags: trip.interestTags || [],
    pace: trip.pace,
    travellers: trip.travellers,
  };

  const places = rankPlaces(filtered, prefs)
    .slice(0, 8)
    .map((row) => toCompactPlace(row, prefs));

  return { catalogueState, places };
}
