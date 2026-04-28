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

// ---------------------------------------------------------------------------
// discoverDestination
// ---------------------------------------------------------------------------

// Build a mock stream that emits NDJSON text lines then resolves.
// Re-used by streamCopilotResponse tests too.
function makeMockStream(chunks, finalText) {
  const listeners = {};
  const stream = {
    on(event, cb) {
      listeners[event] = cb;
      return stream;
    },
    async finalMessage() {
      for (const chunk of chunks) {
        if (listeners['text']) listeners['text'](chunk);
      }
      return { content: [{ type: 'text', text: finalText ?? chunks.join('') }] };
    },
  };
  return stream;
}

function ndjsonChunks(categories) {
  return categories.map((cat) => JSON.stringify(cat) + '\n');
}

describe('discoverDestination — NDJSON streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls messages.stream with haiku model and destination in user message', async () => {
    const chunks = ndjsonChunks([{ category: 'culture', items: [] }]);
    mockStream.mockReturnValue(makeMockStream(chunks));

    await discoverDestination('kyoto', []);

    expect(mockStream).toHaveBeenCalledOnce();
    const call = mockStream.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.messages[0].content).toContain('kyoto');
  });

  it('returns accumulated categories parsed from NDJSON text events', async () => {
    const cats = [
      { category: 'culture', items: [{ name: 'Kinkakuji', lat: 35.0, lng: 135.7 }] },
      { category: 'food', items: [] },
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const result = await discoverDestination('kyoto', []);

    expect(result).toHaveLength(2);
    expect(result[0].category).toBe('culture');
    expect(result[1].category).toBe('food');
  });

  it('calls onCategory callback for each parsed category', async () => {
    const cats = [
      { category: 'nature', items: [{ name: 'Arashiyama', lat: 35.0, lng: 135.6 }] },
      { category: 'nightlife', items: [] },
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const received = [];
    await discoverDestination('kyoto', [], (cat) => received.push(cat));

    expect(received).toHaveLength(2);
    expect(received[0].category).toBe('nature');
    expect(received[1].category).toBe('nightlife');
  });

  it('deduplicates items with the same normalized name across categories', async () => {
    const cats = [
      { category: 'culture', items: [{ name: 'Dujiangyan Scenic Area' }, { name: 'Fushimi Inari' }] },
      // 'Dujiangyan & Scenic Area' normalizes to the same key — should be dropped
      { category: 'hidden_gems', items: [{ name: 'Dujiangyan & Scenic Area' }, { name: 'Nijo Castle' }] },
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const result = await discoverDestination('kyoto', []);

    const allItems = result.flatMap((c) => c.items);
    const names = allItems.map((i) => i.name);
    expect(names.filter((n) => n.toLowerCase().includes('dujiangyan')).length).toBe(1);
    expect(names).toContain('Fushimi Inari');
    expect(names).toContain('Nijo Castle');
  });

  it('silently skips invalid NDJSON lines', async () => {
    const chunks = [
      'not valid json\n',
      JSON.stringify({ category: 'food', items: [{ name: 'Ramen shop' }] }) + '\n',
      '{"missing_items_key": true}\n',
    ];
    mockStream.mockReturnValue(makeMockStream(chunks));

    const result = await discoverDestination('tokyo', []);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('food');
  });
});

// ---------------------------------------------------------------------------
// streamCopilotResponse
// ---------------------------------------------------------------------------

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
    on() { return this; },
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
