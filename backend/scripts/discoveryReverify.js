// Plan 26 W3.3/W3.4: the operator entry point for bounded re-verification of
// terminal `unverified` discovery_places rows (F-26-12). enqueueForVerification
// only ever re-collects provenance='pending' rows, so a row that WAS checked
// and failed never gets another attempt any other way — this script is the
// deliberate, must-be-invoked path that drives enqueueForReverification and
// is how W3.4's measurement gets taken.
//
// This script is NOT wired into any request path and never will be —
// repairing the corpus at scale is a separate owner decision (see the plan's
// W3.4 section). Running it is always an explicit, manual operator action.
//
// Usage (run from backend/):
//   node scripts/discoveryReverify.js                          (all destinations, respects caps)
//   node scripts/discoveryReverify.js --destination=<id>        (one destination only)
//   node scripts/discoveryReverify.js --limit=N                 (cap rows enqueued, per destination)
//   node scripts/discoveryReverify.js --dry-run                 (prints what would run, no provider calls, no writes)
//
// --dry-run touches no provider and writes nothing: it prints, per
// destination, how many terminal-unverified rows exist and how many the caps
// (discoveryReverifyPerDestinationDaily, discoveryReverifyDailyRequestBudget)
// would actually admit today.
//
// A live run drives enqueueForReverification, awaits the drain, then prints a
// per-reason/per-provider/per-source-field summary read back from
// discovery_verification_attempts, plus the budget readout before and after.

import { pathToFileURL } from 'url';
import { config } from '../src/config.js';
import { initDb, getDb } from '../src/db/database.js';
import { listVerificationAttempts } from '../src/db/discoveryCatalogue.js';
import {
  enqueueForReverification,
  waitForVerificationDrain,
  getDiscoveryBudgetStatus,
} from '../src/services/discoveryVerify.js';

function parseArgs(argv) {
  const args = { destination: null, limit: null, dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--destination=')) args.destination = Number(arg.slice('--destination='.length));
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length));
  }
  return args;
}

function listTargetDestinations(db, destinationId) {
  if (destinationId != null) {
    const row = db.prepare('SELECT * FROM discovery_destinations WHERE id = ?').get(destinationId);
    return row ? [row] : [];
  }
  return db.prepare('SELECT * FROM discovery_destinations ORDER BY id').all();
}

function countTerminalUnverified(db, destinationId) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM discovery_places WHERE destination_id = ? AND status = 'active' AND provenance = 'unverified'`,
  ).get(destinationId).c;
}

function printBudgetStatus(label) {
  const status = getDiscoveryBudgetStatus();
  console.log(
    `[discoveryReverify] ${label} — date=${status.date} ` +
    `resolverRequests=${status.resolverRequests.used}/${status.resolverRequests.budget} ` +
    `escalationRequests=${status.escalationRequests.used}/${status.escalationRequests.budget} ` +
    `reverifyRequests=${status.reverifyRequests.used}/${status.reverifyRequests.budget}`,
  );
}

async function runDryRun(db, destinations, limit) {
  console.log(`[discoveryReverify] DRY RUN — ${destinations.length} destination(s) considered, no provider calls, no writes:\n`);

  let totalTerminal = 0;
  for (const destination of destinations) {
    const terminalCount = countTerminalUnverified(db, destination.id);
    totalTerminal += terminalCount;
    const admissible = Math.min(
      terminalCount,
      config.discoveryReverifyPerDestinationDaily,
      typeof limit === 'number' ? limit : Infinity,
    );
    console.log(
      `  destination_id=${destination.id} city_key=${destination.city_key} display_name=${destination.display_name} ` +
      `terminal_unverified=${terminalCount} would_admit<=${admissible} (per-destination cap=${config.discoveryReverifyPerDestinationDaily})`,
    );
  }

  console.log(`\n[discoveryReverify] totals: ${totalTerminal} terminal-unverified row(s) across ${destinations.length} destination(s).`);
  printBudgetStatus('current budget (unspent by this dry run)');
  console.log('\n[discoveryReverify] no network calls made, no writes made. Re-run without --dry-run to actually re-verify.');
}

function summarizeAttempts(attempts) {
  const byReason = new Map();
  const byProvider = new Map();
  const bySourceField = new Map();
  const byVariantKind = new Map(); // 'original' | 'alias_or_stripped'

  for (const attempt of attempts) {
    byReason.set(attempt.reason, (byReason.get(attempt.reason) || 0) + 1);
    const providerKey = attempt.provider || '(none)';
    byProvider.set(providerKey, (byProvider.get(providerKey) || 0) + 1);
    bySourceField.set(attempt.source_field, (bySourceField.get(attempt.source_field) || 0) + 1);

    if (attempt.outcome === 'verified') {
      // A bracketed/aliased query variant differs from the plain catalogue
      // name whenever it contains a paren or doesn't equal the source field's
      // stored value outright — used only for this script's descriptive
      // summary, not for any persisted decision.
      const isStrippedOrAlias = attempt.query_variant && /[()]/.test(attempt.query_variant);
      const kind = isStrippedOrAlias ? 'alias_or_stripped_variant' : 'original_name';
      byVariantKind.set(kind, (byVariantKind.get(kind) || 0) + 1);
    }
  }

  return { byReason, byProvider, bySourceField, byVariantKind };
}

function printCounts(label, map) {
  console.log(`  ${label}:`);
  if (map.size === 0) {
    console.log('    (none)');
    return;
  }
  for (const [key, count] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key}: ${count}`);
  }
}

