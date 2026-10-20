import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { CHENGDU_REPAIR, planRepair, applyRepair } from '../scripts/importFileProvenanceRepair.js';

// Plan 38 W2 (D-38-5): the one-off production correction. Exercises the exported plan/apply functions
// on a temp database seeded in the production shape; main() never runs under import.

const ARTIFACT_ID = CHENGDU_REPAIR.artifactId;
const importedFrom = { artifactId: ARTIFACT_ID, model: 'claude-sonnet-5-5', extractedAt: '2026-10-20T11:13:04.404Z' };

let tmpDir;

async function seed({ filenames = CHENGDU_REPAIR.files, titles = CHENGDU_REPAIR.bookings.map((b) => b.title) } = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-test-provenance-repair-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();
  const db = getDb();
  db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ('tester', 'x', 'Tester', 0)").run();
  const userId = db.prepare("SELECT id FROM users WHERE username = 'tester'").get().id;
  const tripId = db.prepare(
    "INSERT INTO trips (title, owner_id, start_date, end_date) VALUES ('Chengdu - Chongqing', ?, '2026-06-08', '2026-06-15') RETURNING id",
  ).get(userId).id;
  const extraction = {
    isTravelRelated: true,
    summary: 's',
    language: 'en',
    bookings: CHENGDU_REPAIR.bookings.map((b, i) => ({ type: 'hotel', title: titles[i], detailsJson: { importedFrom } })),
  };
  db.prepare("INSERT INTO import_artifacts (id, user_id, trip_id, status, extracted_json) VALUES (?, ?, ?, 'confirmed', ?)")
    .run(ARTIFACT_ID, userId, tripId, JSON.stringify(extraction));
  filenames.forEach((filename, position) => {
    db.prepare(`INSERT INTO import_artifact_files (artifact_id, position, kind, media_type, filename, size_bytes, content_hash, content)
      VALUES (?, ?, 'image', 'image/png', ?, 1, ?, x'00')`).run(ARTIFACT_ID, position, filename, `hash${position}`);
  });
  CHENGDU_REPAIR.bookings.forEach((b, i) => {
    db.prepare('INSERT INTO bookings (id, trip_id, type, title, details_json) VALUES (?, ?, ?, ?, ?)')
      .run(b.id, tripId, 'hotel', titles[i], JSON.stringify({ city: 'Chengdu', importedFrom }));
  });
  return db;
}

const positionsOf = (db, id) => JSON.parse(db.prepare('SELECT details_json FROM bookings WHERE id = ?').get(id).details_json).importedFrom.filePositions;

afterEach(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('importFileProvenanceRepair', () => {
  let db;
  beforeEach(async () => { db = await seed(); });

  it('dry plan names each booking with its own file and writes nothing', () => {
    const plan = planRepair(db);
    expect(plan.lines).toEqual([
      'Regent Chongqing -> regent_chongqing.png  (booking: set; stored extraction: set)',
      'The Ritz-Carlton, Chengdu -> TFURZ_Chengdu.png  (booking: set; stored extraction: set)',
      'SQ 842 -> SIN_TFU_SQ.png  (booking: set; stored extraction: set)',
      'SQ 843 -> TFU_SIN_SQ.png  (booking: set; stored extraction: set)',
    ]);
    expect(plan.bookingWrites).toHaveLength(4);
    expect(positionsOf(db, CHENGDU_REPAIR.bookings[2].id)).toBeUndefined();
  });

  it('apply sets only filePositions, on the bookings and the stored extraction, and is idempotent', () => {
    applyRepair(db, planRepair(db));
    for (const b of CHENGDU_REPAIR.bookings) expect(positionsOf(db, b.id)).toEqual(b.filePositions);
    const details = JSON.parse(db.prepare('SELECT details_json FROM bookings WHERE id = ?').get(CHENGDU_REPAIR.bookings[0].id).details_json);
    expect(details).toEqual({ city: 'Chengdu', importedFrom: { ...importedFrom, filePositions: [0] } });
    const stored = JSON.parse(db.prepare('SELECT extracted_json FROM import_artifacts WHERE id = ?').get(ARTIFACT_ID).extracted_json);
    expect(stored.bookings.map((b) => b.detailsJson.importedFrom.filePositions)).toEqual([[0], [3], [1], [2]]);

    const again = planRepair(db);
    expect(again.bookingWrites).toEqual([]);
    expect(again.extractedJson).toBeNull();
    expect(again.lines.every((l) => l.endsWith('(booking: already correct; stored extraction: already correct)'))).toBe(true);
  });

  it('refuses when a booking already has different positions', () => {
    const id = CHENGDU_REPAIR.bookings[2].id;
    db.prepare('UPDATE bookings SET details_json = ? WHERE id = ?')
      .run(JSON.stringify({ importedFrom: { ...importedFrom, filePositions: [0] } }), id);
    expect(() => planRepair(db)).toThrow(/already has filePositions \[0\], expected \[1\]/);
  });
});

describe('importFileProvenanceRepair guards', () => {
  it('refuses when a filename differs', async () => {
    const db = await seed({ filenames: ['regent_chongqing.png', 'TFU_SIN_SQ.png', 'SIN_TFU_SQ.png', 'TFURZ_Chengdu.png'] });
    expect(() => planRepair(db)).toThrow(/artifact files are/);
  });

  it('refuses when a booking title differs', async () => {
    const db = await seed({ titles: ['Regent Chongqing', 'The Ritz-Carlton, Chengdu', 'SQ 843', 'SQ 842'] });
    expect(() => planRepair(db)).toThrow(/is titled "SQ 843", expected "SQ 842"/);
  });
});
