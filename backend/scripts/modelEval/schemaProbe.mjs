// Plan 34 W0 step 3 — structured-outputs compile probe.
//
//   cd backend; NODE_ENV=test node scripts/modelEval/schemaProbe.mjs [--only <probeId,...>] [--max-usd 1] [--concurrent]
//
// Sends each output schema (Plan 34 §4.1 extraction, §4.2 descriptor, and the W0 revisions) to the
// models that will carry it, on a trivial input: once without a format (input-token baseline), once
// with it ("cold": the first use of that schema in this run; the API compiles the grammar unless it
// cached one in the last 24 h), and once more ("warm"). Budget probes record the 16-union limit and
// the complexity bisection that found why §4.1 as written is rejected. Everything is recorded;
// nothing is repaired or retried.
//
// Direct SDK calls with hand-written schema constants (D-34-2): never extractBookings or
// generatePhotoDescriptor (their regex parsers would reject schema output, F-34-10), and never
// messages.parse() or the SDK's json-schema/zod helpers (they rewrite the schema, so the body sent
// would not be the schema written). SDK retries off. Each probe's requests are sequential; with
// --concurrent the probes run side by side (a rejected compile holds its request for 180 s).
//
// Probe ids: extraction-sonnet-5-5, extraction-sonnet-4-6 (EXTRACTION_SCHEMA_W0),
// extraction-plan-sonnet-5-5, extraction-plan-sonnet-4-6 (§4.1 as written), descriptor-haiku-5-5,
// descriptor-haiku-4-5, union-inline-17, union-inline-16, complexity-<variant> (COMPLEXITY_VARIANTS), and
// emit-category-haiku-5-5 (Plan 35 W0: EMIT_CATEGORY_INPUT_SCHEMA as a strict tool on the staged
// discovery prompt — noformat is the same request without the tool, cold/warm force the tool call),
// and the Plan 37 W0 probes: facts-haiku-5-5, facts-sonnet-5-5, facts-sonnet-4-6 (FACTS_OUTPUT_SCHEMA,
// lib/factsContract.mjs), facts-plan-haiku-5-5 (§4.1 as written, rejected for `maxItems`) and readiness-sonnet-5-5
// (READINESS_OUTPUT_SCHEMA, lib/readinessPrototype.mjs). Those workloads have no row in MODEL_PROFILES
// (and must not), so each of these probes carries its own `profile` from profiles.mjs.
//
// D-30-7: no database is imported or opened. The only external call is the Anthropic Messages API,
// and the only file written is data/model-eval/runs/schema-probe/<timestamp>.jsonl.

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config.js';
import { MODEL_PROFILES, SCENE_TYPES, requestSettings } from '../../src/services/claude.js';
import { EMIT_CATEGORY_INPUT_SCHEMA, EMIT_CATEGORY_TOOL, checkCategoryInput, stagedDiscoverySystemPrompt } from './lib/emitCategoryTool.mjs';
import { costUsd } from './lib/pricing.mjs';
import { RUNS_DIR } from './lib/runner.mjs';
import { PROFILES, toServiceProfile } from './profiles.mjs';
import {
  FACTS_OUTPUT_SCHEMA, FACTS_OUTPUT_SCHEMA_AS_PLANNED, FACTS_SYSTEM, buildFactsContextText, classifyFactsResponse,
} from './lib/factsContract.mjs';
import { READINESS_OUTPUT_SCHEMA, READINESS_SYSTEM, classifyReadinessResponse } from './lib/readinessPrototype.mjs';
import { EXTRACTION_OUTPUT_SCHEMA as LIVE_EXTRACTION_SCHEMA } from '../../src/services/claude.js';

const SONNET_55 = 'claude-sonnet-5-5';
const SONNET_46 = 'claude-sonnet-4-6';
const HAIKU_55 = 'claude-haiku-5-5';
const HAIKU_45 = 'claude-haiku-4-5-20251001';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Plan 34 §4.1, verbatim, with ONE revision: carrierCode.pattern mirrors CARRIER_CODE in
// src/services/lookups.js (F-34-12 was fixed in 94ee798). The plan's `^([A-Z0-9]{2}|[A-Z]{3})$`
// would accept an all-digit "54" that Trippy's own lookup rejects, so the schema must not be
// looser than the validator that consumes it. EXTRACTION_SCHEMA_PLAN_PATTERN carries the plan's
// original pattern and is sent only if the revised one is rejected.
const CARRIER_CODE_PATTERN = '^([A-Z]{3}|[A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])$';
const CARRIER_CODE_PLAN_PATTERN = '^([A-Z0-9]{2}|[A-Z]{3})$';

