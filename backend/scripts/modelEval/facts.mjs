// Plan 37 W0 — the document-facts reader, measured in the harness only. One script, four modes.
//
//   cd backend
//   NODE_ENV=test node scripts/modelEval/facts.mjs <source> --census [--sample-size 30] [--sample <path>]
//   NODE_ENV=test node scripts/modelEval/facts.mjs <source> --profile facts-haiku-55-medium [--only key,key] [--limit n] [--concurrency 3] [--max-usd 8]
//   NODE_ENV=test node scripts/modelEval/facts.mjs --sheets --run <a.jsonl,b.jsonl,...> [--sample <path>] [--out <dir>]
//
//   <source> is exactly one of
//     --fixtures      the committed synthetic fixtures, fixtures/facts/<id>.json (renderFactsFixtures.mjs)
//     --private       the owner's private fixtures, data/model-eval/private/facts/<id>/fixture.json
//     --db <path>     a production backup copy (data/model-eval/private/db/prod-<date>.db), read-only
//   A fixture is { id, trip?, tripTitle?, bookingContext: { bookings: [{ type, title, startDatetime,
//   endDatetime, originTz, destinationTz }], trip: { startDate, endDate } }, files: [{ kind: text | image
//   | pdf, mediaType?, path }], expected? }; `path` is relative to the manifest's folder. Each file is
//   one document, keyed fixture:<id>/<n> or private:<id>/<n> (n is 1-based).
//
// Modes
//   --census    No API call. Trips, documents by kind and language guess, bookings, duplicates, the
//               document-rich trip count (Plan 37 §5 threshold: three trips with eight or more
//               documents) and the deterministic grading sample, written to private/facts/sample.json.
//               Prints counts, titles and filenames only — never a quote or any document text. A
//               fixture source writes no sample unless --sample names the file.
//   (default)   The paid run: one Messages call per document with the live-to-be prompt and schema
//               (lib/factsContract.mjs) under the named facts profile. One record per document in
//               data/model-eval/runs/facts/<profile>/<timestamp>.jsonl, then the W0 step 3 table.
//               Stops with exit code 2 when the --max-usd spend guard trips.
//   --sheets    No API call. Blind grading sheets for the sampled documents from the run files:
//               model hidden behind a letter code, key.json maps codes to runs, a README explains the
//               grading. Output: <out>/facts-<timestamp>/ (default out: private/facts/grading).
//
// D-37-11 guarantee: a --db source is opened ONLY through openSourceReadonly(); this script has no code
// path that writes to it, and none that opens the dev database except readonly counting. Every mode
// ends with the D-30-7 side-effect table (the source copy and the dev database counted at the start and
// the end; the copy must not change) and a name-only listing of the private directory. Run files and
// grading sheets hold parsed facts, quotes and hashes — never document bytes — and the recorder
// redacts request and response text for every non-fixture source. A text layer pdfjs cannot read is
// recorded (extra.textLayerError) and printed, never skipped.
//
// FACTS_GRADING_DIR is read by lib/score/facts.mjs, not here.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../src/config.js';
import { installRecorder, recordFixture } from './lib/recorder.mjs';
import {
  FIXTURES_DIR, PRIVATE_DIR, parseArgs, openRunFile, readRunFile, buildRecord, runPool, filterItems, printProgress,
} from './lib/runner.mjs';
import { getProfile, toServiceProfile } from './profiles.mjs';
import {
  COSTLY_FACT_KINDS, FACTS_PROMPT_VERSION, buildFactsRequest, classifyFactsResponse, findQuote,
} from './lib/factsContract.mjs';
import { dedupeByContent, factsContextFor, listCorpusDocuments, readDocumentContent } from './lib/factsCorpus.mjs';
import {
  countAllTables, countDevDb, openSourceReadonly, printSideEffectTable,
} from './lib/sourceDb.mjs';
import { documentPages, guessLanguage, textLayerSummary } from './lib/documentText.mjs';
import { max, median, sum } from './lib/score/common.mjs';

const WORKLOAD = 'facts';
const PRIVATE_FACTS_DIR = join(PRIVATE_DIR, 'facts');
const DEFAULT_SAMPLE = join(PRIVATE_FACTS_DIR, 'sample.json');
const DEFAULT_GRADING_DIR = join(PRIVATE_FACTS_DIR, 'grading');
const DOCUMENT_RICH_MIN = 8;
const DOCUMENT_RICH_TRIPS_NEEDED = 3;
const SAMPLE_IMAGE_CAP = 20;
const COSTLY = new Set(COSTLY_FACT_KINDS);
const FLAGS = new Set(['fixtures', 'private', 'census', 'sheets']);
const VALUE_FLAGS = ['--db', '--run', '--sample', '--sample-size', '--out'];
const DEFAULT_MEDIA_TYPE = { text: 'text/plain', pdf: 'application/pdf' };
const IMAGE_MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const frac = (n, d) => `${n}/${d} (${pct(n, d)})`;

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

