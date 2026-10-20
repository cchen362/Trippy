// Plan 30 W3 second pass (§4) — discovery prompt variants, measured in the harness only.
//
// A variant replaces the two volume/selection lines of the discovery prompt (claude.js
// DISCOVERY_SELECTION_RULES) and nothing else: every naming, alias, photoQuery, sceneType and
// curation rule stays byte-identical. Variants are defined against Haiku 4.5's original lines (the
// prompt the first pass froze); a line a variant does not name is the ORIGINAL line, whatever the
// profile's model sends live — so variant C means the same text on either model.
// installPromptVariant() wraps the SDK's Messages.prototype.stream AFTER installRecorder(), so the
// recorder sees — and the run file stores — the patched system prompt. A request whose system
// prompt does not contain its model's live lines exactly once fails loudly: a silent no-op patch
// would measure the live prompt under a variant's name.
//
// W3 shipped variant A ('floor-ranked') as Haiku 5.5's live rules, so on a Haiku 5.5 profile that
// variant is now a byte-for-byte no-op.

import Anthropic from '@anthropic-ai/sdk';
import { DISCOVERY_SELECTION_RULES } from '../../../src/services/claude.js';

export const ORIGINAL_LINES = DISCOVERY_SELECTION_RULES['claude-haiku-4-5-20251001'];

// Variant A's quality line, shared by 'floor-ranked' and 'exact-count' so the two cannot drift.
const FLOOR_RANKED_QUALITY = '- Each suggestion must earn its place: put the picks with the most specific "whyItFits" first in each category, and when a candidate would only get a generic "whyItFits", choose a different place instead.';

// Plan 36 W2 (D-36-4): one line per category, shared by the W2 and W3 variants so the two cannot drift.
const DEFINED_CATEGORIES = [
  'What each category holds:',
  "- essentials: the city's must-see places — the unmissable sights and experiences a first-time visitor would regret skipping, with honest notes on crowds and timing.",
  '- culture: museums, galleries, temples, shrines, historic sites, performances and living craft traditions.',
  '- food: restaurants, street-food stalls, food markets, cafés and specific dishes worth seeking out.',
  '- nature: parks, gardens, beaches, rivers, lakes, hills and viewpoints in or within a day trip of the city.',
  '- nightlife: bars, night markets, live music, clubs and experiences that come alive after dark.',
  '- hidden_gems: specific, lesser-known places locals love and most visitors miss.',
  '- architecture: buildings, bridges, streets and quarters worth seeing for their design or history.',
  '- wellness: spas, massage, baths, yoga and quiet places to rest and recharge.',
  'Every item is a place to visit or an experience to have. Practical travel logistics belong in no category: no airports, stations or terminals used for transport, ride-hailing or taxi apps, ATMs or banks, hospitals, clinics or pharmacies, visa or immigration offices, SIM-card counters, or tourist information desks.',
].join('\n');

