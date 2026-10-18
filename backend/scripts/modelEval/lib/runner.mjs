// Shared run loop for the four workload scripts: argument parsing, the JSONL run file, a small
// concurrency pool, and the spend guard (stop scheduling once the projected cost of the whole run
// exceeds --max-usd; Plan 30 W0 sets $10 per workload as the stop-and-report line).

import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costUsd } from './pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = resolve(HERE, '../../..');
export const EVAL_DATA_DIR = join(BACKEND_DIR, 'data', 'model-eval');
export const RUNS_DIR = join(EVAL_DATA_DIR, 'runs');
export const PRIVATE_DIR = join(EVAL_DATA_DIR, 'private');
export const FIXTURES_DIR = resolve(HERE, '../fixtures');

// --profile <name> (default control), --only <id,id>, --concurrency <n>, --max-usd <n>, --limit <n>
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { profile: 'control', only: null, concurrency: 1, maxUsd: 10, limit: null, flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--profile') args.profile = next();
    else if (a === '--only') args.only = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--concurrency') args.concurrency = Math.max(1, parseInt(next(), 10));
    else if (a === '--max-usd') args.maxUsd = Number(next());
    else if (a === '--limit') args.limit = parseInt(next(), 10);
    else if (a.startsWith('--')) args.flags.add(a.slice(2));
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function openRunFile(workload, profileName) {
  const dir = join(RUNS_DIR, workload, profileName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${timestampSlug()}.jsonl`);
  return {
    path,
    write(record) {
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    },
  };
}

export function latestRunFile(workload, profileName) {
  const dir = join(RUNS_DIR, workload, profileName);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}

export function readRunFile(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function sumUsage(calls) {
  const total = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (const c of calls) {
    const u = c.response?.usage;
    if (!u) continue;
    for (const k of Object.keys(total)) total[k] += u[k] ?? 0;
  }
  return total;
}

// Builds the one-line-per-fixture record every workload writes. `calls` comes from
// recordFixture(); `output` is the parsed service result; `extra` is workload-specific.
export function buildRecord({ workload, profileName, profile, fixtureId, variant = null, recorded, output, extra = {} }) {
  const { calls, error, wallMs } = recorded;
  const last = calls.at(-1);
  const usage = sumUsage(calls);
  const cost = calls.reduce((sum, c) => sum + (c.response ? costUsd(c.request.model, c.response.usage) : 0), 0);
  return {
    workload,
    profile: profileName,
    fixtureId,
    variant,
    model: profile.model,
    settings: profile,
    startedAt: new Date(Date.now() - wallMs).toISOString(),
    wallMs,
    firstEventMs: calls[0]?.firstEventMs ?? null,
    stopReason: last?.response?.stop_reason ?? null,
    stopDetails: last?.response?.stop_details ?? null,
    usage,
    costUsd: Number(cost.toFixed(6)),
    apiCalls: calls.length,
    error,
    output,
    extra,
    calls,
  };
}

// Runs runOne(item) for each item with a bounded pool. runOne returns a record (buildRecord shape).
// After each record, the projected spend for the whole list is (spent / done) * total; once it is
// above maxUsd no new item starts, in-flight items finish, and the result says so.
export async function runPool(items, runOne, { concurrency = 1, maxUsd = 10, onRecord } = {}) {
  let next = 0;
  let done = 0;
  let spent = 0;
  let stopped = null;

  async function worker() {
    while (!stopped && next < items.length) {
      const item = items[next];
      next += 1;
      const record = await runOne(item);
      done += 1;
      spent += record.costUsd;
      if (onRecord) onRecord(record, { done, total: items.length, spent });
      const projected = (spent / done) * items.length;
      if (!stopped && projected > maxUsd) {
        stopped = `projected spend $${projected.toFixed(2)} for ${items.length} items exceeds --max-usd ${maxUsd} after ${done}`;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { done, total: items.length, spent, stopped };
}

export function filterItems(items, args, idOf = (x) => x.id) {
  let out = items;
  if (args.only) out = out.filter((x) => args.only.has(idOf(x)));
  if (args.limit) out = out.slice(0, args.limit);
  return out;
}

export function printProgress(record, { done, total, spent }) {
  const flag = record.error ? ` ERROR ${record.error.message}` : '';
  console.log(
    `[${done}/${total}] ${record.fixtureId}${record.variant ? `/${record.variant}` : ''} ` +
    `stop=${record.stopReason} out=${record.usage.output_tokens} wall=${record.wallMs}ms ` +
    `$${record.costUsd.toFixed(4)} (spent $${spent.toFixed(4)})${flag}`,
  );
}
