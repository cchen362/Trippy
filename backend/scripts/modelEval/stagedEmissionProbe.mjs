// Plan 35 W0 — staged-emission probe.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/stagedEmissionProbe.mjs [--only ipoh,chengdu,okinawa] [--runs 2] [--parallel off|on|both] [--max-usd 1] [--max-steps 12] [--concurrency 1] [--strict on|off]
//
// Question: with an emit_category tool and adaptive thinking on, does Haiku 5.5 think per category
// (thinking interleaved across tool calls, so the first category lands early) or does it still plan
// the whole catalogue before its first call (Plan 34 W4: first category at 44 s)? Each run is a real
// tool loop against the live discovery prompt (exact-count volume line, staged output opening —
// lib/emitCategoryTool.mjs): stream a step, replay the assistant turn verbatim (thinking blocks and
// signatures included), answer every tool_use with a tool_result, repeat until the model ends its
// turn. tools, tool_choice and the system block are byte-identical on every step.
//
// Two tool_choice settings are measured side by side: parallel 'disabled' (disable_parallel_tool_use
// true) and 'allowed' (sent explicitly as false). The write-up criteria are Plan 35 §5's go/no-go;
// this script prints them per setting, from the recorded runs.
//
// Recorded per step: block timeline (thinking / text / tool_use start and stop, from the step's
// request start and from the run start), the exact thinking-token count from usage (never an
// estimate), stop reason and details, usage, cost, each delivered category (its full tool input)
// with a schema check. Thinking text and signatures are never written (length only). Nothing is repaired or retried.
//
// Direct SDK stream calls with the SDK's retries off. D-30-7: no database is imported or opened. The
// only external call is the Anthropic Messages API, and the only file written is
// data/model-eval/runs/staged-probe/<timestamp>.jsonl.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config.js';
import { DISCOVERY_CATEGORIES } from '../../src/services/claude.js';
import { countryNameFromCode } from '../../src/utils/countries.js';
import { EMIT_CATEGORY_TOOL, checkCategoryInput, stagedDiscoverySystemPrompt } from './lib/emitCategoryTool.mjs';
import { costUsd } from './lib/pricing.mjs';
import { FIXTURES_DIR, RUNS_DIR } from './lib/runner.mjs';

const MODEL = 'claude-haiku-5-5';
const DESTINATION_IDS = ['ipoh', 'chengdu', 'okinawa'];
const PARALLEL_SETTINGS = { off: ['disabled'], on: ['allowed'], both: ['disabled', 'allowed'] };

// Plan 35 §5 go/no-go thresholds.
const MAX_MEDIAN_THINKING_BEFORE_FIRST_CALL = 1200;
const MIN_ONE_CALL_PER_TURN_FRACTION = 10 / 12;

const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const sum = (values) => values.reduce((a, b) => a + b, 0);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const show = (v) => (v === null || v === undefined ? '-' : String(v));

// --only <id,...>, --runs <n>, --parallel off|on|both, --max-usd <n>, --max-steps <n>, --concurrency <n>,
// --strict on|off (off sends the same tool without `strict`: a diagnostic for the strict decoder)
function parseProbeArgs(argv = process.argv.slice(2)) {
  const args = { only: DESTINATION_IDS, runs: 2, parallel: 'both', maxUsd: 1, maxSteps: 12, concurrency: 1, strict: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--only') args.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--runs') args.runs = Math.max(1, parseInt(next(), 10));
    else if (a === '--parallel') args.parallel = next();
    else if (a === '--max-usd') args.maxUsd = Number(next());
    else if (a === '--max-steps') args.maxSteps = Math.max(1, parseInt(next(), 10));
    else if (a === '--concurrency') args.concurrency = Math.max(1, parseInt(next(), 10));
    else if (a === '--strict') {
      const v = next();
      if (v !== 'on' && v !== 'off') throw new Error('--strict must be on or off');
      args.strict = v === 'on';
    }
    else throw new Error(`unexpected argument ${a}`);
  }
  const unknown = args.only.filter((id) => !DESTINATION_IDS.includes(id));
  if (unknown.length) throw new Error(`unknown destination id(s): ${unknown.join(', ')} (known: ${DESTINATION_IDS.join(', ')})`);
  if (!PARALLEL_SETTINGS[args.parallel]) throw new Error(`--parallel must be one of ${Object.keys(PARALLEL_SETTINGS).join(', ')}`);
  return args;
}

