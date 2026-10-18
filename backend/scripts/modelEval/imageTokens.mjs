// Plan 30 W4 — what does one image or PDF cost in input tokens on Sonnet 4.6 vs Sonnet 5.5?
//
//   cd backend; NODE_ENV=test node scripts/modelEval/imageTokens.mjs
//
// For every committed extraction fixture tagged "image" or "pdf", calls the free
// client.messages.countTokens endpoint per model, once with the file block and once without it, and
// prints the difference — the file's own token cost. The request mirrors the block shape
// extractBookings() builds (a text context block, then an image or document block); the system
// prompt is a short fixed string because only the with/without delta matters.
//
// countTokens is free. This script never calls messages.create or messages.stream.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../src/config.js';
import { costUsd } from './lib/pricing.mjs';
import { FIXTURES_DIR } from './lib/runner.mjs';

const MODELS = ['claude-sonnet-4-6', 'claude-sonnet-5-5'];
const SYSTEM = 'Extract travel bookings from the supplied confirmation.';
const dir = join(FIXTURES_DIR, 'extraction');

function loadFileFixtures() {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((fx) => fx.tags?.some((t) => t === 'image' || t === 'pdf'));
}

function fileBlock(file) {
  const data = readFileSync(resolve(dir, file.path)).toString('base64');
  if (file.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: file.mediaType, data } };
  }
  if (file.kind === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  throw new Error(`unsupported file kind ${file.kind}`);
}

async function count(client, model, content) {
  const res = await client.messages.countTokens({
    model,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  return res.input_tokens;
}

async function main() {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set (run with NODE_ENV=test so backend/.env loads)');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const fixtures = loadFileFixtures();
  if (!fixtures.length) throw new Error('no image or pdf fixtures found; run renderExtractionFixtures.mjs first');

  const rows = [];
  for (const fx of fixtures) {
    const [file] = fx.files;
    const text = { type: 'text', text: `Trip context: ${JSON.stringify(fx.tripContext)}` };
    const delta = {};
    for (const model of MODELS) {
      const [withFile, without] = await Promise.all([
        count(client, model, [text, fileBlock(file)]),
        count(client, model, [text]),
      ]);
      delta[model] = withFile - without;
    }
    rows.push({ id: fx.id, kind: file.kind, t46: delta[MODELS[0]], t55: delta[MODELS[1]] });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(`${pad('fixture', 44)}${pad('kind', 7)}${num('4.6 tok', 9)}${num('5.5 tok', 9)}${num('5.5/4.6', 9)}${num('4.6 $', 11)}${num('5.5 $', 11)}`);
  let sum46 = 0;
  let sum55 = 0;
  for (const r of rows) {
    const usd46 = costUsd(MODELS[0], { input_tokens: r.t46 });
    const usd55 = costUsd(MODELS[1], { input_tokens: r.t55 });
    sum46 += r.t46;
    sum55 += r.t55;
    console.log(
      `${pad(r.id, 44)}${pad(r.kind, 7)}${num(r.t46, 9)}${num(r.t55, 9)}${num((r.t55 / r.t46).toFixed(2), 9)}` +
      `${num(`$${usd46.toFixed(5)}`, 11)}${num(`$${usd55.toFixed(5)}`, 11)}`,
    );
  }
  console.log(
    `${pad('total', 51)}${num(sum46, 9)}${num(sum55, 9)}${num((sum55 / sum46).toFixed(2), 9)}` +
    `${num(`$${costUsd(MODELS[0], { input_tokens: sum46 }).toFixed(5)}`, 11)}` +
    `${num(`$${costUsd(MODELS[1], { input_tokens: sum55 }).toFixed(5)}`, 11)}`,
  );
  console.log('\nfile-block input tokens only (with file minus without file); free countTokens endpoint, no messages.create.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