function buildExtractionSchema(carrierCodePattern) {
  return deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'language', 'result'],
    properties: {
      summary: {
        type: 'string',
        description: 'One line for the traveller: what was found, or why nothing could be imported.',
      },
      language: {
        type: 'string',
        pattern: '^[a-z]{2}$',
        description: "ISO 639-1 code of the input's primary language, e.g. en, zh.",
      },
      result: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'bookings'],
            properties: {
              kind: { const: 'bookings' },
              bookings: { type: 'array', minItems: 1, items: { $ref: '#/$defs/booking' } },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: { kind: { const: 'travel_no_booking' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: { kind: { const: 'not_travel' } },
          },
        ],
      },
    },
    $defs: {
      nullableText: { type: ['string', 'null'] },
      localDatetime: {
        anyOf: [
          { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' },
          { type: 'null' },
        ],
      },
      ianaZone: {
        anyOf: [
          { type: 'string', pattern: '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$' },
          { type: 'null' },
        ],
      },
      booking: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type', 'title', 'confirmationRef', 'bookingSource', 'startDatetime', 'endDatetime',
          'origin', 'destination', 'terminalOrStation', 'originTz', 'destinationTz',
          'details', 'confidence', 'fieldConfidence', 'assumptions',
        ],
        properties: {
          type: { enum: ['flight', 'train', 'bus', 'ferry', 'hotel', 'other'] },
          title: { type: 'string', description: 'Short human title, e.g. the flight or train number, or the hotel name.' },
          confirmationRef: { $ref: '#/$defs/nullableText' },
          bookingSource: { $ref: '#/$defs/nullableText' },
          startDatetime: { $ref: '#/$defs/localDatetime' },
          endDatetime: { $ref: '#/$defs/localDatetime' },
          origin: { $ref: '#/$defs/nullableText' },
          destination: { $ref: '#/$defs/nullableText' },
          terminalOrStation: { $ref: '#/$defs/nullableText' },
          originTz: { $ref: '#/$defs/ianaZone' },
          destinationTz: { $ref: '#/$defs/ianaZone' },
          details: {
            type: 'object',
            additionalProperties: false,
            properties: {
              originCity: { type: 'string', description: 'Canonical English city name.' },
              destinationCity: { type: 'string', description: 'Canonical English city name.' },
              originCountryCode: { type: 'string', pattern: '^[A-Z]{2}$' },
              destinationCountryCode: { type: 'string', pattern: '^[A-Z]{2}$' },
              city: { type: 'string', description: 'Canonical English city name (hotel and other bookings).' },
              countryCode: { type: 'string', pattern: '^[A-Z]{2}$' },
              carrierCode: {
                type: 'string',
                pattern: carrierCodePattern,
                description: 'Airline code only: the 2-character IATA code (KE, U2) or the 3-letter ICAO code.',
              },
              flightNumber: {
                type: 'string',
                pattern: '^[0-9]{1,4}[A-Z]?$',
                description: 'The flight number only, as printed, without the airline code: for KE012 write 012.',
              },
              airlineName: { type: 'string' },
              trainNumber: { type: 'string' },
              originStation: { type: 'string' },
              destinationStation: { type: 'string' },
              seatClass: { type: 'string' },
              address: { type: 'string' },
              localName: { type: 'string', description: 'The name in its original local script.' },
              note: { type: 'string' },
            },
          },
          confidence: {
            type: 'object',
            additionalProperties: false,
            required: ['overall'],
            properties: { overall: { enum: ['high', 'medium', 'low'] } },
          },
          fieldConfidence: {
            type: 'array',
            description: 'One entry for each field you are not fully sure of; omit fields you read with certainty.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field', 'level'],
              properties: {
                field: {
                  enum: [
                    'type', 'title', 'confirmationRef', 'bookingSource', 'startDatetime', 'endDatetime',
                    'origin', 'destination', 'terminalOrStation', 'originTz', 'destinationTz',
                    'originCity', 'destinationCity', 'originCountryCode', 'destinationCountryCode',
                    'city', 'countryCode', 'carrierCode', 'flightNumber', 'airlineName', 'trainNumber',
                    'originStation', 'destinationStation', 'seatClass', 'address', 'localName',
                  ],
                },
                level: { enum: ['high', 'medium', 'low'] },
              },
            },
          },
          assumptions: {
            type: 'array',
            items: { type: 'string' },
            description: "Short statements of any inference you made, e.g. 'Year inferred from the trip dates.'",
          },
        },
      },
    },
  });
}

const EXTRACTION_SCHEMA = buildExtractionSchema(CARRIER_CODE_PATTERN);
const EXTRACTION_SCHEMA_PLAN_PATTERN = buildExtractionSchema(CARRIER_CODE_PLAN_PATTERN);

// Plan 34 §4.2. The enum comes from SCENE_TYPES, never typed twice (Plan 10 D8). If the `{0,7}`
// repetition is rejected, the same "at most 8 words" rule is tried without a range quantifier (seven
// optional groups), and only then the plan's no-pattern fallback.
const PHOTO_QUERY_PATTERN = '^[^ ]+( [^ ]+){0,7}$';
const PHOTO_QUERY_PATTERN_UNROLLED = `^[^ ]+${'( [^ ]+)?'.repeat(7)}$`;

function buildDescriptorSchema(pattern) {
  return deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: ['photoQuery', 'sceneType'],
    properties: {
      photoQuery: {
        type: 'string',
        ...(pattern ? { pattern } : {}),
        description: 'A culturally specific English stock-photo search, at most 8 words, naming the actual place, cuisine or activity.',
      },
      sceneType: { enum: [...SCENE_TYPES] },
    },
  });
}

