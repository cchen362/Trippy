// Plan 34 W3 (§5.1 "Photo query pair") — blind sheet for the photos a fallback chain RECOVERED.
//
//   cd backend; node scripts/modelEval/photoBlindSheet.mjs --replay <photo-query-replay .json> [--seed 34]
//   cd backend; node scripts/modelEval/photoBlindSheet.mjs --score <data/model-eval/runs/photo-blind/<timestamp>>
//
// Offline: no network, no database, no API key. The replay JSON (photoQueryReplay.mjs) says which photo each
// chain chose and by which step. This collects every photo chosen by a retry4, retry3 or broad step in ANY
// chain of ANY run (a photo two chains chose appears once), shuffles them with a seeded PRNG, and writes
// to data/model-eval/runs/photo-blind/<timestamp>/:
//   sheet.html     numbered cards showing ONLY the stop (title, resolved name, city, country, type) and the photo —
//                  no query, no alt text, no chain, no step — so a reviewer judges the photo, not the method
//   key.json       item n -> { placeId, photoId, url, uses: [{ runFile, chain, step, query }] }
//   verdicts.json  the template to fill: right | generic | wrong per item
// --score reads key.json + verdicts.json from a sheet directory and prints, per chain (pooled across runs, each
// use counted), recovered / right / generic / wrong and the wrong-place rate = wrong / recovered; it also writes
// score.json there. It throws if any verdict is missing or not one of the three.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNS_DIR } from './lib/runner.mjs';

const CHAINS = ['A0', 'A1', 'B0', 'B1'];
const RECOVERED_STEPS = new Set(['retry4', 'retry3', 'broad']);
const VERDICTS = ['right', 'generic', 'wrong'];
const LEGEND = {
  right: 'plausibly shows this stop (the named place, or the dish/activity itself)',
  generic: 'the right kind of thing but not identifiably this place; not misleading',
  wrong: 'identifiably a different place, or an unrelated subject',
};

