import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

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
const {
  extractBookings, discoverDestination, streamCopilotResponse, generatePhotoDescriptor, coerceSceneType,
  normalizeName, stripEditorialNamePrefix, sanitizeGeneratedAliases,
  MODEL_PROFILES, profileFor, requestSettings, classifyStop, COPILOT_PING_INTERVAL_MS,
  DISCOVERY_SELECTION_RULES, discoverySystemPrompt,
  EXTRACTION_MODEL, PHOTO_DESCRIPTOR_MODEL, COPILOT_MODEL, DISCOVERY_MODEL,
  EXTRACTION_SYSTEM, EXTRACTION_OUTPUT_SCHEMA, EXTRACTION_OUTPUT_FORMAT,
  EXTRACTION_DETAIL_FIELDS, EXTRACTION_CONFIDENCE_FIELDS, validateAgainstSchema, toAppExtraction,
  PHOTO_DESCRIPTOR_OUTPUT_SCHEMA, PHOTO_DESCRIPTOR_OUTPUT_FORMAT, PHOTO_DESCRIPTOR_SYSTEM, SCENE_TYPES,
} = await import('../src/services/claude.js');

// ---------------------------------------------------------------------------
// discoverDestination
// ---------------------------------------------------------------------------

// Build a mock stream that emits NDJSON text lines then resolves.
// Re-used by streamCopilotResponse tests too. stopReason is optional — when omitted it's
// derived from finalContent (tool_use present => 'tool_use', else 'end_turn'), matching real
// SDK behavior, so existing callers that never passed it keep working unmodified.
// extras (optional): { usage, stopDetails, currentMessage } — usage replaces the default
// 10/20 pair, stopDetails becomes stop_details on the final message (SDK >= 0.99 streams carry
// it), currentMessage is the SDK's partial snapshot a rejected stream still exposes.
function makeMockStream(chunks, finalText, finalContent, stopReason, extras = {}) {
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
      for (const event of extras.streamEvents ?? []) {
        if (listeners['streamEvent']) listeners['streamEvent'](event);
      }
      for (const chunk of chunks) {
        if (listeners['text']) listeners['text'](chunk);
      }
      const content = finalContent ?? [{ type: 'text', text: finalText ?? chunks.join('') }];
      const derivedStopReason = stopReason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
      return {
        content,
        stop_reason: derivedStopReason,
        ...(extras.stopDetails ? { stop_details: extras.stopDetails } : {}),
        usage: extras.usage ?? { input_tokens: 10, output_tokens: 20 },
      };
    },
  };
  if (extras.currentMessage) stream.currentMessage = extras.currentMessage;
  return stream;
}

// Builds a tool_use content block for the agentic-loop tests below.
function toolUseBlock(name, input, id = `tu_${name}`) {
  return { type: 'tool_use', id, name, input };
}

function ndjsonChunks(categories) {
  return categories.map((cat) => JSON.stringify(cat) + '\n');
}

// Four categories with at least one item each — a short but usable generation
// (D-36-1: discoverDestination returns anything with a usable item and completeness is
// judged at read time). Tests that aren't specifically exercising completeness use this
// fixture as a small, valid stream.
const FOUR_HEALTHY_CATEGORIES = [
  { category: 'essentials', items: [{ name: 'Ngurah Rai Airport' }] },
  { category: 'culture', items: [{ name: 'Kinkakuji', lat: 35.0, lng: 135.7 }] },
  { category: 'food', items: [{ name: 'Ramen Alley' }] },
  { category: 'nature', items: [{ name: 'Arashiyama', lat: 35.0, lng: 135.6 }] },
];

// ---------------------------------------------------------------------------
// stripEditorialNamePrefix (Plan 27 W4.1b) — enforcement of the "name" prompt
// instruction, not the wording. See M2 in claude.js for why this is colon-only.
// ---------------------------------------------------------------------------

describe('stripEditorialNamePrefix', () => {
  it('strips a real editorial/award prefix', () => {
    expect(stripEditorialNamePrefix('Michelin Bib Gourmand: Ay-Chung Flour-Shaping'))
      .toBe('Ay-Chung Flour-Shaping');
  });

  it('preserves a trailing CJK bracket when stripping the prefix', () => {
    expect(stripEditorialNamePrefix('Michelin Bib Gourmand: Lao Deng Beef Noodles (老鄧牛肉麵)'))
      .toBe('Lao Deng Beef Noodles (老鄧牛肉麵)');
  });

  it('does not fire on a colon inside brackets (protects opening-hours ranges)', () => {
    expect(stripEditorialNamePrefix('Some Temple (open 9:00-17:00)'))
      .toBe('Some Temple (open 9:00-17:00)');
  });

  it('does not fire when a digit sits directly next to the colon', () => {
    expect(stripEditorialNamePrefix('Ratio 9:16 Rooftop Bar')).toBe('Ratio 9:16 Rooftop Bar');
  });

  it('does not fire when the head exceeds 5 words (more likely a real name than a label)', () => {
    const name = 'One Two Three Four Five Six: Something';
    expect(stripEditorialNamePrefix(name)).toBe(name);
  });

  it('does not fire when the tail has no letters or numbers', () => {
    expect(stripEditorialNamePrefix('Editorial Label: ---')).toBe('Editorial Label: ---');
  });

  // Negative case that matters most: M2 measured that ~10% of dash-shaped names put the real
  // place name on the RIGHT of the dash. Stripping on dash would destroy those names with no
  // way to tell which side is real, so this function must never act on a dash — only a colon.
  it('does not touch a dash-shaped name (dashes are handled by the prompt alone, not this function)', () => {
    expect(stripEditorialNamePrefix('Sichuan University Campus – Architectural Vernacular & Student Life'))
      .toBe('Sichuan University Campus – Architectural Vernacular & Student Life');
    expect(stripEditorialNamePrefix('Rooftop Cocktail Bar — Yu Shang (玉尚)'))
      .toBe('Rooftop Cocktail Bar — Yu Shang (玉尚)');
  });

  it('returns a name with no colon unchanged (identity)', () => {
    expect(stripEditorialNamePrefix('Fushimi Inari Taisha')).toBe('Fushimi Inari Taisha');
  });

  it('returns non-string/empty input unchanged without throwing', () => {
    expect(stripEditorialNamePrefix('')).toBe('');
    expect(stripEditorialNamePrefix(null)).toBe(null);
    expect(stripEditorialNamePrefix(undefined)).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// sanitizeGeneratedAliases (Plan 27 W4.3) — structural half of the "aliases"
// instruction. See the comment above the function in claude.js for the measured
// 5/98 A/B defect and why removing a name-identical alias is lossless.
// ---------------------------------------------------------------------------

describe('sanitizeGeneratedAliases', () => {
  it('drops an alias identical to the name (the measured Plan 27 W4.3 A/B defect: 5/98 items)', () => {
    expect(sanitizeGeneratedAliases(['Taipei Story House'], 'Taipei Story House')).toEqual([]);
  });

  it('drops an alias identical to the name after normalization (punctuation/case differ)', () => {
    expect(sanitizeGeneratedAliases(['taipei   STORY house!'], 'Taipei Story House')).toEqual([]);
  });

  it('keeps a genuine alias', () => {
    expect(sanitizeGeneratedAliases(['IAMM'], 'Islamic Arts Museum Malaysia')).toEqual(['IAMM']);
  });

  // This must NOT be treated as identical-to-name — it is the single most valuable alias shape
  // (the bare name when "name" carries a branch/location qualifier) and a regression here would
  // be silent, since it looks superficially similar to the name-identical case above.
  it('keeps the bare-name alias when the name carries a branch/location qualifier', () => {
    expect(sanitizeGeneratedAliases(['Din Tai Fung'], 'Din Tai Fung (Taipei Nanjing Location)'))
      .toEqual(['Din Tai Fung']);
  });

  it('drops within-list duplicates, keeping the first occurrence in order', () => {
    expect(sanitizeGeneratedAliases(['IAMM', 'Islamic Arts Museum', 'iamm'], 'Museum X'))
      .toEqual(['IAMM', 'Islamic Arts Museum']);
  });

  it('drops non-strings, empty, and whitespace-only entries, and trims survivors', () => {
    expect(sanitizeGeneratedAliases([42, null, undefined, '', '   ', '  Real Alias  '], 'Place'))
      .toEqual(['Real Alias']);
  });

  it('caps the result at 4 entries', () => {
    expect(sanitizeGeneratedAliases(['A', 'B', 'C', 'D', 'E'], 'Place')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns [] for undefined, null, or non-array input', () => {
    expect(sanitizeGeneratedAliases(undefined, 'Place')).toEqual([]);
    expect(sanitizeGeneratedAliases(null, 'Place')).toEqual([]);
    expect(sanitizeGeneratedAliases('not an array', 'Place')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = ['Alias One', 'Place', 'Alias One'];
    const inputCopy = [...input];
    sanitizeGeneratedAliases(input, 'Place');
    expect(input).toEqual(inputCopy);
  });

  it('still dedupes and caps when name is not a usable string', () => {
    expect(sanitizeGeneratedAliases(['A', 'A', 'B'], null)).toEqual(['A', 'B']);
    expect(sanitizeGeneratedAliases(['A', 'A', 'B'], undefined)).toEqual(['A', 'B']);
    expect(sanitizeGeneratedAliases(['A', 'A', 'B'], '')).toEqual(['A', 'B']);
  });
});

describe('discoverDestination — NDJSON streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls messages.stream with Haiku 5.5, thinking disabled at effort low, 48000 max_tokens, and destination in user message', async () => {
    const chunks = ndjsonChunks(FOUR_HEALTHY_CATEGORIES);
    mockStream.mockReturnValue(makeMockStream(chunks));

    await discoverDestination('kyoto', []);

    expect(mockStream).toHaveBeenCalledOnce();
    const call = mockStream.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-5-5');
    // Plan 30 W3 / D-30-6: about 2x the largest measured generation (22,715 output tokens).
    expect(call.max_tokens).toBe(48000);
    expect(call.thinking).toEqual({ type: 'disabled' });
    expect(call.output_config).toEqual({ effort: 'low' });
    expect(call.system).toBe(discoverySystemPrompt('claude-haiku-5-5'));
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

  it('sanitizes an editorial-prefixed name before it reaches onCategory and the accumulated result (W4.1b integration)', async () => {
    const cats = [
      { category: 'essentials', items: [{ name: 'Michelin Bib Gourmand: Ay-Chung Flour-Shaping' }] },
      ...FOUR_HEALTHY_CATEGORIES.slice(1),
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const received = [];
    const result = await discoverDestination('taipei', [], (cat) => received.push(cat));

    const essentialsFromCallback = received.find((c) => c.category === 'essentials');
    const essentialsFromResult = result.find((c) => c.category === 'essentials');
    expect(essentialsFromCallback.items[0].name).toBe('Ay-Chung Flour-Shaping');
    expect(essentialsFromResult.items[0].name).toBe('Ay-Chung Flour-Shaping');
  });

  it('sanitizes aliases against the STRIPPED name, not the raw editorial-prefixed one (W4.3 ordering)', async () => {
    const cats = [
      {
        category: 'essentials',
        items: [{
          name: 'Michelin Bib Gourmand: Lao Deng Beef Noodles',
          aliases: ['Lao Deng Beef Noodles'],
        }],
      },
      ...FOUR_HEALTHY_CATEGORIES.slice(1),
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const received = [];
    await discoverDestination('taipei', [], (cat) => received.push(cat));

    const essentials = received.find((c) => c.category === 'essentials');
    expect(essentials.items[0].name).toBe('Lao Deng Beef Noodles');
    expect(essentials.items[0].aliases).toEqual([]);
  });

  it('dedupes two items that differ only by their editorial prefix onto the sanitized name', async () => {
    const cats = [
      { category: 'essentials', items: [{ name: 'Michelin Bib Gourmand: Ay-Chung Flour-Shaping' }] },
      // 'culture' here duplicates the essentials item (post-sanitization) AND carries a second,
      // distinct item so the category still holds an item after the duplicate is dropped.
      { category: 'culture', items: [{ name: 'Award Winner: Ay-Chung Flour-Shaping' }, { name: 'Longshan Temple' }] },
      ...FOUR_HEALTHY_CATEGORIES.slice(2),
    ];
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

    const result = await discoverDestination('taipei', []);

    const allNames = result.flatMap((c) => c.items).map((i) => i.name);
    expect(allNames.filter((n) => n === 'Ay-Chung Flour-Shaping')).toHaveLength(1);
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

  // D-36-1: a short generation is returned, an empty one is an error, and completeness is
  // reported on the end line (D-36-3) rather than decided here.
  describe('completeness (D-36-1, D-36-3)', () => {
    function endLine(logSpy) {
      return logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith('[discover] end'));
    }

    it('returns a generation with only 3 categories of items, without throwing, and reports complete=false', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const cats = [
        { category: 'essentials', items: [{ name: 'Ngurah Rai Airport' }] },
        { category: 'culture', items: [{ name: 'Uluwatu Temple' }] },
        { category: 'wellness', items: [{ name: 'Karsa Spa' }] },
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      const result = await discoverDestination('bali', []);

      expect(result.map((c) => c.category)).toEqual(['essentials', 'culture', 'wellness']);
      expect(endLine(logSpy)[0]).toContain('complete=%s');
      // complete, deduped, unnamed follow categories/items/dropped
      expect(endLine(logSpy).slice(-3)).toEqual([false, 0, 0]);
      logSpy.mockRestore();
    });

    it('does not count a category with an empty items array toward completeness', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const cats = [
        { category: 'essentials', items: [] },
        { category: 'wellness', items: [{ name: 'Karsa Spa' }] },
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      const result = await discoverDestination('bali', []);

      expect(result).toHaveLength(2);
      expect(endLine(logSpy).slice(-3)).toEqual([false, 0, 0]);
      logSpy.mockRestore();
    });

    it('throws an empty-generation error when no category has a usable item', async () => {
      const cats = [
        { category: 'essentials', items: [] },
        { category: 'culture', items: [{ description: 'a nameless item' }] },
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      await expect(discoverDestination('bali', [])).rejects.toThrow(/empty generation for destination=bali/);
    });

    it('reports categories/items parsed and lines dropped in the empty-generation message', async () => {
      const chunks = ['garbage line\n', ...ndjsonChunks([{ category: 'wellness', items: [] }])];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockStream.mockReturnValue(makeMockStream(chunks));

      await expect(discoverDestination('bali', [])).rejects.toThrow(
        /0 of 1 parsed categories had items \(0 items total\), 1 lines dropped as unparseable/,
      );

      errorSpy.mockRestore();
    });

    it('counts a cross-category repeat as deduped and a nameless item as unnamed on the end line', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const cats = [
        { category: 'essentials', items: [{ name: 'Tanah Lot' }] },
        { category: 'culture', items: [{ name: 'Tanah Lot' }, { name: 'Uluwatu Temple' }, { description: 'no name given' }] },
      ];
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      const result = await discoverDestination('bali', []);

      expect(result.find((c) => c.category === 'culture').items.map((i) => i.name)).toEqual(['Uluwatu Temple']);
      expect(endLine(logSpy).slice(-3)).toEqual([false, 1, 1]);
      logSpy.mockRestore();
    });

    it('reports complete=true when all 8 categories have items', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      mockStream.mockReturnValue(makeMockStream(ndjsonChunks(cats)));

      await discoverDestination('bali', []);

      expect(endLine(logSpy).slice(-3)).toEqual([true, 0, 0]);
      logSpy.mockRestore();
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

  it('writes the turn event first when turnInfo carries the saved question id (D-32-2)', async () => {
    mockStream.mockReturnValue(makeMockStream(['Hello'], 'Hello'));
    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'Hi' }], {}, res, {}, undefined, {}, undefined, { messageId: 'q-123' });

    const events = parseEvents(res);
    expect(events[0]).toEqual({ type: 'turn', messageId: 'q-123' });
    expect(events.filter((e) => e.type === 'turn')).toHaveLength(1);
    expect(events.some((e) => e.type === 'text')).toBe(true);
  });

  it('writes no turn event without turnInfo', async () => {
    mockStream.mockReturnValue(makeMockStream(['Hello'], 'Hello'));
    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'Hi' }], {}, res);
    await streamCopilotResponse([{ role: 'user', content: 'Hi' }], {}, res, {}, undefined, {}, undefined, null);

    expect(parseEvents(res).some((e) => e.type === 'turn')).toBe(false);
  });
});

describe('streamCopilotResponse — tool-use proposal protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a proposal event carrying the tool_use operations', async () => {
    const operations = [{ action: 'remove_stop', stopId: 'stop-1' }];
    mockStream
      .mockReturnValueOnce(makeMockStream(
        ['Sure.'],
        'Sure.',
        [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', name: 'propose_itinerary_changes', input: { operations } },
        ],
      ))
      .mockReturnValueOnce(makeMockStream([' Removing it.'], ' Removing it.'));

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
    mockStream
      .mockReturnValueOnce(makeMockStream(
        ['Sure, removing that.'], undefined,
        [
          { type: 'text', text: 'Sure, removing that.' },
          toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_x'),
          { type: 'tool_use', id: 'tu_term', name: 'propose_itinerary_changes', input: { operations } },
        ],
      ))
      .mockReturnValueOnce(makeMockStream([' Done.'], undefined, [{ type: 'text', text: ' Done.' }]));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'remove it' }], {}, res, {}, undefined, {
      search_discovery_catalogue: executor,
    });

    // D-30-9: the propose call ends tool execution, not the turn - one explain step follows.
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(executor).not.toHaveBeenCalled();
    const events = parseEvents(res);
    // The ignored query tool never reports as running; only the proposal's own activity does (D-30-9).
    expect(events.filter((e) => e.type === 'tool').map((e) => e.tool))
      .toEqual(['propose_itinerary_changes', 'propose_itinerary_changes']);
    const proposalEvent = events.find((e) => e.type === 'proposal');
    expect(proposalEvent).toBeDefined();
    expect(proposalEvent.operations).toEqual(operations);
    // Exactly one tool_result goes back - for the propose block; the ignored query use gets none.
    const ack = mockStream.mock.calls[1][0].messages.at(-1);
    expect(ack.content).toHaveLength(1);
    expect(ack.content[0].tool_use_id).toBe('tu_term');
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
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'hi', operations: null, notice: null });
    const events = parseEvents(res);
    expect(events[events.length - 1].type).toBe('done');
  });
});

