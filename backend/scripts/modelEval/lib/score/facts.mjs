// Facts scoring (Plan 37 W0): the machine metrics of a facts run, and the G-37-1 / B1 / B2 numbers
// once the owner has graded the blind sheets that `facts.mjs --sheets` wrote.
//
// Machine metrics come from the records alone (outcomes, facts per document, quote verification
// against the text layer, page agreement, invalid reasons).
//
// Graded metrics need a grading folder: data/model-eval/private/facts/grading/facts-<timestamp>/ with
// its key.json, or the folder named by the env var FACTS_GRADING_DIR (the directory holding the
// facts-<timestamp> folders, i.e. facts.mjs --out). The run is found through key.json: the code whose
// runId equals this run's `extra.runId`; its sheets are <slug>/<code>.md. If several grading folders
// hold the run (a regrade), the newest key.json wins and the notes say so.
//
// What the owner writes on a sheet:
//   mark column   y / ✓ / 1 = correct, n / ✗ / x / 0 = wrong, blank = not graded
//   `- missing: <kind>: <what>`   a costly fact the document states and the sheet lacks. The kind is
//                 optional; a missing line with no kind, or with deadline / window / requirement,
//                 counts as a costly miss. Empty `- missing:` lines are ignored.
//
// Costly kinds are deadline, window and requirement (lib/factsContract.mjs COSTLY_FACT_KINDS).
//
// G-37-1 (Plan 37 §5): PASS iff costly wrong is at most 3 % of graded costly facts AND missing costly
// facts are at most 10 % counted per fact (missing / (correct + missing)). The plan's "at most 1 in 10"
// can also be read per document; that reading is printed beside the verdict as a note, and the
// orchestrator rules. Nothing is rounded before a threshold is tested.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRIVATE_DIR } from '../runner.mjs';
import { COSTLY_FACT_KINDS, FACT_KINDS } from '../factsContract.mjs';
import { median, max, sum } from './common.mjs';

const COSTLY = new Set(COSTLY_FACT_KINDS);
const KINDS = new Set(FACT_KINDS);
const G1_WRONG_MAX_PCT = 3;
const G1_MISSING_MAX_PCT = 10;
const B2_HAIKU_MARGIN_POINTS = 1.0;

const gradingRoot = () => (process.env.FACTS_GRADING_DIR ? resolve(process.env.FACTS_GRADING_DIR) : join(PRIVATE_DIR, 'facts', 'grading'));

const pct = (n, d) => (d ? (100 * n) / d : null);
const show = (v, digits = 1) => (v === null || v === undefined ? 'n/a' : Number(v.toFixed(digits)));
const frac = (n, d) => (d ? `${n}/${d} (${show(pct(n, d))}%)` : `${n}/${d}`);

// ---------------------------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------------------------

const CORRECT = new Set(['y', 'yes', '✓', '✔', '✔️', '☑', '1', 'ok', 'correct']);
const WRONG = new Set(['n', 'no', '✗', '✘', 'x', '✖', '0', 'wrong']);

function normaliseMark(raw) {
  const mark = String(raw ?? '').trim().toLowerCase();
  if (!mark) return null;
  if (CORRECT.has(mark)) return 'y';
  if (WRONG.has(mark)) return 'n';
  return 'unrecognised';
}

// A markdown table row split on unescaped pipes, without the outer pipes.
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

export function parseSheet(text) {
  const rows = [];
  const missing = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('|')) {
      const cells = splitRow(line);
      if (/^\d+$/.test(cells[0] ?? '')) rows.push({ n: Number(cells[0]), mark: normaliseMark(cells[1]), rawMark: cells[1], kind: cells[2] });
      continue;
    }
    const m = /^\s*[-*]\s*missing\s*:\s*(.*)$/i.exec(line);
    if (!m || !m[1].trim()) continue;
    const typed = /^([a-z_]+)\s*:\s*(.*)$/i.exec(m[1].trim());
    if (typed && KINDS.has(typed[1].toLowerCase())) {
      missing.push({ kind: typed[1].toLowerCase(), text: typed[2].trim() });
    } else {
      missing.push({ kind: null, text: m[1].trim() });
    }
  }
  return { rows, missing };
}

