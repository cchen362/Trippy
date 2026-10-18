// Descriptor scoring (Plan 30 §5.3, W2 gate). Works from the recorded raw response text, because
// the service coerces sceneType and truncates photoQuery before returning: "pre-coercion" and
// "pre-truncation" metrics are only visible in the raw fenced JSON.

import { SCENE_TYPES } from '../../../../src/services/claude.js';
import { median, max, rate } from './common.mjs';

const words = (s) => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean) : []);

// Mirrors generatePhotoDescriptor's parse: first ```json fence in the concatenated text blocks.
function rawDescriptor(record) {
  const text = (record.calls.at(-1)?.response?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const match = text.match(/```json\r?\n([\s\S]*?)\r?\n?```/);
  if (!match) return { text, parsed: null };
  try {
    return { text, parsed: JSON.parse(match[1]) };
  } catch {
    return { text, parsed: null };
  }
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
      rawQuery,
      rawScene,
      sceneValid: rawScene !== null && SCENE_TYPES.includes(rawScene),
      acceptable: r.output?.sceneType ? (place.acceptableSceneTypes ?? []).includes(r.output.sceneType) : false,
      queryWords: rawQuery ? words(rawQuery).length : null,
    };
  });

  const withQuery = rows.filter((r) => r.queryWords !== null);
  const summary = {
    'fallback (null) results': rate(rows.filter((r) => r.fallback).length, n),
    'of which API call failed': rate(rows.filter((r) => r.fallback && r.apiFailed).length, n),
    'max_tokens stops': rate(rows.filter((r) => r.maxTokens).length, n),
    'sceneType valid before coercion': rate(rows.filter((r) => r.sceneValid).length, n),
    'sceneType within acceptable set': rate(rows.filter((r) => r.acceptable).length, n),
    'photoQuery > 8 words before truncation': rate(withQuery.filter((r) => r.queryWords > 8).length, withQuery.length),
    'photoQuery words median / max': `${median(withQuery.map((r) => r.queryWords))} / ${max(withQuery.map((r) => r.queryWords))}`,
  };

  const perItem = rows.map((r) => ({
    id: r.id,
    title: r.title,
    photoQuery: r.rawQuery,
    sceneType: r.rawScene,
    acceptable: r.acceptable,
    'out tok': r.record.usage.output_tokens,
    'wall ms': r.record.wallMs,
  }));

  const notes = [];
  const invalid = rows.filter((r) => !r.fallback && !r.sceneValid);
  if (invalid.length) notes.push(`out-of-vocabulary sceneType: ${invalid.map((r) => `${r.id}=${r.rawScene}`).join(', ')}`);
  const wrongScene = rows.filter((r) => !r.fallback && r.sceneValid && !r.acceptable);
  if (wrongScene.length) notes.push(`valid but outside the acceptable set: ${wrongScene.map((r) => `${r.id}=${r.rawScene}`).join(', ')}`);
  return { summary, perItem, notes };
}
