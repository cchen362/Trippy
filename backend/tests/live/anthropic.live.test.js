// Plan 30 W1 — opt-in live smoke test against the real Anthropic API.
//
// One tiny request per workload SHAPE (extraction text+image, descriptor, co-pilot tools+stream,
// discovery NDJSON stream), sent with the real SDK client and the settings production sends
// (requestSettings(profileFor(workload))). It answers one question the mocked suite cannot: does
// the currently configured model/SDK/profile combination still produce responses the parsers read
// correctly — known block types, text read only from `text` blocks, usage present, a normal stop.
//
// COST: pennies per run (about 8 small requests; the largest is a few hundred output tokens on
// Sonnet). NEVER part of `npm test`: the whole suite is skipped, and makes zero API calls, unless
// LIVE_ANTHROPIC=1.
//
// RUN (PowerShell, from backend/ — config.js loads backend/.env, which holds the real key):
//   $env:LIVE_ANTHROPIC='1'; npx vitest run tests/live
//   Remove-Item Env:LIVE_ANTHROPIC

import { describe, it, expect, beforeAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../src/config.js';
import {
  profileFor, requestSettings, classifyStop, extractBookings, generatePhotoDescriptor,
} from '../../src/services/claude.js';
import {
  PROPOSE_ITINERARY_CHANGES_TOOL, SEARCH_DISCOVERY_CATALOGUE_TOOL, CHECK_TRIP_HEALTH_TOOL,
} from '../../src/services/copilotTools.js';

const KNOWN_BLOCK_TYPES = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

// A valid 16x16 solid-colour PNG built at runtime, so there is no opaque base64 constant to trust.
function tinyPngBase64() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const size = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0xc8)]); // filter 0 + grey pixels
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// Text is read ONLY from `text` blocks — the rule every parser in claude.js follows.
function textOf(message) {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

// The assertions every workload shape must satisfy.
function expectUsableResponse(response, profile) {
  expect(response.model.startsWith(profile.model)).toBe(true);
  expect(response.content.length).toBeGreaterThan(0);
  for (const block of response.content) {
    expect(KNOWN_BLOCK_TYPES.has(block.type), `unknown block type "${block.type}"`).toBe(true);
    if (block.type === 'text') expect(typeof block.text).toBe('string');
    if (block.type === 'thinking') expect(typeof block.thinking).toBe('string');
  }
  expect(response.usage.input_tokens).toBeGreaterThan(0);
  expect(response.usage.output_tokens).toBeGreaterThan(0);
  expect(classifyStop(response).outcome).toBe('complete');
}

describe.skipIf(process.env.LIVE_ANTHROPIC !== '1')('live Anthropic smoke (Plan 30 W1, opt-in)', () => {
  let client;

  beforeAll(() => {
    expect(config.anthropicApiKey, 'ANTHROPIC_API_KEY must be set in backend/.env').toBeTruthy();
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  });

  it('extraction shape: text + image, non-streaming, extraction profile', async () => {
    const profile = profileFor('extraction');
    const response = await client.messages.create({
      ...requestSettings(profile),
      system: 'You describe inputs. Reply with one short sentence.',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Flight CA 421 PEK to CTU on 2027-04-03 08:30. What kind of document is this, and what is in the attached image?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPngBase64() } },
        ],
      }],
    });

    expectUsableResponse(response, profile);
    expect(textOf(response).length).toBeGreaterThan(0);
  }, 120_000);

  it('extraction through the real extractBookings: schema-constrained JSON mapped to the app shape', async () => {
    const { extraction, model, usage } = await extractBookings({
      files: [{ kind: 'text', content: 'Flight CA 421, Beijing PEK to Chengdu CTU, 3 April 2027 08:30-11:55. Booking ref ABC123.' }],
    });

    expect(model).toBe(profileFor('extraction').model);
    expect(Object.keys(extraction)).toEqual(['isTravelRelated', 'summary', 'language', 'bookings']);
    expect(extraction.isTravelRelated).toBe(true);
    expect(extraction.bookings).toHaveLength(1);
    const [booking] = extraction.bookings;
    expect(booking.type).toBe('flight');
    expect(booking.details.carrierCode).toBe('CA');
    expect(booking.details.flightNumber).toBe('421');
    expect(Object.values(booking.details)).not.toContain('');
    expect(typeof booking.confidence.fields).toBe('object');
    expect(booking).not.toHaveProperty('fieldConfidence');
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  }, 120_000);

  it('descriptor shape: non-streaming, descriptor profile', async () => {
    const profile = profileFor('descriptor');
    const response = await client.messages.create({
      ...requestSettings(profile),
      system: 'Reply with the single word: ok',
      messages: [{ role: 'user', content: 'Ready?' }],
    });

    expectUsableResponse(response, profile);
    expect(textOf(response).trim().length).toBeGreaterThan(0);
  }, 60_000);

  it('descriptor through the real generatePhotoDescriptor returns a usable descriptor', async () => {
    const result = await generatePhotoDescriptor({
      title: 'Wuhou Shrine', resolvedName: 'Wuhou Shrine Museum', city: 'Chengdu', country: 'China', type: 'sight',
    });

    expect(result).not.toBeNull();
    expect(typeof result.photoQuery).toBe('string');
    expect(result.photoQuery.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it('co-pilot shape: streamed, with the three co-pilot tools, copilot profile', async () => {
    const profile = profileFor('copilot');
    const stream = client.messages.stream({
      ...requestSettings(profile),
      system: [{ type: 'text', text: 'You are a travel co-pilot. Answer in one short sentence and do not call any tool.' }],
      messages: [{ role: 'user', content: 'Say hello to the traveller.' }],
      tools: [PROPOSE_ITINERARY_CHANGES_TOOL, SEARCH_DISCOVERY_CATALOGUE_TOOL, CHECK_TRIP_HEALTH_TOOL],
    });
    let streamed = '';
    stream.on('text', (delta) => { streamed += delta; });
    const response = await stream.finalMessage();

    expectUsableResponse(response, profile);
    // The streamed text deltas are exactly the text blocks — thinking never leaks into them.
    expect(streamed).toBe(textOf(response));
  }, 120_000);

  it('discovery shape: streamed NDJSON from text deltas, discovery profile', async () => {
    const profile = profileFor('discovery');
    const stream = client.messages.stream({
      ...requestSettings(profile),
      system: 'Return ONLY newline-delimited JSON, one object per line, no prose, no markdown fences. '
        + 'Each line: {"category":"<name>","items":[{"name":"<place>"}]}',
      messages: [{ role: 'user', content: 'Output exactly 2 lines, for the categories food and culture, with 2 items each, for Kyoto.' }],
    });
    let streamed = '';
    stream.on('text', (delta) => { streamed += delta; });
    const response = await stream.finalMessage();

    expectUsableResponse(response, profile);
    expect(streamed).toBe(textOf(response));
    const parsed = streamed.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(typeof entry.category).toBe('string');
      expect(Array.isArray(entry.items)).toBe(true);
    }
  }, 120_000);
});
