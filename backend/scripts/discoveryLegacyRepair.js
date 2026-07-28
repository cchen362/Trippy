// Plan 26 W5: one-off operator repair for two pieces of legacy data debt that
// predate this plan's fixes and can never self-heal through ordinary request
// traffic. This script is NOT wired into any request path and never will be
// — like discoveryReverify.js, running it is always an explicit, manual
// operator action against a specific database file.
//
// ---------------------------------------------------------------------------
// W5.1 — delete empty-country destinations (owner decision D-26-3)
// ---------------------------------------------------------------------------
// Three destinations hold country_code = '' — 北京 and 南疆 (the owner's own
// CJK free-text test destinations, D-26-3) plus Suzhou, which F-26-26 caught
// being created through ordinary use before W4.5 closed that path. They were
// the entire justification for F-26-8's "empty destination country no longer
// earns a free pass" narrowing in discoveryVerify.js, and they hold zero
// verified rows, so deleting them costs zero paid provider work.
//
// W5.1 deliberately does NOT try to recover a country for them first. Both
// CJK names are exactly the class F-26-37 caught: with no country bias to
// anchor it, Nominatim resolved 乌镇 (a Zhejiang water town) to a road in
// Kadoma, Osaka, and returned JP at confidence 0.55. A brand-new or
// country-less destination has no bias by construction, so "geocode the
// country, then keep the catalogue" would be running the exact lookup W4
// exists to distrust. Plan 26 W4.5 then closed the path that CREATES a
// shared catalogue destination without a confirmed country, so a live re-scan
// finding a set that has GROWN since the plan was written means W4.5 has a
// hole and must be investigated before any delete runs — this is why the set
// is re-derived from the DB at run time and gated against an explicit
// operator expectation rather than ever hardcoded.
//
// ---------------------------------------------------------------------------
// W5.2 — repair never-checked rows misclassified as "checked and failed"
// ---------------------------------------------------------------------------
// `discovery_places.provenance` has carried three real values since Plan 26
// W1: 'pending' (never checked), 'unverified' (checked, failed — terminal),
// 'verified' (checked, passed). W1.2's insertPlaces fix only changed what
// gets stamped at INSERT time going forward — rows inserted BEFORE that
// deploy still carry a legacy 'unverified' stamp whether or not a check ever
// actually ran against them. enforceCategoryCap's post-W1.2 cap logic reads
// provenance='unverified' as tier-1 "checked and failed, archive first," so
// it archives legacy rows that were simply never looked at — the very defect
// W1.2 exists to prevent, reappearing for data that predates the fix.
// `status='archived' AND provenance='unverified'` is therefore NOT a valid
// "never checked" identifier on its own: it returns a mixture of genuinely
// checked-and-failed rows and never-checked legacy rows.
//
// The working discriminator (verified against production by the plan's
// orchestrator): a verification that actually ran always left evidence, in
// one of two places —
//   1. discovery_verification_attempts (exists only for checks since the W3
//      deploy that introduced the table).
//   2. place_resolution_cache, under the query key the verifier would have
//      used (a fossil covering older checks — nothing in this codebase ever
//      deletes from that table).
// A row with NEITHER was never checked. Evidence under EITHER the name key
// or the local_name key counts as "checked" (verifyOne tries name first,
// falls back to local_name) — this deliberately errs toward NOT repairing a
// row, since a false "never checked" would spend real provider budget
// re-checking something already checked.
//
// Repair action: provenance -> 'pending', status -> 'active'. 'pending' is
// what makes enqueueForVerification re-collect the row and what makes
// enforceCategoryCap stop treating it as an archivable victim before it has
// ever been checked. status='active' un-archives archived rows and is a
// no-op for rows that were already active. A 'suppressed' row is NEVER
// touched — suppression means the place was found permanently closed, a real
// finding, not cap damage.
//
// ---------------------------------------------------------------------------
// Usage (run from backend/):
//   node scripts/discoveryLegacyRepair.js                                        (report both, no writes)
//   node scripts/discoveryLegacyRepair.js --delete-empty-country                 (report W5.1 only)
//   node scripts/discoveryLegacyRepair.js --repair-unchecked                     (report W5.2 only)
//   node scripts/discoveryLegacyRepair.js --delete-empty-country --repair-unchecked --expect-destinations=4,5 --apply
//
// Without --apply, this is genuinely read-only: no UPDATE/DELETE statement is
// ever prepared, let alone run. --expect-destinations is REQUIRED whenever
// --delete-empty-country is combined with --apply — a hard abort, not a
// warning, if omitted. If both operations are selected, W5.1 always runs
// before W5.2, so a deleted destination's rows are never considered for the
// W5.2 repair.

