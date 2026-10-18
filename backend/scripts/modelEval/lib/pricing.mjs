// Plan 30 F-30-16 — USD per million tokens, official pricing page, 2026-10-18.
// Re-check against https://platform.claude.com/docs/en/about-claude/pricing before a sweep.
//
// usage.input_tokens is the UNCACHED input only; cache writes and reads are billed separately.
// Haiku 5.5 has two tiers by prompt length (input + cache write + cache read). Only the <=100K
// tier's cache prices are recorded; a longer prompt throws instead of being priced by guess.

const PRICES = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.50, cacheRead: 0.10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01, maxPromptTokens: 100_000 },
};

export function costUsd(model, usage) {
  const price = PRICES[model];
  if (!price) throw new Error(`no recorded price for model "${model}" — add it to lib/pricing.mjs`);
  if (!usage) return 0;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  if (price.maxPromptTokens && input + cacheWrite + cacheRead > price.maxPromptTokens) {
    throw new Error(`${model} prompt of ${input + cacheWrite + cacheRead} tokens is above the priced tier`);
  }

  return (
    input * price.input +
    output * price.output +
    cacheWrite * price.cacheWrite +
    cacheRead * price.cacheRead
  ) / 1_000_000;
}
