import { createHash } from 'crypto';
import { getDb } from '../db/database.js';
import {
  resolveCreateStopData,
  writeCreateStop,
  resolveUpdateStopData,
  writeUpdateStop,
  deleteStop,
} from './stops.js';
import { buildTripScopes, listTripScopes } from './trips.js';

// Plan 11 Wave 2 — server-side proposal records, validation, fingerprinting, atomic apply.
//
// A proposal is created the moment the model calls propose_itinerary_changes (Wave 1 tool).
// The same validation runs at creation AND again at apply (fact 3: the cross-trip hole is
// closed by matching every referenced day/stop against :tripId; D6: booking-linked stops are
// off-limits; D7: time is HH:MM|null; D12: unknown actions/fields fail loudly; D11/D12: the
// whole proposal is all-or-nothing). Apply is atomic (D4): every external call happens before
// a single better-sqlite3 transaction that commits all writes + the status flip or nothing.

const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const STOP_TYPES = ['experience', 'food', 'explore', 'transit'];
const ACTIONS = ['add_stop', 'remove_stop', 'move_stop', 'update_stop'];

// Mirrors the tool's update_stop.fields allowlist exactly (copilotTools.js). Photo fields,
// dayId, and anything else are rejected here — moves go through move_stop only.
const ALLOWED_UPDATE_FIELDS = ['title', 'type', 'time', 'note', 'duration', 'estimatedCost', 'bestTime'];

