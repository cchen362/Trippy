// Suite-wide network guard for the unit project (vitest.workspace.js). Unit tests make no
// network calls: every provider Trippy pays for or depends on (Anthropic, Unsplash, Google
// Places, Nominatim, AeroDataBox, FX) is reached through the global `fetch` — the Anthropic
// SDK included, which captures `globalThis.fetch` when its client is constructed — and
// config.js loads the real backend/.env keys even under NODE_ENV=test, so an unmocked call
// would succeed, spend money, and race the test timeout.
//
// Loopback is allowed: the auth and MCP tests drive their own in-process server over
// http://127.0.0.1 / http://localhost. A test that stubs a provider with
// `vi.spyOn(globalThis, 'fetch').mockResolvedValue(...)` replaces this guard for that test and
// is untouched by it; `vi.restoreAllMocks()` puts the guard back.
//
// Throwing alone is not enough: provider services deliberately catch network failures and fall
// back (placeResolver records a Nominatim error and returns 'unresolved'), so a blocked call
// would pass silently. Every blocked URL is therefore recorded and fails the test in afterEach.
//
// The opt-in live smoke (tests/live, LIVE_ANTHROPIC=1) runs in the separate `live` project,
// which does not load this file.
import { afterAll, afterEach } from 'vitest';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const realFetch = globalThis.fetch;
let blockedUrls = [];

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? String(input);
}

function isLoopback(url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

globalThis.fetch = function unitTestNetworkGuard(input, init) {
  const url = requestUrl(input);
  if (isLoopback(url)) return realFetch(input, init);
  blockedUrls.push(url);
  return Promise.reject(new Error(`unit tests make no network calls: ${url}`));
};

function failOnBlockedCalls() {
  if (blockedUrls.length === 0) return;
  const urls = blockedUrls;
  blockedUrls = [];
  throw new Error(
    `unit tests make no network calls — this test tried ${urls.length} external request(s), `
    + 'blocked even where the code under test caught the failure:\n'
    + urls.map((url) => `  ${url}`).join('\n')
    + '\nStub the provider boundary in the test (see tests/locationIntegration.test.js).',
  );
}

afterEach(failOnBlockedCalls);
afterAll(failOnBlockedCalls);
