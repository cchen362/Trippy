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
