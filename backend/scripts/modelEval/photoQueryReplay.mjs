// Plan 34 W3 (§4.2 last bullet, §5.1 "Photo query pair") — photo query replay.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/photoQueryReplay.mjs --profile w3-broad
//     [--run <descriptor run .jsonl>]... [--max-calls 400]
//
// Question: should the photo descriptor also author a `broadQuery` (a broader 2-4 word search) as the
// fallback, or does today's D-31-1 prefix retry (selectPhoto) already do the job? For every record with a
// non-null output in each descriptor run file (default: the newest under data/model-eval/runs/descriptor/<profile>/;
// `--run` may repeat, and all files are processed in ONE process so one cache serves them all), four chains run
// with `excludeIds: []` on the same live Unsplash pools:
//   A0  today's selectPhoto: the 4/3-word prefix retry fires only when the primary search returned ZERO results.
//   A1  the same, but the prefix retry fires on ANY primary miss (zero results OR every result failed the gate).
//   B0  primary; if it returned ZERO results, search the descriptor's broadQuery; then the scene fallback.
//   B1  primary; on ANY primary miss, search broadQuery; then the scene fallback.
// A0 is run twice: by the harness copy of selectPhoto below and by the REAL selectPhoto. Their sent[] lists and
// chosen ids must be identical, or the run throws `parity failure`: that proves the copy is faithful.
//
// Why a cache is used here, unlike photoFallback.mjs: Plan 34 W0 measured Unsplash search as deterministic for
// a fixed query (7/7/7 over three passes of one run file), so sharing a result across chains (and across
// run files that happened to write the same query) measures the chains, not search noise. The cache is keyed by
// the full request URL and holds only successful responses; only real network calls count toward --max-calls.
//
// Guarantees: globalThis.fetch is replaced BEFORE unsplash.js is imported, and the replacement throws on
// anything but GET https://api.unsplash.com/search/photos, so the download-tracking endpoint (or any other host)
// can never be reached. No database is imported or opened. The only file written is
// data/model-eval/runs/photo-query-replay/<profile>/<timestamp>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, latestRunFile, readRunFile } from './lib/runner.mjs';

const SEARCH_ORIGIN = 'https://api.unsplash.com';
const SEARCH_PATH = '/search/photos';
// A place costs at most ~8 real calls across all chains: primary, 4- and 3-word retries, broad, scene
// fallback, plus slack. The real selectPhoto cross-check is served from the cache.
const MAX_CALLS_PER_PLACE = 8;
const MIN_RATE_LIMIT_REMAINING = 50;
const CHAINS = ['A0', 'A1', 'B0', 'B1'];
const RECOVERED_STEPS = new Set(['retry4', 'retry3', 'broad']);

// --profile <name> (default w3-broad), --run <path> (repeatable), --max-calls <n> (default 400)
function parseReplayArgs(argv = process.argv.slice(2)) {
  const args = { profile: 'w3-broad', runs: [], maxCalls: 400 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--profile') args.profile = next();
    else if (a === '--run') args.runs.push(next());
    else if (a === '--max-calls') args.maxCalls = parseInt(next(), 10);
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!Number.isInteger(args.maxCalls) || args.maxCalls < 1) throw new Error('--max-calls must be a positive integer');
  return args;
}

// Shared by the fetch guard and the replay loop.
const state = {
  calls: 0,
  cacheHits: 0,
  maxCalls: Infinity,
  minRemaining: null,
  sent: null, // the current chain's sent[]
};

const cache = new Map(); // url.href -> { status, text }

function guardError(message) {
  return Object.assign(new Error(message), { guard: true });
}

const cachedResponse = ({ status, text }) => new Response(text, { status, headers: { 'content-type': 'application/json' } });

