import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

// --- Mock claude.js service BEFORE importing the route ---
// streamCopilotResponse is stubbed per-test. generatePhotoDescriptor is stubbed too because
// stops.js (now unmocked, reached via copilotProposals) imports it — the route tests never
// trigger photo resolution, but a defined export keeps the import safe.
const mockStreamCopilotResponse = vi.fn();

vi.mock('../src/services/claude.js', () => ({
  streamCopilotResponse: mockStreamCopilotResponse,
  generatePhotoDescriptor: vi.fn().mockResolvedValue(null),
}));

// Import route handlers after mocks are set up
const { default: copilotRouter } = await import('../src/routes/copilot.js');
const { createProposal } = await import('../src/services/copilotProposals.js');

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

let tmpDir;
let userId;
let otherUserId;
let tripId;
let dayId;
let otherTripId;
let otherDayId;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-copilot-test-'));
  initDb(join(tmpDir, 'test.db'));
  await runMigrations();

  const db = getDb();

  const user = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin)
    VALUES ('testuser', 'hash', 'Test User', 1)
    RETURNING id
  `).get();
  userId = user.id;

  const other = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin)
    VALUES ('collab', 'hash', 'Collaborator', 0)
    RETURNING id
  `).get();
  otherUserId = other.id;

  const trip = db.prepare(`
    INSERT INTO trips (title, owner_id, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES ('Test Trip', ?, '2026-05-01', '2026-05-03', 'couple', '[]', 'moderate', 'upcoming')
    RETURNING id
  `).get(userId);
  tripId = trip.id;

  const day = db.prepare(`
    INSERT INTO days (trip_id, date, city)
    VALUES (?, '2026-05-01', 'Test City')
    RETURNING id
  `).get(tripId);
  dayId = day.id;

  otherTripId = db.prepare(`
    INSERT INTO trips (title, owner_id, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES ('Other Trip', ?, '2026-06-01', '2026-06-02', 'solo', '[]', 'moderate', 'upcoming')
    RETURNING id
  `).get(userId).id;
  otherDayId = db.prepare(`
    INSERT INTO days (trip_id, date, city)
    VALUES (?, '2026-06-01', 'Other City')
    RETURNING id
  `).get(otherTripId).id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

function insertStop(title = 'Test Stop', sortOrder = 1) {
  return getDb().prepare(`
    INSERT INTO stops (day_id, title, type, sort_order)
    VALUES (?, ?, 'experience', ?)
    RETURNING id
  `).get(dayId, title, sortOrder).id;
}

// ---------------------------------------------------------------------------
// Handler invocation harness (bypasses Express middleware; req.trip set manually)
// ---------------------------------------------------------------------------

function makeReq(overrides = {}) {
  return {
    user: { id: userId },
    params: { tripId },
    body: {},
    trip: { id: tripId, owner_id: userId },
    ...overrides,
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    _ended: false,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    end() { this._ended = true; },
  };
}

async function callHandler(method, path, req, res) {
  return new Promise((resolve, reject) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const result = originalJson(body);
      resolve();
      return result;
    };

    const next = (err) => {
      if (err) reject(err);
      else resolve();
    };

    const stack = copilotRouter.stack;
    for (const layer of stack) {
      if (!layer.route) continue;
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod !== method) continue;

      const regexPath = routePath.replace(/:([^/]+)/g, '([^/]+)');
      const match = path.match(new RegExp(`^${regexPath}$`));
      if (!match) continue;

      const paramNames = [...routePath.matchAll(/:([^/]+)/g)].map((m) => m[1]);
      req.params = req.params || {};
      paramNames.forEach((name, i) => { req.params[name] = match[i + 1]; });

      const handlers = layer.route.stack;
      const handler = handlers[handlers.length - 1].handle;
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(() => resolve()).catch(reject);
      }
      return;
    }
    reject(new Error(`No handler found for ${method} ${path}`));
  });
}

// ---------------------------------------------------------------------------
// GET history
// ---------------------------------------------------------------------------

describe('GET /trips/:tripId/copilot/history', () => {
  it('returns messages in ascending order and a proposals array', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
      VALUES ('msg-1', ?, ?, 'user', 'Hello copilot', '2026-05-01T10:00:00')
    `).run(tripId, userId);
    db.prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
      VALUES ('msg-2', ?, NULL, 'assistant', 'Hello traveller', '2026-05-01T10:00:01')
    `).run(tripId);

    const req = makeReq();
    const res = makeRes();
    await callHandler('get', `/${tripId}/copilot/history`, req, res);

    expect(Array.isArray(res._body.messages)).toBe(true);
    expect(Array.isArray(res._body.proposals)).toBe(true);
    const msgs = res._body.messages.filter((m) => m.id === 'msg-1' || m.id === 'msg-2');
    expect(msgs.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
    const userMsg = msgs.find((m) => m.id === 'msg-1');
    const assistantMsg = msgs.find((m) => m.id === 'msg-2');
    expect(userMsg.authorName).toBe('Test User');
    expect(assistantMsg.authorName).toBeNull();

    db.prepare('DELETE FROM copilot_messages WHERE id IN (?, ?)').run('msg-1', 'msg-2');
  });

  it('round-trips resolved context_json on a user message', async () => {
    const context = {
      tab: 'plan',
      dayId,
      dayNumber: 1,
      dayCity: 'Test City',
    };
    getDb().prepare(`
      INSERT INTO copilot_messages
        (id, trip_id, user_id, role, content, context_json, created_at)
      VALUES ('msg-context', ?, ?, 'user', 'Context turn', ?, '2026-05-01T10:01:00')
    `).run(tripId, userId, JSON.stringify(context));

    const res = makeRes();
    await callHandler('get', `/${tripId}/copilot/history`, makeReq(), res);

    expect(res._body.messages.find((message) => message.id === 'msg-context')?.context)
      .toEqual(context);

    getDb().prepare('DELETE FROM copilot_messages WHERE id = ?').run('msg-context');
  });
});

