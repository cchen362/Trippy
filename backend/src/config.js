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
  // Daily cap on resolver-call lookups triggered by discovery verification (Trust
  // criteria) — guards cost, not a rate limiter (Nominatim's 1 req/s pacing is
  // separate, enforced inside placeResolver.js).
  discoveryResolverDailyBudget: parseInt(process.env.DISCOVERY_RESOLVER_DAILY_BUDGET || '500', 10),
  isProd: process.env.NODE_ENV === 'production',
};
