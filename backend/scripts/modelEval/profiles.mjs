// Plan 30 §4 — the candidate profiles each workload is evaluated under, by name.
//
// A profile is what the service functions in src/services/claude.js accept as their optional
// `profile` argument: { model, maxTokens, thinking?, effort? }. `thinking` is sent verbatim as the
// request's `thinking` field; `effort` becomes `output_config.effort`. Harness-only keys (`subset`)
// are stripped by toServiceProfile() before a profile reaches a service.
//
// "control" is today's production configuration. assertControlIsLive() refuses to run if it ever
// drifts from LIVE_PROFILES in claude.js, so a control run always measures what production sends.

import { LIVE_PROFILES } from '../../src/services/claude.js';

const HAIKU_45 = 'claude-haiku-4-5-20251001';
const HAIKU_55 = 'claude-haiku-5-5';
const SONNET_46 = 'claude-sonnet-4-6';
const SONNET_55 = 'claude-sonnet-5-5';

export const PROFILES = {
  descriptor: {
    control: { model: HAIKU_45, maxTokens: 256 },
    primary: { model: HAIKU_55, maxTokens: 1024, effort: 'low' },
    'alt-disabled-low': { model: HAIKU_55, maxTokens: 1024, effort: 'low', thinking: { type: 'disabled' } },
    // §4: effort `medium` is measured on a 15-item subset only.
    'alt-medium': { model: HAIKU_55, maxTokens: 1024, effort: 'medium', subset: 15 },
  },
  discovery: {
    control: { model: HAIKU_45, maxTokens: 64000 },
    primary: { model: HAIKU_55, maxTokens: 96000, effort: 'low' },
    'alt-medium': { model: HAIKU_55, maxTokens: 96000, effort: 'medium' },
    'alt-disabled-low': { model: HAIKU_55, maxTokens: 96000, effort: 'low', thinking: { type: 'disabled' } },
  },
  extraction: {
    control: { model: SONNET_46, maxTokens: 8192 },
    primary: { model: SONNET_55, maxTokens: 16000, effort: 'medium' },
    'alt-low': { model: SONNET_55, maxTokens: 16000, effort: 'low' },
    // §5.2: effort `high` only on the fixtures tagged "hard".
    'alt-high': { model: SONNET_55, maxTokens: 16000, effort: 'high', subset: 'hard' },
  },
  copilot: {
    control: { model: SONNET_46, maxTokens: 8192 },
    primary: { model: SONNET_55, maxTokens: 16000, effort: 'low' },
    'alt-medium': { model: SONNET_55, maxTokens: 16000, effort: 'medium' },
    // Thinking-off control for Sonnet 5.5 (F-30-4): between_tools at effort <= high.
    'alt-between-tools': { model: SONNET_55, maxTokens: 16000, effort: 'medium', thinking: { type: 'between_tools' } },
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

// The object a service function receives: no harness-only keys.
export function toServiceProfile(profile) {
  const { subset, ...serviceProfile } = profile;
  return serviceProfile;
}

export function assertControlIsLive(workload) {
  const control = toServiceProfile(PROFILES[workload].control);
  const live = LIVE_PROFILES[workload];
  if (JSON.stringify(control) !== JSON.stringify(live)) {
    throw new Error(
      `${workload} control profile ${JSON.stringify(control)} no longer matches the live profile ` +
      `${JSON.stringify(live)} in src/services/claude.js — update profiles.mjs before measuring.`,
    );
  }
}