// Exactly which keys (besides `action`) each op may carry. Anything else is a schema
// violation. This is what enforces the "exactly one of" shape the tool schema describes in
// prose but cannot express structurally.
const ALLOWED_OP_KEYS = {
  add_stop: ['dayId', 'stop', 'placeId', 'placeVerified'],
  remove_stop: ['stopId'],
  move_stop: ['stopId', 'toDayId', 'position'],
  update_stop: ['stopId', 'fields'],
};
const ALLOWED_STOP_KEYS = ['title', 'type', 'time', 'note', 'lat', 'lng'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isTimeValid(value) {
  return value === null || value === undefined || (typeof value === 'string' && HHMM_RE.test(value));
}

function isNullableString(value) {
  return value === null || value === undefined || typeof value === 'string';
}

function isNullableNumber(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

// The co-pilot LLM emits stops as { title, type, time, note, lat, lng } with no
// locationQuery. Default the query to the title so the resolver attempts a geocode, and tag
// any model-supplied coordinates as 'copilot' so stops.js routes them through the
// generated-coordinate verification path instead of trusting hallucinated values.
export function enrichCopilotStop(stop) {
  const enriched = {
    ...stop,
    locationQuery: stop?.locationQuery ?? stop?.title,
  };
  if (stop?.lat != null && stop?.lng != null) {
    enriched.coordinateSource = 'copilot';
  }
  return enriched;
}

// Look up a day and its owning trip id (cross-trip check, fact 3).
function dayTripId(dayId) {
  const db = getDb();
  const row = db.prepare('SELECT trip_id FROM days WHERE id = ?').get(dayId);
  return row?.trip_id ?? null;
}

// Look up a stop's owning trip id + booking linkage (cross-trip + D6).
function stopMeta(stopId) {
  const db = getDb();
  return db.prepare(`
    SELECT s.id, s.booking_id, d.trip_id
    FROM stops s
    JOIN days d ON d.id = s.day_id
    WHERE s.id = ?
  `).get(stopId) ?? null;
}

// G5 grounded-add lookup: resolves an add_stop op's placeId against the catalogue and this
// trip's own scopes. A place is in-scope iff its discovery_destinations row's city_key is
// among the trip's scope canonical keys (buildTripScopes — the same trip-scope idiom
// copilotGrounding.js uses to resolve a free-text destination, applied here to a place's
// already-known destination instead). Returns a discriminated result so the caller (both
// validation and apply's resolve phase) gets a distinct reason per failure mode.
function lookupGroundedPlace(placeId, tripId) {
  const db = getDb();
  const place = db.prepare('SELECT * FROM discovery_places WHERE id = ?').get(placeId);
  if (!place) return { kind: 'unknown' };
  if (place.status !== 'active') return { kind: 'inactive' };

  const destinationRow = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(place.destination_id);
  if (!destinationRow) return { kind: 'unknown' };

  const dayRows = db.prepare('SELECT city, city_override FROM days WHERE trip_id = ?').all(tripId);
  const scopes = buildTripScopes(dayRows, listTripScopes(tripId));
  const inScope = scopes.some((scope) => scope.canonicalKey === destinationRow.city_key);
  if (!inScope) return { kind: 'out_of_scope' };

  return { kind: 'ok', place, destinationRow };
}

// Validates the whole proposal against the tool schema + trip membership + D6 + D7. Returns
// { ok: true } or { ok: false, reason }. All-or-nothing: the first failing operation
// invalidates the entire proposal (D11/D12).
export function validateProposalOperations(operations, tripId) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, reason: 'A proposal must contain at least one operation.' };
  }

  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    const label = `Operation ${i + 1}`;

    if (!isPlainObject(op)) {
      return { ok: false, reason: `${label} is not a valid operation object.` };
    }
    if (!ACTIONS.includes(op.action)) {
      return { ok: false, reason: `${label} has an unknown action "${op.action}".` };
    }

    // Reject any key that does not belong to this action (enforces the schema's
    // "exactly one of" intent — a disguised move via update_stop.dayId is rejected here).
    const allowedKeys = ALLOWED_OP_KEYS[op.action];
    for (const key of Object.keys(op)) {
      if (key !== 'action' && !allowedKeys.includes(key)) {
        return { ok: false, reason: `${label} (${op.action}) has an unexpected field "${key}".` };
      }
    }

    if (op.action === 'add_stop') {
      if (typeof op.dayId !== 'string' || !op.dayId) {
        return { ok: false, reason: `${label} (add_stop) is missing a valid dayId.` };
      }
      if (dayTripId(op.dayId) !== tripId) {
        return { ok: false, reason: `${label} (add_stop) targets a day that is not part of this trip.` };
      }
      const stop = op.stop;
      if (!isPlainObject(stop)) {
        return { ok: false, reason: `${label} (add_stop) is missing the stop details.` };
      }
      for (const key of Object.keys(stop)) {
        if (!ALLOWED_STOP_KEYS.includes(key)) {
          return { ok: false, reason: `${label} (add_stop) stop has an unexpected field "${key}".` };
        }
      }
      if (typeof stop.title !== 'string' || !stop.title.trim()) {
        return { ok: false, reason: `${label} (add_stop) needs a stop title.` };
      }
      if (!STOP_TYPES.includes(stop.type)) {
        return { ok: false, reason: `${label} (add_stop) has an invalid stop type "${stop.type}".` };
      }
      if (!isTimeValid(stop.time)) {
        return { ok: false, reason: `${label} (add_stop) time must be 24-hour "HH:MM" or null.` };
      }
      if (!isNullableString(stop.note)) {
        return { ok: false, reason: `${label} (add_stop) note must be text or null.` };
      }
      if (!isNullableNumber(stop.lat) || !isNullableNumber(stop.lng)) {
        return { ok: false, reason: `${label} (add_stop) coordinates must be numbers or null.` };
      }
      // G5: placeVerified is a server-stamped display flag — it may only ride alongside
      // a placeId (a model claiming verification with no place to back it up is a
      // schema violation, not a real proposal).
      if ('placeVerified' in op && !('placeId' in op)) {
        return { ok: false, reason: `${label} (add_stop) placeVerified requires a placeId.` };
      }
      if ('placeVerified' in op && typeof op.placeVerified !== 'boolean') {
        return { ok: false, reason: `${label} (add_stop) placeVerified must be a boolean.` };
      }
      if ('placeId' in op) {
        if (!Number.isInteger(op.placeId)) {
          return { ok: false, reason: `${label} (add_stop) placeId must be an integer.` };
        }
        const lookup = lookupGroundedPlace(op.placeId, tripId);
        if (lookup.kind === 'unknown') {
          return { ok: false, reason: `${label} (add_stop) references a catalogue place that does not exist.` };
        }
        if (lookup.kind === 'inactive') {
          return { ok: false, reason: `${label} (add_stop) references a catalogue place that is no longer available.` };
        }
        if (lookup.kind === 'out_of_scope') {
          return { ok: false, reason: `${label} (add_stop) references a place outside this trip's destinations.` };
        }
      }
    } else if (op.action === 'remove_stop') {
      const meta = requireInTripStop(label, 'remove_stop', op.stopId, tripId);
      if (meta.error) return meta.error;
    } else if (op.action === 'move_stop') {
      const meta = requireInTripStop(label, 'move_stop', op.stopId, tripId);
      if (meta.error) return meta.error;
      if (typeof op.toDayId !== 'string' || !op.toDayId) {
        return { ok: false, reason: `${label} (move_stop) is missing a valid toDayId.` };
      }
      if (dayTripId(op.toDayId) !== tripId) {
        return { ok: false, reason: `${label} (move_stop) targets a day that is not part of this trip.` };
      }
      if (!Number.isInteger(op.position) || op.position < 0) {
        return { ok: false, reason: `${label} (move_stop) position must be a non-negative integer.` };
      }
    } else if (op.action === 'update_stop') {
      const meta = requireInTripStop(label, 'update_stop', op.stopId, tripId);
      if (meta.error) return meta.error;
      const fields = op.fields;
      if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
        return { ok: false, reason: `${label} (update_stop) has no fields to change.` };
      }
      for (const key of Object.keys(fields)) {
        if (!ALLOWED_UPDATE_FIELDS.includes(key)) {
          return { ok: false, reason: `${label} (update_stop) cannot change field "${key}".` };
        }
      }
      if ('type' in fields && !STOP_TYPES.includes(fields.type)) {
        return { ok: false, reason: `${label} (update_stop) has an invalid stop type "${fields.type}".` };
      }
      if ('time' in fields && !isTimeValid(fields.time)) {
        return { ok: false, reason: `${label} (update_stop) time must be 24-hour "HH:MM" or null.` };
      }
      if ('title' in fields && (typeof fields.title !== 'string' || !fields.title.trim())) {
        return { ok: false, reason: `${label} (update_stop) title cannot be empty.` };
      }
    }
  }

  return { ok: true };
}

