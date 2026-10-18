// D-30-7 — evaluation never touches owner data or the shared catalogue.
//
// Every harness script that needs a database works on a COPY of the dev DB taken with the SQLite
// backup API (the owner's WAL is large and uncheckpointed, so copying the .db file alone would miss
// committed data). The copy is opened with initDb(copyPath) directly: src/config.js loads dotenv with
// override:true, so backend/.env's DB_PATH always beats anything set in process.env — never rely on
// DB_PATH, and never import src/index.js.
//
// Proof is by side effect. countSideEffects() reads the tables a stray generation, verification,
// resolver call or co-pilot persist would change; the script prints the counts before and after its
// run, and for the OWNER db (opened readonly) at the start and end of the process as well.
//
//   copy changed  -> the run is invalid, the script exits 1.
//   owner changed -> printed as a loud warning but not a failure: this process never opens the owner
//                    db for writing, so a difference means something else (a dev server, the owner
//                    using the app) wrote to it while the run was in flight.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../../src/config.js';
import { initDb, getDb } from '../../../src/db/database.js';
import { EVAL_DATA_DIR } from './runner.mjs';

export const OWNER_DB_PATH = config.dbPath;
export const COPY_DIR = join(EVAL_DATA_DIR, 'db');

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

const COUNT_QUERIES = [
  ['discovery_places rows', 'SELECT COUNT(*) AS v FROM discovery_places'],
  ['discovery_destinations rows', 'SELECT COUNT(*) AS v FROM discovery_destinations'],
  ['SUM(generation_count)', 'SELECT COALESCE(SUM(generation_count), 0) AS v FROM discovery_destinations'],
  ['SUM(discovery_generation_daily.count)', 'SELECT COALESCE(SUM(count), 0) AS v FROM discovery_generation_daily'],
  ['discovery_verification_attempts rows', 'SELECT COUNT(*) AS v FROM discovery_verification_attempts'],
  ['place_resolution_cache rows', 'SELECT COUNT(*) AS v FROM place_resolution_cache'],
  ['copilot_messages rows', 'SELECT COUNT(*) AS v FROM copilot_messages'],
  ['copilot_proposals rows', 'SELECT COUNT(*) AS v FROM copilot_proposals'],
  ['copilot_turn_metrics rows', 'SELECT COUNT(*) AS v FROM copilot_turn_metrics'],
];

// The counts D-30-7 asks for, plus a digest of (id, generation_count, last_generated_at) per
// destination — a generation that inserted nothing would still move last_generated_at.
export function countSideEffects(db) {
  const counts = {};
  for (const [label, sql] of COUNT_QUERIES) counts[label] = db.prepare(sql).get().v;
  const destinations = db
    .prepare('SELECT id, generation_count, last_generated_at FROM discovery_destinations ORDER BY id')
    .all();
  counts['destinations digest'] = createHash('sha256').update(JSON.stringify(destinations)).digest('hex').slice(0, 12);
  return counts;
}

// Counts of the OWNER db, opened readonly and closed again immediately.
export function countOwner() {
  const owner = new Database(OWNER_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return countSideEffects(owner);
  } finally {
    owner.close();
  }
}

// Copies the owner db with the backup API and points the app's db handle at the copy.
// Returns { path, db, ownerStart }. The caller seeds whatever setup it needs, THEN takes the
// "before" counts — setup is part of building the fixture, not a side effect of the run.
export async function makeCopy(workload) {
  const ownerStart = countOwner();

  mkdirSync(COPY_DIR, { recursive: true });
  const path = join(COPY_DIR, `${workload}-${timestampSlug()}.db`);

  const owner = new Database(OWNER_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await owner.backup(path);
  } finally {
    owner.close();
  }

  const db = initDb(path);
  assertActiveDbIsCopy(path);
  return { path, db, ownerStart };
}

// The one assertion that matters: every getDb() in the services resolves to the copy.
export function assertActiveDbIsCopy(copyPath) {
  const active = resolve(getDb().name);
  if (active !== resolve(copyPath)) {
    throw new Error(`D-30-7 violated: getDb() resolves to ${active}, expected the copy ${resolve(copyPath)}`);
  }
  if (active === resolve(OWNER_DB_PATH)) {
    throw new Error(`D-30-7 violated: getDb() resolves to the owner database ${active}`);
  }
}

function diffCounts(before, after) {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}

export function printCountTable({ ownerStart, ownerEnd, before, after }) {
  const header = ['metric', 'owner start', 'owner end', 'copy before', 'copy after', 'copy'];
  const rows = Object.keys(before).map((key) => [
    key,
    ownerStart[key],
    ownerEnd[key],
    before[key],
    after[key],
    before[key] === after[key] ? 'unchanged' : 'CHANGED',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

// assertUnchanged(before, after, label): prints the verdict and returns { ok, changed }.
export function assertUnchanged(before, after, label) {
  const changed = diffCounts(before, after);
  if (changed.length) {
    console.error(`D-30-7 ${label}: CHANGED -> ${changed.map((k) => `${k} ${before[k]} -> ${after[k]}`).join('; ')}`);
  } else {
    console.log(`D-30-7 ${label}: UNCHANGED`);
  }
  return { ok: changed.length === 0, changed };
}

// Takes the after counts, prints the table and both verdicts, writes a sidecar next to the run file,
// closes and removes the copy (unless keep) and sets process.exitCode = 1 when the copy changed.
export function finishSideEffectCheck({ workload, handle, before, runPath = null, keep = false }) {
  assertActiveDbIsCopy(handle.path);
  const after = countSideEffects(getDb());
  const ownerEnd = countOwner();

  console.log(`\nD-30-7 side-effect proof (${workload})`);
  printCountTable({ ownerStart: handle.ownerStart, ownerEnd, before, after });

  const copyVerdict = assertUnchanged(before, after, 'copy');
  const ownerVerdict = assertUnchanged(handle.ownerStart, ownerEnd, 'owner db (readonly counts, start vs end)');
  if (!ownerVerdict.ok) {
    console.warn(
      'WARNING: the owner db changed while this run was in flight. This process opened it readonly only ' +
      '(backup source and count queries), so another process wrote to it — most likely the dev server or ' +
      'the owner using the app. Reported, not hidden.',
    );
  }

  if (runPath) {
    writeFileSync(
      `${runPath}.d30-7.json`,
      JSON.stringify({ workload, copyPath: handle.path, ownerStart: handle.ownerStart, ownerEnd, before, after, copyUnchanged: copyVerdict.ok, ownerUnchanged: ownerVerdict.ok }, null, 2),
      'utf8',
    );
  }

  getDb().close();
  if (keep) {
    console.log(`copy kept at ${handle.path}`);
  } else {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${handle.path}${suffix}`;
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }

  if (!copyVerdict.ok) process.exitCode = 1;
  return { copyUnchanged: copyVerdict.ok, ownerUnchanged: ownerVerdict.ok };
}
