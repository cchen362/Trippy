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
const { discoverDestination, streamCopilotResponse, generatePhotoDescriptor, coerceSceneType } = await import('../src/services/claude.js');

// ---------------------------------------------------------------------------
// discoverDestination
// ---------------------------------------------------------------------------

// Build a mock stream that emits NDJSON text lines then resolves.
// Re-used by streamCopilotResponse tests too. stopReason is optional — when omitted it's
// derived from finalContent (tool_use present => 'tool_use', else 'end_turn'), matching real
// SDK behavior, so existing callers that never passed it keep working unmodified.
function makeMockStream(chunks, finalText, finalContent, stopReason) {
  const listeners = {};
  const stream = {
    on(event, cb) {
      listeners[event] = cb;
      return stream;
    },
    abort() {
      // Real SDK streams expose abort(); the mock just needs to be callable
      // without throwing for tests that don't care about abort behavior.
    },
    async finalMessage() {
      for (const chunk of chunks) {
        if (listeners['text']) listeners['text'](chunk);
      }
      const content = finalContent ?? [{ type: 'text', text: finalText ?? chunks.join('') }];
      const derivedStopReason = stopReason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
      return {
        content,
        stop_reason: derivedStopReason,
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    },
  };
  return stream;
}

// Builds a tool_use content block for the agentic-loop tests below.
function toolUseBlock(name, input, id = `tu_${name}`) {
  return { type: 'tool_use', id, name, input };
}

function ndjsonChunks(categories) {
  return categories.map((cat) => JSON.stringify(cat) + '\n');
}

// Four categories with at least one item each — the minimum yield
// discoverDestination now requires (see MIN_CATEGORIES_WITH_ITEMS in
// src/services/claude.js). Tests that aren't specifically exercising the
// minimum-yield guard use this fixture so they don't trip it incidentally.
const FOUR_HEALTHY_CATEGORIES = [
  { category: 'essentials', items: [{ name: 'Ngurah Rai Airport' }] },
  { category: 'culture', items: [{ name: 'Kinkakuji', lat: 35.0, lng: 135.7 }] },
  { category: 'food', items: [{ name: 'Ramen Alley' }] },
  { category: 'nature', items: [{ name: 'Arashiyama', lat: 35.0, lng: 135.6 }] },
];

describe('discoverDestination — NDJSON streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls messages.stream with haiku model, 64000 max_tokens, and destination in user message', async () => {
    const chunks = ndjsonChunks(FOUR_HEALTHY_CATEGORIES);
    mockStream.mockReturnValue(makeMockStream(chunks));

    await discoverDestination('kyoto', []);

    expect(mockStream).toHaveBeenCalledOnce();
    const call = mockStream.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    // Haiku 4.5's streaming output ceiling — raised from 16000, which
    // truncated the tail of every real generation (production incident:
    // categories systematically missing past the truncation point).
    expect(call.max_tokens).toBe(64000);
    expect(call.messages[0].content).toContain('kyoto');
  });

  it('returns accumulated categories parsed from NDJSON text events', async () => {
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(FOUR_HEALTHY_CATEGORIES)));

    const result = await discoverDestination('kyoto', []);

    expect(result).toHaveLength(4);
    expect(result.map((c) => c.category)).toEqual(['essentials', 'culture', 'food', 'nature']);
  });

  it('calls onCategory callback for each parsed category', async () => {
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(FOUR_HEALTHY_CATEGORIES)));

    const received = [];
    await discoverDestination('kyoto', [], (cat) => received.push(cat));

    expect(received).toHaveLength(4);
    expect(received.map((c) => c.category)).toEqual(['essentials', 'culture', 'food', 'nature']);
  });

  it('deduplicates items with the same normalized name across categories', async () => {
    const cats = [
      ...FOUR_HEALTHY_CATEGORIES.slice(0, 2),
      // 'Dujiangyan & Scenic Area' normalizes to the same key as
      // 'Dujiangyan Scenic Area' below — should be dropped
      { category: 'hidden_gems', items: [{ name: 'Dujiangyan Scenic Area' }, { name: 'Fushimi Inari' }] },
      { category: 'nightlife', items: [{ name: 'Dujiangyan & Scenic Area' }, { name: 'Nijo Castle' }] },
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const result = await discoverDestination('kyoto', []);

    const allItems = result.flatMap((c) => c.items);
    const names = allItems.map((i) => i.name);
    expect(names.filter((n) => n.toLowerCase().includes('dujiangyan')).length).toBe(1);
    expect(names).toContain('Fushimi Inari');
    expect(names).toContain('Nijo Castle');
  });

  it('drops unparseable lines, logs them loudly, and keeps the rest of the stream intact', async () => {
    const chunks = [
      'not valid json\n',
      ...ndjsonChunks(FOUR_HEALTHY_CATEGORIES),
      '{"missing_items_key": true}\n',
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStream.mockReturnValue(makeMockStream(chunks));

    const result = await discoverDestination('tokyo', []);

    // The garbage line is dropped and logged loudly (never silent).
    expect(errorSpy).toHaveBeenCalledWith(
      '[discover] dropped unparseable line (len=%d): %s',
      expect.any(Number),
      expect.stringContaining('not valid json'),
    );
    // The structurally-valid-but-fieldless line ({"missing_items_key":true})
    // has no category/items — dropped without a parse-failure log, and the
    // rest of the categories still come through untouched.
    expect(result).toHaveLength(4);
    expect(result.map((c) => c.category)).toEqual(['essentials', 'culture', 'food', 'nature']);

    errorSpy.mockRestore();
  });

  // Reproduces the production incident: the model wrapped its NDJSON output in
  // a pretty-printed JSON array, so every line had a trailing comma (invalid
  // standalone JSON) except the last, and the array's own `[`/`]` lines and
  // markdown fences appeared as extra lines. Only the final category
  // ('wellness') survived the old parser — the fix must recover all of them.
  it('recovers every category from a pretty-printed-JSON-array response with trailing commas', async () => {
    const cats = [
      { category: 'essentials', items: [{ name: 'Ngurah Rai Airport' }] },
      { category: 'culture', items: [{ name: 'Uluwatu Temple' }] },
      { category: 'food', items: [{ name: 'Warung Babi Guling' }] },
      { category: 'nature', items: [{ name: 'Tegallalang Rice Terrace' }] },
      { category: 'nightlife', items: [{ name: 'Potato Head Beach Club' }] },
      { category: 'hidden_gems', items: [{ name: 'Sidemen Valley' }] },
      { category: 'architecture', items: [{ name: 'Pura Ulun Danu Bratan' }] },
      { category: 'wellness', items: [{ name: 'Karsa Spa' }] },
    ];
    const chunks = [
      '```json\n',
      '[\n',
      ...cats.slice(0, -1).map((c) => `  ${JSON.stringify(c)},\n`),
      `  ${JSON.stringify(cats.at(-1))}\n`,
      ']\n',
      '```\n',
    ];
    mockStream.mockReturnValue(makeMockStream(chunks));

    const result = await discoverDestination('bali, indonesia (id)', []);

    expect(result).toHaveLength(8);
    expect(result.map((c) => c.category)).toEqual(cats.map((c) => c.category));
  });

  describe('category name normalization', () => {
    it('normalizes case/spacing variants onto the canonical category name', async () => {
      const cats = [
        { category: 'Hidden Gems', items: [{ name: 'Sidemen Valley' }] },
        ...FOUR_HEALTHY_CATEGORIES,
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      const result = await discoverDestination('bali', []);

      expect(result.map((c) => c.category)).toContain('hidden_gems');
      const hiddenGems = result.find((c) => c.items.some((i) => i.name === 'Sidemen Valley'));
      expect(hiddenGems.category).toBe('hidden_gems');
    });

    it('drops a category with a name that matches no canonical category, and logs it', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cats = [
        { category: 'shopping', items: [{ name: 'Beachwalk Mall' }] },
        ...FOUR_HEALTHY_CATEGORIES,
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      const result = await discoverDestination('bali', []);

      expect(result.map((c) => c.category)).not.toContain('shopping');
      expect(result).toHaveLength(4);
      expect(errorSpy).toHaveBeenCalledWith('[discover] dropped unknown category name: %s', 'shopping');

      errorSpy.mockRestore();
    });
  });

  describe('minimum-yield guard', () => {
    it('throws when fewer than 4 categories have at least one item', async () => {
      // Mirrors the production incident: a single populated category (plus
      // some empty/dropped ones) must not be treated as a usable generation.
      const cats = [
        { category: 'essentials', items: [] },
        { category: 'wellness', items: [{ name: 'Karsa Spa' }] },
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      await expect(discoverDestination('bali', [])).rejects.toThrow(/insufficient yield/);
    });

    it('throws with a message reporting categories/items parsed and lines dropped', async () => {
      const chunks = ['garbage line\n', ...ndjsonChunks([{ category: 'wellness', items: [{ name: 'Karsa Spa' }] }])];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockStream.mockReturnValue(makeMockStream(chunks));

      await expect(discoverDestination('bali', [])).rejects.toThrow(
        /1 of 1 parsed categories had items \(1 items total\), 1 lines dropped as unparseable/,
      );

      errorSpy.mockRestore();
    });

    it('succeeds when exactly 4 categories have items (the boundary)', async () => {
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(FOUR_HEALTHY_CATEGORIES)));

      const result = await discoverDestination('bali', []);

      expect(result).toHaveLength(4);
    });
  });
});

