// Plan 30 §5.3 co-pilot metrics. score(records) -> { summary, perItem, notes }.
//
// Every number is derived from the recorded turn: the SSE events the fake response captured (with
// timestamps), the tool inputs and results the wrapped executors recorded, and the API calls the
// recorder captured (block order in the terminal call, usage, cache reads). Nothing is re-run.
//
// E-COP-1 (Plan 30 §5.3): on every turn that emitted a proposal, the explanation the prompt asks
// for must reach the panel as text. Two independent readings are reported:
//   * the streamed SSE: characters of text events before the proposal event (> 0), and
//   * the terminal API call: a `text` block started before the propose_itinerary_changes tool_use
//     (a thinking-only lead-in or an empty progress-update block does not count).

import { max, median, sum } from './common.mjs';

const PROPOSE = 'propose_itinerary_changes';
const SEARCH = 'search_discovery_catalogue';
const HEALTH = 'check_trip_health';

const TOOL_ABBREV = { [SEARCH]: 'search', [HEALTH]: 'health', [PROPOSE]: 'propose' };
const abbreviate = (name) => TOOL_ABBREV[name] ?? name;

// Fallback output-tokens-per-character ratio when no record in the run is free of thinking blocks.
const FALLBACK_TOKENS_PER_CHAR = 0.30;
const KEEPALIVE_TURN_MS = 10000;

function isSubsequence(expected, actual) {
  let i = 0;
  for (const name of actual) if (name === expected[i]) i += 1;
  return i === expected.length;
}

function toolSequence(output, hasProposal) {
  const sequence = output.toolCalls.map((c) => c.name);
  if (hasProposal) sequence.push(PROPOSE);
  return sequence;
}

function terminalCall(record) {
  const calls = (record.calls ?? []).filter((c) => c.kind === 'stream' && c.response);
  return calls.at(-1) ?? null;
}

// First text block started before the propose tool_use in the terminal call.
function terminalTextBeforeTool(call) {
  if (!call) return null;
  const timeline = call.blockTimeline ?? [];
  const toolIndex = timeline.findIndex((b) => b.type === 'tool_use' && b.name === PROPOSE);
  if (toolIndex === -1) return null;
  const textIndex = timeline.findIndex((b) => b.type === 'text');
  return textIndex !== -1 && textIndex < toolIndex;
}

// Characters of the thinking block that immediately precedes the propose tool_use in the terminal
// call (0 when that block is not a thinking block or its text is empty); null when there is no
// propose tool_use. Under thinking display 'updates' this text is the model's progress update.
function updateCharsBeforeTool(call) {
  if (!call) return null;
  const content = call.response?.content ?? [];
  const toolIndex = content.findIndex((b) => b.type === 'tool_use' && b.name === PROPOSE);
  if (toolIndex === -1) return null;
  const before = content[toolIndex - 1];
  return before?.type === 'thinking' ? (before.thinking ?? '').length : 0;
}

// Earliest moment anything readable reached the turn: the first streamed text event, or the start
// of any thinking block (in any API call) whose recorded text is non-empty. Times are relative to
// the turn start: SSE `t`, and call.startedAtMs + the block's start within its own call.
function firstVisibleMs(record, firstTextMs) {
  const times = firstTextMs === null ? [] : [firstTextMs];
  for (const call of streamCalls(record)) {
    const content = call.response.content ?? [];
    for (const entry of call.blockTimeline ?? []) {
      if (entry.type === 'thinking' && (content[entry.index]?.thinking ?? '') !== '') {
        times.push(call.startedAtMs + entry.t);
      }
    }
  }
  return times.length ? Math.min(...times) : null;
}

function thinkingBlocks(call) {
  return call ? (call.blockTimeline ?? []).filter((b) => b.type === 'thinking').length : 0;
}

function streamCalls(record) {
  return (record.calls ?? []).filter((c) => c.kind === 'stream' && c.response);
}

function blockSignature(call) {
  return (call?.blockTimeline ?? []).map((b) => (b.type === 'tool_use' ? `tool_use:${abbreviate(b.name)}` : b.type)).join('>');
}

// Largest silence between consecutive SSE events of any type, counting t=0 to the first event.
function maxEventGap(events) {
  let prev = 0;
  let gap = 0;
  for (const e of events) {
    gap = Math.max(gap, e.t - prev);
    prev = e.t;
  }
  return events.length ? gap : null;
}