describe('streamCopilotResponse — max_tokens truncation (Plan 15 Wave 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('truncated prose: emits notice, no proposal, persists partial text, single iteration', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(
      ['some partial prose chunk'],
      'some partial prose chunk',
      [{ type: 'text', text: 'some partial prose chunk' }],
      'max_tokens',
    ));

    const res = makeMockRes();
    const persistTurn = vi.fn().mockResolvedValue(null);

    const returned = await streamCopilotResponse(
      [{ role: 'user', content: 'tell me more' }], {}, res, {}, persistTurn, {},
    );

    expect(mockStream).toHaveBeenCalledOnce();
    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'notice' && e.notice === 'truncated')).toBeDefined();
    expect(events.find((e) => e.type === 'proposal')).toBeUndefined();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'some partial prose chunk', operations: null, notice: 'truncated' });
    expect(returned).toBe('some partial prose chunk');
  });

  it('truncated tool_use: emits notice, discards the cut proposal, persists operations: null', async () => {
    const operations = [{ action: 'remove_stop', stopId: 'stop-1' }];
    mockStream.mockReturnValueOnce(makeMockStream(
      ['Sure.'],
      'Sure.',
      [
        { type: 'text', text: 'Sure.' },
        { type: 'tool_use', name: 'propose_itinerary_changes', input: { operations } },
      ],
      'max_tokens',
    ));

    const res = makeMockRes();
    const persistTurn = vi.fn().mockResolvedValue(null);

    await streamCopilotResponse(
      [{ role: 'user', content: 'remove the first stop' }], {}, res, {}, persistTurn, {},
    );

    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'notice' && e.notice === 'truncated')).toBeDefined();
    expect(events.find((e) => e.type === 'proposal')).toBeUndefined();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Sure.', operations: null, notice: 'truncated' });
  });

  it('a normal end_turn reply does not emit a notice event', async () => {
    const fullText = 'Kyoto has some lovely temples.';
    mockStream.mockReturnValueOnce(makeMockStream([fullText], fullText));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'tell me about kyoto' }], {}, res, {}, undefined, {});

    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'notice')).toBeUndefined();
  });
});

describe('streamCopilotResponse — reportTurnMetrics (Plan 15 Wave 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Custom inline stream objects (not makeMockStream) so each iteration can carry its own
  // cache token fields, which makeMockStream's hardcoded usage does not support.
  function makeUsageStream(text, finalContent, usage, stopReason) {
    const listeners = {};
    return {
      on(event, cb) { listeners[event] = cb; return this; },
      abort() {},
      async finalMessage() {
        if (listeners['text'] && text) listeners['text'](text);
        const content = finalContent ?? [{ type: 'text', text: text ?? '' }];
        const derivedStopReason = stopReason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
        return { content, stop_reason: derivedStopReason, usage };
      },
    };
  }

  it('sums usage across iterations (including cache fields) and reports a non-proposing turn', async () => {
    const executor = vi.fn().mockResolvedValue({ ok: true });
    mockStream
      .mockReturnValueOnce(makeUsageStream(
        'checking', [toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_1')],
        { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 },
      ))
      .mockReturnValueOnce(makeUsageStream(
        'here you go', [{ type: 'text', text: 'here you go' }],
        { input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
        'end_turn',
      ));

    const res = makeMockRes();
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse(
      [{ role: 'user', content: 'suggestions?' }], {}, res, {}, undefined,
      { search_discovery_catalogue: executor }, reportTurnMetrics,
    );

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    const summary = reportTurnMetrics.mock.calls[0][0];
    expect(summary.inputTokens).toBe(150);
    expect(summary.outputTokens).toBe(40);
    expect(summary.cacheWriteTokens).toBe(500);
    expect(summary.cacheReadTokens).toBe(500);
    expect(summary.iterations).toBe(2);
    expect(summary.queryCalls).toBe(1);
    expect(summary.stopReason).toBe('end_turn');
    expect(summary.proposalOps).toBe(0);
    expect(summary.error).toBe(0);
    expect(typeof summary.totalMs).toBe('number');
  });

  it('reports proposalOps matching the operations count on a proposing turn', async () => {
    const operations = [{ action: 'remove_stop', stopId: 'stop-1' }, { action: 'remove_stop', stopId: 'stop-2' }];
    mockStream
      .mockReturnValueOnce(makeUsageStream(
        'Sure.',
        [
          { type: 'text', text: 'Sure.' },
          { type: 'tool_use', name: 'propose_itinerary_changes', input: { operations } },
        ],
        { input_tokens: 20, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ))
      .mockReturnValueOnce(makeUsageStream(
        ' Both go.', [{ type: 'text', text: ' Both go.' }],
        { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 25 },
        'end_turn',
      ));

    const res = makeMockRes();
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse(
      [{ role: 'user', content: 'remove the first two stops' }], {}, res, {}, undefined, {}, reportTurnMetrics,
    );

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    const summary = reportTurnMetrics.mock.calls[0][0];
    expect(summary.proposalOps).toBe(2);
    expect(summary.error).toBe(0);
    // D-30-9: the explain step is a second iteration and its usage is summed in.
    expect(summary.iterations).toBe(2);
    expect(summary.inputTokens).toBe(25);
    expect(summary.outputTokens).toBe(18);
    expect(summary.cacheReadTokens).toBe(25);
  });

  it('reports stopReason: max_tokens on a truncated turn', async () => {
    mockStream.mockReturnValueOnce(makeUsageStream(
      'partial',
      [{ type: 'text', text: 'partial' }],
      { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      'max_tokens',
    ));

    const res = makeMockRes();
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse(
      [{ role: 'user', content: 'tell me more' }], {}, res, {}, undefined, {}, reportTurnMetrics,
    );

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0].stopReason).toBe('max_tokens');
  });

  it('reports error: 1 when the stream throws, and the turn still completes normally', async () => {
    const brokenStream = {
      on() { return brokenStream; },
      async finalMessage() { throw new Error('stream failed'); },
    };
    mockStream.mockReturnValueOnce(brokenStream);

    const res = makeMockRes();
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, res, {}, undefined, {}, reportTurnMetrics);

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    const summary = reportTurnMetrics.mock.calls[0][0];
    expect(summary.error).toBe(1);
    expect(summary.proposalOps).toBe(0);

    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'stream failed' });
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(res.ended).toBe(true);
  });

  it('reportTurnMetrics rejecting does not throw out of streamCopilotResponse or prevent done/res.end()', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['hi'], 'hi'));
    const res = makeMockRes();
    const reportTurnMetrics = vi.fn().mockRejectedValue(new Error('db write failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, res, {}, undefined, {}, reportTurnMetrics),
    ).resolves.toBe('hi');

    const events = parseEvents(res);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(res.ended).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('[copilot] reportTurnMetrics failed:', expect.any(Error));

    errorSpy.mockRestore();
  });

  it('records a client_abort turn (not silence) when the connection drops and the SDK resolves anyway', async () => {
    const res = makeMockRes();
    const abortableStream = {
      on(event, cb) {
        if (event === 'text') abortableStream._textCb = cb;
        return abortableStream;
      },
      abort() {},
      async finalMessage() {
        if (abortableStream._textCb) abortableStream._textCb('partial');
        res.triggerClose();
        return { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    mockStream.mockReturnValueOnce(abortableStream);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, res, {}, undefined, {}, reportTurnMetrics);

    // D-30-4: an aborted turn spent real tokens, so it is recorded once — as an abort, not an error.
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    const summary = reportTurnMetrics.mock.calls[0][0];
    expect(summary.stopReason).toBe('client_abort');
    expect(summary.error).toBe(0);
    expect(summary.proposalOps).toBe(0);
    expect(summary.inputTokens).toBe(1);
    expect(summary.outputTokens).toBe(1);
  });
});

describe('generatePhotoDescriptor (Plan 10 Wave 3, Plan 34 W2 contract)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  function respondWith(text) {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text }] });
  }

  function warnings() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  it('parses a well-formed descriptor', async () => {
    respondWith('{"photoQuery": "steaming hotpot table Chengdu", "sceneType": "food_drink"}');

    const result = await generatePhotoDescriptor({ title: 'Hotpot Spot', city: 'Chengdu', country: 'China', type: 'food' });

    expect(result).toEqual({ photoQuery: 'steaming hotpot table Chengdu', sceneType: 'food_drink' });
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5' });
  });

  it('returns the schema spelling of a differently-cased sceneType (D-34-7)', async () => {
    respondWith('{"photoQuery": "night market skewers", "sceneType": "Food_Drink"}');

    expect(await generatePhotoDescriptor({ title: 'Night Market', type: 'food' })).toEqual({ photoQuery: 'night market skewers', sceneType: 'food_drink' });
  });

  it('returns null when sceneType is outside the vocabulary', async () => {
    respondWith('{"photoQuery": "night market skewers", "sceneType": "wildlife_sanctuary"}');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'Night Market' })).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[photo] descriptor not usable', expect.objectContaining({ title: 'Night Market', reason: expect.stringContaining('sceneType') }));
    warnSpy.mockRestore();
  });

  it('returns null when sceneType is missing', async () => {
    respondWith('{"photoQuery": "night market skewers"}');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'A' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'A', reason: 'sceneType: is required' });
    warnSpy.mockRestore();
  });

  it('returns null when photoQuery is missing', async () => {
    respondWith('{"sceneType": "market"}');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'B' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'B', reason: 'photoQuery: is required' });
    warnSpy.mockRestore();
  });

  it('returns null when there is an extra property', async () => {
    respondWith('{"photoQuery": "night market skewers", "sceneType": "market", "notes": "x"}');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'C' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'C', reason: 'notes: is not an allowed property' });
    warnSpy.mockRestore();
  });

  it('returns null when photoQuery is empty or whitespace', async () => {
    const warnSpy = warnings();
    for (const q of ['', '   ']) {
      respondWith(JSON.stringify({ photoQuery: q, sceneType: 'market' }));
      expect(await generatePhotoDescriptor({ title: 'D' })).toBeNull();
      expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'D', reason: 'photoQuery is empty' });
    }
    warnSpy.mockRestore();
  });

  it('accepts exactly 8 words without an over-limit warning', async () => {
    respondWith('{"photoQuery": "one two three four five six seven eight", "sceneType": "generic"}');
    const warnSpy = warnings();

    const result = await generatePhotoDescriptor({ title: 'Eight Word Place' });

    expect(result).toEqual({ photoQuery: 'one two three four five six seven eight', sceneType: 'generic' });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sends a query over 8 words as written (whitespace-normalised, never cut) and logs it', async () => {
    respondWith('{"photoQuery": "  one two  three four five six seven eight nine ", "sceneType": "generic"}');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'Long Query Place' })).toEqual({
      photoQuery: 'one two three four five six seven eight nine',
      sceneType: 'generic',
    });
    expect(warnSpy).toHaveBeenCalledWith('[photo] descriptor over word limit', { title: 'Long Query Place', words: 9, limit: 8 });
    warnSpy.mockRestore();
  });

  it('returns null when the text is not JSON', async () => {
    respondWith('Sorry, I cannot help with that.');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'Some Place' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'Some Place', reason: expect.stringMatching(/^not JSON \(/) });
    warnSpy.mockRestore();
  });

  it('returns null for a fenced block: nothing is repaired', async () => {
    respondWith('```json\n{"photoQuery": "night market skewers", "sceneType": "market"}\n```');
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'Some Place' })).toBeNull();
    warnSpy.mockRestore();
  });

  it('returns null when there are two text blocks', async () => {
    mockCreate.mockResolvedValue({ content: [
      { type: 'text', text: '{"photoQuery": "a b", "sceneType": "market"}' },
      { type: 'text', text: '{"photoQuery": "c d", "sceneType": "market"}' },
    ] });
    const warnSpy = warnings();

    expect(await generatePhotoDescriptor({ title: 'Some Place' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'Some Place', reason: 'expected exactly one text block, got 2' });
    warnSpy.mockRestore();
  });

  it('returns null (never throws) when the API call fails', async () => {
    mockCreate.mockRejectedValue(new Error('Anthropic outage'));

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
  });
});

