// Background catalogue generation, ahead of anyone opening Discovery. Two callers start one:
//   - the co-pilot's catalogue search (Plan 12 G3, services/copilotGrounding.js), when the
//     destination it searched is empty or stale;
//   - the trip-scope pre-warm (Plan 35 W4, D-35-3, prewarmTripScopes below), when a trip is
//     created or its destination chips are saved.
// Both go through kickBackgroundGeneration, so there is one mechanism: the D-33-1 registry,
// the generation pipeline, and per-category verification are shared and never duplicated.
// The kick lives here rather than in copilotGrounding.js because trips.js calls the pre-warm,
// and copilotGrounding.js imports trips.js; this module imports neither.
import {
  findDestination,
  getOrCreateDestination,
  listActivePlaces,
  getDailyGenerationCount,
  isCatalogueFresh,
  MAX_GENERATIONS_PER_DESTINATION_PER_DAY,
} from '../db/discoveryCatalogue.js';
import { runCatalogueGeneration, getRunningGeneration } from './discoveryGeneration.js';
import { countryNameFromCode } from '../utils/countries.js';

// Fires the exact generation pipeline routes/discovery.js's /discover handler uses (via
// services/discoveryGeneration.js), detached from whatever triggered it: nothing awaits it and
// nothing streams from it. Errors are logged, never thrown back at anything.
//
// Callers decide WHETHER to kick (freshness, the daily cap). "Is this destination already
// generating" is answered here by the shared registry (D-33-1), the same one the /discover
// route consults, so a kick and a Discovery open for the same city never double-generate.
// When one is running the kick simply returns. The registry check and the
// runCatalogueGeneration call sit in one synchronous stretch (no await between them), which
// is what makes check-then-start atomic. Row creation is legitimately generation's job, so
// the kick is allowed to mint the discovery_destinations row.
export function kickBackgroundGeneration(db, { cityKey, countryCode, label, useExclusions }) {
  const key = `${cityKey}|${countryCode}`;

  (async () => {
    const destinationRow = getOrCreateDestination(db, {
      cityKey,
      countryCode,
      displayName: label,
    });

    if (getRunningGeneration(destinationRow.id)) return;

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
  })().catch((err) => {
    console.error(
      '[discoveryPrewarm] background generation failed destination=%s: %s',
      key, err.message,
    );
  });
}

// D-35-3: every stored scope of a trip is warmed when the trip is created or its scopes are
// saved, so a later day's city is ready when the traveller reaches it. Day 1 stays
// pre-warmed by the client on trip load (TripPage.jsx), exactly as before.
//   - a scope with no country code is skipped, never guessed (Plan 26 W4.8: the route's
//     country_required table owns that case, with a human confirming the country);
//   - a destination already fresh, already generating, or at today's daily cap (Plan 7
//     decision 4) is skipped;
//   - everything else is kicked at once, not serially: generation is the slow part, and the
//     Nominatim pacer inside placeResolver.js already serialises verification.
// scopes: listTripScopes() rows ({ label, countryCode, canonicalKey, ... }). Returns the
// `cityKey|countryCode` keys it kicked. Nothing here is awaited and nothing throws back.
export function prewarmTripScopes(db, scopes, { tripId } = {}) {
  const kicked = [];
  const seen = new Set();

  for (const scope of scopes || []) {
    const cityKey = scope.canonicalKey;
    const countryCode = scope.countryCode || '';
    if (!cityKey || !countryCode) continue;

    const key = `${cityKey}|${countryCode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A destination with no row has never generated: not fresh, not running, not capped.
    const destinationRow = findDestination(db, cityKey, countryCode);
    let activeCount = 0;
    if (destinationRow) {
      activeCount = listActivePlaces(db, destinationRow.id).length;
      if (isCatalogueFresh(destinationRow, activeCount)) continue;
      if (getRunningGeneration(destinationRow.id)) continue;
      if (getDailyGenerationCount(db, destinationRow.id) >= MAX_GENERATIONS_PER_DESTINATION_PER_DAY) continue;
    }

    console.log(
      '[discoveryPrewarm] kick trip=%s destination=%s label=%s merge=%s',
      tripId ?? '-', key, scope.label, activeCount > 0,
    );
    // D-35-3: the kick site. Stale (active places stored) generates with exclusions and
    // merges, like the route's stale refresh; a never-generated scope has nothing to exclude.
    kickBackgroundGeneration(db, {
      cityKey,
      countryCode,
      label: scope.label,
      useExclusions: activeCount > 0,
    });
    kicked.push(key);
  }

  return kicked;
}
