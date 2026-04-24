import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock @anthropic-ai/sdk before importing the service ---
const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    })),
  };
});

// Config module mock — avoids env var validation
vi.mock('../src/config.js', () => ({
  config: { anthropicApiKey: 'test-key' },
}));

// Import after mocks are in place
const { discoverDestination, streamCopilotResponse } = await import('../src/services/claude.js');

// Helper: build a minimal valid discovery response payload
function makeDiscoveryResponse(jsonText) {
  return {
    content: [{ type: 'text', text: jsonText }],
  };
}

const VALID_DISCOVERY_JSON = JSON.stringify({
  culture: [],
  food: [],
  nature: [],
  nightlife: [],
  hidden_gems: [],
});

// ---------------------------------------------------------------------------
// discoverDestination
// ---------------------------------------------------------------------------

describe('discoverDestination — system prompt structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(makeDiscoveryResponse(VALID_DISCOVERY_JSON));
  });

  it('calls messages.create with correct model and includes destination in system prompt', async () => {
    await discoverDestination('Kyoto', ['culture', 'food'], 'relaxed', 2);

    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0];

    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.system).toContain('Kyoto');
    expect(call.system).toContain('2 people');
    expect(call.system).toContain('relaxed');
    expect(call.system).toContain('culture, food');
  });

  it('includes web_search tool on first attempt', async () => {
    await discoverDestination('Paris', ['nightlife'], 'fast', 1);

    const call = mockCreate.mock.calls[0][0];
    expect(call.tools).toBeDefined();
    expect(call.tools[0].name).toBe('web_search');
    expect(call.tools[0].type).toBe('web_search_20250305');
  });

  it('returns parsed results and source="web" on success', async () => {
    const result = await discoverDestination('Tokyo', ['food'], 'moderate', 3);

    expect(result.source).toBe('web');
    expect(result.results).toEqual({
      culture: [],
      food: [],
      nature: [],
      nightlife: [],
      hidden_gems: [],
    });
  });
});

describe('discoverDestination — fallback when web_search tool throws', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries without tools and returns source="ai"', async () => {
    // First call (with tools) throws a "tool not available" error
    mockCreate
      .mockRejectedValueOnce(new Error('tool_use not supported'))
      .mockResolvedValueOnce(makeDiscoveryResponse(VALID_DISCOVERY_JSON));

    const result = await discoverDestination('Rome', ['history'], 'relaxed', 2);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Second call must not include tools
    const secondCall = mockCreate.mock.calls[1][0];
    expect(secondCall.tools).toBeUndefined();

    expect(result.source).toBe('ai');
    expect(result.results).toBeDefined();
  });
});

describe('discoverDestination — invalid JSON response throws 502', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws 502 when web response is not valid JSON', async () => {
    mockCreate.mockResolvedValue(makeDiscoveryResponse('This is not JSON at all'));

    await expect(discoverDestination('Berlin', [], 'moderate', 1)).rejects.toMatchObject({
      message: 'Discovery response was not valid JSON',
      status: 502,
    });
  });

  it('throws 502 when fallback (ai) response is not valid JSON', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('tool not enabled'))
      .mockResolvedValueOnce(makeDiscoveryResponse('still not json'));

    await expect(discoverDestination('Berlin', [], 'moderate', 1)).rejects.toMatchObject({
      message: 'Discovery response was not valid JSON',
      status: 502,
    });
  });
});

// ---------------------------------------------------------------------------
// streamCopilotResponse
// ---------------------------------------------------------------------------

// Build a mock stream that emits text events synchronously then resolves
function makeMockStream(chunks, finalText) {
  const listeners = {};

  const stream = {
    on(event, cb) {
      listeners[event] = cb;
      return stream;
    },
    async finalMessage() {
      // Fire text events synchronously before resolving
      for (const chunk of chunks) {
        if (listeners['text']) listeners['text'](chunk);
      }
      return {
        content: [{ type: 'text', text: finalText }],
      };
    },
  };

  return stream;
}

// Minimal mock for Express res
function makeMockRes() {
  const headers = {};
  const written = [];
  return {
    headers,
    written,
    flushed: false,
    ended: false,
    setHeader(k, v) { headers[k] = v; },
    flushHeaders() { this.flushed = true; },
    write(chunk) { written.push(chunk); },
    end() { this.ended = true; },
  };
}

describe('streamCopilotResponse — SSE headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets correct SSE headers before writing', async () => {
    const chunks = ['Hello ', 'world'];
    const fullText = 'Hello world';
    mockStream.mockReturnValue(makeMockStream(chunks, fullText));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'Hi' }], {}, res);

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['Cache-Control']).toBe('no-cache');
    expect(res.headers['Connection']).toBe('keep-alive');
    expect(res.flushed).toBe(true);
  });

  it('calls res.end() after streaming completes', async () => {
    mockStream.mockReturnValue(makeMockStream(['done'], 'done'));
    const res = makeMockRes();
    await streamCopilotResponse([], {}, res);
    expect(res.ended).toBe(true);
  });
});

describe('streamCopilotResponse — mutation JSON block extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts and emits mutation event when JSON block is present', async () => {
    const mutation = { operations: [{ action: 'remove_stop', stopId: 'stop-1' }] };
    const fullText = `Sure, I'll remove that stop.\n\`\`\`json\n${JSON.stringify(mutation)}\n\`\`\``;

    mockStream.mockReturnValue(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'Remove the first stop' }], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    const mutationEvent = events.find((e) => e.type === 'mutation');

    expect(mutationEvent).toBeDefined();
    expect(mutationEvent.mutation).toEqual(mutation);
  });

  it('does NOT emit mutation event when no JSON block present', async () => {
    const fullText = 'Here is some travel advice with no changes.';
    mockStream.mockReturnValue(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'What should I see?' }], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    const mutationEvent = events.find((e) => e.type === 'mutation');

    expect(mutationEvent).toBeUndefined();
  });

  it('always ends with a done event', async () => {
    const fullText = 'Simple response.';
    mockStream.mockReturnValue(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    await streamCopilotResponse([], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    const lastEvent = events[events.length - 1];

    expect(lastEvent.type).toBe('done');
  });

  it('emits error event and ends when stream throws', async () => {
    const brokenStream = {
      on() { return brokenStream; },
      async finalMessage() { throw new Error('stream failed'); },
    };
    mockStream.mockReturnValue(brokenStream);

    const res = makeMockRes();
    await streamCopilotResponse([], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    expect(events[0]).toEqual({ type: 'error', message: 'stream failed' });
    expect(res.ended).toBe(true);
  });
});

describe('streamCopilotResponse — return value', () => {
  it('returns the full text string', async () => {
    const fullText = 'The full copilot reply text.';
    mockStream.mockReturnValue(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    const returned = await streamCopilotResponse([], {}, res);

    expect(returned).toBe(fullText);
  });
});
