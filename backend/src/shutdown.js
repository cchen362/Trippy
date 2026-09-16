// Plan 28 W5.1: clean shutdown for the HTTP server and its DB connection.
//
// Ordering matters and is deliberate:
//   1. server.close()               — stop accepting new connections.
//   2. server.closeIdleConnections() — free sockets with nothing in flight.
//   3. (after a grace period) server.closeAllConnections() — destroy sockets
//      that are still mid-request, including any open MCP stream.
//   4. await the server's 'close' callback — all sockets are gone.
//   5. closeDb() — only once nothing can still be writing.
//
// Step 3 is safe for apply_draft specifically, not accidentally: destroying
// the response socket fires Node's `res` 'close' event, which the SDK's
// toNodeHandler (@modelcontextprotocol/node) turns into `abort.abort()` on
// the AbortSignal passed through to the tool call. applyDraft's resolve loop
// (services/mcp/apply.js) checks `signal?.aborted` at the head of every
// iteration and throws `{ code: 'cancelled' }` before touching the database.
// The only DB write happens after resolution, as one synchronous
// better-sqlite3 transaction — and JS's single-threaded execution makes a
// transaction body uninterruptible once started. So an in-flight apply is
// either cancelled before it writes, or already mid-transaction and will
// finish it (nothing here can catch it half-written). Destroying the
// connection can therefore never leave a partial write — at worst it leaves
// the draft `pending`, to be retried.
export async function shutdownServer({ server, closeDb, gracePeriodMs = 5000 }) {
  const closed = new Promise((resolve) => server.close(() => resolve()));

  server.closeIdleConnections();

  // Wait for in-flight requests to finish on their own, but no longer than the
  // grace period — then destroy whatever is still open. The timer stays ref'd
  // on purpose: a shutdown in progress is exactly the thing that must keep the
  // process alive until closeDb() has run.
  if (gracePeriodMs > 0) {
    let timer;
    const grace = new Promise((resolve) => { timer = setTimeout(resolve, gracePeriodMs); });
    await Promise.race([closed, grace]);
    clearTimeout(timer);
  }
  server.closeAllConnections();

  await closed;
  await closeDb();
}

// installShutdownHandlers registers SIGTERM/SIGINT exactly once each. Docker
// sends SIGTERM with a 10s default stop timeout before SIGKILL, so the
// shutdownServer default 5s grace period must stay comfortably under that.
export function installShutdownHandlers({ server, closeDb, log = console }) {
  let shuttingDown = false;

  const handle = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.log(`[shutdown] ${signal} received, closing…`);
    shutdownServer({ server, closeDb })
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[shutdown] failed to close cleanly', error);
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => handle('SIGTERM'));
  process.once('SIGINT', () => handle('SIGINT'));
}