// Characters the model billed as visible output: streamed text plus every tool_use input.
function visibleOutputChars(record) {
  const toolInput = streamCalls(record)
    .flatMap((c) => c.response.content ?? [])
    .filter((b) => b.type === 'tool_use')
    .reduce((n, b) => n + JSON.stringify(b.input ?? {}).length, 0);
  return (record.output.fullText ?? '').length + toolInput;
}

function thinkingStats(record) {
  const calls = streamCalls(record);
  const blocks = calls.reduce((n, c) => n + (c.blockTimeline ?? []).filter((b) => b.type === 'thinking').length, 0);
  const chars = calls
    .flatMap((c) => c.response.content ?? [])
    .filter((b) => b.type === 'thinking')
    .reduce((n, b) => n + (b.thinking ?? '').length, 0);
  // Sonnet 5.5 reports thinking tokens exactly; exact only when every stream call carries the count.
  const counts = calls.map((c) => c.response.usage?.output_tokens_details?.thinking_tokens);
  const exactTokens = counts.length && counts.every((x) => typeof x === 'number' && Number.isFinite(x)) ? sum(counts) : null;
  return { blocks, chars, exactTokens };
}

function auditOperations(operations, seed, searchPlaceIds) {
  const dayIds = new Set(seed.dayIds);
  const stopIds = new Set(seed.stopIds);
  const bookingLinked = new Set(seed.bookingLinkedStopIds);
  const result = {
    invalidIds: 0, bookingLinkedTargets: 0, adds: 0, addsWithoutPlaceId: 0, addsPlaceNotInResults: 0, timesSet: 0,
  };

  for (const op of operations) {
    if (op.action === 'add_stop') {
      result.adds += 1;
      if (!dayIds.has(op.dayId)) result.invalidIds += 1;
      if (!Number.isInteger(op.placeId)) result.addsWithoutPlaceId += 1;
      else if (!searchPlaceIds.has(op.placeId)) result.addsPlaceNotInResults += 1;
      if (op.stop?.time != null) result.timesSet += 1;
    } else {
      if (!stopIds.has(op.stopId)) result.invalidIds += 1;
      if (bookingLinked.has(op.stopId)) result.bookingLinkedTargets += 1;
      if (op.action === 'move_stop' && !dayIds.has(op.toDayId)) result.invalidIds += 1;
      if (op.action === 'update_stop' && op.fields?.time != null) result.timesSet += 1;
    }
  }
  return result;
}

