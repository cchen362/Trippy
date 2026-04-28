import { initDb } from './src/db/database.js';
import { runMigrations } from './src/db/migrations.js';
import { repairTripStopLocations } from './src/services/stops.js';
import { getDb } from './src/db/database.js';

initDb('./data/trippy.db');
runMigrations();

const db = getDb();

// Reset all previously-curated stops so the repair can overwrite them with Nominatim data.
// These were set from AI-estimated coordinates mislabeled as gcj02 — not accurate.
const resetCurated = db.prepare(`
  UPDATE stops
  SET coordinate_system = 'unknown', location_status = 'estimated', coordinate_source = NULL
  WHERE coordinate_source = 'curated'
    AND location_status != 'user_confirmed'
`);
const curatedChanged = resetCurated.run();
console.log(`Reset ${curatedChanged.changes} curated stop(s) for Nominatim re-repair`);

const trips = [
  ['d9ef494d820630134895c9e3eb7a14b8', 'f8fd07f218c8325b69cb8c117a8ec728', 'Chengdu - Chongqing'],
  ['d9ef494d820630134895c9e3eb7a14b8', '7f8a0688b873073dc6ce23e4dfb17a4b', 'Ipoh - Kuala Lumpur'],
];

for (const [userId, tripId, label] of trips) {
  console.log(`\nRepairing ${label}...`);
  const result = await repairTripStopLocations(userId, tripId);
  console.log(`${label}: repaired ${result.repaired} / ${result.total}`);
}