function loadDestinations(ids) {
  const { destinations } = JSON.parse(readFileSync(join(FIXTURES_DIR, 'discovery-destinations.json'), 'utf8'));
  return ids.map((id) => {
    const fixture = destinations.find((d) => d.id === id);
    if (!fixture) throw new Error(`destination "${id}" is not in fixtures/discovery-destinations.json`);
    // Built exactly as routes/discovery.js builds it.
    return { id, claudeDestination: `${fixture.label}, ${countryNameFromCode(fixture.countryCode)} (${fixture.countryCode})` };
  });
}

// The live discovery user message (claude.js discoverDestination).
const userMessageFor = (destination) => `Curate the best of ${destination}. Include neighbourhood gems alongside the genuinely unmissable. Be specific, be honest about crowds and tourist traps.`;

function openProbeFile() {
  const dir = join(RUNS_DIR, 'staged-probe');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  return {
    path,
    write(record) {
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    },
  };
}

// The stored copy of a request body: replayed thinking blocks keep their length, never their text or
// signature.
function redactThinking(body) {
  const clone = structuredClone(body);
  for (const m of clone.messages) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map((block) => {
      if (block.type === 'thinking') return { type: 'thinking', thinkingChars: (block.thinking ?? '').length, signatureLength: block.signature?.length ?? 0 };
      if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', dataLength: block.data?.length ?? 0 };
      return block;
    });
  }
  return clone;
}

// One streamed step. Never throws for an API failure (that is data); the step record carries it.
async function runStep(client, body, runStartedAt) {
  const startedAt = Date.now();
  const startOffsetMs = startedAt - runStartedAt;
  const timeline = [];
  let firstEventMs = null;
  let messageDelta = null;
  let message = null;
  let error = null;

  try {
    const stream = client.messages.stream(body);
    stream.on('streamEvent', (event) => {
      const t = Date.now() - startedAt;
      if (firstEventMs === null) firstEventMs = t;
      if (event.type === 'content_block_start') {
        timeline.push({ index: event.index, type: event.content_block?.type ?? null, name: event.content_block?.name ?? null, tStart: t, tStop: null });
      } else if (event.type === 'content_block_stop') {
        const entry = timeline.find((e) => e.index === event.index);
        if (entry) entry.tStop = t;
      } else if (event.type === 'message_delta') {
        messageDelta = event.delta ?? null;
      }
    });
    message = await stream.finalMessage();
  } catch (err) {
    error = err;
  }
  const wallMs = Date.now() - startedAt;

  const blockTimeline = timeline.map((e) => ({
    ...e,
    runTStart: startOffsetMs + e.tStart,
    runTStop: e.tStop === null ? null : startOffsetMs + e.tStop,
  }));
  const firstToolUse = blockTimeline.find((e) => e.type === 'tool_use') ?? null;
  const base = {
    startOffsetMs,
    wallMs,
    firstEventMs,
    blockTimeline,
    firstToolUseStartMs: firstToolUse ? firstToolUse.tStart : null,
    firstToolUseStopMs: firstToolUse ? firstToolUse.tStop : null,
    firstToolUseStopRunMs: firstToolUse ? firstToolUse.runTStop : null,
  };

  if (error || !message) {
    return {
      message: null,
      record: {
        ...base,
        error: { message: error?.message ?? 'no final message', status: error?.status ?? null, name: error?.name ?? null },
        stopReason: null,
        stopDetails: null,
        usage: null,
        thinkingTokens: null,
        thinkingBlocks: 0,
        thinkingChars: [],
        toolUseCount: 0,
        textBlocks: [],
        categories: [],
        costUsd: 0,
      },
    };
  }

  const content = message.content ?? [];
  const thinking = content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  const toolUses = content.filter((b) => b.type === 'tool_use');
  const usage = message.usage ?? null;
  return {
    message,
    record: {
      ...base,
      error: null,
      stopReason: message.stop_reason ?? null,
      // SDK 0.91.1's streamed finalMessage dropped stop_details (F-30-5); the raw message_delta still has it.
      stopDetails: message.stop_details ?? messageDelta?.stop_details ?? null,
      usage,
      thinkingTokens: usage?.output_tokens_details?.thinking_tokens ?? null,
      thinkingBlocks: thinking.length,
      thinkingChars: thinking.map((b) => (b.type === 'thinking' ? (b.thinking ?? '').length : (b.data ?? '').length)),
      toolUseCount: toolUses.length,
      textBlocks: content.filter((b) => b.type === 'text').map((b) => b.text),
      categories: toolUses.map((b) => ({
        category: typeof b.input?.category === 'string' ? b.input.category : null,
        itemCount: Array.isArray(b.input?.items) ? b.input.items.length : null,
        check: checkCategoryInput(b.input),
        // The delivered category itself, so a defect in a later step (a collapsed category, junk in a
        // field) is read from what the model sent, not from its own account of it.
        input: b.input,
      })),
      costUsd: Number(costUsd(MODEL, usage).toFixed(6)),
    },
  };
}

