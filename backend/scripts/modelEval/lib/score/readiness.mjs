// Plan 37 W0 — readiness prototype metrics and the G-37-2 / G-37-3 gates.
// score(records) -> { summary, perItem, notes }.
//
// Machine metrics come from the run file alone. The gates need the owner's marks: readiness.mjs
// --sheets writes one blind sheet per trip per ledger run under
// data/model-eval/private/facts/grading/readiness-<timestamp>/ (override the root with the
// READINESS_GRADING_DIR environment variable), with a key.json mapping each code to its run. This
// module finds the sheets whose key names a record's run id and repeat, parses the three mark
// columns, and prints the gates:
//
//   G-37-3  ledger trust    false lines / (true + false lines) pooled, PASS iff <= 10 %
//   G-37-2  payoff          per repeat, the share of trips with at least one line marked true +
//                           new + action-changing, PASS iff every repeat's share is >= 50 %
//
// Marks: true column t / f (a check mark or cross is accepted), new column n (new) / k (already
// known), action column y / n. A blank true column means the line is ungraded. A mark that is not
// one of these throws, naming the sheet and line: a typo must not silently turn into an ungraded line.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVATE_DIR } from '../runner.mjs';
import { max, median } from './common.mjs';

export const GRADING_ROOT = process.env.READINESS_GRADING_DIR ?? join(PRIVATE_DIR, 'facts', 'grading');

export const G_37_3_MAX_FALSE_RATE = 0.10;
export const G_37_2_MIN_TRIP_SHARE = 0.5;

