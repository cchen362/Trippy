// Plan 30 W3 second pass (§4) — discovery prompt variants, measured in the harness only.
//
// A variant replaces the two volume/selection lines of DISCOVER_SYSTEM in src/services/claude.js
// and nothing else: every naming, alias, photoQuery, sceneType and curation rule stays
// byte-identical. installPromptVariant() wraps the SDK's Messages.prototype.stream AFTER
// installRecorder(), so the recorder sees — and the run file stores — the patched system prompt.
// A request whose system prompt does not contain each original line exactly once fails loudly:
// a silent no-op patch would measure the frozen prompt under a variant's name.

import Anthropic from '@anthropic-ai/sdk';

// The two lines as they stand in DISCOVER_SYSTEM (claude.js), verbatim.
export const ORIGINAL_LINES = Object.freeze({
  quality: '- Each suggestion must earn its place. If you cannot write a specific, non-generic "whyItFits", do not include it.',
  volume: '- Aim for 30 items per category. Fewer sharp picks beats padding with mediocre ones — do not force 30 if the city cannot support it.',
});

// Each variant maps an original line to its replacement; a line it does not name is kept.
export const PROMPT_VARIANTS = Object.freeze({
  // A: an explicit target and floor per category, and the quality rule rephrased so it ranks the
  // picks within that count instead of gating inclusion.
  'floor-ranked': Object.freeze({
    quality: '- Each suggestion must earn its place: put the picks with the most specific "whyItFits" first in each category, and when a candidate would only get a generic "whyItFits", choose a different place instead.',
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
});

export function applyPromptVariant(system, variantName) {
  const variant = PROMPT_VARIANTS[variantName];
  if (!variant) throw new Error(`unknown discovery prompt variant "${variantName}" (expected one of ${Object.keys(PROMPT_VARIANTS).join(', ')})`);
  if (typeof system !== 'string') throw new Error('discovery prompt variant: request has no string system prompt');
  let patched = system;
  for (const [key, replacement] of Object.entries(variant)) {
    const original = ORIGINAL_LINES[key];
    const occurrences = patched.split(original).length - 1;
    if (occurrences !== 1) {
      throw new Error(`discovery prompt variant "${variantName}": expected the original ${key} line exactly once in the system prompt, found ${occurrences} — DISCOVER_SYSTEM changed; update ORIGINAL_LINES`);
    }
    patched = patched.replace(original, () => replacement);
  }
  return patched;
}

let installedVariant = null;

// Process-wide: discovery.mjs makes only discovery calls, and runs one profile per process.
export function installPromptVariant(variantName) {
  if (installedVariant) throw new Error(`a prompt variant ("${installedVariant}") is already installed in this process`);
  applyPromptVariant(`${ORIGINAL_LINES.quality}\n${ORIGINAL_LINES.volume}`, variantName); // validates the name
  installedVariant = variantName;
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'variant-probe' }).messages);
  const recordedStream = proto.stream;
  proto.stream = function variantStream(body, options) {
    return recordedStream.call(this, { ...body, system: applyPromptVariant(body.system, variantName) }, options);
  };
}