// The next user turn: one tool_result per tool_use. The cache breakpoint sits on the newest turn's
// last block only; earlier turns lose theirs, so a request carries the system block's plus one.
function nextUserTurn(toolUses, categoriesReceived, messages) {
  const content = toolUses.map((block) => {
    const category = typeof block.input?.category === 'string' ? block.input.category : null;
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify({
        received: category,
        remaining: DISCOVERY_CATEGORIES.length - new Set(categoriesReceived.filter((c) => DISCOVERY_CATEGORIES.includes(c))).size,
      }),
    };
  });
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) for (const block of m.content) delete block.cache_control;
  }
  content[content.length - 1].cache_control = { type: 'ephemeral' };
  return { role: 'user', content };
}

function summariseRun(job, startedAt, steps, categoriesReceived, endReason) {
  const distinct = new Set(categoriesReceived.filter((c) => DISCOVERY_CATEGORIES.includes(c)));
  const last = steps[steps.length - 1] ?? null;
  const duplicates = [...new Set(categoriesReceived.filter((c, i) => categoriesReceived.indexOf(c) !== i))];
  const complete = distinct.size === DISCOVERY_CATEGORIES.length && last?.stopReason === 'end_turn';
  const endTurnBeforeEight = last?.stopReason === 'end_turn' && distinct.size < DISCOVERY_CATEGORIES.length;

  const thinkingPerStep = steps.map((s) => s.thinkingTokens);
  const firstToolIndex = steps.findIndex((s) => s.toolUseCount > 0);
  let thinkingBeforeFirstCall = null;
  if (firstToolIndex >= 0) {
    const upTo = thinkingPerStep.slice(0, firstToolIndex + 1);
    thinkingBeforeFirstCall = upTo.every((v) => v !== null) ? sum(upTo) : null;
  }
  const firstCategoryStep = steps.find((s) => s.firstToolUseStopRunMs !== null && s.firstToolUseStopRunMs !== undefined);
  const usageSum = (key) => sum(steps.map((s) => s.usage?.[key] ?? 0));
  const turnsWithACall = steps.filter((s) => s.toolUseCount > 0).length;

  return {
    destination: job.destination.id,
    run: job.run,
    parallel: job.parallel,
    strict: job.strict,
    startedAt,
    outcome: complete ? 'complete' : (endTurnBeforeEight ? 'end_turn_before_eight' : endReason),
    steps,
    totals: {
      steps: steps.length,
      totalWallMs: Date.now() - Date.parse(startedAt),
      firstCategoryMs: firstCategoryStep ? firstCategoryStep.firstToolUseStopRunMs : null,
      step1ThinkingTokens: thinkingPerStep[0] ?? null,
      thinkingBeforeFirstCall,
      thinkingTokensPerStep: thinkingPerStep,
      totalThinkingTokens: sum(thinkingPerStep.map((v) => v ?? 0)),
      totalOutputTokens: usageSum('output_tokens'),
      totalInputTokens: usageSum('input_tokens'),
      totalCacheReadTokens: usageSum('cache_read_input_tokens'),
      totalCacheWriteTokens: usageSum('cache_creation_input_tokens'),
      totalCostUsd: Number(sum(steps.map((s) => s.costUsd)).toFixed(6)),
      categoriesInOrder: categoriesReceived,
      duplicates,
      callsPerTurn: steps.map((s) => s.toolUseCount),
      turnsWithACall,
      turnsWithOneCall: steps.filter((s) => s.toolUseCount === 1).length,
      laterStepsWithThinking: steps.slice(1).filter((s) => s.thinkingBlocks >= 1).length,
      proseOnlyTurns: steps.filter((s) => s.toolUseCount === 0 && s.textBlocks.some((t) => t.trim())).length,
      endTurnBeforeEight,
      schemaInvalidCategories: sum(steps.map((s) => s.categories.filter((c) => !c.check.ok).length)),
    },
  };
}