import { pathToFileURL } from 'url';
import { config } from '../src/config.js';
import { initDb, getDb } from '../src/db/database.js';
import { buildPlaceQueryKey } from '../src/services/placeResolver.js';
import { CATEGORY_ACTIVE_CAP } from '../src/db/discoveryCatalogue.js';

export function parseArgs(argv) {
  const args = {
    deleteEmptyCountry: false,
    repairUnchecked: false,
    expectDestinations: null,
    apply: false,
  };
  for (const arg of argv) {
    if (arg === '--delete-empty-country') args.deleteEmptyCountry = true;
    else if (arg === '--repair-unchecked') args.repairUnchecked = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--expect-destinations=')) {
      args.expectDestinations = arg.slice('--expect-destinations='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// W5.1 — find/delete empty-country destinations
// ---------------------------------------------------------------------------

// Re-derives the live "empty country" destination set. Never hardcode ids as
// the source of truth — this always reflects the current DB.
export function findEmptyCountryDestinations(db) {
  return db.prepare(`
    SELECT
      d.id, d.city_key, d.country_code, d.display_name,
      (SELECT COUNT(*) FROM discovery_places p WHERE p.destination_id = d.id) AS place_count,
      (SELECT COUNT(*) FROM discovery_places p WHERE p.destination_id = d.id AND p.provenance = 'verified') AS verified_count
    FROM discovery_destinations d
    WHERE d.country_code = '' OR d.country_code IS NULL
    ORDER BY d.id
  `).all();
}

function formatIdSet(ids) {
  return `[${[...ids].sort((a, b) => a - b).join(', ')}]`;
}

// Deletes every destination in the live empty-country set, in one
// transaction, in explicit dependency order (attempts, generation_daily,
// places, destination) — explicit deletes (rather than relying on the
// ON DELETE CASCADE FKs) are what let this report exact per-table row
// counts, which a cascade cannot.
//
// Two hard gates run BEFORE any statement is prepared:
//   1. expectDestinations (required, an array of numeric ids) must equal the
//      live derived set exactly, in both directions. A derived set that has
//      GROWN beyond expectation means Plan 26 W4.5 has a hole and must be
//      investigated before any delete runs; a set that has SHRUNK means the
//      operator's assumption is stale. Either way this aborts loudly rather
//      than silently deleting a different set than the operator reviewed.
//   2. No target destination may hold a place with provenance='verified' —
//      owner decision D-26-3 rests on these destinations holding zero
//      verified rows (zero paid provider work). If that stopped being true
//      the decision needs revisiting before this runs.
export function deleteEmptyCountryDestinations(db, expectDestinations) {
  if (!Array.isArray(expectDestinations)) {
    throw new Error('deleteEmptyCountryDestinations requires an explicit expectDestinations array (use --expect-destinations)');
  }

  const derived = findEmptyCountryDestinations(db);
  const derivedIds = derived.map((d) => d.id);
  const derivedSet = new Set(derivedIds);
  const expectedSet = new Set(expectDestinations);

  const extra = derivedIds.filter((id) => !expectedSet.has(id));
  const missing = expectDestinations.filter((id) => !derivedSet.has(id));

  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `Empty-country destination set does not match --expect-destinations. ` +
      `live=${formatIdSet(derivedIds)} expected=${formatIdSet(expectDestinations)} ` +
      `extra_in_live=${formatIdSet(extra)} missing_from_live=${formatIdSet(missing)}. ` +
      `A GROWN set means Plan 26 W4.5 has a hole and must be investigated before deleting anything.`,
    );
  }

  const withVerified = derived.filter((d) => d.verified_count > 0);
  if (withVerified.length > 0) {
    throw new Error(
      `Refusing to delete destination(s) holding verified places (owner decision D-26-3 requires zero verified rows): ` +
      withVerified.map((d) => `id=${d.id} display_name=${d.display_name} verified_count=${d.verified_count}`).join('; '),
    );
  }

  const deleteAttempts = db.prepare('DELETE FROM discovery_verification_attempts WHERE destination_id = ?');
  const deleteGenerationDaily = db.prepare('DELETE FROM discovery_generation_daily WHERE destination_id = ?');
  const deletePlaces = db.prepare('DELETE FROM discovery_places WHERE destination_id = ?');
  const deleteDestination = db.prepare('DELETE FROM discovery_destinations WHERE id = ?');

  const perDestination = [];

  const run = db.transaction(() => {
    for (const destination of derived) {
      const attemptsDeleted = deleteAttempts.run(destination.id).changes;
      const generationDailyDeleted = deleteGenerationDaily.run(destination.id).changes;
      const placesDeleted = deletePlaces.run(destination.id).changes;
      const destinationDeleted = deleteDestination.run(destination.id).changes;
      perDestination.push({
        id: destination.id,
        city_key: destination.city_key,
        display_name: destination.display_name,
        place_count_before: destination.place_count,
        verified_count_before: destination.verified_count,
        attemptsDeleted,
        generationDailyDeleted,
        placesDeleted,
        destinationDeleted,
      });
    }
  });
  run();

  return { destinations: derived, perDestination };
}

// ---------------------------------------------------------------------------
// W5.2 — classify and repair never-checked rows
// ---------------------------------------------------------------------------

// Every candidate row: legacy-stamped 'unverified' provenance that is still
// active or archived (never suppressed — see the file header).
export function findNeverCheckedCandidates(db) {
  return db.prepare(`
    SELECT dp.*, dd.display_name AS destination_display_name, dd.country_code AS destination_country_code, dd.city_key AS destination_city_key
    FROM discovery_places dp
    JOIN discovery_destinations dd ON dd.id = dp.destination_id
    WHERE dp.provenance = 'unverified' AND dp.status IN ('active', 'archived')
    ORDER BY dp.destination_id, dp.id
  `).all();
}

// Classifies one candidate row as CHECKED (real evidence exists) or NEVER
// CHECKED. Evidence under either the name key or the local_name key counts
// as checked — verifyOne tries name first, falls back to local_name, so
// evidence under either means the row was looked at. This deliberately errs
// toward NOT repairing: a false "never checked" would burn provider budget
// re-checking something that was already checked.
export function classifyNeverChecked(db, place, destination) {
  const hasAttempt = db.prepare(
    'SELECT 1 FROM discovery_verification_attempts WHERE place_id = ? LIMIT 1',
  ).get(place.id);
  if (hasAttempt) return { checked: true, evidence: 'attempts' };

  const nameKey = buildPlaceQueryKey({
    queryText: place.name,
    city: destination.display_name,
    country: destination.country_code,
  });
  const hasNameCache = db.prepare(
    'SELECT 1 FROM place_resolution_cache WHERE query_key = ? LIMIT 1',
  ).get(nameKey);
  if (hasNameCache) return { checked: true, evidence: 'cache_name' };

  if (place.local_name) {
    const localNameKey = buildPlaceQueryKey({
      queryText: place.local_name,
      city: destination.display_name,
      country: destination.country_code,
    });
    const hasLocalNameCache = db.prepare(
      'SELECT 1 FROM place_resolution_cache WHERE query_key = ? LIMIT 1',
    ).get(localNameKey);
    if (hasLocalNameCache) return { checked: true, evidence: 'cache_local_name' };
  }

  return { checked: false, evidence: null };
}

// Builds the classification + (optional) repair report. When apply is false
// this only reads — no UPDATE is prepared or run. When apply is true, every
// never-checked row is flipped to provenance='pending', status='active' in
// one transaction.
export function repairNeverCheckedRows(db, { apply = false } = {}) {
  const candidates = findNeverCheckedCandidates(db);

  const neverChecked = [];
  const excluded = { attempts: 0, cache_name: 0, cache_local_name: 0 };

  for (const place of candidates) {
    const destination = {
      id: place.destination_id,
      display_name: place.destination_display_name,
      country_code: place.destination_country_code,
      city_key: place.destination_city_key,
    };
    const result = classifyNeverChecked(db, place, destination);
    if (result.checked) {
      excluded[result.evidence] = (excluded[result.evidence] || 0) + 1;
    } else {
      neverChecked.push(place);
    }
  }

  const byDestination = new Map();
  const byStatus = { active: 0, archived: 0 };
  for (const place of neverChecked) {
    byStatus[place.status] = (byStatus[place.status] || 0) + 1;
    const key = place.destination_id;
    if (!byDestination.has(key)) {
      byDestination.set(key, {
        destinationId: place.destination_id,
        displayName: place.destination_display_name,
        count: 0,
        active: 0,
        archived: 0,
      });
    }
    const entry = byDestination.get(key);
    entry.count += 1;
    entry[place.status] += 1;
  }

  // Cap-pressure readout: for each destination+category among the
  // never-checked rows, how many active slots exist today, how many rows are
  // about to become active (only archived rows change the active count —
  // already-active rows are a no-op), and whether the resulting total
  // exceeds the shared category cap.
  const capPressureKeyed = new Map();
  for (const place of neverChecked) {
    const key = `${place.destination_id}::${place.category}`;
    if (!capPressureKeyed.has(key)) {
      const currentActive = db.prepare(
        `SELECT COUNT(*) AS c FROM discovery_places WHERE destination_id = ? AND category = ? AND status = 'active'`,
      ).get(place.destination_id, place.category).c;
      capPressureKeyed.set(key, {
        destinationId: place.destination_id,
        displayName: place.destination_display_name,
        category: place.category,
        currentActive,
        becomingActive: 0,
      });
    }
    if (place.status === 'archived') {
      capPressureKeyed.get(key).becomingActive += 1;
    }
  }
  const capPressure = [...capPressureKeyed.values()].map((entry) => {
    const resultingTotal = entry.currentActive + entry.becomingActive;
    return {
      ...entry,
      resultingTotal,
      exceedsCap: resultingTotal > CATEGORY_ACTIVE_CAP,
      cap: CATEGORY_ACTIVE_CAP,
    };
  });

  let rowsWritten = 0;
  if (apply && neverChecked.length > 0) {
    const update = db.prepare(
      `UPDATE discovery_places SET provenance = 'pending', status = 'active' WHERE id = ?`,
    );
    const run = db.transaction(() => {
      for (const place of neverChecked) {
        rowsWritten += update.run(place.id).changes;
      }
    });
    run();
  }

  return {
    candidateCount: candidates.length,
    neverChecked,
    excluded,
    byDestination: [...byDestination.values()],
    byStatus,
    capPressure,
    applied: apply,
    rowsWritten,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printW51Report(db, { apply, expectDestinations }) {
  console.log('\n=== W5.1 — empty-country destinations ===');
  const derived = findEmptyCountryDestinations(db);

  if (derived.length === 0) {
    console.log('  (none found — nothing to delete)');
    return { attempted: false, ok: true };
  }

  for (const destination of derived) {
    console.log(
      `  id=${destination.id} city_key=${destination.city_key} display_name=${destination.display_name} ` +
      `place_count=${destination.place_count} verified_count=${destination.verified_count}`,
    );
  }

  if (!apply) {
    console.log(`  (dry run — would delete ${derived.length} destination(s) and their places/attempts/generation-counters; re-run with --delete-empty-country --expect-destinations=<ids> --apply to perform)`);
    return { attempted: false, ok: true };
  }

  if (!expectDestinations) {
    console.error('  FAILED: --delete-empty-country --apply requires --expect-destinations=<comma-separated ids>');
    return { attempted: true, ok: false };
  }

  try {
    const { perDestination } = deleteEmptyCountryDestinations(db, expectDestinations);
    console.log(`  applied — deleted ${perDestination.length} destination(s):`);
    for (const row of perDestination) {
      console.log(
        `    id=${row.id} display_name=${row.display_name} ` +
        `attempts_deleted=${row.attemptsDeleted} generation_daily_deleted=${row.generationDailyDeleted} ` +
        `places_deleted=${row.placesDeleted} destination_deleted=${row.destinationDeleted}`,
      );
    }
    const anyMissedDeletion = perDestination.some((row) => row.destinationDeleted !== 1);
    if (perDestination.length === 0 || anyMissedDeletion) {
      console.error('  FAILED: candidates existed but the delete did not remove them — no-op detected.');
      return { attempted: true, ok: false };
    }
    return { attempted: true, ok: true };
  } catch (error) {
    console.error(`  FAILED: ${error.message}`);
    return { attempted: true, ok: false };
  }
}

function printW52Report(db, { apply }) {
  console.log('\n=== W5.2 — never-checked rows misclassified as unverified ===');
  const report = repairNeverCheckedRows(db, { apply });

  console.log(`  candidates scanned (provenance='unverified', status active/archived): ${report.candidateCount}`);
  console.log(`  never-checked (to repair): ${report.neverChecked.length} (active=${report.byStatus.active || 0}, archived=${report.byStatus.archived || 0})`);
  console.log('  excluded as already-checked:');
  console.log(`    by discovery_verification_attempts row: ${report.excluded.attempts}`);
  console.log(`    by place_resolution_cache fossil (name key): ${report.excluded.cache_name}`);
  console.log(`    by place_resolution_cache fossil (local_name key): ${report.excluded.cache_local_name}`);

  if (report.byDestination.length > 0) {
    console.log('  by destination:');
    for (const entry of report.byDestination) {
      console.log(`    destination_id=${entry.destinationId} display_name=${entry.displayName} count=${entry.count} (active=${entry.active || 0}, archived=${entry.archived || 0})`);
    }
  }

  if (report.capPressure.length > 0) {
    console.log('  cap pressure (destination + category):');
    for (const entry of report.capPressure) {
      console.log(
        `    destination_id=${entry.destinationId} display_name=${entry.displayName} category=${entry.category} ` +
        `current_active=${entry.currentActive} becoming_active=${entry.becomingActive} resulting_total=${entry.resultingTotal} ` +
        `cap=${entry.cap} ${entry.exceedsCap ? 'EXCEEDS CAP' : 'within cap'}`,
      );
    }
  }

  if (!apply) {
    console.log(`  (dry run — would flip ${report.neverChecked.length} row(s) to provenance='pending', status='active'; re-run with --repair-unchecked --apply to perform)`);
    return { attempted: false, ok: true };
  }

  console.log(`  applied — ${report.rowsWritten} row(s) written`);
  if (report.neverChecked.length > 0 && report.rowsWritten === 0) {
    console.error('  FAILED: candidates existed but zero rows were written — no-op detected.');
    return { attempted: true, ok: false };
  }
  return { attempted: true, ok: true };
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runBoth = !args.deleteEmptyCountry && !args.repairUnchecked;

  initDb(config.dbPath);
  const db = getDb();

  const destinationsBefore = db.prepare('SELECT COUNT(*) AS c FROM discovery_destinations').get().c;
  const placesBefore = db.prepare('SELECT COUNT(*) AS c FROM discovery_places').get().c;

  console.log(`[discoveryLegacyRepair] db=${config.dbPath} apply=${args.apply} mode=${runBoth ? 'report-both' : [args.deleteEmptyCountry && 'delete-empty-country', args.repairUnchecked && 'repair-unchecked'].filter(Boolean).join('+')}`);

  let ok = true;

  if (runBoth || args.deleteEmptyCountry) {
    const applyThis = args.apply && (runBoth ? false : args.deleteEmptyCountry);
    // In report-both mode (no operation flag selected) nothing is ever
    // applied, even if --apply was passed — "report both, change nothing"
    // per the CLI contract.
    const result = printW51Report(db, { apply: applyThis, expectDestinations: args.expectDestinations });
    if (result.attempted && !result.ok) ok = false;
  }

  if (runBoth || args.repairUnchecked) {
    const applyThis = args.apply && (runBoth ? false : args.repairUnchecked);
    const result = printW52Report(db, { apply: applyThis });
    if (result.attempted && !result.ok) ok = false;
  }

  if (args.apply) {
    const destinationsAfter = db.prepare('SELECT COUNT(*) AS c FROM discovery_destinations').get().c;
    const placesAfter = db.prepare('SELECT COUNT(*) AS c FROM discovery_places').get().c;
    console.log(
      `\n[discoveryLegacyRepair] totals — discovery_destinations: ${destinationsBefore} -> ${destinationsAfter}; ` +
      `discovery_places: ${placesBefore} -> ${placesAfter}`,
    );
  }

  if (!ok) {
    console.error('\n[discoveryLegacyRepair] FAILED — see errors above.');
    process.exitCode = 1;
  } else {
    console.log('\n[discoveryLegacyRepair] done.');
  }
}

// Windows-safe "am I the entry point" check — import.meta.url includes a
// file:// scheme and drive-letter casing that differs from process.argv[1]'s
// raw path, so compare through pathToFileURL rather than a direct string
// match (mirrors discoveryReverify.js).
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error('[discoveryLegacyRepair] fatal error:', err);
    process.exit(1);
  });
}
