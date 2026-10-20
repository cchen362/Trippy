// Plan 35 W0 — the emit_category tool and the staged discovery prompt, measured in the harness only.
//
// Shared by stagedEmissionProbe.mjs (does Haiku 5.5 think per category when each category is a tool
// call?) and schemaProbe.mjs (does the strict tool schema compile?). W1 moves the schema constant
// into claude.js; until then this file is the one place it is written, so the two probes cannot
// measure different schemas.
//
// Every property is required and nothing is optional (Plan 34 D-34-5: compile cost doubles with each
// optional property of one object). "Absent" is a nullable type or an empty array, never a missing
// key. The item fields are the live NDJSON contract's, unchanged — `lat`/`lng`/`localName` nullable
// as the prompt already says.

import { DISCOVERY_CATEGORIES, SCENE_TYPES, discoverySystemPrompt } from '../../../src/services/claude.js';
import { applyPromptVariant } from './discoveryPromptVariants.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const EMIT_CATEGORY_INPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['category', 'items'],
  properties: {
    category: { enum: [...DISCOVERY_CATEGORIES], description: 'The category being delivered.' },
    items: {
      type: 'array',
      description: "That category's places, best first.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'description', 'whyItFits', 'estimatedDuration', 'openingHours',
          'lat', 'lng', 'localName', 'aliases', 'photoQuery', 'sceneType',
        ],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          whyItFits: { type: 'string' },
          estimatedDuration: { type: 'string' },
          openingHours: { type: 'string' },
          lat: { type: ['number', 'null'] },
          lng: { type: ['number', 'null'] },
          localName: { type: ['string', 'null'] },
          aliases: { type: 'array', items: { type: 'string' } },
          photoQuery: { type: 'string' },
          sceneType: { enum: [...SCENE_TYPES] },
        },
      },
    },
  },
});

export const EMIT_CATEGORY_TOOL = deepFreeze({
  name: 'emit_category',
  description: 'Deliver one finished category of the catalogue. Call once per category, in the order the system prompt gives.',
  input_schema: EMIT_CATEGORY_INPUT_SCHEMA,
  strict: true,
});

export const STAGING_PARAGRAPH = `You are a discerning travel curator. Deliver the catalogue through the emit_category tool: one call per category, eight calls in total, in this order:
essentials, culture, food, nature, nightlife, hidden_gems, architecture, wellness

Work one category at a time: choose that category's places, call emit_category with them, then move on to the next category. Make exactly one emit_category call per turn. Write no text outside the tool calls. After the wellness call has been received, end your turn without writing anything.`;

// The live discovery prompt with the exact-count volume line (what ships with thinking on, D-34-10)
// and the NDJSON output-format opening replaced by STAGING_PARAGRAPH. The text replaced is read from
// the template: everything before the "Each item:" line. It must be exactly the NDJSON opening, found
// once — a silent no-op would measure the NDJSON prompt under the staged name.
const NDJSON_OPENING_START = 'You are a discerning travel curator. Return ONLY newline-delimited JSON';
const NDJSON_OPENING_END = 'essentials, culture, food, nature, nightlife, hidden_gems, architecture, wellness';
const ITEM_LINE_MARKER = '\n\nEach item: {';

export function stagedDiscoverySystemPrompt(model) {
  const system = applyPromptVariant(discoverySystemPrompt(model), 'exact-count', model);
  const occurrences = system.split(ITEM_LINE_MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`staged discovery prompt: expected the "Each item:" line exactly once, found ${occurrences}`);
  }
  const opening = system.slice(0, system.indexOf(ITEM_LINE_MARKER));
  if (!opening.startsWith(NDJSON_OPENING_START) || !opening.endsWith(NDJSON_OPENING_END)) {
    throw new Error('staged discovery prompt: the text before the "Each item:" line is not the NDJSON output-format opening');
  }
  return STAGING_PARAGRAPH + system.slice(opening.length);
}

const ITEM_KEYS = EMIT_CATEGORY_INPUT_SCHEMA.properties.items.items.required;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A hand-written check of exactly EMIT_CATEGORY_INPUT_SCHEMA. claude.js validateAgainstSchema has no
// `number` type, so it cannot check lat/lng.
export function checkCategoryInput(input) {
  const fail = (error) => ({ ok: false, error });
  if (!isObject(input)) return fail('input: not an object');
  const topKeys = Object.keys(input);
  if (topKeys.length !== 2 || !topKeys.includes('category') || !topKeys.includes('items')) {
    return fail(`input: keys must be exactly category, items (got ${topKeys.join(', ')})`);
  }
  if (!DISCOVERY_CATEGORIES.includes(input.category)) return fail(`category: "${input.category}" is not in the category enum`);
  if (!Array.isArray(input.items)) return fail('items: not an array');

  for (let i = 0; i < input.items.length; i += 1) {
    const item = input.items[i];
    const at = `items[${i}]`;
    if (!isObject(item)) return fail(`${at}: not an object`);
    const keys = Object.keys(item);
    const missing = ITEM_KEYS.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !ITEM_KEYS.includes(k));
    if (missing.length || extra.length) {
      return fail(`${at}: ${[missing.length ? `missing ${missing.join(', ')}` : null, extra.length ? `unexpected ${extra.join(', ')}` : null].filter(Boolean).join('; ')}`);
    }
    for (const key of ['name', 'description', 'whyItFits', 'estimatedDuration', 'openingHours', 'photoQuery']) {
      if (typeof item[key] !== 'string') return fail(`${at}.${key}: not a string`);
    }
    for (const key of ['lat', 'lng']) {
      if (item[key] !== null && !(typeof item[key] === 'number' && Number.isFinite(item[key]))) return fail(`${at}.${key}: not a number or null`);
    }
    if (item.localName !== null && typeof item.localName !== 'string') return fail(`${at}.localName: not a string or null`);
    if (!Array.isArray(item.aliases) || item.aliases.some((a) => typeof a !== 'string')) return fail(`${at}.aliases: not an array of strings`);
    if (!SCENE_TYPES.includes(item.sceneType)) return fail(`${at}.sceneType: "${item.sceneType}" is not in the scene-type enum`);
  }
  return { ok: true };
}
