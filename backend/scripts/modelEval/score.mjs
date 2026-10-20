// Plan 30 §5.3 — prints the metrics table for one workload, one column per profile.
//
//   node scripts/modelEval/score.mjs <workload> [--profile control,primary] [--run <file.jsonl>] [--detail]
//
// Without --run, each profile's most recent run file is scored. Workload-specific metrics come
// from lib/score/<workload>.mjs, which exports score(records) -> { summary, perItem, notes }.

import { WORKLOADS } from './profiles.mjs';
import { latestRunFile, readRunFile } from './lib/runner.mjs';
import { commonMetrics } from './lib/score/common.mjs';

const argv = process.argv.slice(2);
const workload = argv[0];
if (!WORKLOADS.includes(workload)) {
  console.error(`usage: score.mjs <${WORKLOADS.join('|')}> [--profile a,b] [--run file] [--detail]`);
  process.exit(1);
}

let profileNames = ['control'];
let runPath = null;
let detail = false;
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--profile') profileNames = argv[++i].split(',');
  else if (argv[i] === '--run') runPath = argv[++i];
  else if (argv[i] === '--detail') detail = true;
  else throw new Error(`unexpected argument ${argv[i]}`);
}

const mod = await import(`./lib/score/${workload}.mjs`);
const { score } = mod;

const columns = [];
for (const name of runPath ? [null] : profileNames) {
  const path = runPath ?? latestRunFile(workload, name);
  if (!path) {
    console.error(`no run file for ${workload}/${name}`);
    process.exit(1);
  }
  const records = readRunFile(path);
  const specific = score(records);
  columns.push({
    name: name ?? records[0]?.profile ?? 'run',
    path,
    metrics: { ...commonMetrics(records), ...specific.summary },
    perItem: specific.perItem,
    notes: specific.notes ?? [],
  });
}

const metricNames = [...new Set(columns.flatMap((c) => Object.keys(c.metrics)))];
console.log(`\n### ${workload}\n`);
for (const c of columns) console.log(`- ${c.name}: ${c.path}`);
console.log(`\n| metric | ${columns.map((c) => c.name).join(' | ')} |`);
console.log(`|---|${columns.map(() => '---').join('|')}|`);
for (const m of metricNames) {
  console.log(`| ${m} | ${columns.map((c) => c.metrics[m] ?? '—').join(' | ')} |`);
}
if (typeof mod.compare === 'function') {
  const lines = mod.compare(columns);
  if (lines.length) {
    console.log('\n### comparison\n');
    for (const line of lines) console.log(line);
  }
}
for (const c of columns) {
  for (const note of c.notes) console.log(`\n> ${c.name}: ${note}`);
}
if (detail) {
  for (const c of columns) {
    console.log(`\n#### ${c.name} — per item\n`);
    console.table(c.perItem);
  }
}
