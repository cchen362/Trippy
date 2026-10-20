// Plan 37 — the document-facts contract as the harness sees it.
//
// Shared by facts.mjs (reads documents into facts), schemaProbe.mjs (does the schema compile on both
// 5.5 models?) and readiness.mjs (reads a facts run). W0 wrote the contract here; W1 moved it into
// src/services/claude.js (FACT_KINDS, FACTS_OUTPUT_SCHEMA, FACTS_OUTPUT_FORMAT, FACTS_PROMPT_VERSION,
// FACTS_SYSTEM, the request builders and classifyFactsResponse) and src/services/documentText.js
// (quote matching), byte-identical and pinned by tests/claude.test.js. This file re-exports them, so
// the harness measures exactly what production sends and no two scripts can measure different
// contracts. Only the harness-only items below are defined here.
//
// The schema carries no `maxItems`: the API rejects it on every model measured ("For 'array' type,
// property 'maxItems' is not supported" — Haiku 5.5, Sonnet 5.5, Sonnet 4.6; W0 compile probe,
// 2026-10-20). Plan 37 §4.1 as written stays below as FACTS_OUTPUT_SCHEMA_AS_PLANNED so the probe can
// re-run the rejection; nothing else sends it.

import { FACTS_OUTPUT_SCHEMA } from '../../../src/services/claude.js';

export {
  FACT_KINDS, FACTS_OUTPUT_SCHEMA, FACTS_OUTPUT_FORMAT, FACTS_PROMPT_VERSION, FACTS_SYSTEM,
  buildFactsContextText, buildFactsRequest, classifyFactsResponse,
} from '../../../src/services/claude.js';
export { normaliseForMatch, findQuote } from '../../../src/services/documentText.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// The kinds G-37-1 and B1/B2 are measured on: a wrong one costs the traveller money or a missed slot.
export const COSTLY_FACT_KINDS = Object.freeze(['deadline', 'window', 'requirement']);

// FACTS_OUTPUT_SCHEMA plus §4.1's `maxItems: 40`. The API rejected it on Haiku 5.5, Sonnet 5.5 and
// Sonnet 4.6 (W0 compile probe, 2026-10-20); schemaProbe.mjs sends it under `facts-plan-haiku-5-5`
// so the rejection can be re-run against a future API. No read ever sends it.
export const FACTS_OUTPUT_SCHEMA_AS_PLANNED = (() => {
  const copy = structuredClone(FACTS_OUTPUT_SCHEMA);
  copy.properties.facts = { type: 'array', maxItems: 40, items: copy.properties.facts.items };
  return deepFreeze(copy);
})();
