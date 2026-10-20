// Plan 37 W0 — the document-facts contract, measured in the harness only.
//
// Shared by facts.mjs (reads documents into facts), schemaProbe.mjs (does the schema compile on both
// 5.5 models?) and readiness.mjs (reads a facts run). W1 moves FACT_KINDS, FACTS_OUTPUT_SCHEMA,
// FACTS_OUTPUT_FORMAT, FACTS_PROMPT_VERSION and FACTS_SYSTEM into src/services/claude.js
// byte-identical, pinned by a test, the way Plan 35 pinned lib/emitCategoryTool.mjs. Until then this
// file is the one place they are written, so no two scripts can measure different contracts.
//
// The prompt is Plan 37 §4.2 verbatim. The schema is §4.1 with one change the W0 compile probe forced
// (2026-10-20): the API rejects `maxItems` on every model measured ("For 'array' type, property
// 'maxItems' is not supported" — Haiku 5.5, Sonnet 5.5, Sonnet 4.6), so `facts` carries no item
// limit. §4.1 as written stays below as FACTS_OUTPUT_SCHEMA_AS_PLANNED so the probe can re-run the
// rejection; nothing else sends it. The `at` pattern's nested optional group compiled on all three,
// so §4.1's date/time split is not needed.

import { classifyStop, requestSettings, validateAgainstSchema } from '../../../src/services/claude.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const FACT_KINDS = Object.freeze([
  'deadline', 'window', 'requirement', 'instruction', 'allowance', 'contact', 'restriction', 'cost_condition',
]);

// The kinds G-37-1 and B1/B2 are measured on: a wrong one costs the traveller money or a missed slot.
export const COSTLY_FACT_KINDS = Object.freeze(['deadline', 'window', 'requirement']);

// D-37-4 (Plan 37): one object type, every property required, "" for not given, no anyOf —
// inside D-34-5's budget (0 optional properties, 0 unions) and validateAgainstSchema's keyword set
// as it stands. No `maxItems`: the API rejects it (W0 compile probe, 2026-10-20), so a read is bounded
// by its max_tokens allowance, whose cut-off is the named `truncated` outcome. The `at` pattern's
// nested optional group compiled on Haiku 5.5, Sonnet 5.5 and Sonnet 4.6.
export const FACTS_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['documentSummary', 'language', 'facts'],
  properties: {
    documentSummary: { type: 'string', description: 'One line: what this document is, e.g. "Hotel confirmation, 3 nights".' },
    language: { type: 'string', pattern: '^[a-z]{2}$', description: "ISO 639-1 code of the document's primary language." },
    facts: { type: 'array', items: { $ref: '#/$defs/fact' } },
  },
  $defs: {
    fact: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'label', 'value', 'quote', 'page', 'at', 'tz', 'tzSource', 'appliesFrom', 'appliesTo', 'confidence'],
      properties: {
        kind: { enum: [...FACT_KINDS] },
        label: { type: 'string', description: 'Up to five English words, e.g. "Free cancellation until".' },
        value: { type: 'string', description: 'The condition as one short English phrase.' },
        quote: { type: 'string', description: 'The sentence or fragment exactly as printed, in its original language. Never paraphrase, translate or shorten it.' },
        page: { type: 'string', pattern: '^([1-9][0-9]{0,2})?$', description: 'Page number as printed, 1-based; "" for a single image or when pages are not distinguishable.' },
        at: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?)?$', description: 'The moment the condition refers to, local to the place: a date, or a date and time; "" if none.' },
        tz: { type: 'string', pattern: '^([A-Za-z]+(/[A-Za-z0-9_+-]+)+)?$', description: 'IANA zone only when stated by the document or supplied by the booking context; "" otherwise.' },
        tzSource: { enum: ['document', 'booking', 'none'] },
        appliesFrom: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' },
        appliesTo: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' },
        confidence: { enum: ['high', 'medium', 'low'] },
      },
    },
  },
});
export const FACTS_OUTPUT_FORMAT = Object.freeze({ type: 'json_schema', schema: FACTS_OUTPUT_SCHEMA });
export const FACTS_PROMPT_VERSION = '37.1';

