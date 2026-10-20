// Plan 30 W0 — discovery evaluation harness.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/discovery.mjs --profile control
//     [--only id,id] [--variant first|exclusions] [--repeat n] [--concurrency 3] [--max-usd 10]
//     [--limit n] [--dry-run] [--keep-db]
//
// Six destinations x two variants (first generation / with the exclusion list a "show more" or a
// stale refresh would send) -> up to 12 generations per profile. Each generation calls the real
// discoverDestination(claudeDestination, exclusions, onCategory, profile) and records the request,
// the response, the streaming timeline and the accumulated categories.
//
// D-30-7: runs against a backup-API COPY of the dev DB (lib/dbCopy.mjs). discoverDestination is the
// only service function called. runCatalogueGeneration, insertPlaces, enqueueForVerification and
// every resolver are never called, so nothing is inserted, enqueued or geocoded; the count table at
// the end proves it. The exclusion lists are captured once from the copy into
// data/model-eval/discovery-exclusions.json and reused, so every profile is measured against
// identical lists.
//
// Plan 36 W2: --repeat <n> runs every selected item n times (the record keeps the plain fixtureId;
// extra.repeat is the 1-based repetition), to measure a collapse rate. Fixtures flagged firstOnly have
// no dev-DB row, so they get no exclusion capture and only the 'first' variant; fixtures flagged optIn
// (hoian, danang) are generated only when --only names them, so the standard corpus is unchanged.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb } from '../../src/db/database.js';
import { findDestination, listExclusionNames } from '../../src/db/discoveryCatalogue.js';
import { discoverDestination } from '../../src/services/claude.js';
import { countryNameFromCode } from '../../src/utils/countries.js';
import { assertControlIsLive, getProfile, toServiceProfile } from './profiles.mjs';
import { installRecorder, recordFixture } from './lib/recorder.mjs';
import { installPromptVariant } from './lib/discoveryPromptVariants.mjs';
import {
  EVAL_DATA_DIR, FIXTURES_DIR, buildRecord, filterItems, openRunFile, parseArgs, printProgress, runPool,
} from './lib/runner.mjs';
import { countSideEffects, finishSideEffectCheck, makeCopy } from './lib/dbCopy.mjs';

const EXCLUSIONS_PATH = join(EVAL_DATA_DIR, 'discovery-exclusions.json');
const EXCLUSION_CAP = 400; // the same cap runCatalogueGeneration passes to listExclusionNames

// --variant is this script's own flag; runner.parseArgs treats unknown --flags as booleans, so it
// is lifted out of argv first.
function extractVariant(argv) {
  const rest = [];
  let variant = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--variant') {
      variant = argv[i + 1];
      i += 1;
      if (variant !== 'first' && variant !== 'exclusions') {
        throw new Error('--variant must be "first" or "exclusions"');
      }
    } else {
      rest.push(argv[i]);
    }
  }
  return { variant, rest };
}

// Plan 36 W2: --repeat is lifted out of argv the same way (default 1).
function extractRepeat(argv) {
  const rest = [];
  let repeat = 1;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repeat') {
      repeat = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
    } else {
      rest.push(argv[i]);
    }
  }
  return { repeat, rest };
}

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// claudeDestination exactly as routes/discovery.js composes it for a known country.
function claudeDestinationFor(fixture) {
  return `${fixture.label}, ${countryNameFromCode(fixture.countryCode)} (${fixture.countryCode})`;
}

// Captures exclusion lists for any fixture missing from the stored file; never rewrites an entry
// that already exists, so a second profile sees byte-identical lists.
function loadOrCaptureExclusions(db, fixtures) {
  const stored = existsSync(EXCLUSIONS_PATH) ? JSON.parse(readFileSync(EXCLUSIONS_PATH, 'utf8')) : { destinations: {} };
  let captured = 0;

  for (const fixture of fixtures) {
    if (fixture.firstOnly) continue; // Plan 36 W2: no dev-DB row, so no exclusion list to capture
    if (stored.destinations[fixture.id]) continue;
    const row = findDestination(db, fixture.cityKey, fixture.countryCode);
    if (!row) {
      throw new Error(`fixture ${fixture.id}: no discovery_destinations row for ${fixture.cityKey}|${fixture.countryCode} in the dev DB copy`);
    }
    const names = listExclusionNames(db, row.id, EXCLUSION_CAP);
    stored.destinations[fixture.id] = {
      cityKey: fixture.cityKey,
      countryCode: fixture.countryCode,
      sourceDestinationId: row.id,
      count: names.length,
      sha256: sha256(names),
      names,
    };
    captured += 1;
  }

  if (captured) {
    stored.capturedAt = new Date().toISOString();
    mkdirSync(dirname(EXCLUSIONS_PATH), { recursive: true });
    writeFileSync(EXCLUSIONS_PATH, JSON.stringify(stored, null, 2), 'utf8');
    console.log(`captured ${captured} exclusion list(s) into ${EXCLUSIONS_PATH}`);
  }
  return stored.destinations;
}

