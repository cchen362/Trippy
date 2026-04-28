import { getDb } from '../db/database.js';
import { pickPhoto } from './unsplash.js';
import { assertDayAccess, assertStopAccess } from './trips.js';

function formatStop(row) {
  return {
    id: row.id,
    dayId: row.day_id,
    bookingId: row.booking_id,
    time: row.time,
    title: row.title,
    type: row.type,
    note: row.note,
    lat: row.lat,
    lng: row.lng,
    locationQuery: row.location_query,
    resolvedName: row.resolved_name,
    resolvedAddress: row.resolved_address,
    coordinateSystem: row.coordinate_system,
    coordinateSource: row.coordinate_source,
    locationStatus: row.location_status,
    locationConfidence: row.location_confidence,
    providerId: row.provider_id,
    unsplashPhotoUrl: row.unsplash_photo_url,
    estimatedCost: row.estimated_cost,
    bookingRequired: Boolean(row.booking_required),
    bestTime: row.best_time,
    duration: row.duration,
    sortOrder: row.sort_order,
    isFeatured: Boolean(row.is_featured),
    createdAt: row.created_at,
  };
}

function isPhotoEligible(type) {
  return type !== 'transit';
}

function cleanTitle(title) {
  return title
    .replace(/\([^)]*\)/g, '')   // strip (parentheticals)
    .replace(/\s+at\s+.*/i, '')  // strip "at Venue Name"
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cityInTitle(title, city) {
  return Boolean(city && title.toLowerCase().includes(city.toLowerCase()));
}

function buildPhotoQuery(title, type, city) {
  const clean = cleanTitle(title);
  const hasCity = cityInTitle(title, city);

  if (type === 'hotel') {
    return hasCity ? `${clean} hotel` : `${clean} ${city} hotel`.trim();
  }
  if (type === 'food') {
    // Avoid city name — city-specific fallback images are often off-topic (e.g. panda for Chengdu)
    return `${clean} food`;
  }
  return hasCity ? clean : `${clean} ${city || ''}`.trim();
}

function buildFallbackQuery(type, city, title) {
  if (type === 'hotel') return city ? `${city} hotel interior` : 'hotel lobby';
  if (type === 'food') return city ? `${city} food restaurant` : 'restaurant food';
  return city || title;
}

function titleHash(title) {
  let h = 5381;
  for (const ch of title) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function getDayIndex(tripId, dayDate) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM days
    WHERE trip_id = ? AND date < ?
  `).get(tripId, dayDate);
  return row?.count || 0;
}

async function resolvePhotoUrl({ title, type, city, dayIndex, existingUrl }) {
  if (existingUrl !== undefined) return existingUrl;
  if (!isPhotoEligible(type)) return null;

  try {
    const photo = await pickPhoto({
      query: buildPhotoQuery(title, type, city),
      fallbackQuery: buildFallbackQuery(type, city, title),
      dayIndex,
      stopSeed: titleHash(title),
    });
    return photo?.url || null;
  } catch {
    return null;
  }
}

function nextSortOrder(dayId) {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM stops WHERE day_id = ?').get(dayId);
  return row.nextOrder;
}

export async function createStop(userId, dayId, input) {
  const db = getDb();
  const day = assertDayAccess(userId, dayId);
  const title = input.title?.trim();

  if (!title) {
    throw Object.assign(new Error('Stop title is required'), { status: 400 });
  }

  const type = input.type || 'explore';
  const dayIndex = getDayIndex(day.trip_id, day.date);
  const unsplashPhotoUrl = await resolvePhotoUrl({
    title,
    type,
    city: day.city,
    dayIndex,
    existingUrl: input.unsplashPhotoUrl,
  });

  const row = db.prepare(`
    INSERT INTO stops (
      day_id, booking_id, time, title, type, note, lat, lng, unsplash_photo_url,
      estimated_cost, booking_required, best_time, duration, sort_order, is_featured
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    dayId,
    input.bookingId || null,
    input.time || null,
    title,
    type,
    input.note || null,
    input.lat ?? null,
    input.lng ?? null,
    unsplashPhotoUrl,
    input.estimatedCost || null,
    input.bookingRequired ? 1 : 0,
    input.bestTime || null,
    input.duration || null,
    input.sortOrder ?? nextSortOrder(dayId),
    input.isFeatured ? 1 : 0,
  );

  return formatStop(row);
}

