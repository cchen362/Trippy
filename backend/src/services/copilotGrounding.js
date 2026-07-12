// Read-only co-pilot grounding executor (Plan 12 Wave 1, G1/G3/G4/G8). Backs the
// search_discovery_catalogue tool (services/copilotTools.js): the model proposes a
// destination/query/category, and this module answers strictly from what is already
// stored in the discovery catalogue — it never calls Claude and never mints a new
// discovery_destinations row. Wave 2 adds the background-generation kick that fills
// an empty/stale catalogue after this executor has already answered from what's on
// hand.
import { getDb } from '../db/database.js';
import {
  findDestination,
  listActivePlaces,
  listCountryCodedRows,
  CACHE_TTL_MS,
  cacheTimestampToEpochMs,
} from '../db/discoveryCatalogue.js';
import { rankPlaces, buildFitLine } from './discoveryRank.js';
import { buildTripScopes, listTripScopes } from './trips.js';
import { scopesMatch } from '../utils/geoIdentity.js';

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

  const destinationRow = findDestination(db, matchedScope.canonicalKey, countryCode);
  if (!destinationRow) {
    return { catalogueState: 'empty', places: [] };
  }

  const activeRows = listActivePlaces(db, destinationRow.id);
  const lastGeneratedAtMs = cacheTimestampToEpochMs(destinationRow.last_generated_at);
  const cacheIsFresh = activeRows.length > 0 && lastGeneratedAtMs !== null
    ? (Date.now() - lastGeneratedAtMs) < CACHE_TTL_MS
    : false;

  const catalogueState = activeRows.length === 0 ? 'empty' : (cacheIsFresh ? 'fresh' : 'stale');
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