function installFetchGuard(maxCalls) {
  state.maxCalls = maxCalls;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url;
    const url = new URL(href);
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || url.origin !== SEARCH_ORIGIN || url.pathname !== SEARCH_PATH) {
      throw guardError(`photoQueryReplay blocks ${method} ${url.origin}${url.pathname}: only ${SEARCH_ORIGIN}${SEARCH_PATH} may be called`);
    }
    state.sent?.push(url.searchParams.get('query'));

    const hit = cache.get(url.href);
    if (hit) {
      state.cacheHits += 1;
      return cachedResponse(hit);
    }
    if (state.calls >= state.maxCalls) {
      throw guardError(`photoQueryReplay reached --max-calls ${state.maxCalls}`);
    }
    state.calls += 1;

    const response = await realFetch(input, init);
    const header = response.headers.get('x-ratelimit-remaining');
    if (header !== null && Number.isFinite(Number(header))) {
      state.minRemaining = state.minRemaining === null ? Number(header) : Math.min(state.minRemaining, Number(header));
    }
    if (!response.ok) return response;
    const entry = { status: response.status, text: await response.text() };
    cache.set(url.href, entry);
    return cachedResponse(entry);
  };
}

// --- Harness copies of unsplash.js internals, VERBATIM (they are not exported and must not be). ----------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'at', 'in', 'on', 'to', 'for', 'with',
  'near', 'best', 'top', 'travel', 'trip', 'tour', 'visit', 'place', 'spot',
  'local', 'famous', 'popular',
]);

function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function significantTokens(query, city, country) {
  const excluded = new Set([...tokenize(city), ...tokenize(country), ...STOPWORDS]);
  return tokenize(query).filter((token) => !excluded.has(token));
}

function passesGate(photo, sigTokens) {
  if (sigTokens.length === 0) return true;
  const words = new Set(
    tokenize(`${photo.altDescription || ''} ${photo.description || ''} ${(photo.tags || []).join(' ')}`),
  );
  return sigTokens.some((token) => {
    if (words.has(token) || words.has(`${token}s`) || words.has(`${token}es`)) return true;
    if (token.endsWith('es') && words.has(token.slice(0, -2))) return true;
    return token.endsWith('s') && words.has(token.slice(0, -1));
  });
}

function firstQualifying(pool, exclude, sigTokens) {
  for (const photo of pool) {
    if (exclude.has(photo.id)) continue;
    if (!passesGate(photo, sigTokens)) continue;
    return photo;
  }
  return null;
}

// selectPhoto's scene-fallback query rule, verbatim.
function sceneFallbackQuery(sceneType, country, city) {
  if (sceneType && sceneType !== 'generic') {
    return `${sceneType.replace(/_/g, ' ')} ${country || ''}`.trim();
  }
  return `${city || ''} travel`.trim();
}

// --- The chains. -------------------------------------------------------------------------------------------

const normalise = (q) => q.trim().split(/\s+/).join(' ').toLowerCase();

// Whether the broad step may run at all: present, 2+ characters, and not the primary query again.
function broadUsable(broad, query) {
  if (typeof broad !== 'string') return false;
  const trimmed = broad.trim();
  if (trimmed.length < 2) return false;
  return normalise(trimmed) !== normalise(query);
}

// One chain, with the Plan 31 measuring method's inputs. `prefixRetry` / `broadRetry` are null (off),
// 'zero' (only after a primary search that returned no results) or 'any' (after any primary miss).
// With { prefixRetry: 'zero', broadRetry: null } this is selectPhoto, line for line.
// `searchPhotos` is the real exported function; every query it sends is recorded by the fetch guard
// into state.sent by the caller.
async function runChain(searchPhotos, { query, sceneType, country, city, broad }, { prefixRetry, broadRetry }) {
  const exclude = new Set();
  const sigTokens = significantTokens(query, city, country);
  const result = (step, photo, extra = {}) => ({
    step, photo, primaryCount, primaryMiss, sceneSearched: false, ...extra,
  });

  const primary = await searchPhotos(query);
  const primaryCount = primary.length;
  const hit = firstQualifying(primary, exclude, sigTokens);
  const primaryMiss = hit ? 'hit' : primaryCount === 0 ? 'zero' : 'gate-fail';
  if (hit) return result('primary', hit);

  const missAllowed = (mode) => mode === 'any' || (mode === 'zero' && primaryCount === 0);

  if (missAllowed(prefixRetry)) {
    const words = query.trim().split(/\s+/);
    let lastSentWords = words.length;
    for (const retryWords of [4, 3]) {
      if (retryWords >= lastSentWords) continue;
      const retryQuery = words.slice(0, retryWords).join(' ');
      lastSentWords = retryWords;
      const retried = await searchPhotos(retryQuery);
      const retryHit = firstQualifying(retried, exclude, significantTokens(retryQuery, city, country));
      if (retryHit) return result(`retry${retryWords}`, retryHit);
    }
  }

  if (missAllowed(broadRetry) && broadUsable(broad, query)) {
    const broadQuery = broad.trim();
    const broadPool = await searchPhotos(broadQuery);
    const broadHit = firstQualifying(broadPool, exclude, significantTokens(broadQuery, city, country));
    if (broadHit) return result('broad', broadHit);
  }

  const fallbackQuery = sceneFallbackQuery(sceneType, country, city);
  if (!fallbackQuery || fallbackQuery.length < 2) {
    return result('none', null);
  }

  const fallback = await searchPhotos(fallbackQuery);
  for (const photo of fallback) {
    if (exclude.has(photo.id)) continue;
    return result('scene', photo, { sceneSearched: true });
  }
  return result('none', null, { sceneSearched: true });
}