async function runOnce(client, job, args, guard) {
  const startedAt = new Date().toISOString();
  const runStartedAt = Date.now();
  const system = [{ type: 'text', text: stagedDiscoverySystemPrompt(MODEL), cache_control: { type: 'ephemeral' } }];
  const toolChoice = { type: 'auto', disable_parallel_tool_use: job.parallel === 'disabled' };
  const tool = job.strict ? EMIT_CATEGORY_TOOL : (({ strict, ...rest }) => rest)(EMIT_CATEGORY_TOOL);
  const messages = [{ role: 'user', content: userMessageFor(job.destination.claudeDestination) }];
  const steps = [];
  const categoriesReceived = [];
  let endReason = null;

  for (let n = 1; ; n += 1) {
    if (n > args.maxSteps) {
      endReason = 'max_steps';
      break;
    }
    if (guard.wouldExceed()) {
      endReason = 'stopped_by_spend_guard';
      guard.stopped = `spent $${guard.spent.toFixed(4)} and the largest step cost $${guard.largestStep.toFixed(4)}, over --max-usd ${args.maxUsd}`;
      break;
    }

    // Identical tools, tool_choice and system on every step; only messages grow.
    const body = {
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      system,
      tools: [tool],
      tool_choice: toolChoice,
      messages,
    };
    // Bodies grow with every turn: the first two are stored whole, later ones as a hash.
    const requestFields = n <= 2
      ? { request: redactThinking(body) }
      : { requestSha256: sha256(JSON.stringify(body)) };
    const messagesLength = messages.length;

    const { message, record } = await runStep(client, body, runStartedAt);
    guard.add(record.costUsd);
    steps.push({ step: n, messagesLength, ...requestFields, ...record });

    if (!message) {
      endReason = `api_error: ${[record.error.status, record.error.message].filter(Boolean).join(' ')}`;
      break;
    }
    messages.push({ role: 'assistant', content: message.content });

    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    for (const block of toolUses) categoriesReceived.push(typeof block.input?.category === 'string' ? block.input.category : null);
    if (message.stop_reason !== 'tool_use') {
      endReason = `stop_reason_${message.stop_reason}`;
      break;
    }
    if (!toolUses.length) {
      endReason = 'tool_use_stop_without_tool_use_block';
      break;
    }
    messages.push(nextUserTurn(toolUses, categoriesReceived, messages));
  }

  return summariseRun(job, startedAt, steps, categoriesReceived, endReason);
}