const DESCRIPTOR_SCHEMA = buildDescriptorSchema(PHOTO_QUERY_PATTERN);
const DESCRIPTOR_SCHEMA_UNROLLED = buildDescriptorSchema(PHOTO_QUERY_PATTERN_UNROLLED);
const DESCRIPTOR_SCHEMA_NO_PATTERN = buildDescriptorSchema(null);
const DESCRIPTOR_FALLBACKS = [
  { name: 'DESCRIPTOR_SCHEMA_UNROLLED', schema: DESCRIPTOR_SCHEMA_UNROLLED },
  { name: 'DESCRIPTOR_SCHEMA_NO_PATTERN', schema: DESCRIPTOR_SCHEMA_NO_PATTERN },
];

// Budget probes (§4.1 "Budget"). Whether the 16-union limit counts a `$ref` once per definition or
// once per use is the complexity variant `ref-per-use-on-8` below (it needs a base that compiles).
// Control: n required inline nullable strings are n union positions, no `$ref` involved.
function buildInlineUnion(n) {
  const names = Array.from({ length: n }, (_, i) => `field${i + 1}`);
  return deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: names,
    properties: Object.fromEntries(names.map((name) => [name, { type: ['string', 'null'] }])),
  });
}

// Complexity bisection (W0 finding): EXTRACTION_SCHEMA spends the full 180 s compile allowance and
// is rejected with "Schema is too complex." on both Sonnet models. Each variant removes one
// ingredient, so the accepted ones name what the grammar cannot afford.
function stripPatterns(node) {
  if (Array.isArray(node)) return node.forEach(stripPatterns);
  if (!node || typeof node !== 'object') return undefined;
  delete node.pattern;
  return Object.values(node).forEach(stripPatterns);
}

function extractionVariant(mutate) {
  const schema = structuredClone(EXTRACTION_SCHEMA);
  mutate(schema, schema.$defs.booking);
  return deepFreeze(schema);
}

const DETAIL_CORE_FIELDS = [
  'originCity', 'destinationCity', 'originCountryCode', 'destinationCountryCode',
  'city', 'countryCode', 'carrierCode', 'flightNumber',
];
const DETAIL_PLACE_FIELDS = [
  'originCity', 'destinationCity', 'originCountryCode', 'destinationCountryCode',
  'city', 'countryCode', 'address', 'localName',
];

const COMPLEXITY_VARIANTS = [
  ['no-patterns', 'every `pattern` removed', (schema) => stripPatterns(schema)],
  ['no-detail-patterns', 'patterns removed inside details only', (_, booking) => stripPatterns(booking.properties.details)],
  ['details-empty', 'details has no properties', (_, booking) => { booking.properties.details.properties = {}; }],
  ['details-8-optional', 'details keeps its 8 core optional fields, with patterns', (_, booking) => {
    const props = booking.properties.details.properties;
    for (const key of Object.keys(props)) if (!DETAIL_CORE_FIELDS.includes(key)) delete props[key];
  }],
  ['no-field-confidence', 'fieldConfidence array removed', (_, booking) => {
    delete booking.properties.fieldConfidence;
    booking.required = booking.required.filter((k) => k !== 'fieldConfidence');
  }],
  ['flat-result', 'result is { kind enum, bookings array } instead of a three-way anyOf', (schema) => {
    schema.properties.result = {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'bookings'],
      properties: {
        kind: { enum: ['bookings', 'travel_no_booking', 'not_travel'] },
        bookings: { type: 'array', items: { $ref: '#/$defs/booking' } },
      },
    };
  }],
  // Round 2: the first round accepted only details-empty and details-8-optional, so the cost is the
  // optional properties of one object. Find the threshold, and test two shapes that keep all 16.
  ...[10, 12, 14].map((n) => [`details-${n}-optional`, `details keeps its first ${n} optional fields`, (_, booking) => {
    const props = booking.properties.details.properties;
    Object.keys(props).slice(n).forEach((key) => delete props[key]);
  }]),
  ['details-split-2x8', 'details is two required groups (places, service) of 8 optional fields each', (_, booking) => {
    const props = booking.properties.details.properties;
    const group = (keys) => ({
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(keys.map((k) => [k, props[k]])),
    });
    booking.properties.details = {
      type: 'object',
      additionalProperties: false,
      required: ['places', 'service'],
      properties: {
        places: group(DETAIL_PLACE_FIELDS),
        service: group(Object.keys(props).filter((k) => !DETAIL_PLACE_FIELDS.includes(k))),
      },
    };
  }],
  ['details-required-empty', 'all 16 details fields required strings, "" for absent (patterns allow "")', (_, booking) => {
    const details = booking.properties.details;
    for (const prop of Object.values(details.properties)) {
      if (prop.pattern) prop.pattern = `^(${prop.pattern.slice(1, -1)})?$`;
    }
    details.required = Object.keys(details.properties);
    details.description = 'Every key is required: write "" for anything the input does not give. Never guess a value to fill a key.';
  }],
  ['ref-per-use-on-8', 'details-8-optional plus 7 extra required nullableText refs (17 if counted per use)', (_, booking) => {
    const props = booking.properties.details.properties;
    for (const key of Object.keys(props)) if (!DETAIL_CORE_FIELDS.includes(key)) delete props[key];
    for (let i = 1; i <= 7; i += 1) {
      booking.properties[`extra${i}`] = { $ref: '#/$defs/nullableText' };
      booking.required.push(`extra${i}`);
    }
  }],
].map(([id, what, mutate]) => ({ id, what, schema: extractionVariant(mutate) }));