const CHAIN_MODES = {
  A0: { prefixRetry: 'zero', broadRetry: null },
  A1: { prefixRetry: 'any', broadRetry: null },
  B0: { prefixRetry: null, broadRetry: 'zero' },
  B1: { prefixRetry: null, broadRetry: 'any' },
};

// Runs fn with state.sent collecting every query the fetch guard sees; returns { value, sent }.
async function collectSent(fn) {
  const sent = [];
  state.sent = sent;
  try {
    return { value: await fn(), sent };
  } finally {
    state.sent = null;
  }
}

function parityFailure(record, harness, real) {
  return Object.assign(
    new Error(
      `parity failure for ${record.fixtureId}: harness A0 sent ${JSON.stringify(harness.sent)} and chose ${harness.chosenId}, ` +
      `the real selectPhoto sent ${JSON.stringify(real.sent)} and chose ${real.chosenId}`,
    ),
    { fatal: true },
  );
}

async function replayPlace(record, { searchPhotos, selectPhoto }) {
  const place = record.extra?.place ?? {};
  const { photoQuery: query, sceneType } = record.output;
  const broad = typeof record.extra?.broadQuery === 'string' ? record.extra.broadQuery : null;
  const input = { query, sceneType, country: place.country, city: place.city, broad };

  const chains = {};
  let primaryInfo = null;
  for (const name of CHAINS) {
    const { value, sent } = await collectSent(() => runChain(searchPhotos, input, CHAIN_MODES[name]));
    primaryInfo ??= { primaryResults: value.primaryCount, primaryMiss: value.primaryMiss };
    chains[name] = {
      step: value.step,
      chosenId: value.photo?.id ?? null,
      chosenUrl: value.photo?.url ?? null,
      alt: value.photo?.alt ?? null,
      sent,
      fallback: value.sceneSearched,
    };
  }

  // Parity: the harness copy of today's selectPhoto against the real one (served from the cache).
  const real = await collectSent(() => selectPhoto({ query, sceneType, country: place.country, city: place.city, excludeIds: [] }));
  const realOutcome = { sent: real.sent, chosenId: real.value?.id ?? null };
  const a0 = chains.A0;
  if (JSON.stringify(a0.sent) !== JSON.stringify(realOutcome.sent) || a0.chosenId !== realOutcome.chosenId) {
    throw parityFailure(record, a0, realOutcome);
  }

  const broadWords = broad ? broad.trim().split(/\s+/).filter(Boolean).length : 0;
  return {
    id: record.fixtureId,
    title: place.title ?? null,
    resolvedName: place.resolvedName ?? null,
    city: place.city ?? null,
    country: place.country ?? null,
    type: place.type ?? null,
    photoQuery: query,
    broadQuery: broad,
    broadWords,
    broadSameAsPrimary: broad !== null && broad.trim().length >= 2 && normalise(broad) === normalise(query),
    sceneType,
    ...primaryInfo,
    chains,
  };
}

const chainTotals = (places, name) => ({
  fallbacks: places.filter((p) => p.chains[name].fallback).length,
  recovered: places.filter((p) => RECOVERED_STEPS.has(p.chains[name].step)).length,
  none: places.filter((p) => p.chains[name].chosenId === null).length,
});

