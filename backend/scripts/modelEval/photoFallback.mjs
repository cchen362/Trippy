// Plan 34 W0 step 2 (reused by W2) — live selectPhoto fallback passes.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/photoFallback.mjs --profile control
//     [--run <descriptor run .jsonl>] [--passes 3] [--limit <places per pass>] [--max-calls 700]
//
// Reads a descriptor run file (default: the newest under data/model-eval/runs/descriptor/<profile>/)
// and, for every record with a non-null output, calls the real, unmodified selectPhoto() from
// src/services/unsplash.js with that output's photoQuery and sceneType, `excludeIds: []` — the
// Plan 31 measuring method. Each pass is live: there is NO cache, because run-to-run noise in the
// fallback count is the point (Plan 34 F-34-11, the 14-20 band).
//
// Guarantees: globalThis.fetch is replaced BEFORE unsplash.js is imported, and the replacement
// throws on anything but GET https://api.unsplash.com/search/photos, so the download-tracking
// endpoint (or any other host) can never be reached. No database is imported or opened. The only
// file written is data/model-eval/runs/photo-fallback/<profile>/<timestamp>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, latestRunFile, readRunFile } from './lib/runner.mjs';

const SEARCH_ORIGIN = 'https://api.unsplash.com';
const SEARCH_PATH = '/search/photos';
// A place costs at most 4 searches (primary, 4-word retry, 3-word retry, scene fallback).
const MAX_CALLS_PER_PLACE = 4;
const MIN_RATE_LIMIT_REMAINING = 50;

// --profile <name> (default control), --run <path>, --passes <n> (default 3), --limit <n>,
// --max-calls <n> (default 700)
function parseFallbackArgs(argv = process.argv.slice(2)) {
  const args = { profile: 'control', run: null, passes: 3, limit: null, maxCalls: 700 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--profile') args.profile = next();
    else if (a === '--run') args.run = next();
    else if (a === '--passes') args.passes = Math.max(1, parseInt(next(), 10));
    else if (a === '--limit') args.limit = parseInt(next(), 10);
    else if (a === '--max-calls') args.maxCalls = parseInt(next(), 10);
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

// Shared by the fetch guard and the pass loop.
const state = {
  calls: 0,
  maxCalls: Infinity,
  minRemaining: null,
  sent: null, // the current place's sent[]
};

function guardError(message) {
  return Object.assign(new Error(message), { guard: true });
}

function installFetchGuard(maxCalls) {
  state.maxCalls = maxCalls;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url;
    const url = new URL(href);
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || url.origin !== SEARCH_ORIGIN || url.pathname !== SEARCH_PATH) {
      throw guardError(`photoFallback blocks ${method} ${url.origin}${url.pathname}: only ${SEARCH_ORIGIN}${SEARCH_PATH} may be called`);
    }
    if (state.calls >= state.maxCalls) {
      throw guardError(`photoFallback reached --max-calls ${state.maxCalls}`);
    }
    state.calls += 1;
    state.sent?.push(url.searchParams.get('query'));

    const response = await realFetch(input, init);
    const header = response.headers.get('x-ratelimit-remaining');
    if (header !== null && Number.isFinite(Number(header))) {
      state.minRemaining = state.minRemaining === null ? Number(header) : Math.min(state.minRemaining, Number(header));
    }
    return response;
  };
}

const wordsOf = (query) => query.trim().split(/\s+/);

// selectPhoto exports no helper for its scene-fallback query, so the classification uses the shape
// of what it sends: the primary query and D-31-1's 4- and 3-word retries are all word-prefixes of
// the primary query; only the scene fallback ("<scene type> <country>" or "<city> travel") is not.
function isWordPrefix(sentQuery, primaryQuery) {
  const sent = wordsOf(sentQuery);
  const primary = wordsOf(primaryQuery);
  return sent.length <= primary.length && sent.every((w, i) => w === primary[i]);
}

function classify(primaryQuery, sent, chosenId) {
  const fallback = sent.some((q) => !isWordPrefix(q, primaryQuery));
  const retried = sent.some((q) => isWordPrefix(q, primaryQuery) && wordsOf(q).length < wordsOf(primaryQuery).length);
  return {
    fallback,
    retried,
    recoveredByRetry: retried && !fallback && chosenId !== null,
    none: chosenId === null,
  };
}