describe('PHOTO_DESCRIPTOR_OUTPUT_SCHEMA (Plan 34 W2, D-34-1)', () => {
  const schema = PHOTO_DESCRIPTOR_OUTPUT_SCHEMA;

  it('builds the sceneType enum from SCENE_TYPES', () => {
    expect(schema.properties.sceneType.enum).toEqual(SCENE_TYPES);
  });

  it('is deep-frozen without freezing SCENE_TYPES itself', () => {
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
    expect(Object.isFrozen(schema.properties.sceneType.enum)).toBe(true);
    expect(Object.isFrozen(SCENE_TYPES)).toBe(false);
    expect(SCENE_TYPES).toHaveLength(14);
  });

  it('has no optional property and rejects extras', () => {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('puts no pattern on photoQuery (the 8-word limit is a server check)', () => {
    expect(schema.properties.photoQuery).not.toHaveProperty('pattern');
  });

  it('is exposed as a json_schema format', () => {
    expect(PHOTO_DESCRIPTOR_OUTPUT_FORMAT).toEqual({ type: 'json_schema', schema });
  });
});

describe('photo descriptor prompt text (Plan 34 W2, D-34-1)', () => {
  it('pins the prompt text', () => {
    expect(createHash('sha256').update(PHOTO_DESCRIPTOR_SYSTEM).digest('hex')).toBe('fdbbf529358f0a7e0e619e34fa8d50ab36a78e1a206a07d6f6241970c5a52b5f');
  });

  it('carries no output-format instruction', () => {
    for (const gone of ['fence', '```', 'Output']) expect(PHOTO_DESCRIPTOR_SYSTEM).not.toContain(gone);
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

  it('returns the canonical member for a differently-cased string (D-34-7)', () => {
    expect(coerceSceneType('MARKET')).toBe('market');
    expect(coerceSceneType('Food_Drink')).toBe('food_drink');
  });

  it('returns null for a non-string', () => {
    expect(coerceSceneType(42)).toBeNull();
    expect(coerceSceneType(['market'])).toBeNull();
  });
});

// Plan 26 W1.3 (F-26-9): normalizeName used [^\w\s] with no /u flag, so \w was
// ASCII-only and any pure-CJK name folded to "" — the first such item in a
// destination claimed normalized_name = '' and every subsequent CJK-named
// item was silently skipped as a duplicate by insertPlaces (see the
// insertPlaces dedupe test in discoveryCatalogue.test.js for the user-visible
// consequence). No coverage existed for this function before Plan 26.
describe('normalizeName (Plan 26 W1.3 — CJK name folding, F-26-9)', () => {
  it('folds distinct pure-CJK names to distinct, non-empty keys', () => {
    const duck = normalizeName('北京烤鸭');
    const palace = normalizeName('故宫博物院');
    const oldTown = normalizeName('喀什老城');

    expect(duck).not.toBe('');
    expect(palace).not.toBe('');
    expect(oldTown).not.toBe('');
    expect(new Set([duck, palace, oldTown]).size).toBe(3);
  });

  it('reproduces the pre-fix bug when run against the old pattern, for contrast', () => {
    // Not a call into the fixed function — this documents exactly what F-26-9
    // reported so a future regression back to \w is legible as a diff here.
    const oldNormalize = (str) => str.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    expect(oldNormalize('北京烤鸭')).toBe('');
    expect(oldNormalize('故宫博物院')).toBe('');
  });

  it('keeps mixed CJK+Latin names intact', () => {
    const result = normalizeName('Chuan Wei Small Eat 川味小吃 (Xinyi)');
    expect(result).not.toBe('');
    expect(result).toContain('chuan wei small eat');
    expect(result).toContain('川味小吃');
    expect(result).toContain('xinyi');
  });

  it('still strips English geographic suffixes exactly as before', () => {
    expect(normalizeName('Dujiangyan & Scenic Area')).toBe('dujiangyan');
    expect(normalizeName('Dujiangyan Scenic Area')).toBe('dujiangyan');
    expect(normalizeName('Old Town Historic District')).toBe('');
    expect(normalizeName('Yulong Old Town')).toBe('yulong');
  });

  it('still collapses punctuation and whitespace for Latin names', () => {
    // Punctuation (apostrophe, "!!") is replaced with a space, not deleted, so
    // "People's" splits into two tokens — this is existing behaviour, unchanged
    // by the \p{L}\p{N}/u fix.
    expect(normalizeName("People's Liberation Monument!!")).toBe('people s liberation monument');
  });
});

// ---------------------------------------------------------------------------
// Plan 30 W0 — the optional `profile` parameter must not change a default request.
// The sha256 literals below were captured at 4496a96, before the profile parameter existed;
// they pin the exact serialized body (key order, prompt text, tool schemas) each workload sends
// today. A deliberate change to a prompt or tool schema will move them — re-capture then.
// ---------------------------------------------------------------------------

describe('default request bodies are byte-identical (Plan 30 W0)', () => {
  const sha256 = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

  const EXTRACT_ARGS = {
    files: [{ kind: 'text', content: 'Flight CA 421 PEK to CTU, 03/04/2027 08:30. Ref ABC123.' }],
    contextText: 'Booked for the spring trip.',
    tripContext: { startDate: '2027-04-01', endDate: '2027-04-10', destinations: [{ city: 'Chengdu', countryCode: 'CN' }] },
  };
  const EXTRACT_REPLY = {
    content: [{ type: 'text', text: JSON.stringify({ summary: 'x', language: 'en', result: { kind: 'travel_no_booking' } }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runExtraction(extra = {}) {
    // extractBookings stamps today's date into the body — pin it so the hash is stable.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));
    mockCreate.mockResolvedValue(EXTRACT_REPLY);
    const result = await extractBookings({ ...EXTRACT_ARGS, ...extra });
    return { body: mockCreate.mock.calls[0][0], result };
  }

  async function runDescriptor(extra = {}) {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"photoQuery":"a b","sceneType":"market"}' }] });
    await generatePhotoDescriptor({ title: 'Hotpot Spot', resolvedName: 'Shu Daxia', city: 'Chengdu', country: 'China', type: 'food', ...extra });
    return mockCreate.mock.calls[0][0];
  }

  async function runDiscovery(...profileArg) {
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(FOUR_HEALTHY_CATEGORIES)));
    await discoverDestination('kyoto', ['Kinkakuji', 'Ramen Alley'], undefined, ...profileArg);
    return mockStream.mock.calls[0][0];
  }

  async function runCopilot(reportTurnMetrics, ...profileArg) {
    mockStream.mockReturnValue(makeMockStream(['Hello'], 'Hello'));
    await streamCopilotResponse(
      [{ role: 'user', content: 'How is day 2?' }],
      { tripId: 't1', days: [{ id: 'd1', stops: [] }] },
      makeMockRes(), {}, undefined, {}, reportTurnMetrics, null, ...profileArg,
    );
    return mockStream.mock.calls[0][0];
  }

  it('extractBookings', async () => {
    const { body } = await runExtraction();
    // Plan 30 W4 moved this pin to Sonnet 5.5 at effort 'medium' with adaptive thinking left on.
    // Plan 34 W1: the fourth deliberate move off the W0 pin — the D-34-1 schema contract and the §4.3 prompt (structure asserted first, sha256 re-captured).
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'output_config', 'system', 'messages']);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(16000);
    expect(body.output_config).toEqual({ effort: 'medium', format: EXTRACTION_OUTPUT_FORMAT });
    expect(Object.keys(body.output_config)).toEqual(['effort', 'format']);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema).toBe(EXTRACTION_OUTPUT_SCHEMA);
    expect(body.system).toBe(EXTRACTION_SYSTEM);
    expect(body).not.toHaveProperty('thinking');
    expect(sha256(body)).toBe('f79b1f96f41ba333e47409eeb59d249c5e6abe1fdd40d65a071b31309611c420');
  });

  it('extractBookings rolled back to Sonnet 4.6 sends the same contract with no effort (Plan 30 W4 rollback, D-34-6)', async () => {
    const { body } = await runExtraction({ profile: { model: 'claude-sonnet-4-6', ...MODEL_PROFILES['claude-sonnet-4-6'].extraction } });
    // Plan 34 W1: the fourth deliberate move off the W0 pin — the D-34-1 schema contract and the §4.3 prompt (structure asserted first, sha256 re-captured).
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'output_config', 'system', 'messages']);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(8192);
    expect(body.output_config).toEqual({ format: EXTRACTION_OUTPUT_FORMAT });
    expect(body.output_config.format.schema).toBe(EXTRACTION_OUTPUT_SCHEMA);
    expect(body.system).toBe(EXTRACTION_SYSTEM);
    expect(body).not.toHaveProperty('thinking');
    expect(sha256(body)).toBe('fcdfddad740029b903a224b4a7af414280cb5ae875c1ca66445c09d703ca5c6e');
  });

  it('generatePhotoDescriptor', async () => {
    const body = await runDescriptor();
    // Plan 30 W2: the one deliberate move off the W0 pin — Haiku 5.5 at effort 'low' (the sha256
    // was re-captured for that body; the other three pins were untouched).
    // Plan 34 W2: the second deliberate move off the W0 pin — the D-34-1 schema contract and the §4.3 prompt (structure asserted first, sha256 re-captured).
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'output_config', 'system', 'messages']);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.output_config).toEqual({ effort: 'low', format: PHOTO_DESCRIPTOR_OUTPUT_FORMAT });
    expect(body.output_config.format.schema).toBe(PHOTO_DESCRIPTOR_OUTPUT_SCHEMA);
    expect(body.system).toBe(PHOTO_DESCRIPTOR_SYSTEM);
    expect(body).not.toHaveProperty('thinking');
    expect(sha256(body)).toBe('3a3cea4dd690745402da85fdbe36aca16ff575304470ee28ef9ea98b17048840');
  });

  it('generatePhotoDescriptor rolled back to Haiku 4.5 sends the same contract with no effort (Plan 30 W2 rollback, D-34-6)', async () => {
    const body = await runDescriptor({ profile: { model: 'claude-haiku-4-5-20251001', ...MODEL_PROFILES['claude-haiku-4-5-20251001'].descriptor } });
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'output_config', 'system', 'messages']);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.max_tokens).toBe(256);
    expect(body.output_config).toEqual({ format: PHOTO_DESCRIPTOR_OUTPUT_FORMAT });
    expect(body.output_config.format.schema).toBe(PHOTO_DESCRIPTOR_OUTPUT_SCHEMA);
    expect(body.system).toBe(PHOTO_DESCRIPTOR_SYSTEM);
    expect(body).not.toHaveProperty('thinking');
    expect(sha256(body)).toBe('e9aa83fd0d6c08df4e0641ddfa756907bc27b3062b83dd2655bad0ba1de00c48');
  });

  it('discoverDestination', async () => {
    const body = await runDiscovery();
    // Plan 30 W3: the second deliberate move off the W0 pin — Haiku 5.5, thinking disabled at
    // effort 'low', with Haiku 5.5's discovery selection rules (the sha256 below was re-captured
    // for this body).
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'thinking', 'output_config', 'system', 'messages']);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(48000);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(sha256(body)).toBe('4feadef79f9f7b407c58f264aacc3c7e898184a6e130682918677e43d4a18a1e');
  });

  it('discoverDestination rolled back to Haiku 4.5 sends the exact W0 body (Plan 30 W3 rollback)', async () => {
    const body = await runDiscovery({ model: 'claude-haiku-4-5-20251001', ...MODEL_PROFILES['claude-haiku-4-5-20251001'].discovery });
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'messages']);
    expect(sha256(body)).toBe('0c8c2727661fb86d990849536a00b62414dccc13d64e91d65c35ec8d083bcbc6');
  });

  it('streamCopilotResponse', async () => {
    const body = await runCopilot();
    // Plan 30 W5: the fifth deliberate move off the W0 pin - Sonnet 5.5 at effort 'low' under the
    // D-30-9 explain-after-proposal protocol, with the system prompt's second "How to propose
    // changes" bullet saying "call the tool first, explain after the acknowledgement". Structure
    // first, then the re-captured sha256.
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'output_config', 'system', 'messages', 'tools']);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(16000);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body.system[0].text).toContain('- Call the tool first. Once Trippy has acknowledged the call, explain the proposed changes to the traveller in prose: what changes and why, in your own words. If you are not proposing changes, do not call the tool.');
    expect(body.system[0].text).not.toContain('First explain your reasoning in prose');
    expect(sha256(body)).toBe('3a751ac74b7d3291a76ba904792cf214b85d46289b9e883f4fff15eaf528c712');
  });

  it('streamCopilotResponse rolled back to Sonnet 4.6 sends the exact D-30-9 Sonnet 4.6 body (Plan 30 W5 rollback)', async () => {
    const body = await runCopilot(undefined, { model: 'claude-sonnet-4-6', ...MODEL_PROFILES['claude-sonnet-4-6'].copilot });
    expect(Object.keys(body)).toEqual(['model', 'max_tokens', 'system', 'messages', 'tools']);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(8192);
    expect(sha256(body)).toBe('739c12cf99a9690e999297e29dbff080b461c129ad96de48e2f97f2a1cb43c4c');
  });

  describe('an explicit profile changes the request as intended', () => {
    const profile = { model: 'claude-haiku-5-5', maxTokens: 1024, effort: 'low', thinking: { type: 'disabled' } };

    function expectProfileFields(body) {
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.max_tokens).toBe(1024);
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.output_config).toEqual({ effort: 'low' });
    }

    it('extractBookings sends the profile and reports its model', async () => {
      const { body, result } = await runExtraction({ profile });
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.max_tokens).toBe(1024);
      expect(body.thinking).toEqual({ type: 'disabled' });
      // D-34-6: extraction's output format rides in the same output_config as the profile's effort.
      expect(body.output_config).toEqual({ effort: 'low', format: EXTRACTION_OUTPUT_FORMAT });
      expect(result.model).toBe('claude-haiku-5-5');
    });

    it('generatePhotoDescriptor sends the profile', async () => {
      const body = await runDescriptor({ profile });
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.max_tokens).toBe(1024);
      expect(body.thinking).toEqual({ type: 'disabled' });
      // D-34-6: the descriptor's output format rides in the same output_config as the profile's effort.
      expect(body.output_config).toEqual({ effort: 'low', format: PHOTO_DESCRIPTOR_OUTPUT_FORMAT });
    });

    it('discoverDestination sends the profile', async () => {
      expectProfileFields(await runDiscovery(profile));
    });

    it('streamCopilotResponse sends the profile and reports its model', async () => {
      const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
      expectProfileFields(await runCopilot(reportTurnMetrics, profile));
      expect(reportTurnMetrics.mock.calls[0][0].model).toBe('claude-haiku-5-5');
    });

    it('omits thinking and sends only the format when the profile carries neither thinking nor effort', async () => {
      const body = await runDescriptor({ profile: { model: 'claude-haiku-5-5', maxTokens: 512 } });
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.max_tokens).toBe(512);
      expect(body).not.toHaveProperty('thinking');
      expect(body.output_config).toEqual({ format: PHOTO_DESCRIPTOR_OUTPUT_FORMAT });
    });

    it('sends effort beside the format in output_config without a thinking field', async () => {
      const body = await runDescriptor({ profile: { model: 'claude-haiku-5-5', maxTokens: 1024, effort: 'medium' } });
      expect(body.output_config).toEqual({ effort: 'medium', format: PHOTO_DESCRIPTOR_OUTPUT_FORMAT });
      expect(body).not.toHaveProperty('thinking');
    });
  });
});

