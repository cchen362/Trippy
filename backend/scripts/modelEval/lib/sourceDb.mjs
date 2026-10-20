// Plan 37 W0 (D-37-11) — reading owner documents from a production backup copy without writing.
//
// facts.mjs and readiness.mjs take `--db <path>`: the owner's production backup copy at
// data/model-eval/private/db/prod-<date>.db. lib/dbCopy.mjs only knows the dev database
// (config.dbPath, F-37-4), so this module adds a second source:
//
//   openSourceReadonly(path)   the copy, opened readonly — census, document enumeration, bytes
//   copySourceForWrite(path)   a disposable backup-API copy OF that copy, opened through initDb so
//                              services that call getDb() (getTripDetail) run against it; never the
//                              source itself and never the dev database
//
// Proof is by side effect, as D-30-7 does it: countAllTables() counts every table and digests the
// counts with each table's max(rowid); a script takes the counts at the start and the end for every
// database it touched and prints them with printSideEffectTable(). A source that must not change and
// did sets process.exitCode = 1.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initDb } from '../../../src/db/database.js';
import { COPY_DIR, OWNER_DB_PATH, assertActiveDbIsCopy } from './dbCopy.mjs';

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function openSourceReadonly(path) {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`--db ${full} does not exist`);
  return new Database(full, { readonly: true, fileMustExist: true });
}

// { '<table> rows': n, ..., digest } for every user table, so a stray write anywhere shows.
export function countAllTables(db) {
  // `wr` is 1 for a WITHOUT ROWID table, which has no rowid to read; its count alone stands for it.
  const tables = db
    .prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const counts = {};
  const digestParts = [];
  for (const { name: table, wr } of tables) {
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const n = db.prepare(`SELECT COUNT(*) AS v FROM ${quoted}`).get().v;
    const maxRowid = wr ? 'no-rowid' : db.prepare(`SELECT MAX(rowid) AS v FROM ${quoted}`).get().v;
    counts[`${table} rows`] = n;
    digestParts.push([table, n, maxRowid]);
  }
  counts.digest = createHash('sha256').update(JSON.stringify(digestParts)).digest('hex').slice(0, 12);
  return counts;
}

// Counts of a database file opened readonly and closed again at once.
export function countFileReadonly(path) {
  const db = openSourceReadonly(path);
  try {
    return countAllTables(db);
  } finally {
    db.close();
  }
}

// The dev database (the owner's local data), counted readonly — this process never opens it for
// writing, so a difference between start and end means another process wrote to it.
export function countDevDb() {
  return countFileReadonly(OWNER_DB_PATH);
}

// A disposable copy of the source taken with the backup API (the WAL included), opened with initDb so
// every getDb() in the services resolves to it. Returns { path, db }.
export async function copySourceForWrite(sourcePath, label) {
  const source = resolve(sourcePath);
  if (source === resolve(OWNER_DB_PATH)) {
    throw new Error('D-37-11: --db names the dev database; readiness runs on a copy of the production backup copy');
  }
  mkdirSync(COPY_DIR, { recursive: true });
  const path = join(COPY_DIR, `${label}-${timestampSlug()}.db`);
  const src = openSourceReadonly(source);
  try {
    await src.backup(path);
  } finally {
    src.close();
  }
  const db = initDb(path);
  assertActiveDbIsCopy(path);
  if (resolve(path) === source) throw new Error(`D-37-11 violated: the working copy is the source ${source}`);
  return { path, db };
}

export function removeCopy(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

const totalRows = (counts) => Object.entries(counts)
  .filter(([k, v]) => k.endsWith(' rows') && typeof v === 'number')
  .reduce((s, [, v]) => s + v, 0);

function printTable(header, body) {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of body) console.log(line(r));
}

// rows: [{ name, start, end, mustNotChange }]. Prints one summary row per database (tables, total
// rows and digest at start and end, verdict) and, for a database that changed, every metric that
// moved. The full per-table counts always go to `${runPath}.d30-7.json` when runPath is given. A
// database with mustNotChange that changed sets process.exitCode = 1; one without it (the dev
// database, which another process may legitimately write) is reported loudly and does not fail.
export function printSideEffectTable(rows, { title, runPath = null } = {}) {
  console.log(`\nD-30-7 / D-37-11 side-effect proof${title ? ` (${title})` : ''}`);
  const verdicts = [];
  const summary = [];
  const moved = [];
  for (const row of rows) {
    const keys = [...new Set([...Object.keys(row.start), ...Object.keys(row.end)])];
    const changed = keys.filter((k) => row.start[k] !== row.end[k]);
    const tables = keys.filter((k) => k.endsWith(' rows')).length;
    summary.push([
      row.name, tables, totalRows(row.start), totalRows(row.end), row.start.digest ?? '-', row.end.digest ?? '-',
      changed.length ? 'CHANGED' : 'unchanged',
    ]);
    for (const k of changed) moved.push([row.name, k, row.start[k] ?? '-', row.end[k] ?? '-']);
    verdicts.push({ row, changed });
  }
  printTable(['database', 'tables', 'rows start', 'rows end', 'digest start', 'digest end', ''], summary);
  if (moved.length) {
    console.log('\nmetrics that moved');
    printTable(['database', 'metric', 'start', 'end'], moved);
  }

  const results = [];
  for (const { row, changed } of verdicts) {
    if (changed.length) {
      const detail = changed.map((k) => `${k} ${row.start[k]} -> ${row.end[k]}`).join('; ');
      if (row.mustNotChange) {
        console.error(`${row.name}: CHANGED -> ${detail}`);
        process.exitCode = 1;
      } else {
        console.warn(
          `WARNING ${row.name}: CHANGED -> ${detail}. This process opened it readonly only, so another ` +
          'process (a dev server, the owner using the app) wrote to it. Reported, not hidden.',
        );
      }
    } else {
      console.log(`${row.name}: UNCHANGED`);
    }
    results.push({ name: row.name, mustNotChange: Boolean(row.mustNotChange), unchanged: changed.length === 0, start: row.start, end: row.end });
  }
  if (runPath) writeFileSync(`${runPath}.d30-7.json`, JSON.stringify({ title, verdicts: results }, null, 2), 'utf8');
  return results;
}