export async function updateStop(userId, stopId, input) {
  const db = getDb();
  const existing = assertStopAccess(userId, stopId);

  const isMoving = input.dayId && input.dayId !== existing.day_id;
  const targetDayId = isMoving ? input.dayId : existing.day_id;
  const day = assertDayAccess(userId, targetDayId);

  const title = (input.title ?? existing.title)?.trim();
  const type = input.type ?? existing.type;
  const shouldRefreshPhoto = isMoving || input.title !== undefined || input.type !== undefined || input.unsplashPhotoUrl !== undefined;
  const dayIndex = getDayIndex(day.trip_id, day.date);
  const unsplashPhotoUrl = shouldRefreshPhoto
    ? await resolvePhotoUrl({
      title,
      type,
      city: day.city,
      dayIndex,
      existingUrl: input.unsplashPhotoUrl,
    })
    : existing.unsplash_photo_url;

  const sortOrder = isMoving ? nextSortOrder(targetDayId) : (input.sortOrder ?? existing.sort_order);

  const row = db.prepare(`
    UPDATE stops
    SET
      day_id = ?,
      time = ?,
      title = ?,
      type = ?,
      note = ?,
      lat = ?,
      lng = ?,
      unsplash_photo_url = ?,
      estimated_cost = ?,
      booking_required = ?,
      best_time = ?,
      duration = ?,
      sort_order = ?,
      is_featured = ?
    WHERE id = ?
    RETURNING *
  `).get(
    targetDayId,
    input.time ?? existing.time,
    title,
    type,
    input.note ?? existing.note,
    input.lat ?? existing.lat,
    input.lng ?? existing.lng,
    unsplashPhotoUrl,
    input.estimatedCost ?? existing.estimated_cost,
    input.bookingRequired !== undefined ? (input.bookingRequired ? 1 : 0) : existing.booking_required,
    input.bestTime ?? existing.best_time,
    input.duration ?? existing.duration,
    sortOrder,
    input.isFeatured !== undefined ? (input.isFeatured ? 1 : 0) : existing.is_featured,
    stopId,
  );

  return formatStop(row);
}

export function deleteStop(userId, stopId) {
  const db = getDb();
  assertStopAccess(userId, stopId);
  db.prepare('DELETE FROM stops WHERE id = ?').run(stopId);
  return { ok: true };
}

export function reorderStops(userId, dayId, orderedStopIds) {
  const db = getDb();
  assertDayAccess(userId, dayId);

  const existingIds = db.prepare('SELECT id FROM stops WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC').all(dayId).map((row) => row.id);
  if (existingIds.length !== orderedStopIds.length || existingIds.some((id) => !orderedStopIds.includes(id))) {
    throw Object.assign(new Error('orderedStopIds must contain every stop for the day exactly once'), {
      status: 400,
    });
  }

  const reorder = db.transaction(() => {
    const update = db.prepare('UPDATE stops SET sort_order = ? WHERE id = ?');
    orderedStopIds.forEach((id, index) => {
      update.run(index + 1, id);
    });
  });

  reorder();

  return db.prepare('SELECT * FROM stops WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC').all(dayId).map(formatStop);
}