// Shared stop-membership + booking-linked (D6) check for remove/move/update.
function requireInTripStop(label, action, stopId, tripId) {
  if (typeof stopId !== 'string' || !stopId) {
    return { error: { ok: false, reason: `${label} (${action}) is missing a valid stopId.` } };
  }
  const meta = stopMeta(stopId);
  if (!meta || meta.trip_id !== tripId) {
    return { error: { ok: false, reason: `${label} (${action}) targets a stop that is not part of this trip.` } };
  }
  if (meta.booking_id != null) {
    return {
      error: {
        ok: false,
        reason: `${label} (${action}) targets a booking-linked stop. Manage bookings in Logistics.`,
      },
    };
  }
  return { meta };
}

// D5 loss warnings — computed at creation for remove_stop/update_stop targets carrying a
// user note or a user-pinned photo (photo_source = 'user'), which re-adding cannot recover.
export function computeLossWarnings(operations, tripId) {
  const db = getDb();
  const warnings = [];
  for (const op of operations) {
    if (op.action !== 'remove_stop' && op.action !== 'update_stop') continue;
    const stop = db.prepare(`
      SELECT s.id, s.title, s.note, s.photo_source, d.trip_id
      FROM stops s JOIN days d ON d.id = s.day_id
      WHERE s.id = ?
    `).get(op.stopId);
    if (!stop || stop.trip_id !== tripId) continue;

    const hasNote = typeof stop.note === 'string' && stop.note.trim().length > 0;
    const hasUserPhoto = stop.photo_source === 'user';
    if (!hasNote && !hasUserPhoto) continue;

    const losses = [];
    if (hasNote) losses.push('note');
    if (hasUserPhoto) losses.push('photo');
    warnings.push({
      stopId: stop.id,
      stopTitle: stop.title,
      action: op.action,
      losses,
    });
  }
  return warnings;
}