// ---------------------------------------------------------------------------
// Plan 30 W1 — model-keyed profiles (D-30-1), one stop classifier (D-30-3),
// co-pilot keep-alive / never-silent / honest aborts (D-30-4).
// ---------------------------------------------------------------------------

// A thinking block as a thinking-capable model emits it under the default display: empty text,
// a signature. It must be ignored by every parser and replayed untouched by the co-pilot loop.
const THINKING_BLOCK = { type: 'thinking', thinking: '', signature: 'sig-abc' };
const EXTRACT_OK_TEXT = JSON.stringify({ summary: 'x', language: 'en', result: { kind: 'travel_no_booking' } });
const DESCRIPTOR_OK_TEXT = '{"photoQuery":"night market skewers","sceneType":"market"}';

describe('MODEL_PROFILES / profileFor (D-30-1)', () => {
  it('returns each workload\'s live model and max_tokens, model first', () => {
    expect(profileFor('extraction')).toEqual({ model: EXTRACTION_MODEL, maxTokens: 16000, effort: 'medium' });
    expect(profileFor('copilot')).toEqual({ model: COPILOT_MODEL, maxTokens: 16000, effort: 'low' });
    expect(COPILOT_MODEL).toBe('claude-sonnet-5-5');
    expect(profileFor('descriptor')).toEqual({ model: PHOTO_DESCRIPTOR_MODEL, maxTokens: 1024, effort: 'low' });
    expect(profileFor('discovery')).toEqual({ model: DISCOVERY_MODEL, maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' });
    // Plan 30 W5: Sonnet 5.5 co-pilot runs adaptive thinking at effort 'low' (no thinking field).
    expect(Object.keys(profileFor('copilot'))).toEqual(['model', 'maxTokens', 'effort']);
    // Plan 30 W4: Sonnet 5.5 extraction runs adaptive thinking at effort 'medium' (no thinking field).
    expect(Object.keys(profileFor('extraction'))).toEqual(['model', 'maxTokens', 'effort']);
    // Plan 30 W2: Haiku 5.5 runs adaptive thinking unless told otherwise, so its descriptor
    // profile carries an effort; no thinking field (low effort did not think in the sweep).
    expect(Object.keys(profileFor('descriptor'))).toEqual(['model', 'maxTokens', 'effort']);
    // Plan 30 W3: discovery turns thinking off explicitly (key order is what the harness compares).
    expect(Object.keys(profileFor('discovery'))).toEqual(['model', 'maxTokens', 'thinking', 'effort']);
  });

  it('never gives Haiku 4.5 an effort or thinking field (it rejects output_config.effort)', () => {
    for (const settings of Object.values(MODEL_PROFILES['claude-haiku-4-5-20251001'])) {
      expect(settings).not.toHaveProperty('effort');
      expect(settings).not.toHaveProperty('thinking');
    }
  });

  it('never gives Sonnet 4.6 a thinking field (it runs thinking-off)', () => {
    for (const settings of Object.values(MODEL_PROFILES['claude-sonnet-4-6'])) {
      expect(settings).not.toHaveProperty('thinking');
    }
  });

  it('keeps the Haiku 4.5 descriptor row, so a one-line constant revert restores a compatible body (Plan 30 W2 rollback)', () => {
    expect(MODEL_PROFILES['claude-haiku-4-5-20251001'].descriptor).toEqual({ maxTokens: 256 });
    expect(MODEL_PROFILES['claude-haiku-5-5'].descriptor).toEqual({ maxTokens: 1024, effort: 'low' });
  });

  it('keeps the Haiku 4.5 discovery row, so a one-line constant revert restores a compatible body (Plan 30 W3 rollback)', () => {
    expect(MODEL_PROFILES['claude-haiku-4-5-20251001'].discovery).toEqual({ maxTokens: 64000 });
    expect(MODEL_PROFILES['claude-haiku-5-5'].discovery).toEqual({ maxTokens: 48000, thinking: { type: 'disabled' }, effort: 'low' });
  });

  it('keeps the Sonnet 4.6 extraction row, so a one-line constant revert restores a compatible body (Plan 30 W4 rollback)', () => {
    expect(MODEL_PROFILES['claude-sonnet-4-6'].extraction).toEqual({ maxTokens: 8192 });
    expect(MODEL_PROFILES['claude-sonnet-5-5'].extraction).toEqual({ maxTokens: 16000, effort: 'medium' });
    // F-30-6: the extraction call is non-streaming, so its allowance must stay at or under 21,333.
    expect(MODEL_PROFILES['claude-sonnet-5-5'].extraction.maxTokens).toBeLessThanOrEqual(21333);
  });

  it('keeps the Sonnet 4.6 co-pilot row, so a one-line constant revert restores a compatible body (Plan 30 W5 rollback)', () => {
    expect(MODEL_PROFILES['claude-sonnet-4-6'].copilot).toEqual({ maxTokens: 8192 });
    expect(MODEL_PROFILES['claude-sonnet-5-5'].copilot).toEqual({ maxTokens: 16000, effort: 'low' });
    expect(MODEL_PROFILES['claude-sonnet-5-5'].copilot).not.toHaveProperty('thinking');
  });

  it('the live profiles feed requestSettings: the co-pilot sends output_config effort low and no thinking', () => {
    expect(Object.keys(requestSettings(profileFor('copilot')))).toEqual(['model', 'max_tokens', 'output_config']);
    expect(requestSettings(profileFor('copilot')).output_config).toEqual({ effort: 'low' });
    expect(Object.keys(requestSettings(profileFor('extraction')))).toEqual(['model', 'max_tokens', 'output_config']);
    expect(Object.keys(requestSettings(profileFor('descriptor')))).toEqual(['model', 'max_tokens', 'output_config']);
    expect(Object.keys(requestSettings(profileFor('discovery')))).toEqual(['model', 'max_tokens', 'thinking', 'output_config']);
  });

  it('merges a workload output format beside the model\'s effort, effort first (D-34-6)', () => {
    const format = { type: 'json_schema', schema: { type: 'object' } };
    const withBoth = requestSettings(profileFor('extraction'), { format });
    expect(Object.keys(withBoth)).toEqual(['model', 'max_tokens', 'output_config']);
    expect(withBoth.output_config).toEqual({ effort: 'medium', format });
    expect(Object.keys(withBoth.output_config)).toEqual(['effort', 'format']);
  });

  it('sends a format alone as output_config when the model\'s row has no effort (D-34-6)', () => {
    const format = { type: 'json_schema', schema: { type: 'object' } };
    const rollback = requestSettings({ model: 'claude-sonnet-4-6', ...MODEL_PROFILES['claude-sonnet-4-6'].extraction }, { format });
    expect(rollback).toEqual({ model: 'claude-sonnet-4-6', max_tokens: 8192, output_config: { format } });
  });

  it('is unchanged when no format is given (every other workload\'s body)', () => {
    expect(requestSettings(profileFor('descriptor'))).toEqual({ model: PHOTO_DESCRIPTOR_MODEL, max_tokens: 1024, output_config: { effort: 'low' } });
    expect(requestSettings({ model: 'claude-sonnet-4-6', maxTokens: 8192 })).toEqual({ model: 'claude-sonnet-4-6', max_tokens: 8192 });
    expect(requestSettings(profileFor('discovery'), {})).toEqual(requestSettings(profileFor('discovery')));
  });

  it('throws a clear error for an unknown workload', () => {
    expect(() => profileFor('translation')).toThrow(/unknown workload "translation"/);
  });

  it('is frozen — a caller cannot rewrite what production sends', () => {
    expect(Object.isFrozen(MODEL_PROFILES)).toBe(true);
    expect(Object.isFrozen(MODEL_PROFILES['claude-sonnet-4-6'])).toBe(true);
    expect(Object.isFrozen(MODEL_PROFILES['claude-sonnet-4-6'].extraction)).toBe(true);
  });
});

// Plan 30 W3 second pass — the discovery prompt's volume/selection rules are keyed by model.
// The prompt-text sha256 literals pin each model's full prompt, so an edit to either is deliberate.
describe('discovery prompt keyed by model (D-30-1, Plan 30 W3)', () => {
  const sha256Text = (text) => createHash('sha256').update(text).digest('hex');

  it('pins each model\'s discovery prompt text', () => {
    // Haiku 4.5: byte-identical to the DISCOVER_SYSTEM constant before W3.
    expect(sha256Text(discoverySystemPrompt('claude-haiku-4-5-20251001'))).toBe('34c3742fbd01638a66e1e9ba9a2d35c13c5270004407a5abb099bdff495c362e');
    // Haiku 5.5: the measured W3 second-pass variant A.
    expect(sha256Text(discoverySystemPrompt('claude-haiku-5-5'))).toBe('b851c503f3e9ff456e26ac742c0cf3875b6ed8d68e8d96ec714b152098f814d9');
  });

  it('differs between models only in the two selection lines', () => {
    const p45 = discoverySystemPrompt('claude-haiku-4-5-20251001');
    const p55 = discoverySystemPrompt('claude-haiku-5-5');
    const r45 = DISCOVERY_SELECTION_RULES['claude-haiku-4-5-20251001'];
    const r55 = DISCOVERY_SELECTION_RULES['claude-haiku-5-5'];
    expect(p55).not.toBe(p45);
    expect(p55.replace(r55.quality, () => r45.quality).replace(r55.volume, () => r45.volume)).toBe(p45);
  });

  it('every model with a discovery profile has selection rules, and the map is frozen', () => {
    for (const [model, workloads] of Object.entries(MODEL_PROFILES)) {
      if (workloads.discovery) expect(() => discoverySystemPrompt(model)).not.toThrow();
    }
    expect(Object.isFrozen(DISCOVERY_SELECTION_RULES)).toBe(true);
    expect(Object.isFrozen(DISCOVERY_SELECTION_RULES['claude-haiku-5-5'])).toBe(true);
  });

  it('sends the rolled-back model its own prompt, and refuses a model with no rules', async () => {
    mockStream.mockReset();
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(FOUR_HEALTHY_CATEGORIES)));
    await discoverDestination('kyoto', [], undefined, { model: 'claude-haiku-4-5-20251001', maxTokens: 64000 });
    expect(mockStream.mock.calls[0][0].system).toBe(discoverySystemPrompt('claude-haiku-4-5-20251001'));

    mockStream.mockReset();
    await expect(discoverDestination('kyoto', [], undefined, { model: 'claude-sonnet-4-6', maxTokens: 1000 }))
      .rejects.toThrow(/no discovery selection rules for model "claude-sonnet-4-6"/);
    expect(mockStream).not.toHaveBeenCalled();
  });
});

describe('classifyStop (D-30-3)', () => {
  it('maps refusal to refused and carries the category when the message has one', () => {
    expect(classifyStop({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }))
      .toEqual({ outcome: 'refused', stopReason: 'refusal', category: 'cyber' });
    expect(classifyStop({ stop_reason: 'refusal' }))
      .toEqual({ outcome: 'refused', stopReason: 'refusal', category: null });
  });

  it('maps max_tokens and model_context_window_exceeded to truncated', () => {
    expect(classifyStop({ stop_reason: 'max_tokens' }).outcome).toBe('truncated');
    expect(classifyStop({ stop_reason: 'model_context_window_exceeded' }).outcome).toBe('truncated');
  });

  it('treats every other stop (and a missing message) as complete', () => {
    for (const stop_reason of ['end_turn', 'tool_use', 'stop_sequence', 'pause_turn', undefined]) {
      expect(classifyStop({ stop_reason }).outcome).toBe('complete');
    }
    expect(classifyStop(undefined)).toEqual({ outcome: 'complete', stopReason: null, category: null });
  });
});

