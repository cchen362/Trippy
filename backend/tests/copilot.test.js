import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';

// --- Mock claude.js service BEFORE importing the route ---
const mockStreamCopilotResponse = vi.fn();

vi.mock('../src/services/claude.js', () => ({
  streamCopilotResponse: mockStreamCopilotResponse,
}));

// --- Mock stops.js service to avoid Unsplash calls ---
const mockCreateStop = vi.fn();
const mockDeleteStop = vi.fn();
const mockUpdateStop = vi.fn();

vi.mock('../src/services/stops.js', () => ({
  createStop: mockCreateStop,
  deleteStop: mockDeleteStop,
  updateStop: mockUpdateStop,
}));

// Import route handlers after mocks are set up
const { default: copilotRouter } = await import('../src/routes/copilot.js');

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

let tmpDir;
let userId;
let tripId;
let dayId;
let stopId;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trippy-copilot-test-'));
  initDb(join(tmpDir, 'test.db'));
  runMigrations();

  const db = getDb();

  // Create a user
  const user = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, is_admin)
    VALUES ('testuser', 'hash', 'Test User', 1)
    RETURNING id
  `).get();
  userId = user.id;

  // Create a trip
  const trip = db.prepare(`
    INSERT INTO trips (title, owner_id, destinations, destination_countries, start_date, end_date, travellers, interest_tags, pace, status)
    VALUES ('Test Trip', ?, '[]', '[]', '2026-05-01', '2026-05-03', 'couple', '[]', 'moderate', 'upcoming')
    RETURNING id
  `).get(userId);
  tripId = trip.id;

  // Create a day
  const day = db.prepare(`
    INSERT INTO days (trip_id, date, city)
    VALUES (?, '2026-05-01', 'Test City')
    RETURNING id
  `).get(tripId);
  dayId = day.id;

  // Create a stop
  const stop = db.prepare(`
    INSERT INTO stops (day_id, title, type, sort_order)
    VALUES (?, 'Test Stop', 'experience', 1)
    RETURNING id
  `).get(dayId);
  stopId = stop.id;
});

afterAll(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: invoke a route handler directly
// ---------------------------------------------------------------------------

function makeReq(overrides = {}) {
  return {
    user: { id: userId },
    params: { tripId },
    body: {},
    trip: null, // set by requireTripAccess; we bypass middleware in direct calls
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    _ended: false,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    end() { this._ended = true; },
  };
  return res;
}

// Invoke a route handler by finding it on the router stack.
// Intercepts res.json() so sync handlers that call res.json() resolve the promise.
async function callHandler(method, path, req, res) {
  return new Promise((resolve, reject) => {
    // Wrap res.json so both sync and async handlers resolve properly
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

    // Find the matching route in the router stack
    const stack = copilotRouter.stack;
    for (const layer of stack) {
      if (!layer.route) continue;
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];

      if (routeMethod !== method) continue;

      // Simple path matching: replace :param with regex
      const regexPath = routePath.replace(/:([^/]+)/g, '([^/]+)');
      const match = path.match(new RegExp(`^${regexPath}$`));
      if (!match) continue;

      // Extract params
      const paramNames = [...routePath.matchAll(/:([^/]+)/g)].map((m) => m[1]);
      paramNames.forEach((name, i) => {
        req.params = req.params || {};
        req.params[name] = match[i + 1];
      });

      // Get the last handler (after middleware)
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
// 1. GET history returns messages in order
// ---------------------------------------------------------------------------

describe('GET /trips/:tripId/copilot/history', () => {
  it('returns messages in ascending order', async () => {
    const db = getDb();

    // Insert two messages with deterministic timestamps
    db.prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
      VALUES ('msg-1', ?, ?, 'user', 'Hello copilot', '2026-05-01T10:00:00')
    `).run(tripId, userId);

    db.prepare(`
      INSERT INTO copilot_messages (id, trip_id, user_id, role, content, created_at)
      VALUES ('msg-2', ?, NULL, 'assistant', 'Hello traveller', '2026-05-01T10:00:01')
    `).run(tripId);

    const req = makeReq({ params: { tripId } });
    const res = makeRes();

    await callHandler('get', `/${tripId}/copilot/history`, req, res);

    expect(res._body).toBeDefined();
    expect(Array.isArray(res._body.messages)).toBe(true);

    const msgs = res._body.messages.filter((m) => m.id === 'msg-1' || m.id === 'msg-2');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe('msg-1');
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Hello copilot');
    expect(msgs[1].id).toBe('msg-2');
    expect(msgs[1].role).toBe('assistant');

    // Clean up
    db.prepare('DELETE FROM copilot_messages WHERE id IN (?, ?)').run('msg-1', 'msg-2');
  });
});

