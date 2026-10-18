// Plan 30 W5 (Q-30-3) — co-pilot request patch, measured in the harness only.
//
// The thinking-display remedy ('alt-updates-low') needs an `anthropic-beta` header on the stream
// call: streamCopilotResponse passes no options argument, so the header is added here without
// changing production code (claude.js is never changed to measure a variant). The two co-pilot
// prompt variants measured on 2026-10-19 were rejected (D-30-9) and their code is gone; their run
// files stay under runs/copilot/v-reply-text-*/ as history.
//
// installCopilotRequestPatch() wraps the SDK's Messages.prototype.stream AFTER installRecorder(),
// so the recorder sees the call as the service made it and the beta header only affects the wire.

import Anthropic from '@anthropic-ai/sdk';

let installed = false;

// Process-wide: copilot.mjs runs one profile per process.
export function installCopilotRequestPatch({ betas } = {}) {
  if (installed) throw new Error('a co-pilot request patch is already installed in this process');
  installed = true;
  if (!Array.isArray(betas) || betas.length === 0) return;

  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'patch-probe' }).messages);
  const recordedStream = proto.stream;
  proto.stream = function patchedStream(body, options) {
    const patchedOptions = { ...options, headers: { ...(options?.headers ?? {}), 'anthropic-beta': betas.join(',') } };
    return recordedStream.call(this, body, patchedOptions);
  };
}