// The newest grading folder whose key.json maps a code to this run.
function findGrading(runId) {
  const root = gradingRoot();
  if (!existsSync(root)) return { found: null, matches: 0, root };
  const hits = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const keyPath = join(root, entry.name, 'key.json');
    if (!existsSync(keyPath)) continue;
    const key = JSON.parse(readFileSync(keyPath, 'utf8'));
    if (!key.codes || !Array.isArray(key.documents)) continue;
    const code = Object.keys(key.codes).find((c) => key.codes[c].runId === runId);
    if (code) hits.push({ dir: join(root, entry.name), key, code });
  }
  hits.sort((a, b) => String(a.key.createdAt).localeCompare(String(b.key.createdAt)));
  return { found: hits.at(-1) ?? null, matches: hits.length, root };
}

function emptyTally() {
  return { docs: 0, docsWithMissing: 0, correct: 0, wrong: 0, missing: 0, otherMissing: 0, factsGraded: 0, factsUngraded: 0 };
}

function addCostly(tally, parsed) {
  tally.docs += 1;
  let docMissing = 0;
  for (const row of parsed.rows) {
    if (row.mark === 'y' || row.mark === 'n') tally.factsGraded += 1;
    else tally.factsUngraded += 1;
    if (!COSTLY.has(row.kind)) continue;
    if (row.mark === 'y') tally.correct += 1;
    else if (row.mark === 'n') tally.wrong += 1;
  }
  for (const miss of parsed.missing) {
    if (miss.kind === null || COSTLY.has(miss.kind)) {
      tally.missing += 1;
      docMissing += 1;
    } else {
      tally.otherMissing += 1;
    }
  }
  if (docMissing) tally.docsWithMissing += 1;
}

const costlyScore = (t) => pct(t.correct, t.correct + t.wrong + t.missing);
const wrongPct = (t) => pct(t.wrong, t.correct + t.wrong);
const missingRate = (t) => pct(t.missing, t.correct + t.missing);