// Measured 2026-10-19 on Sonnet 5.5 (first call, compile included): details with 8 optional fields
// 6.3 s, 10 → 18.0 s, 12 → 72.0 s, 14 → rejected at 180 s; the compile cost doubles with each optional
// property of one object. All 16 required with "" for absent compiled in 7.1 s; two groups of 8 in
// 13.7 s. EXTRACTION_SCHEMA_W0 is the required-"" shape (the importer already drops '', F-34-5).
const variantSchema = (id) => COMPLEXITY_VARIANTS.find((v) => v.id === id).schema;
const EXTRACTION_SCHEMA_W0 = variantSchema('details-required-empty');
const EXTRACTION_SCHEMA_SPLIT = variantSchema('details-split-2x8');

const EXTRACTION_SYSTEM = 'You extract travel bookings from the input into the response schema.';
const EXTRACTION_USER = 'Korean Air KE 012, Seoul Incheon (ICN) 2027-06-14 10:00 to Tokyo Narita (NRT) 12:25, booking reference 6XKQ2M.';
const DESCRIPTOR_SYSTEM = 'Write an English stock-photo search query and a scene type for the place.';
const DESCRIPTOR_USER = 'Kiyomizu-dera, Kyoto, Japan, stop type: experience';
const BUDGET_SYSTEM = 'Fill the response schema.';
const BUDGET_USER = 'Reply with nulls.';

// Plan 37 W0. The facts user turn is the real shape (§4.2): a booking-context text block, then a
// short pasted-text document carrying one deadline, one window and one requirement.
const FACTS_USER = [
  {
    type: 'text',
    text: buildFactsContextText({
      bookings: [{
        type: 'hotel', title: 'Hotel Gion Nanba', startDatetime: '2026-11-15T15:00', endDatetime: '2026-11-17T11:00',
        originTz: null, destinationTz: 'Asia/Tokyo',
      }],
      trip: { startDate: '2026-11-14', endDate: '2026-11-18' },
    }),
  },
  { type: 'text', text: 'Free cancellation until 14 November 2026, 18:00. Check-in from 15:00. Passport required at check-in.' },
];

// A tiny stand-in for the readiness input (lib/readinessPrototype.mjs buildReadinessInput): the flight
// lands after the hotel's reception closes, so a correct answer is one conflict citing B1, B2 and F1.
const READINESS_USER = [{
  type: 'text',
  text: [
    'Trip (as the co-pilot sees it):',
    '{"trip":{"title":"Kyoto weekend","startDate":"2026-11-14","endDate":"2026-11-16"}}',
    '',
    'Bookings:',
    '[',
    '  {"ref":"B1","type":"flight","title":"KE 723","start":"2026-11-14T20:40","end":"2026-11-14T22:50","destinationTz":"Asia/Tokyo"},',
    '  {"ref":"B2","type":"hotel","title":"Hotel Gion Nanba","start":"2026-11-14T15:00","end":"2026-11-16T11:00"}',
    ']',
    '',
    'Days:',
    '[{"ref":"D1","date":"2026-11-14","city":"Kyoto"},{"ref":"D2","date":"2026-11-15","city":"Kyoto"}]',
    '',
    'Document facts:',
    '[{"ref":"F1","bookings":["B2"],"kind":"window","label":"Reception hours","value":"Reception closes at 22:00","quote":"Reception is open until 22:00.","document":"Hotel confirmation","quoteVerified":true}]',
    '',
    'Health findings:',
    '[]',
  ].join('\n'),
}];
const READINESS_PROBE_EVIDENCE = Object.fromEntries(['B1', 'B2', 'D1', 'D2', 'F1'].map((id) => [id, {}]));

// The readiness probe sends the real request fields but lowers max_tokens to 16,000 for the probe
// only: it is a non-streaming create (the readiness run itself streams at 64,000), and the schema
// compile is what is measured.
const readinessProbeProfile = { ...toServiceProfile(PROFILES.readiness['readiness-sonnet-55-high']), maxTokens: 16000 };

