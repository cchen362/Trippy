// Plan 30 W0 — co-pilot evaluation harness.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/copilot.mjs --profile control
//     [--only id,id] [--concurrency 2] [--max-usd 10] [--limit n] [--dry-run] [--keep-db]
//
// Runs the 20 scenarios in fixtures/copilot/scenarios.json through the real
// streamCopilotResponse(conversation, itineraryContext, res, req, persistTurn, toolExecutors,
// reportTurnMetrics, profile) with the real tool executors, against two synthetic trips seeded into
// a backup-API COPY of the dev DB. `res` is a recording fake (every SSE write is stored with a
// timestamp), persistTurn is NOT passed (so the service emits the operations-only proposal event and
// nothing is persisted), and reportTurnMetrics only captures the summary.
//
// D-30-7, and what makes it hold here
// -----------------------------------
// Anything that resolves to a stale, uncapped, in-scope destination makes searchDiscoveryCatalogue
// fire runCatalogueGeneration — a real Haiku call, catalogue inserts and Nominatim traffic. Setup
// therefore makes that impossible BEFORE the "before" counts are taken, in the copy only:
//   * shanghai|CN, hangzhou|CN, taipei|TW get last_generated_at = datetime('now')  -> 'fresh'
//   * kaohsiung|TW stays stale and gets today's discovery_generation_daily count set to
//     MAX_GENERATIONS_PER_DESTINATION_PER_DAY                                          -> 'generation_capped'
// assertNoKickPossible() then re-derives the state of every scope of both trips exactly as
// searchDiscoveryCatalogue does and throws unless each is 'fresh' or 'generation_capped'. A search
// for a destination not on the trip is 'out_of_scope' (no catalogue read at all). The 'generating'
// state therefore cannot be exercised without breaking D-30-7 and is deliberately not covered.
// The count table at the end (and the owner db counts) prove nothing moved.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../../src/db/database.js';
import {
  MAX_GENERATIONS_PER_DESTINATION_PER_DAY, CACHE_TTL_MS, cacheTimestampToEpochMs,
  findDestination, getDailyGenerationCount, listActivePlaces, listCountryCodedRows,
} from '../../src/db/discoveryCatalogue.js';
import { streamCopilotResponse } from '../../src/services/claude.js';
import { copilotTripContext } from '../../src/services/copilotTools.js';
import { searchDiscoveryCatalogue } from '../../src/services/copilotGrounding.js';
import { validateProposalOperations } from '../../src/services/copilotProposals.js';
import { runTripHealthChecks } from '../../src/services/tripHealth.js';
import { buildTripScopes, createTrip, getTripDetail, listTripScopes } from '../../src/services/trips.js';
import { scopesMatch } from '../../src/utils/geoIdentity.js';
import { assertControlIsLive, getProfile, toServiceProfile } from './profiles.mjs';
import { installRecorder, recordFixture } from './lib/recorder.mjs';
import {
  FIXTURES_DIR, buildRecord, filterItems, openRunFile, parseArgs, printProgress, runPool,
} from './lib/runner.mjs';
import { countSideEffects, finishSideEffectCheck, makeCopy } from './lib/dbCopy.mjs';

const SYNTHETIC_USER = {
  username: 'model-eval-user',
  passwordHash: 'model-eval-no-login', // a fixed non-secret string: this account can never log in
  displayName: 'Model Eval',
};

// Destinations the scenarios search, and the catalogue state each must be in (see header).
const FRESH_DESTINATIONS = [['shanghai', 'CN'], ['hangzhou', 'CN'], ['taipei', 'TW']];
const CAPPED_DESTINATION = ['kaohsiung', 'TW'];
const EXPECTED_STATE = {
  'shanghai|CN': 'fresh',
  'hangzhou|CN': 'fresh',
  'taipei|TW': 'fresh',
  'kaohsiung|TW': 'generation_capped',
};

// ---------------------------------------------------------------------------------------------
// Setup (runs in the copy, before the "before" counts)
// ---------------------------------------------------------------------------------------------