describe('extractBookings — thinking blocks and stop reasons (D-30-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
  });

  const files = [{ kind: 'text', content: 'Flight CA 421 PEK to CTU' }];
  const usage = { input_tokens: 5, output_tokens: 7 };

  it('reads the JSON from text blocks and ignores a leading thinking block', async () => {
    mockCreate.mockResolvedValue({
      content: [THINKING_BLOCK, { type: 'text', text: EXTRACT_OK_TEXT }],
      stop_reason: 'end_turn',
      usage,
    });

    const { extraction } = await extractBookings({ files });

    expect(extraction.isTravelRelated).toBe(true);
  });

  it('rejects a refusal with a specific 502 naming the category, never "no JSON block"', async () => {
    mockCreate.mockResolvedValue({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
      usage,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await extractBookings({ files }).catch((e) => e);

    expect(err.status).toBe(502);
    expect(err.message).toBe(
      'The booking reader declined to process this input (category: cyber). Try pasting the confirmation text instead.',
    );
    expect(err.message).not.toMatch(/no JSON block/);
    warnSpy.mockRestore();
  });

  it('omits the category clause when the refusal carries none', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '' }], stop_reason: 'refusal', usage });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await extractBookings({ files }).catch((e) => e);

    expect(err.status).toBe(502);
    expect(err.message).toBe('The booking reader declined to process this input. Try pasting the confirmation text instead.');
    warnSpy.mockRestore();
  });

  it('a max_tokens stop during thinking (no answer text) says it stopped, and never tells the traveller to split the file (D-34-8, Q-34-3)', async () => {
    mockCreate.mockResolvedValue({ content: [THINKING_BLOCK], stop_reason: 'max_tokens', usage });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await extractBookings({ files }).catch((e) => e);

    expect(err.status).toBe(502);
    expect(err.message).toBe('The booking reader stopped before writing its answer. Please try again.');
    expect(err.message).not.toMatch(/split/);
    expect(warnSpy).toHaveBeenCalledWith('[import] extraction cut off during=%s stopReason=%s out=%d', 'thinking', 'max_tokens', 7);
    warnSpy.mockRestore();
  });

  it('a max_tokens stop with whitespace-only text counts as during thinking', async () => {
    mockCreate.mockResolvedValue({ content: [THINKING_BLOCK, { type: 'text', text: '  \n' }], stop_reason: 'max_tokens', usage });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(extractBookings({ files })).rejects.toMatchObject({
      status: 502,
      message: 'The booking reader stopped before writing its answer. Please try again.',
    });
    warnSpy.mockRestore();
  });

  it('a max_tokens stop after the answer began is a genuinely long output and keeps the split-the-file advice', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"summary":"x","lang' }],
      stop_reason: 'max_tokens',
      usage,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await extractBookings({ files }).catch((e) => e);

    expect(err.status).toBe(502);
    expect(err.message).toBe("The booking reader's output was cut off — try fewer pages or split the file.");
    expect(err.raw).toBe('{"summary":"x","lang');
    expect(warnSpy).toHaveBeenCalledWith('[import] extraction cut off during=%s stopReason=%s out=%d', 'text', 'max_tokens', 7);
    warnSpy.mockRestore();
  });

  it('treats model_context_window_exceeded like max_tokens', async () => {
    mockCreate.mockResolvedValue({ content: [THINKING_BLOCK], stop_reason: 'model_context_window_exceeded', usage });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(extractBookings({ files })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/cut off|stopped before/) });
    warnSpy.mockRestore();
  });

  it('keeps raw (first 2000 chars of text) on a truncation so the failure stays diagnosable', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"summary":"x","lang'.padEnd(2500, 'x') }],
      stop_reason: 'max_tokens',
      usage,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await extractBookings({ files }).catch((e) => e);

    expect(err.raw).toBe('{"summary":"x","lang'.padEnd(2500, 'x').slice(0, 2000));
    warnSpy.mockRestore();
  });
});

// Plan 34 W1 — the extraction answer is an API-enforced schema (D-34-1), parsed from exactly one
// text block and re-checked in code (D-34-2), then mapped back to the app's own shape (D-34-3).
const emptyDetails = () => Object.fromEntries(EXTRACTION_DETAIL_FIELDS.map((key) => [key, '']));
const schemaBooking = (over = {}, detailOver = {}) => ({
  type: 'flight',
  title: 'KE012',
  confirmationRef: 'ABC123',
  bookingSource: null,
  startDatetime: '2027-04-03T08:30',
  endDatetime: '2027-04-03T12:10',
  origin: 'ICN',
  destination: 'JFK',
  terminalOrStation: null,
  originTz: 'Asia/Seoul',
  destinationTz: 'America/New_York',
  details: { ...emptyDetails(), originCity: 'Seoul', destinationCity: 'New York', carrierCode: 'KE', flightNumber: '012', ...detailOver },
  confidence: { overall: 'high' },
  fieldConfidence: [{ field: 'startDatetime', level: 'low' }],
  assumptions: ['Year inferred from the trip dates.'],
  ...over,
});
const schemaAnswer = (result, extra = {}) => JSON.stringify({ summary: 'One flight.', language: 'en', result, ...extra });
const bookingsAnswer = (booking = schemaBooking()) => schemaAnswer({ kind: 'bookings', bookings: [booking] });

describe('extractBookings — schema contract (Plan 34 D-34-1/D-34-2/D-34-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
  });

  const files = [{ kind: 'text', content: 'Flight KE012 ICN to JFK' }];
  const usage = { input_tokens: 5, output_tokens: 7 };
  const reply = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage });

  it('maps a bookings result to exactly the app shape the importer has always read (D-34-3)', async () => {
    mockCreate.mockResolvedValue(reply(bookingsAnswer()));

    const { extraction, model, usage: reported } = await extractBookings({ files });

    expect(Object.keys(extraction)).toEqual(['isTravelRelated', 'summary', 'language', 'bookings']);
    expect(extraction.isTravelRelated).toBe(true);
    expect(extraction.summary).toBe('One flight.');
    expect(extraction.language).toBe('en');
    const [booking] = extraction.bookings;
    expect(Object.keys(booking)).toEqual([
      'type', 'title', 'confirmationRef', 'bookingSource', 'startDatetime', 'endDatetime', 'origin', 'destination',
      'terminalOrStation', 'originTz', 'destinationTz', 'details', 'confidence', 'assumptions',
    ]);
    expect(booking).not.toHaveProperty('fieldConfidence');
    expect(booking.confidence).toEqual({ overall: 'high', fields: { startDatetime: 'low' } });
    expect(booking.details).toEqual({ originCity: 'Seoul', destinationCity: 'New York', carrierCode: 'KE', flightNumber: '012' });
    expect(Object.values(booking.details)).not.toContain('');
    expect(booking.bookingSource).toBeNull();
    expect(booking.assumptions).toEqual(['Year inferred from the trip dates.']);
    expect(model).toBe('claude-sonnet-5-5');
    expect(reported).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  it('reads a leading thinking block and one schema text block', async () => {
    mockCreate.mockResolvedValue({ content: [THINKING_BLOCK, { type: 'text', text: bookingsAnswer() }], stop_reason: 'end_turn', usage });

    const { extraction } = await extractBookings({ files });

    expect(extraction.bookings).toHaveLength(1);
  });

  it('maps travel_no_booking to a travel-related answer with no bookings (Q-34-1)', async () => {
    mockCreate.mockResolvedValue(reply(schemaAnswer({ kind: 'travel_no_booking' }, { summary: 'A fare sale, nothing booked.' })));

    const { extraction } = await extractBookings({ files });

    expect(extraction).toEqual({ isTravelRelated: true, summary: 'A fare sale, nothing booked.', language: 'en', bookings: [] });
  });

  it('maps not_travel to isTravelRelated false with no bookings', async () => {
    mockCreate.mockResolvedValue(reply(schemaAnswer({ kind: 'not_travel' })));

    const { extraction } = await extractBookings({ files });

    expect(extraction.isTravelRelated).toBe(false);
    expect(extraction.bookings).toEqual([]);
  });

  it('keeps every key even when all details are empty (details becomes an empty object)', async () => {
    mockCreate.mockResolvedValue(reply(bookingsAnswer(schemaBooking({ type: 'other', title: 'Airport transfer', fieldConfidence: [] }, { originCity: '', destinationCity: '', carrierCode: '', flightNumber: '' }))));

    const { extraction } = await extractBookings({ files });

    expect(extraction.bookings[0].details).toEqual({});
    expect(extraction.bookings[0].confidence).toEqual({ overall: 'high', fields: {} });
  });

  it('D-34-7: case-normalises enum values and returns the schema spelling', async () => {
    mockCreate.mockResolvedValue(reply(bookingsAnswer(schemaBooking({
      type: 'Flight',
      confidence: { overall: 'HIGH' },
      fieldConfidence: [{ field: 'FlightNumber', level: 'Low' }],
    }))));

    const { extraction } = await extractBookings({ files });

    expect(extraction.bookings[0].type).toBe('flight');
    expect(extraction.bookings[0].confidence).toEqual({ overall: 'high', fields: { flightNumber: 'low' } });
  });

  describe('a shape failure is a named 502 with raw kept, never a repair', () => {
    const cases = [
      ['two text blocks', { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }], stop_reason: 'end_turn', usage }, /exactly one text block, got 2/],
      ['no text block at all after a normal stop', { content: [THINKING_BLOCK], stop_reason: 'end_turn', usage }, /exactly one text block, got 0/],
      ['text that is not JSON (a fenced block)', reply('```json\n{}\n```'), /not JSON/],
      ['a missing result', reply(JSON.stringify({ summary: 'x', language: 'en' })), /result: is required/],
      ['an extra unknown key', reply(schemaAnswer({ kind: 'not_travel' }, { isTravelRelated: false })), /isTravelRelated: is not an allowed property/],
      ['kind bookings with an empty bookings array', reply(schemaAnswer({ kind: 'bookings', bookings: [] })), /result\.bookings: needs at least 1 item/],
      ['a booking under kind not_travel', reply(schemaAnswer({ kind: 'not_travel', bookings: [schemaBooking()] })), /result\.bookings: is not an allowed property/],
      ['a flight number that carries the airline code', reply(bookingsAnswer(schemaBooking({}, { flightNumber: 'KE012' }))), /result\.bookings\[0\]\.details\.flightNumber: does not match/],
      ['a bare UTC timezone', reply(bookingsAnswer(schemaBooking({ originTz: 'UTC' }))), /result\.bookings\[0\]\.originTz/],
    ];

    it.each(cases)('%s', async (_name, response, reason) => {
      mockCreate.mockResolvedValue(response);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const err = await extractBookings({ files }).catch((e) => e);

      expect(err.status).toBe(502);
      expect(err.message).toBe('The booking reader returned an unexpected shape.');
      expect(typeof err.raw).toBe('string');
      expect(warnSpy).toHaveBeenCalledWith('[import] extraction unexpected shape: %s', expect.stringMatching(reason));
      warnSpy.mockRestore();
    });

    it('keeps the first 2000 characters of the answer text as raw', async () => {
      mockCreate.mockResolvedValue(reply(`not json ${'x'.repeat(3000)}`));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const err = await extractBookings({ files }).catch((e) => e);

      expect(err.raw).toHaveLength(2000);
      expect(err.raw.startsWith('not json ')).toBe(true);
      warnSpy.mockRestore();
    });
  });

  it('a refusal is still named as a refusal, never as a shape failure', async () => {
    mockCreate.mockResolvedValue({ content: [], stop_reason: 'refusal', usage });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await extractBookings({ files }).catch((e) => e);

    expect(err.message).toMatch(/declined to process this input/);
    warnSpy.mockRestore();
  });
});