// `matrix` and `tool` probes run noformat -> cold -> warm; `budget` probes run cold only (the outcome
// is accepted-or-rejected, which the first request already settles). A `tool` probe sends its schema
// as a strict tool with a forced tool choice instead of as output_config.format.
const PROBES = [
  // The plan's §4.1 schema, as written: rejected on both Sonnet models after the full 180 s compile
  // ("Schema is too complex."), with either carrierCode pattern. Kept so the rejection can be re-run.
  {
    probeId: 'extraction-plan-sonnet-5-5', kind: 'matrix', workload: 'extraction', model: SONNET_55,
    schemaName: 'EXTRACTION_SCHEMA', schema: EXTRACTION_SCHEMA,
    fallbacks: [{ name: 'EXTRACTION_SCHEMA_PLAN_PATTERN', schema: EXTRACTION_SCHEMA_PLAN_PATTERN }],
    system: EXTRACTION_SYSTEM, user: EXTRACTION_USER,
  },
  {
    probeId: 'extraction-plan-sonnet-4-6', kind: 'matrix', workload: 'extraction', model: SONNET_46,
    schemaName: 'EXTRACTION_SCHEMA', schema: EXTRACTION_SCHEMA,
    fallbacks: [{ name: 'EXTRACTION_SCHEMA_PLAN_PATTERN', schema: EXTRACTION_SCHEMA_PLAN_PATTERN }],
    system: EXTRACTION_SYSTEM, user: EXTRACTION_USER,
  },
  // The W0 revision: every details field required, "" for absent (see COMPLEXITY_VARIANTS).
  ...[SONNET_55, SONNET_46].map((model) => ({
    probeId: `extraction-sonnet-${model === SONNET_55 ? '5-5' : '4-6'}`, kind: 'matrix', workload: 'extraction', model,
    schemaName: 'EXTRACTION_SCHEMA_W0', schema: EXTRACTION_SCHEMA_W0,
    fallbacks: [{ name: 'EXTRACTION_SCHEMA_SPLIT', schema: EXTRACTION_SCHEMA_SPLIT }],
    system: EXTRACTION_SYSTEM, user: EXTRACTION_USER,
  })),
  {
    probeId: 'descriptor-haiku-5-5', kind: 'matrix', workload: 'descriptor', model: HAIKU_55,
    schemaName: 'DESCRIPTOR_SCHEMA', schema: DESCRIPTOR_SCHEMA,
    fallbacks: DESCRIPTOR_FALLBACKS,
    system: DESCRIPTOR_SYSTEM, user: DESCRIPTOR_USER,
  },
  {
    probeId: 'descriptor-haiku-4-5', kind: 'matrix', workload: 'descriptor', model: HAIKU_45,
    schemaName: 'DESCRIPTOR_SCHEMA', schema: DESCRIPTOR_SCHEMA,
    fallbacks: DESCRIPTOR_FALLBACKS,
    system: DESCRIPTOR_SYSTEM, user: DESCRIPTOR_USER,
  },
  // Plan 35 W0: the staged-emission tool. Compile cost is what is measured here; stagedEmissionProbe.mjs
  // measures the behaviour.
  {
    probeId: 'emit-category-haiku-5-5', kind: 'tool', workload: 'discovery', model: HAIKU_55,
    schemaName: 'EMIT_CATEGORY_INPUT_SCHEMA', schema: EMIT_CATEGORY_INPUT_SCHEMA,
    fallbacks: [],
    system: stagedDiscoverySystemPrompt(HAIKU_55),
    user: 'Curate the best of Ipoh, Malaysia (MY). Include neighbourhood gems alongside the genuinely unmissable. Be specific, be honest about crowds and tourist traps.',
  },
  // Plan 37 W0 (§5): FACTS_OUTPUT_SCHEMA and READINESS_OUTPUT_SCHEMA on the models that will carry them.
  // §4.1 as written (with `maxItems: 40`) was rejected on all three facts models on 2026-10-20 ("For
  // 'array' type, property 'maxItems' is not supported"); facts-plan-haiku-5-5 keeps that rejection
  // re-runnable at the cheapest model, and the facts probes send the schema the API accepts.
  {
    probeId: 'facts-plan-haiku-5-5', kind: 'matrix', workload: 'facts', model: HAIKU_55,
    profile: toServiceProfile(PROFILES.facts['facts-haiku-55-medium']),
    schemaName: 'FACTS_OUTPUT_SCHEMA_AS_PLANNED', schema: FACTS_OUTPUT_SCHEMA_AS_PLANNED,
    fallbacks: [{ name: 'FACTS_OUTPUT_SCHEMA', schema: FACTS_OUTPUT_SCHEMA }],
    system: FACTS_SYSTEM, user: FACTS_USER,
  },
  ...[
    ['facts-haiku-5-5', HAIKU_55, 'facts-haiku-55-medium'],
    ['facts-sonnet-5-5', SONNET_55, 'facts-sonnet-55-medium'],
    ['facts-sonnet-4-6', SONNET_46, 'facts-sonnet-46-medium'],
  ].map(([probeId, model, profileName]) => ({
    probeId, kind: 'matrix', workload: 'facts', model,
    profile: toServiceProfile(PROFILES.facts[profileName]),
    schemaName: 'FACTS_OUTPUT_SCHEMA', schema: FACTS_OUTPUT_SCHEMA,
    fallbacks: [],
    system: FACTS_SYSTEM, user: FACTS_USER,
  })),
  {
    probeId: 'readiness-sonnet-5-5', kind: 'matrix', workload: 'readiness', model: SONNET_55,
    profile: readinessProbeProfile,
    schemaName: 'READINESS_OUTPUT_SCHEMA', schema: READINESS_OUTPUT_SCHEMA,
    fallbacks: [],
    system: READINESS_SYSTEM, user: READINESS_USER,
  },
  {
    probeId: 'union-inline-17', kind: 'budget', workload: 'extraction', model: SONNET_55,
    schemaName: 'INLINE_UNION_17', schema: buildInlineUnion(17),
    system: BUDGET_SYSTEM, user: BUDGET_USER,
  },
  {
    probeId: 'union-inline-16', kind: 'budget', workload: 'extraction', model: SONNET_55,
    schemaName: 'INLINE_UNION_16', schema: buildInlineUnion(16),
    system: BUDGET_SYSTEM, user: BUDGET_USER,
  },
  ...COMPLEXITY_VARIANTS.map((v) => ({
    probeId: `complexity-${v.id}`, kind: 'budget', workload: 'extraction', model: SONNET_55,
    schemaName: `EXTRACTION_SCHEMA:${v.id} (${v.what})`, schema: v.schema,
    system: EXTRACTION_SYSTEM, user: EXTRACTION_USER,
  })),
];

