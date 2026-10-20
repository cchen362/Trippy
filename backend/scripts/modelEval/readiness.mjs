// Plan 37 W0 — the whole-trip readiness prototype, run over a facts run.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/readiness.mjs
//     --db <production backup copy> --facts <facts run .jsonl> [--profile readiness-sonnet-55-high]
//     [--repeat 2] [--min-docs 8] [--trips id,id] [--concurrency 1] [--max-usd 8] [--dry-run] [--keep-db]
//
//   node scripts/modelEval/readiness.mjs --sheets --run <a.jsonl[,b.jsonl]> [--out <dir>]
//
// Run mode. For every trip with at least --min-docs documents in the facts run (or the trips named by
// --trips), builds the readiness input (lib/readinessPrototype.mjs: the trip as the co-pilot sees it,
// its bookings, days, the facts run's facts, and the health findings) and makes one streamed call per
// repeat. This is a grading prototype, not the Phase 2 design; nothing it writes is read by the app.
//
// D-37-11, and what makes it hold here. The production backup copy named by --db is only ever opened
// readonly (sourceDb.mjs): once for its start counts, and as the source of a backup-API copy that is
// opened through initDb so getTripDetail() and runTripHealthChecks() run on real data. Nothing else
// touches the source, and the owner's dev database is only counted. The side-effect table at the end
// compares the source (must not change), the working copy before vs after the runs (must not change:
// getTripDetail is a read), and the dev database (reported, not a failure). Records keep the trip's
// documents' parsed facts and hashes, never document bytes; run files and sheets live under the
// gitignored data/ directory, and the recorder redacts the request and response text.
//
// Sheet mode. Writes blind grading sheets (one per trip per ledger run, the model behind a code) and a
// key file; lib/score/readiness.mjs reads the marked sheets back for G-37-2 and G-37-3.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../src/config.js';
import { getDb } from '../../src/db/database.js';
import { getTripDetail } from '../../src/services/trips.js';
import { costUsd } from './lib/pricing.mjs';
import { getProfile, toServiceProfile } from './profiles.mjs';
import { installRecorder, recordFixture } from './lib/recorder.mjs';
import { PRIVATE_DIR, buildRecord, openRunFile, parseArgs, printProgress, readRunFile, runPool } from './lib/runner.mjs';
import {
  buildReadinessInput, buildReadinessRequest, classifyReadinessResponse,
} from './lib/readinessPrototype.mjs';
import {
  countAllTables, countDevDb, copySourceForWrite, openSourceReadonly, printSideEffectTable, removeCopy,
} from './lib/sourceDb.mjs';
import { G_37_2_MIN_TRIP_SHARE, G_37_3_MAX_FALSE_RATE, tripSlug } from './lib/score/readiness.mjs';

const DEFAULT_PROFILE = 'readiness-sonnet-55-high';
const VALUE_FLAGS = ['--db', '--facts', '--repeat', '--min-docs', '--trips', '--run', '--out'];

