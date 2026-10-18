// Plan 30 W3 (§5.3) — discovery reality / location spot check.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/discoverySpotCheck.mjs --profile control,primary
//     [--per-destination 10] [--seed 30] [--only id,id] [--dry-run] [--keep-db]
//
// For each profile, takes that profile's most recent discovery run file (lib/runner.mjs latestRunFile),
// pools both variants' items per fixture, dedupes by normalizeName(name) and draws --per-destination
// items with a seeded PRNG (mulberry32, seeded per profile+fixture, so the sample is reproducible and
// adding a profile never changes another profile's draw). The sample is then pushed through the REAL
// verification pipeline — enqueueForVerification -> verifyOne -> resolvePlace -> classifyHit — with its
// real in-process daily budgets, Nominatim pacing and Google escalation sub-budget, and the verified
// share is reported per profile and per destination. Rows still `pending` after the drain (budget
// exhausted, or never reached) are reported as pending, never as verified or unverified.
//
// D-30-7 — no trace in any database. The mechanism is a single manual transaction on a backup-API
// COPY of the dev DB (lib/dbCopy.mjs):
//   1. makeCopy() copies the owner DB and points getDb() at the copy; countSideEffects() is taken.
//   2. db.exec('BEGIN') opens one transaction. better-sqlite3 turns every nested db.transaction()
//      (recordVerificationAttempts, etc.) into a SAVEPOINT inside it, and its statements are
//      synchronous, so the awaits inside the async resolver never interleave with a foreign writer.
//   3. A SCRATCH discovery_destinations row per (profile, fixture) carries the sampled rows. It copies
//      the real destination's display_name and country_code (buildResolveArgs sends display_name as
//      the city and classifyHit compares country_code) but has its own city_key, so a name already in
//      the real catalogue is never deduped away by insertPlaces and two profiles cannot collide.
//   4. Everything the pipeline wrote — scratch destinations, places, attempt rows, resolver cache
//      rows written by placeResolver.writeCache through getDb() — is read back, then
//      db.exec('ROLLBACK') in a finally. finishSideEffectCheck() prints the before/after count table
//      and exits 1 if any count moved. The owner DB is only ever opened readonly by dbCopy.
// runCatalogueGeneration is never called, DB_PATH is never set (config.js loads backend/.env with
// override:true, see dbCopy.mjs).
//
// What is NOT rolled back, by design: the in-process budget counters and the Nominatim pacing state in
// discoveryVerify.js / placeResolver.js are module memory, not database rows. They die with this
// process; they are real spend against the provider quotas and are reported via
// getDiscoveryBudgetStatus() before and after.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../../src/db/database.js';
import { findDestination, getOrCreateDestination, insertPlaces } from '../../src/db/discoveryCatalogue.js';
import { normalizeName } from '../../src/services/claude.js';
import { enqueueForVerification, getDiscoveryBudgetStatus } from '../../src/services/discoveryVerify.js';
import {
  FIXTURES_DIR, RUNS_DIR, latestRunFile, parseArgs, readRunFile,
} from './lib/runner.mjs';
import { countSideEffects, finishSideEffectCheck, makeCopy } from './lib/dbCopy.mjs';

const WORKLOAD = 'discovery-spotcheck';
const REASONS = [
  'ok', 'no_result', 'weak_match', 'country_mismatch', 'empty_destination_country',
  'budget_exhausted', 'resolver_error', 'not_reached',
];
const PROGRESS_INTERVAL_MS = 15000;

// --per-destination and --seed are this script's own flags; runner.parseArgs rejects the value that
// follows an unknown --flag, so both are lifted out of argv first.
function extractOptions(argv) {
  const options = { perDestination: 10, seed: 30 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--per-destination' || a === '--seed') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error(`${a} needs a value`);
      const value = parseInt(raw, 10);
      if (!Number.isInteger(value) || value < 0 || (a === '--per-destination' && value < 1)) {
        throw new Error(`${a} must be ${a === '--seed' ? 'a non-negative' : 'a positive'} integer, got "${raw}"`);
      }
      if (a === '--per-destination') options.perDestination = value;
      else options.seed = value;
      i += 1;
    } else {
      rest.push(a);
    }
  }
  return { options, rest };
}

