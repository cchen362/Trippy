// Two projects, so the network guard is structural rather than a per-file habit:
// - unit: everything `npm test` runs. tests/setup/noNetwork.js blocks every non-loopback fetch.
//   tests/setup/noDiscoveryPrewarm.js stubs the trip-scope pre-warm that createTrip fires.
// - live: the opt-in paid-provider smoke (LIVE_ANTHROPIC=1, about $0.02 a run). It must reach
//   the real API, so it is the one project that does not load the guard.
//   Run it alone with: npx vitest run tests/live
export default [
  {
    test: {
      name: 'unit',
      include: ['tests/**/*.test.js'],
      exclude: ['tests/live/**', '**/node_modules/**'],
      setupFiles: ['./tests/setup/noNetwork.js', './tests/setup/noDiscoveryPrewarm.js'],
    },
  },
  {
    test: {
      name: 'live',
      include: ['tests/live/**/*.test.js'],
    },
  },
];
