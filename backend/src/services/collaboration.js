import { getDb } from '../db/database.js';
import { assertTripAccess } from './trips.js';

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
  };
}

function mapCollaborator(row) {
  return {
    ...mapUser(row),
    role: row.role,
    addedAt: row.added_at,
  };
}

export function assertTripOwner(userId, tripId) {
  const db = getDb();
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);

  if (!trip) {
    throw Object.assign(new Error('Trip not found'), { status: 404 });
  }

  if (trip.owner_id !== userId) {
    throw Object.assign(new Error('Only the trip owner can manage collaborators'), {
      status: 403,
    });
  }

  return trip;
}

export function listCollaborators(userId, tripId) {
  const db = getDb();
  const trip = assertTripAccess(userId, tripId);
  const owner = db.prepare(`
    SELECT id, username, display_name, is_admin
    FROM users
    WHERE id = ?
  `).get(trip.owner_id);

  const collaborators = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.is_admin, tc.role, tc.added_at
    FROM trip_collaborators tc
    JOIN users u ON u.id = tc.user_id
    WHERE tc.trip_id = ?
    ORDER BY tc.added_at ASC, u.username ASC
  `).all(tripId).map(mapCollaborator);

  return {
    owner: { ...mapUser(owner), role: 'owner' },
    collaborators,
    canManage: trip.owner_id === userId,
  };
}

export function inviteCollaborator(userId, tripId, username) {
  const db = getDb();
  const trip = assertTripOwner(userId, tripId);
  const normalizedUsername = username?.trim();

  if (!normalizedUsername) {
    throw Object.assign(new Error('username is required'), { status: 400 });
  }

  const user = db.prepare(`
    SELECT id, username, display_name, is_admin
    FROM users
    WHERE username = ?
  `).get(normalizedUsername);

  if (!user) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  if (user.id === trip.owner_id) {
    throw Object.assign(new Error('Trip owner is already on this trip'), { status: 400 });
  }

  const existing = db.prepare(`
    SELECT 1
    FROM trip_collaborators
    WHERE trip_id = ? AND user_id = ?
  `).get(tripId, user.id);

  if (existing) {
    throw Object.assign(new Error('User is already a collaborator'), { status: 409 });
  }

  db.prepare(`
    INSERT INTO trip_collaborators (trip_id, user_id, role)
    VALUES (?, ?, 'editor')
  `).run(tripId, user.id);

  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.is_admin, tc.role, tc.added_at
    FROM trip_collaborators tc
    JOIN users u ON u.id = tc.user_id
    WHERE tc.trip_id = ? AND tc.user_id = ?
  `).get(tripId, user.id);

  return mapCollaborator(row);
}

export function removeCollaborator(userId, tripId, collaboratorUserId) {
  const db = getDb();
  const trip = assertTripOwner(userId, tripId);

  if (collaboratorUserId === trip.owner_id) {
    throw Object.assign(new Error('Trip owner cannot be removed'), { status: 400 });
  }

  const result = db.prepare(`
    DELETE FROM trip_collaborators
    WHERE trip_id = ? AND user_id = ?
  `).run(tripId, collaboratorUserId);

  if (result.changes === 0) {
    throw Object.assign(new Error('Collaborator not found'), { status: 404 });
  }

  return { ok: true };
}
