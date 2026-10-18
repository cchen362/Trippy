// Plan 30 W3 — one real discovery generation through the HTTP route, on a COPY of the dev DB.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/discoveryRouteCheck.mjs
//     [--destination Tainan] [--country TW] [--keep-db]
//
// What it proves, after a DISCOVERY_MODEL switch, that the mocked suite cannot:
//   * the real route (POST /api/trips/:tripId/discover) streams per-category SSE events, with the
//     8 s {type:'thinking'} ping interleaved, and ends with {type:'done'};
//   * runCatalogueGeneration persists the rows with provenance 'pending', bumps generation_count,
//     and the verification queue drains them under the in-process resolver budgets.
//
// D-30-7: the generation WRITES — it must, to exercise insert/enqueue — so it writes only to the
// copy (lib/dbCopy.mjs makeCopy + initDb(copy); DB_PATH is never used). The copy is deleted at the
// end unless --keep-db. The owner DB is opened read-only for counts at start and end, and the
// script exits 1 if they moved. The auth session is minted inside the copy for the copy's first
// trip owner, so no real login or cookie is involved. The destination must not already exist in
// the copy, so the run is a true cache miss (first generation).

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { getDb } from '../../src/db/database.js';
import discoveryRoutes from '../../src/routes/discovery.js';
import { findDestination } from '../../src/db/discoveryCatalogue.js';
import { getDiscoveryBudgetStatus, waitForVerificationDrain } from '../../src/services/discoveryVerify.js';
import { profileFor } from '../../src/services/claude.js';
import { canonicalGeoKey } from '../../src/utils/geoIdentity.js';
import { assertUnchanged, countOwner, makeCopy } from './lib/dbCopy.mjs';

function parseOptions(argv) {
  const options = { destination: 'Tainan', country: 'TW', keepDb: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--destination') options.destination = argv[++i];
    else if (a === '--country') options.country = argv[++i];
    else if (a === '--keep-db') options.keepDb = true;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!options.destination || !/^[A-Z]{2}$/.test(options.country ?? '')) {
    throw new Error('--destination needs a value and --country a 2-letter uppercase code');
  }
  return options;
}

// Reads an SSE response body and returns every data event with its arrival time.
async function readSse(response, startedAt) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line) events.push({ t: Date.now() - startedAt, ...JSON.parse(line.slice(6)) });
    }
  }
  return events;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.log(`live discovery profile: ${JSON.stringify(profileFor('discovery'))}`);

  const handle = await makeCopy('discovery-route');
  const db = getDb();
  const cityKey = canonicalGeoKey(options.destination);
  let server = null;
  try {
    if (findDestination(db, cityKey, options.country)) {
      throw new Error(`${cityKey}|${options.country} already exists in the copy — pick a destination the dev catalogue does not hold`);
    }
    const trip = db.prepare('SELECT id, owner_id FROM trips ORDER BY created_at LIMIT 1').get();
    if (!trip) throw new Error('the dev DB copy has no trip to run the route under');
    const token = randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO auth_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))`)
      .run(randomBytes(16).toString('hex'), trip.owner_id, token);

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/trips', discoveryRoutes);
    app.use((err, req, res, next) => {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message });
    });
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/trips/${trip.id}/discover`;

    const budgetBefore = getDiscoveryBudgetStatus();
    console.log(`POST ${url.replace(/\/[0-9a-f]{32}\//, '/<trip>/')}  destination=${options.destination} countryCode=${options.country}`);
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `auth_token=${token}` },
      body: JSON.stringify({ destination: options.destination, countryCode: options.country }),
    });
    if (!response.ok) throw new Error(`route answered HTTP ${response.status}: ${await response.text()}`);
    const events = await readSse(response, startedAt);

    console.log('\nSSE timeline (s  event):');
    for (const e of events) {
      const detail = e.type === 'category' ? ` ${e.category} items=${e.items.length}` : (e.type === 'error' ? ` ${e.message}` : '');
      console.log(`  ${(e.t / 1000).toFixed(1).padStart(6)}  ${e.type}${detail}`);
    }
    const categories = events.filter((e) => e.type === 'category');
    const pings = events.filter((e) => e.type === 'thinking');
    const firstCategory = categories[0]?.t ?? null;
    const pingsBetween = pings.filter((p) => firstCategory !== null && p.t > firstCategory && p.t < categories.at(-1).t).length;
    console.log(`\ncategories streamed ${categories.length}, items ${categories.reduce((n, c) => n + c.items.length, 0)}, ` +
      `pings ${pings.length} (${pings.filter((p) => firstCategory === null || p.t < firstCategory).length} before the first category, ${pingsBetween} between categories), ` +
      `last event ${events.at(-1)?.type}`);

    const destination = findDestination(db, cityKey, options.country);
    const provenanceAfterInsert = destination
      ? db.prepare('SELECT provenance, COUNT(*) AS n FROM discovery_places WHERE destination_id = ? GROUP BY provenance').all(destination.id)
      : [];
    console.log(`destination row: ${destination ? `generation_count=${destination.generation_count}, last_generated_at=${destination.last_generated_at}` : 'MISSING'}`);
    console.log(`provenance right after the stream: ${JSON.stringify(provenanceAfterInsert)}`);

    if (destination) {
      console.log('waiting for the verification queue to drain…');
      await waitForVerificationDrain(destination.id);
      const after = db.prepare('SELECT provenance, status, COUNT(*) AS n FROM discovery_places WHERE destination_id = ? GROUP BY provenance, status').all(destination.id);
      console.log(`after drain (provenance, status): ${JSON.stringify(after)}`);
    }
    const budgetAfter = getDiscoveryBudgetStatus();
    console.log(`budget before: ${JSON.stringify(budgetBefore)}`);
    console.log(`budget after:  ${JSON.stringify(budgetAfter)}`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const ownerEnd = countOwner();
    console.log(`\nowner db counts at start: ${JSON.stringify(handle.ownerStart)}`);
    db.close();
    if (!options.keepDb) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${handle.path}${suffix}`, { force: true });
      console.log(`deleted the copy ${handle.path}`);
    } else {
      console.log(`kept the copy ${handle.path}`);
    }
    if (!assertUnchanged(handle.ownerStart, ownerEnd, 'owner db (readonly counts, start vs end)').ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