// --replay <path> [--seed n] | --score <dir>
function parseSheetArgs(argv = process.argv.slice(2)) {
  const args = { replay: null, score: null, seed: 34 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--replay') args.replay = next();
    else if (a === '--score') args.score = next();
    else if (a === '--seed') args.seed = parseInt(next(), 10);
    else throw new Error(`unexpected argument ${a}`);
  }
  if (Boolean(args.replay) === Boolean(args.score)) throw new Error('pass exactly one of --replay <file> or --score <dir>');
  if (!Number.isInteger(args.seed)) throw new Error('--seed must be an integer');
  return args;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every recovered photo, deduped by (place id, photo id), in a stable order before the shuffle.
function collectRecovered(replay) {
  const byKey = new Map();
  for (const run of replay.runs) {
    for (const place of run.places) {
      for (const chain of CHAINS) {
        const c = place.chains[chain];
        if (!RECOVERED_STEPS.has(c.step) || !c.chosenId) continue;
        const key = `${place.id}\u0000${c.chosenId}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            placeId: place.id,
            photoId: c.chosenId,
            url: c.chosenUrl,
            place: {
              title: place.title, resolvedName: place.resolvedName, city: place.city, country: place.country, type: place.type,
            },
            uses: [],
          });
        }
        // The search that found a recovered photo is the last one the chain sent.
        byKey.get(key).uses.push({ runFile: run.runFile, chain, step: c.step, query: c.sent.at(-1) });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.placeId + a.photoId).localeCompare(b.placeId + b.photoId));
}

function renderSheet(items) {
  const cards = items.map((item, i) => {
    const { title, resolvedName, city, country, type } = item.place;
    const named = resolvedName && resolvedName !== title ? `<div class="resolved">${escapeHtml(resolvedName)}</div>` : '';
    const where = [city, country].filter(Boolean).map(escapeHtml).join(', ');
    return `<figure class="card">
  <figcaption>
    <div class="n">${i + 1}</div>
    <div class="title">${escapeHtml(title)}</div>
    ${named}
    <div class="where">${where}${type ? ` &middot; ${escapeHtml(type)}` : ''}</div>
  </figcaption>
  <img src="${escapeHtml(item.url)}" width="360" loading="lazy" alt="">
</figure>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo blind sheet</title>
<style>
  body { font: 15px/1.4 Georgia, serif; margin: 24px; background: #fafaf7; color: #1b1b1b; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.lead { margin: 0 0 20px; color: #444; max-width: 70ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; }
  .card { margin: 0; background: #fff; border: 1px solid #d8d6cc; padding: 12px; }
  .n { font: 700 18px/1 monospace; margin-bottom: 6px; }
  .title { font-weight: 700; }
  .resolved, .where { color: #555; font-size: 14px; }
  img { display: block; width: 360px; max-width: 100%; height: auto; margin-top: 10px; background: #eee; }
</style>
</head>
<body>
<h1>Photo blind sheet</h1>
<p class="lead">${items.length} photos. For each stop, judge the photo only: right (plausibly shows this stop, or the dish or activity itself), generic (the right kind of thing but not identifiably this place, not misleading), or wrong (identifiably a different place, or an unrelated subject). Record verdicts in verdicts.json by item number.</p>
<div class="grid">
${cards.join('\n')}
</div>
</body>
</html>
`;
}

function buildSheet(args) {
  const replay = readJson(resolve(args.replay));
  const recovered = collectRecovered(replay);
  if (!recovered.length) throw new Error(`${args.replay} has no recovered photos (no retry4, retry3 or broad step)`);
  const items = shuffle(recovered, args.seed);

  const dir = join(RUNS_DIR, 'photo-blind', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'sheet.html'), renderSheet(items), 'utf8');
  const key = Object.fromEntries(items.map((item, i) => [String(i + 1), {
    placeId: item.placeId, photoId: item.photoId, url: item.url, uses: item.uses,
  }]));
  writeFileSync(join(dir, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, 'utf8');
  const verdicts = { legend: LEGEND, items: items.map((_, i) => ({ n: i + 1, verdict: null })) };
  writeFileSync(join(dir, 'verdicts.json'), `${JSON.stringify(verdicts, null, 2)}\n`, 'utf8');

  const uses = items.reduce((sum, item) => sum + item.uses.length, 0);
  console.log(`${items.length} recovered photos (${uses} chain uses) from ${args.replay}, seed ${args.seed}`);
  console.log(`wrote ${dir}`);
}

function scoreSheet(args) {
  const dir = resolve(args.score);
  const key = readJson(join(dir, 'key.json'));
  const verdictFile = readJson(join(dir, 'verdicts.json'));
  const keyed = Object.keys(key);
  if (!Array.isArray(verdictFile.items) || verdictFile.items.length !== keyed.length) {
    throw new Error(`verdicts.json has ${verdictFile.items?.length} items but key.json has ${keyed.length}`);
  }
  const verdictOf = new Map();
  for (const { n, verdict } of verdictFile.items) {
    if (!VERDICTS.includes(verdict)) throw new Error(`item ${n}: verdict ${JSON.stringify(verdict)} is not one of ${VERDICTS.join(', ')}`);
    if (!key[String(n)]) throw new Error(`item ${n} is not in key.json`);
    verdictOf.set(String(n), verdict);
  }
  if (verdictOf.size !== keyed.length) throw new Error('verdicts.json repeats or skips an item number');

  const perChain = Object.fromEntries(CHAINS.map((c) => [c, { recovered: 0, right: 0, generic: 0, wrong: 0 }]));
  for (const [n, entry] of Object.entries(key)) {
    for (const use of entry.uses) {
      const tally = perChain[use.chain];
      tally.recovered += 1;
      tally[verdictOf.get(n)] += 1;
    }
  }
  for (const tally of Object.values(perChain)) {
    tally.wrongPlaceRate = tally.recovered ? Number((tally.wrong / tally.recovered).toFixed(3)) : null;
  }

  const result = { dir, items: keyed.length, perChain };
  writeFileSync(join(dir, 'score.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log('chain  recovered  right  generic  wrong  wrong-place rate');
  for (const chain of CHAINS) {
    const t = perChain[chain];
    const rate = t.wrongPlaceRate === null ? 'n/a' : `${t.wrong}/${t.recovered} = ${(t.wrongPlaceRate * 100).toFixed(1)}%`;
    console.log(`${chain.padEnd(6)} ${String(t.recovered).padEnd(10)} ${String(t.right).padEnd(6)} ${String(t.generic).padEnd(8)} ${String(t.wrong).padEnd(6)} ${rate}`);
  }
  console.log(`wrote ${join(dir, 'score.json')}`);
}

try {
  const args = parseSheetArgs();
  if (args.replay) buildSheet(args);
  else scoreSheet(args);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