function printSummary(records) {
  console.log('\n=== staged-emission summary ===');
  const settings = [...new Set(records.map((r) => r.parallel))];
  for (const setting of settings) {
    const runs = records.filter((r) => r.parallel === setting);
    console.log(`\nparallel: ${setting} (${runs.length} runs)`);
    console.log('  dest      run  outcome                  steps  1stCat ms  think<1stCall  think/step               calls/turn           cost');
    for (const r of runs) {
      const t = r.totals;
      console.log(
        `  ${r.destination.padEnd(8)}  ${String(r.run).padEnd(3)}  ${r.outcome.padEnd(23).slice(0, 23)}  ${String(t.steps).padEnd(5)}  ` +
        `${show(t.firstCategoryMs).padEnd(9)}  ${show(t.thinkingBeforeFirstCall).padEnd(13)}  ` +
        `${t.thinkingTokensPerStep.map(show).join('/').padEnd(23)}  ${t.callsPerTurn.join('/').padEnd(19)}  $${t.totalCostUsd.toFixed(4)}`,
      );
    }

    const totals = runs.map((r) => r.totals);
    const before = totals.map((t) => t.thinkingBeforeFirstCall).filter((v) => v !== null);
    const medBefore = median(before);
    const oneCall = sum(totals.map((t) => t.turnsWithOneCall));
    const withCall = sum(totals.map((t) => t.turnsWithACall));
    const laterThinking = sum(totals.map((t) => t.laterStepsWithThinking));
    const runsWithLater = totals.filter((t) => t.laterStepsWithThinking > 0).length;
    const prose = sum(totals.map((t) => t.proseOnlyTurns));
    const early = totals.filter((t) => t.endTurnBeforeEight).length;
    const incomplete = runs.filter((r) => r.outcome !== 'complete').length;
    const firstCat = median(totals.map((t) => t.firstCategoryMs).filter((v) => v !== null));
    const wall = median(totals.map((t) => t.totalWallMs));

    const verdicts = [
      [
        `median thinking tokens before the first call <= ${MAX_MEDIAN_THINKING_BEFORE_FIRST_CALL}`,
        medBefore !== null && medBefore <= MAX_MEDIAN_THINKING_BEFORE_FIRST_CALL,
        `median ${show(medBefore)} over ${before.length} runs`,
      ],
      [
        'one emit_category per turn on >= 10/12 of turns with a call',
        withCall > 0 && oneCall / withCall >= MIN_ONE_CALL_PER_TURN_FRACTION,
        `${oneCall}/${withCall}${withCall ? ` = ${(100 * oneCall / withCall).toFixed(0)}%` : ''}`,
      ],
      [
        '>= 1 thinking block on a step after the first (interleaving)',
        laterThinking > 0,
        `${laterThinking} steps in ${runsWithLater} of ${runs.length} runs`,
      ],
      [
        'no prose-only turn, no end_turn before the eighth category',
        prose === 0 && early === 0,
        `${prose} prose-only turns, ${early} early end_turn`,
      ],
    ];
    console.log(`\n  Plan 35 §5 go/no-go (${setting}):`);
    for (const [label, pass, detail] of verdicts) console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${label}  [${detail}]`);
    console.log(`    => ${verdicts.every(([, pass]) => pass) ? 'GO' : 'NO-GO'}${incomplete ? `   (${incomplete} of ${runs.length} runs did not complete)` : ''}`);
    console.log(`    median firstCategoryMs ${show(firstCat)}, median totalWallMs ${show(wall)}`);
  }
}

async function main() {
  const args = parseProbeArgs();
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const destinations = loadDestinations(args.only);
  const settings = PARALLEL_SETTINGS[args.parallel];

  // maxRetries 0: an API error is recorded as the API said it, not retried.
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
  const file = openProbeFile();
  console.log(`stagedEmissionProbe: ${destinations.map((d) => d.id).join(', ')} x ${args.runs} runs, parallel ${settings.join(' + ')}, ${MODEL} (strict ${args.strict ? 'on' : 'off'}, --max-usd ${args.maxUsd}, --max-steps ${args.maxSteps})`);
  console.log('D-30-7: this script imports no database; only the Anthropic API is called.');

  const jobs = [];
  for (const parallel of settings) {
    for (const destination of destinations) {
      for (let run = 1; run <= args.runs; run += 1) jobs.push({ parallel, destination, run, strict: args.strict });
    }
  }

  // Spend guard: do not start a step that, at the most expensive one seen so far, could pass the cap.
  const guard = {
    spent: 0,
    largestStep: 0,
    stopped: null,
    wouldExceed() {
      return this.spent + this.largestStep > args.maxUsd;
    },
    add(cost) {
      this.spent += cost;
      this.largestStep = Math.max(this.largestStep, cost);
    },
  };

  const records = [];
  let skipped = 0;
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      if (guard.stopped) {
        skipped += 1;
        continue;
      }
      const record = await runOnce(client, job, args, guard);
      file.write(record);
      records.push(record);
      const t = record.totals;
      console.log(
        `  ${job.destination.id} run ${job.run} [${job.parallel}]: ${record.outcome}, ${t.steps} steps, ` +
        `first category ${show(t.firstCategoryMs)} ms, thinking before first call ${show(t.thinkingBeforeFirstCall)}, $${t.totalCostUsd.toFixed(4)}`,
      );
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker));

  printSummary(records);
  console.log(`\nrun file: ${file.path}`);
  console.log(`runs ${records.length}, spent $${guard.spent.toFixed(4)}`);
  if (guard.stopped) {
    console.log(`STOPPED by the spend guard: ${guard.stopped}${skipped ? ` (${skipped} runs not started)` : ''}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
