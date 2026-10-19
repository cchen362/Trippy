// Plan 30 W0 — extraction harness.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/extraction.mjs --profile control [--only id,id] [--limit n] [--concurrency 3] [--max-usd 10]
//
// Runs extractBookings() from the real service against every fixture:
//   - committed synthetic cases: scripts/modelEval/fixtures/extraction/<id>.json — text inline, or a
//     rendered PNG/PDF named by relative `path` under fixtures/extraction/files/ (written by
//     renderExtractionFixtures.mjs, Plan 30 W4)
//   - the owner's private cases (gitignored): data/model-eval/private/extraction/<id>/fixture.json,
//     whose files reference binaries by relative `path` instead of inline `content`. Private runs
//     redact request/response text in the record; the raw input never lands in a run file.
// One JSON line per fixture goes to data/model-eval/runs/extraction/<profile>/<timestamp>.jsonl.
//
// D-30-7: no database is imported or opened; the only external call is the Anthropic Messages API.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installRecorder, recordFixture } from './lib/recorder.mjs';
import {
  FIXTURES_DIR, PRIVATE_DIR, parseArgs, openRunFile, buildRecord, runPool, filterItems, printProgress,
} from './lib/runner.mjs';
import { getProfile, toServiceProfile, assertControlIsLive } from './profiles.mjs';
import { installExtractionPromptVariant } from './lib/extractionPromptVariants.mjs';

const WORKLOAD = 'extraction';

// A file is { kind, mediaType?, filename?, path } (binary or text read from disk, path relative to
// the fixture's own folder) or { kind: 'text', content } with the text inline. Committed and private
// fixtures share this resolver.
function resolveFile(file, folder) {
  if (!file.path) return file;
  const bytes = readFileSync(resolve(folder, file.path));
  const content = file.kind === 'text' ? bytes.toString('utf8') : bytes.toString('base64');
  const { path, ...rest } = file;
  return { ...rest, content };
}

function loadCommittedFixtures() {
  const dir = join(FIXTURES_DIR, WORKLOAD);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const fixture = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { ...fixture, files: fixture.files.map((file) => resolveFile(file, dir)), private: false };
    });
}

function loadPrivateFixtures() {
  const root = join(PRIVATE_DIR, WORKLOAD);
  mkdirSync(root, { recursive: true });
  const fixtures = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = join(root, entry.name);
    const manifest = join(folder, 'fixture.json');
    if (!existsSync(manifest)) continue;
    const fixture = JSON.parse(readFileSync(manifest, 'utf8'));
    fixtures.push({
      ...fixture,
      id: fixture.id ?? entry.name,
      files: fixture.files.map((f) => resolveFile(f, folder)),
      private: true,
    });
  }
  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const args = parseArgs();
  const profile = getProfile(WORKLOAD, args.profile);
  const serviceProfile = toServiceProfile(profile);
  if (args.profile === 'control') assertControlIsLive(WORKLOAD);

  installRecorder();
  // After the recorder, so the run file stores the prompt that was actually sent (Plan 34 §4.3).
  if (profile.promptVariant) installExtractionPromptVariant(profile.promptVariant);
  const { extractBookings } = await import('../../src/services/claude.js');

  let fixtures = [...loadCommittedFixtures(), ...loadPrivateFixtures()];
  if (profile.subset === 'hard') fixtures = fixtures.filter((f) => f.tags?.includes('hard'));
  fixtures = filterItems(fixtures, args);
  if (!fixtures.length) throw new Error('no fixtures selected');

  const runFile = openRunFile(WORKLOAD, args.profile);
  const privateCount = fixtures.filter((f) => f.private).length;
  console.log(
    `extraction / ${args.profile} (${profile.model}): ${fixtures.length} fixtures ` +
    `(${privateCount} private), concurrency ${args.concurrency}, --max-usd ${args.maxUsd}`,
  );
  if (profile.promptVariant) console.log(`prompt variant: ${profile.promptVariant}`);
  console.log('D-30-7: this script imports no database; only the Anthropic API is called.');

  async function runOne(fixture) {
    const recorded = await recordFixture(
      () => extractBookings({
        files: fixture.files,
        contextText: fixture.contextText ?? null,
        tripContext: fixture.tripContext ?? null,
        profile: serviceProfile,
      }),
      { redactText: fixture.private },
    );
    const record = buildRecord({
      workload: WORKLOAD,
      profileName: args.profile,
      profile: serviceProfile,
      fixtureId: fixture.id,
      recorded,
      output: recorded.result?.extraction ?? null,
      extra: {
        private: fixture.private,
        tags: fixture.tags ?? [],
        expected: fixture.expected,
        promptVariant: profile.promptVariant ?? null,
      },
    });
    runFile.write(record);
    return record;
  }

  const summary = await runPool(fixtures, runOne, {
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