// ---------------------------------------------------------------------------
// 2. POST saves user message and calls streamCopilotResponse
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/copilot', () => {
  it('saves user message and calls streamCopilotResponse', async () => {
    mockStreamCopilotResponse.mockResolvedValue('Assistant reply');

    const req = makeReq({
      params: { tripId },
      body: { message: 'What should I see in Chengdu?' },
    });
    const res = makeRes();

    await callHandler('post', `/${tripId}/copilot`, req, res);

    expect(mockStreamCopilotResponse).toHaveBeenCalledOnce();

    const db = getDb();
    const userMsg = db.prepare(
      "SELECT * FROM copilot_messages WHERE trip_id = ? AND role = 'user' AND content = ?",
    ).get(tripId, 'What should I see in Chengdu?');

    expect(userMsg).toBeDefined();
    expect(userMsg.user_id).toBe(userId);

    // Clean up
    db.prepare('DELETE FROM copilot_messages WHERE trip_id = ? AND content = ?')
      .run(tripId, 'What should I see in Chengdu?');
  });

  // 3. POST saves assistant response after streaming
  it('saves assistant response after streaming completes', async () => {
    const assistantText = 'Visit Jinli Ancient Street!';
    mockStreamCopilotResponse.mockResolvedValue(assistantText);

    const req = makeReq({
      params: { tripId },
      body: { message: 'Recommend something in Chengdu' },
    });
    const res = makeRes();

    await callHandler('post', `/${tripId}/copilot`, req, res);

    const db = getDb();
    const assistantMsg = db.prepare(
      "SELECT * FROM copilot_messages WHERE trip_id = ? AND role = 'assistant' AND content = ?",
    ).get(tripId, assistantText);

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.user_id).toBeNull();

    // Clean up
    db.prepare("DELETE FROM copilot_messages WHERE trip_id = ? AND (content = ? OR content = ?)")
      .run(tripId, 'Recommend something in Chengdu', assistantText);
  });

  // 4. POST with missing message body returns 400
  it('returns 400 when message is missing', async () => {
    const req = makeReq({
      params: { tripId },
      body: {},
    });
    const res = makeRes();

    await expect(callHandler('post', `/${tripId}/copilot`, req, res)).rejects.toMatchObject({
      status: 400,
      message: 'message is required',
    });

    // streamCopilotResponse must NOT have been called
    expect(mockStreamCopilotResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. POST /apply with valid add_stop mutation
// ---------------------------------------------------------------------------

describe('POST /trips/:tripId/copilot/apply', () => {
  it('calls createStop for add_stop operations', async () => {
    const newStop = { id: 'new-stop-1', dayId, title: 'Giant Panda Base', type: 'experience' };
    mockCreateStop.mockResolvedValue(newStop);

    const req = makeReq({
      params: { tripId },
      body: {
        mutation: {
          operations: [
            { action: 'add_stop', dayId, stop: { title: 'Giant Panda Base', type: 'experience' } },
          ],
        },
      },
    });
    const res = makeRes();

    await callHandler('post', `/${tripId}/copilot/apply`, req, res);

    expect(mockCreateStop).toHaveBeenCalledOnce();
    expect(mockCreateStop).toHaveBeenCalledWith(
      userId,
      dayId,
      { title: 'Giant Panda Base', type: 'experience' },
    );
    expect(res._body).toBeDefined();
    expect(res._body.trip).toBeDefined();
  });

  // 6. POST /apply with invalid operations array returns 400
  it('returns 400 when operations is not an array', async () => {
    const req = makeReq({
      params: { tripId },
      body: { mutation: { operations: 'not-an-array' } },
    });
    const res = makeRes();

    await expect(callHandler('post', `/${tripId}/copilot/apply`, req, res)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns 400 when mutation is missing entirely', async () => {
    const req = makeReq({
      params: { tripId },
      body: {},
    });
    const res = makeRes();

    await expect(callHandler('post', `/${tripId}/copilot/apply`, req, res)).rejects.toMatchObject({
      status: 400,
    });
  });

  // 7. POST /apply with unauthorized stopId returns 403/404 (from assertStopAccess)
  it('throws when stopId does not belong to this user', async () => {
    const req = makeReq({
      params: { tripId },
      body: {
        mutation: {
          operations: [
            { action: 'remove_stop', stopId: 'non-existent-stop-id' },
          ],
        },
      },
    });
    const res = makeRes();

    // assertStopAccess throws 404 for stops not found/accessible
    await expect(callHandler('post', `/${tripId}/copilot/apply`, req, res)).rejects.toMatchObject({
      status: 404,
    });

    // deleteStop must NOT have been called since validation failed
    expect(mockDeleteStop).not.toHaveBeenCalled();
  });

  it('executes remove_stop via deleteStop for valid stopId', async () => {
    mockDeleteStop.mockReturnValue({ ok: true });

    const req = makeReq({
      params: { tripId },
      body: {
        mutation: {
          operations: [
            { action: 'remove_stop', stopId },
          ],
        },
      },
    });
    const res = makeRes();

    await callHandler('post', `/${tripId}/copilot/apply`, req, res);

    expect(mockDeleteStop).toHaveBeenCalledOnce();
    expect(mockDeleteStop).toHaveBeenCalledWith(userId, stopId);
  });
});