function prepareCatalogueState(db) {
  const makeFresh = db.prepare(
    "UPDATE discovery_destinations SET last_generated_at = datetime('now') WHERE city_key = ? AND country_code = ?",
  );
  for (const [cityKey, countryCode] of FRESH_DESTINATIONS) {
    if (makeFresh.run(cityKey, countryCode).changes !== 1) {
      throw new Error(`setup: no discovery_destinations row for ${cityKey}|${countryCode} in the dev DB copy`);
    }
  }

  const capped = findDestination(db, CAPPED_DESTINATION[0], CAPPED_DESTINATION[1]);
  if (!capped) throw new Error('setup: no discovery_destinations row for kaohsiung|TW in the dev DB copy');
  db.prepare(`
    INSERT INTO discovery_generation_daily (destination_id, utc_date, count)
    VALUES (?, strftime('%Y-%m-%d', 'now'), ?)
    ON CONFLICT(destination_id, utc_date) DO UPDATE SET count = excluded.count
  `).run(capped.id, MAX_GENERATIONS_PER_DESTINATION_PER_DAY);
}

const deterministicId = (...parts) => createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);

// Mirrors services/stops.js inferBookingStop (not exported): what the booking-linked stop of a
// hotel or train booking carries, so the seeded stop is the one the real sync would have written.
function bookingStopFields(booking) {
  const [datePart, timePart] = booking.startDatetime.split('T');
  if (booking.type === 'hotel') {
    return {
      date: datePart,
      time: timePart ? timePart.slice(0, 5) : '15:00',
      title: booking.title,
      type: 'hotel',
      note: [booking.bookingSource, booking.confirmationRef].filter(Boolean).join(' • ') || null,
      isFeatured: 1,
    };
  }
  return {
    date: datePart,
    time: timePart.slice(0, 5),
    title: booking.title,
    type: 'transit',
    note: [booking.origin, booking.destination, booking.confirmationRef].filter(Boolean).join(' • ') || null,
    isFeatured: booking.type === 'flight' ? 1 : 0,
  };
}

function seedUser(db) {
  return db.prepare(
    'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, 0) RETURNING id',
  ).get(SYNTHETIC_USER.username, SYNTHETIC_USER.passwordHash, SYNTHETIC_USER.displayName).id;
}