function inferBookingStop(booking) {
  if (booking.type === 'hotel') {
    const [datePart, timePart] = String(booking.start_datetime || '').split('T');
    const date = datePart || null;
    if (!date) return null;
    return {
      date,
      time: timePart ? timePart.slice(0, 5) : '15:00',
      title: booking.title,
      type: 'hotel',
      note: [booking.booking_source, booking.confirmation_ref].filter(Boolean).join(' • ') || null,
      bookingRequired: true,
      isFeatured: true,
      cityHint: booking.destination || booking.origin || '',
    };
  }

  if (!booking.start_datetime || !String(booking.start_datetime).includes('T')) {
    return null;
  }

  const [date, time] = booking.start_datetime.split('T');
  return {
    date,
    time: time.slice(0, 5),
    title: booking.title,
    type: booking.type === 'train' || booking.type === 'flight' || booking.type === 'ferry' ? 'transit' : 'booked',
    note: [booking.origin, booking.destination, booking.confirmation_ref].filter(Boolean).join(' • ') || null,
    bookingRequired: true,
    isFeatured: booking.type === 'flight',
    cityHint: booking.destination || booking.origin || '',
  };
}

export async function backfillTripPhotos(userId, tripId) {
  const db = getDb();
  const trip = db.prepare('SELECT id FROM trips WHERE id = ? AND owner_id = ?').get(tripId, userId);
  if (!trip) throw Object.assign(new Error('Not found'), { status: 404 });

  const nullStops = db.prepare(`
    SELECT s.id, s.title, s.type, d.city, d.trip_id, d.date
    FROM stops s
    JOIN days d ON s.day_id = d.id
    WHERE d.trip_id = ? AND s.unsplash_photo_url IS NULL AND s.type != 'transit'
  `).all(tripId);

  const updated = [];
  for (const s of nullStops) {
    const dayIndex = getDayIndex(s.trip_id, s.date);
    const url = await resolvePhotoUrl({ title: s.title, type: s.type, city: s.city, dayIndex });
    if (url) {
      db.prepare('UPDATE stops SET unsplash_photo_url = ? WHERE id = ?').run(url, s.id);
      updated.push(s.id);
    }
  }
  return updated;
}

export async function syncStopWithBooking(booking) {
  const db = getDb();
  const existingStop = db.prepare('SELECT * FROM stops WHERE booking_id = ?').get(booking.id);
  const inferred = inferBookingStop(booking);

  if (!inferred) {
    if (existingStop) {
      db.prepare('DELETE FROM stops WHERE id = ?').run(existingStop.id);
    }
    return null;
  }

  const day = db.prepare('SELECT * FROM days WHERE trip_id = ? AND date = ? LIMIT 1').get(booking.trip_id, inferred.date);
  if (!day) {
    if (existingStop) {
      db.prepare('DELETE FROM stops WHERE id = ?').run(existingStop.id);
    }
    return null;
  }

  const dayIndex = getDayIndex(day.trip_id, day.date);
  const unsplashPhotoUrl = await resolvePhotoUrl({
    title: inferred.title,
    type: inferred.type,
    city: inferred.cityHint || day.city,
    dayIndex,
    existingUrl: existingStop?.unsplash_photo_url,
  });

  if (existingStop) {
    const row = db.prepare(`
      UPDATE stops
      SET
        day_id = ?,
        time = ?,
        title = ?,
        type = ?,
        note = ?,
        unsplash_photo_url = ?,
        booking_required = 1,
        is_featured = ?
      WHERE id = ?
      RETURNING *
    `).get(
      day.id,
      inferred.time,
      inferred.title,
      inferred.type,
      inferred.note,
      unsplashPhotoUrl,
      inferred.isFeatured ? 1 : 0,
      existingStop.id,
    );
    return formatStop(row);
  }

  const row = db.prepare(`
    INSERT INTO stops (
      day_id, booking_id, time, title, type, note, unsplash_photo_url,
      booking_required, sort_order, is_featured
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    RETURNING *
  `).get(
    day.id,
    booking.id,
    inferred.time,
    inferred.title,
    inferred.type,
    inferred.note,
    unsplashPhotoUrl,
    nextSortOrder(day.id),
    inferred.isFeatured ? 1 : 0,
  );

  return formatStop(row);
}