async function runLive(db, destinations, limit) {
  printBudgetStatus('budget before this run');

  // Take the run's start marker FROM SQLITE, not from JS. attempted_at is written
  // by datetime('now') as 'YYYY-MM-DD HH:MM:SS', while new Date().toISOString()
  // yields 'YYYY-MM-DDTHH:MM:SS.sssZ' — and listVerificationAttempts compares
  // `attempted_at >= since` as TEXT, where ' ' (0x20) sorts before 'T' (0x54). An
  // ISO marker therefore excludes every row the run just wrote, so the summary
  // reported zero regardless of what happened. Reading the marker from the same
  // clock and the same format that writes the column removes the conversion
  // entirely rather than translating between two representations.
  const since = db.prepare("SELECT datetime('now') AS t").get().t;

  // The Nominatim pacing timer inside placeResolver is deliberately unref()'d
  // (placeResolver.js, pumpNominatimQueue) so that gate can never hold the Express
  // server — or a test run — open. That is correct there and fatal here: this
  // script's ONLY pending work is a paced drain, so between two lookups there is
  // nothing ref'ing the event loop and Node exits *cleanly* mid-run — exit code 0,
  // partial work written, no summary, no error. A job runner has to assert its own
  // liveness rather than borrow it from a timer that has disclaimed exactly that.
  const keepAlive = setInterval(() => {}, 1000);
  let admittedAny = false;

  try {
    console.log(`\n[discoveryReverify] enqueuing re-verification for ${destinations.length} destination(s)...`);
    for (const destination of destinations) {
      const terminalCount = countTerminalUnverified(db, destination.id);
      if (terminalCount === 0) continue;
      admittedAny = true;
      console.log(`  destination_id=${destination.id} display_name=${destination.display_name} terminal_unverified=${terminalCount}`);
      await enqueueForReverification(db, destination.id, limit != null ? { limit } : {});
      await waitForVerificationDrain(destination.id);
    }
  } finally {
    clearInterval(keepAlive);
  }

  const attempts = destinations
    .flatMap((destination) => listVerificationAttempts(db, { destinationId: destination.id, since, limit: 5000 }))
    .filter((attempt) => attempt.reverification === 1);

  // Loud failure on the silent-no-op shape. The bug this guards against exited 0
  // with partial work and no summary, which reads exactly like a clean run in a
  // deploy log. If candidates existed and the budgets had room, a run that wrote
  // nothing did not succeed — say so and fail the exit code.
  if (admittedAny && attempts.length === 0) {
    const status = getDiscoveryBudgetStatus();
    const budgetBound = status.reverifyRequests.used >= status.reverifyRequests.budget;
    console.error(
      '[discoveryReverify] FAILED: candidates were available but no attempt row was written. %s',
      budgetBound
        ? 'Cause: the re-verify daily request budget is exhausted.'
        : 'Budgets had room — the drain did not run to completion.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n[discoveryReverify] ${attempts.length} attempt row(s) written this run.`);
  const { byReason, byProvider, bySourceField, byVariantKind } = summarizeAttempts(attempts);
  printCounts('by reason', byReason);
  printCounts('by provider', byProvider);
  printCounts('by source_field', bySourceField);
  printCounts('winning variant kind (verified outcomes only)', byVariantKind);

  console.log();
  printBudgetStatus('budget after this run');
}

async function main() {
  const { destination, limit, dryRun } = parseArgs(process.argv.slice(2));

  initDb(config.dbPath);
  const db = getDb();

  const destinations = listTargetDestinations(db, destination);
  if (destinations.length === 0) {
    console.log(destination != null
      ? `[discoveryReverify] no destination found with id=${destination}`
      : '[discoveryReverify] no destinations in the catalogue — nothing to do');
    return;
  }

  if (dryRun) {
    await runDryRun(db, destinations, limit);
  } else {
    await runLive(db, destinations, limit);
  }
}

// Windows-safe "am I the entry point" check — import.meta.url includes a
// file:// scheme and drive-letter casing that differs from process.argv[1]'s
// raw path, so compare through pathToFileURL rather than a direct string match.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error('[discoveryReverify] fatal error:', err);
    process.exit(1);
  });
}