// Creates one trip through the real createTrip(), then writes day cities, bookings and stops with
// parameterised SQL. Returns the ids the scorer needs.
function seedTrip(db, userId, key, spec) {
  const created = createTrip(userId, {
    title: spec.title,
    startDate: spec.startDate,
    endDate: spec.endDate,
    travellers: spec.travellers,
    pace: spec.pace,
    interestTags: spec.interestTags,
    destinations: spec.destinations,
  });
  const tripId = created.trip.id;
  const dayRows = created.days; // ordered by date, one per night of the range

  const dayIds = [];
  const stopIds = [];
  const bookingLinkedStopIds = [];
  const stopTitleById = {};

  db.transaction(() => {
    // Day ids are rewritten before any stop exists (no child rows, so the primary-key update is
    // safe) so the itinerary JSON in the system prompt is identical on every run.
    for (const cityDay of spec.dayCities) {
      const row = dayRows[cityDay.day - 1];
      const id = deterministicId(key, 'day', cityDay.day);
      db.prepare('UPDATE days SET id = ?, city = ?, city_country = ? WHERE id = ?')
        .run(id, cityDay.city, cityDay.countryCode, row.id);
      dayIds.push(id);
    }

    const insertBooking = db.prepare(`
      INSERT INTO bookings (
        id, trip_id, type, title, confirmation_ref, booking_source, start_datetime, end_datetime,
        origin, destination, details_json, show_in_itinerary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const bookingIds = {};
    for (const [bookingKey, booking] of Object.entries(spec.bookings)) {
      const id = deterministicId(key, 'booking', bookingKey);
      insertBooking.run(
        id, tripId, booking.type, booking.title, booking.confirmationRef, booking.bookingSource,
        booking.startDatetime, booking.endDatetime, booking.origin, booking.destination,
        JSON.stringify(booking.detailsJson ?? {}),
      );
      bookingIds[bookingKey] = id;
    }

    const insertStop = db.prepare(`
      INSERT INTO stops (
        id, day_id, booking_id, time, title, type, note, lat, lng, booking_required, best_time,
        duration, sort_order, is_featured, location_query, coordinate_system, location_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const daySpec of spec.days) {
      daySpec.stops.forEach((stop, index) => {
        const id = deterministicId(key, 'stop', daySpec.day, index);
        const dayId = dayIds[daySpec.day - 1];
        if (stop.booking) {
          const booking = spec.bookings[stop.booking];
          const fields = bookingStopFields(booking);
          const expectedDay = dayRows.findIndex((row) => row.date === fields.date) + 1;
          if (expectedDay !== daySpec.day) {
            throw new Error(`fixture ${key}: booking ${stop.booking} starts on day ${expectedDay}, listed under day ${daySpec.day}`);
          }
          insertStop.run(
            id, dayId, bookingIds[stop.booking], fields.time, fields.title, fields.type, fields.note,
            null, null, 1, null, null, index + 1, fields.isFeatured, fields.title, 'unknown', 'user_confirmed',
          );
          bookingLinkedStopIds.push(id);
          stopTitleById[id] = fields.title;
        } else {
          const hasCoordinates = stop.lat != null && stop.lng != null;
          insertStop.run(
            id, dayId, null, stop.time ?? null, stop.title, stop.type, stop.note ?? null,
            stop.lat ?? null, stop.lng ?? null, 0, stop.bestTime ?? null, stop.duration ?? null, index + 1, 0,
            stop.title, hasCoordinates ? 'wgs84' : 'unknown',
            stop.locationStatus ?? (hasCoordinates ? 'resolved' : 'unresolved'),
          );
          stopTitleById[id] = stop.title;
        }
        stopIds.push(id);
      });
    }
  })();

  return { key, tripId, dayIds, stopIds, bookingLinkedStopIds, stopTitleById };
}

// ---------------------------------------------------------------------------------------------
// D-30-7 guard: no search in this harness may start a background generation
// ---------------------------------------------------------------------------------------------

// Re-derives, for each scope of the trip, the state searchDiscoveryCatalogue would compute — the
// same resolution (stored scope -> country -> findDestination -> freshness -> daily cap), without
// calling it — and throws unless every scope lands on 'fresh' or 'generation_capped'.
function assertNoKickPossible(db, tripDetail) {
  const storedScopes = listTripScopes(tripDetail.trip.id);
  const scopes = buildTripScopes(tripDetail.days, storedScopes);
  const states = [];

  for (const scope of scopes) {
    const stored = storedScopes.find((s) => s.canonicalKey === scope.canonicalKey);
    let countryCode = stored?.countryCode ?? '';
    if (countryCode === '') {
      const coded = listCountryCodedRows(db, scope.canonicalKey);
      if (coded.length === 1) countryCode = coded[0].country_code;
    }
    const row = findDestination(db, scope.canonicalKey, countryCode);
    let state = 'generating';
    if (row) {
      const active = listActivePlaces(db, row.id);
      const lastMs = cacheTimestampToEpochMs(row.last_generated_at);
      const fresh = active.length > 0 && lastMs !== null && (Date.now() - lastMs) < CACHE_TTL_MS;
      if (fresh) state = 'fresh';
      else if (getDailyGenerationCount(db, row.id) >= MAX_GENERATIONS_PER_DESTINATION_PER_DAY) state = 'generation_capped';
    }
    const key = `${scope.canonicalKey}|${countryCode}`;
    states.push({ key, state });
    if (state === 'generating') {
      throw new Error(`D-30-7: scope ${key} of trip "${tripDetail.trip.title}" would fire a background generation — the setup must make it fresh or capped`);
    }
    if (EXPECTED_STATE[key] && EXPECTED_STATE[key] !== state) {
      throw new Error(`setup: scope ${key} resolves to '${state}', expected '${EXPECTED_STATE[key]}'`);
    }
  }
  return states;
}

// ---------------------------------------------------------------------------------------------
// Conversation construction
// ---------------------------------------------------------------------------------------------

// Mirrors routes/copilot.js resolveMessageContext + contextLine (neither is exported): the
// '[Viewing: ...]' prefix a stored message context turns into when the route rebuilds history.
function viewLine(view, tripDetail) {
  const tabLabel = view.tab[0].toUpperCase() + view.tab.slice(1);
  const parts = [`${tabLabel} tab`];
  if (view.day) {
    const day = tripDetail.days[view.day - 1];
    if (!day) throw new Error(`view references day ${view.day}, trip has ${tripDetail.days.length}`);
    const city = day.resolvedCity ?? day.city ?? null;
    parts.push(`Day ${view.day}${city ? ` (${city})` : ''}`);
  }
  if (view.stop) parts.push(`stop "${view.stop}"`);
  return `[Viewing: ${parts.join(', ')}]`;
}

const FILLER_SUBJECTS = [
  'the MRT and EasyCard', 'rain gear in May', 'bubble tea', 'tipping customs', 'carrying cash',
  'SIM cards and eSIMs', 'the weather in early May', 'what to pack', 'convenience store breakfasts',
  'hot springs', 'sunscreen and heat', 'night market etiquette', 'luggage storage at stations',
  'how early to reach the high-speed rail station', 'a few Mandarin phrases', 'power adapters',
  'tap water', 'allergies and menus', 'offline maps', 'travel insurance', 'jet lag', 'taxi apps',
  'souvenir shopping',
];
const FILLER_ANSWERS = [
  (s) => `Short answer on ${s}: it is easy to sort out on the day, so I would not build the itinerary around it. A quick check before you leave is plenty.`,
  (s) => `On ${s}, most travellers find it simpler than expected. Keep it flexible and ask locally if something looks unclear.`,
  (s) => `Worth a minute of thought: ${s}. Nothing in your current plan needs to change for it, so just keep it in mind.`,
];

// Deterministic filler so the long-thread scenario never depends on 46 hand-written entries:
// `count` messages, alternating user / assistant, starting with the traveller.
function generateFiller(count) {
  const messages = [];
  for (let i = 0; i < count / 2; i += 1) {
    const subject = FILLER_SUBJECTS[i % FILLER_SUBJECTS.length];
    messages.push({ role: 'user', content: `Quick question about ${subject}: is it worth planning around on this trip?` });
    messages.push({ role: 'assistant', content: FILLER_ANSWERS[i % FILLER_ANSWERS.length](subject) });
  }
  return messages;
}

function buildConversation(scenario, tripDetail) {
  const messages = scenario.longThread ? generateFiller(scenario.longThread) : [];
  for (const m of scenario.messages) {
    messages.push({ role: m.role, content: m.view ? `${viewLine(m.view, tripDetail)}\n\n${m.content}` : m.content });
  }
  return messages;
}

// ---------------------------------------------------------------------------------------------
// Fakes and one scenario run
// ---------------------------------------------------------------------------------------------

class RecordingResponse extends EventEmitter {
  constructor({ turnStart, abortAfterFirstText }) {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.headers = {};
    this.events = [];
    this.turnStart = turnStart;
    this.abortAfterFirstText = abortAfterFirstText;
    this.sawText = false;
  }

  setHeader(name, value) { this.headers[name] = value; }

  flushHeaders() { this.headersFlushedAt = Date.now() - this.turnStart; }

  write(chunk) {
    const line = String(chunk).split('\n').find((l) => l.startsWith('data: '));
    if (!line) return true;
    const event = JSON.parse(line.slice('data: '.length));
    this.events.push({ t: Date.now() - this.turnStart, event });
    if (event.type === 'text' && this.abortAfterFirstText && !this.sawText) {
      this.sawText = true;
      this.destroyed = true;
      this.emit('close');
    }
    return true;
  }

  end() { this.writableEnded = true; }
}

// The Plan 11 sanitize step defaults a missing move_stop position; validate with the same default.
function validateForRecord(operations, tripId) {
  const withDefaults = operations.map((op) => (
    op && op.action === 'move_stop' && !Number.isInteger(op.position) ? { ...op, position: 0 } : op
  ));
  return validateProposalOperations(withDefaults, tripId);
}

async function runScenario(scenario, { profile, profileName, seeded, userId }) {
  const seed = seeded[scenario.trip];
  const tripDetail = getTripDetail(seed.tripId, userId);
  const itineraryContext = copilotTripContext(tripDetail);
  const conversation = buildConversation(scenario, tripDetail);

  const toolCalls = [];
  const wrap = (name, run) => async (input) => {
    const startedAt = Date.now();
    const result = await run(input);
    toolCalls.push({ name, input, result, ms: Date.now() - startedAt });
    return result;
  };
  const toolExecutors = {
    search_discovery_catalogue: wrap('search_discovery_catalogue', (input) => searchDiscoveryCatalogue(tripDetail, input)),
    check_trip_health: wrap('check_trip_health', (input) => ({ findings: runTripHealthChecks(tripDetail, input || {}) })),
  };

  let metrics = null;
  const reportTurnMetrics = async (summary) => { metrics = summary; };

  let res;
  let fullText = '';
  const recorded = await recordFixture(async () => {
    res = new RecordingResponse({ turnStart: Date.now(), abortAfterFirstText: Boolean(scenario.abortAfterFirstText) });
    const req = new EventEmitter();
    fullText = await streamCopilotResponse(
      conversation, itineraryContext, res, req, undefined, toolExecutors, reportTurnMetrics, toServiceProfile(profile),
    );
    return fullText;
  });

  const events = res.events;
  const proposalEvent = events.find((e) => e.event.type === 'proposal');
  const validation = proposalEvent ? validateForRecord(proposalEvent.event.operations, seed.tripId) : null;

  return buildRecord({
    workload: 'copilot',
    profileName,
    profile,
    fixtureId: scenario.id,
    variant: null,
    recorded,
    output: { events, toolCalls, metrics, fullText, validation },
    extra: {
      scenarioId: scenario.id,
      trip: scenario.trip,
      description: scenario.description,
      expect: scenario.expect,
      abortAfterFirstText: Boolean(scenario.abortAfterFirstText),
      messageCount: conversation.length,
      contextChars: JSON.stringify(itineraryContext).length,
      seed: {
        dayIds: seed.dayIds,
        stopIds: seed.stopIds,
        bookingLinkedStopIds: seed.bookingLinkedStopIds,
        stopTitleById: seed.stopTitleById,
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Dry run: everything except the paid call
// ---------------------------------------------------------------------------------------------

function dryRun({ scenarios, seeded, userId, db }) {
  console.log('\nSeeded trips (in the copy):');
  for (const key of Object.keys(seeded)) {
    const detail = getTripDetail(seeded[key].tripId, userId);
    const context = copilotTripContext(detail);
    const contextChars = JSON.stringify(context, null, 2).length;
    console.log(
      `  trip ${key} "${detail.trip.title}" ${detail.trip.startDate}..${detail.trip.endDate}: ${detail.days.length} days, ` +
      `${seeded[key].stopIds.length} stops (${seeded[key].bookingLinkedStopIds.length} booking-linked), ${detail.bookings.length} bookings, ` +
      `scopes [${listTripScopes(seeded[key].tripId).map((s) => `${s.label}|${s.countryCode}`).join(', ')}]; ` +
      `itinerary context ${contextChars} chars (~${Math.round(contextChars / 3.5)} tokens)`,
    );
    console.log(`    day cities: ${detail.days.map((d, i) => `${i + 1}=${d.resolvedCity}`).join(', ')}`);
    console.log(`    scope states: ${assertNoKickPossible(db, detail).map((s) => `${s.key}=${s.state}`).join(', ')}`);
  }

  console.log('\nScenarios:');
  for (const scenario of scenarios) {
    const tripDetail = getTripDetail(seeded[scenario.trip].tripId, userId);
    const conversation = buildConversation(scenario, tripDetail);
    const e = scenario.expect;
    console.log(
      `  ${scenario.id.padEnd(30)} trip ${scenario.trip}  messages=${String(conversation.length).padStart(2)}  ` +
      `proposes=${e.proposes}  tools=[${e.tools.join(', ')}] (${e.toolsMode})${scenario.abortAfterFirstText ? '  ABORT' : ''}`,
    );
  }

  // Free executor probes (no model call): prove the setup yields fresh / capped / out_of_scope and
  // that no probe starts a generation. The count table printed afterwards must be unchanged.
  return (async () => {
    const probes = [['A', 'Shanghai'], ['A', 'Hangzhou'], ['A', 'Suzhou'], ['B', 'Taipei'], ['B', 'Kaohsiung']];
    console.log('\nExecutor probes (real searchDiscoveryCatalogue, no model call):');
    for (const [key, destination] of probes) {
      const detail = getTripDetail(seeded[key].tripId, userId);
      const result = await searchDiscoveryCatalogue(detail, { destination });
      console.log(`  trip ${key} search "${destination}" -> ${result.catalogueState}, ${result.places.length} places`);
    }
    for (const [key, input] of [['A', {}], ['A', { dayId: seeded.A.dayIds[2] }], ['B', {}]]) {
      const detail = getTripDetail(seeded[key].tripId, userId);
      const findings = runTripHealthChecks(detail, input);
      console.log(`  trip ${key} check_trip_health ${JSON.stringify(input) === '{}' ? 'whole trip' : 'day 3'} -> ${findings.length} findings (${[...new Set(findings.map((f) => f.check))].join(', ')})`);
    }
  })();
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!process.argv.includes('--concurrency')) args.concurrency = 2;
  const isDryRun = args.flags.has('dry-run');
  const keepDb = args.flags.has('keep-db');

  const profile = getProfile('copilot', args.profile);
  if (args.profile === 'control') assertControlIsLive('copilot');

  const trips = JSON.parse(readFileSync(join(FIXTURES_DIR, 'copilot', 'trips.json'), 'utf8')).trips;
  const allScenarios = JSON.parse(readFileSync(join(FIXTURES_DIR, 'copilot', 'scenarios.json'), 'utf8')).scenarios;
  if (allScenarios.length !== 20) throw new Error(`expected exactly 20 scenarios, found ${allScenarios.length}`);
  const scenarios = filterItems(allScenarios, args);

  const handle = await makeCopy('copilot');
  let before = null;
  let runPath = null;
  try {
    const db = getDb();
    prepareCatalogueState(db);
    const userId = seedUser(db);
    const seeded = {};
    for (const [key, spec] of Object.entries(trips)) seeded[key] = seedTrip(db, userId, key, spec);
    for (const key of Object.keys(seeded)) assertNoKickPossible(db, getTripDetail(seeded[key].tripId, userId));

    before = countSideEffects(db);
    console.log(`working copy: ${handle.path}`);
    console.log(`profile ${args.profile}: ${JSON.stringify(toServiceProfile(profile))}`);
    console.log(`${scenarios.length} scenario(s)${isDryRun ? ' (dry run, no API call)' : ''}`);

    if (isDryRun) {
      await dryRun({ scenarios, seeded, userId, db });
    } else if (scenarios.length) {
      installRecorder();
      const run = openRunFile('copilot', args.profile);
      runPath = run.path;
      console.log(`run file: ${run.path}`);

      const summary = await runPool(scenarios, async (scenario) => {
        const record = await runScenario(scenario, { profile, profileName: args.profile, seeded, userId });
        run.write(record);
        return record;
      }, { concurrency: args.concurrency, maxUsd: args.maxUsd, onRecord: printProgress });

      console.log(`\ndone ${summary.done}/${summary.total}, spent $${summary.spent.toFixed(4)}${summary.stopped ? ` — STOPPED: ${summary.stopped}` : ''}`);
      if (summary.stopped) process.exitCode = 1;
    }
  } finally {
    // before is null only if setup threw before the first count; then there is nothing to compare.
    if (before) finishSideEffectCheck({ workload: 'copilot', handle, before, runPath, keep: keepDb });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