describe('validateAgainstSchema / toAppExtraction (D-34-2, D-34-3)', () => {
  it('returns a normalised deep copy and leaves its input untouched', () => {
    const input = JSON.parse(bookingsAnswer(schemaBooking({ type: 'Hotel' })));
    const before = JSON.stringify(input);

    const result = validateAgainstSchema(input, EXTRACTION_OUTPUT_SCHEMA);

    expect(result.ok).toBe(true);
    expect(result.value.result.bookings[0].type).toBe('hotel');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('names the first problem with its JSON path', () => {
    const input = JSON.parse(bookingsAnswer(schemaBooking({}, { carrierCode: 'KE012' })));
    const result = validateAgainstSchema(input, EXTRACTION_OUTPUT_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^result\.bookings\[0\]\.details\.carrierCode: does not match \^/);
    expect(validateAgainstSchema([], EXTRACTION_OUTPUT_SCHEMA)).toEqual({ ok: false, error: 'the answer: expected object, got array' });
  });

  it('accepts null where the schema allows it and rejects it where it does not', () => {
    expect(validateAgainstSchema(JSON.parse(bookingsAnswer(schemaBooking({ startDatetime: null, originTz: null }))), EXTRACTION_OUTPUT_SCHEMA).ok).toBe(true);
    expect(validateAgainstSchema(JSON.parse(bookingsAnswer(schemaBooking({ title: null }))), EXTRACTION_OUTPUT_SCHEMA).ok).toBe(false);
  });

  it('throws on a keyword it does not check, so a schema edit cannot go unchecked', () => {
    expect(() => validateAgainstSchema(1, { type: 'string', maxLength: 3 })).toThrow(/does not support the "maxLength" keyword/);
    expect(() => validateAgainstSchema(1, { type: 'integer' })).toThrow(/does not support type "integer"/);
    expect(() => validateAgainstSchema({}, { type: 'object', additionalProperties: { type: 'string' } })).toThrow(/additionalProperties: false/);
    expect(() => validateAgainstSchema({}, { $ref: '#/$defs/missing' })).toThrow(/cannot resolve \$ref/);
  });

  it('toAppExtraction drops "" details and folds fieldConfidence into confidence.fields', () => {
    const mapped = toAppExtraction(JSON.parse(bookingsAnswer(schemaBooking({ fieldConfidence: [{ field: 'title', level: 'medium' }, { field: 'origin', level: 'low' }] }))));
    expect(mapped.bookings[0].confidence).toEqual({ overall: 'high', fields: { title: 'medium', origin: 'low' } });
    expect(mapped.bookings[0].details).toEqual({ originCity: 'Seoul', destinationCity: 'New York', carrierCode: 'KE', flightNumber: '012' });
  });
});

describe('extraction output schema budget (D-34-5)', () => {
  const children = (node) => [
    ...Object.values(node.properties ?? {}),
    ...(node.items ? [node.items] : []),
    ...(node.anyOf ?? []),
    ...Object.values(node.$defs ?? {}),
  ];
  const allNodes = (node) => [node, ...children(node).flatMap(allNodes)];
  const nodes = allNodes(EXTRACTION_OUTPUT_SCHEMA);
  const details = EXTRACTION_OUTPUT_SCHEMA.$defs.booking.properties.details;

  it('has no optional property anywhere: every object requires exactly its own keys', () => {
    const objects = nodes.filter((n) => n.properties);
    expect(objects.length).toBeGreaterThan(5);
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
      expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
    }
  });

  it('spends 4 of 16 union definitions, counted once per definition ($ref is not followed)', () => {
    const unions = nodes.filter((n) => Array.isArray(n.anyOf) || Array.isArray(n.type));
    expect(unions).toHaveLength(4);
    expect(unions.length).toBeLessThanOrEqual(16);
  });

  it('details requires all 16 keys as strings, and every pattern accepts ""', () => {
    expect(details.required).toEqual(EXTRACTION_DETAIL_FIELDS);
    expect(EXTRACTION_DETAIL_FIELDS).toHaveLength(16);
    expect(Object.keys(details.properties)).toEqual(EXTRACTION_DETAIL_FIELDS);
    for (const prop of Object.values(details.properties)) {
      expect(prop.type).toBe('string');
      if (prop.pattern) expect(new RegExp(prop.pattern).test('')).toBe(true);
    }
  });

  it('lists every confidence field name once, and the details keys it can be unsure of are among them', () => {
    const enumList = EXTRACTION_OUTPUT_SCHEMA.$defs.booking.properties.fieldConfidence.items.properties.field.enum;
    expect(enumList).toEqual(EXTRACTION_CONFIDENCE_FIELDS);
    expect(new Set(enumList).size).toBe(26);
    for (const key of ['originCity', 'carrierCode', 'flightNumber', 'localName']) expect(enumList).toContain(key);
  });

  it('is deep-frozen, as is the format that carries it', () => {
    for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(EXTRACTION_OUTPUT_SCHEMA.required)).toBe(true);
    expect(Object.isFrozen(EXTRACTION_OUTPUT_FORMAT)).toBe(true);
    expect(EXTRACTION_OUTPUT_FORMAT).toEqual({ type: 'json_schema', schema: EXTRACTION_OUTPUT_SCHEMA });
  });

  it('keeps the booking type list identical to the importer\'s BOOKING_TYPES', () => {
    expect(EXTRACTION_OUTPUT_SCHEMA.$defs.booking.properties.type.enum).toEqual(['flight', 'train', 'bus', 'ferry', 'hotel', 'other']);
  });

  it('carrierCode and flightNumber patterns enforce the code/number split (D-34-4)', () => {
    const carrier = new RegExp(details.properties.carrierCode.pattern);
    for (const ok of ['KE', 'U2', '3K', 'KAL', '']) expect(carrier.test(ok)).toBe(true);
    for (const bad of ['54', 'KE012', 'ke']) expect(carrier.test(bad)).toBe(false);
    const number = new RegExp(details.properties.flightNumber.pattern);
    for (const ok of ['012', '2490A', '']) expect(number.test(ok)).toBe(true);
    for (const bad of ['KE012', '12345']) expect(number.test(bad)).toBe(false);
  });
});

describe('extraction prompt text (Plan 34 §4.3)', () => {
  it('pins the prompt text', () => {
    expect(createHash('sha256').update(EXTRACTION_SYSTEM).digest('hex')).toBe('84d2aec19bbb27f26d6dbdae804548478c2479838b615b14295a5bfa89452844');
  });

  it('carries the classification rule and the carrier/number rule, and no output-format instruction', () => {
    expect(EXTRACTION_SYSTEM).toContain('6. Classify the input in `result.kind`: `bookings` when it contains at least one booking you can extract; `travel_no_booking` when it is about travel but holds no booking (a fare sale, a newsletter, a price alert, travel advice); `not_travel` otherwise. Never invent a booking to reach `bookings`.');
    expect(EXTRACTION_SYSTEM).toContain('9. Put the airline code in `details.carrierCode` and only the number in `details.flightNumber`.');
    // Kept on measurement (W1 browser pass): without it, inputs that ask to see the reasoning draw a
    // reasoning_extraction refusal under the schema; the old contract never did.
    expect(EXTRACTION_SYSTEM.endsWith('\n10. Do not explain your reasoning in prose.')).toBe(true);
    for (const gone of ['fenced', '```', 'Output shape', 'isTravelRelated']) expect(EXTRACTION_SYSTEM).not.toContain(gone);
  });
});

describe('generatePhotoDescriptor — thinking blocks and stop reasons (D-30-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
  });

  it('reads the JSON from text blocks and ignores a leading thinking block', async () => {
    mockCreate.mockResolvedValue({
      content: [THINKING_BLOCK, { type: 'text', text: DESCRIPTOR_OK_TEXT }],
      stop_reason: 'end_turn',
    });

    const result = await generatePhotoDescriptor({ title: 'Night Market' });

    expect(result).toEqual({ photoQuery: 'night market skewers', sceneType: 'market' });
  });

  it('returns null and warns with the reason on a refusal', async () => {
    mockCreate.mockResolvedValue({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[photo] descriptor not usable',
      { title: 'Some Place', stopReason: 'refusal', category: 'cyber' },
    );
    warnSpy.mockRestore();
  });

  it('returns null and warns on a max_tokens stop during thinking', async () => {
    mockCreate.mockResolvedValue({ content: [THINKING_BLOCK], stop_reason: 'max_tokens' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await generatePhotoDescriptor({ title: 'Some Place' });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[photo] descriptor not usable',
      { title: 'Some Place', stopReason: 'max_tokens', category: null },
    );
    warnSpy.mockRestore();
  });

  it('warns on the model_context_window_exceeded stop too', async () => {
    mockCreate.mockResolvedValue({ content: [THINKING_BLOCK], stop_reason: 'model_context_window_exceeded' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await generatePhotoDescriptor({ title: 'Some Place' })).toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('warns why when the text is not JSON, and when photoQuery is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Sorry.' }], stop_reason: 'end_turn' });
    expect(await generatePhotoDescriptor({ title: 'A' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'A', reason: expect.stringMatching(/^not JSON \(/) });

    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"sceneType":"market"}' }], stop_reason: 'end_turn' });
    expect(await generatePhotoDescriptor({ title: 'B' })).toBeNull();
    expect(warnSpy).toHaveBeenLastCalledWith('[photo] descriptor not usable', { title: 'B', reason: 'photoQuery: is required' });

    warnSpy.mockRestore();
  });
});

describe('discoverDestination — end-of-generation line and stop reasons (D-30-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockReset();
  });

  function endLine(logSpy) {
    return logSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith('[discover] end'));
  }

  it('parses text deltas and ignores a leading thinking block, logging one end line on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks = ndjsonChunks(FOUR_HEALTHY_CATEGORIES);
    mockStream.mockReturnValue(makeMockStream(chunks, undefined, [THINKING_BLOCK, { type: 'text', text: chunks.join('') }], undefined, {
      usage: { input_tokens: 100, output_tokens: 4321 },
    }));

    const result = await discoverDestination('kyoto', []);

    expect(result).toHaveLength(4);
    const line = endLine(logSpy);
    expect(line).toBeDefined();
    // destination, stop_reason, category, output_tokens, categories, items, dropped, complete, deduped, unnamed
    expect(line.slice(1)).toEqual(['kyoto', 'end_turn', null, 4321, 4, 4, 0, false, 0, 0]);
    expect(logSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].startsWith('[discover] ok'))).toBe(true);
    logSpy.mockRestore();
  });

  it('fails a refused generation, naming destination, reason and category, and logs the end line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStream.mockReturnValue(makeMockStream([], undefined, [], 'refusal', {
      stopDetails: { type: 'refusal', category: 'cyber' },
      usage: { input_tokens: 10, output_tokens: 0 },
    }));

    await expect(discoverDestination('kyoto', [])).rejects.toThrow(
      /generation refused for destination=kyoto: stop_reason=refusal category=cyber, 0 categories with items/,
    );

    expect(endLine(logSpy).slice(1)).toEqual(['kyoto', 'refusal', 'cyber', 0, 0, 0, 0, false, 0, 0]);
    expect(logSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].startsWith('[discover] ok'))).toBe(false);
    logSpy.mockRestore();
  });

  it('fails a max_tokens stop during thinking (no text) as truncated, not as thin yield', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStream.mockReturnValue(makeMockStream([], undefined, [THINKING_BLOCK], 'max_tokens'));

    await expect(discoverDestination('kyoto', [])).rejects.toThrow(/generation truncated for destination=kyoto: stop_reason=max_tokens/);

    expect(endLine(logSpy)[2]).toBe('max_tokens');
    logSpy.mockRestore();
  });

  it('fails a truncated generation even when enough categories parsed — the catalogue must stay stale', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStream.mockReturnValue(makeMockStream(ndjsonChunks(FOUR_HEALTHY_CATEGORIES), undefined, undefined, 'model_context_window_exceeded'));

    await expect(discoverDestination('kyoto', [])).rejects.toThrow(/generation truncated.*model_context_window_exceeded/);

    expect(endLine(logSpy).slice(1)).toEqual(['kyoto', 'model_context_window_exceeded', null, 20, 4, 4, 0, false, 0, 0]);
    logSpy.mockRestore();
  });

  it('logs the end line when the stream itself rejects, and rethrows', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStream.mockReturnValue({
      on() { return this; },
      async finalMessage() { throw new Error('socket hang up'); },
    });

    await expect(discoverDestination('kyoto', [])).rejects.toThrow('socket hang up');

    const line = errorSpy.mock.calls.find((c) => typeof c[0] === 'string' && c[0].startsWith('[discover] end'));
    expect(line).toBeDefined();
    expect(line[0]).toContain('stop_reason=error');
    expect(line[1]).toBe('kyoto');
    expect(line.at(-1)).toBe('socket hang up');
    errorSpy.mockRestore();
  });
});

describe('streamCopilotResponse — thinking blocks and stop reasons (D-30-3, D-30-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockReset();
  });

  const noticesOf = (res) => parseEvents(res).filter((e) => e.type === 'notice');
  const typesOf = (res) => parseEvents(res).map((e) => e.type);
  const proposalContent = [
    { type: 'text', text: 'Here is a plan.' },
    { type: 'tool_use', id: 'tu_p', name: 'propose_itinerary_changes', input: { operations: [{ action: 'remove_stop', stopId: 's1' }] } },
  ];

  it('replays the assistant content, thinking block included and unchanged, into the next iteration', async () => {
    const firstContent = [THINKING_BLOCK, toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_1')];
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, firstContent))
      .mockReturnValueOnce(makeMockStream(['Done.'], undefined, [THINKING_BLOCK, { type: 'text', text: 'Done.' }]));
    const executor = vi.fn().mockResolvedValue({ places: [] });

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'ideas?' }], {}, res, {}, undefined, { search_discovery_catalogue: executor });

    expect(mockStream).toHaveBeenCalledTimes(2);
    const secondMessages = mockStream.mock.calls[1][0].messages;
    expect(secondMessages[1]).toEqual({ role: 'assistant', content: firstContent });
    expect(secondMessages[1].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-abc' });
    expect(secondMessages[2].role).toBe('user');
    // Prose streamed from text events only; the thinking block contributes nothing.
    expect(parseEvents(res).filter((e) => e.type === 'text').map((e) => e.content).join('')).toBe('Done.');
    expect(noticesOf(res)).toEqual([]);
  });

  it('refusal: notice "refused", no proposal even with a tool_use present, then done', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, proposalContent, 'refusal'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const persistTurn = vi.fn().mockResolvedValue(null);

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn);

    expect(noticesOf(res)).toEqual([{ type: 'notice', notice: 'refused' }]);
    expect(typesOf(res)).not.toContain('proposal');
    expect(typesOf(res).at(-1)).toBe('done');
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: '', operations: null, notice: 'refused' });
    warnSpy.mockRestore();
  });

  it('refusal reports the raw stop reason in the turn metrics', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [], 'refusal'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, makeMockRes(), {}, undefined, {}, reportTurnMetrics);

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'refusal', error: 0, proposalOps: 0 });
    warnSpy.mockRestore();
  });

  it('max_tokens during thinking (content is only a thinking block): notice "truncated", then done', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK], 'max_tokens'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res);

    expect(noticesOf(res)).toEqual([{ type: 'notice', notice: 'truncated' }]);
    expect(typesOf(res).at(-1)).toBe('done');
  });

  it('model_context_window_exceeded is treated as truncated, discarding a cut proposal', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, proposalContent, 'model_context_window_exceeded'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res);

    expect(noticesOf(res)).toEqual([{ type: 'notice', notice: 'truncated' }]);
    expect(typesOf(res)).not.toContain('proposal');
  });

  it('a thinking-only end_turn emits exactly one "empty" notice before done', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK], 'end_turn'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, vi.fn().mockResolvedValue(null));

    expect(noticesOf(res)).toEqual([{ type: 'notice', notice: 'empty' }]);
    const types = typesOf(res);
    expect(types.indexOf('notice')).toBeLessThan(types.indexOf('done'));
    expect(types.at(-1)).toBe('done');
  });

  it('a proposal-only turn (no text, even from the explain step) is not "empty"', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [
        THINKING_BLOCK,
        { type: 'tool_use', id: 'tu_p', name: 'propose_itinerary_changes', input: { operations: [{ action: 'remove_stop', stopId: 's1' }] } },
      ]))
      .mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK], 'end_turn'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, vi.fn().mockResolvedValue({ proposalId: 'p1', operations: [{ action: 'remove_stop', stopId: 's1' }] }));

    expect(noticesOf(res)).toEqual([]);
    expect(typesOf(res)).toContain('proposal');
  });

  it('a normal text turn emits no notice at all', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['Hi there'], undefined, [THINKING_BLOCK, { type: 'text', text: 'Hi there' }]));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res);

    expect(noticesOf(res)).toEqual([]);
  });
});