// Plan 38 W0 (D-38-1): the LIVE extraction schema (claude.js, not the plan-shaped EXTRACTION_SCHEMA
// above, which the API rejects) plus one required per-booking `sourceFiles` array of 1-based file
// numbers. No maxItems (Plan 37 W0: the compile drops it) and no optional property (D-34-5).
// extractionVariant takes the live schema over wholesale, then adds the property.
function sourceFilesVariant(items) {
  return extractionVariant((schema) => {
    for (const key of Object.keys(schema)) delete schema[key];
    Object.assign(schema, structuredClone(LIVE_EXTRACTION_SCHEMA));
    const booking = schema.$defs.booking;
    booking.properties.sourceFiles = {
      type: 'array',
      description: 'The 1-based numbers of the files this booking was read from: every file that shows a fact of it.',
      items,
      minItems: 1,
    };
    booking.required = [...booking.required, 'sourceFiles'];
  });
}
const SOURCE_FILES_ENUM_SCHEMA = sourceFilesVariant({ enum: [1, 2, 3, 4] });
const SOURCE_FILES_PATTERN_SCHEMA = sourceFilesVariant({ type: 'string', pattern: '^[1-4]$' });

PROBES.push(
  ...[['extraction-sourcefiles-sonnet-5-5', SONNET_55], ['extraction-sourcefiles-sonnet-4-6', SONNET_46]].map(([probeId, model]) => ({
    probeId, kind: 'matrix', workload: 'extraction', model,
    schemaName: 'EXTRACTION_SCHEMA_LIVE+sourceFiles(enum 1-4)', schema: SOURCE_FILES_ENUM_SCHEMA,
    fallbacks: [],
    system: EXTRACTION_SYSTEM, user: EXTRACTION_USER,
  })),
  {
    probeId: 'extraction-sourcefiles-pattern-sonnet-5-5', kind: 'matrix', workload: 'extraction', model: SONNET_55,
    schemaName: 'EXTRACTION_SCHEMA_LIVE+sourceFiles(string pattern ^[1-4]$)', schema: SOURCE_FILES_PATTERN_SCHEMA,
    fallbacks: [],
    system: EXTRACTION_SYSTEM, user: EXTRACTION_USER,
  },
);