// ---------------------------------------------------------------------------
// streamCopilotResponse
// ---------------------------------------------------------------------------

// Minimal mock for Express res. Captures 'close' handlers so abort tests can fire them; the
// mock's destroyed/writableEnded fields mirror the real res shape write() guards against.
function makeMockRes() {
  const headers = {};
  const written = [];
  const closeHandlers = [];
  return {
    headers,
    written,
    flushed: false,
    ended: false,
    destroyed: false,
    writableEnded: false,
    setHeader(k, v) { headers[k] = v; },
    flushHeaders() { this.flushed = true; },
    write(chunk) { written.push(chunk); },
    end() { this.ended = true; this.writableEnded = true; },
    on(event, cb) {
      if (event === 'close') closeHandlers.push(cb);
      return this;
    },
    triggerClose() {
      closeHandlers.forEach((cb) => cb());
    },
  };
}

// Parses the SSE `data: {...}` chunks written to a mock res into plain event objects.
function parseEvents(res) {
  return res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
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

describe('streamCopilotResponse — tool-use proposal protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a proposal event carrying the tool_use operations', async () => {
    const operations = [{ action: 'remove_stop', stopId: 'stop-1' }];
    mockStream.mockReturnValue(makeMockStream(
      ['Sure.'],
      'Sure.',
      [
        { type: 'text', text: 'Sure.' },
        { type: 'tool_use', name: 'propose_itinerary_changes', input: { operations } },
      ],
    ));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'Remove the first stop' }], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    const proposalEvent = events.find((e) => e.type === 'proposal');
    const mutationEvent = events.find((e) => e.type === 'mutation');

    expect(proposalEvent).toBeDefined();
    expect(proposalEvent.operations).toEqual(operations);
    expect(mutationEvent).toBeUndefined();
  });

  it('does NOT emit a proposal event when the model returns only text', async () => {
    const fullText = 'Here is some travel advice with no changes.';
    mockStream.mockReturnValue(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'What should I see?' }], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    const proposalEvent = events.find((e) => e.type === 'proposal');

    expect(proposalEvent).toBeUndefined();
  });

  it('passes the propose_itinerary_changes tool to the Anthropic stream call', async () => {
    mockStream.mockReturnValue(makeMockStream(['done'], 'done'));

    const res = makeMockRes();
    await streamCopilotResponse([], {}, res);

    expect(mockStream.mock.calls[0][0].tools.map((t) => t.name)).toContain('propose_itinerary_changes');
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

  it('emits error event followed by a done event and ends when stream throws', async () => {
    const brokenStream = {
      on() { return brokenStream; },
      async finalMessage() { throw new Error('stream failed'); },
    };
    mockStream.mockReturnValue(brokenStream);

    const res = makeMockRes();
    await streamCopilotResponse([], {}, res);

    const events = res.written.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
    expect(events[0]).toEqual({ type: 'error', message: 'stream failed' });
    expect(events[1]).toEqual({ type: 'done' });
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

describe('streamCopilotResponse — agentic tool loop (Plan 12 Wave 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plain text turn: exactly one stream call, no tool SSE events, done event, text intact', async () => {
    const fullText = 'Kyoto has some lovely temples.';
    mockStream.mockReturnValueOnce(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    const returned = await streamCopilotResponse([{ role: 'user', content: 'tell me about kyoto' }], {}, res, {}, undefined, {});

    expect(mockStream).toHaveBeenCalledOnce();
    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'tool')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(returned).toBe(fullText);
  });

  it('multi-iteration: executes a query tool_use, feeds back a tool_result, and continues', async () => {
    const executor = vi.fn().mockResolvedValue({ catalogueState: 'fresh', places: [] });
    const iter1Content = [
      { type: 'text', text: 'Let me check.' },
      toolUseBlock('search_discovery_catalogue', { destination: 'Hangzhou' }, 'tu_1'),
    ];
    const iter2Content = [{ type: 'text', text: ' Here you go.' }];

    mockStream
      .mockReturnValueOnce(makeMockStream(['Let me check.'], undefined, iter1Content))
      .mockReturnValueOnce(makeMockStream([' Here you go.'], undefined, iter2Content));

    const res = makeMockRes();
    const fullText = await streamCopilotResponse(
      [{ role: 'user', content: 'suggestions in Hangzhou?' }], {}, res, {}, undefined,
      { search_discovery_catalogue: executor },
    );

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith({ destination: 'Hangzhou' });

    const secondCallMessages = mockStream.mock.calls[1][0].messages;
    const assistantMsg = secondCallMessages.find((m) => m.role === 'assistant' && m.content === iter1Content);
    expect(assistantMsg).toBeDefined();
    const userToolResultMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(userToolResultMsg.role).toBe('user');
    expect(userToolResultMsg.content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: JSON.stringify({ catalogueState: 'fresh', places: [] }),
    }]);

    const events = parseEvents(res);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(fullText).toBe('Let me check. Here you go.');
  });

  it('tool SSE ordering: started -> done bracket the executor, before the next iteration text', async () => {
    const executor = vi.fn().mockResolvedValue({ catalogueState: 'fresh', places: [] });
    mockStream
      .mockReturnValueOnce(makeMockStream(
        ['Let me check.'], undefined,
        [{ type: 'text', text: 'Let me check.' }, toolUseBlock('search_discovery_catalogue', { destination: 'Hangzhou' }, 'tu_1')],
      ))
      .mockReturnValueOnce(makeMockStream([' Here you go.'], undefined, [{ type: 'text', text: ' Here you go.' }]));

    const res = makeMockRes();
    await streamCopilotResponse(
      [{ role: 'user', content: 'suggestions in Hangzhou?' }], {}, res, {}, undefined,
      { search_discovery_catalogue: executor },
    );

    const events = parseEvents(res);
    const kinds = events.map((e) => (e.type === 'tool' ? `tool:${e.state}` : e.type));
    const startedIdx = kinds.indexOf('tool:started');
    const doneIdx = kinds.indexOf('tool:done');
    const secondTextIdx = kinds.lastIndexOf('text');

    expect(startedIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(startedIdx);
    expect(secondTextIdx).toBeGreaterThan(doneIdx);
  });

  it('caps executed query calls at 5 per turn and sends a budget notice for the 6th', async () => {
    const executor = vi.fn().mockResolvedValue({ ok: true });
    for (let i = 1; i <= 6; i += 1) {
      mockStream.mockReturnValueOnce(makeMockStream(
        [`iter${i}`], undefined,
        [toolUseBlock('search_discovery_catalogue', { destination: `Dest${i}` }, `tu_${i}`)],
      ));
    }
    mockStream.mockReturnValueOnce(makeMockStream(['final answer'], undefined, [{ type: 'text', text: 'final answer' }]));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'go' }], {}, res, {}, undefined, {
      search_discovery_catalogue: executor,
    });

    expect(mockStream).toHaveBeenCalledTimes(7);
    expect(executor).toHaveBeenCalledTimes(5);

    // The 7th stream call's messages carry the budget-notice tool_result for the capped tu_6.
    const seventhCallMessages = mockStream.mock.calls[6][0].messages;
    const lastUserMsg = seventhCallMessages[seventhCallMessages.length - 1];
    expect(lastUserMsg.content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'tu_6',
      content: 'Query tool budget for this turn is used up. Answer the traveller now with the information you already have.',
    }]);

    const events = parseEvents(res);
    const toolEvents = events.filter((e) => e.type === 'tool');
    expect(toolEvents).toHaveLength(10); // 5 executed calls x (started + done)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('hard-stops when the model calls a query tool again after the budget notice', async () => {
    const executor = vi.fn().mockResolvedValue({ ok: true });
    for (let i = 1; i <= 6; i += 1) {
      mockStream.mockReturnValueOnce(makeMockStream(
        [`iter${i}`], undefined,
        [toolUseBlock('search_discovery_catalogue', { destination: `Dest${i}` }, `tu_${i}`)],
      ));
    }
    // 7th response ALSO contains only a (now over-cap) query tool_use — the model ignored the
    // budget notice sent alongside tu_6's tool_result. This must break the loop instead of
    // continuing forever.
    mockStream.mockReturnValueOnce(makeMockStream(
      ['iter7'], undefined,
      [toolUseBlock('search_discovery_catalogue', { destination: 'Dest7' }, 'tu_7')],
    ));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'go' }], {}, res, {}, undefined, {
      search_discovery_catalogue: executor,
    });

    expect(mockStream).toHaveBeenCalledTimes(7);
    expect(executor).toHaveBeenCalledTimes(5);
    const events = parseEvents(res);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('terminal propose_itinerary_changes wins over a query tool_use in the same response', async () => {
    const executor = vi.fn();
    const operations = [{ action: 'remove_stop', stopId: 'stop-1' }];
    mockStream.mockReturnValueOnce(makeMockStream(
      ['Sure, removing that.'], undefined,
      [
        { type: 'text', text: 'Sure, removing that.' },
        toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_x'),
        { type: 'tool_use', id: 'tu_term', name: 'propose_itinerary_changes', input: { operations } },
      ],
    ));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'remove it' }], {}, res, {}, undefined, {
      search_discovery_catalogue: executor,
    });

    expect(mockStream).toHaveBeenCalledOnce();
    expect(executor).not.toHaveBeenCalled();
    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'tool')).toBeUndefined();
    const proposalEvent = events.find((e) => e.type === 'proposal');
    expect(proposalEvent).toBeDefined();
    expect(proposalEvent.operations).toEqual(operations);
  });

  it('aborts the live stream when the client drops the SSE connection mid-iteration', async () => {
    // finalMessage() fires the captured 'close' handler before resolving, simulating the
    // client dropping the connection while the stream is still live.
    const res = makeMockRes();
    let abortCalled = false;
    const abortableStream = {
      on(event, cb) {
        if (event === 'text') abortableStream._textCb = cb;
        return abortableStream;
      },
      abort() { abortCalled = true; },
      async finalMessage() {
        if (abortableStream._textCb) abortableStream._textCb('partial');
        res.triggerClose();
        return { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    mockStream.mockReturnValueOnce(abortableStream);

    await streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, res, {}, undefined, {});

    expect(abortCalled).toBe(true);
    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
  });

  it('logs summed usage and iteration/query-call counts across iterations', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const executor = vi.fn().mockResolvedValue({ ok: true });
    mockStream
      .mockReturnValueOnce(makeMockStream(
        ['iter1'], undefined,
        [toolUseBlock('search_discovery_catalogue', { destination: 'X' }, 'tu_1')],
      ))
      .mockReturnValueOnce(makeMockStream(['iter2'], undefined, [{ type: 'text', text: 'iter2' }]));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'go' }], {}, res, {}, undefined, {
      search_discovery_catalogue: executor,
    });

    const usageCall = logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('turn usage'));
    expect(usageCall).toBeDefined();
    expect(usageCall[0]).toContain('iterations=%d');
    expect(usageCall[0]).toContain('queryCalls=%d');
    const [inputTokens, outputTokens, , , iterationsArg, queryCallsArg] = usageCall.slice(1);
    expect(inputTokens).toBe(20); // 10 + 10 summed across 2 iterations
    expect(outputTokens).toBe(40); // 20 + 20 summed across 2 iterations
    expect(iterationsArg).toBe(2);
    expect(queryCallsArg).toBe(1);

    logSpy.mockRestore();
  });

  it('still works when called with the original 5-arg signature (no toolExecutors)', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['hi'], 'hi'));
    const res = makeMockRes();
    const persistTurn = vi.fn().mockResolvedValue(null);

    const returned = await streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, res, {}, persistTurn);

    expect(returned).toBe('hi');
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'hi', operations: null });
    const events = parseEvents(res);
    expect(events[events.length - 1].type).toBe('done');
  });
});