// The sheet folder name of a trip. The id suffix keeps two trips with the same title apart.
export function tripSlug(tripId, title) {
  const words = String(title ?? 'trip').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${words.slice(0, 40).replace(/-+$/g, '') || 'trip'}-${String(tripId).slice(0, 6)}`;
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

const TRUE_MARKS = new Set(['t', 'true', '✓', '✔']);
const FALSE_MARKS = new Set(['f', 'false', '✗', '✘', 'x']);
const NEW_MARKS = new Set(['n', 'new']);
const KNOWN_MARKS = new Set(['k', 'known']);
const YES_MARKS = new Set(['y', 'yes']);
const NO_MARKS = new Set(['n', 'no']);

function parseMark(raw, column, where) {
  const mark = raw.trim().toLowerCase();
  if (!mark) return null;
  const sets = {
    true: [[TRUE_MARKS, true], [FALSE_MARKS, false]],
    new: [[NEW_MARKS, true], [KNOWN_MARKS, false]],
    action: [[YES_MARKS, true], [NO_MARKS, false]],
  }[column];
  for (const [set, value] of sets) if (set.has(mark)) return value;
  throw new Error(`${where}: "${raw.trim()}" is not a valid mark for the ${column} column`);
}

// The marks of one sheet: Map(line number -> { true, isNew, action }), each null when blank. Only the
// first five cells are read, and they never contain an escaped pipe.
export function parseSheetMarks(markdown, where = 'sheet') {
  const marks = new Map();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    const n = Number(cells[1]?.trim());
    if (!Number.isInteger(n) || n < 1) continue;
    const here = `${where} line ${n}`;
    marks.set(n, {
      true: parseMark(cells[2] ?? '', 'true', here),
      isNew: parseMark(cells[3] ?? '', 'new', here),
      action: parseMark(cells[4] ?? '', 'action', here),
    });
  }
  return marks;
}

// Grading folders newest first.
function gradingDirs() {
  if (!existsSync(GRADING_ROOT)) return [];
  return readdirSync(GRADING_ROOT)
    .filter((name) => name.startsWith('readiness-') && existsSync(join(GRADING_ROOT, name, 'key.json')))
    .sort()
    .reverse()
    .map((name) => ({ name, dir: join(GRADING_ROOT, name), key: JSON.parse(readFileSync(join(GRADING_ROOT, name, 'key.json'), 'utf8')) }));
}

// For every record: its sheet's marks, or null when no grading folder covers its run + repeat.
function loadMarks(records) {
  const dirs = gradingDirs();
  const byRecord = new Map();
  const used = new Set();
  const missing = [];
  for (const record of records) {
    const { runId, repeat, tripId, tripTitle } = record.extra;
    let found = null;
    for (const g of dirs) {
      const code = Object.keys(g.key).find((c) => g.key[c].runId === runId && g.key[c].repeat === repeat);
      if (code) { found = { g, code }; break; }
    }
    if (!found) { byRecord.set(record, null); continue; }
    const sheet = join(found.g.dir, tripSlug(tripId, tripTitle), `${found.code}.md`);
    if (!existsSync(sheet)) { missing.push(sheet); byRecord.set(record, null); continue; }
    used.add(found.g.name);
    byRecord.set(record, parseSheetMarks(readFileSync(sheet, 'utf8'), sheet));
  }
  return { byRecord, used: [...used], missing, dirsFound: dirs.length };
}

export function score(records) {
  const n = records.length;
  const outcomes = {};
  for (const r of records) outcomes[r.extra.outcome] = (outcomes[r.extra.outcome] ?? 0) + 1;

  const completes = records.filter((r) => r.extra.outcome === 'complete' && r.output);
  const itemsOf = (r) => r.output.items;
  const allItems = completes.flatMap(itemsOf);
  const tally = (key, values) => values.map((v) => `${v} ${allItems.filter((i) => i[key] === v).length}`).join(', ');
  const thinkingTokens = records.flatMap((r) => r.calls.map((c) => c.response?.usage?.output_tokens_details?.thinking_tokens));
  const unknownEvidence = records.reduce((s, r) => s + (r.extra.unknownEvidence?.length ?? 0), 0);

  const { byRecord, used, missing, dirsFound } = loadMarks(records);

  // Graded lines, per record.
  const perItem = records.map((r) => {
    const marks = byRecord.get(r);
    const items = r.extra.outcome === 'complete' && r.output ? itemsOf(r) : [];
    let isTrue = 0;
    let isFalse = 0;
    let qualifying = 0;
    if (marks) {
      items.forEach((_, index) => {
        const m = marks.get(index + 1);
        if (!m || m.true === null) return;
        if (m.true) isTrue += 1; else isFalse += 1;
        if (m.true && m.isNew === true && m.action === true) qualifying += 1;
      });
    }
    return {
      trip: r.extra.tripTitle,
      repeat: r.extra.repeat,
      outcome: r.extra.outcome,
      docs: r.extra.documentCount,
      facts: r.extra.factCount,
      lines: items.length,
      holds: r.extra.itemCounts?.holds ?? 0,
      conflict: r.extra.itemCounts?.conflict ?? 0,
      question: r.extra.itemCounts?.question ?? 0,
      high: r.extra.itemCounts?.high ?? 0,
      unknownEvidence: r.extra.unknownEvidence?.length ?? 0,
      sheet: marks ? 'found' : '—',
      true: isTrue,
      false: isFalse,
      'true+new+action': qualifying,
    };
  });

  const totalTrue = perItem.reduce((s, p) => s + p.true, 0);
  const totalFalse = perItem.reduce((s, p) => s + p.false, 0);
  const totalLines = perItem.reduce((s, p) => s + p.lines, 0);
  const graded = totalTrue + totalFalse;

  const summary = {
    'outcomes': Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', '),
    'ledger lines per run median / max': `${median(completes.map((r) => itemsOf(r).length))} / ${max(completes.map((r) => itemsOf(r).length))}`,
    'lines by kind': tally('kind', ['conflict', 'question', 'holds']),
    'lines by severity': tally('severity', ['high', 'medium', 'low']),
    'unknown evidence ids': unknownEvidence,
    'input tok median': median(records.map((r) => r.usage.input_tokens)),
    'output tok (incl. thinking) max': max(records.map((r) => r.usage.output_tokens)),
    'thinking tok max': max(thinkingTokens) ?? '— (not reported)',
    'lines graded / ungraded': `${graded} / ${totalLines - graded}`,
    'lines true / false': graded ? `${totalTrue} / ${totalFalse}` : '—',
  };

  const notes = [];

  // G-37-3, pooled over every graded line.
  if (graded) {
    const falseRate = totalFalse / graded;
    summary['G-37-3 false rate'] = `${pct(totalFalse, graded)} (${totalFalse}/${graded}) — ${falseRate <= G_37_3_MAX_FALSE_RATE ? 'PASS' : 'FAIL'} (limit ${G_37_3_MAX_FALSE_RATE * 100}%)`;
  } else {
    summary['G-37-3 false rate'] = 'ungraded';
  }

  // G-37-2, per repeat: the share of trips with at least one true + new + action-changing line.
  const repeats = [...new Set(records.map((r) => r.extra.repeat))].sort((a, b) => a - b);
  const shares = [];
  const tripsYielding = new Set();
  const trips = new Set(records.map((r) => r.extra.tripId));
  for (const repeat of repeats) {
    const rows = records.map((r, i) => ({ r, p: perItem[i] })).filter(({ r }) => r.extra.repeat === repeat);
    const tripCount = new Set(rows.map(({ r }) => r.extra.tripId)).size;
    const gradedHere = rows.reduce((s, { p }) => s + p.true + p.false, 0);
    const yielding = rows.filter(({ p }) => p['true+new+action'] > 0);
    for (const { r } of yielding) tripsYielding.add(r.extra.tripId);
    const share = tripCount ? yielding.length / tripCount : 0;
    shares.push({ repeat, share, gradedHere, tripCount, yielding: yielding.length });
  }
  if (shares.length && shares.every((s) => s.gradedHere > 0)) {
    for (const s of shares) {
      summary[`G-37-2 repeat ${s.repeat}`] = `${pct(s.yielding, s.tripCount)} (${s.yielding}/${s.tripCount} trips) — ${s.share >= G_37_2_MIN_TRIP_SHARE ? 'PASS' : 'FAIL'}`;
    }
    summary['G-37-2'] = shares.every((s) => s.share >= G_37_2_MIN_TRIP_SHARE)
      ? `PASS (every repeat >= ${G_37_2_MIN_TRIP_SHARE * 100}% of ${trips.size} trips)`
      : `FAIL (a repeat is below ${G_37_2_MIN_TRIP_SHARE * 100}% of ${trips.size} trips)`;
    notes.push(`G-37-2, either-repeat share (a trip counts if any repeat yielded a qualifying line): ${tripsYielding.size}/${trips.size} trips (${pct(tripsYielding.size, trips.size)}). Reported for the record; the gate is every repeat.`);
  } else {
    summary['G-37-2'] = 'ungraded';
    const ungradedRepeats = shares.filter((s) => s.gradedHere === 0).map((s) => s.repeat);
    if (ungradedRepeats.length && ungradedRepeats.length < shares.length) {
      notes.push(`G-37-2 not computed: repeat(s) ${ungradedRepeats.join(', ')} have no graded line.`);
    }
  }

  if (used.length) notes.push(`grading folder(s): ${used.join(', ')} under ${GRADING_ROOT}`);
  else notes.push(`no grading folder covers these runs under ${GRADING_ROOT} (${dirsFound} readiness folder(s) found); run readiness.mjs --sheets, then grade the sheets.`);
  if (missing.length) notes.push(`${missing.length} sheet(s) named by a key are missing: ${missing.join('; ')}`);
  const notComplete = records.filter((r) => r.extra.outcome !== 'complete');
  if (notComplete.length) {
    notes.push(`${notComplete.length} of ${n} run(s) are not complete (${notComplete.map((r) => `${r.extra.tripTitle} #${r.extra.repeat}: ${r.extra.outcome}`).join('; ')}); they yield no lines and count against G-37-2.`);
  }

  return { summary, perItem, notes };
}

// One profile is measured, so there is nothing to compare.
export function compare() {
  return [];
}
