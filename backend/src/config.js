// Validates all required env vars at startup — fail fast, never silently
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv();
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
  dbPath: process.env.DB_PATH || './data/trippy.db',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  unsplashAccessKey: process.env.UNSPLASH_ACCESS_KEY,
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY,
  maptilerKey: process.env.MAPTILER_API_KEY || '',
  flightDataProvider: process.env.FLIGHT_DATA_PROVIDER || '',
  aerodataboxApiKey: process.env.AERODATABOX_API_KEY || '',
  aerodataboxApiHost: process.env.AERODATABOX_API_HOST || 'aerodatabox.p.rapidapi.com',
  isProd: process.env.NODE_ENV === 'production',
};