// mulberry32: a 32-bit seeded PRNG, returns a function yielding floats in [0, 1).
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, folding a string into a 32-bit seed component.
function hashString(text) {
  let h = 0x811C9DC5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Fisher-Yates over a copy, first n of the shuffle.
function draw(pool, n, rng) {
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// Both variants' items for one fixture, flattened with their category, deduped on normalizeName
// (first occurrence wins) and sorted by that key so the draw does not depend on the record order.
function poolFor(records, fixtureId) {
  const seen = new Set();
  const pool = [];
  for (const record of records) {
    if (record.fixtureId !== fixtureId) continue;
    for (const category of record.output ?? []) {
      for (const item of category.items ?? []) {
        if (!item?.name) continue;
        const key = normalizeName(item.name) || item.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push({ key, item: { ...item, category: category.category } });
      }
    }
  }
  return pool.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((entry) => entry.item);
}

// Reads each profile's latest discovery run file and builds the units: one per (fixture, profile),
// fixture-major so the verification order interleaves profiles within a fixture.
function buildSample({ profiles, fixtures, options }) {
  const recordsByProfile = new Map();
  const runFiles = {};
  for (const profile of profiles) {
    const path = latestRunFile('discovery', profile);
    if (!path) throw new Error(`profile ${profile}: no discovery run file under ${join(RUNS_DIR, 'discovery', profile)}`);
    runFiles[profile] = path;
    const records = readRunFile(path);
    for (const record of records) {
      if (record.error) console.warn(`profile ${profile}: ${record.fixtureId}/${record.variant} has an error record (${record.error.message}); its output is still pooled`);
    }
    recordsByProfile.set(profile, records);
  }

  const units = [];
  for (const fixture of fixtures) {
    for (const profile of profiles) {
      const pool = poolFor(recordsByProfile.get(profile), fixture.id);
      if (!pool.length) {
        console.warn(`profile ${profile}: no items for fixture ${fixture.id} in ${runFiles[profile]}; skipped`);
        continue;
      }
      const rng = mulberry32((options.seed ^ hashString(`${profile}|${fixture.id}`)) >>> 0);
      const items = draw(pool, options.perDestination, rng);
      units.push({ fixture, profile, poolSize: pool.length, items });
    }
  }
  return { units, runFiles };
}

function printSample(units) {
  console.log('\nSample (profile / fixture / category / name / localName):');
  for (const unit of units) {
    console.log(`  ${unit.profile} / ${unit.fixture.id}: ${unit.items.length} of ${unit.poolSize} pooled item(s)`);
    for (const item of unit.items) {
      console.log(`    ${unit.profile.padEnd(10)} ${unit.fixture.id.padEnd(12)} ${String(item.category).padEnd(12)} ${item.name}${item.localName ? `  [${item.localName}]` : ''}`);
    }
  }
}

// Creates a scratch destination for the unit and inserts its sampled items with the real
// insertPlaces. Returns the unit enriched with destinationId and the inserted rows.
function insertUnit(db, unit, realDisplayName) {
  const scratch = getOrCreateDestination(db, {
    cityKey: `${unit.fixture.cityKey}__w3spot__${unit.profile}`,
    countryCode: unit.fixture.countryCode,
    displayName: realDisplayName,
  });
  const inserted = insertPlaces(db, scratch.id, unit.items, 0);
  return { ...unit, destinationId: scratch.id, inserted };
}

// The final verdict for a place: its provenance, the last attempt row (which lookup decided it) and
// the fields applyVerified wrote.
function readBack(db, unit) {
  const placeStmt = db.prepare(`
    SELECT id, category, name, local_name, provenance, status, provider_place_id, lat, lng, business_status
    FROM discovery_places WHERE id = ?
  `);
  const attemptsStmt = db.prepare(`
    SELECT source_field, provider, query_variant, escalated, network_requests, location_status,
           match_score, returned_name, returned_country, error, outcome, reason
    FROM discovery_verification_attempts WHERE place_id = ? ORDER BY id ASC
  `);
  return unit.inserted.map((row) => {
    const place = placeStmt.get(row.id);
    const attempts = attemptsStmt.all(row.id);
    const last = attempts.at(-1) ?? null;
    return {
      placeId: place.id,
      category: place.category,
      name: place.name,
      localName: place.local_name,
      provenance: place.provenance,
      status: place.status,
      reason: last?.reason ?? 'not_reached',
      sourceField: last?.source_field ?? null,
      resolvedCountry: last?.returned_country ?? null,
      resolvedName: last?.returned_name ?? null,
      providerPlaceId: place.provider_place_id,
      lat: place.lat,
      lng: place.lng,
      businessStatus: place.business_status,
      attempts,
    };
  });
}

function tally(verdicts) {
  const counts = { n: verdicts.length, verified: 0, unverified: 0, pending: 0, reasons: {} };
  for (const reason of REASONS) counts.reasons[reason] = 0;
  for (const v of verdicts) {
    counts[v.provenance] += 1;
    counts.reasons[v.reason] = (counts.reasons[v.reason] ?? 0) + 1;
  }
  return counts;
}

function cell(counts) {
  const pending = counts.pending ? ` (+${counts.pending} pending)` : '';
  return `${counts.verified}/${counts.n}${pending}`;
}

function pct(counts) {
  return counts.n ? `${Math.round((counts.verified / counts.n) * 100)}%` : 'n/a';
}

function printTables({ profiles, fixtures, results }) {
  const byKey = new Map(results.map((r) => [`${r.fixture.id}|${r.profile}`, tally(r.verdicts)]));
  const perProfile = Object.fromEntries(profiles.map((p) => [p, tally(results.filter((r) => r.profile === p).flatMap((r) => r.verdicts))]));

  const header = ['destination', ...profiles];
  const rows = fixtures.map((f) => [f.id, ...profiles.map((p) => (byKey.has(`${f.id}|${p}`) ? cell(byKey.get(`${f.id}|${p}`)) : '-'))]);
  rows.push(['TOTAL', ...profiles.map((p) => cell(perProfile[p]))]);
  rows.push(['verified share', ...profiles.map((p) => pct(perProfile[p]))]);

  console.log('\nVerified share (verified/inserted; pending rows are neither verified nor unverified):\n');
  console.log(`| ${header.join(' | ')} |`);
  console.log(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);

  console.log('\nLast-lookup reason per place:\n');
  console.log(`| reason | ${profiles.join(' | ')} |`);
  console.log(`| --- | ${profiles.map(() => '---').join(' | ')} |`);
  for (const reason of REASONS) {
    if (profiles.every((p) => perProfile[p].reasons[reason] === 0)) continue;
    console.log(`| ${reason} | ${profiles.map((p) => perProfile[p].reasons[reason]).join(' | ')} |`);
  }
  return perProfile;
}

function budgetLine(status) {
  return `resolver ${status.resolverRequests.used}/${status.resolverRequests.budget}, ` +
    `escalation ${status.escalationRequests.used}/${status.escalationRequests.budget}, ` +
    `reverify ${status.reverifyRequests.used}/${status.reverifyRequests.budget} (${status.date})`;
}

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function runVerification({ db, units, profiles, fixtures, options, args }) {
  // Real display names and country codes, read from the live (copied) destination rows.
  const displayNames = new Map();
  for (const fixture of fixtures) {
    const real = findDestination(db, fixture.cityKey, fixture.countryCode);
    if (!real) {
      throw new Error(`fixture ${fixture.id}: no discovery_destinations row for ${fixture.cityKey}|${fixture.countryCode} in the dev DB copy`);
    }
    displayNames.set(fixture.id, real.display_name);
  }

  if (args.flags.has('dry-run')) {
    console.log('\nDry run — destination rows the real mode would mirror (no insert, no network):');
    for (const fixture of fixtures) {
      console.log(`  ${fixture.id}: city_key=${fixture.cityKey} country=${fixture.countryCode} display_name=${JSON.stringify(displayNames.get(fixture.id))}`);
    }
    return null;
  }

  const budgetBefore = getDiscoveryBudgetStatus();
  console.log(`\nbudget before: ${budgetLine(budgetBefore)}`);

  db.exec('BEGIN');
  let progress = null;
  try {
    const inserted = units.map((unit) => insertUnit(db, unit, displayNames.get(unit.fixture.id)));
    for (const unit of inserted) {
      if (unit.inserted.length < unit.items.length) {
        console.warn(`${unit.profile}/${unit.fixture.id}: insertPlaces kept ${unit.inserted.length} of ${unit.items.length} sampled items (normalized-name duplicates)`);
      }
    }
    const total = inserted.reduce((sum, u) => sum + u.inserted.length, 0);
    console.log(`inserted ${total} scratch row(s) across ${inserted.length} scratch destination(s); verifying through the real pipeline`);

    const allIds = inserted.flatMap((u) => u.inserted.map((r) => r.id));
    const remainingStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM discovery_places WHERE id IN (${allIds.map(() => '?').join(',')}) AND provenance = 'pending'`,
    );
    progress = setInterval(() => {
      console.log(`  ... ${total - remainingStmt.get(...allIds).c}/${total} checked`);
    }, PROGRESS_INTERVAL_MS);

    // One enqueue per scratch destination, fixture-major, so every profile's queue starts in the same
    // tick and the shared Nominatim gate serves them in turn; a budget exhaustion therefore lands on
    // all profiles alike. The returned promise resolves when that destination's drain ends.
    await Promise.all(inserted.map((unit) => enqueueForVerification(db, unit.destinationId, unit.inserted.map((r) => r.id))));
    clearInterval(progress);
    progress = null;

    const budgetAfter = getDiscoveryBudgetStatus();
    console.log(`budget after:  ${budgetLine(budgetAfter)}`);

    const results = inserted.map((unit) => ({
      fixture: unit.fixture,
      profile: unit.profile,
      poolSize: unit.poolSize,
      verdicts: readBack(db, unit),
    }));
    return { results, budgetBefore, budgetAfter };
  } finally {
    if (progress) clearInterval(progress);
    if (db.inTransaction) db.exec('ROLLBACK');
  }
}

async function main() {
  const { options, rest } = extractOptions(process.argv.slice(2));
  const args = parseArgs(rest);
  const profiles = [...new Set(args.profile.split(',').map((p) => p.trim()).filter(Boolean))];
  if (!profiles.length) throw new Error('--profile needs at least one profile name');

  const allFixtures = JSON.parse(readFileSync(join(FIXTURES_DIR, 'discovery-destinations.json'), 'utf8')).destinations;
  const fixtures = args.only ? allFixtures.filter((f) => args.only.has(f.id)) : allFixtures;
  if (!fixtures.length) throw new Error('no fixtures selected');

  const { units, runFiles } = buildSample({ profiles, fixtures, options });
  if (!units.length) throw new Error('the run files hold no items for the selected fixtures');
  console.log(`profiles: ${profiles.join(', ')}  per-destination: ${options.perDestination}  seed: ${options.seed}`);
  for (const [profile, path] of Object.entries(runFiles)) console.log(`  ${profile}: ${path}`);
  printSample(units);

  const handle = await makeCopy(WORKLOAD);
  let before = null;
  let runPath = null;
  try {
    before = countSideEffects(getDb());
    console.log(`\nworking copy: ${handle.path}`);

    const outcome = await runVerification({ db: getDb(), units, profiles, fixtures, options, args });
    if (outcome) {
      const perProfile = printTables({ profiles, fixtures, results: outcome.results });
      const dir = join(RUNS_DIR, WORKLOAD);
      mkdirSync(dir, { recursive: true });
      runPath = join(dir, `${timestampSlug()}.json`);
      writeFileSync(runPath, JSON.stringify({
        workload: WORKLOAD,
        createdAt: new Date().toISOString(),
        options,
        profiles,
        runFiles,
        budgetBefore: outcome.budgetBefore,
        budgetAfter: outcome.budgetAfter,
        perProfile,
        perDestination: outcome.results.map((r) => ({ fixtureId: r.fixture.id, profile: r.profile, poolSize: r.poolSize, ...tally(r.verdicts) })),
        sample: units.map((u) => ({ profile: u.profile, fixtureId: u.fixture.id, poolSize: u.poolSize, items: u.items.map((i) => ({ category: i.category, name: i.name, localName: i.localName ?? null })) })),
        verdicts: outcome.results.map((r) => ({ fixtureId: r.fixture.id, profile: r.profile, places: r.verdicts })),
      }, null, 2), 'utf8');
      console.log(`\nresults: ${runPath}`);
    }
  } finally {
    // before is null only if setup threw before the first count; then there is nothing to compare.
    if (before) finishSideEffectCheck({ workload: WORKLOAD, handle, before, runPath, keep: args.flags.has('keep-db') });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