// Each variant maps an original line to its replacement; a line it does not name is kept.
export const PROMPT_VARIANTS = Object.freeze({
  // The frozen first-pass prompt: both original lines, on any model.
  original: Object.freeze({}),
  // A: an explicit target and floor per category, and the quality rule rephrased so it ranks the
  // picks within that count instead of gating inclusion. Live for Haiku 5.5 since W3.
  'floor-ranked': Object.freeze({
    quality: FLOOR_RANKED_QUALITY,
    volume: '- Return 10–15 items per category. Include at least 8 in every category unless the destination genuinely cannot support that many; never pad with mediocre places, and say nothing about any shortfall.',
  }),
  // B: the same target and floor with the original quality line, to tell which line drives volume.
  floor: Object.freeze({
    volume: '- Return 10–15 items per category. Include at least 8 in every category unless the destination genuinely cannot support that many; never pad with mediocre places, and say nothing about any shortfall.',
  }),
  // C: the original 30 target with only the permission-to-shrink sentence replaced by a narrow
  // exit, to test whether "Fewer sharp picks beats padding" alone is what 5.5 reads as "2-5".
  'aim30-exit': Object.freeze({
    volume: '- Aim for 30 items per category. Stop short of 30 only when the destination has genuinely run out of places that meet these rules.',
  }),
  // Plan 34 W4 (D-34-10): variant A's quality line with an exact-count volume line, measured with
  // adaptive thinking on. Names BOTH keys: an unnamed key would fall back to Haiku 4.5's original line.
  'exact-count': Object.freeze({
    quality: FLOOR_RANKED_QUALITY,
    volume: '- Return exactly 12 items in every category. Return fewer only when the destination genuinely cannot support 12 places that meet these rules; never pad with generic or mediocre places, and say nothing about any shortfall.',
  }),
  // Plan 36 W2 (D-36-4): variant A's lines with "say nothing about any shortfall" dropped, plus a
  // `categories` block (one line per category) inserted after the category-order line. Essentials is
  // the city's must-see places; practical logistics stay out of every category.
  'defined-categories': Object.freeze({
    quality: FLOOR_RANKED_QUALITY,
    volume: '- Return 10–15 items per category. Include at least 8 in every category unless the destination genuinely cannot support that many; never pad with mediocre places.',
    categories: DEFINED_CATEGORIES,
  }),
  // Plan 36 W3 (Q-36-1 option (a)): the W2 definitions with a firm count line in place of the range
  // and floor, to test whether a fixed number holds small towns at full volume without padding.
  'defined-count': Object.freeze({
    quality: FLOOR_RANKED_QUALITY,
    volume: '- Return 10 places in every category. Return fewer only when the destination genuinely cannot support 10 places that meet these rules; never pad with mediocre places.',
    categories: DEFINED_CATEGORIES,
  }),
});

// The category-order line every discovery prompt carries exactly once; a variant's `categories`
// block is inserted right after it (Plan 36 W2).
const CATEGORY_ORDER_LINE = 'essentials, culture, food, nature, nightlife, hidden_gems, architecture, wellness\n';

export function applyPromptVariant(system, variantName, model) {
  const variant = PROMPT_VARIANTS[variantName];
  if (!variant) throw new Error(`unknown discovery prompt variant "${variantName}" (expected one of ${Object.keys(PROMPT_VARIANTS).join(', ')})`);
  if (typeof system !== 'string') throw new Error('discovery prompt variant: request has no string system prompt');
  const live = DISCOVERY_SELECTION_RULES[model];
  if (!live) throw new Error(`discovery prompt variant: no DISCOVERY_SELECTION_RULES for model "${model}"`);
  let patched = system;
  for (const key of Object.keys(ORIGINAL_LINES)) {
    const occurrences = patched.split(live[key]).length - 1;
    if (occurrences !== 1) {
      throw new Error(`discovery prompt variant "${variantName}": expected ${model}'s live ${key} line exactly once in the system prompt, found ${occurrences}`);
    }
    patched = patched.replace(live[key], () => variant[key] ?? ORIGINAL_LINES[key]);
  }
  if (variant.categories) {
    const occurrences = patched.split(CATEGORY_ORDER_LINE).length - 1;
    if (occurrences !== 1) {
      throw new Error(`discovery prompt variant "${variantName}": expected the category-order line exactly once in the system prompt, found ${occurrences}`);
    }
    patched = patched.replace(CATEGORY_ORDER_LINE, () => `${CATEGORY_ORDER_LINE}\n${variant.categories}\n`);
  }
  return patched;
}

let installedVariant = null;

// Process-wide: discovery.mjs makes only discovery calls, and runs one profile per process.
export function installPromptVariant(variantName) {
  if (installedVariant) throw new Error(`a prompt variant ("${installedVariant}") is already installed in this process`);
  if (!PROMPT_VARIANTS[variantName]) throw new Error(`unknown discovery prompt variant "${variantName}"`);
  installedVariant = variantName;
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'variant-probe' }).messages);
  const recordedStream = proto.stream;
  proto.stream = function variantStream(body, options) {
    return recordedStream.call(this, { ...body, system: applyPromptVariant(body.system, variantName, body.model) }, options);
  };
}
