// Plan 30 W5 (Q-30-3) — co-pilot request patches, measured in the harness only.
//
// Two remedies for "the traveller sees no explanation above the change preview" are measured here
// without changing production code (claude.js is never changed to measure a variant):
//   * a prompt variant that rewrites the single "explain your reasoning" line of the co-pilot
//     system prompt, and
//   * an `anthropic-beta` header, passed as the stream call's second argument (streamCopilotResponse
//     passes none), for the thinking-display beta.
// installCopilotRequestPatch() wraps the SDK's Messages.prototype.stream AFTER installRecorder(),
// so the recorder sees — and the run file stores — the patched request body. A system prompt that
// does not contain the original line exactly once fails loudly: a silent no-op patch would measure
// the live prompt under a variant's name.

import Anthropic from '@anthropic-ai/sdk';

export const ORIGINAL_LINE = '- First explain your reasoning in prose, then call the tool with the operations. If you are not proposing changes, do not call the tool.';

// Each variant is the replacement for ORIGINAL_LINE; null keeps it.
export const PROMPT_VARIANTS = Object.freeze({
  original: null,
  'reply-text': '- Before you call the tool, write your explanation to the traveller as your reply text: what you are proposing and why. That reply text is what the traveller sees above the change preview; an internal note or a message to yourself is not shown to them. Then call the tool with the operations. If you are not proposing changes, do not call the tool.',
  'reply-text-short': '- Before you call the tool, tell the traveller in one or two sentences of reply text what you are proposing and why; that text is shown directly above the change preview, and an internal note is not. Then call the tool with the operations. If you are not proposing changes, do not call the tool.',
});

// system is the array streamCopilotResponse sends: [{ type: 'text', text, cache_control }].
// Returns a new array; cache_control (and any other block field) is carried over unchanged.
export function applyPromptVariant(system, variantName) {
  if (!Object.hasOwn(PROMPT_VARIANTS, variantName)) {
    throw new Error(`unknown co-pilot prompt variant "${variantName}" (expected one of ${Object.keys(PROMPT_VARIANTS).join(', ')})`);
  }
  if (!Array.isArray(system) || system[0]?.type !== 'text' || typeof system[0].text !== 'string') {
    throw new Error('co-pilot prompt variant: request system is not an array whose first block is a text block');
  }
  const occurrences = system[0].text.split(ORIGINAL_LINE).length - 1;
  if (occurrences !== 1) {
    throw new Error(`co-pilot prompt variant "${variantName}": expected the "explain your reasoning" line exactly once in the system prompt, found ${occurrences}`);
  }
  const replacement = PROMPT_VARIANTS[variantName] ?? ORIGINAL_LINE;
  const [first, ...rest] = system;
  return [{ ...first, text: first.text.replace(ORIGINAL_LINE, () => replacement) }, ...rest];
}

let installed = false;

// Process-wide: copilot.mjs runs one profile per process.
export function installCopilotRequestPatch({ promptVariant, betas } = {}) {
  if (installed) throw new Error('a co-pilot request patch is already installed in this process');
  installed = true;
  if (promptVariant && !Object.hasOwn(PROMPT_VARIANTS, promptVariant)) {
    throw new Error(`unknown co-pilot prompt variant "${promptVariant}"`);
  }
  const patchPrompt = Boolean(promptVariant) && promptVariant !== 'original';
  const patchBetas = Array.isArray(betas) && betas.length > 0;

  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'variant-probe' }).messages);
  const recordedStream = proto.stream;
  proto.stream = function patchedStream(body, options) {
    const patchedBody = patchPrompt ? { ...body, system: applyPromptVariant(body.system, promptVariant) } : body;
    const patchedOptions = patchBetas
      ? { ...options, headers: { ...(options?.headers ?? {}), 'anthropic-beta': betas.join(',') } }
      : options;
    return recordedStream.call(this, patchedBody, patchedOptions);
  };
}