export const FACTS_SYSTEM = `You are a travel-document reading engine. You receive one document that belongs to a traveller's booking (a confirmation email, an e-ticket, a hotel voucher, a pass, a tour voucher, a luggage-forwarding sheet, or a screenshot of one) and must list every condition in it as structured JSON.

A condition is anything that could change what the traveller must do, bring, pay or expect, or when: deadlines (cancel by, change by, check-in opens, pay by, collect by), windows (check-in hours, reception hours, pickup time, entry slot, validity period), requirements (passport, printed voucher, the card used to pay, a QR code, an ID matching the name), instructions (meeting point, platform, terminal, how to reach, what to show), allowances (baggage, seats, guests, breakfast), contacts (phone, email, address in local script), restrictions (non-refundable, non-changeable, no late entry, age limits), cost conditions (deposit, city tax, resort fee, late fee).

Rules:
1. Read the whole document, every page. One fact per condition; a condition stated twice is one fact.
2. NEVER invent a value. Quote the sentence or fragment exactly as printed, in its original language; never paraphrase, translate or shorten the quote. Put the English reading in "value".
3. Skip boilerplate that names no specific time, amount, place or action (general terms, marketing, "subject to conditions" lines). Keep anything with a time, a date, an amount, a place, a name requirement or an action.
4. "at" is the moment the condition refers to, local to the place, as a date or a date and time; "" when the condition has none. A date without a year takes the year from the booking context below; make no other inference.
5. "tz" is the IANA zone only if the document states a zone or the booking context supplies one, and "tzSource" says which; otherwise "" and "none". Never guess a zone.
6. "page" is the page number as printed, 1-based; "" for a single image or when pages are not distinguishable.
7. "kind" is one of the eight kinds; choose the closest. "label" is up to five English words; "value" is one short English phrase.
8. The booking context below (type, title, dates, zones, trip dates) is for disambiguation only; never produce a fact from the context itself.
9. If the document holds no condition, return an empty "facts" array; never pad.
10. Do not explain your reasoning in prose.`;

// ---------------------------------------------------------------------------------------------
// §4.1 as written, kept for the compile probe only
// ---------------------------------------------------------------------------------------------

// FACTS_OUTPUT_SCHEMA plus §4.1's `maxItems: 40`. The API rejected it on Haiku 5.5, Sonnet 5.5 and
// Sonnet 4.6 (W0 compile probe, 2026-10-20); schemaProbe.mjs sends it under `facts-plan-haiku-5-5`
// so the rejection can be re-run against a future API. No read ever sends it.
export const FACTS_OUTPUT_SCHEMA_AS_PLANNED = (() => {
  const copy = structuredClone(FACTS_OUTPUT_SCHEMA);
  copy.properties.facts = { type: 'array', maxItems: 40, items: copy.properties.facts.items };
  return deepFreeze(copy);
})();

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

const orNotGiven = (v) => (v ? v : 'not given');

// The booking-context text block (§4.2): type, title, start, end, origin and destination zones per
// booking the document backs (one artifact can back several bookings, F-37-14), then the trip's
// dates. No "today": nothing in the read depends on it, and a constant block keeps reads of the same
// document comparable across days.
//   context = { bookings: [{ type, title, startDatetime, endDatetime, originTz, destinationTz }],
//               trip: { startDate, endDate } }
export function buildFactsContextText(context) {
  const bookings = context?.bookings ?? [];
  if (!bookings.length) throw new Error('facts context: a document must belong to at least one booking');
  const lines = ['Booking context (for disambiguation only):'];
  bookings.forEach((b, i) => {
    lines.push(
      `Booking ${i + 1}: ${b.type} "${b.title}"; start ${orNotGiven(b.startDatetime)}; end ${orNotGiven(b.endDatetime)}; ` +
      `origin zone ${orNotGiven(b.originTz)}; destination zone ${orNotGiven(b.destinationTz)}.`,
    );
  });
  const trip = context?.trip ?? {};
  lines.push(`Trip dates: ${orNotGiven(trip.startDate)} to ${orNotGiven(trip.endDate)}.`);
  return lines.join('\n');
}