// Deterministic hash over the trip's STRUCTURAL state — ordered day ids, and per day the
// ordered stop ids with each stop's time + booking_id. Any structural change between
// proposal creation and apply (a reorder, a new/removed stop, a retimed stop, a booking
// linking) changes this hash → the proposal goes stale (409). Cosmetic edits (a note,
// a photo) deliberately do not.
export function computeTripFingerprint(tripId) {
  const db = getDb();
  const days = db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY date ASC, id ASC').all(tripId);
  const parts = days.map((day) => {
    const stops = db.prepare(
      'SELECT id, time, booking_id FROM stops WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC',
    ).all(day.id);
    const stopSig = stops.map((s) => `${s.id}|${s.time ?? ''}|${s.booking_id ?? ''}`).join(',');
    return `${day.id}:${stopSig}`;
  });
  return createHash('sha256').update(parts.join(';')).digest('hex');
}

function proposalToJson(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    messageId: row.message_id,
    createdByUserId: row.created_by_user_id,
    operations: JSON.parse(row.operations_json),
    warnings: JSON.parse(row.warnings_json),
    status: row.status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedByUserId: row.resolved_by_user_id,
  };
}

// Post-deployment follow-up (2026-07-15): a natural-language "move X to day Y" carries no
// positional intent, so the model routinely omits move_stop.position — which
// validateProposalOperations then hard-rejects, even though the tool schema can't
// structurally require it (a single polymorphic op object, "exactly one of" enforced only
// in prose). Defaulting to append-to-end here — rather than loosening the validator — keeps
// the position contract intact for callers who do supply one, while making the common
// no-position case work. Only defaults when toDayId already resolves to a real day of this
// trip; a malformed/hallucinated toDayId is left alone so it still fails validation honestly.
function defaultMoveStopPosition(op, tripId) {
  if (Number.isInteger(op.position) && op.position >= 0) return op;
  if (typeof op.toDayId !== 'string' || !op.toDayId) return op;
  if (dayTripId(op.toDayId) !== tripId) return op;
  const count = getDb().prepare('SELECT COUNT(*) AS count FROM stops WHERE day_id = ?').get(op.toDayId).count;
  return { ...op, position: count };
}

// G5: sanitizes + stamps every add_stop op's placeVerified flag BEFORE validation, on
// copies of the caller's operations (never mutated in place). The server is the only
// authority on verification — any model-supplied placeVerified is stripped first, then
// re-stamped true only when the placeId resolves to a provenance === 'verified' catalogue
// row. The stamped array is what gets validated, stored in operations_json, and returned,
// so the SSE payload and listProposalsForTrip both carry the flag with no further plumbing
// (Wave 4's badge hook). Also defaults a missing move_stop.position — see
// defaultMoveStopPosition above.
function sanitizeAndStampOperations(operations, tripId) {
  if (!Array.isArray(operations)) return operations;
  return operations.map((op) => {
    if (!isPlainObject(op)) return op;
    if (op.action === 'move_stop') return defaultMoveStopPosition(op, tripId);
    if (op.action !== 'add_stop') return op;
    const { placeVerified: _modelClaimedVerified, ...rest } = op;
    if (!Number.isInteger(rest.placeId)) return rest;
    const lookup = lookupGroundedPlace(rest.placeId, tripId);
    if (lookup.kind === 'ok' && lookup.place.provenance === 'verified') {
      return { ...rest, placeVerified: true };
    }
    return rest;
  });
}