// Removes the flags that take a path or a list from argv (runner.parseArgs throws on any positional
// value it does not know) and returns them with the rest.
function splitArgs(argv) {
  const values = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.includes(argv[i])) {
      if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
      values[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  return { values, rest };
}

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

function positiveInt(raw, flag, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number of at least 1, got "${raw}"`);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Run mode
// ---------------------------------------------------------------------------------------------

// The complete facts records of the run, grouped by trip. A trip's document count is its records plus
// the aliases each one stands for (D-37-1: one read per content, several keys).
function groupFactsRun(factsPath) {
  const records = readRunFile(factsPath);
  if (!records.length) throw new Error(`${factsPath} holds no records`);
  const notFacts = records.filter((r) => r.workload !== 'facts');
  if (notFacts.length) throw new Error(`${factsPath} is not a facts run (${notFacts.length} record(s) with another workload)`);

  const byTrip = new Map();
  for (const r of records) {
    if (r.extra?.outcome !== 'complete' || !r.output) continue;
    if (!byTrip.has(r.extra.tripId)) byTrip.set(r.extra.tripId, { tripId: r.extra.tripId, tripTitle: r.extra.tripTitle, records: [] });
    byTrip.get(r.extra.tripId).records.push(r);
  }
  for (const trip of byTrip.values()) {
    trip.documentCount = trip.records.reduce((s, r) => s + 1 + (r.extra.aliasKeys?.length ?? 0), 0);
    trip.factCount = trip.records.reduce((s, r) => s + r.output.facts.length, 0);
  }
  return { records, byTrip, runId: records.find((r) => r.extra?.runId)?.extra.runId ?? null };
}

function selectTrips(byTrip, { minDocs, only }) {
  if (only) {
    const missing = only.filter((id) => !byTrip.has(id));
    if (missing.length) throw new Error(`--trips names trip(s) with no complete facts record: ${missing.join(', ')}`);
    return only.map((id) => byTrip.get(id));
  }
  return [...byTrip.values()]
    .filter((t) => t.documentCount >= minDocs)
    .sort((a, b) => b.documentCount - a.documentCount);
}

// Row counts of every table plus the connection's own count of rows it has changed. The counts catch
// an insert or a delete; total_changes() also catches an UPDATE in place, which leaves them unmoved.
function workingCopyCounts() {
  const db = getDb();
  return { ...countAllTables(db), 'connection total_changes()': db.prepare('SELECT total_changes() AS v').get().v };
}

function ownerOf(tripId) {
  const row = getDb().prepare('SELECT owner_id FROM trips WHERE id = ?').get(tripId);
  if (!row) throw new Error(`trip ${tripId} is in the facts run but not in the working copy`);
  return row.owner_id;
}

function buildInputFor(trip) {
  const tripDetail = getTripDetail(trip.tripId, ownerOf(trip.tripId));
  return { tripDetail, input: buildReadinessInput({ tripDetail, factRecords: trip.records }) };
}

function printDryRun(trips, profile) {
  console.log('\nDry run: inputs built, no API call.');
  let totalTokens = 0;
  for (const trip of trips) {
    const { input } = buildInputFor(trip);
    const tokens = Math.round(input.text.length / 4);
    totalTokens += tokens;
    const { B, D, F, H } = input.counts;
    console.log(
      `  ${trip.tripTitle} [${trip.tripId.slice(0, 6)}]: ${input.text.length} chars, ~${tokens} input tokens; ` +
      `ids B${B} D${D} F${F} H${H} (${trip.documentCount} documents, ${trip.factCount} facts in the run)`,
    );
  }
  const perRepeat = costUsd(profile.model, { input_tokens: totalTokens, output_tokens: 0 });
  console.log(`  total ~${totalTokens} input tokens per repeat (~$${perRepeat.toFixed(3)} input only; thinking and the ledger are extra).`);
}

async function runOne({ trip, repeat }, { client, profile, profileName, factsPath, factsRunId, runId }) {
  const { tripDetail, input } = buildInputFor(trip);
  const request = buildReadinessRequest(profile, input);
  const recorded = await recordFixture(
    () => client.messages.stream(request).finalMessage(),
    { redactText: true },
  );

  const classified = recorded.error
    ? { outcome: 'error', stopReason: null, category: null, error: recorded.error.message, value: null, unknownEvidence: [] }
    : classifyReadinessResponse(recorded.result, input.evidence);
  const items = classified.value?.items ?? [];
  const count = (key, value) => items.filter((i) => i[key] === value).length;

  return buildRecord({
    workload: 'readiness',
    profileName,
    profile,
    fixtureId: `trip:${trip.tripId}`,
    recorded,
    output: classified.value ?? null,
    extra: {
      runId,
      repeat,
      tripId: trip.tripId,
      tripTitle: trip.tripTitle,
      tripStartDate: tripDetail.trip.startDate,
      tripEndDate: tripDetail.trip.endDate,
      factsRun: factsPath,
      factsRunId,
      documentCount: trip.documentCount,
      factCount: trip.factCount,
      inputCounts: input.counts,
      evidence: input.evidence,
      outcome: classified.outcome,
      stopReason: classified.stopReason,
      refusalCategory: classified.category,
      validationError: classified.error,
      unknownEvidence: classified.unknownEvidence,
      itemCounts: {
        holds: count('kind', 'holds'), conflict: count('kind', 'conflict'), question: count('kind', 'question'),
        high: count('severity', 'high'), medium: count('severity', 'medium'), low: count('severity', 'low'),
      },
    },
  });
}

async function runMode(argv, values) {
  const args = parseArgs(argv);
  const profileName = argv.includes('--profile') ? args.profile : DEFAULT_PROFILE;
  const maxUsd = argv.includes('--max-usd') ? args.maxUsd : 8;
  const isDryRun = args.flags.has('dry-run');
  const keepDb = args.flags.has('keep-db');

  if (!values.db) throw new Error('--db <production backup copy> is required');
  if (!values.facts) throw new Error('--facts <facts run .jsonl> is required');
  const dbPath = resolve(values.db);
  const factsPath = resolve(values.facts);
  const repeats = positiveInt(values.repeat, '--repeat', 2);
  const minDocs = positiveInt(values['min-docs'], '--min-docs', 8);
  const only = values.trips ? values.trips.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const profile = getProfile('readiness', profileName);
  const serviceProfile = toServiceProfile(profile);

  const facts = groupFactsRun(factsPath);
  const trips = selectTrips(facts.byTrip, { minDocs, only });
  if (!trips.length) {
    throw new Error(`no trip has ${minDocs} or more documents in ${factsPath} (${facts.byTrip.size} trip(s) with complete records); lower --min-docs or name --trips`);
  }

  // Start counts of the source and the dev database, before anything is copied.
  const sourceHandle = openSourceReadonly(dbPath);
  const sourceStart = (() => { try { return countAllTables(sourceHandle); } finally { sourceHandle.close(); } })();
  const devStart = countDevDb();

  const copy = await copySourceForWrite(dbPath, 'readiness');
  let copyBefore = null;
  let runPath = null;
  try {
    copyBefore = workingCopyCounts();
    console.log(`source (readonly): ${dbPath}`);
    console.log(`working copy: ${copy.path}`);
    console.log(`facts run: ${factsPath}${facts.runId ? ` (run ${facts.runId})` : ''}`);
    console.log(`profile ${profileName}: ${JSON.stringify(serviceProfile)}`);
    console.log(`selected ${trips.length} trip(s), ${repeats} repeat(s) each${only ? ' (named by --trips)' : ` (>= ${minDocs} documents)`}:`);
    for (const t of trips) console.log(`  ${t.tripTitle} [${t.tripId.slice(0, 6)}]: ${t.documentCount} documents, ${t.factCount} facts`);

    if (isDryRun) {
      printDryRun(trips, serviceProfile);
    } else {
      if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
      installRecorder();
      // After the recorder, so the SDK's stream method is the recording one.
      const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
      const run = openRunFile('readiness', profileName);
      runPath = run.path;
      const runId = `readiness-${timestampSlug()}`;
      console.log(`run file: ${run.path}`);

      const items = [];
      for (let repeat = 1; repeat <= repeats; repeat += 1) for (const trip of trips) items.push({ trip, repeat });

      const summary = await runPool(items, async (item) => {
        const record = await runOne(item, { client, profile: serviceProfile, profileName, factsPath, factsRunId: facts.runId, runId });
        run.write(record);
        return record;
      }, { concurrency: args.concurrency, maxUsd, onRecord: printProgress });

      console.log(`\ndone ${summary.done}/${summary.total}, spent $${summary.spent.toFixed(4)}${summary.stopped ? ` — STOPPED: ${summary.stopped}` : ''}`);
      if (summary.stopped) process.exitCode = 2;
    }
  } finally {
    // copyBefore is null only if setup threw before the first count; then there is nothing to compare.
    if (copyBefore) {
      const sourceEndHandle = openSourceReadonly(dbPath);
      const sourceEnd = (() => { try { return countAllTables(sourceEndHandle); } finally { sourceEndHandle.close(); } })();
      const copyAfter = workingCopyCounts();
      const exitBefore = process.exitCode;
      printSideEffectTable([
        { name: `source (readonly) ${dbPath}`, start: sourceStart, end: sourceEnd, mustNotChange: true },
        { name: `working copy ${copy.path} (before vs after the runs)`, start: copyBefore, end: copyAfter, mustNotChange: true },
        { name: 'dev database (counted readonly)', start: devStart, end: countDevDb(), mustNotChange: false },
      ], { title: 'readiness', runPath });
      if (exitBefore === 2 && !process.exitCode) process.exitCode = 2;
      getDb().close();
      if (keepDb) console.log(`copy kept at ${copy.path}`);
      else removeCopy(copy.path);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Sheet mode
// ---------------------------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// A seeded shuffle, so the same runs always get the same codes (re-running --sheets never re-blinds).
function seededShuffle(items, seedText) {
  const seed = createHash('sha256').update(seedText).digest().readUInt32LE(0);
  let state = seed;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const escapeCell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

function resolveEvidence(id, evidence) {
  const e = evidence?.[id];
  if (!e) return `${id} (not in the input)`;
  const d = e.detail;
  if (e.type === 'fact') {
    const where = [d.document, d.page ? `p.${d.page}` : null,
      d.quoteVerified === true ? 'quote verified' : d.quoteVerified === false ? 'quote NOT found in the text' : 'no text layer'].filter(Boolean).join(', ');
    return `${id} ${d.kind} "${d.label}" = ${d.value} — quote "${d.quote}" (${where})`;
  }
  if (e.type === 'booking') return `${id} ${d.type} "${d.title}", ${d.start ?? 'no start'}`;
  if (e.type === 'day') return `${id} day ${d.date}${d.city ? `, ${d.city}` : ''}`;
  if (e.type === 'finding') return `${id} ${d.check}: ${d.message}`;
  return `${id} ${e.label}`;
}

function sheetFor(record, code) {
  const x = record.extra;
  const lines = [
    `# ${x.tripTitle}`,
    '',
    `Ledger run ${code}. Trip ${x.tripStartDate ?? '?'} to ${x.tripEndDate ?? '?'}; ${x.documentCount} documents, ${x.factCount} facts read.`,
    '',
  ];
  if (x.outcome !== 'complete') {
    lines.push(`This run did not complete (outcome: ${x.outcome}${x.validationError ? `, ${x.validationError}` : ''}). There is nothing to grade; it counts against G-37-2.`);
    return `${lines.join('\n')}\n`;
  }
  const items = record.output.items;
  if (!items.length) {
    lines.push('The check returned no lines for this trip. There is nothing to grade; it counts against G-37-2.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('| # | true | new | action | kind | severity | line | evidence |', '|---|---|---|---|---|---|---|---|');
  items.forEach((item, index) => {
    const evidence = item.evidence.map((id) => resolveEvidence(id, x.evidence)).join('; ');
    lines.push(`| ${index + 1} |  |  |  | ${item.kind} | ${item.severity} | ${escapeCell(item.text)} | ${escapeCell(evidence)} |`);
  });
  return `${lines.join('\n')}\n`;
}

function gradingReadme(codes) {
  return `# Readiness grading

Each folder is one trip; each file in it is one anonymous run of the whole-trip check (${codes.length} run code${codes.length === 1 ? '' : 's'}: ${codes.join(', ')}). You do not know which model or repeat a code is. Every line the check produced is a row. Fill three columns per row; leave a row blank only if you want it left out of the numbers.

| column | mark | meaning |
|---|---|---|
| true | t or f | t: the line is correct against the documents and the itinerary. f: it is wrong (a fact misread, a conflict that is not one, a stale or mismatched document, a time zone assumed). Check the quote in the evidence column against the document. |
| new | n or k | n: you did not already know this. k: you already knew it. |
| action | y or n | y: knowing it in time would have changed something you did (rebooked, called, brought a document, left earlier). n: it would not have. |

Gates (Plan 37 section 5):

- G-37-2, payoff. At least half of the document-rich trips must have at least one line you marked t + n + y. Each run code is counted on its own, so every run has to reach half; the share across all runs together is printed as a note. If it fails, the Phase 2 plan is not written and the numbers are recorded.
- G-37-3, ledger trust. No more than 1 in ${Math.round(1 / G_37_3_MAX_FALSE_RATE)} graded lines may be marked f (${G_37_3_MAX_FALSE_RATE * 100}% of the lines you mark t or f, pooled over every sheet). If it fails, the cause is named (time zone, stale document, missing fact) so a later attempt knows where to start.

The G-37-2 bar is ${G_37_2_MIN_TRIP_SHARE * 100}% of trips. A sheet that says the run did not complete or returned no lines has nothing to grade and counts against G-37-2.

When done: node scripts/modelEval/score.mjs readiness --run <the run file>. The key (which code is which run) is key.json in this folder; do not open it before grading.
`;
}

function sheetsMode(values) {
  if (!values.run) throw new Error('--sheets needs --run <a.jsonl[,b.jsonl]>');
  const runFiles = values.run.split(',').map((s) => resolve(s.trim())).filter(Boolean);

  // A ledger run is one (run file, repeat); each holds one record per trip.
  const ledgerRuns = [];
  for (const file of runFiles) {
    const records = readRunFile(file);
    if (!records.length) throw new Error(`${file} holds no records`);
    const wrong = records.filter((r) => r.workload !== 'readiness');
    if (wrong.length) throw new Error(`${file} is not a readiness run`);
    const repeats = [...new Set(records.map((r) => r.extra.repeat))].sort((a, b) => a - b);
    for (const repeat of repeats) {
      const mine = records.filter((r) => r.extra.repeat === repeat);
      ledgerRuns.push({ file, repeat, runId: mine[0].extra.runId, profile: mine[0].profile, model: mine[0].model, records: mine });
    }
  }

  const sorted = [...ledgerRuns].sort((a, b) => `${a.file}#${a.repeat}`.localeCompare(`${b.file}#${b.repeat}`));
  const shuffled = seededShuffle(sorted, sorted.map((r) => `${r.runId}#${r.repeat}`).join('\n'));
  if (shuffled.length > CODE_ALPHABET.length) throw new Error(`${shuffled.length} ledger runs is more than ${CODE_ALPHABET.length} codes`);

  const outDir = resolve(values.out ?? join(PRIVATE_DIR, 'facts', 'grading', `readiness-${timestampSlug()}`));
  if (existsSync(join(outDir, 'key.json'))) {
    throw new Error(`${outDir} already holds a key.json; refusing to overwrite sheets that may be graded (choose another --out)`);
  }
  mkdirSync(outDir, { recursive: true });

  const key = {};
  const codes = [];
  shuffled.forEach((run, i) => {
    const code = CODE_ALPHABET[i];
    codes.push(code);
    key[code] = { runFile: run.file, runId: run.runId, profile: run.profile, model: run.model, repeat: run.repeat };
    for (const record of run.records) {
      const dir = join(outDir, tripSlug(record.extra.tripId, record.extra.tripTitle));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${code}.md`), sheetFor(record, code), 'utf8');
    }
  });
  writeFileSync(join(outDir, 'key.json'), JSON.stringify(key, null, 2), 'utf8');
  writeFileSync(join(outDir, 'README.md'), gradingReadme(codes.sort()), 'utf8');

  const sheetCount = shuffled.reduce((s, r) => s + r.records.length, 0);
  console.log(`grading folder: ${outDir}`);
  console.log(`${sheetCount} sheet(s) for ${shuffled.length} ledger run(s), codes ${codes.join(', ')}; the key is key.json (do not open it before grading).`);
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const { values, rest } = splitArgs(process.argv.slice(2));
  if (rest.includes('--sheets')) {
    const unexpected = rest.filter((a) => a !== '--sheets');
    if (unexpected.length) throw new Error(`unexpected argument(s) with --sheets: ${unexpected.join(' ')}`);
    sheetsMode(values);
    return;
  }
  await runMode(rest, values);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