// ---------------------------------------------------------------------------
// DELETE history — owner-only (D8)
// ---------------------------------------------------------------------------

describe('DELETE /trips/:tripId/copilot/history', () => {
  it('clears the conversation for the owner', async () => {
    const req = makeReq();
    const res = makeRes();
    await callHandler('delete', `/${tripId}/copilot/history`, req, res);
    expect(res._body.ok).toBe(true);
  });

  it('rejects a non-owner with 403', async () => {
    const req = makeReq({ user: { id: otherUserId }, trip: { id: tripId, owner_id: userId } });
    const res = makeRes();
    await expect(callHandler('delete', `/${tripId}/copilot/history`, req, res)).rejects.toMatchObject({
      status: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// POST copilot — streaming + persistTurn
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/copilot', () => {
  it('saves the user message and passes a persistTurn callback', async () => {
    mockStreamCopilotResponse.mockImplementation(async (msgs, ctx, res, req, persistTurn) => {
      await persistTurn({ assistantText: 'Assistant reply', operations: null });
      return 'Assistant reply';
    });

    const req = makeReq({ body: { message: 'What should I see?' } });
    const res = makeRes();
    await callHandler('post', `/${tripId}/copilot`, req, res);

    expect(mockStreamCopilotResponse).toHaveBeenCalledOnce();
    const db = getDb();
    const userMsg = db.prepare(
      "SELECT * FROM copilot_messages WHERE trip_id = ? AND role = 'user' AND content = ?",
    ).get(tripId, 'What should I see?');
    expect(userMsg.user_id).toBe(userId);
    const assistantMsg = db.prepare(
      "SELECT * FROM copilot_messages WHERE trip_id = ? AND role = 'assistant' AND content = ?",
    ).get(tripId, 'Assistant reply');
    expect(assistantMsg).toBeDefined();

    db.prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content IN (?, ?)')
      .run(tripId, 'What should I see?', 'Assistant reply');
  });

  it('feeds the model exactly the newest 50 messages in chronological order (Wave 3, D4)', async () => {
    const db = getDb();
    // Seed 55 alternating messages, all timestamped strictly before "now" so the new user
    // turn (inserted at "now" by the route) is always the newest. seed-0 is oldest.
    for (let i = 0; i < 55; i += 1) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const secondsAgo = 55 - i;
      db.prepare(`
        INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now', '-' || ? || ' seconds'))
      `).run(tripId, role === 'user' ? userId : null, role, `seed-${i}`, secondsAgo);
    }

    mockStreamCopilotResponse.mockImplementation(async (msgs, ctx, res, req, persistTurn) => {
      await persistTurn({ assistantText: 'window reply', operations: null });
      return 'window reply';
    });

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({ body: { message: 'window probe' } }),
      makeRes(),
    );

    const [messages] = mockStreamCopilotResponse.mock.calls[0];
    expect(messages).toHaveLength(50);
    // Pool is 55 seeded + 1 new = 56 messages; newest 50 drops the oldest 6 (seed-0..seed-5),
    // keeping seed-6..seed-54 (49 messages) plus the new user turn, chronologically ordered.
    expect(messages[0].content).toBe('seed-6');
    expect(messages[48].content).toBe('seed-54');
    expect(messages[49].content).toBe('window probe');
    expect(messages.some((m) => m.content === 'seed-0')).toBe(false);
    expect(messages.some((m) => m.content === 'seed-5')).toBe(false);

    db.prepare("DELETE FROM copilot_messages WHERE trip_id = ? AND content LIKE 'seed-%'").run(tripId);
    db.prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content IN (?, ?)')
      .run(tripId, 'window probe', 'window reply');
  });

  it('injects resolved context into the user turn only and persists it separately', async () => {
    const stopId = insertStop('West Lake', 2);
    mockStreamCopilotResponse.mockImplementation(async () => 'Done');

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({
        body: {
          message: "How's this day looking?",
          context: { tab: 'plan', dayId, stopId },
        },
      }),
      makeRes(),
    );

    const [messages, systemContext] = mockStreamCopilotResponse.mock.calls[0];
    const injectedTurn = messages.find((message) => message.content.includes("How's this day looking?"));
    expect(injectedTurn).toEqual({
      role: 'user',
      content: `[Viewing: Plan tab, Day 1 (Test City), stop "West Lake"]\n\nHow's this day looking?`,
    });
    expect(JSON.stringify(systemContext)).not.toContain('[Viewing:');

    const stored = getDb().prepare(`
      SELECT content, context_json FROM copilot_messages
      WHERE trip_id = ? AND role = 'user' AND content = ?
    `).get(tripId, "How's this day looking?");
    expect(stored.content).toBe("How's this day looking?");
    expect(JSON.parse(stored.context_json)).toEqual({
      tab: 'plan',
      dayId,
      dayNumber: 1,
      dayCity: 'Test City',
      stopId,
      stopName: 'West Lake',
    });

    getDb().prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?')
      .run(tripId, "How's this day looking?");
  });

  it('normalizes Discovery context identically for persistence, history, and model injection', async () => {
    mockStreamCopilotResponse.mockResolvedValue('Done');

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({
        body: {
          message: 'Does this fit the trip?',
          context: {
            tab: 'discovery',
            discoveryName: '  Hupao Spring  ',
            dayId: otherDayId,
            stopId: 'not-a-stop',
          },
        },
      }),
      makeRes(),
    );

    const [messages, systemContext] = mockStreamCopilotResponse.mock.calls[0];
    expect(messages.find((message) => message.content.includes('Does this fit the trip?'))).toEqual({
      role: 'user',
      content: '[Viewing: Discovery, suggestion "Hupao Spring"]\n\nDoes this fit the trip?',
    });
    expect(JSON.stringify(systemContext)).not.toContain('Hupao Spring');

    const stored = getDb().prepare(`
      SELECT id, context_json FROM copilot_messages
      WHERE trip_id = ? AND role = 'user' AND content = ?
    `).get(tripId, 'Does this fit the trip?');
    expect(JSON.parse(stored.context_json)).toEqual({
      tab: 'discovery',
      discoveryName: 'Hupao Spring',
    });

    const historyRes = makeRes();
    await callHandler('get', `/${tripId}/copilot/history`, makeReq(), historyRes);
    expect(historyRes._body.messages.find((message) => message.id === stored.id)?.context).toEqual({
      tab: 'discovery',
      discoveryName: 'Hupao Spring',
    });

    getDb().prepare('DELETE FROM copilot_messages WHERE id = ?').run(stored.id);
  });

  it.each([
    [{ tab: 'discovery' }, 'discoveryName must be a string'],
    [{ tab: 'discovery', discoveryName: '   ' }, 'discoveryName must not be empty'],
    [{ tab: 'discovery', discoveryName: 'A'.repeat(161) }, 'discoveryName is too long'],
    [{ tab: 'discovery', discoveryName: 'Hupao\nSpring' }, 'discoveryName must be a single line without control characters'],
  ])('drops malformed Discovery context without failing the turn', async (context, reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStreamCopilotResponse.mockResolvedValue('Done');
    const message = `Malformed discovery ${reason}`;

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({ body: { message, context } }),
      makeRes(),
    );

    const stored = getDb().prepare(`
      SELECT context_json FROM copilot_messages WHERE trip_id = ? AND content = ?
    `).get(tripId, message);
    expect(stored.context_json).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[copilot] Dropping invalid message context: %s',
      reason,
    );

    warn.mockRestore();
    getDb().prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?')
      .run(tripId, message);
  });

  it('ignores discoveryName outside the Discovery surface', async () => {
    mockStreamCopilotResponse.mockResolvedValue('Done');

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({
        body: {
          message: 'Plan context only',
          context: { tab: 'plan', dayId, discoveryName: 'Injected subject' },
        },
      }),
      makeRes(),
    );

    const stored = getDb().prepare(`
      SELECT context_json FROM copilot_messages WHERE trip_id = ? AND content = ?
    `).get(tripId, 'Plan context only');
    expect(JSON.parse(stored.context_json)).toEqual({
      tab: 'plan',
      dayId,
      dayNumber: 1,
      dayCity: 'Test City',
    });
    const [messages] = mockStreamCopilotResponse.mock.calls[0];
    expect(messages.find((message) => message.content.includes('Plan context only')).content)
      .not.toContain('Injected subject');

    getDb().prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?')
      .run(tripId, 'Plan context only');
  });

  it('drops an unknown tab with a warning without failing the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStreamCopilotResponse.mockResolvedValue('Done');

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({ body: { message: 'Unknown tab turn', context: { tab: 'discover', dayId } } }),
      makeRes(),
    );

    const stored = getDb().prepare(`
      SELECT context_json FROM copilot_messages WHERE trip_id = ? AND content = ?
    `).get(tripId, 'Unknown tab turn');
    expect(stored.context_json).toBeNull();
    const [messages] = mockStreamCopilotResponse.mock.calls[0];
    expect(messages.find((message) => message.content === 'Unknown tab turn')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      '[copilot] Dropping invalid message context: %s',
      'unknown tab',
    );

    warn.mockRestore();
    getDb().prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?')
      .run(tripId, 'Unknown tab turn');
  });

  it('drops a cross-trip id with a warning without failing the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStreamCopilotResponse.mockResolvedValue('Done');

    await callHandler(
      'post',
      `/${tripId}/copilot`,
      makeReq({ body: { message: 'Cross-trip turn', context: { tab: 'plan', dayId: otherDayId } } }),
      makeRes(),
    );

    const stored = getDb().prepare(`
      SELECT context_json FROM copilot_messages WHERE trip_id = ? AND content = ?
    `).get(tripId, 'Cross-trip turn');
    expect(stored.context_json).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[copilot] Dropping invalid message context: %s',
      'dayId does not belong to trip',
    );

    warn.mockRestore();
    getDb().prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?')
      .run(tripId, 'Cross-trip turn');
  });

  it('creates a proposal record when the model calls the tool', async () => {
    const operations = [{ action: 'add_stop', dayId, stop: { title: 'Giant Panda Base', type: 'experience', time: null } }];
    mockStreamCopilotResponse.mockImplementation(async (msgs, ctx, res, req, persistTurn) => {
      const payload = await persistTurn({ assistantText: 'Adding it now.', operations });
      // The route hands back the enriched proposal SSE payload for the service to emit.
      res.json({ payload });
      return 'Adding it now.';
    });

    const req = makeReq({ body: { message: 'Add the panda base' } });
    const res = makeRes();
    await callHandler('post', `/${tripId}/copilot`, req, res);

    expect(res._body.payload.proposalId).toBeDefined();
    expect(res._body.payload.status).toBe('pending');

    const db = getDb();
    const proposal = db.prepare('SELECT * FROM copilot_proposals WHERE id = ?').get(res._body.payload.proposalId);
    expect(proposal.trip_id).toBe(tripId);
    expect(proposal.status).toBe('pending');
    expect(proposal.message_id).not.toBeNull();

    db.prepare('DELETE FROM copilot_proposals WHERE id = ?').run(res._body.payload.proposalId);
    db.prepare("DELETE FROM copilot_messages WHERE trip_id = ? AND content IN ('Add the panda base', 'Adding it now.')").run(tripId);
  });

  it('inserts a copilot_turn_metrics row when the service reports turn metrics', async () => {
    mockStreamCopilotResponse.mockImplementation(async (msgs, ctx, res, req, persistTurn, toolExecutors, reportTurnMetrics) => {
      await reportTurnMetrics({
        model: 'claude-sonnet-4-6',
        inputTokens: 120,
        outputTokens: 45,
        cacheWriteTokens: 500,
        cacheReadTokens: 0,
        ttfdMs: 300,
        totalMs: 1500,
        iterations: 1,
        queryCalls: 0,
        stopReason: 'end_turn',
        proposalOps: 0,
        error: 0,
      });
      return 'Done';
    });

    const req = makeReq({ body: { message: 'Metrics turn' } });
    const res = makeRes();
    await callHandler('post', `/${tripId}/copilot`, req, res);

    const db = getDb();
    const row = db.prepare('SELECT * FROM copilot_turn_metrics WHERE trip_id = ?').get(tripId);
    expect(row).toBeDefined();
    expect(row.trip_id).toBe(tripId);
    expect(row.model).toBe('claude-sonnet-4-6');
    expect(row.input_tokens).toBe(120);
    expect(row.output_tokens).toBe(45);
    expect(row.cache_write_tokens).toBe(500);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.ttfd_ms).toBe(300);
    expect(row.total_ms).toBe(1500);
    expect(row.iterations).toBe(1);
    expect(row.query_calls).toBe(0);
    expect(row.stop_reason).toBe('end_turn');
    expect(row.proposal_ops).toBe(0);
    expect(row.error).toBe(0);

    db.prepare('DELETE FROM copilot_turn_metrics WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?').run(tripId, 'Metrics turn');
  });

  it('prunes copilot_turn_metrics rows older than 90 days on write, keeping the new row', async () => {
    const db = getDb();
    const stale = db.prepare(`
      INSERT INTO copilot_turn_metrics (
        trip_id, created_at, model, input_tokens, output_tokens, cache_write_tokens,
        cache_read_tokens, ttfd_ms, total_ms, iterations, query_calls, stop_reason,
        proposal_ops, error
      ) VALUES (?, datetime('now', '-100 days'), 'claude-sonnet-4-6', 1, 1, 0, 0, 100, 200, 1, 0, 'end_turn', 0, 0)
      RETURNING id
    `).get(tripId);

    mockStreamCopilotResponse.mockImplementation(async (msgs, ctx, res, req, persistTurn, toolExecutors, reportTurnMetrics) => {
      await reportTurnMetrics({
        model: 'claude-sonnet-4-6',
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        ttfdMs: 100,
        totalMs: 500,
        iterations: 1,
        queryCalls: 0,
        stopReason: 'end_turn',
        proposalOps: 0,
        error: 0,
      });
      return 'Done';
    });

    await callHandler('post', `/${tripId}/copilot`, makeReq({ body: { message: 'Retention turn' } }), makeRes());

    expect(db.prepare('SELECT id FROM copilot_turn_metrics WHERE id = ?').get(stale.id)).toBeUndefined();
    const fresh = db.prepare(
      "SELECT id FROM copilot_turn_metrics WHERE trip_id = ? AND total_ms = 500",
    ).get(tripId);
    expect(fresh).toBeDefined();

    db.prepare('DELETE FROM copilot_turn_metrics WHERE id = ?').run(fresh.id);
    db.prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?').run(tripId, 'Retention turn');
  });

  it('returns 400 when message is missing', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    await expect(callHandler('post', `/${tripId}/copilot`, req, res)).rejects.toMatchObject({
      status: 400,
      message: 'message is required',
    });
    expect(mockStreamCopilotResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST apply — proposal-id only (raw operations rejected)
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/copilot/apply', () => {
  it('returns 400 when proposalId is missing (raw operations rejected)', async () => {
    const req = makeReq({ body: { mutation: { operations: [{ action: 'remove_stop', stopId: 'x' }] } } });
    const res = makeRes();
    await expect(callHandler('post', `/${tripId}/copilot/apply`, req, res)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns 404 for an unknown proposalId', async () => {
    const req = makeReq({ body: { proposalId: 'does-not-exist' } });
    const res = makeRes();
    await expect(callHandler('post', `/${tripId}/copilot/apply`, req, res)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('applies a pending remove_stop proposal and marks it applied', async () => {
    const stopId = insertStop('Stop To Remove', 5);
    const { proposalId } = createProposal({
      tripId,
      userId,
      messageId: null,
      operations: [{ action: 'remove_stop', stopId }],
    });

    const req = makeReq({ body: { proposalId } });
    const res = makeRes();
    await callHandler('post', `/${tripId}/copilot/apply`, req, res);

    expect(res._body.status).toBe('applied');
    const db = getDb();
    expect(db.prepare('SELECT * FROM stops WHERE id = ?').get(stopId)).toBeUndefined();
    expect(db.prepare('SELECT status FROM copilot_proposals WHERE id = ?').get(proposalId).status).toBe('applied');
  });

  it('rejects re-applying an already-applied proposal with 409', async () => {
    const stopId = insertStop('Stop To Remove Twice', 6);
    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [{ action: 'remove_stop', stopId }],
    });
    await callHandler('post', `/${tripId}/copilot/apply`, makeReq({ body: { proposalId } }), makeRes());

    await expect(
      callHandler('post', `/${tripId}/copilot/apply`, makeReq({ body: { proposalId } }), makeRes()),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// POST reject
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/copilot/proposals/:id/reject', () => {
  it('records a rejection', async () => {
    const stopId = insertStop('Stop For Reject', 7);
    const { proposalId } = createProposal({
      tripId, userId, messageId: null,
      operations: [{ action: 'remove_stop', stopId }],
    });

    const req = makeReq({ body: {} });
    const res = makeRes();
    await callHandler('post', `/${tripId}/copilot/proposals/${proposalId}/reject`, req, res);

    expect(res._body.status).toBe('rejected');
    const db = getDb();
    expect(db.prepare('SELECT status FROM copilot_proposals WHERE id = ?').get(proposalId).status).toBe('rejected');
    // The stop is untouched by a rejection.
    expect(db.prepare('SELECT id FROM stops WHERE id = ?').get(stopId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// D-30-8 (Plan 30): every turn ends in exactly one persisted assistant row
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/copilot — one persisted assistant row per turn (D-30-8)', () => {
  const STOPPED_LINE = '[The traveller stopped this reply. Treat their next message as a new request; resume only if they ask.]';
  const INTERRUPTED_LINE = '[This reply was cut off by an error before it finished.]';
  const NO_REPLY_LINE = '[No reply was given to this message.]';

  // Isolated trip so rows seeded here can never collide with the other describes' fixtures.
  const turnReq = (message) => makeReq({
    body: { message },
    params: { tripId: otherTripId },
    trip: { id: otherTripId, owner_id: userId },
  });
  const historyReq = () => makeReq({
    params: { tripId: otherTripId },
    trip: { id: otherTripId, owner_id: userId },
  });

  // Runs one turn whose stubbed service hands persistTurn the given arguments, and returns the
  // conversation messages the route built for the model.
  async function runTurn(message, persistArgs) {
    mockStreamCopilotResponse.mockImplementationOnce(async (msgs, ctx, res, req, persistTurn) => {
      await persistTurn(persistArgs);
      return persistArgs.assistantText;
    });
    await callHandler('post', `/${otherTripId}/copilot`, turnReq(message), makeRes());
    return mockStreamCopilotResponse.mock.calls.at(-1)[0];
  }

  const rows = () => getDb().prepare(
    'SELECT role, content, notice FROM copilot_messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC',
  ).all(otherTripId);

  beforeEach(() => {
    getDb().prepare('DELETE FROM copilot_messages WHERE trip_id = ?').run(otherTripId);
  });

  it('stores the assistant row with its notice and returns it from the history endpoint', async () => {
    await runTurn('Plan day 2', { assistantText: 'Day 2 is ', operations: null, notice: 'stopped' });

    expect(rows()).toEqual([
      { role: 'user', content: 'Plan day 2', notice: null },
      { role: 'assistant', content: 'Day 2 is ', notice: 'stopped' },
    ]);

    const res = makeRes();
    await callHandler('get', `/${otherTripId}/copilot/history`, historyReq(), res);
    expect(res._body.messages.map((m) => [m.role, m.notice])).toEqual([['user', null], ['assistant', 'stopped']]);
  });

  it('always inserts one assistant row, even for a text-less turn with no proposal', async () => {
    await runTurn('Anything?', { assistantText: '', operations: null, notice: 'empty' });

    expect(rows()).toEqual([
      { role: 'user', content: 'Anything?', notice: null },
      { role: 'assistant', content: '', notice: 'empty' },
    ]);
  });

  it('after a stopped turn the next turn alternates user/assistant and the stopped row carries the bracket line', async () => {
    await runTurn('First question', { assistantText: 'Partial answer', operations: null, notice: 'stopped' });
    const messages = await runTurn('Second question', { assistantText: 'Full answer', operations: null, notice: null });

    expect(messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: `Partial answer\n\n${STOPPED_LINE}` },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('sends the stopped line alone when nothing had streamed, and labels an interrupted reply', async () => {
    await runTurn('Q1', { assistantText: '', operations: null, notice: 'stopped' });
    await runTurn('Q2', { assistantText: 'Half a thou', operations: null, notice: 'interrupted' });
    const messages = await runTurn('Q3', { assistantText: 'ok', operations: null, notice: null });

    expect(messages).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: STOPPED_LINE },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: `Half a thou\n\n${INTERRUPTED_LINE}` },
      { role: 'user', content: 'Q3' },
    ]);
  });

  it('gives a blank empty/refused/truncated assistant row the fallback line, never an empty turn', async () => {
    await runTurn('Q1', { assistantText: '', operations: null, notice: 'empty' });
    await runTurn('Q2', { assistantText: '', operations: null, notice: 'refused' });
    await runTurn('Q3', { assistantText: '', operations: null, notice: 'truncated' });
    const messages = await runTurn('Q4', { assistantText: 'ok', operations: null, notice: null });

    expect(messages.filter((m) => m.role === 'assistant').map((m) => m.content))
      .toEqual([NO_REPLY_LINE, NO_REPLY_LINE, NO_REPLY_LINE]);
  });

  it('leaves a text-bearing truncated row and a notice-null proposal-only row exactly as stored', async () => {
    const db = getDb();
    const stopId = db.prepare(`
      INSERT INTO stops (day_id, title, type, sort_order) VALUES (?, 'Proposal Target', 'experience', 1) RETURNING id
    `).get(otherDayId).id;
    await runTurn('Q1', { assistantText: 'cut off mid', operations: null, notice: 'truncated' });
    await runTurn('Q2', { assistantText: '', operations: [{ action: 'remove_stop', stopId }], notice: null });
    const messages = await runTurn('Q3', { assistantText: 'ok', operations: null, notice: null });

    expect(messages[1]).toEqual({ role: 'assistant', content: 'cut off mid' });
    // Proposal-only rows keep their empty content (out of scope for D-30-8).
    expect(messages[3]).toEqual({ role: 'assistant', content: '' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM copilot_proposals WHERE trip_id = ? AND message_id IS NOT NULL')
      .get(otherTripId).n).toBe(1);

    db.prepare('DELETE FROM copilot_proposals WHERE trip_id = ?').run(otherTripId);
    db.prepare('DELETE FROM stops WHERE id = ?').run(stopId);
  });

  it('orders same-second rows by insertion in both the history and the model context', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?, '2026-05-01 10:00:00')
    `);
    // Ids sort opposite to insertion order, so only rowid can produce the right result.
    insert.run('zz-1', otherTripId, userId, 'user', 'tie-1');
    insert.run('yy-2', otherTripId, null, 'assistant', 'tie-2');
    insert.run('xx-3', otherTripId, userId, 'user', 'tie-3');
    insert.run('ww-4', otherTripId, null, 'assistant', 'tie-4');

    const res = makeRes();
    await callHandler('get', `/${otherTripId}/copilot/history`, historyReq(), res);
    expect(res._body.messages.map((m) => m.content)).toEqual(['tie-1', 'tie-2', 'tie-3', 'tie-4']);

    const messages = await runTurn('tie-5', { assistantText: 'ok', operations: null, notice: null });
    expect(messages.slice(0, 5).map((m) => m.content)).toEqual(['tie-1', 'tie-2', 'tie-3', 'tie-4', 'tie-5']);
  });

  it('inserts nothing (and creates no proposal) when the question row was cleared before persistTurn ran', async () => {
    const db = getDb();
    const stopId = db.prepare(`
      INSERT INTO stops (day_id, title, type, sort_order) VALUES (?, 'Cleared Target', 'experience', 1) RETURNING id
    `).get(otherDayId).id;
    let returned;
    mockStreamCopilotResponse.mockImplementationOnce(async (msgs, ctx, res, req, persistTurn) => {
      // Stop followed by Clear conversation: the owner empties the history mid-turn.
      db.prepare('DELETE FROM copilot_messages WHERE trip_id = ?').run(otherTripId);
      returned = await persistTurn({
        assistantText: 'late partial',
        operations: [{ action: 'remove_stop', stopId }],
        notice: 'stopped',
      });
      return 'late partial';
    });

    await callHandler('post', `/${otherTripId}/copilot`, turnReq('doomed question'), makeRes());

    expect(returned).toBeNull();
    expect(rows()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM copilot_proposals WHERE trip_id = ?').get(otherTripId).n).toBe(0);
    db.prepare('DELETE FROM stops WHERE id = ?').run(stopId);
  });
});

// ---------------------------------------------------------------------------
// Plan 32: remove a stopped exchange (D-32-1 … D-32-6)
// ---------------------------------------------------------------------------

describe('DELETE /trips/:tripId/copilot/exchanges/:messageId (Plan 32)', () => {
  let removeTripId;
  let thirdUserId;

  beforeAll(() => {
    const db = getDb();
    thirdUserId = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, is_admin)
      VALUES ('collab-two', 'hash', 'Second Collaborator', 0)
      RETURNING id
    `).get().id;
    removeTripId = db.prepare(`
      INSERT INTO trips (title, owner_id, start_date, end_date, travellers, interest_tags, pace, status)
      VALUES ('Remove Trip', ?, '2026-07-01', '2026-07-02', 'couple', '[]', 'moderate', 'upcoming')
      RETURNING id
    `).get(userId).id;
    db.prepare(`
      INSERT INTO days (trip_id, date, city) VALUES (?, '2026-07-01', 'Remove City')
    `).run(removeTripId);
    const addCollaborator = db.prepare('INSERT INTO trip_collaborators (trip_id, user_id) VALUES (?, ?)');
    addCollaborator.run(removeTripId, otherUserId);
    addCollaborator.run(removeTripId, thirdUserId);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM copilot_proposals WHERE trip_id = ?').run(removeTripId);
    db.prepare('DELETE FROM copilot_messages WHERE trip_id = ?').run(removeTripId);
  });

  const asUser = (id, extra = {}) => makeReq({
    user: { id },
    params: { tripId: removeTripId },
    trip: { id: removeTripId, owner_id: userId },
    ...extra,
  });
  const remove = (id, messageId) =>
    callHandler('delete', `/${removeTripId}/copilot/exchanges/${messageId}`, asUser(id), makeRes());
  const removeWithBody = async (id, messageId) => {
    const res = makeRes();
    await callHandler('delete', `/${removeTripId}/copilot/exchanges/${messageId}`, asUser(id), res);
    return res._body;
  };
  const askQuestion = (message) => callHandler('post', `/${removeTripId}/copilot`, asUser(userId, {
    body: { message },
  }), makeRes());

  let seq = 0;
  // Seeds one row with a strictly increasing timestamp, so ordering never depends on the clock.
  function seed(id, role, authorId, { notice = null, replyTo = null, tripId: rowTripId = removeTripId } = {}) {
    seq += 1;
    const created = `2026-07-01 10:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}`;
    getDb().prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, notice, reply_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, rowTripId, role === 'user' ? authorId : null, role, `${role} ${id}`, notice, replyTo, created);
  }
  const remaining = () => getDb().prepare(
    'SELECT id FROM copilot_messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC',
  ).all(removeTripId).map((r) => r.id);

  it('lets the author remove their own stopped exchange, and the next turn no longer carries it', async () => {
    seed('q-a', 'user', otherUserId);
    seed('a-a', 'assistant', null, { notice: 'stopped', replyTo: 'q-a' });
    seed('q-keep', 'user', otherUserId);
    seed('a-keep', 'assistant', null, { replyTo: 'q-keep' });

    expect(await removeWithBody(otherUserId, 'q-a')).toEqual({ removed: 2 });
    expect(remaining()).toEqual(['q-keep', 'a-keep']);

    mockStreamCopilotResponse.mockImplementationOnce(async () => 'ok');
    await askQuestion('Fresh question');
    const sent = mockStreamCopilotResponse.mock.calls.at(-1)[0].map((m) => m.content);
    expect(sent).toEqual(['user q-keep', 'assistant a-keep', 'Fresh question']);
  });

  it('lets the trip owner remove a collaborator\'s stopped exchange', async () => {
    seed('q-a', 'user', otherUserId);
    seed('a-a', 'assistant', null, { notice: 'stopped', replyTo: 'q-a' });

    expect(await removeWithBody(userId, 'q-a')).toEqual({ removed: 2 });
    expect(remaining()).toEqual([]);
  });

  it('refuses a collaborator removing someone else\'s exchange with 403 and leaves the rows', async () => {
    seed('q-a', 'user', otherUserId);
    seed('a-a', 'assistant', null, { notice: 'stopped', replyTo: 'q-a' });

    await expect(remove(thirdUserId, 'q-a')).rejects.toMatchObject({
      status: 403,
      message: 'Only the person who asked, or the trip owner, can remove this.',
    });
    expect(remaining()).toEqual(['q-a', 'a-a']);
  });

  it('refuses a finished reply with 409 and leaves the rows', async () => {
    seed('q-a', 'user', userId);
    seed('a-a', 'assistant', null, { notice: null, replyTo: 'q-a' });

    await expect(remove(userId, 'q-a')).rejects.toMatchObject({
      status: 409,
      message: 'This conversation changed — reload and try again.',
    });
    expect(remaining()).toEqual(['q-a', 'a-a']);
  });

  it('refuses a stopped reply that a proposal references, with 409', async () => {
    seed('q-a', 'user', userId);
    seed('a-a', 'assistant', null, { notice: 'stopped', replyTo: 'q-a' });
    getDb().prepare(`
      INSERT INTO copilot_proposals (id, trip_id, message_id, created_by_user_id, operations_json, trip_fingerprint)
      VALUES ('p-guard', ?, 'a-a', ?, '[]', 'fp')
    `).run(removeTripId, userId);

    await expect(remove(userId, 'q-a')).rejects.toMatchObject({ status: 409 });
    expect(remaining()).toEqual(['q-a', 'a-a']);
  });

  it('answers 404 for another trip\'s message id', async () => {
    seed('q-other', 'user', userId, { tripId: otherTripId });
    try {
      await expect(remove(userId, 'q-other')).rejects.toMatchObject({
        status: 404,
        message: 'This conversation changed — reload and try again.',
      });
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM copilot_messages WHERE id = ?').get('q-other').n).toBe(1);
    } finally {
      getDb().prepare('DELETE FROM copilot_messages WHERE id = ?').run('q-other');
    }
  });

  it('answers 404 for an assistant row id and for a second removal of the same id', async () => {
    seed('q-a', 'user', userId);
    seed('a-a', 'assistant', null, { notice: 'stopped', replyTo: 'q-a' });

    await expect(remove(userId, 'a-a')).rejects.toMatchObject({ status: 404 });
    expect(remaining()).toEqual(['q-a', 'a-a']);

    await remove(userId, 'q-a');
    await expect(remove(userId, 'q-a')).rejects.toMatchObject({ status: 404 });
  });

  it('removes a question that has no reply yet, and its late stopped reply is then never inserted', async () => {
    let capturedPersistTurn;
    let capturedTurnInfo;
    mockStreamCopilotResponse.mockImplementationOnce(
      async (msgs, ctx, res, req, persistTurn, toolExecutors, reportTurnMetrics, turnInfo) => {
        capturedPersistTurn = persistTurn;
        capturedTurnInfo = turnInfo;
        return '';
      },
    );
    await askQuestion('Mistaken question');

    // The route names the saved question for the stream (D-32-2).
    const saved = getDb().prepare(
      "SELECT id FROM copilot_messages WHERE trip_id = ? AND role = 'user'",
    ).get(removeTripId);
    expect(capturedTurnInfo).toEqual({ messageId: saved.id });

    expect(await removeWithBody(userId, saved.id)).toEqual({ removed: 1 });
    expect(await capturedPersistTurn({ assistantText: 'late partial', operations: null, notice: 'stopped' })).toBeNull();
    expect(remaining()).toEqual([]);
  });

  it('pairs a legacy exchange (reply_to NULL) by order', async () => {
    seed('q-old', 'user', userId);
    seed('a-old', 'assistant', null, { notice: 'stopped' });
    seed('q-new', 'user', userId);
    seed('a-new', 'assistant', null, { replyTo: 'q-new' });

    expect(await removeWithBody(userId, 'q-old')).toEqual({ removed: 2 });
    expect(remaining()).toEqual(['q-new', 'a-new']);
  });

  it('refuses an ambiguous legacy pair (another question sits between) with 409', async () => {
    seed('q-one', 'user', otherUserId);
    seed('q-two', 'user', userId);
    seed('a-late', 'assistant', null, { notice: 'stopped' });

    await expect(remove(otherUserId, 'q-one')).rejects.toMatchObject({ status: 409 });
    expect(remaining()).toEqual(['q-one', 'q-two', 'a-late']);
  });

  it('removes a pending post-037 question alone and never takes another question\'s reply', async () => {
    seed('q-pending', 'user', userId);
    seed('q-other', 'user', otherUserId);
    seed('a-other', 'assistant', null, { notice: 'stopped', replyTo: 'q-other' });

    expect(await removeWithBody(userId, 'q-pending')).toEqual({ removed: 1 });
    expect(remaining()).toEqual(['q-other', 'a-other']);
  });

  it('leaves turn metrics alone (D-32-6)', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO copilot_turn_metrics (trip_id, model, total_ms, iterations, query_calls)
      VALUES (?, 'm', 1, 1, 0)
    `).run(removeTripId);
    seed('q-a', 'user', userId);
    seed('a-a', 'assistant', null, { notice: 'stopped', replyTo: 'q-a' });

    await remove(userId, 'q-a');
    expect(db.prepare('SELECT COUNT(*) AS n FROM copilot_turn_metrics WHERE trip_id = ?').get(removeTripId).n).toBe(1);
    db.prepare('DELETE FROM copilot_turn_metrics WHERE trip_id = ?').run(removeTripId);
  });

  it('persistTurn writes reply_to as the saved question id', async () => {
    mockStreamCopilotResponse.mockImplementationOnce(async (msgs, ctx, res, req, persistTurn) => {
      await persistTurn({ assistantText: 'Reply', operations: null, notice: null });
      return 'Reply';
    });
    await askQuestion('Linked question');

    const question = getDb().prepare(
      "SELECT id FROM copilot_messages WHERE trip_id = ? AND role = 'user'",
    ).get(removeTripId);
    const reply = getDb().prepare(
      "SELECT reply_to FROM copilot_messages WHERE trip_id = ? AND role = 'assistant'",
    ).get(removeTripId);
    expect(reply.reply_to).toBe(question.id);
  });

  it('GET /history carries userId on user rows and null on assistant rows', async () => {
    seed('q-a', 'user', otherUserId);
    seed('a-a', 'assistant', null, { replyTo: 'q-a' });

    const res = makeRes();
    await callHandler('get', `/${removeTripId}/copilot/history`, asUser(userId), res);
    const byId = Object.fromEntries(res._body.messages.map((m) => [m.id, m]));
    expect(byId['q-a'].userId).toBe(otherUserId);
    expect(byId['a-a'].userId).toBeNull();
  });
});
