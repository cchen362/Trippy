import { initDb, getDb } from './src/db/database.js';
import { runMigrations } from './src/db/migrations.js';

initDb('./data/trippy.db');
runMigrations();
const db = getDb();

const cacheRows = db.prepare(`
  SELECT query_key, provider, name, lat, lng, coordinate_system, confidence
  FROM place_resolution_cache
  ORDER BY updated_at DESC
  LIMIT 20
`).all();

console.log('Recent place_resolution_cache entries:');
cacheRows.forEach((r) => console.log(
  `  ${r.query_key.padEnd(50)} provider=${r.provider.padEnd(15)} lat=${r.lat} name=${r.name}`
));

// Also test a direct Nominatim call
import { resolvePlace } from './src/services/placeResolver.js';
console.log('\nTesting single Nominatim call for "Luohan Temple"...');
try {
  const result = await resolvePlace({ queryText: 'Luohan Temple', city: null, country: 'CN', allowNetwork: true, preferNominatim: true });
  console.log('Result:', JSON.stringify(result, null, 2));
} catch (e) {
  console.error('Error:', e.message);
}
