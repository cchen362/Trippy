// READ-ONLY inventory for owner review before running the destructive
// 024_geo_data_repair migration in production (Plan 9 Wave 5.2/5.3, mirrors
// Plan 8 Wave 6's pre-deploy inventory pattern). Prints computeRepairPlan's
// output human-readably — every planned day stamp, every planned destination
// delete with its child counts, and totals. Never writes anything.
//
// Usage (run from backend/):
//   node scripts/geoRepairInventory.js

import { config } from '../src/config.js';
import { initDb, getDb } from '../src/db/database.js';
import { computeRepairPlan } from '../src/db/migrations/024_geo_data_repair.js';

function countChildren(db, destinationId) {
  const places = db.prepare(
    'SELECT COUNT(*) c FROM discovery_places WHERE destination_id = ?',
  ).get(destinationId).c;
  const daily = db.prepare(
    'SELECT COUNT(*) c FROM discovery_generation_daily WHERE destination_id = ?',
  ).get(destinationId).c;
  return { places, daily };
}

function printDestinationDelete(db, destination, label) {
  const { places, daily } = countChildren(db, destination.id);
  console.log(
    `  [${label}] destination_id=${destination.id} city_key=${destination.city_key} ` +
    `country_code=${JSON.stringify(destination.country_code)} display_name=${destination.display_name} ` +
    `(${places} places, ${daily} daily-generation rows)`,
  );
}

function main() {
  initDb(config.dbPath);
  const db = getDb();

  const plan = computeRepairPlan(db);
  const totalPlanned = plan.dayStamps.length + plan.emptyCountryTwinDeletes.length + plan.reviewedCjkDeletes.length;

  if (totalPlanned === 0) {
    console.log('[geoRepairInventory] nothing to repair — no-op');
    return;
  }

  console.log(`[geoRepairInventory] ${plan.dayStamps.length} day stamp(s) planned:`);
  for (const stamp of plan.dayStamps) {
    console.log(`  trip=${stamp.tripId} day=${stamp.dayId} date=${stamp.date} city="${stamp.city}" -> country=${stamp.country}`);
  }

  console.log(`\n[geoRepairInventory] ${plan.emptyCountryTwinDeletes.length} empty-country twin delete(s) planned:`);
  for (const destination of plan.emptyCountryTwinDeletes) {
    printDestinationDelete(db, destination, 'empty-country twin');
  }

  console.log(`\n[geoRepairInventory] ${plan.reviewedCjkDeletes.length} reviewed CJK duplicate delete(s) planned:`);
  for (const destination of plan.reviewedCjkDeletes) {
    printDestinationDelete(db, destination, 'reviewed CJK duplicate');
  }

  console.log(
    `\n[geoRepairInventory] totals: ${plan.dayStamps.length} day stamp(s), ` +
    `${plan.emptyCountryTwinDeletes.length + plan.reviewedCjkDeletes.length} destination delete(s)`,
  );
}

main();
