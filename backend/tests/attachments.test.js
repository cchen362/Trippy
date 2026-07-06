import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import * as authService from '../src/services/auth.js';
import { createTrip } from '../src/services/trips.js';
import { createBooking, deleteBooking } from '../src/services/bookings.js';
import { addAttachment, deleteAttachment, getAttachmentFile, listAttachments } from '../src/services/attachments.js';

let tmpDir;
let owner;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-attachments-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  owner = authService.setup('owner', 'password123', 'Trip Owner').user;
});

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

function makeTrip() {
  return createTrip(owner.id, {
    title: 'Sichuan Trip',
    destinations: ['Chengdu'],
    destinationCountries: ['CN'],
    startDate: '2026-09-10',
    endDate: '2026-09-20',
    travellers: 'solo',
    interestTags: [],
    pace: 'moderate',
  });
}

async function makeBooking() {
  const trip = makeTrip();
  const booking = await createBooking(owner.id, trip.trip.id, {
    type: 'hotel',
    title: 'Hand-entered hotel',
    confirmationRef: 'HOTEL1',
  });
  return { trip, booking };
}

const PNG_BASE64 = Buffer.from('fake-image-bytes').toString('base64');
const PDF_BASE64 = Buffer.from('fake-pdf-bytes').toString('base64');

describe('addAttachment / listAttachments', () => {
  it('persists a valid image attachment', async () => {
    const { booking } = await makeBooking();
    const attachment = await addAttachment(owner.id, booking.id, {
      mediaType: 'image/png', filename: 'photo.png', content: PNG_BASE64,
    });
    expect(attachment.mediaType).toBe('image/png');
    expect(attachment.filename).toBe('photo.png');

    const list = listAttachments(owner.id, booking.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(attachment.id);
    expect(list[0].content).toBeUndefined();
  });

  it('persists a valid PDF attachment', async () => {
    const { booking } = await makeBooking();
    const attachment = addAttachment(owner.id, booking.id, {
      mediaType: 'application/pdf', filename: 'confirmation.pdf', content: PDF_BASE64,
    });
    expect(attachment.mediaType).toBe('application/pdf');
  });

  it('rejects an unsupported mediaType', async () => {
    const { booking } = await makeBooking();
    expect(() => addAttachment(owner.id, booking.id, {
      mediaType: 'text/plain', filename: 'notes.txt', content: PNG_BASE64,
    })).toThrow();
  });

  it('rejects an oversize image', async () => {
    const { booking } = await makeBooking();
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    expect(() => addAttachment(owner.id, booking.id, {
      mediaType: 'image/png', filename: 'big.png', content: oversize,
    })).toThrow();
  });

  it('rejects an oversize pdf', async () => {
    const { booking } = await makeBooking();
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect(() => addAttachment(owner.id, booking.id, {
      mediaType: 'application/pdf', filename: 'big.pdf', content: oversize,
    })).toThrow();
  });

  it('rejects a 5th attachment on the same booking', async () => {
    const { booking } = await makeBooking();
    for (let i = 0; i < 4; i += 1) {
      addAttachment(owner.id, booking.id, { mediaType: 'image/png', filename: `p${i}.png`, content: PNG_BASE64 });
    }
    expect(() => addAttachment(owner.id, booking.id, {
      mediaType: 'image/png', filename: 'p5.png', content: PNG_BASE64,
    })).toThrow();
  });
});

describe('getAttachmentFile round-trip', () => {
  it('returns the exact bytes and media type that were uploaded', async () => {
    const { booking } = await makeBooking();
    const attachment = addAttachment(owner.id, booking.id, {
      mediaType: 'image/webp', filename: 'shot.webp', content: PNG_BASE64,
    });

    const file = getAttachmentFile(owner.id, booking.id, attachment.id);
    expect(file.media_type).toBe('image/webp');
    expect(file.content.toString('base64')).toBe(PNG_BASE64);
  });
});

describe('access control', () => {
  it('404s for all attachment operations when called by an unrelated user', async () => {
    const { booking } = await makeBooking();
    const attachment = addAttachment(owner.id, booking.id, {
      mediaType: 'image/png', filename: 'p.png', content: PNG_BASE64,
    });

    const inviteCode = authService.getInviteCode();
    const stranger = authService.register('stranger', 'password123', 'Stranger', inviteCode).user;

    for (const fn of [
      () => listAttachments(stranger.id, booking.id),
      () => addAttachment(stranger.id, booking.id, { mediaType: 'image/png', filename: 'x.png', content: PNG_BASE64 }),
      () => getAttachmentFile(stranger.id, booking.id, attachment.id),
      () => deleteAttachment(stranger.id, booking.id, attachment.id),
    ]) {
      expect(fn).toThrow();
      try {
        fn();
      } catch (err) {
        expect(err.status).toBe(404);
      }
    }
  });
});

describe('deleteAttachment', () => {
  it('removes the row and 404s on a second delete', async () => {
    const { booking } = await makeBooking();
    const attachment = addAttachment(owner.id, booking.id, {
      mediaType: 'image/png', filename: 'p.png', content: PNG_BASE64,
    });

    expect(deleteAttachment(owner.id, booking.id, attachment.id)).toEqual({ ok: true });
    expect(listAttachments(owner.id, booking.id)).toHaveLength(0);
    expect(() => deleteAttachment(owner.id, booking.id, attachment.id)).toThrow();
  });
});

describe('cascade delete with booking', () => {
  it('removes all attachments when the booking is deleted', async () => {
    const { booking } = await makeBooking();
    addAttachment(owner.id, booking.id, { mediaType: 'image/png', filename: 'p1.png', content: PNG_BASE64 });
    addAttachment(owner.id, booking.id, { mediaType: 'application/pdf', filename: 'p2.pdf', content: PDF_BASE64 });

    const before = getDb().prepare('SELECT COUNT(*) as count FROM booking_attachments WHERE booking_id = ?').get(booking.id);
    expect(before.count).toBe(2);

    deleteBooking(owner.id, booking.id);

    const after = getDb().prepare('SELECT COUNT(*) as count FROM booking_attachments WHERE booking_id = ?').get(booking.id);
    expect(after.count).toBe(0);
  });
});
