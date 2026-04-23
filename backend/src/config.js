// Validates all required env vars at startup — fail fast, never silently
const required = [
  'SESSION_SECRET',
  'DB_PATH',
  'ANTHROPIC_API_KEY',
  'UNSPLASH_ACCESS_KEY',
  'GOOGLE_PLACES_API_KEY',
];

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
  isProd: process.env.NODE_ENV === 'production',
};
