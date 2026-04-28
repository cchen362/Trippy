import { getDb } from '../db/database.js';
import { pickPhoto } from './unsplash.js';
import { assertDayAccess, assertStopAccess } from './trips.js';
import { resolvePlace } from './placeResolver.js';

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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countryForDay(day) {
  try {
    const countries = JSON.parse(day.destination_countries || '[]');
    return Array.isArray(countries) ? countries[0] : null;
  } catch {
    return null;
  }
}

function hasCoordinates(input) {
  return Number.isFinite(Number(input?.lat)) && Number.isFinite(Number(input?.lng));
}

function hasTrustedCoordinateMetadata(input) {
  return ['wgs84', 'gcj02'].includes(input?.coordinateSystem)
    && ['resolved', 'estimated', 'user_confirmed'].includes(input?.locationStatus || 'resolved');
}

function isGeneratedCoordinateSource(source) {
  return source === 'discovery' || source === 'copilot';
}

function isSimilarPlace(query, resolvedName) {
  const normalizedQuery = normalizeText(query);
  const normalizedResolved = normalizeText(resolvedName);
  if (!normalizedQuery || !normalizedResolved) return false;
  return normalizedQuery === normalizedResolved
    || normalizedQuery.includes(normalizedResolved)
    || normalizedResolved.includes(normalizedQuery);
}

function applyResolutionFields(base, resolution, locationQuery) {
  return {
    ...base,
    lat: resolution.lat ?? null,
    lng: resolution.lng ?? null,
    locationQuery,
    resolvedName: resolution.resolvedName ?? null,
    resolvedAddress: resolution.resolvedAddress ?? null,
    coordinateSystem: resolution.coordinateSystem || 'unknown',
    coordinateSource: resolution.coordinateSource ?? null,
    locationStatus: resolution.locationStatus || 'unresolved',
    locationConfidence: resolution.confidence ?? null,
    providerId: resolution.providerId ?? null,
  };
}

function preserveLocationFields(input) {
  return {
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    locationQuery: input.locationQuery ?? input.title ?? null,
    resolvedName: input.resolvedName ?? null,
    resolvedAddress: input.resolvedAddress ?? null,
    coordinateSystem: input.coordinateSystem || 'unknown',
    coordinateSource: input.coordinateSource ?? null,
    locationStatus: input.locationStatus || 'resolved',
    locationConfidence: input.locationConfidence ?? null,
    providerId: input.providerId ?? null,
  };
}