function analyse(record) {
  const { output, extra } = record;
  const expect = extra.expect;
  const events = output.events;

  const proposalIndex = events.findIndex((e) => e.event.type === 'proposal');
  const proposalEvent = proposalIndex === -1 ? null : events[proposalIndex].event;
  const hasProposal = proposalEvent !== null;
  const textEvents = events.filter((e) => e.event.type === 'text');
  const sequence = toolSequence(output, hasProposal);

  const sequenceOk = expect.toolsMode === 'exact'
    ? JSON.stringify(sequence) === JSON.stringify(expect.tools)
    : isSubsequence(expect.tools, sequence);
  const forbiddenUsed = (expect.forbidTools ?? []).filter((name) => sequence.includes(name));

  const searchResults = output.toolCalls.filter((c) => c.name === SEARCH);
  const statesSeen = [...new Set(searchResults.map((c) => c.result?.catalogueState).filter(Boolean))];
  const searchPlaceIds = new Set(searchResults.flatMap((c) => (c.result?.places ?? []).map((p) => p.placeId)));

  const textBeforeProposal = hasProposal
    ? events.slice(0, proposalIndex).filter((e) => e.event.type === 'text').reduce((n, e) => n + e.event.content.length, 0)
    : null;
  const terminal = terminalCall(record);
  const textBlockFirst = hasProposal ? terminalTextBeforeTool(terminal) : null;
  const updateChars = hasProposal ? updateCharsBeforeTool(terminal) : null;

  const ops = hasProposal ? proposalEvent.operations : [];
  const audit = auditOperations(ops, extra.seed, searchPlaceIds);
  if (expect.timeAllowed) audit.timesSet = 0;

  const searchCategoryOk = expect.searchCategory
    ? searchResults.some((c) => c.input?.category === expect.searchCategory)
    : null;
  const healthDayOk = expect.healthDayNumber
    ? output.toolCalls.some((c) => c.name === HEALTH && c.input?.dayId === extra.seed.dayIds[expect.healthDayNumber - 1])
    : null;

  const noticeKinds = events.filter((e) => e.event.type === 'notice').map((e) => e.event.notice);
  const apiCalls = (record.calls ?? []).filter((c) => c.kind === 'stream');
  const capNoticeSent = apiCalls.some((c) => JSON.stringify(c.request.messages ?? []).includes('Query tool budget for this turn'));
  const aborted = extra.abortAfterFirstText;
  const thinking = thinkingStats(record);

  return {
    record,
    expect,
    sequence,
    sequenceOk,
    forbiddenUsed,
    hasProposal,
    proposesOk: hasProposal === expect.proposes,
    textBeforeProposal,
    textBlockFirst,
    updateChars,
    thinkingBlocksInTerminal: thinkingBlocks(terminal),
    thinkingBlocksAll: thinking.blocks,
    thinkingChars: thinking.chars,
    thinkingExactTokens: thinking.exactTokens,
    outputTokens: record.usage?.output_tokens ?? 0,
    visibleChars: visibleOutputChars(record),
    maxGapMs: maxEventGap(events),
    noticeKinds,
    blocks: hasProposal ? blockSignature(terminal) : null,
    statesSeen,
    stateRelayed: expect.catalogueState && searchResults.length ? statesSeen.includes(expect.catalogueState) : null,
    audit,
    validation: output.validation,
    searchCategoryOk,
    healthDayOk,
    ttfdMs: textEvents.length ? textEvents[0].t : null,
    ttfvMs: firstVisibleMs(record, textEvents.length ? textEvents[0].t : null),
    iterations: apiCalls.length,
    truncated: noticeKinds.includes('truncated'),
    silent: !aborted && textEvents.length === 0 && !hasProposal,
    silentWithoutNotice: !aborted && textEvents.length === 0 && !hasProposal && noticeKinds.length === 0,
    errored: events.some((e) => e.event.type === 'error') || Boolean(record.error),
    endedClean: aborted ? !events.some((e) => e.event.type === 'done') && !hasProposal : null,
    capNoticeSent,
    // Cache reads on iterations 2+ only: the first iteration may read a prefix an earlier scenario
    // already wrote (ids are deterministic, so the system block is shared), which says nothing about
    // whether a turn's own follow-up iterations reuse the cache.
    cacheRead: apiCalls.slice(1).reduce((n, c) => n + (c.response?.usage?.cache_read_input_tokens ?? 0), 0),
  };
}

const frac = (count, n) => `${count}/${n}`;
const yn = (value) => (value === null ? '—' : value ? 'yes' : 'NO');