describe('streamCopilotResponse — keep-alive ping (D-30-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockReset();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A stream whose final message waits on a promise the test controls.
  function makeHeldStream() {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const stream = {
      on() { return stream; },
      abort() {},
      finalMessage: () => held,
    };
    return { stream, release };
  }

  const pingsOf = (res) => parseEvents(res).filter((e) => e.type === 'ping');

  it('is 8 s, matching the discovery route keep-alive', () => {
    expect(COPILOT_PING_INTERVAL_MS).toBe(8000);
  });

  it('writes a ping every 8 s while the model is silent, not before, and stops after done', async () => {
    const { stream, release } = makeHeldStream();
    mockStream.mockReturnValueOnce(stream);

    const res = makeMockRes();
    const turn = streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res);

    vi.advanceTimersByTime(COPILOT_PING_INTERVAL_MS - 1);
    expect(pingsOf(res)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pingsOf(res)).toHaveLength(1);
    vi.advanceTimersByTime(COPILOT_PING_INTERVAL_MS * 2);
    expect(pingsOf(res)).toHaveLength(3);
    // The keep-alive is the only thing on the wire so far.
    expect(parseEvents(res).every((e) => e.type === 'ping')).toBe(true);

    release({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    await turn;

    const pingsAtDone = pingsOf(res).length;
    expect(parseEvents(res).at(-1).type).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(COPILOT_PING_INTERVAL_MS * 5);
    expect(pingsOf(res)).toHaveLength(pingsAtDone);
  });

  it('clears the interval when the stream errors', async () => {
    const { stream } = makeHeldStream();
    stream.finalMessage = () => Promise.reject(new Error('boom'));
    mockStream.mockReturnValueOnce(stream);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, makeMockRes());

    expect(vi.getTimerCount()).toBe(0);
    errorSpy.mockRestore();
  });

  it('clears the interval on the aborted early return too', async () => {
    const res = makeMockRes();
    const stream = {
      on() { return stream; },
      abort() {},
      async finalMessage() {
        res.triggerClose();
        return { content: [], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    mockStream.mockReturnValueOnce(stream);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps pinging across a slow query-tool executor between iterations', async () => {
    let releaseExecutor;
    const executor = vi.fn(() => new Promise((resolve) => { releaseExecutor = () => resolve({ ok: true }); }));
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'X' }, 'tu_1')]))
      .mockReturnValueOnce(makeMockStream(['Done'], 'Done'));

    const res = makeMockRes();
    const turn = streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined, { search_discovery_catalogue: executor });
    // Let iteration 1 resolve and the executor start.
    await vi.advanceTimersByTimeAsync(0);
    expect(executor).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(COPILOT_PING_INTERVAL_MS * 2);
    expect(pingsOf(res)).toHaveLength(2);

    releaseExecutor();
    await turn;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('streamCopilotResponse — client abort is not an error (D-30-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockReset();
  });

  // A stream whose finalMessage() fires the res 'close' handler and then REJECTS — what the real
  // SDK does on abort() (APIUserAbortError). currentMessage is the SDK's partial snapshot.
  function makeRejectingAbortStream(res, currentMessage) {
    const stream = {
      on() { return stream; },
      abort() {},
      currentMessage,
      async finalMessage() {
        res.triggerClose();
        throw new Error('Request was aborted.');
      },
    };
    return stream;
  }

  it('records one client_abort turn with the partial usage, error 0, and writes nothing else', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce(makeRejectingAbortStream(res, {
      usage: { input_tokens: 800, output_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 500 },
    }));
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const persistTurn = vi.fn();

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      stopReason: 'client_abort',
      error: 0,
      proposalOps: 0,
      inputTokens: 800,
      outputTokens: 12,
      cacheWriteTokens: 300,
      cacheReadTokens: 500,
      iterations: 1,
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].startsWith('[copilot] client aborted turn'))).toBe(true);
    // D-30-8: the stopped turn is still saved (here with no text yet), never with operations.
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: '', operations: null, notice: 'stopped' });
    expect(parseEvents(res).filter((e) => e.type === 'error' || e.type === 'done')).toEqual([]);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('adds the aborted iteration\'s partial usage to the iterations already completed', async () => {
    const res = makeMockRes();
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'X' }, 'tu_1')], undefined, {
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 0 },
      }))
      .mockReturnValueOnce(makeRejectingAbortStream(res, {
        usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 },
      }));
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined,
      { search_discovery_catalogue: vi.fn().mockResolvedValue({ ok: true }) }, reportTurnMetrics);

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({
      stopReason: 'client_abort',
      error: 0,
      inputTokens: 107,
      outputTokens: 13,
      cacheWriteTokens: 40,
      cacheReadTokens: 40,
      iterations: 2,
      queryCalls: 1,
    });
    logSpy.mockRestore();
  });

  it('records zero usage (not a crash) when the rejected stream has no snapshot yet', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce(makeRejectingAbortStream(res, undefined));
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined, {}, reportTurnMetrics);

    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', error: 0, inputTokens: 0, outputTokens: 0 });
    logSpy.mockRestore();
  });

  it('records the abort once when the client drops between iterations, during a query tool', async () => {
    const res = makeMockRes();
    const executor = vi.fn(async () => {
      res.triggerClose();
      return { ok: true };
    });
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'X' }, 'tu_1')], undefined, {
      usage: { input_tokens: 50, output_tokens: 5 },
    }));
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined,
      { search_discovery_catalogue: executor }, reportTurnMetrics);

    expect(mockStream).toHaveBeenCalledOnce();
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({
      stopReason: 'client_abort', error: 0, inputTokens: 50, outputTokens: 5, iterations: 1, queryCalls: 1,
    });
    logSpy.mockRestore();
  });

  it('a genuine error (client still connected) keeps error 1 even when the stream exposes a snapshot', async () => {
    const stream = {
      on() { return stream; },
      abort() {},
      currentMessage: { usage: { input_tokens: 9, output_tokens: 9 } },
      async finalMessage() { throw new Error('upstream 529'); },
    };
    mockStream.mockReturnValueOnce(stream);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined, {}, reportTurnMetrics);

    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ error: 1, proposalOps: 0, inputTokens: 0, outputTokens: 0 });
    expect(reportTurnMetrics.mock.calls[0][0].stopReason).not.toBe('client_abort');
    expect(parseEvents(res).find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'upstream 529' });
    errorSpy.mockRestore();
  });
});

describe('streamCopilotResponse — every turn persists one assistant row (D-30-8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockReset();
  });

  const noticesOf = (res) => parseEvents(res).filter((e) => e.type === 'notice');
  const proposeContent = [
    { type: 'text', text: 'Sure.' },
    { type: 'tool_use', id: 'tu_p', name: 'propose_itinerary_changes', input: { operations: [{ action: 'remove_stop', stopId: 's1' }] } },
  ];

  // Streams `chunks` through the text listener, then runs `end()` — the point where the turn
  // stops being a normal one. Mirrors the real SDK: abort makes finalMessage() reject.
  function makeStreamThen(chunks, end) {
    let onText = null;
    const stream = {
      on(event, cb) { if (event === 'text') onText = cb; return stream; },
      abort() {},
      currentMessage: { usage: { input_tokens: 5, output_tokens: 2 } },
      async finalMessage() {
        for (const chunk of chunks) onText?.(chunk);
        return end();
      },
    };
    return stream;
  }

  let logSpy;
  let errorSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('abort with finalMessage() rejecting: saves the partial text as stopped, metrics unchanged', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce(makeStreamThen(['Day 2 is ', 'busy'], () => {
      res.triggerClose();
      throw new Error('Request was aborted.');
    }));
    const persistTurn = vi.fn().mockResolvedValue(null);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Day 2 is busy', operations: null, notice: 'stopped' });
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', error: 0, proposalOps: 0 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('abort with finalMessage() resolving after the drop: saves the text as stopped, never the proposal', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce(makeStreamThen(['Sure.'], () => {
      res.triggerClose();
      return { content: proposeContent, stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2 } };
    }));
    const persistTurn = vi.fn().mockResolvedValue(null);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Sure.', operations: null, notice: 'stopped' });
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', error: 0, proposalOps: 0 });
    expect(parseEvents(res).map((e) => e.type)).not.toContain('proposal');
  });

  it('abort between iterations (during a query tool): saves the earlier text as stopped', async () => {
    const res = makeMockRes();
    const executor = vi.fn(async () => {
      res.triggerClose();
      return { ok: true };
    });
    mockStream.mockReturnValueOnce(makeMockStream(['Let me check. '], undefined, [
      { type: 'text', text: 'Let me check. ' },
      toolUseBlock('search_discovery_catalogue', { destination: 'X' }, 'tu_1'),
    ]));
    const persistTurn = vi.fn().mockResolvedValue(null);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn,
      { search_discovery_catalogue: executor }, reportTurnMetrics);

    expect(mockStream).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Let me check. ', operations: null, notice: 'stopped' });
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', error: 0 });
  });

  it('abort while propose_itinerary_changes was streaming: operations is null', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce(makeStreamThen(['Sure.'], () => {
      res.triggerClose();
      throw new Error('Request was aborted.');
    }));
    const persistTurn = vi.fn().mockResolvedValue(null);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, vi.fn());

    expect(persistTurn.mock.calls[0][0].operations).toBeNull();
  });

  it('a persistTurn failure on abort is logged and does not break the metrics', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce(makeStreamThen(['Hi'], () => {
      res.triggerClose();
      throw new Error('Request was aborted.');
    }));
    const persistTurn = vi.fn().mockRejectedValue(new Error('disk full'));
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(errorSpy).toHaveBeenCalledWith('[copilot] persistTurn failed:', expect.any(Error));
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', error: 0 });
  });

  it('genuine error mid-reply: saves the partial text as interrupted, error metrics, error event', async () => {
    mockStream.mockReturnValueOnce(makeStreamThen(['Half a thou'], () => {
      throw new Error('upstream 529');
    }));
    const persistTurn = vi.fn().mockResolvedValue(null);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const res = makeMockRes();

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Half a thou', operations: null, notice: 'interrupted' });
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ error: 1, proposalOps: 0 });
    expect(parseEvents(res).find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'upstream 529' });
  });

  it('a throw after the success-path persist does not write a second row', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['Fine.'], 'Fine.'));
    const persistTurn = vi.fn().mockResolvedValue(null);
    // recordMetrics swallows its own failures, so make the post-persist SSE write throw instead.
    const res = makeMockRes();
    const realWrite = res.write.bind(res);
    let exploded = false;
    res.write = (chunk) => {
      if (!exploded && chunk.includes('"type":"done"')) {
        exploded = true;
        throw new Error('socket exploded');
      }
      realWrite(chunk);
    };

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, vi.fn());

    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Fine.', operations: null, notice: null });
  });

  it('success-path notices: truncated, refused, empty, and null for normal and proposal-only turns', async () => {
    const run = async (...streamArgs) => {
      mockStream.mockReturnValueOnce(makeMockStream(...streamArgs));
      const persistTurn = vi.fn().mockResolvedValue(null);
      const res = makeMockRes();
      await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {});
      return { call: persistTurn.mock.calls[0][0], res };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const truncated = await run(['cut'], 'cut', [{ type: 'text', text: 'cut' }], 'max_tokens');
    expect(truncated.call).toEqual({ assistantText: 'cut', operations: null, notice: 'truncated' });

    const refused = await run([], undefined, [], 'refusal');
    expect(refused.call).toEqual({ assistantText: '', operations: null, notice: 'refused' });

    const empty = await run([], undefined, [THINKING_BLOCK], 'end_turn');
    expect(empty.call).toEqual({ assistantText: '', operations: null, notice: 'empty' });
    // D-30-4 untouched: the SSE side still emits its own single 'empty' notice.
    expect(noticesOf(empty.res)).toEqual([{ type: 'notice', notice: 'empty' }]);

    const normal = await run(['Hello'], 'Hello');
    expect(normal.call).toEqual({ assistantText: 'Hello', operations: null, notice: null });

    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK, proposeContent[1]]));
    const proposalOnly = await run([], undefined, [THINKING_BLOCK], 'end_turn');
    expect(proposalOnly.call).toEqual({
      assistantText: '',
      operations: [{ action: 'remove_stop', stopId: 's1' }],
      notice: null,
    });
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// D-30-9 (Plan 30 W5) - amends the Plan 11 Wave 1 terminal-tool rule. A propose_itinerary_changes
// call still ends tool execution, but no longer ends the turn: one acknowledgement tool_result and
// one tool_choice 'none' explain step follow, so the explanation is written as final text.
// ---------------------------------------------------------------------------

