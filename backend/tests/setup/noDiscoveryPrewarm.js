// Suite-wide stub for the trip-scope pre-warm (Plan 35 W4, D-35-3), loaded beside
// noNetwork.js for the unit project. createTrip and updateTrip's chip save now start a
// background Discovery generation for every stored scope with a country code. Most test files
// create trips with country-coded destinations to test something else entirely, so without
// this each of them would fire detached generations that run past the test that started them,
// write catalogue rows another test then reads, and, with a real backend/.env key loaded, send
// a model request the network guard records and fails.
//
// Only prewarmTripScopes is stubbed. kickBackgroundGeneration, which the co-pilot's catalogue
// search also uses, stays real. A test of the pre-warm itself opts back in with
// `vi.unmock('../src/services/discoveryPrewarm.js')` (tests/discoveryPrewarm.test.js).
import { vi } from 'vitest';

vi.mock('../../src/services/discoveryPrewarm.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, prewarmTripScopes: vi.fn(() => []) };
});
