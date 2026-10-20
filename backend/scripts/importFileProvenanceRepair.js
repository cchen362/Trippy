// One-off: record which uploaded file each booking of a multi-file import came from (Plan 38 W2).
// Bookings imported before Plan 38 carry only importedFrom.artifactId, so every booking of a
// multi-file import listed every file of it. Production held exactly one such import (Plan 38
// F-38-5): the owner's four Chengdu–Chongqing screenshots. The mapping below was confirmed by the
// owner (Plan 38 Q-38-1). It is written to the four bookings and to the same four bookings inside
// the artifact's stored extraction, so a cached re-upload keeps the link (D-38-5).
//
// Usage (run from backend/):
//   node scripts/importFileProvenanceRepair.js          (dry-run — prints only)
//   node scripts/importFileProvenanceRepair.js --apply  (writes, in one transaction)
//
// D-38-5: it refuses to write unless every id, title, artifact link and filename is exactly what the
// mapping expects; it touches only importedFrom.filePositions; a second run reports "already correct".

import { pathToFileURL } from 'url';
import { config } from '../src/config.js';
import { initDb, getDb } from '../src/db/database.js';

export const CHENGDU_REPAIR = Object.freeze({
  artifactId: '1b659f4489cce6039079ca587c42de7e',
  files: Object.freeze(['regent_chongqing.png', 'SIN_TFU_SQ.png', 'TFU_SIN_SQ.png', 'TFURZ_Chengdu.png']),
  bookings: Object.freeze([
    Object.freeze({ id: 'bac15cc05452c30e7c556a1fb4ee730c', title: 'Regent Chongqing', filePositions: [0] }),
    Object.freeze({ id: '02c2b872948b5bc70e7a2fce3a40233d', title: 'The Ritz-Carlton, Chengdu', filePositions: [3] }),
    Object.freeze({ id: '5cba008a8b853e463bda2217ec209570', title: 'SQ 842', filePositions: [1] }),
    Object.freeze({ id: 'a22fd68b76081dd028ad3aef0f1932b4', title: 'SQ 843', filePositions: [2] }),
  ]),
});

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

function stateOf(current, wanted, where) {
  if (current === undefined) return 'set';
  if (sameList(current, wanted)) return 'already correct';
  throw new Error(`${where} already has filePositions ${JSON.stringify(current)}, expected ${JSON.stringify(wanted)} — refusing`);
}

// Checks every precondition and returns the rows to write; throws, naming the mismatch, on any surprise.
export function planRepair(db, repair = CHENGDU_REPAIR) {
  const artifact = db.prepare('SELECT id, extracted_json FROM import_artifacts WHERE id = ?').get(repair.artifactId);
  if (!artifact) throw new Error(`artifact ${repair.artifactId} not found`);

  const files = db.prepare('SELECT position, filename FROM import_artifact_files WHERE artifact_id = ? ORDER BY position')
    .all(repair.artifactId);
  if (!sameList(files.map((f) => f.filename), repair.files) || !files.every((f, i) => f.position === i)) {
    throw new Error(`artifact files are ${JSON.stringify(files)}, expected ${JSON.stringify(repair.files)}`);
  }

  const extraction = JSON.parse(artifact.extracted_json || 'null');
  if (!extraction || !Array.isArray(extraction.bookings)) throw new Error('artifact has no stored extraction');

  const lines = [];
  const bookingWrites = [];
  for (const target of repair.bookings) {
    const row = db.prepare('SELECT id, title, details_json FROM bookings WHERE id = ?').get(target.id);
    if (!row) throw new Error(`booking ${target.id} (${target.title}) not found`);
    if (row.title !== target.title) throw new Error(`booking ${target.id} is titled "${row.title}", expected "${target.title}"`);
    const details = JSON.parse(row.details_json || '{}');
    if (details.importedFrom?.artifactId !== repair.artifactId) {
      throw new Error(`booking ${target.id} is not linked to artifact ${repair.artifactId}`);
    }
    const state = stateOf(details.importedFrom.filePositions, target.filePositions, `booking ${target.id}`);
    if (state === 'set') {
      details.importedFrom = { ...details.importedFrom, filePositions: [...target.filePositions] };
      bookingWrites.push({ id: row.id, detailsJson: JSON.stringify(details) });
    }

    const stored = extraction.bookings.filter((b) => b.title === target.title);
    if (stored.length !== 1) throw new Error(`stored extraction has ${stored.length} bookings titled "${target.title}", expected 1`);
    const storedState = stateOf(stored[0].detailsJson?.importedFrom?.filePositions, target.filePositions, `stored extraction "${target.title}"`);
    if (storedState === 'set') {
      stored[0].detailsJson = {
        ...stored[0].detailsJson,
        importedFrom: { ...stored[0].detailsJson?.importedFrom, filePositions: [...target.filePositions] },
      };
    }

    const names = target.filePositions.map((p) => repair.files[p]).join(', ');
    lines.push(`${target.title} -> ${names}  (booking: ${state}; stored extraction: ${storedState})`);
  }

  const extractionChanged = JSON.stringify(extraction) !== artifact.extracted_json;
  return { lines, bookingWrites, extractedJson: extractionChanged ? JSON.stringify(extraction) : null };
}

export function applyRepair(db, plan, artifactId = CHENGDU_REPAIR.artifactId) {
  db.transaction(() => {
    const update = db.prepare('UPDATE bookings SET details_json = ? WHERE id = ?');
    for (const w of plan.bookingWrites) update.run(w.detailsJson, w.id);
    if (plan.extractedJson) {
      db.prepare('UPDATE import_artifacts SET extracted_json = ? WHERE id = ?').run(plan.extractedJson, artifactId);
    }
  })();
}

function main() {
  const apply = process.argv.includes('--apply');
  initDb(config.dbPath);
  const db = getDb();
  const plan = planRepair(db);
  for (const line of plan.lines) console.log(`  ${line}`);
  const pending = plan.bookingWrites.length + (plan.extractedJson ? 1 : 0);
  if (pending === 0) {
    console.log('[importFileProvenanceRepair] already correct; nothing to write.');
  } else if (apply) {
    applyRepair(db, plan);
    console.log(`[importFileProvenanceRepair] wrote ${plan.bookingWrites.length} booking(s)${plan.extractedJson ? ' and the stored extraction' : ''}.`);
  } else {
    console.log('[importFileProvenanceRepair] dry run: no writes made. Re-run with --apply to write.');
  }
}

// Windows-safe entry-point check (see refetchCjkBookingEvidence.js).
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    main();
  } catch (err) {
    console.error('[importFileProvenanceRepair] fatal error:', err.message);
    process.exit(1);
  }
}