// Runs the selected generations and returns the run file path (null for a dry run).
async function sweep({ args, profile, items, exclusionsById, dryRun, repeat }) {
  console.log(`profile ${args.profile}: ${JSON.stringify(toServiceProfile(profile))}${profile.promptVariant ? ` + prompt variant "${profile.promptVariant}"` : ''}`);
  console.log(`${items.length} generation(s)${repeat > 1 ? ` (${items.length / repeat} item(s) x ${repeat} repeats)` : ''}${dryRun ? ' (dry run, no API call)' : ''}:`);
  for (const { fixture, variant } of items.filter((item) => item.repeat === 1)) {
    const exclusion = exclusionsById[fixture.id];
    console.log(
      `  ${fixture.id}/${variant}  "${claudeDestinationFor(fixture)}"  ` +
      `exclusions=${variant === 'exclusions' ? exclusion.count : 0}  repeat=${repeat}  [${fixture.role}]`,
    );
  }
  if (dryRun || !items.length) return null;

  installRecorder();
  // After the recorder, so the run file stores the patched system prompt (W3 second pass).
  if (profile.promptVariant) installPromptVariant(profile.promptVariant);
  const run = openRunFile('discovery', args.profile);
  console.log(`run file: ${run.path}`);

  const summary = await runPool(items, async ({ fixture, variant, repeat: repetition }) => {
    const exclusion = exclusionsById[fixture.id];
    const exclusions = variant === 'exclusions' ? exclusion.names : [];
    const claudeDestination = claudeDestinationFor(fixture);
    const streamed = [];
    const categoryTimes = [];
    const startedAt = Date.now();

    const recorded = await recordFixture(() => discoverDestination(
      claudeDestination,
      exclusions,
      (category) => {
        streamed.push(category);
        categoryTimes.push({ category: category.category, items: category.items.length, t: Date.now() - startedAt });
      },
      toServiceProfile(profile),
    ));

    const record = buildRecord({
      workload: 'discovery',
      profileName: args.profile,
      profile,
      fixtureId: fixture.id,
      variant,
      recorded,
      output: streamed,
      extra: {
        destination: claudeDestination,
        variant,
        promptVariant: profile.promptVariant ?? null,
        exclusionCount: exclusions.length,
        exclusionsSha: variant === 'exclusions' ? exclusion.sha256 : null,
        categoryTimes,
        repeat: repetition,
      },
    });
    run.write(record);
    return record;
  }, {
    concurrency: args.concurrency,
    maxUsd: args.maxUsd,
    // Repeated records share a fixtureId, so the progress line names the repetition.
    onRecord: (record, state) => printProgress(
      repeat > 1 ? { ...record, fixtureId: `${record.fixtureId}#${record.extra.repeat}` } : record,
      state,
    ),
  });

  console.log(`
done ${summary.done}/${summary.total}, spent $${summary.spent.toFixed(4)}${summary.stopped ? ` — STOPPED: ${summary.stopped}` : ''}`);
  if (summary.stopped) process.exitCode = 1;
  return run.path;
}

async function main() {
  const { variant: variantFilter, rest: afterVariant } = extractVariant(process.argv.slice(2));
  const { repeat, rest } = extractRepeat(afterVariant);
  const args = parseArgs(rest);
  if (!rest.includes('--concurrency')) args.concurrency = 3;
  const dryRun = args.flags.has('dry-run');
  const keepDb = args.flags.has('keep-db');

  const profile = getProfile('discovery', args.profile);
  if (args.profile === 'control') assertControlIsLive('discovery');

  const fixtures = JSON.parse(readFileSync(join(FIXTURES_DIR, 'discovery-destinations.json'), 'utf8')).destinations;

  const handle = await makeCopy('discovery');
  let before = null;
  let runPath = null;
  try {
    const exclusionsById = loadOrCaptureExclusions(getDb(), fixtures);
    before = countSideEffects(getDb());
    console.log(`working copy: ${handle.path}`);

    const variants = variantFilter ? [variantFilter] : ['first', 'exclusions'];
    // Plan 36 W2: optIn fixtures need --only to name them; firstOnly fixtures have no 'exclusions' variant.
    const base = filterItems(
      fixtures
        .filter((fixture) => !fixture.optIn || args.only?.has(fixture.id))
        .flatMap((fixture) => variants
          .filter((variant) => !fixture.firstOnly || variant === 'first')
          .map((variant) => ({ fixture, variant }))),
      args,
      (item) => item.fixture.id,
    );
    const items = base.flatMap((item) => Array.from({ length: repeat }, (_, i) => ({ ...item, repeat: i + 1 })));
    runPath = await sweep({ args, profile, items, exclusionsById, dryRun, repeat });
  } finally {
    // before is null only if setup threw before the first count; then there is nothing to compare.
    if (before) finishSideEffectCheck({ workload: 'discovery', handle, before, runPath, keep: keepDb });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