async function main() {
  const args = parseFallbackArgs();
  const runFile = args.run ?? latestRunFile('descriptor', args.profile);
  if (!runFile) throw new Error(`no descriptor run file for profile "${args.profile}" under ${join(RUNS_DIR, 'descriptor', args.profile)}`);

  installFetchGuard(args.maxCalls);
  const { selectPhoto } = await import('../../src/services/unsplash.js');
  const { config } = await import('../../src/config.js');
  if (!config.unsplashAccessKey) throw new Error('UNSPLASH_ACCESS_KEY is not configured');

  const records = readRunFile(runFile);
  const withOutput = records.filter((r) => r.output && typeof r.output.photoQuery === 'string');
  const nullOutputs = records.length - withOutput.length;
  const places = args.limit ? withOutput.slice(0, args.limit) : withOutput;
  if (!places.length) throw new Error(`${runFile} has no records with an output`);

  console.log(`photoFallback / ${args.profile}: ${places.length} places x ${args.passes} passes from ${runFile}`);
  console.log(`${nullOutputs} record(s) have a null output and are skipped. --max-calls ${args.maxCalls}. Live, no cache; excludeIds [].`);

  const passes = [];
  let stopped = null;

  for (let pass = 1; pass <= args.passes && !stopped; pass += 1) {
    const callsBefore = state.calls;
    const placeResults = [];

    for (const record of places) {
      if (state.calls + MAX_CALLS_PER_PLACE > args.maxCalls) {
        stopped = `--max-calls ${args.maxCalls} would be passed by the next place (${state.calls} used)`;
        break;
      }
      if (state.minRemaining !== null && state.minRemaining < MIN_RATE_LIMIT_REMAINING) {
        stopped = `X-Ratelimit-Remaining fell to ${state.minRemaining} (< ${MIN_RATE_LIMIT_REMAINING})`;
        break;
      }

      const { photoQuery, sceneType } = record.output;
      const place = record.extra?.place ?? {};
      const sent = [];
      state.sent = sent;
      let chosen = null;
      let error = null;
      try {
        chosen = await selectPhoto({ query: photoQuery, sceneType, country: place.country, city: place.city, excludeIds: [] });
      } catch (err) {
        if (err.guard) throw err;
        error = err.message;
        console.error(`  ${record.fixtureId}: selectPhoto failed: ${err.message}`);
      } finally {
        state.sent = null;
      }

      const chosenId = chosen?.id ?? null;
      placeResults.push({
        id: record.fixtureId,
        query: photoQuery,
        sceneType,
        sent,
        chosenId,
        chosenUrl: chosen?.url ?? null,
        ...classify(photoQuery, sent, chosenId),
        ...(error ? { error } : {}),
      });
    }

    const summary = {
      pass,
      fallbacks: placeResults.filter((p) => p.fallback).length,
      retried: placeResults.filter((p) => p.retried).length,
      recoveredByRetry: placeResults.filter((p) => p.recoveredByRetry).length,
      none: placeResults.filter((p) => p.none).length,
      errors: placeResults.filter((p) => p.error).length,
      calls: state.calls - callsBefore,
      places: placeResults,
    };
    passes.push(summary);
    console.log(
      `pass ${pass}: ${placeResults.length} places, fallbacks ${summary.fallbacks}, retried ${summary.retried}, ` +
      `recoveredByRetry ${summary.recoveredByRetry}, none ${summary.none}, errors ${summary.errors}, calls ${summary.calls}`,
    );
  }

  const fallbacksPerPass = passes.map((p) => p.fallbacks);
  const mean = fallbacksPerPass.reduce((a, b) => a + b, 0) / fallbacksPerPass.length;
  const result = {
    runFile,
    passes,
    summary: {
      fallbacksPerPass,
      mean: Number(mean.toFixed(2)),
      minRateLimitRemaining: state.minRemaining,
      totalCalls: state.calls,
      nullOutputs,
      stopped,
    },
  };

  const dir = join(RUNS_DIR, 'photo-fallback', args.profile);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`\nfallbacks per pass: [${fallbacksPerPass.join(', ')}], mean ${result.summary.mean}`);
  console.log(`total calls ${state.calls}, min X-Ratelimit-Remaining ${state.minRemaining ?? 'not seen'}`);
  console.log(`wrote ${outPath}`);
  if (stopped) {
    console.log(`STOPPED: ${stopped}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