function gradedMetrics(records) {
  const runId = records[0]?.extra?.runId;
  const out = { summary: {}, notes: [], perDoc: new Map() };
  const { found, matches, root } = findGrading(runId);
  if (!found) {
    out.notes.push(`no graded sheets: no key.json under ${root} names run ${runId}. Run facts.mjs --sheets --run <this run file>, grade the sheets, then score again.`);
    return out;
  }
  if (matches > 1) out.notes.push(`${matches} grading folders hold this run; scored the newest (${found.dir}).`);

  const all = emptyTally();
  const images = emptyTally();
  const unrecognised = [];
  const blankSheets = [];
  for (const doc of found.key.documents) {
    const sheet = join(found.dir, doc.slug, `${found.code}.md`);
    if (!existsSync(sheet)) continue;
    const parsed = parseSheet(readFileSync(sheet, 'utf8'));
    for (const row of parsed.rows) if (row.mark === 'unrecognised') unrecognised.push(`${doc.slug}/${found.code}.md row ${row.n}: "${row.rawMark}"`);
    const graded = parsed.rows.some((r) => r.mark === 'y' || r.mark === 'n') || parsed.missing.length > 0;
    if (!graded) {
      blankSheets.push(doc.slug);
      continue;
    }
    addCostly(all, parsed);
    if (doc.kind === 'image') addCostly(images, parsed);
    out.perDoc.set(doc.key, {
      graded: true,
      correct: parsed.rows.filter((r) => r.mark === 'y').length,
      wrong: parsed.rows.filter((r) => r.mark === 'n').length,
      missing: parsed.missing.length,
    });
  }
  if (blankSheets.length) out.notes.push(`${blankSheets.length} sheet(s) not graded and left out: ${blankSheets.join(', ')}`);
  if (unrecognised.length) out.notes.push(`unrecognised marks (counted as not graded): ${unrecognised.join('; ')}`);
  if (all.otherMissing) out.notes.push(`${all.otherMissing} missing line(s) named a non-costly kind and are not in the costly numbers.`);
  if (!all.docs) {
    out.notes.push(`grading folder ${found.dir} found for code ${found.code}, but no sheet has a mark or a missing line yet.`);
    return out;
  }

  const wrong = wrongPct(all);
  const miss = missingRate(all);
  const g1 = wrong !== null && miss !== null && wrong <= G1_WRONG_MAX_PCT && miss <= G1_MISSING_MAX_PCT;
  const docMissingPct = pct(all.docsWithMissing, all.docs);
  out.summary = {
    'grading folder / code': `${found.dir} / ${found.code}`,
    'graded documents': all.docs,
    'facts graded / ungraded': `${all.factsGraded} / ${all.factsUngraded}`,
    'costly correct / wrong / missing': `${all.correct} / ${all.wrong} / ${all.missing}`,
    'costly wrong (%)': show(wrong),
    'missing rate, per fact (%)': show(miss),
    'documents with any missing costly fact': frac(all.docsWithMissing, all.docs),
    'costly score (%)': show(costlyScore(all), 2),
    'costly score, images only (%)': images.docs ? show(costlyScore(images), 2) : 'n/a',
    'costly correct / wrong / missing, images only': images.docs ? `${images.correct} / ${images.wrong} / ${images.missing}` : 'n/a',
    'G-37-1': wrong === null || miss === null
      ? 'n/a (no graded costly facts)'
      : `${g1 ? 'PASS' : 'FAIL'} (wrong ${show(wrong)}% <= ${G1_WRONG_MAX_PCT}, missing per fact ${show(miss)}% <= ${G1_MISSING_MAX_PCT})`,
  };
  out.notes.push(
    `G-37-1 reads "missing at most 1 in 10" per fact (${show(miss)}%). Read per document it is ${frac(all.docsWithMissing, all.docs)} ` +
    `of graded documents with a missing costly fact (${show(docMissingPct)}%; limit 10%) — ${docMissingPct !== null && docMissingPct <= G1_MISSING_MAX_PCT ? 'also within the limit' : 'outside the limit'}. The orchestrator rules which reading governs.`,
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// score(records) -> { summary, perItem, notes }
// ---------------------------------------------------------------------------------------------

function countBy(list, keyOf) {
  const out = {};
  for (const item of list) {
    const k = keyOf(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.entries(out).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
}

export function score(records) {
  const complete = records.filter((r) => r.extra.outcome === 'complete');
  const withLayer = complete.filter((r) => r.extra.textLayer?.hasText);
  const total = (list, key) => sum(list.map((r) => r.extra.counts[key]));
  const factsPerDoc = complete.map((r) => r.extra.counts.facts);
  const invalid = records.filter((r) => r.extra.outcome === 'invalid');
  const refused = records.filter((r) => r.extra.outcome === 'refused');
  const unreadable = records.filter((r) => r.extra.textLayerError);

  const graded = gradedMetrics(records);

  const summary = {
    'run id': records[0]?.extra.runId ?? 'unknown',
    'prompt version': [...new Set(records.map((r) => r.extra.promptVersion))].join(', '),
    'outcomes': countBy(records, (r) => r.extra.outcome),
    'facts total': total(records, 'facts'),
    'facts per document median / max': `${median(factsPerDoc)} / ${max(factsPerDoc)}`,
    'costly-kind facts': total(records, 'costly'),
    'verification, text-layer documents': frac(total(withLayer, 'verified'), total(withLayer, 'facts')),
    'costly verification, text-layer documents': frac(total(withLayer, 'costlyVerified'), total(withLayer, 'costly')),
    'documents with / without a text layer': `${withLayer.length} / ${complete.length - withLayer.length}`,
    'page agree / disagree': `${total(complete, 'pageAgree')} / ${total(complete, 'pageDisagree')}`,
    'largest output (tokens)': max(records.map((r) => r.usage.output_tokens)),
    'invalid reasons': invalid.length ? invalid.map((r) => r.extra.validationError).join('; ') : 'none',
    'refusals': refused.length ? countBy(refused, (r) => r.extra.refusalCategory ?? 'unspecified') : 'none',
    'unreadable text layers': unreadable.length,
    ...graded.summary,
  };

  const perItem = records.map((r) => {
    const g = graded.perDoc.get(r.fixtureId);
    return {
      key: r.fixtureId,
      kind: r.extra.kind,
      outcome: r.extra.outcome,
      facts: r.extra.counts.facts,
      costly: r.extra.counts.costly,
      verified: r.extra.textLayer?.hasText ? `${r.extra.counts.verified}/${r.extra.counts.facts}` : 'no text layer',
      graded: g ? `${g.correct}y ${g.wrong}n ${g.missing} missing` : '',
    };
  });

  const notes = [...graded.notes];
  for (const r of unreadable) notes.push(`text layer unreadable: ${r.extra.textLayerError}`);
  return { summary, perItem, notes };
}

// ---------------------------------------------------------------------------------------------
// compare(columns) -> lines
// ---------------------------------------------------------------------------------------------

// Columns are { name, path, metrics, perItem, notes } from score.mjs. score() puts the costly scores in
// the summary as numbers rounded to two decimals, and the B1/B2 thresholds are tested on those.
function scoreOf(column, key) {
  const v = column?.metrics?.[key];
  return typeof v === 'number' ? v : null;
}

export function compare(columns) {
  if (columns.length < 2) return [];
  const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
  const lines = ['', '#### facts comparisons (Plan 37 §5)', ''];
  const haiku = byName['facts-haiku-55-medium'];
  const sonnet = byName['facts-sonnet-55-medium'];
  const old = byName['facts-sonnet-46-medium'];
  let any = false;

  if (haiku && sonnet) {
    any = true;
    const h = scoreOf(haiku, 'costly score (%)');
    const s = scoreOf(sonnet, 'costly score (%)');
    if (h === null || s === null) {
      lines.push('- B2 (import-time reader): not computable yet — both runs need graded sheets (costly score (%) is n/a).');
    } else {
      const pass = h >= s - B2_HAIKU_MARGIN_POINTS;
      lines.push(
        `- B2 (D-37-9): Haiku 5.5 medium costly score ${h}% vs Sonnet 5.5 medium ${s}% (difference ${show(h - s, 2)} points; ` +
        `Haiku passes if it is no more than ${B2_HAIKU_MARGIN_POINTS} point behind) -> ${pass ? 'Haiku reads at import' : 'Sonnet reads at import'}.`,
      );
    }
  }

  if (sonnet && old) {
    any = true;
    const n = scoreOf(sonnet, 'costly score, images only (%)');
    const o = scoreOf(old, 'costly score, images only (%)');
    if (n === null || o === null) {
      lines.push('- B1 (vision hypothesis): not computable yet — both runs need graded image sheets.');
    } else {
      lines.push(
        `- B1 (vision hypothesis, images only): Sonnet 5.5 costly score ${n}% vs Sonnet 4.6 ${o}% (difference ${show(n - o, 2)} points). ` +
        'Recorded whatever it says; it changes no decision in this plan.',
      );
    }
  }

  if (!any) lines.push('- B1/B2 need the facts-haiku-55-medium, facts-sonnet-55-medium and facts-sonnet-46-medium columns (score.mjs facts --profile a,b,c).');
  return lines;
}