describe('generatePhotoDescriptor (Plan 10 Wave 3)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  function respondWith(text) {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text }] });
  }

  it('parses a well-formed descriptor', async () => {
    respondWith('```json\n{"photoQuery": "steaming hotpot table Chengdu", "sceneType": "food_drink"}\n```');

    const result = await generatePhotoDescriptor({ title: 'Hotpot Spot', city: 'Chengdu', country: 'China', type: 'food' });

    expect(result).toEqual({ photoQuery: 'steaming hotpot table Chengdu', sceneType: 'food_drink' });
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5-20251001' });
  });

  it('coerces an invalid sceneType to null while keeping a valid photoQuery', async () => {
    respondWith('```json\n{"photoQuery": "night market skewers", "sceneType": "not_a_real_scene"}\n```');

    const result = await generatePhotoDescriptor({ title: 'Night Market', type: 'food' });

    expect(result).toEqual({ photoQuery: 'night market skewers', sceneType: null });
  });

  it('caps photoQuery at 8 words', async () => {
    respondWith('```json\n{"photoQuery": "one two three four five six seven eight nine ten", "sceneType": "generic"}\n```');

    const result = await generatePhotoDescriptor({ title: 'Long Query Place' });

    expect(result.photoQuery.split(/\s+/)).toHaveLength(8);
  });

  it('returns null when the response has no fenced JSON block', async () => {
    respondWith('Sorry, I cannot help with that.');

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
  });

  it('returns null when the JSON is malformed', async () => {
    respondWith('```json\n{"photoQuery": "broken\n```');

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
  });

  it('returns null when photoQuery is missing or empty', async () => {
    respondWith('```json\n{"sceneType": "market"}\n```');

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
  });

  it('returns null (never throws) when the API call fails', async () => {
    mockCreate.mockRejectedValue(new Error('Anthropic outage'));

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
  });
});

describe('coerceSceneType (Plan 10 Wave 3)', () => {
  it('passes through every D8 enum member', () => {
    expect(coerceSceneType('temple_shrine')).toBe('temple_shrine');
    expect(coerceSceneType('generic')).toBe('generic');
  });

  it('coerces anything else — including null/undefined/empty string — to null', () => {
    expect(coerceSceneType('bogus')).toBeNull();
    expect(coerceSceneType(null)).toBeNull();
    expect(coerceSceneType(undefined)).toBeNull();
    expect(coerceSceneType('')).toBeNull();
  });
});