// parseArgs (lib/runner.mjs) treats every non-flag token as an error, so the value flags are taken
// out first. Unknown boolean flags are an error here: a typo such as --cencus must not start a paid run.
function readArgs() {
  const values = {};
  const rest = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      values[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      rest.push(a);
    }
  }
  const args = parseArgs(rest);
  for (const flag of args.flags) if (!FLAGS.has(flag)) throw new Error(`unknown flag --${flag}`);
  return { args, values };
}

function chooseMode(args, values) {
  const census = args.flags.has('census');
  const sheets = args.flags.has('sheets');
  if (census && sheets) throw new Error('--census and --sheets are separate modes');
  const sources = [];
  if (args.flags.has('fixtures')) sources.push('fixture');
  if (args.flags.has('private')) sources.push('private');
  if (values.db) sources.push('db');

  if (sheets) {
    if (sources.length) throw new Error('--sheets reads run files; it takes no document source');
    if (!values.run) throw new Error('--sheets needs --run <a.jsonl,b.jsonl,...>');
    return { mode: 'sheets', source: null };
  }
  for (const stray of ['run', 'out']) if (values[stray]) throw new Error(`--${stray} belongs to --sheets`);
  if (sources.length !== 1) {
    throw new Error('name exactly one document source: --fixtures, --private or --db <path>');
  }
  if (census) return { mode: 'census', source: sources[0] };
  if (values.sample || values['sample-size']) throw new Error('--sample and --sample-size belong to --census (and --sample to --sheets)');
  return { mode: 'run', source: sources[0] };
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

// Every source becomes the same document shape as lib/factsCorpus.mjs, plus
//   origin    'db' | 'private' | 'fixture'  (what extra.source records)
//   context   the booking context buildFactsRequest takes
//   expected  the fixture's label block, or null
//   load()    the bytes, read lazily: { kind, mediaType, content, bytes }

function fixtureDocuments(fixture, folder, origin) {
  const where = `${origin} fixture "${fixture.id}"`;
  if (!Array.isArray(fixture.files) || !fixture.files.length) throw new Error(`${where}: files must be a non-empty array`);
  if (!fixture.bookingContext?.bookings?.length) throw new Error(`${where}: bookingContext.bookings must list at least one booking`);
  const tripId = fixture.trip ?? fixture.id;
  return fixture.files.map((file, i) => {
    if (!['text', 'image', 'pdf'].includes(file.kind)) throw new Error(`${where}: file ${i + 1} has kind "${file.kind}"`);
    if (!file.path) throw new Error(`${where}: file ${i + 1} has no path`);
    const bytes = readFileSync(resolve(folder, file.path));
    const mediaType = file.mediaType ?? DEFAULT_MEDIA_TYPE[file.kind] ?? IMAGE_MEDIA_TYPES[extname(file.path).toLowerCase()];
    if (!mediaType) throw new Error(`${where}: file ${i + 1} needs a mediaType`);
    const kind = file.kind;
    return {
      key: `${origin}:${fixture.id}/${i + 1}`,
      origin,
      source: origin,
      tripId,
      tripTitle: fixture.tripTitle ?? tripId,
      tripStartDate: fixture.bookingContext.trip?.startDate ?? null,
      tripEndDate: fixture.bookingContext.trip?.endDate ?? null,
      bookingIds: [],
      bookings: fixture.bookingContext.bookings,
      kind,
      mediaType,
      filename: basename(file.path),
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
      attachmentSource: null,
      aliasKeys: [],
      context: fixture.bookingContext,
      expected: fixture.expected ?? null,
      load: async () => ({ kind, mediaType, content: kind === 'text' ? bytes.toString('utf8') : bytes.toString('base64'), bytes }),
    };
  });
}

// One read per (trip, content), D-37-1: later copies of the same bytes in a trip fold into the first.
function foldFixtureDuplicates(docs) {
  const out = [];
  const seen = new Map();
  for (const doc of docs) {
    const group = `${doc.tripId}|${doc.contentHash}`;
    const first = seen.get(group);
    if (first) first.aliasKeys.push(doc.key);
    else {
      seen.set(group, doc);
      out.push(doc);
    }
  }
  return out;
}

function loadFixtureSource(origin) {
  const docs = [];
  if (origin === 'fixture') {
    const dir = join(FIXTURES_DIR, WORKLOAD);
    if (!existsSync(dir)) throw new Error(`${dir} does not exist; run renderFactsFixtures.mjs`);
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      docs.push(...fixtureDocuments(JSON.parse(readFileSync(join(dir, name), 'utf8')), dir, origin));
    }
  } else {
    mkdirSync(PRIVATE_FACTS_DIR, { recursive: true });
    const entries = readdirSync(PRIVATE_FACTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'grading')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const folder = join(PRIVATE_FACTS_DIR, entry.name);
      const manifest = join(folder, 'fixture.json');
      if (!existsSync(manifest)) continue;
      const fixture = JSON.parse(readFileSync(manifest, 'utf8'));
      docs.push(...fixtureDocuments({ ...fixture, id: fixture.id ?? entry.name }, folder, origin));
    }
  }
  const documents = foldFixtureDuplicates(docs);
  return { documents, rawCount: docs.length, orphanImportFiles: null, tripsInDb: null, bookingCounts: null };
}

