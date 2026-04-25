import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import {
  inviteCollaborator,
  listCollaborators,
  removeCollaborator,
} from '../src/services/collaboration.js';
import { createShareLink, getSharedTrip } from '../src/services/share.js';
import { createStop } from '../src/services/stops.js';
import { createTrip, getTripDetail, listTripsForUser } from '../src/services/trips.js';

let tmpDir;
let owner;
let collaborator;
let otherUser;
let tripDetail;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-collab-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();

  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
  const inviteCode = authService.getInviteCode();
  collaborator = authService.register('friend', 'password123', 'Travel Friend', inviteCode).user;
  otherUser = authService.register('other', 'password123', 'Other User', inviteCode).user;
  tripDetail = createTrip(owner.id, {
    title: 'Spring Chengdu',
    destinations: ['Chengdu'],
    destinationCountries: ['CN'],
    startDate: '2026-05-01',
    endDate: '2026-05-02',
    travellers: 'friends',
    interestTags: ['tea'],
    pace: 'moderate',
  });
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

describe('collaboration service', () => {
  it('lets a trip owner invite a registered user by username', () => {
    const added = inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');
    const collaborators = listCollaborators(owner.id, tripDetail.trip.id);

    expect(added).toMatchObject({
      id: collaborator.id,
      username: 'friend',
      displayName: 'Travel Friend',
      role: 'editor',
    });
    expect(collaborators.owner.id).toBe(owner.id);
    expect(collaborators.canManage).toBe(true);
    expect(collaborators.collaborators).toHaveLength(1);
  });

  it('shows invited trips in the collaborator trip list', () => {
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');

    const trips = listTripsForUser(collaborator.id);

    expect(trips.map((trip) => trip.id)).toContain(tripDetail.trip.id);
  });

  it('lets collaborators access and edit itinerary data', async () => {
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');
    const dayId = tripDetail.days[0].id;

    const stop = await createStop(collaborator.id, dayId, {
      title: 'People Park Tea House',
      type: 'explore',
      time: '10:00',
    });
    const detail = getTripDetail(tripDetail.trip.id, collaborator.id);

    expect(stop.title).toBe('People Park Tea House');
    expect(detail.days[0].stops.map((item) => item.id)).toContain(stop.id);
  });

  it('prevents collaborators from managing other collaborators', () => {
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');

    expect(() => inviteCollaborator(collaborator.id, tripDetail.trip.id, 'other')).toThrow(
      'Only the trip owner can manage collaborators',
    );
    expect(() => removeCollaborator(collaborator.id, tripDetail.trip.id, collaborator.id)).toThrow(
      'Only the trip owner can manage collaborators',
    );
  });

  it('lets the trip owner remove a collaborator', () => {
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');

    const result = removeCollaborator(owner.id, tripDetail.trip.id, collaborator.id);
    const collaborators = listCollaborators(owner.id, tripDetail.trip.id);

    expect(result).toEqual({ ok: true });
    expect(collaborators.collaborators).toHaveLength(0);
    expect(listTripsForUser(collaborator.id).map((trip) => trip.id)).not.toContain(tripDetail.trip.id);
  });

  it('prevents inviting the owner or duplicate collaborators', () => {
    expect(() => inviteCollaborator(owner.id, tripDetail.trip.id, 'owner')).toThrow(
      'Trip owner is already on this trip',
    );

    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');
    expect(() => inviteCollaborator(owner.id, tripDetail.trip.id, 'friend')).toThrow(
      'User is already a collaborator',
    );
  });

  it('keeps unrelated authenticated users from listing collaborators', () => {
    expect(() => listCollaborators(otherUser.id, tripDetail.trip.id)).toThrow('Trip not found');
  });
});

describe('share service', () => {
  it('creates a stable share token and returns public itinerary data without bookings', async () => {
    await createStop(owner.id, tripDetail.days[0].id, {
      title: 'Wide Alley',
      type: 'explore',
      time: '09:30',
    });

    const first = createShareLink(owner.id, tripDetail.trip.id);
    const second = createShareLink(owner.id, tripDetail.trip.id);
    const shared = getSharedTrip(first.token);

    expect(first.token).toBeTruthy();
    expect(second.token).toBe(first.token);
    expect(shared.trip.title).toBe('Spring Chengdu');
    expect(shared.days[0].stops[0].title).toBe('Wide Alley');
    expect(shared).not.toHaveProperty('bookings');
    expect(shared.trip).not.toHaveProperty('ownerId');
  });

  it('lets an editor collaborator create a share token', () => {
    inviteCollaborator(owner.id, tripDetail.trip.id, 'friend');

    const link = createShareLink(collaborator.id, tripDetail.trip.id);

    expect(link.token).toBeTruthy();
  });

  it('returns 404-style errors for invalid share tokens', () => {
    expect(() => getSharedTrip('missing-token')).toThrow('Share link not found');
  });
});
