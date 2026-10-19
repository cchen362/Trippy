// Plan 30 W0 — photo-descriptor harness.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/descriptor.mjs --profile control [--only id,id] [--limit n] [--concurrency 3] [--max-usd 10]
//
// Runs generatePhotoDescriptor() from the real service for each place in
// scripts/modelEval/fixtures/descriptor-places.json. A numeric profile `subset` keeps the first N
// places. One JSON line per place goes to data/model-eval/runs/descriptor/<profile>/<timestamp>.jsonl.
//
// A profile may carry a harness-only `promptVariant` (Plan 34 W3: 'broad-query', profile 'w3-broad'): it is installed from
// lib/descriptorContractVariants.mjs after the recorder, so the run file stores the request actually sent and the raw
// answer, and each record's `extra.broadQuery` holds the broadQuery the model wrote. claude.js is unchanged.
//
// D-30-7: no database is imported or opened; the only external call is the Anthropic Messages API.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installRecorder, recordFixture } from './lib/recorder.mjs';
import { FIXTURES_DIR, parseArgs, openRunFile, buildRecord, runPool, filterItems, printProgress } from './lib/runner.mjs';
import { getProfile, toServiceProfile, assertControlIsLive } from './profiles.mjs';
import { installDescriptorContractVariant, rawBroadQuery } from './lib/descriptorContractVariants.mjs';

const WORKLOAD = 'descriptor';

async function main() {
  const args = parseArgs();
  const profile = getProfile(WORKLOAD, args.profile);
  const serviceProfile = toServiceProfile(profile);
  if (args.profile === 'control') assertControlIsLive(WORKLOAD);

  installRecorder();
  // After the recorder, so the run file stores the request that was actually sent (Plan 34 §4.2).
  if (profile.promptVariant) installDescriptorContractVariant(profile.promptVariant);
  const { generatePhotoDescriptor } = await import('../../src/services/claude.js');

  let places = JSON.parse(readFileSync(join(FIXTURES_DIR, 'descriptor-places.json'), 'utf8'));
  if (Number.isInteger(profile.subset)) places = places.slice(0, profile.subset);
  places = filterItems(places, args);
  if (!places.length) throw new Error('no places selected');

  const runFile = openRunFile(WORKLOAD, args.profile);
  console.log(
    `descriptor / ${args.profile} (${profile.model}): ${places.length} places, ` +
    `concurrency ${args.concurrency}, --max-usd ${args.maxUsd}`,
  );
  if (profile.promptVariant) console.log(`prompt variant: ${profile.promptVariant}`);
  console.log('D-30-7: this script imports no database; only the Anthropic API is called.');

  async function runOne(place) {
    const { id, title, resolvedName, city, country, type } = place;
    const recorded = await recordFixture(
      () => generatePhotoDescriptor({ title, resolvedName, city, country, type, profile: serviceProfile }),
    );
    const record = buildRecord({
      workload: WORKLOAD,
      profileName: args.profile,
      profile: serviceProfile,
      fixtureId: id,
      recorded,
      output: recorded.result ?? null,
      extra: { place },
    });
    if (profile.promptVariant) record.extra.broadQuery = rawBroadQuery(record);
    runFile.write(record);
    return record;
  }

  const summary = await runPool(places, runOne, {
    concurrency: args.concurrency,
    maxUsd: args.maxUsd,
    onRecord: printProgress,
  });

  console.log(`\nrun file: ${runFile.path}`);
  console.log(`done ${summary.done}/${summary.total}, spent $${summary.spent.toFixed(4)}`);
  if (summary.stopped) {
    console.log(`STOPPED by the spend guard: ${summary.stopped}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
