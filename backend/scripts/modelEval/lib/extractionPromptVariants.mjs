// Plan 34 W1 (§4.3 / F-34-7) — extraction prompt variants, measured in the harness only.
//
// 'think-first' appends one sentence to the extraction system prompt. It is adopted into
// claude.js only if W1 measures that it removes a critical error or raises critical-field accuracy
// without a max_tokens stop (§5.1), so until then it exists only on the wire of a harness run.
// installExtractionPromptVariant() wraps the SDK's Messages.prototype.create AFTER installRecorder(),
// so the recorder sees — and the run file stores — the patched system prompt. A request whose
// system prompt is not exactly the live EXTRACTION_SYSTEM fails loudly: a silent no-op patch
// would measure the live prompt under a variant's name.

import Anthropic from '@anthropic-ai/sdk';
import { EXTRACTION_SYSTEM } from '../../../src/services/claude.js';

export const EXTRACTION_PROMPT_VARIANTS = Object.freeze({
  'think-first': '\n\nThink the problem through before you answer.',
});

export function applyExtractionPromptVariant(system, variantName) {
  const suffix = EXTRACTION_PROMPT_VARIANTS[variantName];
  if (suffix === undefined) {
    throw new Error(`unknown extraction prompt variant "${variantName}" (expected one of ${Object.keys(EXTRACTION_PROMPT_VARIANTS).join(', ')})`);
  }
  if (system !== EXTRACTION_SYSTEM) {
    throw new Error(`extraction prompt variant "${variantName}": the request's system prompt is not the live EXTRACTION_SYSTEM, so the variant would not measure what it names`);
  }
  return `${system}${suffix}`;
}

let installedVariant = null;

// Process-wide: extraction.mjs makes only extraction calls, and runs one profile per process.
export function installExtractionPromptVariant(variantName) {
  if (installedVariant) throw new Error(`an extraction prompt variant ("${installedVariant}") is already installed in this process`);
  if (!EXTRACTION_PROMPT_VARIANTS[variantName]) throw new Error(`unknown extraction prompt variant "${variantName}"`);
  installedVariant = variantName;
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'variant-probe' }).messages);
  const recordedCreate = proto.create;
  proto.create = function variantCreate(body, options) {
    return recordedCreate.call(this, { ...body, system: applyExtractionPromptVariant(body.system, variantName) }, options);
  };
}
