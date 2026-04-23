import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function seedIfEmpty(adminUserId) {
  const db = getDb();
  const tripCount = db.prepare('SELECT COUNT(*) as c FROM trips').get();
  if (tripCount.c > 0) return; // already seeded

  const raw = readFileSync(join(__dirname, '../../../data/seed/chengdu-chongqing.json'), 'utf8');
  const { trip, days } = JSON.parse(raw);

  const insertTrip = db.prepare(`
    INSERT INTO trips (title, owner_id, destinations, destination_countries, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
    RETURNING id
  `);

  const { id: tripId } = insertTrip.get(
    trip.title,
    adminUserId,
    JSON.stringify(trip.destinations),
    JSON.stringify(trip.destination_countries),
    trip.start_date,
    trip.end_date,
    trip.travellers,
    JSON.stringify(trip.interest_tags),
    trip.pace
  );

  const insertDay = db.prepare(`
    INSERT INTO days (trip_id, date, city, phase, hotel, theme, color_code) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);

  const insertStop = db.prepare(`
    INSERT INTO stops (day_id, time, title, type, note, lat, lng, estimated_cost, duration, sort_order, is_featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const day of days) {
    const { id: dayId } = insertDay.get(tripId, day.date, day.city, day.phase, day.hotel, day.theme, day.color_code);
    for (const stop of day.stops) {
      insertStop.run(
        dayId, stop.time, stop.title, stop.type, stop.note ?? null,
        stop.lat ?? null, stop.lng ?? null,
        stop.estimated_cost ?? null, stop.duration ?? null,
        stop.sort_order, stop.is_featured ? 1 : 0
      );
    }
  }

  console.log(`Seed: inserted trip "${trip.title}" (${days.length} days)`);
}
