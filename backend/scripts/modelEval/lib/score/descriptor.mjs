// Descriptor scoring (Plan 30 §5.3, W2 gate; Plan 34 §5.1 W2). Works from the recorded raw response
// text, because the service coerces sceneType before returning: "before coercion" metrics are only
// visible in the raw answer.
//
// Two answer contracts are scored, told apart per record by the recorded request:
//   - schema (Plan 34 W2): the request carried output_config.format; the answer is exactly one text
//     block holding only JSON. A photoQuery over 8 words is sent as written and logged (D-34-12),
//     never cut.
//   - fenced (W0 baselines and the 5.5 control): the answer is the first ```json fence in prose,
//     and the service truncated an over-long photoQuery to 8 words.

import {
  SCENE_TYPES,
  PHOTO_DESCRIPTOR_OUTPUT_SCHEMA,
  validateAgainstSchema,
} from '../../../../src/services/claude.js';
import { median, max, rate } from './common.mjs';

const words = (s) => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean) : []);
const sameQuery = (a, b) => words(a).join(' ').toLowerCase() === words(b).join(' ').toLowerCase();

const isSchemaContract = (record) => Boolean(record.calls?.at(-1)?.request?.output_config?.format);

function rawDescriptor(record) {
  const blocks = record.calls?.at(-1)?.response?.content ?? [];
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string');
  if (isSchemaContract(record)) {
    // Schema contract: the single text block is the whole answer.
    if (texts.length !== 1) return { text: texts.map((b) => b.text).join(''), parsed: null };
    try {
      return { text: texts[0].text, parsed: JSON.parse(texts[0].text) };
    } catch {
      return { text: texts[0].text, parsed: null };
    }
  }
  // Fenced contract: mirrors the old parse, first ```json fence in the concatenated text blocks.
  const text = texts.map((b) => b.text).join('');
  const match = text.match(/```json\r?\n([\s\S]*?)\r?\n?```/);
  if (!match) return { text, parsed: null };
  try {
    return { text, parsed: JSON.parse(match[1]) };
  } catch {
    return { text, parsed: null };
  }
}

// The schema the request actually carried (a Plan 34 W3 'broad-query' request carries the live schema plus a
// required broadQuery), else the live constant.
const requestSchema = (record) => record.calls?.at(-1)?.request?.output_config?.format?.schema ?? PHOTO_DESCRIPTOR_OUTPUT_SCHEMA;

// Schema-valid per validateAgainstSchema (which case-normalises enums: the exact-vocabulary check
// stays in sceneValid) and a non-empty photoQuery.
function schemaValid(parsed, schema) {
  if (!parsed || !validateAgainstSchema(parsed, schema).ok) return false;
  return typeof parsed.photoQuery === 'string' && parsed.photoQuery.trim().length > 0;
}

export function score(records) {
  const n = records.length;
  const rows = records.map((r) => {
    const { parsed } = rawDescriptor(r);
    const place = r.extra?.place ?? {};
    const rawQuery = typeof parsed?.photoQuery === 'string' ? parsed.photoQuery.trim() : null;
    const rawScene = typeof parsed?.sceneType === 'string' ? parsed.sceneType : null;
    const apiFailed = r.calls.some((c) => c.error);
    return {
      id: r.fixtureId,
      title: place.title,
      record: r,
      fallback: r.output === null,
      apiFailed,
      maxTokens: r.stopReason === 'max_tokens',
      schemaContract: isSchemaContract(r),
      endTurn: r.stopReason === 'end_turn',
      schemaOk: schemaValid(parsed, requestSchema(r)),
      rawQuery,
      rawScene,
      sceneValid: rawScene !== null && SCENE_TYPES.includes(rawScene),
      acceptable: r.output?.sceneType ? (place.acceptableSceneTypes ?? []).includes(r.output.sceneType) : false,
      queryWords: rawQuery ? words(rawQuery).length : null,
      broadQuery: typeof r.extra?.broadQuery === 'string' ? r.extra.broadQuery.trim() : null,
    };
  });

  const schemaRows = rows.filter((r) => r.schemaContract);
  const contract = schemaRows.length === 0 ? 'fenced' : schemaRows.length === n ? 'schema' : `mixed (${schemaRows.length} schema / ${n - schemaRows.length} fenced)`;
  const schemaEnd = schemaRows.filter((r) => r.endTurn);
  const withQuery = rows.filter((r) => r.queryWords !== null);
  const summary = {
    contract,
    'schema-valid (of end_turn)': schemaRows.length
      ? `${rate(schemaEnd.filter((r) => r.schemaOk).length, schemaEnd.length)}${schemaRows.length < n ? ' (schema records only)' : ''}`
      : '— (fenced)',
    refusals: rate(records.filter((r) => r.stopReason === 'refusal').length, n),
    'fallback (null) results': rate(rows.filter((r) => r.fallback).length, n),
    'of which API call failed': rate(rows.filter((r) => r.fallback && r.apiFailed).length, n),
    'max_tokens stops': rate(rows.filter((r) => r.maxTokens).length, n),
    'sceneType valid before coercion': rate(rows.filter((r) => r.sceneValid).length, n),
    'sceneType within acceptable set': rate(rows.filter((r) => r.acceptable).length, n),
    'photoQuery > 8 words (raw)': rate(withQuery.filter((r) => r.queryWords > 8).length, withQuery.length),
    'photoQuery words median / max': `${median(withQuery.map((r) => r.queryWords))} / ${max(withQuery.map((r) => r.queryWords))}`,
  };

  // Plan 34 W3: rows only when the run asked for a broadQuery (profile w3-broad).
  const hasBroad = records.some((r) => 'broadQuery' in (r.extra ?? {}));
  if (hasBroad) {
    const withBroad = rows.filter((r) => r.broadQuery);
    const broadWords = withBroad.map((r) => words(r.broadQuery).length);
    summary['broadQuery present'] = rate(withBroad.length, n);
    summary['broadQuery words median / max'] = `${median(broadWords)} / ${max(broadWords)}`;
    summary['broadQuery > 4 words'] = rate(broadWords.filter((w) => w > 4).length, withBroad.length);
    summary['broadQuery identical to photoQuery'] = rate(withBroad.filter((r) => r.rawQuery && sameQuery(r.broadQuery, r.rawQuery)).length, withBroad.length);
  }

  const perItem = rows.map((r) => ({
    id: r.id,
    title: r.title,
    photoQuery: r.rawQuery,
    ...(hasBroad ? { broadQuery: r.broadQuery } : {}),
    sceneType: r.rawScene,
    acceptable: r.acceptable,
    'out tok': r.record.usage.output_tokens,
    'wall ms': r.record.wallMs,
  }));

  const notes = [];
  if (withQuery.some((r) => r.queryWords > 8 && r.schemaContract)) {
    notes.push('photoQuery > 8 words (raw): under the schema contract the service sends such a query as written and logs a warning (D-34-12; never cut).');
  }
  const invalid = rows.filter((r) => !r.fallback && !r.sceneValid);
  if (invalid.length) notes.push(`out-of-vocabulary sceneType: ${invalid.map((r) => `${r.id}=${r.rawScene}`).join(', ')}`);
  const wrongScene = rows.filter((r) => !r.fallback && r.sceneValid && !r.acceptable);
  if (wrongScene.length) notes.push(`valid but outside the acceptable set: ${wrongScene.map((r) => `${r.id}=${r.rawScene}`).join(', ')}`);
  return { summary, perItem, notes };
}