// Creates the audit record the instant a tool call arrives. A schema/trip/booking/time
// violation still produces a row — status 'invalid' with the reason — so the failure is
// visible and auditable rather than a silent no-op (D12).
export function createProposal({ tripId, userId, messageId, operations }) {
  const db = getDb();
  const sanitizedOperations = sanitizeAndStampOperations(operations, tripId);
  const validation = validateProposalOperations(sanitizedOperations, tripId);
  const status = validation.ok ? 'pending' : 'invalid';
  const statusReason = validation.ok ? null : validation.reason;
  const warnings = validation.ok ? computeLossWarnings(sanitizedOperations, tripId) : [];
  const fingerprint = computeTripFingerprint(tripId);

  const row = db.prepare(`
    INSERT INTO copilot_proposals
      (trip_id, message_id, created_by_user_id, operations_json, warnings_json, trip_fingerprint, status, status_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    tripId,
    messageId ?? null,
    userId ?? null,
    JSON.stringify(sanitizedOperations),
    JSON.stringify(warnings),
    fingerprint,
    status,
    statusReason,
  );

  return {
    proposalId: row.id,
    operations: sanitizedOperations,
    warnings,
    status,
    statusReason,
  };
}

// G5 grounded-add field mapping — mirrors DiscoveryPanel.jsx's handleAddToDay exactly
// (frontend/src/components/discovery/DiscoveryPanel.jsx:411-469), so a co-pilot add backed
// by a catalogue place produces the identical stop input a manual Discovery add would.
// Preview-visible fields (title, type, time, note) come ONLY from the model's proposed
// stop — the preview the user approved must be what gets applied; lat/lng are never taken
// from the model. Catalogue coordinates are trusted only for provenance === 'verified' rows
// — the same line serializePlaceRow draws (routes/discovery.js:47) — because those came
// through our own resolver pipeline; any other row gets no coordinate fields at all, so
// resolveCreateStopData's normal resolver runs against the location hints below.
function buildGroundedStopInput(op, place, destinationRow) {
  const stop = op.stop;
  const aliases = JSON.parse(place.aliases_json || '[]');
  const base = {
    title: stop.title,
    type: stop.type,
    time: stop.time ?? null,
    note: stop.note ?? null,
    locationQuery: place.name,
    locationCity: destinationRow.display_name,
    locationCountry: destinationRow.country_code || null,
    localName: place.local_name,
    locationAliases: [place.local_name, ...aliases].filter(Boolean),
    duration: place.estimated_duration,
    source: 'discovery',
    provenance: place.provenance,
    photoQuery: place.photo_query,
    sceneType: place.scene_type,
  };

  if (place.provenance === 'verified' && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
    return {
      ...base,
      lat: place.lat,
      lng: place.lng,
      coordinateSystem: 'wgs84',
      coordinateSource: 'places',
      locationStatus: 'resolved',
      providerId: place.provider_place_id,
    };
  }

  return base;
}

function markStatus(proposalId, status, statusReason, userId) {
  getDb().prepare(`
    UPDATE copilot_proposals
    SET status = ?, status_reason = ?, resolved_at = datetime('now'), resolved_by_user_id = ?
    WHERE id = ?
  `).run(status, statusReason ?? null, userId ?? null, proposalId);
}

// Sync move using reorderStops semantics (1-based sort_order, display order
// `sort_order ASC, created_at ASC`) — replaces the deleted raw-SQL move path (fact 6), so a
// moved stop lands exactly at `position` with no sort_order 0-vs-1 collision.
function applyMove(db, op) {
  const fromRow = db.prepare('SELECT day_id FROM stops WHERE id = ?').get(op.stopId);
  const fromDayId = fromRow?.day_id ?? null;

  db.prepare('UPDATE stops SET day_id = ? WHERE id = ?').run(op.toDayId, op.stopId);

  const update = db.prepare('UPDATE stops SET sort_order = ? WHERE id = ?');
  const targetIds = db.prepare(
    'SELECT id FROM stops WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC',
  ).all(op.toDayId).map((r) => r.id);
  const without = targetIds.filter((id) => id !== op.stopId);
  const pos = Math.max(0, Math.min(op.position, without.length));
  without.splice(pos, 0, op.stopId);
  without.forEach((id, index) => update.run(index + 1, id));

  if (fromDayId && fromDayId !== op.toDayId) {
    const srcIds = db.prepare(
      'SELECT id FROM stops WHERE day_id = ? ORDER BY sort_order ASC, created_at ASC',
    ).all(fromDayId).map((r) => r.id);
    srcIds.forEach((id, index) => update.run(index + 1, id));
  }
}

// Applies a pending proposal atomically (D4). Throws with a status code on any refusal:
// 404 not found / wrong trip, 409 already resolved or stale fingerprint, 422 re-validation
// failure. On success every write and the status→applied flip commit in one transaction.
export async function applyProposal({ tripId, userId, proposalId }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM copilot_proposals WHERE id = ?').get(proposalId);
  if (!row || row.trip_id !== tripId) {
    throw Object.assign(new Error('Proposal not found'), { status: 404 });
  }
  if (row.status !== 'pending') {
    throw Object.assign(new Error(`This suggestion was already ${row.status}.`), { status: 409 });
  }

  const operations = JSON.parse(row.operations_json);

  // Re-validate: guards against a stop being deleted or booking-linked since creation in a
  // way the fingerprint alone would not explain in user terms.
  const validation = validateProposalOperations(operations, tripId);
  if (!validation.ok) {
    markStatus(proposalId, 'invalid', validation.reason, userId);
    throw Object.assign(new Error(validation.reason), { status: 422 });
  }

  // Re-fingerprint: any structural drift since creation → stale (D3).
  if (computeTripFingerprint(tripId) !== row.trip_fingerprint) {
    const reason = 'The trip changed since this suggestion was made. Ask again to get a fresh one.';
    markStatus(proposalId, 'stale', reason, userId);
    throw Object.assign(new Error(reason), { status: 409 });
  }

  const addOps = operations.filter((op) => op.action === 'add_stop');
  const removeOps = operations.filter((op) => op.action === 'remove_stop');
  const moveOps = operations.filter((op) => op.action === 'move_stop');
  const updateOps = operations.filter((op) => op.action === 'update_stop');

  // Resolve phase — ALL external calls (geocode, photos) happen here, before the
  // transaction, producing ready-to-write row data (fact 11).
  const resolvedAdds = [];
  for (const op of addOps) {
    if (Number.isInteger(op.placeId)) {
      // Re-validation above already confirmed this resolves 'ok' (active, in-scope).
      const { place, destinationRow } = lookupGroundedPlace(op.placeId, tripId);
      resolvedAdds.push(await resolveCreateStopData(userId, op.dayId, buildGroundedStopInput(op, place, destinationRow)));
    } else {
      resolvedAdds.push(await resolveCreateStopData(userId, op.dayId, enrichCopilotStop(op.stop)));
    }
  }
  const resolvedUpdates = [];
  for (const op of updateOps) {
    resolvedUpdates.push(await resolveUpdateStopData(userId, op.stopId, op.fields));
  }

  // Write phase — one transaction. Removes first, then moves, then updates, then adds, then
  // the status flip. Any throw rolls the whole thing back, leaving the trip and the proposal
  // untouched (D4 atomicity).
  const applyTxn = db.transaction(() => {
    for (const op of removeOps) deleteStop(userId, op.stopId);
    for (const op of moveOps) applyMove(db, op);
    for (const resolved of resolvedUpdates) writeUpdateStop(resolved);
    for (const resolved of resolvedAdds) writeCreateStop(resolved);
    db.prepare(`
      UPDATE copilot_proposals
      SET status = 'applied', status_reason = NULL, resolved_at = datetime('now'), resolved_by_user_id = ?
      WHERE id = ?
    `).run(userId ?? null, proposalId);
  });
  applyTxn();

  return proposalId;
}

export function rejectProposal({ tripId, userId, proposalId }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM copilot_proposals WHERE id = ?').get(proposalId);
  if (!row || row.trip_id !== tripId) {
    throw Object.assign(new Error('Proposal not found'), { status: 404 });
  }
  if (row.status !== 'pending') {
    throw Object.assign(new Error(`This suggestion was already ${row.status}.`), { status: 409 });
  }
  markStatus(proposalId, 'rejected', null, userId);
  return proposalId;
}

// Recent proposals for the trip, so the panel can restore pending previews and render
// applied/rejected/stale states on the message thread after a refresh (Wave 3).
export function listProposalsForTrip(tripId, limit = 50) {
  const rows = getDb().prepare(`
    SELECT * FROM copilot_proposals
    WHERE trip_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(tripId, limit);
  return rows.map(proposalToJson);
}