// --only <probeId,...>, --max-usd <n> (default 1), --concurrent
function parseProbeArgs(argv = process.argv.slice(2)) {
  const args = { only: null, maxUsd: 1, concurrent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--only') args.only = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--max-usd') args.maxUsd = Number(next());
    else if (a === '--concurrent') args.concurrent = true;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

function openProbeFile() {
  const dir = join(RUNS_DIR, 'schema-probe');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  return {
    path,
    write(record) {
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    },
  };
}

// The real profile's request fields, with the format merged into output_config beside any effort
// (Plan 34 D-34-6: Haiku 4.5 and Sonnet 4.6 send output_config: { format } with no effort).
// A probe may carry its own `profile` (Plan 37: facts and readiness have no MODEL_PROFILES row); every
// other probe reads the live row, exactly as before. `user` is a string or a content-block array.
function buildBody({ kind, model, workload, schema, system, user, profile: ownProfile }) {
  const profile = ownProfile ?? MODEL_PROFILES[model]?.[workload];
  if (!profile) throw new Error(`no ${workload} profile for ${model} in MODEL_PROFILES`);
  const settings = requestSettings(ownProfile ?? { model, ...profile });
  if (kind === 'tool') {
    // The real discovery profile (thinking disabled, which a forced tool choice requires), with
    // max_tokens cut to 8,000: the probe forces one category, so a single call cannot run long, and the
    // profile's 48,000 would only raise the ceiling on a mistake. No output format; the tool is the schema.
    return {
      ...settings,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
      ...(schema ? { tools: [EMIT_CATEGORY_TOOL], tool_choice: { type: 'tool', name: 'emit_category' } } : {}),
    };
  }
  const outputConfig = schema
    ? { ...(settings.output_config ?? {}), format: { type: 'json_schema', schema } }
    : settings.output_config;
  return {
    ...settings,
    ...(outputConfig ? { output_config: outputConfig } : {}),
    system,
    messages: [{ role: 'user', content: user }],
  };
}

function shapeCheckFor(workload, parsed, kind, response) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (workload === 'facts') {
    // The harness classifier on the response itself: the schema and the empty-quote rule.
    const verdict = classifyFactsResponse(response);
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    return {
      factCount: facts.length,
      kinds: facts.map((f) => f?.kind ?? null),
      atValues: facts.map((f) => f?.at ?? null),
      pages: facts.map((f) => f?.page ?? null),
      validation: { outcome: verdict.outcome, error: verdict.error },
    };
  }
  if (workload === 'readiness') {
    const verdict = classifyReadinessResponse(response, READINESS_PROBE_EVIDENCE);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      itemCount: items.length,
      kinds: items.map((i) => i?.kind ?? null),
      validation: { outcome: verdict.outcome, error: verdict.error, unknownEvidence: verdict.unknownEvidence },
    };
  }
  if (kind === 'tool') {
    return {
      category: parsed.category ?? null,
      itemCount: Array.isArray(parsed.items) ? parsed.items.length : null,
      check: checkCategoryInput(parsed),
    };
  }
  if (workload === 'descriptor') {
    const query = typeof parsed.photoQuery === 'string' ? parsed.photoQuery : null;
    return {
      photoQueryWords: query ? query.trim().split(/\s+/).filter(Boolean).length : null,
      sceneTypeInVocabulary: SCENE_TYPES.includes(parsed.sceneType),
    };
  }
  const bookings = parsed.result?.kind === 'bookings' && Array.isArray(parsed.result.bookings) ? parsed.result.bookings : [];
  return {
    kind: parsed.result?.kind ?? null,
    bookingCount: bookings.length,
    flights: bookings.map((b) => ({
      carrierCode: b?.details?.carrierCode ?? b?.details?.service?.carrierCode ?? null,
      flightNumber: b?.details?.flightNumber ?? b?.details?.service?.flightNumber ?? null,
    })),
    detailKeys: bookings.map((b) => Object.keys(b?.details ?? {}).length),
  };
}

async function sendOne(client, probe, { attempt, schemaName, schema }) {
  const body = buildBody({ ...probe, schema });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = {
    probeId: probe.probeId,
    workload: probe.workload,
    model: probe.model,
    schemaName: schema ? schemaName : null,
    attempt,
    startedAt,
  };

  let response = null;
  let error = null;
  try {
    response = await client.messages.create(body);
  } catch (err) {
    error = err;
  }
  const wallMs = Date.now() - t0;

  if (error) {
    return {
      ...base,
      wallMs,
      ok: false,
      httpStatus: error.status ?? null,
      errorType: error.error?.error?.type ?? error.name ?? null,
      errorMessage: error.error?.error?.message ?? error.message ?? null,
      stopReason: null,
      stopDetails: null,
      usage: null,
      costUsd: 0,
      textOutput: null,
      parsed: null,
      parseError: null,
      blockTypes: [],
      shapeCheck: null,
      request: body,
    };
  }

  const blocks = response.content ?? [];
  const textBlocks = blocks.filter((b) => b.type === 'text');
  const textOutput = textBlocks.map((b) => b.text).join('');
  let parsed = null;
  let parseError = null;
  if (schema) {
    if (probe.kind === 'tool') {
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      if (toolUses.length !== 1) parseError = `expected exactly one tool_use block, got ${toolUses.length}`;
      else parsed = toolUses[0].input;
    } else if (textBlocks.length !== 1) {
      parseError = `expected exactly one text block, got ${textBlocks.length}`;
    } else {
      try {
        parsed = JSON.parse(textBlocks[0].text);
      } catch (err) {
        parseError = err.message;
      }
    }
  }

  return {
    ...base,
    wallMs,
    ok: true,
    httpStatus: 200,
    errorType: null,
    errorMessage: null,
    stopReason: response.stop_reason ?? null,
    stopDetails: response.stop_details ?? null,
    usage: response.usage ?? null,
    costUsd: Number(costUsd(probe.model, response.usage).toFixed(6)),
    textOutput,
    parsed,
    parseError,
    blockTypes: blocks.map((b) => b.type),
    shapeCheck: schema && parsed ? shapeCheckFor(probe.workload, parsed, probe.kind, response) : null,
    request: body,
  };
}

function is4xx(record) {
  return !record.ok && record.httpStatus >= 400 && record.httpStatus < 500;
}

function describe(record) {
  if (!record) return '-';
  if (!record.ok) return `REJECTED ${record.httpStatus} ${record.errorType}`;
  return `ok ${record.wallMs}ms`;
}