// The document in extraction's transport (F-37-11). `content` is UTF-8 text for kind text and
// base64 for image and pdf.
export function documentBlock(document) {
  if (document.kind === 'text') return { type: 'text', text: document.content };
  if (document.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: document.mediaType, data: document.content } };
  }
  if (document.kind === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.content } };
  }
  throw new Error(`facts request: unknown document kind "${document.kind}"`);
}

// The full request body: the profile's settings with the format beside its effort (D-34-6), the
// system prompt as a plain string (no cache_control: one document per call, §4.2), and one user
// turn of context then document.
export function buildFactsRequest(profile, { context, document }) {
  return {
    ...requestSettings(profile, { format: FACTS_OUTPUT_FORMAT }),
    system: FACTS_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildFactsContextText(context) }, documentBlock(document)] }],
  };
}

// ---------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------

// D-30-3 / D-37-4: classify the stop first, then parse exactly one text block and validate it.
// Nothing is repaired. Returns { outcome, stopReason, category, error, value } where outcome is
// complete | refused | truncated | invalid, and `value` is the validated answer (enum spellings
// normalised by validateAgainstSchema, D-34-7) only when complete. `parsed` is kept on an invalid
// outcome so the record shows what came back.
export function classifyFactsResponse(message) {
  const stop = classifyStop(message);
  const base = { stopReason: stop.stopReason, category: stop.category };
  if (stop.outcome !== 'complete') return { ...base, outcome: stop.outcome, error: null, value: null, parsed: null };

  const textBlocks = (message.content ?? []).filter((b) => b.type === 'text');
  const invalid = (error, parsed = null) => ({ ...base, outcome: 'invalid', error, value: null, parsed });
  if (textBlocks.length !== 1) return invalid(`expected exactly one text block, got ${textBlocks.length}`);

  let parsed;
  try {
    parsed = JSON.parse(textBlocks[0].text);
  } catch (err) {
    return invalid(`not JSON (${err.message})`);
  }
  const checked = validateAgainstSchema(parsed, FACTS_OUTPUT_SCHEMA);
  if (!checked.ok) return invalid(checked.error, parsed);
  // D-37-2: no fact without its quote.
  const emptyQuote = checked.value.facts.findIndex((f) => !normaliseForMatch(f.quote));
  if (emptyQuote !== -1) return invalid(`facts[${emptyQuote}].quote: empty`, parsed);

  return { ...base, outcome: 'complete', error: null, value: checked.value, parsed };
}

// ---------------------------------------------------------------------------------------------
// Quote verification (D-37-2; the harness copy until W1's services/documentText.js)
// ---------------------------------------------------------------------------------------------

// Zero-width characters a text layer or a pasted email can carry inside a word: ZWSP, ZWNJ, ZWJ,
// WORD JOINER, BOM / ZWNBSP.
const ZERO_WIDTH = /[​‌‍⁠﻿]/gu;
const WHITESPACE = /\s/gu;

// NFKC (full-width digits and letters, compatibility forms), then every whitespace character and
// every zero-width character removed, so line breaks, column gaps and ideographic spaces in a text
// layer never decide a match.
export function normaliseForMatch(s) {
  return String(s ?? '').normalize('NFKC').replace(WHITESPACE, '').replace(ZERO_WIDTH, '');
}

// pages: the document's text, one string per page (a text document is one page). Returns
// { found, page } with `page` 1-based: the page holding the quote, or for a quote that runs across a
// page break, the page it starts on. An empty quote is never found.
export function findQuote(pages, quote) {
  const needle = normaliseForMatch(quote);
  if (!needle || !Array.isArray(pages) || !pages.length) return { found: false, page: null };
  const normalised = pages.map(normaliseForMatch);
  const onPage = normalised.findIndex((p) => p.includes(needle));
  if (onPage !== -1) return { found: true, page: onPage + 1 };

  const joined = normalised.join('');
  const at = joined.indexOf(needle);
  if (at === -1) return { found: false, page: null };
  let end = 0;
  for (let i = 0; i < normalised.length; i += 1) {
    end += normalised[i].length;
    if (at < end) return { found: true, page: i + 1 };
  }
  return { found: true, page: normalised.length };
}
