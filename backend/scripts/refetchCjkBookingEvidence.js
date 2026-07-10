// One-off: rewrite CJK structured evidence on hotel bookings to English (Plan 9
// Wave 5.3). lookupHotelDetails now sends languageCode=en on every call (Plan 9
// §0 fact 1's fix — see src/services/lookups.js), but bookings created BEFORE
// that fix still carry whatever language Google's per-place default returned
// (production: the Park Hyatt Hangzhou booking's locality/sublocality/adminAreas
// are CJK). This script re-fetches those bookings' place details in English and
// merges only the language-sensitive structured fields back in — never touching
// placeId, name, address, lat/lng, tz, or any other stored field.
//
// Usage (run from backend/):
//   node scripts/refetchCjkBookingEvidence.js          (dry-run — prints only)
//   node scripts/refetchCjkBookingEvidence.js --apply   (re-fetches and writes)
//
// GOOGLE_PLACES_API_KEY and DB_PATH come from the same .env the app uses
// (see src/config.js) — no separate configuration needed.

import { pathToFileURL } from 'url';
import { config } from '../src/config.js';
import { initDb, getDb } from '../src/db/database.js';
import { lookupHotelDetails } from '../src/services/lookups.js';

const HOTEL_BOOKING_TYPE = 'hotel';
const REFETCHED_FIELDS = ['countryCode', 'locality', 'sublocality', 'adminAreas', 'city'];

// True when any of detailsJson.city/locality/sublocality, or any string value
// inside detailsJson.adminAreas, contains a Han-script character. countryCode
// is deliberately excluded — it's always a Latin ISO alpha-2 code (e.g. 'CN'),
// never itself evidence of a language problem. Null-safe throughout.
export function hasCjkEvidence(detailsJson) {
  const hanPattern = /\p{Script=Han}/u;
  const details = detailsJson || {};

  for (const field of ['city', 'locality', 'sublocality']) {
    const value = details[field];
    if (typeof value === 'string' && hanPattern.test(value)) return true;
  }

  const adminAreas = details.adminAreas;
  if (adminAreas && typeof adminAreas === 'object') {
    for (const value of Object.values(adminAreas)) {
      if (typeof value === 'string' && hanPattern.test(value)) return true;
    }
  }

  return false;
}

// Returns the names of the offending fields (for reporting only) — same scan
// as hasCjkEvidence, but collecting instead of short-circuiting.
function collectCjkFields(detailsJson) {
  const hanPattern = /\p{Script=Han}/u;
  const details = detailsJson || {};
  const fields = [];

  for (const field of ['city', 'locality', 'sublocality']) {
    const value = details[field];
    if (typeof value === 'string' && hanPattern.test(value)) fields.push(field);
  }

  const adminAreas = details.adminAreas;
  if (adminAreas && typeof adminAreas === 'object') {
    for (const [key, value] of Object.entries(adminAreas)) {
      if (typeof value === 'string' && hanPattern.test(value)) fields.push(`adminAreas.${key}`);
    }
  }

  return fields;
}

// Selects every hotel booking whose details_json parses, has a non-empty
// placeId, and carries CJK evidence per hasCjkEvidence. Bookings with
// unparseable details_json are warned about and skipped (never thrown).
export function selectCjkHotelBookings(db) {
  const rows = db.prepare(
    'SELECT * FROM bookings WHERE type = ?',
  ).all(HOTEL_BOOKING_TYPE);

  const selected = [];

  for (const booking of rows) {
    let detailsJson;
    try {
      detailsJson = JSON.parse(booking.details_json || '{}');
    } catch (err) {
      console.warn(
        '[refetchCjkBookingEvidence] booking=%s: unparseable details_json, skipping (%s)',
        booking.id, err.message,
      );
      continue;
    }

    if (!detailsJson.placeId) continue;
    if (!hasCjkEvidence(detailsJson)) continue;

    selected.push({ booking, detailsJson, cjkFields: collectCjkFields(detailsJson) });
  }

  return selected;
}

// Returns a NEW object: existingDetails with ONLY the five language-sensitive
// fields replaced from fresh. Everything else (placeId, name, address, lat,
// lng, tz, and any unknown keys) is carried over byte-identical. Neither
// input is mutated.
export function mergeRefetchedFields(existingDetails, fresh) {
  const merged = { ...(existingDetails || {}) };
  for (const field of REFETCHED_FIELDS) {
    merged[field] = fresh[field];
  }
  return merged;
}

async function runDryRun(db) {
  const selected = selectCjkHotelBookings(db);

  if (selected.length === 0) {
    console.log('[refetchCjkBookingEvidence] no CJK-evidence hotel bookings found — nothing to do');
    return;
  }

  console.log(`[refetchCjkBookingEvidence] DRY RUN — ${selected.length} booking(s) would be re-fetched:`);
  for (const { booking, detailsJson, cjkFields } of selected) {
    console.log(`\n  booking=${booking.id} trip=${booking.trip_id} title="${booking.title}"`);
    console.log(`    offending fields: ${cjkFields.join(', ')}`);
    for (const field of cjkFields) {
      const [base, sub] = field.split('.');
      const value = sub ? detailsJson[base]?.[sub] : detailsJson[base];
      console.log(`      ${field} = ${JSON.stringify(value)}`);
    }
  }
  console.log('\n[refetchCjkBookingEvidence] no network calls made, no writes made. Re-run with --apply to fetch and update.');
}

async function runApply(db) {
  const selected = selectCjkHotelBookings(db);

  if (selected.length === 0) {
    console.log('[refetchCjkBookingEvidence] no CJK-evidence hotel bookings found — nothing to do');
    return;
  }

  const updateStmt = db.prepare('UPDATE bookings SET details_json = ? WHERE id = ?');

  for (const { booking, detailsJson } of selected) {
    console.log(`\n[refetchCjkBookingEvidence] booking=${booking.id} trip=${booking.trip_id} title="${booking.title}"`);
    let fresh;
    try {
      fresh = await lookupHotelDetails(detailsJson.placeId);
    } catch (err) {
      console.error(
        '[refetchCjkBookingEvidence] booking=%s: lookupHotelDetails failed, skipping (%s)',
        booking.id, err.message,
      );
      continue;
    }

    const merged = mergeRefetchedFields(detailsJson, fresh);

    for (const field of REFETCHED_FIELDS) {
      console.log(
        `    ${field}: ${JSON.stringify(detailsJson[field] ?? null)} -> ${JSON.stringify(merged[field] ?? null)}`,
      );
    }

    updateStmt.run(JSON.stringify(merged), booking.id);
    console.log(`    updated booking=${booking.id}`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');

  initDb(config.dbPath);
  const db = getDb();

  if (apply) {
    await runApply(db);
  } else {
    await runDryRun(db);
  }
}

// Windows-safe "am I the entry point" check — import.meta.url includes a
// file:// scheme and drive-letter casing that differs from process.argv[1]'s
// raw path, so compare through pathToFileURL rather than a direct string match.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error('[refetchCjkBookingEvidence] fatal error:', err);
    process.exit(1);
  });
}