function loadDbSource(db) {
  const { documents: raw, orphanImportFiles } = listCorpusDocuments(db);
  const documents = dedupeByContent(raw).map((doc) => ({
    ...doc,
    origin: 'db',
    context: factsContextFor(doc),
    expected: null,
    load: async () => readDocumentContent(db, doc),
  }));
  const bookingCounts = new Map(
    db.prepare('SELECT trip_id, COUNT(*) AS n FROM bookings GROUP BY trip_id').all().map((r) => [r.trip_id, r.n]),
  );
  const tripsInDb = db.prepare('SELECT COUNT(*) AS n FROM trips').get().n;
  return { documents, rawCount: raw.length, orphanImportFiles, tripsInDb, bookingCounts };
}

// The text layer of one document: { pages, textLayer, language, error }. `pages` is null for an
// image and for a PDF pdfjs cannot open; the error names the document and is never swallowed — the
// caller records and prints it.
async function analyse(doc, content) {
  if (doc.kind === 'image') return { pages: null, textLayer: null, language: 'image', error: null };
  try {
    const { pages } = await documentPages(doc, content);
    const textLayer = textLayerSummary(pages);
    return { pages, textLayer, language: textLayer.hasText ? guessLanguage(pages.join('\n')) : 'unknown', error: null };
  } catch (err) {
    return { pages: null, textLayer: null, language: 'unknown', error: err.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Side-effect proof (D-30-7 / D-37-11) and the private tree
// ---------------------------------------------------------------------------------------------

function listTree(dir, depth, indent = '  ', lines = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const shown = entries.slice(0, 40);
  for (const entry of shown) {
    lines.push(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory() && depth > 1) listTree(join(dir, entry.name), depth - 1, `${indent}  `, lines);
  }
  if (entries.length > shown.length) lines.push(`${indent}... (+${entries.length - shown.length} more)`);
  return lines;
}

function printPrivateTree() {
  console.log(`\nprivate directory (names only; run files and sheets stay under ${PRIVATE_DIR}):`);
  if (!existsSync(PRIVATE_DIR)) {
    console.log('  (does not exist)');
    return;
  }
  for (const line of listTree(PRIVATE_DIR, 3)) console.log(line);
}

// Counts at the start, the work, counts at the end, then the table — also when the work throws, so a
// failed run still shows nothing was written. `work` returns { runPath? }.
async function withSideEffectProof({ sourceDb, sourcePath, title }, work) {
  const rows = [];
  if (sourceDb) {
    rows.push({ name: `source copy ${sourcePath} (opened readonly)`, start: countAllTables(sourceDb), end: null, mustNotChange: true });
  }
  rows.push({ name: 'dev database (counted readonly; owner data)', start: countDevDb(), end: null, mustNotChange: false });

  let outcome = { runPath: null };
  let failure = null;
  try {
    outcome = (await work()) ?? outcome;
  } catch (err) {
    failure = err;
  }
  if (sourceDb) {
    rows[0].end = countAllTables(sourceDb);
    sourceDb.close();
  }
  rows.at(-1).end = countDevDb();
  printSideEffectTable(rows, { title, runPath: outcome.runPath });
  printPrivateTree();
  if (failure) throw failure;
}

// ---------------------------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------------------------

function padTable(header, body) {
  const widths = header.map((h, i) => Math.max(String(h).length, ...body.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of body) console.log(line(r));
}

const count = (items, keyOf) => {
  const out = {};
  for (const item of items) {
    const k = keyOf(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};
const fmtCounts = (obj) => Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ') || '-';

// Deterministic grading sample (Plan 37 §5): every image first (the B1 vision comparison needs the
// image subset), up to 20; then round-robin over (kind, language, source) strata, rarest stratum
// first; document-rich trips before the rest, ties broken by sha256(key).
function selectSample(rows, size, richTripIds) {
  const hashOf = new Map(rows.map((r) => [r.doc.key, sha256(r.doc.key)]));
  const order = (a, b) => {
    const rich = Number(richTripIds.has(b.doc.tripId)) - Number(richTripIds.has(a.doc.tripId));
    if (rich) return rich;
    return hashOf.get(a.doc.key) < hashOf.get(b.doc.key) ? -1 : 1;
  };
  const sorted = [...rows].sort(order);
  const chosen = sorted.filter((r) => r.doc.kind === 'image').slice(0, Math.min(SAMPLE_IMAGE_CAP, size));
  const taken = new Set(chosen.map((r) => r.doc.key));

  const strata = new Map();
  for (const r of sorted) {
    if (taken.has(r.doc.key)) continue;
    const stratum = `${r.doc.kind}|${r.language}|${r.doc.source}`;
    if (!strata.has(stratum)) strata.set(stratum, []);
    strata.get(stratum).push(r);
  }
  const queues = [...strata.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
  while (chosen.length < size && queues.some(([, q]) => q.length)) {
    for (const [, queue] of queues) {
      if (chosen.length >= size) break;
      const next = queue.shift();
      if (next) chosen.push(next);
    }
  }
  return chosen;
}

async function censusMode({ source, loaded, values, dbPath }) {
  const { documents, rawCount, orphanImportFiles, tripsInDb, bookingCounts } = loaded;
  const sampleSize = values['sample-size'] ? parseInt(values['sample-size'], 10) : 30;
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error('--sample-size must be a positive integer');

  console.log(`\ncensus / source ${source}${dbPath ? ` (${dbPath})` : ''} — no API call, no document text printed`);

  const rows = [];
  for (const doc of documents) {
    const content = await doc.load();
    const analysis = await analyse(doc, content);
    rows.push({ doc, language: analysis.language, textLayer: analysis.textLayer, error: analysis.error });
  }

  const trips = new Map();
  for (const r of rows) {
    if (!trips.has(r.doc.tripId)) trips.set(r.doc.tripId, []);
    trips.get(r.doc.tripId).push(r);
  }

  const tripRows = [...trips.entries()].map(([tripId, list]) => {
    const first = list[0].doc;
    const bookingIds = new Set(list.flatMap((r) => r.doc.bookingIds));
    const bookings = bookingCounts ? (bookingCounts.get(tripId) ?? 0) : new Set(list.flatMap((r) => r.doc.bookings.map((b) => `${b.title}|${b.startDatetime}`))).size;
    const pdfs = list.filter((r) => r.doc.kind === 'pdf');
    return {
      tripId,
      title: first.tripTitle,
      dates: `${first.tripStartDate ?? '?'} to ${first.tripEndDate ?? '?'}`,
      bookings,
      backed: bookingIds.size,
      unique: list.length,
      raw: list.length + sum(list.map((r) => r.doc.aliasKeys.length)),
      kinds: count(list, (r) => r.doc.kind),
      att: count(list.filter((r) => r.doc.source === 'attachment'), (r) => r.doc.attachmentSource ?? 'unknown'),
      imports: list.filter((r) => r.doc.source === 'import').length,
      languages: count(list, (r) => r.language),
      pdfPages: sum(pdfs.map((r) => r.textLayer?.pages ?? 0)),
      pdfNoText: pdfs.filter((r) => r.textLayer && !r.textLayer.hasText).length,
      pdfUnreadable: pdfs.filter((r) => r.error).length,
    };
  }).sort((a, b) => b.unique - a.unique || a.title.localeCompare(b.title));

  console.log('\nPer trip (unique-content documents; "raw" counts the folded copies too):');
  padTable(
    ['trip', 'dates', 'bookings', 'raw', 'unique', 'text/image/pdf', 'att manual/mcp', 'import', 'languages', 'pdf pages', 'pdf no text', 'pdf unreadable'],
    tripRows.map((t) => [
      t.title.length > 30 ? `${t.title.slice(0, 29)}…` : t.title,
      t.dates, t.bookings, t.raw, t.unique,
      `${t.kinds.text ?? 0}/${t.kinds.image ?? 0}/${t.kinds.pdf ?? 0}`,
      `${t.att.manual ?? 0}/${t.att.mcp ?? 0}`,
      t.imports, fmtCounts(t.languages), t.pdfPages, t.pdfNoText, t.pdfUnreadable,
    ]),
  );
  if (tripsInDb !== null) console.log(`(${tripsInDb - tripRows.length} of ${tripsInDb} trips in the database have no document)`);

  const pdfRows = rows.filter((r) => r.doc.kind === 'pdf');
  const unreadable = rows.filter((r) => r.error);
  console.log('\nTotals:');
  console.log(`  trips with documents ${tripRows.length}; bookings backed by a document ${source === 'db' ? sum(tripRows.map((t) => t.backed)) : 'n/a (fixtures carry no ids)'}`);
  console.log(`  documents: ${rawCount} raw, ${rows.length} unique-content after dedupe, ${rawCount - rows.length} duplicate copies folded`);
  console.log(`  by kind: ${fmtCounts(count(rows, (r) => r.doc.kind))}`);
  console.log(`  by source: ${fmtCounts(count(rows, (r) => r.doc.source))}`);
  console.log(`  attachments by origin: ${fmtCounts(count(rows.filter((r) => r.doc.source === 'attachment'), (r) => r.doc.attachmentSource ?? 'unknown'))}`);
  console.log(`  languages (script heuristic on the text layer): ${fmtCounts(count(rows, (r) => r.language))}`);
  console.log(`  PDF pages ${sum(pdfRows.map((r) => r.textLayer?.pages ?? 0))}; PDFs without a text layer ${pdfRows.filter((r) => r.textLayer && !r.textLayer.hasText).length}; PDFs pdfjs could not read ${unreadable.length}`);
  for (const r of unreadable) console.log(`  UNREADABLE ${r.error}`);
  if (orphanImportFiles) {
    console.log(`  import files backing no booking, by artifact status: ${fmtCounts(orphanImportFiles)} (not documents of any booking)`);
  }

  const rich = tripRows.filter((t) => t.unique >= DOCUMENT_RICH_MIN);
  console.log(`\nDocument-rich trips (>= ${DOCUMENT_RICH_MIN} unique-content documents): ${rich.length}`);
  for (const t of rich) console.log(`  ${t.title}: ${t.unique}`);
  console.log(
    rich.length < DOCUMENT_RICH_TRIPS_NEEDED
      ? `VERDICT: fewer than three document-rich trips -> pause for private fixtures (Q-37-1), then re-run the census.`
      : `VERDICT: enough document-rich trips (${rich.length} >= ${DOCUMENT_RICH_TRIPS_NEEDED}).`,
  );

  // The grading sample.
  const richIds = new Set(rich.map((t) => t.tripId));
  const chosen = selectSample(rows, sampleSize, richIds);
  const strata = count(chosen, (r) => `${r.doc.kind}|${r.language}|${r.doc.source}`);
  console.log(`\nGrading sample: ${chosen.length} of ${rows.length} documents (requested ${sampleSize}; images first, up to ${SAMPLE_IMAGE_CAP})`);
  console.log(`  by kind: ${fmtCounts(count(chosen, (r) => r.doc.kind))}`);
  console.log(`  by language: ${fmtCounts(count(chosen, (r) => r.language))}`);
  console.log(`  from document-rich trips: ${chosen.filter((r) => richIds.has(r.doc.tripId)).length}`);
  console.log('  strata (kind|language|source):');
  for (const [k, v] of Object.entries(strata).sort(([a], [b]) => a.localeCompare(b))) console.log(`    ${k}  ${v}`);
  if (chosen.length < sampleSize) console.log(`  NOTE: only ${chosen.length} documents exist; the sample is everything.`);

  const samplePath = values.sample ? resolve(values.sample) : (source === 'fixture' ? null : DEFAULT_SAMPLE);
  if (!samplePath) {
    console.log('\nsample not written (fixture source); pass --sample <path> to write one.');
  } else {
    mkdirSync(dirname(samplePath), { recursive: true });
    writeFileSync(samplePath, `${JSON.stringify({
      createdAt: new Date().toISOString(),
      source,
      dbPath,
      sampleSize: chosen.length,
      keys: chosen.map((r) => r.doc.key),
      strata,
    }, null, 2)}\n`, 'utf8');
    console.log(`\nsample written: ${samplePath}`);
  }
  return { runPath: null };
}

// ---------------------------------------------------------------------------------------------
// The facts run
// ---------------------------------------------------------------------------------------------

function verifyFacts(pages, facts) {
  return facts.map((fact, index) => {
    const found = findQuote(pages, fact.quote);
    return { index, found: found.found, page: found.page };
  });
}

function factCounts(facts, verification) {
  const verified = (i) => verification?.[i]?.found === true;
  const counts = {
    facts: facts.length,
    costly: facts.filter((f) => COSTLY.has(f.kind)).length,
    verified: verification ? verification.filter((v) => v.found).length : 0,
    costlyVerified: facts.filter((f, i) => COSTLY.has(f.kind) && verified(i)).length,
    pageStated: facts.filter((f) => f.page !== '').length,
    pageAgree: 0,
    pageDisagree: 0,
  };
  facts.forEach((f, i) => {
    if (f.page === '' || !verified(i)) return;
    if (Number(f.page) === verification[i].page) counts.pageAgree += 1;
    else counts.pageDisagree += 1;
  });
  return counts;
}

function printRunSummary(records) {
  const done = records.filter((r) => r.extra);
  const usable = (r) => r.extra.outcome === 'complete';
  const withLayer = done.filter((r) => usable(r) && r.extra.textLayer?.hasText);
  const total = (list, key) => sum(list.map((r) => r.extra.counts[key]));
  const factsPerDoc = done.filter(usable).map((r) => r.extra.counts.facts);

  const summaryRows = [
    ['documents', done.length],
    ['outcomes', fmtCounts(count(done, (r) => r.extra.outcome))],
    ['stop_reason', fmtCounts(count(done, (r) => r.stopReason ?? (r.error ? 'error' : 'none')))],
    ['facts total', total(done, 'facts')],
    ['facts per document median / max', `${median(factsPerDoc)} / ${max(factsPerDoc)}`],
    ['costly-kind facts (deadline/window/requirement)', total(done, 'costly')],
    ['verification on text-layer documents', frac(total(withLayer, 'verified'), total(withLayer, 'facts'))],
    ['costly verification on text-layer documents', frac(total(withLayer, 'costlyVerified'), total(withLayer, 'costly'))],
    ['text-layer documents / without a text layer', `${withLayer.length} / ${done.filter((r) => !r.extra.textLayer?.hasText).length}`],
    ['page agree / disagree (model page vs found page)', `${total(done, 'pageAgree')} / ${total(done, 'pageDisagree')}`],
    ['largest output tokens', max(done.map((r) => r.usage.output_tokens))],
    ['cost per document median / max ($)', `${(median(done.map((r) => r.costUsd)) ?? 0).toFixed(5)} / ${(max(done.map((r) => r.costUsd)) ?? 0).toFixed(5)}`],
    ['run cost ($)', sum(done.map((r) => r.costUsd)).toFixed(4)],
  ];
  console.log('\nFacts run summary (Plan 37 W0 step 3)');
  padTable(['metric', 'value'], summaryRows);

  const kinds = [...new Set(done.map((r) => r.extra.kind))].sort();
  console.log('\nBy document kind');
  padTable(
    ['kind', 'documents', 'complete', 'facts', 'costly', 'verified / facts (text layer)', 'cost median ($)', 'output tok max'],
    kinds.map((kind) => {
      const list = done.filter((r) => r.extra.kind === kind);
      const layer = list.filter((r) => usable(r) && r.extra.textLayer?.hasText);
      return [
        kind, list.length, list.filter(usable).length, total(list, 'facts'), total(list, 'costly'),
        layer.length ? frac(total(layer, 'verified'), total(layer, 'facts')) : 'no text layer',
        (median(list.map((r) => r.costUsd)) ?? 0).toFixed(5),
        max(list.map((r) => r.usage.output_tokens)),
      ];
    }),
  );
}

async function runMode({ args, source, loaded, dbPath }) {
  const profile = getProfile(WORKLOAD, args.profile);
  const serviceProfile = toServiceProfile(profile);
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set (backend/.env); a facts run needs it');

  let documents = loaded.documents;
  if (profile.subset === 'image') documents = documents.filter((d) => d.kind === 'image');
  documents = filterItems(documents, args, (d) => d.key);
  if (!documents.length) throw new Error('no documents selected');

  // The recorder first, so the client's calls are the ones recorded.
  installRecorder();
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
  const runFile = openRunFile(WORKLOAD, args.profile);
  const runId = basename(runFile.path, '.jsonl');
  console.log(
    `facts / ${args.profile} (${profile.model}): ${documents.length} documents from ${source}${dbPath ? ` ${dbPath}` : ''}, ` +
    `prompt ${FACTS_PROMPT_VERSION}, concurrency ${args.concurrency}, --max-usd ${args.maxUsd}`,
  );
  console.log('D-37-11: the source is read-only; only the Anthropic API is called. Request and response text is redacted for non-fixture sources.');

  const records = [];

  async function runOne(doc) {
    const content = await doc.load();
    const analysis = await analyse(doc, content);
    if (analysis.error) console.error(`TEXT LAYER UNREADABLE ${analysis.error}`);

    const recorded = await recordFixture(
      () => client.messages.create(buildFactsRequest(serviceProfile, { context: doc.context, document: content })),
      { redactText: doc.origin !== 'fixture' },
    );
    const classified = recorded.error ? null : classifyFactsResponse(recorded.result);
    const facts = classified?.value?.facts ?? [];
    const verification = analysis.textLayer?.hasText && facts.length ? verifyFacts(analysis.pages, facts) : null;

    const record = buildRecord({
      workload: WORKLOAD,
      profileName: args.profile,
      profile: serviceProfile,
      fixtureId: doc.key,
      recorded,
      output: classified?.value ?? null,
      extra: {
        runId,
        source: doc.origin,
        dbPath,
        tripId: doc.tripId,
        tripTitle: doc.tripTitle,
        bookingIds: doc.bookingIds,
        bookings: doc.bookings,
        aliasKeys: doc.aliasKeys,
        kind: doc.kind,
        mediaType: doc.mediaType,
        filename: doc.filename,
        contentHash: doc.contentHash,
        attachmentSource: doc.attachmentSource,
        promptVersion: FACTS_PROMPT_VERSION,
        outcome: classified ? classified.outcome : 'error',
        stopReason: classified?.stopReason ?? null,
        refusalCategory: classified?.category ?? null,
        validationError: classified?.outcome === 'invalid' ? classified.error : null,
        parsedOnInvalid: classified?.outcome === 'invalid' ? classified.parsed : null,
        textLayer: analysis.textLayer,
        textLayerError: analysis.error,
        languageGuess: analysis.language,
        verification,
        counts: factCounts(facts, verification),
        expected: doc.expected,
      },
    });
    runFile.write(record);
    return record;
  }

  const summary = await runPool(documents, runOne, {
    concurrency: args.concurrency,
    maxUsd: args.maxUsd,
    onRecord: (record, progress) => {
      records.push(record);
      printProgress(record, progress);
      const { outcome, counts, textLayer } = record.extra;
      const verifiedNote = textLayer?.hasText ? `${counts.verified}/${counts.facts} verified` : 'not verifiable (no text layer)';
      console.log(`      outcome=${outcome} facts=${counts.facts} costly=${counts.costly} ${verifiedNote}${record.extra.validationError ? ` invalid: ${record.extra.validationError}` : ''}`);
    },
  });

  console.log(`\nrun file: ${runFile.path}`);
  console.log(`done ${summary.done}/${summary.total}, spent $${summary.spent.toFixed(4)}`);
  printRunSummary(records);
  if (summary.stopped) {
    console.log(`STOPPED by the spend guard: ${summary.stopped}`);
    if (!process.exitCode) process.exitCode = 2;
  }
  return { runPath: runFile.path };
}

// ---------------------------------------------------------------------------------------------
// Blind grading sheets
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

function originLine(extra, key) {
  if (key.startsWith('artifactFile:')) return extra.kind === 'text' ? 'pasted confirmation (import)' : 'import file (a document sent through capture)';
  if (key.startsWith('attachment:')) return `attachment${extra.attachmentSource ? ` (${extra.attachmentSource})` : ''}`;
  return extra.source;
}

function sheetFor({ code, key, record }) {
  const { extra } = record;
  const titles = (extra.bookings ?? []).map((b) => b.title).filter(Boolean);
  const lines = [
    `# Sheet ${code}`,
    '',
    `- Document key: \`${key}\``,
    `- Trip: ${cell(extra.tripTitle)}`,
    `- Bookings: ${(extra.bookings ?? []).map((b) => `${cell(b.title)} (${b.startDatetime ? String(b.startDatetime).slice(0, 10) : 'no start date'})`).join('; ') || 'none'}`,
    `- Kind: ${extra.kind}; file: ${cell(extra.filename) || 'none'}`,
    `- Source: ${originLine(extra, key)}`,
    extra.kind === 'text'
      ? '- Open it: a pasted confirmation has no viewer; read the text you pasted into the original import.'
      : `- Open it in Trippy: Trip → Logistics → ${titles.length ? titles.map(cell).join(' or ') : '<booking>'} → Documents`,
    `- Run outcome: ${extra.outcome}`,
    '',
  ];
  const facts = record.output?.facts ?? [];
  if (extra.outcome !== 'complete') {
    lines.push(`This run did not return facts for this document (${extra.outcome}). Nothing to mark; list what the document holds under "Missing costly facts".`, '');
  } else if (!facts.length) {
    lines.push('This run returned no facts for this document. Mark nothing; list what the document holds under "Missing costly facts".', '');
  } else {
    // `at` and the zone are what Due counts down to (D-37-6, D-37-10), so a wrong time or a zone
    // credited to the wrong source must be visible to the grader, not only the English value.
    lines.push('| # | mark | kind | label | value | at | zone | quote | page | verified |', '|---|---|---|---|---|---|---|---|---|---|');
    facts.forEach((fact, i) => {
      const v = extra.verification?.[i];
      const verified = !v ? 'no text layer' : v.found ? `p.${v.page}` : 'not found';
      const zone = fact.tzSource === 'none' ? 'not stated' : `${cell(fact.tz) || '—'} (from ${fact.tzSource})`;
      lines.push(`| ${i + 1} |  | ${fact.kind} | ${cell(fact.label)} | ${cell(fact.value)} | ${fact.at || '—'} | ${zone} | ${cell(fact.quote)} | ${fact.page || '—'} | ${verified} |`);
    });
    lines.push('');
  }
  lines.push(
    '## Missing costly facts',
    '',
    'A deadline, window or requirement that is in the document but absent from the table above. One per line, as `- missing: deadline: <what>` (kind is deadline, window or requirement). Add lines as needed.',
    '',
    '- missing: ',
    '- missing: ',
    '- missing: ',
    '',
    '## Notes',
    '',
  );
  return `${lines.join('\n')}\n`;
}

const GRADING_README = `# Grading the facts sheets

Grade blind. Each sheet is one model's reading of one document, named by a letter code. Do not open
key.json until every sheet is marked: it says which code is which model.

For each sheet, open the document in Trippy (the path is on the sheet) and compare:

1. **Mark every row** in the \`mark\` column: \`y\` if the fact is correct against the document (the
   quote is really there, the label and value say what the document says, the \`at\` date and time
   are the moment the document means, the zone is right and credited to the right source, the page
   is right), \`n\` if it is wrong in any way that would mislead a traveller. ✓ and ✗ are accepted too. A blank row
   counts as ungraded and is left out of the numbers.
2. **List what is missing.** Under "Missing costly facts", add one \`- missing: <kind>: <what>\` line
   for each costly fact the document states that the sheet does not list. Costly kinds are
   **deadline**, **window** and **requirement**. "Missing" means present in the document but absent
   from the sheet. Leave the empty \`- missing:\` lines as they are when nothing is missing.
3. Use Notes for anything odd (a quote that looks right but is cut, a wrong time zone, a fact filed
   under the wrong kind). Notes are not scored.

When every sheet is marked, run \`node scripts/modelEval/score.mjs facts --run <run file>\` for one run's
G-37-1 numbers, or \`score.mjs facts --profile facts-haiku-55-medium,facts-sonnet-55-medium,facts-sonnet-46-medium\`
for each profile's latest run side by side with the B1 / B2 comparisons.
`;

function sheetsMode({ values }) {
  const runPaths = values.run.split(',').map((p) => resolve(p.trim())).filter(Boolean);
  const runs = runPaths.map((path) => {
    const records = readRunFile(path);
    if (!records.length) throw new Error(`${path} holds no records`);
    const byKey = new Map(records.map((r) => [r.fixtureId, r]));
    return {
      path,
      records,
      byKey,
      runId: records[0].extra?.runId ?? basename(path, '.jsonl'),
      profile: records[0].profile,
      model: records[0].model,
    };
  });
  if (runs.length > 26) throw new Error('at most 26 runs (codes A-Z)');

  const samplePath = values.sample ? resolve(values.sample) : DEFAULT_SAMPLE;
  let keys;
  if (existsSync(samplePath)) {
    keys = JSON.parse(readFileSync(samplePath, 'utf8')).keys;
    console.log(`sample: ${keys.length} documents from ${samplePath}`);
  } else {
    if (values.sample) throw new Error(`--sample ${samplePath} does not exist`);
    keys = [...runs[0].byKey.keys()].filter((k) => runs.every((r) => r.byKey.has(k)));
    console.log(`no sample file at ${samplePath}; using the ${keys.length} documents present in every run`);
  }

  const createdAt = new Date();
  const seed = createdAt.getTime() % 2147483647;
  const rand = mulberry32(seed);
  const shuffled = [...runs];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const codes = {};
  shuffled.forEach((run, i) => {
    codes[String.fromCharCode(65 + i)] = { runId: run.runId, runFile: run.path, profile: run.profile, model: run.model, run };
  });

  const outRoot = join(values.out ? resolve(values.out) : DEFAULT_GRADING_DIR, `facts-${timestampSlug(createdAt)}`);
  mkdirSync(outRoot, { recursive: true });

  const documents = [];
  let sheetCount = 0;
  keys.forEach((key, index) => {
    const slugKind = [...runs.map((r) => r.byKey.get(key))].find(Boolean)?.extra.kind;
    if (!slugKind) {
      console.warn(`skipping ${key}: no run has it`);
      return;
    }
    const slug = `${String(index + 1).padStart(2, '0')}-${slugKind}`;
    const dir = join(outRoot, slug);
    mkdirSync(dir, { recursive: true });
    let describe = null;
    for (const [code, entry] of Object.entries(codes)) {
      const record = entry.run.byKey.get(key);
      if (!record) continue;
      writeFileSync(join(dir, `${code}.md`), sheetFor({ code, key, record }), 'utf8');
      sheetCount += 1;
      describe ??= record.extra;
    }
    documents.push({
      slug, key, aliasKeys: describe.aliasKeys ?? [], tripId: describe.tripId, tripTitle: describe.tripTitle,
      kind: describe.kind, filename: describe.filename,
    });
  });

  const keyCodes = Object.fromEntries(Object.entries(codes).map(([code, { run, ...rest }]) => [code, rest]));
  writeFileSync(join(outRoot, 'key.json'), `${JSON.stringify({ createdAt: createdAt.toISOString(), seed, codes: keyCodes, documents }, null, 2)}\n`, 'utf8');
  writeFileSync(join(outRoot, 'README.md'), GRADING_README, 'utf8');
  console.log(`\n${sheetCount} sheets for ${documents.length} documents, ${runs.length} runs, codes ${Object.keys(codes).join(', ')}`);
  console.log(`grading folder: ${outRoot}`);
  console.log('Do not open key.json until every sheet is marked. No document bytes are written here (D-37-11).');
  return { runPath: null };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const { args, values } = readArgs();
  const { mode, source } = chooseMode(args, values);

  if (mode === 'sheets') {
    await withSideEffectProof({ sourceDb: null, title: 'facts --sheets' }, async () => sheetsMode({ values }));
    return;
  }

  let sourceDb = null;
  let loaded;
  const dbPath = source === 'db' ? resolve(values.db) : null;
  try {
    if (source === 'db') {
      sourceDb = openSourceReadonly(dbPath);
      loaded = loadDbSource(sourceDb);
    } else {
      loaded = loadFixtureSource(source);
    }
  } catch (err) {
    sourceDb?.close();
    throw err;
  }
  const title = `facts ${mode === 'census' ? '--census' : `--profile ${args.profile}`} (${source})`;
  await withSideEffectProof({ sourceDb, sourcePath: dbPath, title }, async () => (
    mode === 'census'
      ? censusMode({ source, loaded, values, dbPath })
      : runMode({ args, source, loaded, dbPath })
  ));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
