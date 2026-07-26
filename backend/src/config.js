// Validates all required env vars at startup — fail fast, never silently
import { config as loadEnv } from 'dotenv';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(__dirname, '..');

// override: true so project .env always wins over stale/empty system env vars
loadEnv({ override: true });
loadEnv({ path: join(__dirname, '../../.env'), override: false });

const required = [];

if (process.env.NODE_ENV !== 'test') {
  required.push(
    'SESSION_SECRET',
    'DB_PATH',
    'ANTHROPIC_API_KEY',
    'UNSPLASH_ACCESS_KEY',
    'GOOGLE_PLACES_API_KEY',
  );
}

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET,
  dbPath: (() => {
    const raw = process.env.DB_PATH || './data/trippy.db';
    return isAbsolute(raw) ? raw : resolve(BACKEND_DIR, raw);
  })(),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  unsplashAccessKey: process.env.UNSPLASH_ACCESS_KEY,
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY,
  maptilerKey: process.env.MAPTILER_API_KEY || '',
  flightDataProvider: process.env.FLIGHT_DATA_PROVIDER || '',
  aerodataboxApiKey: process.env.AERODATABOX_API_KEY || '',
  aerodataboxApiHost: process.env.AERODATABOX_API_HOST || 'aerodatabox.p.rapidapi.com',
  nominatimUserAgent: process.env.NOMINATIM_USER_AGENT || 'Trippy travel planner local development (contact: local@example.invalid)',
  // Plan 7 Wave 2 (Q3 discovery grounded catalogue): rating/rating_count enrichment
  // costs a pricier Google Places field-mask tier, so it stays flag-guarded and off
  // by default (decision 2, Gate C). Applies to discovery verification calls only.
  discoveryRatingEnrichment: process.env.DISCOVERY_RATING_ENRICHMENT === '1',
  // Plan 26 W3.2 (F-26-6): daily cap on discovery-verification RESOLVER REQUESTS —
  // real provider HTTP calls, not lookups. The pre-W3 counter (discoveryResolverDailyBudget,
  // now removed) counted lookups, but one lookup costs 1..N Nominatim requests (one per
  // query variant tried, resolverQueryTexts) plus possibly a Google request — 240
  // generated candidates can consume ~480 lookups but ~700-800 real requests, so the old
  // counter was lying about the thing it exists to bound. 1000 is chosen to preserve
  // today's real observed throughput (~700-800 requests for one full generation) while
  // the number finally means what it says. Verified read-only against the running
  // production container (2026-07-27): neither this env var nor its predecessor is set
  // there, so this rename breaks no deployed configuration.
  discoveryResolverDailyRequestBudget: parseInt(process.env.DISCOVERY_RESOLVER_DAILY_REQUEST_BUDGET || '1000', 10),
  // Plan 26 W2.3 (D-26-4): a cap on GOOGLE PLACES REQUESTS spent escalating past a
  // weak Nominatim hit during discovery verification. Deliberately a separate
  // sub-budget from discoveryResolverDailyRequestBudget above — that one bounds ALL
  // resolver-request spend (Nominatim + Google) across ordinary verification, so it
  // cannot bound escalation spend specifically by itself. Keeping the escalation
  // ceiling on its own counter makes it structural rather than assumed.
  discoveryEscalationDailyBudget: parseInt(process.env.DISCOVERY_ESCALATION_DAILY_BUDGET || '50', 10),
  // Plan 26 W3.3 (F-26-12): a THIRD, independent daily counter bounding
  // RE-VERIFICATION spend — reaching terminal `unverified` rows that ordinary
  // verification never revisits. Separate from discoveryResolverDailyRequestBudget so a
  // re-verification run can never crowd out same-day fresh-generation verification (or
  // vice versa); separate from discoveryEscalationDailyBudget because escalation is a
  // per-lookup sub-decision inside a single verification, while this bounds an entire
  // background repair job.
  discoveryReverifyDailyRequestBudget: parseInt(process.env.DISCOVERY_REVERIFY_DAILY_REQUEST_BUDGET || '150', 10),
  // Plan 26 W3.3: the structural half of "throttled so it can never consume a day's
  // budget in one destination" (plan line 194) — the global counter above is the cost
  // half, this is the per-destination ceiling. Tracked in-memory per destination per UTC
  // day (mirrors the daily counters' own reset semantics), so one destination's backlog
  // of terminal-unverified rows can never exhaust discoveryReverifyDailyRequestBudget by
  // itself and starve every other destination's re-verification for the rest of the day.
  discoveryReverifyPerDestinationDaily: parseInt(process.env.DISCOVERY_REVERIFY_PER_DESTINATION_DAILY || '25', 10),
  isProd: process.env.NODE_ENV === 'production',
};
