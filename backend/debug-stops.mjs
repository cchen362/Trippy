import { initDb, getDb } from './src/db/database.js';
import { runMigrations } from './src/db/migrations.js';

initDb('./data/trippy.db');
runMigrations();
const db = getDb();

const stops = db.prepare(`
  SELECT s.title, s.coordinate_system, s.location_status, s.coordinate_source, s.lat, s.lng, d.city
  FROM stops s
  JOIN days d ON d.id = s.day_id
  JOIN trips t ON t.id = d.trip_id
  WHERE t.owner_id = 'd9ef494d820630134895c9e3eb7a14b8'
  ORDER BY t.id, s.title
  LIMIT 30
`).all();

stops.forEach((s) => console.log(
  `${s.title.padEnd(35)} sys=${s.coordinate_system.padEnd(8)} status=${s.location_status.padEnd(14)} src=${(s.coordinate_source||'null').padEnd(14)} city=${s.city}`
));

const counts = db.prepare(`
  SELECT coordinate_system, location_status, COUNT(*) as cnt
  FROM stops s
  JOIN days d ON d.id = s.day_id
  JOIN trips t ON t.id = d.trip_id
  WHERE t.owner_id = 'd9ef494d820630134895c9e3eb7a14b8'
  GROUP BY coordinate_system, location_status
`).all();
console.log('\nSummary:');
counts.forEach((c) => console.log(`  ${c.coordinate_system} / ${c.location_status}: ${c.cnt}`));