async function resolveLocationForStop({ day, title, input, existing = null }) {
  const explicitLocationQuery = input.locationQuery ?? input.location ?? null;
  const locationQuery = (explicitLocationQuery || input.resolvedName || title || '').trim();
  const inputHasCoordinates = hasCoordinates(input);
  const trustedCoordinates = inputHasCoordinates && hasTrustedCoordinateMetadata(input);
  const generatedCoordinates = inputHasCoordinates && isGeneratedCoordinateSource(input.coordinateSource);

  if (trustedCoordinates && !generatedCoordinates) {
    return preserveLocationFields({ ...input, locationQuery });
  }

  const existingQuery = existing?.location_query || existing?.title || '';
  const queryChanged = Boolean(existing) && normalizeText(locationQuery) !== normalizeText(existingQuery);
  const protectedUserPin = existing?.location_status === 'user_confirmed'
    && !input.reResolveLocation
    && !trustedCoordinates;

  if (protectedUserPin) {
    return {
      lat: existing.lat,
      lng: existing.lng,
      locationQuery: existing.location_query,
      resolvedName: existing.resolved_name,
      resolvedAddress: existing.resolved_address,
      coordinateSystem: existing.coordinate_system,
      coordinateSource: existing.coordinate_source,
      locationStatus: existing.location_status,
      locationConfidence: existing.location_confidence,
      providerId: existing.provider_id,
    };
  }

  const shouldResolve = Boolean(locationQuery)
    && (!existing || input.reResolveLocation || queryChanged || generatedCoordinates || (!inputHasCoordinates && input.locationQuery !== undefined));

  if (shouldResolve) {
    const resolution = await resolvePlace({
      queryText: locationQuery,
      city: day.resolvedCity || day.city,
      country: countryForDay(day),
      allowNetwork: Boolean(explicitLocationQuery || input.reResolveLocation || input.coordinateSource === 'booking'),
    });

    if (resolution.lat !== null && resolution.lng !== null && (!inputHasCoordinates || isSimilarPlace(locationQuery, resolution.resolvedName))) {
      const confirmedResolution = generatedCoordinates && resolution.coordinateSystem === 'unknown'
        ? { ...resolution, locationStatus: 'estimated', confidence: Math.min(resolution.confidence ?? 0.68, 0.68) }
        : resolution;
      return applyResolutionFields({}, confirmedResolution, locationQuery);
    }

    if (inputHasCoordinates) {
      return {
        lat: input.lat,
        lng: input.lng,
        locationQuery,
        resolvedName: resolution.resolvedName ?? null,
        resolvedAddress: resolution.resolvedAddress ?? null,
        coordinateSystem: input.coordinateSystem || 'unknown',
        coordinateSource: input.coordinateSource || 'discovery',
        locationStatus: 'estimated',
        locationConfidence: Math.min(resolution.confidence ?? 0.5, 0.68),
        providerId: resolution.providerId ?? null,
      };
    }

    return applyResolutionFields({}, resolution, locationQuery);
  }

  if (inputHasCoordinates) {
    return {
      lat: input.lat,
      lng: input.lng,
      locationQuery,
      resolvedName: input.resolvedName ?? existing?.resolved_name ?? null,
      resolvedAddress: input.resolvedAddress ?? existing?.resolved_address ?? null,
      coordinateSystem: input.coordinateSystem || existing?.coordinate_system || 'unknown',
      coordinateSource: input.coordinateSource ?? existing?.coordinate_source ?? null,
      locationStatus: input.locationStatus || existing?.location_status || 'estimated',
      locationConfidence: input.locationConfidence ?? existing?.location_confidence ?? null,
      providerId: input.providerId ?? existing?.provider_id ?? null,
    };
  }

  return {
    lat: existing?.lat ?? null,
    lng: existing?.lng ?? null,
    locationQuery: existing?.location_query ?? locationQuery ?? null,
    resolvedName: existing?.resolved_name ?? null,
    resolvedAddress: existing?.resolved_address ?? null,
    coordinateSystem: existing?.coordinate_system ?? 'unknown',
    coordinateSource: existing?.coordinate_source ?? null,
    locationStatus: existing?.location_status ?? 'unresolved',
    locationConfidence: existing?.location_confidence ?? null,
    providerId: existing?.provider_id ?? null,
  };
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
  const location = await resolveLocationForStop({ day, title, input });
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
      estimated_cost, booking_required, best_time, duration, sort_order, is_featured,
      location_query, resolved_name, resolved_address, coordinate_system, coordinate_source,
      location_status, location_confidence, provider_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    dayId,
    input.bookingId || null,
    input.time || null,
    title,
    type,
    input.note || null,
    location.lat,
    location.lng,
    unsplashPhotoUrl,
    input.estimatedCost || null,
    input.bookingRequired ? 1 : 0,
    input.bestTime || null,
    input.duration || null,
    input.sortOrder ?? nextSortOrder(dayId),
    input.isFeatured ? 1 : 0,
    location.locationQuery,
    location.resolvedName,
    location.resolvedAddress,
    location.coordinateSystem,
    location.coordinateSource,
    location.locationStatus,
    location.locationConfidence,
    location.providerId,
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
  const location = await resolveLocationForStop({ day, title, input, existing });
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
      is_featured = ?,
      location_query = ?,
      resolved_name = ?,
      resolved_address = ?,
      coordinate_system = ?,
      coordinate_source = ?,
      location_status = ?,
      location_confidence = ?,
      provider_id = ?
    WHERE id = ?
    RETURNING *
  `).get(
    targetDayId,
    input.time ?? existing.time,
    title,
    type,
    input.note ?? existing.note,
    location.lat,
    location.lng,
    unsplashPhotoUrl,
    input.estimatedCost ?? existing.estimated_cost,
    input.bookingRequired !== undefined ? (input.bookingRequired ? 1 : 0) : existing.booking_required,
    input.bestTime ?? existing.best_time,
    input.duration ?? existing.duration,
    sortOrder,
    input.isFeatured !== undefined ? (input.isFeatured ? 1 : 0) : existing.is_featured,
    location.locationQuery,
    location.resolvedName,
    location.resolvedAddress,
    location.coordinateSystem,
    location.coordinateSource,
    location.locationStatus,
    location.locationConfidence,
    location.providerId,
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
  if (!booking.show_in_itinerary) return null;

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
      locationQuery: booking.destination || booking.title,
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
    locationQuery: booking.type === 'other' ? (booking.destination || booking.title) : (booking.destination || booking.origin || booking.title),
    cityHint: booking.destination || booking.origin || '',
  };
}

function cleanupLinkedStop(stop) {
  if (!stop) return;
  const db = getDb();
  if (stop.booking_required) {
    db.prepare('DELETE FROM stops WHERE id = ?').run(stop.id);
  } else {
    db.prepare('UPDATE stops SET booking_id = NULL WHERE id = ?').run(stop.id);
  }
}

function findMatchingStopForBooking(dayId, booking, location) {
  if (booking.type !== 'other') return null;
  const db = getDb();
  const title = normalizeText(booking.title);
  const destination = normalizeText(booking.destination);
  const providerId = location?.providerId;

  const rows = db.prepare(`
    SELECT *
    FROM stops
    WHERE day_id = ?
      AND (booking_id IS NULL OR booking_id = ?)
    ORDER BY COALESCE(time, '99:99') ASC, sort_order ASC, created_at ASC
  `).all(dayId, booking.id);

  return rows.find((stop) => {
    const stopTitle = normalizeText(stop.title);
    const stopQuery = normalizeText(stop.location_query);
    const textMatch = (title && (stopTitle === title || stopQuery === title))
      || (destination && (stopTitle === destination || stopQuery === destination));
    const providerMatch = providerId && stop.provider_id && providerId === stop.provider_id;
    return textMatch || providerMatch;
  }) || null;
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
    cleanupLinkedStop(existingStop);
    return null;
  }

  const day = db.prepare(`
    SELECT d.*, t.destination_countries
    FROM days d
    JOIN trips t ON t.id = d.trip_id
    WHERE d.trip_id = ? AND d.date = ?
    LIMIT 1
  `).get(booking.trip_id, inferred.date);
  if (!day) {
    cleanupLinkedStop(existingStop);
    return null;
  }

  const location = await resolveLocationForStop({
    day,
    title: inferred.title,
    input: {
      title: inferred.title,
      locationQuery: inferred.locationQuery,
      coordinateSource: 'booking',
    },
    existing: existingStop,
  });

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
        booking_id = ?,
        time = ?,
        title = ?,
        type = ?,
        note = ?,
        lat = ?,
        lng = ?,
        unsplash_photo_url = ?,
        booking_required = 1,
        is_featured = ?,
        location_query = ?,
        resolved_name = ?,
        resolved_address = ?,
        coordinate_system = ?,
        coordinate_source = ?,
        location_status = ?,
        location_confidence = ?,
        provider_id = ?
      WHERE id = ?
      RETURNING *
    `).get(
      day.id,
      booking.id,
      inferred.time,
      inferred.title,
      inferred.type,
      inferred.note,
      location.lat,
      location.lng,
      unsplashPhotoUrl,
      inferred.isFeatured ? 1 : 0,
      location.locationQuery,
      location.resolvedName,
      location.resolvedAddress,
      location.coordinateSystem,
      location.coordinateSource,
      location.locationStatus,
      location.locationConfidence,
      location.providerId,
      existingStop.id,
    );
    return formatStop(row);
  }

  const matchingStop = findMatchingStopForBooking(day.id, booking, location);
  if (matchingStop) {
    const row = db.prepare(`
      UPDATE stops
      SET
        booking_id = ?,
        lat = COALESCE(lat, ?),
        lng = COALESCE(lng, ?),
        location_query = COALESCE(location_query, ?),
        resolved_name = COALESCE(resolved_name, ?),
        resolved_address = COALESCE(resolved_address, ?),
        coordinate_system = CASE WHEN coordinate_system = 'unknown' THEN ? ELSE coordinate_system END,
        coordinate_source = COALESCE(coordinate_source, ?),
        location_status = CASE WHEN location_status = 'unresolved' THEN ? ELSE location_status END,
        location_confidence = COALESCE(location_confidence, ?),
        provider_id = COALESCE(provider_id, ?)
      WHERE id = ?
      RETURNING *
    `).get(
      booking.id,
      location.lat,
      location.lng,
      location.locationQuery,
      location.resolvedName,
      location.resolvedAddress,
      location.coordinateSystem,
      location.coordinateSource,
      location.locationStatus,
      location.locationConfidence,
      location.providerId,
      matchingStop.id,
    );
    return formatStop(row);
  }

  const row = db.prepare(`
    INSERT INTO stops (
      day_id, booking_id, time, title, type, note, lat, lng, unsplash_photo_url,
      booking_required, sort_order, is_featured, location_query, resolved_name,
      resolved_address, coordinate_system, coordinate_source, location_status,
      location_confidence, provider_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    day.id,
    booking.id,
    inferred.time,
    inferred.title,
    inferred.type,
    inferred.note,
    location.lat,
    location.lng,
    unsplashPhotoUrl,
    nextSortOrder(day.id),
    inferred.isFeatured ? 1 : 0,
    location.locationQuery,
    location.resolvedName,
    location.resolvedAddress,
    location.coordinateSystem,
    location.coordinateSource,
    location.locationStatus,
    location.locationConfidence,
    location.providerId,
  );

  return formatStop(row);
}