async function main() {
  const args = parseReplayArgs();
  const runFiles = args.runs.length ? args.runs : [latestRunFile('descriptor', args.profile)];
  if (runFiles.some((f) => !f)) {
    throw new Error(`no descriptor run file for profile "${args.profile}" under ${join(RUNS_DIR, 'descriptor', args.profile)}`);
  }

  installFetchGuard(args.maxCalls);
  const { selectPhoto, searchPhotos } = await import('../../src/services/unsplash.js');
  const { config } = await import('../../src/config.js');
  if (!config.unsplashAccessKey) throw new Error('UNSPLASH_ACCESS_KEY is not configured');

  console.log(`photoQueryReplay / ${args.profile}: ${runFiles.length} run file(s), --max-calls ${args.maxCalls}. Shared cache; excludeIds [].`);

  const runs = [];
  const totals = { nullOutputs: 0, broadOverFourWords: 0, broadSameAsPrimary: 0 };
  let stopped = null;

  for (const runFile of runFiles) {
    const records = readRunFile(runFile);
    const withOutput = records.filter((r) => r.output && typeof r.output.photoQuery === 'string');
    const nullOutputs = records.length - withOutput.length;
    if (!withOutput.length) throw new Error(`${runFile} has no records with an output`);
    totals.nullOutputs += nullOutputs;
    console.log(`${runFile}: ${withOutput.length} places, ${nullOutputs} null output(s) skipped`);

    const places = [];
    for (const record of withOutput) {
      if (state.calls + MAX_CALLS_PER_PLACE > args.maxCalls) {
        stopped = `--max-calls ${args.maxCalls} would be passed by the next place (${state.calls} real calls used)`;
        break;
      }
      if (state.minRemaining !== null && state.minRemaining < MIN_RATE_LIMIT_REMAINING) {
        stopped = `X-Ratelimit-Remaining fell to ${state.minRemaining} (< ${MIN_RATE_LIMIT_REMAINING})`;
        break;
      }
      let placeResult;
      try {
        placeResult = await replayPlace(record, { searchPhotos, selectPhoto });
      } catch (err) {
        // A guard stop or a harness fault is never recorded as data; an Unsplash failure is, by stopping the
        // run and writing what was measured so far.
        if (err.guard || err.fatal) throw err;
        stopped = `${record.fixtureId}: search failed: ${err.message}`;
        break;
      }
      totals.broadOverFourWords += placeResult.broadWords > 4 ? 1 : 0;
      totals.broadSameAsPrimary += placeResult.broadSameAsPrimary ? 1 : 0;
      places.push(placeResult);
    }

    runs.push({
      runFile,
      placesAvailable: withOutput.length,
      placesProcessed: places.length,
      complete: places.length === withOutput.length,
      chains: Object.fromEntries(CHAINS.map((name) => [name, chainTotals(places, name)])),
      places,
    });
    if (stopped) break;
  }

  const summaryChains = {};
  for (const name of CHAINS) {
    const fallbacksPerRun = runs.map((r) => r.chains[name].fallbacks);
    const mean = fallbacksPerRun.reduce((a, b) => a + b, 0) / fallbacksPerRun.length;
    summaryChains[name] = {
      fallbacksPerRun,
      mean: Number(mean.toFixed(2)),
      recoveredPerRun: runs.map((r) => r.chains[name].recovered),
    };
  }

  const result = {
    profile: args.profile,
    runFiles,
    runs,
    summary: {
      chains: summaryChains,
      placesPerRun: runs.map((r) => r.placesProcessed),
      realCalls: state.calls,
      cacheHits: state.cacheHits,
      minRateLimitRemaining: state.minRemaining,
      ...totals,
      stopped,
    },
  };

  const dir = join(RUNS_DIR, 'photo-query-replay', args.profile);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log('\nchain  fallbacks per run (places)           mean   recovered per run');
  for (const name of CHAINS) {
    const s = summaryChains[name];
    const perRun = s.fallbacksPerRun.map((f, i) => `${f}/${result.summary.placesPerRun[i]}`).join('  ');
    console.log(`${name.padEnd(6)} ${perRun.padEnd(36)} ${String(s.mean).padEnd(6)} ${s.recoveredPerRun.join('  ')}`);
  }
  console.log(
    `real calls ${state.calls}, cache hits ${state.cacheHits}, min X-Ratelimit-Remaining ${state.minRemaining ?? 'not seen'}, ` +
    `null outputs ${totals.nullOutputs}, broadQuery > 4 words ${totals.broadOverFourWords}, broadQuery same as primary ${totals.broadSameAsPrimary}`,
  );
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