export function score(records) {
  const analyses = records.map(analyse);
  const n = analyses.length;
  if (!n) return { summary: {}, perItem: [], notes: ['no records'] };

  const proposing = analyses.filter((a) => a.hasProposal);
  const multi = analyses.filter((a) => a.iterations > 1);
  const stateExpected = analyses.filter((a) => a.stateRelayed !== null);
  const timed = analyses.filter((a) => a.ttfdMs !== null);
  const timedVisible = analyses.filter((a) => a.ttfvMs !== null);

  const notAborted = analyses.filter((a) => !a.record.extra.abortAfterFirstText);

  const longTurns = analyses.filter((a) => a.record.wallMs > KEEPALIVE_TURN_MS && a.maxGapMs !== null);
  const worstGap = max(longTurns.map((a) => a.maxGapMs));

  // Thinking text is empty under the default display, so thinking tokens are estimated as output
  // tokens minus visible output at the run's own tokens-per-char ratio, measured on turns that
  // produced no thinking block (Plan 30 W4 method).
  const thinkingFree = analyses.filter((a) => a.thinkingBlocksAll === 0);
  const ratioChars = sum(thinkingFree.map((a) => a.visibleChars));
  const ratioMeasured = ratioChars > 0;
  const tokensPerChar = ratioMeasured ? sum(thinkingFree.map((a) => a.outputTokens)) / ratioChars : FALLBACK_TOKENS_PER_CHAR;
  for (const a of analyses) {
    a.thinkingExact = a.thinkingExactTokens !== null;
    a.thinkingEst = a.thinkingExact ? a.thinkingExactTokens : Math.max(0, Math.round(a.outputTokens - a.visibleChars * tokensPerChar));
  }
  const exactCount = analyses.filter((a) => a.thinkingExact).length;
  const totalOutput = sum(analyses.map((a) => a.outputTokens));
  const thinkShare = totalOutput ? Math.round((100 * sum(analyses.map((a) => a.thinkingEst))) / totalOutput) : 0;

  const sumAudit = (key) => proposing.reduce((s, a) => s + a.audit[key], 0);
  const totalAdds = sumAudit('adds');

  const summary = {
    'scenarios': n,
    'tool sequence as expected': frac(analyses.filter((a) => a.sequenceOk && !a.forbiddenUsed.length).length, n),
    'proposes as expected': frac(analyses.filter((a) => a.proposesOk).length, n),
    'E-COP-1 text before proposal (SSE)': frac(proposing.filter((a) => a.textBeforeProposal > 0).length, proposing.length),
    'E-COP-1 text block before tool_use (terminal call)': frac(proposing.filter((a) => a.textBlockFirst === true).length, proposing.length),
    'E-COP-1 remedy: non-empty progress-update text right before the propose tool_use (terminal call)': frac(proposing.filter((a) => a.updateChars > 0).length, proposing.length),
    'E-COP-1 either: text before proposal OR non-empty update before tool_use': frac(proposing.filter((a) => a.textBeforeProposal > 0 || a.updateChars > 0).length, proposing.length),
    'proposal ids all real': frac(proposing.filter((a) => a.audit.invalidIds === 0).length, proposing.length),
    'proposal passes server validation': frac(proposing.filter((a) => a.validation?.ok).length, proposing.length),
    'booking-linked stops targeted': sumAudit('bookingLinkedTargets'),
    'add_stop without placeId': frac(sumAudit('addsWithoutPlaceId'), totalAdds),
    'add_stop placeId not in this turn\'s search results': frac(sumAudit('addsPlaceNotInResults'), totalAdds),
    'clock time set without a request': sumAudit('timesSet'),
    'expected catalogueState relayed in a tool result': frac(stateExpected.filter((a) => a.stateRelayed).length, stateExpected.length),
    'time to first text ms: median / max': `${median(timed.map((a) => a.ttfdMs))} / ${max(timed.map((a) => a.ttfdMs))} (n=${timed.length})`,
    'time to first visible output ms (text, or thinking block with text): median / max (n)': `${median(timedVisible.map((a) => a.ttfvMs))} / ${max(timedVisible.map((a) => a.ttfvMs))} (n=${timedVisible.length})`,
    'turn total ms: median / max': `${median(analyses.map((a) => a.record.wallMs))} / ${max(analyses.map((a) => a.record.wallMs))}`,
    'API iterations per turn: median / max': `${median(analyses.map((a) => a.iterations))} / ${max(analyses.map((a) => a.iterations))}`,
    'truncation notices': frac(analyses.filter((a) => a.truncated).length, n),
    'silent turns (no text, no proposal)': frac(analyses.filter((a) => a.silent).length, n),
    'turns with an error event': frac(analyses.filter((a) => a.errored).length, n),
    'cache read tokens on iterations 2+, multi-iteration turns: median': `${median(multi.map((a) => a.cacheRead))} (n=${multi.length})`,
    'turns that hit the query cap': frac(analyses.filter((a) => a.capNoticeSent).length, n),
    'cost per turn ($): median / mean': `${median(analyses.map((a) => a.record.costUsd)).toFixed(5)} / ${(analyses.reduce((s, a) => s + a.record.costUsd, 0) / n).toFixed(5)}`,
    'max gap between SSE events ms on turns > 10 s: max': `${worstGap ?? '—'} (n=${longTurns.length})`,
    'turns > 10 s with an SSE gap > 10 s': frac(longTurns.filter((a) => a.maxGapMs > KEEPALIVE_TURN_MS).length, longTurns.length),
    'thinking blocks: turns with >= 1 (any call)': frac(analyses.filter((a) => a.thinkingBlocksAll > 0).length, n),
    'turns with any non-empty thinking text (any call)': frac(analyses.filter((a) => a.thinkingChars > 0).length, n),
    'thinking tokens (exact where the API reports them, else estimated): median / max (share of output)': `${median(analyses.map((a) => a.thinkingEst))} / ${max(analyses.map((a) => a.thinkingEst))} (${thinkShare}%)`,
    'text-less, proposal-less turns without a notice': frac(notAborted.filter((a) => a.silentWithoutNotice).length, notAborted.length),
  };

  const perItem = analyses.map((a) => ({
    scenario: a.record.fixtureId,
    tools: a.sequence.map(abbreviate).join('>') || '(none)',
    toolsOk: yn(a.sequenceOk && !a.forbiddenUsed.length),
    proposes: `${a.hasProposal ? 'yes' : 'no'}${a.proposesOk ? '' : ' (UNEXPECTED)'}`,
    textBefore: a.textBeforeProposal === null ? '—' : a.textBeforeProposal,
    textBlockFirst: yn(a.textBlockFirst),
    updateChars: a.updateChars === null ? '—' : a.updateChars,
    thinkBlk: a.thinkingBlocksInTerminal,
    thinkBlkAll: a.thinkingBlocksAll,
    thinkEst: a.thinkingEst,
    thinkExact: yn(a.thinkingExact),
    thinkChars: a.thinkingChars,
    blocks: a.blocks ?? '—',
    ids: a.hasProposal ? yn(a.audit.invalidIds === 0) : '—',
    valid: a.validation ? yn(a.validation.ok) : '—',
    bookingHits: a.audit.bookingLinkedTargets,
    adds: a.audit.adds ? `${a.audit.adds - a.audit.addsWithoutPlaceId - a.audit.addsPlaceNotInResults}/${a.audit.adds} grounded` : '—',
    timesSet: a.audit.timesSet,
    state: a.statesSeen.join(',') || '—',
    stateOk: yn(a.stateRelayed),
    ttfdMs: a.ttfdMs ?? '—',
    ttfvMs: a.ttfvMs ?? '—',
    totalMs: a.record.wallMs,
    iters: a.iterations,
    trunc: a.truncated ? 'YES' : '',
    silent: a.silent ? 'YES' : '',
    notice: a.noticeKinds.join(','),
    maxGapMs: a.maxGapMs ?? '—',
    cacheRd2plus: a.cacheRead,
    costUsd: a.record.costUsd,
    ...(a.expect.searchCategory ? { category: yn(a.searchCategoryOk) } : {}),
    ...(a.expect.healthDayNumber ? { dayScoped: yn(a.healthDayOk) } : {}),
    ...(a.endedClean !== null ? { abortClean: yn(a.endedClean) } : {}),
  }));

  const failures = analyses.flatMap((a) => {
    const reasons = [];
    if (!a.sequenceOk) reasons.push(`tools [${a.sequence.join(', ')}] vs expected [${a.expect.tools.join(', ')}] (${a.expect.toolsMode})`);
    if (a.forbiddenUsed.length) reasons.push(`used forbidden ${a.forbiddenUsed.join(', ')}`);
    if (!a.proposesOk) reasons.push(`proposal ${a.hasProposal ? 'emitted' : 'missing'}`);
    if (a.validation && !a.validation.ok) reasons.push(`validation: ${a.validation.reason}`);
    return reasons.length ? [`${a.record.fixtureId}: ${reasons.join('; ')}`] : [];
  });

  const notes = [
    'qualitative checks (warm decline, honest relay of catalogue state, reply language) are not scored — read output.fullText in the run file for the scenarios flagged in expect.notes.',
    'the "generating" catalogue state cannot be exercised by this harness (it would fire a real background generation, D-30-7).',
    ratioMeasured
      ? `thinking estimate uses ${tokensPerChar.toFixed(3)} output tokens per visible char, measured on ${thinkingFree.length}/${n} turns with no thinking block.`
      : `no turn in this run is free of thinking blocks, so the thinking estimate uses the fallback ${FALLBACK_TOKENS_PER_CHAR} output tokens per visible char.`,
    `thinking tokens: ${exactCount}/${n} records use the API's exact thinking_tokens count; the rest use the per-char estimate.`,
    ...(failures.length ? [`mismatches: ${failures.join(' | ')}`] : []),
  ];
  return { summary, perItem, notes };
}