function printSummary(records) {
  console.log('\n=== schema probe summary ===');
  const byProbe = new Map();
  for (const r of records) {
    if (!byProbe.has(r.probeId)) byProbe.set(r.probeId, []);
    byProbe.get(r.probeId).push(r);
  }

  for (const [probeId, rs] of byProbe) {
    const model = rs[0].model;
    console.log(`\n${probeId} (${model})`);
    const noformat = rs.find((r) => r.attempt === 'noformat');
    const schemaNames = [...new Set(rs.filter((r) => r.schemaName).map((r) => r.schemaName))];
    for (const name of schemaNames) {
      const cold = rs.find((r) => r.schemaName === name && r.attempt === 'cold');
      const warm = rs.find((r) => r.schemaName === name && r.attempt === 'warm');
      const accepted = cold?.ok ? 'ACCEPTED' : 'REJECTED';
      console.log(`  schema ${name}: ${accepted}`);
      console.log(`    cold: ${describe(cold)}   warm: ${describe(warm)}`);
      if (cold?.ok && noformat?.ok) {
        const before = noformat.usage?.input_tokens ?? 0;
        const after = cold.usage?.input_tokens ?? 0;
        console.log(`    input tokens: ${before} (no format) -> ${after} (format), overhead ${after - before >= 0 ? '+' : ''}${after - before}`);
      }
      for (const r of [cold, warm].filter(Boolean)) {
        if (r.ok) {
          console.log(
            `    ${r.attempt}: stop=${r.stopReason} blocks=[${r.blockTypes.join(',')}] out=${r.usage?.output_tokens} ` +
            `parse=${r.parseError ? `FAILED (${r.parseError})` : 'ok'} $${r.costUsd.toFixed(5)}`,
          );
          if (r.shapeCheck) console.log(`      shape: ${JSON.stringify(r.shapeCheck)}`);
        } else {
          console.log(`    ${r.attempt} error: ${r.httpStatus} ${r.errorType}: ${r.errorMessage}`);
        }
      }
    }
    if (noformat && !noformat.ok) {
      console.log(`    noformat error: ${noformat.httpStatus} ${noformat.errorType}: ${noformat.errorMessage}`);
    }
  }
}

async function main() {
  const args = parseProbeArgs();
  const probes = args.only ? PROBES.filter((p) => args.only.has(p.probeId)) : PROBES;
  if (args.only) {
    const unknown = [...args.only].filter((id) => !PROBES.some((p) => p.probeId === id));
    if (unknown.length) throw new Error(`unknown probe id(s): ${unknown.join(', ')} (known: ${PROBES.map((p) => p.probeId).join(', ')})`);
  }
  if (!probes.length) throw new Error('no probes selected');
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  // maxRetries 0: a rejected schema must be recorded as the API said it, not retried.
  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
  const file = openProbeFile();
  console.log(`schemaProbe: ${probes.map((p) => p.probeId).join(', ')} (--max-usd ${args.maxUsd})`);
  console.log('D-30-7: this script imports no database; only the Anthropic API is called.');

  const records = [];
  let spent = 0;
  let largestRequest = 0;
  let stopped = null;

  async function send(probe, spec) {
    // Spend guard: do not start a request that, at the most expensive one seen so far, could pass the cap.
    if (spent + largestRequest > args.maxUsd) {
      stopped = `spent $${spent.toFixed(4)} and the largest request cost $${largestRequest.toFixed(4)}, over --max-usd ${args.maxUsd}`;
      return null;
    }
    const record = await sendOne(client, probe, spec);
    file.write(record);
    records.push(record);
    spent += record.costUsd;
    largestRequest = Math.max(largestRequest, record.costUsd);
    console.log(`  ${probe.probeId} ${spec.attempt}${spec.schema ? `/${spec.schemaName}` : ''}: ${describe(record)} $${record.costUsd.toFixed(5)}`);
    return record;
  }

  // One probe's requests are always sequential (cold before warm). With --concurrent, the probes
  // themselves run side by side, so a set of 180 s compile timeouts costs 180 s, not 180 s each.
  async function runProbe(probe) {
    if (stopped) return;
    console.log(`\n${probe.probeId} (${probe.model})`);
    if (probe.kind !== 'budget') {
      if (!(await send(probe, { attempt: 'noformat', schemaName: null, schema: null }))) return;
    }
    const cold = await send(probe, { attempt: 'cold', schemaName: probe.schemaName, schema: probe.schema });
    if (!cold || probe.kind === 'budget') return;

    if (cold.ok) {
      await send(probe, { attempt: 'warm', schemaName: probe.schemaName, schema: probe.schema });
    } else if (is4xx(cold)) {
      // Rejected: skip warm and try the fallbacks in order (cold + warm) until one is accepted.
      for (const fallback of probe.fallbacks) {
        const fallbackCold = await send(probe, { attempt: 'cold', schemaName: fallback.name, schema: fallback.schema });
        if (!fallbackCold) break;
        if (fallbackCold.ok) {
          await send(probe, { attempt: 'warm', schemaName: fallback.name, schema: fallback.schema });
          break;
        }
        if (!is4xx(fallbackCold)) break;
      }
    }
  }

  if (args.concurrent) await Promise.all(probes.map(runProbe));
  else for (const probe of probes) await runProbe(probe);

  printSummary(records);
  console.log(`\nrun file: ${file.path}`);
  console.log(`requests ${records.length}, spent $${spent.toFixed(4)}`);
  if (stopped) {
    console.log(`STOPPED by the spend guard: ${stopped}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
