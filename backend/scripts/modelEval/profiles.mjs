// Plan 30 §4 — the candidate profiles each workload is evaluated under, by name.
//
// A profile is what the service functions in src/services/claude.js accept as their optional
// `profile` argument: { model, maxTokens, thinking?, effort? }. `thinking` is sent verbatim as the
// request's `thinking` field; `effort` becomes `output_config.effort`. Harness-only keys (`subset`,
// `promptVariant`, `betas`) are stripped by toServiceProfile() before a profile reaches a service.
//
// "control" is today's production configuration. assertControlIsLive() refuses to run if it ever
// drifts from profileFor(workload) in claude.js (D-30-1: the model-keyed MODEL_PROFILES map), so a
// control run always measures what production sends.

import { profileFor } from '../../src/services/claude.js';

const HAIKU_45 = 'claude-haiku-4-5-20251001';
const HAIKU_55 = 'claude-haiku-5-5';
const SONNET_46 = 'claude-sonnet-4-6';
const SONNET_55 = 'claude-sonnet-5-5';

export const PROFILES = {
  descriptor: {
    // W2 flipped PHOTO_DESCRIPTOR_MODEL, so control is now Haiku 5.5 at effort low (identical to the
    // winning candidate, which is why there is no separate primary). 'baseline-45' is the W0
    // control under its old name: runnable for a re-measure, never asserted against the live profile.
    control: { model: HAIKU_55, maxTokens: 1024, effort: 'low' },
    'baseline-45': { model: HAIKU_45, maxTokens: 256 },
    'alt-disabled-low': { model: HAIKU_55, maxTokens: 1024, effort: 'low', thinking: { type: 'disabled' } },
    // §4: effort `medium` is measured on a 15-item subset only.
    'alt-medium': { model: HAIKU_55, maxTokens: 1024, effort: 'medium', subset: 15 },
    // Plan 34 W3 (§4.2, §5.1): the live settings with a third field, `broadQuery`, added on the wire
    // (lib/descriptorContractVariants.mjs; claude.js is unchanged). Harness-only: it feeds
    // photoQueryReplay.mjs and is adopted into claude.js only if the replay says it beats D-31-1.
    'w3-broad': { model: HAIKU_55, maxTokens: 1024, effort: 'low', promptVariant: 'broad-query' },
  },
  discovery: {
    // W3 flipped DISCOVERY_MODEL: control is now Haiku 5.5 with thinking disabled at effort low and
    // the model-keyed prompt rules (claude.js DISCOVERY_SELECTION_RULES) — the measured
    // 'v-floor-ranked-disabled-low' with its measured allowance. 'baseline-45' is the W0 control
    // under its old name, runnable for a re-measure, never asserted against the live profile. The
    // run files under runs/discovery/control/ dated 2026-10-18T12-* are that W0 Haiku 4.5 control.
    control: { model: HAIKU_55, maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' },
    'baseline-45': { model: HAIKU_45, maxTokens: 64000 },
    // The W3 first-pass candidates measured the frozen prompt; promptVariant 'original' keeps them
    // on it now that Haiku 5.5's live rules are variant A.
    primary: { model: HAIKU_55, maxTokens: 96000, effort: 'low', promptVariant: 'original' },
    'alt-medium': { model: HAIKU_55, maxTokens: 96000, effort: 'medium', promptVariant: 'original' },
    'alt-disabled-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', thinking: { type: 'disabled' }, promptVariant: 'original' },
    // W3 second pass (§4): the frozen prompt failed the gate on volume, so these measure the
    // volume/selection wording variants in lib/discoveryPromptVariants.mjs. `promptVariant` is
    // harness-only; discovery.mjs patches the system prompt on the wire, claude.js is unchanged.
    'v-floor-ranked-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', promptVariant: 'floor-ranked' },
    'v-floor-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', promptVariant: 'floor' },
    'v-aim30-exit-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', promptVariant: 'aim30-exit' },
    'v-floor-ranked-disabled-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', thinking: { type: 'disabled' }, promptVariant: 'floor-ranked' },
    'v-floor-low-disabled-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', thinking: { type: 'disabled' }, promptVariant: 'floor' },
    'v-aim30-exit-disabled-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', thinking: { type: 'disabled' }, promptVariant: 'aim30-exit' },
    // Plan 34 W4 (D-34-10): adaptive thinking (no `thinking` field) at effort low with the exact-count
    // line; 48,000 is ~2x the Plan 30 W3 thinking-on max output (25,002), per D-30-6.
    'v-exact12-adaptive-low': { model: HAIKU_55, maxTokens: 48000, effort: 'low', promptVariant: 'exact-count' },
    // The shared-prompt question: the same variants on the control model (Haiku 4.5, 64,000).
    '45-floor-ranked': { model: HAIKU_45, maxTokens: 64000, promptVariant: 'floor-ranked' },
    '45-floor': { model: HAIKU_45, maxTokens: 64000, promptVariant: 'floor' },
    '45-aim30-exit': { model: HAIKU_45, maxTokens: 64000, promptVariant: 'aim30-exit' },
  },
  extraction: {
    // W4 flipped EXTRACTION_MODEL: control is now Sonnet 5.5 at effort medium (identical to the
    // measured primary). 'baseline-46' is the W0/W4 Sonnet 4.6 control under its new name — the run
    // files under runs/extraction/baseline-46/ — runnable for a re-measure, never asserted live.
    control: { model: SONNET_55, maxTokens: 16000, effort: 'medium' },
    'baseline-46': { model: SONNET_46, maxTokens: 8192 },
    primary: { model: SONNET_55, maxTokens: 16000, effort: 'medium' },
    'alt-low': { model: SONNET_55, maxTokens: 16000, effort: 'low' },
    // §5.2: effort `high` only on the fixtures tagged "hard".
    'alt-high': { model: SONNET_55, maxTokens: 16000, effort: 'high', subset: 'hard' },
    // W4: a deliberately tiny allowance, run with --only on one long fixture, to produce the D-30-3
    // cut-off error on Sonnet 5.5 in the harness (the plan forbids lowering it in code).
    'forced-cutoff': { model: SONNET_55, maxTokens: 300, effort: 'medium' },
    // Plan 34 W1 (§5.1, Q-34-3): measured under the schema-constrained contract, full corpus (no
    // subset). 'contract-think' sends the live settings with the §4.3 'think-first' sentence added
    // on the wire (lib/extractionPromptVariants.mjs; claude.js is unchanged) and is adopted only if
    // it removes a critical error or raises critical-field accuracy without a max_tokens stop.
    // 'contract-high' is the same contract at effort high, the Q-34-3 remedy if medium runs away.
    'contract-think': { model: SONNET_55, maxTokens: 16000, effort: 'medium', promptVariant: 'think-first' },
    'contract-high': { model: SONNET_55, maxTokens: 16000, effort: 'high' },
  },
  copilot: {
    // W5 flipped COPILOT_MODEL: control is now Sonnet 5.5 at effort low under the D-30-9
    // explain-after-proposal protocol (identical to the measured primary). 'baseline-46' is the
    // Sonnet 4.6 control under its new name, runnable for a re-measure, never asserted live. Its
    // run files are under runs/copilot/control/: the W0 and old-protocol runs are dated
    // 2026-10-18T12-*, the D-30-9-protocol run 2026-10-18T17-37-* (recorded 2026-10-19).
    control: { model: SONNET_55, maxTokens: 16000, effort: 'low' },
    'baseline-46': { model: SONNET_46, maxTokens: 8192 },
    primary: { model: SONNET_55, maxTokens: 16000, effort: 'low' },
    'alt-medium': { model: SONNET_55, maxTokens: 16000, effort: 'medium' },
    // Thinking-off control for Sonnet 5.5 (F-30-4): between_tools at effort <= high.
    'alt-between-tools': { model: SONNET_55, maxTokens: 16000, effort: 'medium', thinking: { type: 'between_tools' } },
    // Plan 30 W5 (Q-30-3): remedies for the missing explanation above the change preview, measured
    // at effort low. `betas` is harness-only: copilot.mjs applies it on the wire
    // (lib/copilotRequestPatch.mjs); claude.js is unchanged.
    // Show the model's progress updates: thinking display 'updates' behind its beta header.
    // Historical and re-runnable.
    'alt-updates-low': { model: SONNET_55, maxTokens: 16000, effort: 'low', thinking: { type: 'adaptive', display: 'updates' }, betas: ['thinking-display-updates-2026-08-18'] },
    // Two prompt variants that rewrote the one "explain your reasoning" line were measured on
    // 2026-10-19 (no effect: 5/10 and 4/10 explanations) and rejected by the owner in favour of
    // the acknowledgement protocol (D-30-9). Their profiles and code are removed; the run files stay
    // under runs/copilot/v-reply-text-low/ and runs/copilot/v-reply-text-short-low/ as history.
  },
};

export const WORKLOADS = Object.keys(PROFILES);

export function getProfile(workload, name) {
  const byName = PROFILES[workload];
  if (!byName) throw new Error(`unknown workload "${workload}" (expected one of ${WORKLOADS.join(', ')})`);
  const profile = byName[name];
  if (!profile) throw new Error(`unknown ${workload} profile "${name}" (expected one of ${Object.keys(byName).join(', ')})`);
  return profile;
}

// The object a service function receives: no harness-only keys (`subset`, `promptVariant`, `betas`).
export function toServiceProfile(profile) {
  const { subset, promptVariant, betas, ...serviceProfile } = profile;
  return serviceProfile;
}

export function assertControlIsLive(workload) {
  const control = toServiceProfile(PROFILES[workload].control);
  const live = profileFor(workload);
  if (JSON.stringify(control) !== JSON.stringify(live)) {
    throw new Error(
      `${workload} control profile ${JSON.stringify(control)} no longer matches the live profile ` +
      `${JSON.stringify(live)} in src/services/claude.js — update profiles.mjs before measuring.`,
    );
  }
}