describe('streamCopilotResponse - proposal acknowledgement and explain step (D-30-9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.mockReset();
  });

  const OPS = [{ action: 'remove_stop', stopId: 's1' }, { action: 'remove_stop', stopId: 's2' }];
  const proposeBlock = (operations = OPS, id = 'tu_prop') => (
    { type: 'tool_use', id, name: 'propose_itinerary_changes', input: { operations } }
  );
  const typesOf = (res) => parseEvents(res).map((e) => e.type);
  const textOf = (res) => parseEvents(res).filter((e) => e.type === 'text').map((e) => e.content).join('');

  it('replays the assistant content unchanged and acknowledges the propose block with exactly one tool_result', async () => {
    const firstContent = [THINKING_BLOCK, proposeBlock()];
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, firstContent))
      .mockReturnValueOnce(makeMockStream(['Both stops go.'], undefined, [{ type: 'text', text: 'Both stops go.' }], 'end_turn'));

    await streamCopilotResponse([{ role: 'user', content: 'drop s1 and s2' }], {}, makeMockRes());

    expect(mockStream).toHaveBeenCalledTimes(2);
    const messages = mockStream.mock.calls[1][0].messages;
    expect(messages).toHaveLength(3);
    // Preserved-thinking rule: the assistant turn is replayed as the same content, thinking block included.
    expect(messages[1]).toEqual({ role: 'assistant', content: firstContent });
    expect(messages[1].content).toBe(firstContent);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0].type).toBe('tool_result');
    expect(messages[2].content[0].tool_use_id).toBe('tu_prop');
    expect(JSON.parse(messages[2].content[0].content)).toEqual({ status: 'received', operationCount: 2 });
  });

  it('acknowledges a proposal with a malformed operations field as operationCount 0', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [{ type: 'tool_use', id: 'tu_bad', name: 'propose_itinerary_changes', input: {} }]))
      .mockReturnValueOnce(makeMockStream(['Hm.'], undefined, [{ type: 'text', text: 'Hm.' }], 'end_turn'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res);

    const ack = mockStream.mock.calls[1][0].messages.at(-1).content[0];
    expect(JSON.parse(ack.content)).toEqual({ status: 'received', operationCount: 0 });
    expect(typesOf(res)).not.toContain('proposal');
  });

  it('sends tool_choice none on the explain call only, with the tools list unchanged', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Done.'], undefined, [{ type: 'text', text: 'Done.' }], 'end_turn'));

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, makeMockRes());

    const [first, second] = mockStream.mock.calls.map((c) => c[0]);
    // The key must not exist at all on a non-explain call - not even as undefined.
    expect(Object.hasOwn(first, 'tool_choice')).toBe(false);
    expect(second.tool_choice).toEqual({ type: 'none' });
    expect(second.tools).toEqual(first.tools);
    expect(second.tools.map((t) => t.name)).toEqual(
      ['propose_itinerary_changes', 'search_discovery_catalogue', 'check_trip_health'],
    );
    expect(second.system).toEqual(first.system);
    expect(second.model).toBe(first.model);
    expect(second.max_tokens).toBe(first.max_tokens);
  });

  it('sends no tool_choice key on a plain-text turn or on any call of a query-tool turn', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['Hi.'], 'Hi.'));
    await streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, makeMockRes());
    expect(mockStream).toHaveBeenCalledOnce();
    expect(Object.hasOwn(mockStream.mock.calls[0][0], 'tool_choice')).toBe(false);

    mockStream.mockReset();
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_1')]))
      .mockReturnValueOnce(makeMockStream(['Here.'], undefined, [{ type: 'text', text: 'Here.' }], 'end_turn'));
    await streamCopilotResponse([{ role: 'user', content: 'ideas?' }], {}, makeMockRes(), {}, undefined,
      { search_discovery_catalogue: vi.fn().mockResolvedValue({ places: [] }) });
    expect(mockStream).toHaveBeenCalledTimes(2);
    for (const [body] of mockStream.mock.calls) {
      expect(Object.hasOwn(body, 'tool_choice')).toBe(false);
    }
  });

  it('a query round-trip before the proposal still works: explain is the third call, tool_choice none only there', async () => {
    const executor = vi.fn().mockResolvedValue({ places: [] });
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_1')]))
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Added.'], undefined, [{ type: 'text', text: 'Added.' }], 'end_turn'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined, { search_discovery_catalogue: executor });

    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(executor).toHaveBeenCalledOnce();
    const bodies = mockStream.mock.calls.map((c) => c[0]);
    expect(bodies.map((b) => Object.hasOwn(b, 'tool_choice'))).toEqual([false, false, true]);
    expect(bodies[2].messages).toHaveLength(5);
    expect(typesOf(res)).toContain('proposal');
  });

  it('writes the explanation as text events before the proposal event, and persists it with the operations once', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK, proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Both stops ', 'go: they clash.'], undefined, [{ type: 'text', text: 'Both stops go: they clash.' }], 'end_turn'));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    const res = makeMockRes();
    const returned = await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    const types = typesOf(res);
    expect(textOf(res)).toBe('Both stops go: they clash.');
    expect(types.lastIndexOf('text')).toBeLessThan(types.indexOf('proposal'));
    expect(types.indexOf('proposal')).toBeLessThan(types.indexOf('done'));
    expect(types.filter((t) => t === 'proposal')).toHaveLength(1);
    expect(types).not.toContain('notice');
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Both stops go: they clash.', operations: OPS, notice: null });
    expect(returned).toBe('Both stops go: they clash.');
    expect(reportTurnMetrics).toHaveBeenCalledOnce();
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ iterations: 2, proposalOps: 2, stopReason: 'end_turn', error: 0 });
  });

  const toolEvents = (res) => parseEvents(res).filter((e) => e.type === 'tool');
  const PROPOSE_STARTED = { type: 'tool', tool: 'propose_itinerary_changes', state: 'started' };
  const PROPOSE_DONE = { type: 'tool', tool: 'propose_itinerary_changes', state: 'done' };

  it('reports the proposal as an active tool from the call until the first explanation delta', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK, proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Moved ', 'it.'], undefined, [{ type: 'text', text: 'Moved it.' }], 'end_turn'));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'move it' }], {}, res, {}, persistTurn);

    const events = parseEvents(res).filter((e) => e.type !== 'ping');
    expect(toolEvents(res)).toEqual([PROPOSE_STARTED, PROPOSE_DONE]);
    const started = events.findIndex((e) => e.type === 'tool' && e.state === 'started');
    const done = events.findIndex((e) => e.type === 'tool' && e.state === 'done');
    const firstText = events.findIndex((e) => e.type === 'text');
    const proposal = events.findIndex((e) => e.type === 'proposal');
    // 'started' is the first thing the client sees; 'done' lands immediately before the first delta.
    expect(started).toBe(0);
    expect(done).toBe(firstText - 1);
    expect(firstText).toBeLessThan(proposal);
  });

  it('closes the proposal activity when the explain step ends without text, before the notice and proposal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream([], undefined, [], 'refusal'));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn);

    const types = typesOf(res).filter((t) => t !== 'ping');
    expect(toolEvents(res)).toEqual([PROPOSE_STARTED, PROPOSE_DONE]);
    expect(types).toEqual(['tool', 'tool', 'notice', 'proposal', 'done']);
    warnSpy.mockRestore();
  });

  it('reports no proposal activity on a plain-text turn or a query-only turn', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['Hi.'], 'Hi.'));
    const plain = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'hi' }], {}, plain);
    expect(toolEvents(plain)).toEqual([]);

    mockStream.mockReset();
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_1')]))
      .mockReturnValueOnce(makeMockStream(['Here.'], undefined, [{ type: 'text', text: 'Here.' }], 'end_turn'));
    const query = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'ideas?' }], {}, query, {}, undefined,
      { search_discovery_catalogue: vi.fn().mockResolvedValue({ places: [] }) });
    expect(toolEvents(query).map((e) => e.tool)).toEqual(['search_discovery_catalogue', 'search_discovery_catalogue']);
  });

  const proposeBlockStart = (id = 'tu_prop') => (
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'propose_itinerary_changes', input: {} } }
  );

  it('reports the proposal as started when its tool_use block opens, before the response ends, and only once', async () => {
    const res = makeMockRes();
    let eventsWhenBlockOpened = null;
    let streamEventListener = null;
    mockStream
      .mockReturnValueOnce({
        on(event, cb) { if (event === 'streamEvent') streamEventListener = cb; return this; },
        abort() {},
        async finalMessage() {
          streamEventListener(proposeBlockStart());
          // The operations are still streaming at this point; the response has not ended.
          eventsWhenBlockOpened = parseEvents(res).filter((e) => e.type !== 'ping');
          return { content: [proposeBlock()], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2 } };
        },
      })
      .mockReturnValueOnce(makeMockStream(['Moved.'], undefined, [{ type: 'text', text: 'Moved.' }], 'end_turn'));

    await streamCopilotResponse([{ role: 'user', content: 'move it' }], {}, res);

    expect(eventsWhenBlockOpened).toEqual([PROPOSE_STARTED]);
    expect(toolEvents(res)).toEqual([PROPOSE_STARTED, PROPOSE_DONE]);
  });

  it('ignores block starts for query tools and text', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('check_trip_health', {}, 'tu_h')], undefined, {
        streamEvents: [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_h', name: 'check_trip_health', input: {} } },
        ],
      }))
      .mockReturnValueOnce(makeMockStream(['All good.'], undefined, [{ type: 'text', text: 'All good.' }], 'end_turn'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'check' }], {}, res, {}, undefined,
      { check_trip_health: vi.fn().mockResolvedValue({ findings: [] }) });

    expect(toolEvents(res).map((e) => e.tool)).toEqual(['check_trip_health', 'check_trip_health']);
  });

  it('closes the proposal activity when the propose response is cut before the explain step', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()], 'max_tokens', {
      streamEvents: [proposeBlockStart()],
    }));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, vi.fn().mockResolvedValue(null));

    expect(mockStream).toHaveBeenCalledOnce();
    expect(parseEvents(res).filter((e) => e.type !== 'ping')).toEqual([
      PROPOSE_STARTED,
      PROPOSE_DONE,
      { type: 'notice', notice: 'truncated' },
      { type: 'done' },
    ]);
  });

  it('a query round-trip before the proposal reports each tool in turn', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_1')]))
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Added.'], undefined, [{ type: 'text', text: 'Added.' }], 'end_turn'));

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, undefined,
      { search_discovery_catalogue: vi.fn().mockResolvedValue({ places: [] }) });

    expect(toolEvents(res)).toEqual([
      { type: 'tool', tool: 'search_discovery_catalogue', state: 'started' },
      { type: 'tool', tool: 'search_discovery_catalogue', state: 'done' },
      PROPOSE_STARTED,
      PROPOSE_DONE,
    ]);
  });

  it('never executes anything from the explain step, and a tool_use there cannot overwrite the proposal', async () => {
    const executor = vi.fn();
    const otherOps = [{ action: 'remove_stop', stopId: 'other' }];
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [
        toolUseBlock('search_discovery_catalogue', { destination: 'Kyoto' }, 'tu_q'),
        proposeBlock(),
      ]))
      .mockReturnValueOnce(makeMockStream(['Explained.'], undefined, [
        { type: 'text', text: 'Explained.' },
        toolUseBlock('search_discovery_catalogue', { destination: 'Osaka' }, 'tu_q2'),
        proposeBlock(otherOps, 'tu_prop2'),
      ]));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, { search_discovery_catalogue: executor });

    // (e) a query tool_use beside the propose block is ignored outright, in both responses.
    expect(executor).not.toHaveBeenCalled();
    expect(mockStream).toHaveBeenCalledTimes(2);
    // Only the proposal's own activity events - no query tool ever reports as running.
    expect(parseEvents(res).filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', tool: 'propose_itinerary_changes', state: 'started' },
      { type: 'tool', tool: 'propose_itinerary_changes', state: 'done' },
    ]);
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn.mock.calls[0][0].operations).toEqual(OPS);
  });

  it('explain step cut by max_tokens: the proposal is still emitted, with a truncated notice', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Both stops'], undefined, [{ type: 'text', text: 'Both stops' }], 'max_tokens'));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    const events = parseEvents(res);
    expect(events.filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', notice: 'truncated' }]);
    expect(events.find((e) => e.type === 'proposal')).toMatchObject({ proposalId: 'p1' });
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Both stops', operations: OPS, notice: 'truncated' });
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'max_tokens', proposalOps: 2, iterations: 2 });
  });

  it('explain step refused: the proposal is still emitted, with a refused notice', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream([], undefined, [], 'refusal'));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn);

    expect(parseEvents(res).filter((e) => e.type === 'notice')).toEqual([{ type: 'notice', notice: 'refused' }]);
    expect(typesOf(res)).toContain('proposal');
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: '', operations: OPS, notice: 'refused' });
    warnSpy.mockRestore();
  });

  it('truncation BEFORE the proposal still discards it and makes no explain call (Plan 11 D5)', async () => {
    mockStream.mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()], 'max_tokens'));
    const persistTurn = vi.fn().mockResolvedValue(null);

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn);

    expect(mockStream).toHaveBeenCalledOnce();
    expect(typesOf(res)).not.toContain('proposal');
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: '', operations: null, notice: 'truncated' });
  });

  it('client abort right after the propose response: no explain call, no proposal, saved as stopped', async () => {
    const res = makeMockRes();
    mockStream.mockReturnValueOnce({
      on() { return this; },
      abort() {},
      async finalMessage() {
        res.triggerClose();
        return { content: [proposeBlock()], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2 } };
      },
    });
    const persistTurn = vi.fn().mockResolvedValue(null);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(mockStream).toHaveBeenCalledOnce();
    expect(typesOf(res)).not.toContain('proposal');
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: '', operations: null, notice: 'stopped' });
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', proposalOps: 0, error: 0 });
    logSpy.mockRestore();
  });

  it('client abort during the explain step: partial text saved as stopped, never the proposal', async () => {
    const res = makeMockRes();
    let onText = null;
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce({
        on(event, cb) { if (event === 'text') onText = cb; return this; },
        abort() {},
        currentMessage: { usage: { input_tokens: 4, output_tokens: 1 } },
        async finalMessage() {
          onText?.('Both ');
          res.triggerClose();
          throw new Error('Request was aborted.');
        },
      });
    const persistTurn = vi.fn().mockResolvedValue(null);
    const reportTurnMetrics = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn, {}, reportTurnMetrics);

    expect(typesOf(res)).not.toContain('proposal');
    expect(persistTurn).toHaveBeenCalledOnce();
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: 'Both ', operations: null, notice: 'stopped' });
    expect(reportTurnMetrics.mock.calls[0][0]).toMatchObject({ stopReason: 'client_abort', proposalOps: 0, iterations: 2 });
    logSpy.mockRestore();
  });

  it('an explain step with no text still emits the proposal and no "empty" notice', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK, proposeBlock()]))
      .mockReturnValueOnce(makeMockStream([], undefined, [THINKING_BLOCK], 'end_turn'));
    const persistTurn = vi.fn().mockResolvedValue({ proposalId: 'p1', operations: OPS });

    const res = makeMockRes();
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, res, {}, persistTurn);

    const types = typesOf(res);
    expect(types).toContain('proposal');
    expect(types).not.toContain('notice');
    expect(persistTurn).toHaveBeenCalledWith({ assistantText: '', operations: OPS, notice: null });
  });

  it('runs exactly one explain step per turn', async () => {
    mockStream
      .mockReturnValueOnce(makeMockStream([], undefined, [proposeBlock()]))
      .mockReturnValueOnce(makeMockStream(['Words.'], undefined, [{ type: 'text', text: 'Words.' }, proposeBlock(OPS, 'tu_again')]))
      .mockReturnValueOnce(makeMockStream(['never'], 'never'));

    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, makeMockRes());

    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it('pins the co-pilot system prompt text (D-30-9 bullet in place, other bullets byte-identical)', async () => {
    mockStream.mockReturnValueOnce(makeMockStream(['Hi'], 'Hi'));
    await streamCopilotResponse([{ role: 'user', content: 'x' }], {}, makeMockRes());

    const text = mockStream.mock.calls[0][0].system[0].text;
    expect(text).toContain([
      '## How to propose changes',
      '- The ONLY way to change the itinerary is to call the propose_itinerary_changes tool. Never write changes as prose, JSON, or code blocks.',
      '- Call the tool first. Once Trippy has acknowledged the call, explain the proposed changes to the traveller in prose: what changes and why, in your own words. If you are not proposing changes, do not call the tool.',
      '- Use real dayId and stopId values from the itinerary above.',
    ].join('\n'));
    // The itinerary context is `{}` here, so the whole prompt is deterministic.
    expect(createHash('sha256').update(text).digest('hex')).toBe('801426643725841661899e1f71b2dc10fef551b0340d560583dc5b90b0ecd365');
  });
});
