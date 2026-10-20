import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { PROPOSE_ITINERARY_CHANGES_TOOL, SEARCH_DISCOVERY_CATALOGUE_TOOL, CHECK_TRIP_HEALTH_TOOL } from './copilotTools.js';
import { normaliseForMatch } from './documentText.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

export const DISCOVERY_CATEGORIES = ['essentials', 'culture', 'food', 'nature', 'nightlife', 'hidden_gems', 'architecture', 'wellness'];

// Plan 2A D3: extraction uses Sonnet, not Haiku. Messy screenshots and
// date-ambiguity reasoning are exactly where Haiku degrades, and extraction
// errors are user-facing. Plan 30 W4 moved the version, not the tier: Sonnet 5.5 at effort
// 'medium'. Reverting this constant restores Sonnet 4.6's settings (no thinking, no effort).
export const EXTRACTION_MODEL = 'claude-sonnet-5-5';

export const PHOTO_DESCRIPTOR_MODEL = 'claude-haiku-5-5';

// Plan 30 W5: Sonnet 5.5 at effort 'low' under the D-30-9 explain-after-proposal protocol.
// Reverting this constant restores Sonnet 4.6's settings (8,192, no thinking, no effort).
export const COPILOT_MODEL = 'claude-sonnet-5-5';

// Plan 30 W3: Haiku 5.5 with thinking disabled, and the prompt's volume rules keyed by model
// (DISCOVERY_SELECTION_RULES). Reverting this constant restores Haiku 4.5's settings and prompt.
export const DISCOVERY_MODEL = 'claude-haiku-5-5';

// D-37-9 (Plan 37): Haiku 5.5 at effort 'medium' reads documents at import — it tied Sonnet 5.5 at 100 % on the costly kinds in W0 B2 at about a seventeenth of the cost per document.
// Sonnet 5.5 keeps a `facts` row as the measured alternative; no 4.x row exists because there is nothing to roll back to.
export const FACTS_MODEL = 'claude-haiku-5-5';

// D-30-1 (Plan 30): request settings are keyed by MODEL, never by workload alone — reverting a
// workload's *_MODEL constant automatically restores that model's compatible parameters.
// The settings are not interchangeable across models: Haiku 4.5 rejects output_config.effort
// outright (a 400), while Sonnet 4.6 runs thinking-off by default and must not be sent a
// `thinking` field it was never configured for (F-30-12). A rollback that reverted only the model
// string and kept a newer model's effort/thinking would fail every request, so the settings live
// under the model that accepts them and profileFor() looks them up by the configured model.
// A profile is { model, maxTokens, thinking?, effort? } — `thinking` is sent verbatim, `effort`
// becomes output_config.effort (a workload's output format joins it there, D-34-6). Plan 30 W0
// lets the evaluation harness (backend/scripts/modelEval) inject another profile through each
// service function's optional `profile` argument.
export const MODEL_PROFILES = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({
    // Plan 30 W4 / D-30-6: on 23 fixtures (text, phone screenshots, PDFs) the largest output was
    // 2,370 tokens thinking included, and only 2 of 23 responses at 'medium' thought at all. 16,000
    // is above the 2x rule on purpose: no multi-page itinerary was measured, and with a tight
    // allowance Sonnet 5.5 can spend all of it thinking and return no text (a 300-token run did).
    // A cut-off is a traveller-facing failure (D-30-3), the allowance is a ceiling, not a spend,
    // and this call is non-streaming, so it must stay at or under 21,333 (F-30-6).
    extraction: Object.freeze({ maxTokens: 16000, effort: 'medium' }),
    // Plan 30 W5 / D-30-6: on the 20 scenarios the largest single iteration was 1,764 output tokens
    // thinking included (an eight-search proposal step; 1,258 of them thinking) and the explain
    // step's largest was 542. 16,000 is well above the 2x rule on purpose: adaptive thinking at
    // 'low' varied from 820 to 1,258 tokens on the same scenario, and a tight allowance can be
    // spent entirely on thinking and return no text. The call is streamed, so F-30-6's 21,333 cap
    // does not apply, and the allowance is a ceiling, not a spend. No `thinking` field: adaptive
    // stays on.
    copilot: Object.freeze({ maxTokens: 16000, effort: 'low' }),
    // Plan 37 W1 / D-37-9: the alternative reader W0 measured (largest output 1,703 tokens thinking
    // included). It shares Haiku 5.5's ceiling because W0's corpus was six documents and an unspent
    // ceiling costs nothing; non-streaming, so it must stay at or under 21,333 (F-30-6).
    facts: Object.freeze({ maxTokens: 8700, effort: 'medium' }),
  }),
  'claude-sonnet-4-6': Object.freeze({
    // Rollback row for both extraction (since Plan 30 W4) and the co-pilot (since Plan 30 W5).
    extraction: Object.freeze({ maxTokens: 8192 }),
    copilot: Object.freeze({ maxTokens: 8192 }),
  }),
  'claude-haiku-5-5': Object.freeze({
    // Plan 30 W2 / D-30-6: at effort 'low' no response carried a thinking block on 50/50 fixtures
    // (output 43-62 tokens); effort 'medium' thought once in 15 (198 tokens). 1,024 is over 5x the
    // largest output seen at any effort, and a cut-off still degrades to the Plan 10 D3 null
    // fallback (resolvedName + city), so the allowance can never block a stop.
    descriptor: Object.freeze({ maxTokens: 1024, effort: 'low' }),
    // Plan 37 W1 / D-30-6: W0 measured the largest output at 4,319 tokens thinking included (the
    // two-page PDF); 8,700 is about 2x. The call is non-streaming, so it must stay at or under
    // 21,333 (F-30-6). A cut-off is the named `truncated` outcome and is never retried (D-30-3).
    facts: Object.freeze({ maxTokens: 8700, effort: 'medium' }),
    discovery: Object.freeze({
      // Plan 30 W3 second pass / D-30-6: with thinking disabled the largest generation in 12 was
      // 22,715 output tokens (median 19,485); 48,000 is about 2x that. Thinking is disabled
      // because at effort 'low' adaptive thinking planned the whole list before the first line
      // (first category 36 s against 12 s) and settled on the prompt's floor instead of its
      // target. A cut-off is still classified (D-30-3) and leaves the catalogue stale.
      // D-34-10 (Plan 34 W4): thinking on with an exact-count line beat this on quality but put
      // the first category at 44 s; kept off, deferred to a design that removes the wait.
      // Plan 35 W0: staged emission through a tool was that design; measured NO-GO (23-37 s).
      maxTokens: 48000,
      thinking: Object.freeze({ type: 'disabled' }),
      effort: 'low',
    }),
  }),
  'claude-haiku-4-5-20251001': Object.freeze({
    descriptor: Object.freeze({ maxTokens: 256 }),
    discovery: Object.freeze({
      // Rollback row since Plan 30 W3. Haiku 4.5's streaming output ceiling: a 16,000 budget once
      // cut off the last categories of real generations (architecture, wellness). Plan 30 W0
      // measured 17,857 median / 32,509 max output tokens per generation on this prompt, not the
      // ~40-50K once estimated; 64,000 stays so a revert sends exactly the pre-W3 body.
      maxTokens: 64000,
    }),
  }),
});

const WORKLOAD_MODELS = Object.freeze({
  extraction: EXTRACTION_MODEL,
  descriptor: PHOTO_DESCRIPTOR_MODEL,
  discovery: DISCOVERY_MODEL,
  copilot: COPILOT_MODEL,
  facts: FACTS_MODEL,
});

// The profile a workload sends: its configured model first, then that model's settings for the
// workload. Key order is { model, maxTokens, thinking?, effort? } — requestSettings() relies on
// nothing else, but the harness compares profiles by JSON text.
export function profileFor(workload) {
  const model = WORKLOAD_MODELS[workload];
  if (!model) {
    throw new Error(`unknown workload "${workload}" (expected one of ${Object.keys(WORKLOAD_MODELS).join(', ')})`);
  }
  const settings = MODEL_PROFILES[model]?.[workload];
  if (!settings) {
    throw new Error(`no ${workload} profile for model "${model}" in MODEL_PROFILES — add one before pointing ${workload} at it`);
  }
  return { model, ...settings };
}

// A bad *_MODEL constant must fail at boot, not on the first request that uses it.
for (const workload of Object.keys(WORKLOAD_MODELS)) profileFor(workload);

// A profile as the request fields it controls. Spread where model/max_tokens sit so the key order
// of a default (no thinking, no effort) body is exactly what it was before profiles existed.
// D-34-6 (Plan 34): an output `format` is a property of the workload, not of the model, so it comes
// in beside the profile and is merged into the same output_config as the model's effort (effort
// first). Sonnet 4.6 and Haiku 4.5 rows carry no effort, so they send output_config: { format }.
// With no format the result is exactly what it was, so every unstructured workload's body is unchanged.
export function requestSettings({ model, maxTokens, thinking, effort }, { format } = {}) {
  return {
    model,
    max_tokens: maxTokens,
    ...(thinking ? { thinking } : {}),
    ...(effort || format ? { output_config: { ...(effort ? { effort } : {}), ...(format ? { format } : {}) } } : {}),
  };
}

// D-30-3 (Plan 30): every request path classifies the stop before trusting the content. A refusal
// is HTTP 200 with stop_reason 'refusal' on current models; a cut-off (max_tokens, or the context
// window — which includes adaptive thinking spent before any text) leaves content incomplete or
// absent. `category` is stop_details.category when the SDK carries it: the non-streaming Message
// does; SDK 0.91.1's streamed finalMessage never copies stop_details, later SDKs do — null is a
// valid answer either way.
export function classifyStop(message) {
  const stopReason = message?.stop_reason ?? null;
  const category = message?.stop_details?.category ?? null;
  let outcome = 'complete';
  if (stopReason === 'refusal') outcome = 'refused';
  else if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') outcome = 'truncated';
  return { outcome, stopReason, category };
}

// Closed D8 scene-type vocabulary (Plan 10 §1) — used by both discovery-authored
// and Haiku-authored photo descriptors, and by the fallback query builder in
// unsplash.js. Never persist a value outside this set.
export const SCENE_TYPES = [
  'temple_shrine', 'market', 'street_neighborhood', 'nature_outdoors', 'museum_gallery',
  'landmark_architecture', 'food_drink', 'nightlife', 'beach_water', 'viewpoint',
  'wellness', 'hotel_stay', 'entertainment', 'generic',
];

// Coerces a possibly-invalid/absent sceneType string to a valid D8 enum member
// or null. Used at every write path that persists a scene_type value so a bad
// enum (model hallucination, stale client, malformed cache) never lands in the DB.
// D-34-7 (Plan 34): structured outputs do not guarantee enum capitalisation, and discovery-authored items reach this too, so a string is lower-cased and the canonical member returned.
export function coerceSceneType(value) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return SCENE_TYPES.includes(lower) ? lower : null;
}

// Plan 2A D6: the schema's city fields below (details.originCity/destinationCity/city)
// must come back as canonical English — this is what deriveDayGeo's seed layer reads.
// Local-script names are preserved in the title/station fields, not here.
// D-38-2 (Plan 38): rule 10 names the "File n of N" labels extractBookings puts before each file, so
// `sourceFiles` can say which upload a booking came from; it sits before the reasoning line so that stays last.
// Plan 34 W1: rule 11 (rule 10 until Plan 38) is the surviving half of the old fenced-block rule 9, kept on measurement. Under
// the schema contract, an input that asks the model to show its reasoning ("Please show your
// thinking…") drew a reasoning_extraction refusal on 5/6 and 6/12 calls without it, and 0 with it —
// the same as the pre-schema contract. It lets the model decline that request and still extract.
export const EXTRACTION_SYSTEM = `You are a travel-booking extraction engine. You receive raw content (pasted text, email text, screenshots, or PDFs of travel confirmations) and must extract every distinct booking as structured JSON.

Rules:
1. Extract every distinct booking present in the input — a single email or screenshot may contain more than one (e.g. outbound + return flight, or multiple train legs).
2. NEVER invent a value. If you cannot read or infer a field with reasonable confidence, set it to null and lower that field's confidence entry instead of guessing.
3. Date inference: today's date and (if provided) the trip's destination and date range are injected below as context. Use them to resolve ambiguous or partial dates:
   - If a booking's year is missing, infer it from the trip's date range if the trip context is given; otherwise infer the nearest future occurrence of that month/day relative to today, and record the inference in "assumptions".
   - If a date is ambiguous between DD/MM and MM/DD, prefer the interpretation that falls inside the trip's date range if a trip is given; otherwise pick the more common international DD/MM interpretation and set that field's confidence to "low".
4. Hotel bookings that only specify check-in/check-out dates without times: default startDatetime to T15:00 and endDatetime to T11:00, and add an assumption noting the default check-in/check-out time was applied.
5. Multilingual input: put the English/exonym city name in details.originCity / details.destinationCity / details.city; preserve the original local-script name in details.localName; set the top-level "language" field to the input's primary language code.
5a. Hotel and "other" bookings: set details.countryCode to the ISO 3166-1 alpha-2 code of the country details.city is in, using the same confidence discipline as originCountryCode/destinationCountryCode — null if you cannot infer it with reasonable confidence, never a guess.
6. Classify the input in \`result.kind\`: \`bookings\` when it contains at least one booking you can extract; \`travel_no_booking\` when it is about travel but holds no booking (a fare sale, a newsletter, a price alert, travel advice); \`not_travel\` otherwise. Never invent a booking to reach \`bookings\`.
7. Timezones: emit your best-guess IANA timezone (e.g. "Asia/Shanghai") for originTz/destinationTz. If you are not reasonably confident, use null — do not guess a generic value like "UTC".
8. Ground transfers, car rentals, tour tickets, event tickets, and anything that does not fit flight/train/bus/ferry/hotel should use type "other" with a descriptive title (e.g. "Airport transfer — Chengdu Shuangliu to hotel").
9. Put the airline code in \`details.carrierCode\` and only the number in \`details.flightNumber\`.
10. Each input file is labelled "File n of N". In \`sourceFiles\`, list the number of every file the booking's details were read from: one number when a booking comes from one file, all of them when one booking is spread across several files, and the same number on several bookings when one file holds several bookings.
11. Do not explain your reasoning in prose.`;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// D-34-1 (Plan 34): the extraction answer is an API-enforced output contract. The request carries this
// schema as output_config.format, decoding is constrained to it, and the answer is the response's
// single text block holding only JSON. It supersedes Plan 2A D4's fenced block in prose and the regex
// that found it. Hand-written and frozen on purpose (D-34-2): the body sent is the schema written here.
// D-34-5: the budget is 4 of 16 union definitions (a $ref counts once per definition, not per use) and
// 0 of 24 optional properties; compile time doubles with each optional property of one object (W0
// measured 16 optional `details` fields rejected after 180 s). A later field must be another required
// string that may be "" (not given), never an optional property, and a test walks the schema to hold
// that line. `details` keys use "" for "not given" and every pattern accepts "", so no key costs a
// union; toAppExtraction() drops the "" keys again so the returned and stored shape is unchanged.
// The `type` list repeats importer.js BOOKING_TYPES (importer imports this module, so it cannot be
// imported back without a cycle); a test pins the equality.
const EXTRACTION_BOOKING_TYPES = Object.freeze(['flight', 'train', 'bus', 'ferry', 'hotel', 'other']);

// D-38-1 (Plan 38): the 1-based file numbers `sourceFiles` may name. It repeats importer.js MAX_INPUTS
// for the same cycle reason as the type list, and a test pins the equality. The schema cannot know how
// many files one request holds, so extractBookings checks each number against files.length after validation.
export const EXTRACTION_FILE_NUMBERS = Object.freeze([1, 2, 3, 4]);

// The sixteen `details` keys, in schema order. Every one is a required string in the schema.
export const EXTRACTION_DETAIL_FIELDS = Object.freeze([
  'originCity', 'destinationCity', 'originCountryCode', 'destinationCountryCode', 'city', 'countryCode',
  'carrierCode', 'flightNumber', 'airlineName', 'trainNumber', 'originStation', 'destinationStation',
  'seatClass', 'address', 'localName', 'note',
]);

// The names a model may attach a per-field confidence to (booking fields plus the details keys it
// can be unsure of). The schema carries them as an array of { field, level } because an open-keyed
// map needs additionalProperties other than false, which structured outputs do not support.
export const EXTRACTION_CONFIDENCE_FIELDS = Object.freeze([
  'type', 'title', 'confirmationRef', 'bookingSource', 'startDatetime', 'endDatetime',
  'origin', 'destination', 'terminalOrStation', 'originTz', 'destinationTz',
  'originCity', 'destinationCity', 'originCountryCode', 'destinationCountryCode',
  'city', 'countryCode', 'carrierCode', 'flightNumber', 'airlineName', 'trainNumber',
  'originStation', 'destinationStation', 'seatClass', 'address', 'localName',
]);

export const EXTRACTION_OUTPUT_SCHEMA = deepFreeze({
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
        'details', 'confidence', 'fieldConfidence', 'assumptions', 'sourceFiles',
      ],
      properties: {
        type: { enum: [...EXTRACTION_BOOKING_TYPES] },
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
          description: 'Every key is required: write "" for anything the input does not give. Never guess a value to fill a key.',
          required: [...EXTRACTION_DETAIL_FIELDS],
          properties: {
            originCity: { type: 'string', description: 'Canonical English city name.' },
            destinationCity: { type: 'string', description: 'Canonical English city name.' },
            originCountryCode: { type: 'string', pattern: '^([A-Z]{2})?$' },
            destinationCountryCode: { type: 'string', pattern: '^([A-Z]{2})?$' },
            city: { type: 'string', description: 'Canonical English city name (hotel and other bookings).' },
            countryCode: { type: 'string', pattern: '^([A-Z]{2})?$' },
            carrierCode: {
              type: 'string',
              pattern: '^(([A-Z]{3}|[A-Z]{2}|[A-Z][0-9]|[0-9][A-Z]))?$',
              description: 'Airline code only: the 2-character IATA code (KE, U2) or the 3-letter ICAO code.',
            },
            flightNumber: {
              type: 'string',
              pattern: '^([0-9]{1,4}[A-Z]?)?$',
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
              field: { enum: [...EXTRACTION_CONFIDENCE_FIELDS] },
              level: { enum: ['high', 'medium', 'low'] },
            },
          },
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: "Short statements of any inference you made, e.g. 'Year inferred from the trip dates.'",
        },
        // D-38-1: required, no maxItems (the compile drops it, Plan 37 W0) and no union, so the D-34-5 budget holds.
        sourceFiles: {
          type: 'array',
          minItems: 1,
          items: { enum: [...EXTRACTION_FILE_NUMBERS] },
          description: 'The numbers of the files this booking was read from (see the File labels). Usually one; more when one booking spans several files.',
        },
      },
    },
  },
});

export const EXTRACTION_OUTPUT_FORMAT = Object.freeze({ type: 'json_schema', schema: EXTRACTION_OUTPUT_SCHEMA });

// D-34-2 (Plan 34): the schema's own rules re-checked in code after JSON.parse, never a second or
// different contract. It understands exactly the keywords EXTRACTION_OUTPUT_SCHEMA uses and throws on
// any other, so a later schema edit cannot leave a rule silently unchecked.
// D-34-7: enum and const membership is checked after case normalisation, and the returned copy carries the schema's own spelling.
// Returns { ok: true, value } with a normalised deep copy, or { ok: false, error } naming the first
// problem as '<json path>: <reason>'. For an anyOf the error reported is the deepest one, which is
// the branch that came closest to matching.
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type', 'const', 'enum', 'anyOf', '$ref', '$defs', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'pattern', 'description',
]);

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'null']);

function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const childPath = (path, key) => (path ? `${path}.${key}` : key);

function checkNode(value, schema, root, path) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`validateAgainstSchema does not support the "${keyword}" keyword (at ${path || 'the root'})`);
    }
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`validateAgainstSchema supports only additionalProperties: false (at ${path || 'the root'})`);
  }

  if (schema.$ref !== undefined) {
    const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    const target = match ? root.$defs?.[match[1]] : undefined;
    if (!target) throw new Error(`validateAgainstSchema cannot resolve $ref "${schema.$ref}" (at ${path || 'the root'})`);
    return checkNode(value, target, root, path);
  }

  let current = value;
  const actual = jsonTypeOf(current);

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const name of allowed) {
      if (!SCHEMA_TYPES.has(name)) {
        throw new Error(`validateAgainstSchema does not support type "${name}" (at ${path || 'the root'})`);
      }
    }
    if (!allowed.includes(actual)) {
      return { ok: false, path, reason: `expected ${allowed.join(' or ')}, got ${actual}` };
    }
  }

  const canonical = (candidates, kind) => {
    const match = candidates.find((c) => (
      typeof c === 'string' && typeof current === 'string' ? c.toLowerCase() === current.toLowerCase() : c === current
    ));
    if (match === undefined) {
      return { ok: false, path, reason: `${kind} ${candidates.map((c) => JSON.stringify(c)).join(', ')}, got ${JSON.stringify(current)}` };
    }
    current = match;
    return null;
  };
  if (schema.const !== undefined) {
    const failed = canonical([schema.const], 'must be');
    if (failed) return failed;
  }
  if (schema.enum !== undefined) {
    const failed = canonical(schema.enum, 'must be one of');
    if (failed) return failed;
  }

  if (schema.anyOf !== undefined) {
    let deepest = null;
    for (const branch of schema.anyOf) {
      const attempt = checkNode(current, branch, root, path);
      if (attempt.ok) return attempt;
      if (!deepest || attempt.path.length > deepest.path.length) deepest = attempt;
    }
    return deepest;
  }

  if (schema.pattern !== undefined && typeof current === 'string' && !new RegExp(schema.pattern).test(current)) {
    return { ok: false, path, reason: `does not match ${schema.pattern}` };
  }

  if (schema.properties !== undefined && actual === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(current, key)) return { ok: false, path: childPath(path, key), reason: 'is required' };
    }
    const copy = {};
    for (const [key, child] of Object.entries(current)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) return { ok: false, path: childPath(path, key), reason: 'is not an allowed property' };
        copy[key] = child;
        continue;
      }
      const result = checkNode(child, schema.properties[key], root, childPath(path, key));
      if (!result.ok) return result;
      copy[key] = result.value;
    }
    current = copy;
  }

  if (actual === 'array') {
    if (schema.minItems !== undefined && current.length < schema.minItems) {
      return { ok: false, path, reason: `needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}` };
    }
    if (schema.items !== undefined) {
      const copy = [];
      for (let i = 0; i < current.length; i += 1) {
        const result = checkNode(current[i], schema.items, root, `${path}[${i}]`);
        if (!result.ok) return result;
        copy.push(result.value);
      }
      current = copy;
    }
  }

  return { ok: true, value: current };
}

export function validateAgainstSchema(value, schema, root = schema) {
  const result = checkNode(value, schema, root, '');
  return result.ok ? result : { ok: false, error: `${result.path || 'the answer'}: ${result.reason}` };
}

// D-34-3 (Plan 34): the model answers a three-way classification; the app keeps the two fields it
// has always read. This folds a validated answer into { isTravelRelated, summary, language, bookings }
// with each booking exactly as the old fenced block produced it: fieldConfidence folded back into
// confidence.fields, and every details key the model left "" removed. Q-34-1 (owner, default):
// travel_no_booking counts as travel with nothing to import, so the review screen says
// "We couldn't find any bookings in that." and only not_travel says it is not travel.
export function toAppExtraction(value) {
  const { summary, language, result } = value;
  const bookings = result.kind === 'bookings'
    ? result.bookings.map((b) => ({
      type: b.type,
      title: b.title,
      confirmationRef: b.confirmationRef,
      bookingSource: b.bookingSource,
      startDatetime: b.startDatetime,
      endDatetime: b.endDatetime,
      origin: b.origin,
      destination: b.destination,
      terminalOrStation: b.terminalOrStation,
      originTz: b.originTz,
      destinationTz: b.destinationTz,
      details: Object.fromEntries(Object.entries(b.details).filter(([, v]) => v !== '')),
      confidence: {
        overall: b.confidence.overall,
        fields: Object.fromEntries(b.fieldConfidence.map((f) => [f.field, f.level])),
      },
      assumptions: b.assumptions,
      // D-38-1: 1-based numbers on the wire, 0-based import_artifact_files positions in the app,
      // folded to a sorted unique set (the schema cannot say "unique").
      filePositions: [...new Set(b.sourceFiles)].sort((x, y) => x - y).map((n) => n - 1),
    }))
    : [];
  return { isTravelRelated: result.kind !== 'not_travel', summary, language, bookings };
}

// Extracts structured bookings from pasted text / uploaded images / PDFs via a single
// non-streaming Claude call. files: [{ kind: 'text'|'image'|'pdf', mediaType, content }]
// where content is a UTF-8 string for 'text' and base64 (no data-URI prefix) otherwise.
// profile (optional): request settings override for the evaluation harness; defaults to live.
export async function extractBookings({ files, contextText, tripContext, profile = profileFor('extraction') }) {
  const client = getClient();

  const todayIso = new Date().toISOString().slice(0, 10);
  let contextBlock = `Today's date: ${todayIso}.`;
  if (tripContext) {
    contextBlock += ` Trip date range: ${tripContext.startDate} to ${tripContext.endDate}.`;
    if (tripContext.destinations?.length) {
      // destinations is an array of {city, countryCode} pairs — format as "City (CC)",
      // omitting the parenthetical for a pair with no resolved country.
      const formatted = tripContext.destinations
        .map((d) => (d.countryCode ? `${d.city} (${d.countryCode})` : d.city))
        .join(', ');
      contextBlock += ` Trip destinations: ${formatted}.`;
    }
  } else {
    contextBlock += ' No trip context given — infer the nearest future date when year/date is ambiguous.';
  }

  const content = [{ type: 'text', text: contextBlock }];
  if (contextText?.trim()) {
    content.push({ type: 'text', text: `Additional user-provided context:\n${contextText.trim()}` });
  }

  // D-38-2 (Plan 38): every file is preceded by its number and kind, never its filename (user-typed
  // metadata that can mislead), so `sourceFiles` can name it. A one-file import is labelled the same way.
  const FILE_LABEL_KIND = { text: 'pasted text', image: 'image', pdf: 'pdf' };
  for (const [index, file] of files.entries()) {
    content.push({ type: 'text', text: `File ${index + 1} of ${files.length} (${FILE_LABEL_KIND[file.kind]}):` });
    if (file.kind === 'text') {
      content.push({ type: 'text', text: file.content });
    } else if (file.kind === 'image') {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: file.mediaType, data: file.content },
      });
    } else if (file.kind === 'pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: file.content },
      });
    }
  }

  console.log('[import] extract files=%d', files.length);

  const response = await client.messages.create({
    ...requestSettings(profile, { format: EXTRACTION_OUTPUT_FORMAT }),
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content }],
  });

  const inTok = response.usage?.input_tokens ?? 0;
  const outTok = response.usage?.output_tokens ?? 0;
  console.log('[import] extract files=%d in=%d out=%d', files.length, inTok, outTok);

  const textBlocks = response.content.filter((block) => block.type === 'text');
  const fullText = textBlocks.map((block) => block.text).join('');

  // D-30-3: a refusal or cut-off is named for what it is, never reported as a bad shape. The
  // frontend shows a status'd error's message verbatim, so these are written for the traveller.
  const stop = classifyStop(response);
  if (stop.outcome === 'refused') {
    console.warn('[import] extraction refused stopReason=%s category=%s', stop.stopReason, stop.category);
    throw Object.assign(
      new Error(
        `The booking reader declined to process this input${stop.category ? ` (category: ${stop.category})` : ''}. ` +
        'Try pasting the confirmation text instead.',
      ),
      { status: 502, raw: fullText.slice(0, 2000) },
    );
  }
  if (stop.outcome === 'truncated') {
    // D-34-8 / Q-34-3: under a schema the usual cut-off is the model spending the whole allowance
    // thinking before it writes a character of the answer (F-34-7), which is not the traveller's
    // file being too long. No answer text at all means that runaway; text that began and was cut
    // is a genuinely long output, so only that case tells the traveller to split the file.
    const during = fullText.trim() ? 'text' : 'thinking';
    console.warn('[import] extraction cut off during=%s stopReason=%s out=%d', during, stop.stopReason, outTok);
    throw Object.assign(
      new Error(during === 'thinking'
        ? 'The booking reader stopped before writing its answer. Please try again.'
        : "The booking reader's output was cut off — try fewer pages or split the file."),
      { status: 502, raw: fullText.slice(0, 2000) },
    );
  }

  // D-34-2: classify the stop first (above), then parse exactly one text block and validate it.
  // Nothing is repaired: any deviation is a named 502 with the text kept for diagnosis.
  if (textBlocks.length !== 1) {
    throw extractionShapeError(`expected exactly one text block, got ${textBlocks.length}`, fullText);
  }
  const answerText = textBlocks[0].text;
  let parsed;
  try {
    parsed = JSON.parse(answerText);
  } catch (e) {
    throw extractionShapeError(`not JSON (${e.message})`, answerText);
  }
  const checked = validateAgainstSchema(parsed, EXTRACTION_OUTPUT_SCHEMA);
  if (!checked.ok) throw extractionShapeError(checked.error, answerText);
  // D-38-1: a file number past this request's file count is a deviation like any other, never clamped.
  if (checked.value.result.kind === 'bookings') {
    for (const [i, booking] of checked.value.result.bookings.entries()) {
      const outOfRange = booking.sourceFiles.find((n) => n > files.length);
      if (outOfRange !== undefined) {
        throw extractionShapeError(`result.bookings[${i}].sourceFiles: file ${outOfRange} of ${files.length}`, answerText);
      }
    }
  }

  return {
    extraction: toAppExtraction(checked.value),
    model: profile.model,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

function extractionShapeError(reason, rawText) {
  console.warn('[import] extraction unexpected shape: %s', reason);
  return Object.assign(new Error('The booking reader returned an unexpected shape.'), {
    status: 502,
    raw: rawText.slice(0, 2000),
  });
}

// Strips punctuation and common geographic suffixes so "Dujiangyan & Scenic Area"
// and "Dujiangyan Scenic Area" collapse to the same canonical key.
//
// Mirrored verbatim in THREE places that must stay in sync (Plan 26 W1.3 /
// F-26-9): this function, and — on the frontend — the copies being
// consolidated into the single shared module frontend/src/utils/placeNames.js.
// Any change here must be ported there too.
//
// [^\w\s] with no /u flag made \w ASCII-only, so any pure-CJK name (e.g.
// 北京烤鸭, 故宫博物院) folded to "" — the first such item in a destination
// claimed normalized_name = '' and every subsequent one was silently skipped
// as a duplicate by insertPlaces (discoveryCatalogue.js). \p{L}\p{N} with /u
// keeps any Unicode letter or number instead of only ASCII word characters —
// canonicalGeoKey (utils/geoIdentity.js) is the fix template. This is
// forward-only: existing normalized_name values are NOT backfilled (W3 will
// have evidence about what a rewrite would merge before that's attempted).
// Deliberately no NFD/diacritic folding here — that would change dedupe for
// accented Latin names beyond this wave's scope.
export function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// D-30-1 (Plan 30 W3 second pass): the two volume/selection lines of the discovery prompt are
// keyed by model, like the request settings, so reverting DISCOVERY_MODEL restores the prompt the
// old model was measured with. Haiku 4.5 keeps its original text. Haiku 5.5 follows a number
// literally: "Aim for 30 … do not force 30" gave 2–5 items per category, so its rules name a
// target and a floor and rank within that count instead of gating inclusion. The same wording on
// Haiku 4.5 broke its output format (a category lost, 14 lines dropped), which is why the rules
// are per model rather than shared. Every other line of the prompt is identical for both models,
// except Haiku 5.5's `categories` block (Plan 36 W4), which Haiku 4.5 does not have.
//
// D-36-4 (Plan 36): Essentials is the city's must-see places; practical logistics belong in no category.
// D-36-6 (Plan 36 W4): Haiku 5.5 asks for 12 places per category per batch, a batch size and not a cap ("Find more places" appends up to CATEGORY_ACTIVE_CAP = 45).
// The owner accepted the measured cost: on "show more", about 40% of a batch repeats an excluded name
// (control 31%), but new places per batch held (51.5 against 52.3), so the repeats cost about $0.001
// a tap and are dropped by insertPlaces. Do not "fix" the repeat rate by dropping the definitions
// without re-measuring new places per batch; see docs/DECISIONS.md.
export const DISCOVERY_SELECTION_RULES = Object.freeze({
  'claude-haiku-4-5-20251001': Object.freeze({
    quality: '- Each suggestion must earn its place. If you cannot write a specific, non-generic "whyItFits", do not include it.',
    volume: '- Aim for 30 items per category. Fewer sharp picks beats padding with mediocre ones — do not force 30 if the city cannot support it.',
  }),
  'claude-haiku-5-5': Object.freeze({
    quality: '- Each suggestion must earn its place: put the picks with the most specific "whyItFits" first in each category, and when a candidate would only get a generic "whyItFits", choose a different place instead.',
    volume: '- Return 12 places in every category. Return fewer only when the destination genuinely cannot support 12 places that meet these rules; never pad with mediocre places.',
    categories: [
      'What each category holds:',
      "- essentials: the city's must-see places — the unmissable sights and experiences a first-time visitor would regret skipping, with honest notes on crowds and timing.",
      '- culture: museums, galleries, temples, shrines, historic sites, performances and living craft traditions.',
      '- food: restaurants, street-food stalls, food markets, cafés and specific dishes worth seeking out.',
      '- nature: parks, gardens, beaches, rivers, lakes, hills and viewpoints in or within a day trip of the city.',
      '- nightlife: bars, night markets, live music, clubs and experiences that come alive after dark.',
      '- hidden_gems: specific, lesser-known places locals love and most visitors miss.',
      '- architecture: buildings, bridges, streets and quarters worth seeing for their design or history.',
      '- wellness: spas, massage, baths, yoga and quiet places to rest and recharge.',
      'Every item is a place to visit or an experience to have. Practical travel logistics belong in no category: no airports, stations or terminals used for transport, ride-hailing or taxi apps, ATMs or banks, hospitals, clinics or pharmacies, visa or immigration offices, SIM-card counters, or tourist information desks.',
    ].join('\n'),
  }),
});

// The discovery system prompt for a model (without the per-request exclusion list).
export function discoverySystemPrompt(model) {
  const rules = DISCOVERY_SELECTION_RULES[model];
  if (!rules) {
    throw new Error(`no discovery selection rules for model "${model}" in DISCOVERY_SELECTION_RULES — add them before pointing discovery at it`);
  }
  return discoverSystemWith(rules);
}

// A model's optional `categories` block sits between the category-order line and the item shape;
// a model without one (Haiku 4.5) gets exactly the text it always had.
const discoverSystemWith = ({ quality, volume, categories }) => {
  const categoriesBlock = categories ? `\n${categories}\n` : '';
  return `You are a discerning travel curator. Return ONLY newline-delimited JSON — one object per line, one line per category, nothing else. No prose, no markdown fences, no wrapper object.

Each line must match exactly:
{"category":"<name>","items":[...]}

Output all 8 categories in this order:
essentials, culture, food, nature, nightlife, hidden_gems, architecture, wellness
${categoriesBlock}
Each item: { "name": string, "description": string (1-2 sentences, specific and factual), "whyItFits": string (one concrete sentence — name atmosphere, crowd level, or specific draw; never generic phrases like "great for couples" or "popular with tourists"; describe the PLACE itself, never the traveller — never write "the traveller", "your group", "your trip", "your preferences", or any other personalization framing, since this text is shown for every trip regardless of who's asking), "estimatedDuration": string, "openingHours": string, "lat": number|null, "lng": number|null }

Additional item fields:
- Include "localName": string|null and "aliases": string[] on every item.
- For places whose common indexed/local name is not English, put the traveler-friendly English or romanized name in "name", the local-script/common local name in "localName", and alternate names in "aliases" (specified below). Use null/[] when no meaningful local variant exists.
- "name" must be the place's proper name only — what a local would see on the sign, on a map, or on a booking. Anything describing what the place offers, what it feels like, when to go, or why it is interesting belongs in "description" or "whyItFits", NEVER in "name". Wrong, in every position: "Michelin Bib Gourmand: Ay-Chung Flour-Shaping" (award label), "Sichuan University Campus – Architectural Vernacular & Student Life" (appended description), "Yongkang Street (for coffee and pastry)" / "Zhongshan Hall (post-war neoclassicism)" / "Taipei Prison (tours by appointment)" (description hidden in brackets — moving editorial into parentheses does not make it a name).
- A bracket in "name" may contain ONLY one of: a branch or street/district that distinguishes this outlet from others of the same name; the local-script or romanized form of the same name; or a well-known alternate name. Nothing else. Right: "Din Tai Fung (Taipei Nanjing Location)", "Chen Mapo Tofu (Xuanhuang Street Location)", "Elephant Mountain (Xiangshan)". If the bracket does not carry one of those three things, delete it — a bare "Yongkang Street" is correct and complete.
- "aliases": every OTHER name this exact place is known by, so it can still be found when "name" fails a map search. Include each kind that applies: the official/registered name; the romanized form; the common local name written in Latin script; a well-known short form or acronym; and the bare name when "name" carries a branch or location qualifier. Worked examples: "Islamic Arts Museum Malaysia" → ["IAMM"]; "Sultan Abdul Samad Building" → ["Bangunan Sultan Abdul Samad"]; "Din Tai Fung (Taipei Nanjing Location)" → ["Din Tai Fung"]. Most real places have at least one — use [] only for a place that genuinely has no other name, such as an unnamed street stall. HARD RULES: never repeat "name" verbatim as an alias; never use the name of a DIFFERENT place, even a similar or nearby one (aliases are searched against real maps, so a wrong one pins this suggestion to the wrong location); never a description, category, or marketing text. At most 4.
- Include "photoQuery": a culturally specific English search string for stock-photo search (at most 8 words, referencing the actual place/cuisine/activity — never generic terms like "nice place" or "travel photo").
- Include "sceneType": exactly one of temple_shrine, market, street_neighborhood, nature_outdoors, museum_gallery, landmark_architecture, food_drink, nightlife, beach_water, viewpoint, wellness, hotel_stay, entertainment, generic. Choose the closest match; use "generic" if unsure.

Curation rules:
- Avoid the generic tourist front page. Only include a famous landmark if it is genuinely unmissable AND you can explain a specific, compelling reason to visit beyond its name.
- Prioritise places with authentic local character: neighbourhood favourites, spots that reward insider knowledge, experiences with real depth.
${quality}
${volume}
- Use the most specific, locally-used name for each place. Do not append generic suffixes unless part of the official name.
- Do not repeat the same place across categories.`;
};

// A model without discovery selection rules must fail at boot, not on its first generation.
discoverySystemPrompt(DISCOVERY_MODEL);

// Lines that are pure JSON-array/markdown-fence scaffolding rather than a
// category object — seen when the model wraps its NDJSON output in a
// pretty-printed JSON array despite being told not to.
const STRUCTURAL_LINE_RE = /^(\[|\]|```json|```)$/;

// Maps a possibly-mangled category name (wrong case, spaces instead of
// underscores, stray whitespace) onto one of the canonical DISCOVERY_CATEGORIES
// names. Returns null when it doesn't match any canonical name — the frontend's
// tabs and the ranking layer (services/discoveryRank.js) key off these exact
// strings, so an unrecognized name must never be stored.
function canonicalizeCategoryName(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, '_');
  return DISCOVERY_CATEGORIES.includes(normalized) ? normalized : null;
}

// Backstop for the "name" instruction in the discovery prompt (W4.1a) — not the primary fix, the
// prompt is. Strips an editorial/award label prefix ending in a colon at bracket depth zero
// (e.g. "Michelin Bib Gourmand: Ay-Chung Flour-Shaping" -> "Ay-Chung Flour-Shaping").
//
// Colon-only, deliberately: dashes are NOT stripped here. Measured evidence (Plan 27 W4, M2) —
// of 60 dash-shaped names in the dev catalogue, roughly 10% put the real place name on the
// RIGHT of the dash ("Rooftop Cocktail Bar — Yu Shang (玉尚)", "Craft Beer Brewery — Xiaofeng
// Brewing (小风精酿)"). A deterministic dash strip would destroy those real names with no way
// to tell which side is which. Dashes are handled by the prompt alone.
//
// Forward-only: existing stored names are never rewritten by this function.
export function stripEditorialNamePrefix(name) {
  if (typeof name !== 'string' || !name) return name;

  let depth = 0;
  let colonIndex = -1;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    if (ch === '(' || ch === '[' || ch === '【' || ch === '（') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '】' || ch === '）') {
      depth = Math.max(0, depth - 1);
    } else if ((ch === ':' || ch === '：') && depth === 0) {
      colonIndex = i;
      break;
    }
  }

  if (colonIndex === -1) return name;

  const before = name[colonIndex - 1];
  const after = name[colonIndex + 1];
  if ((before && /\d/.test(before)) || (after && /\d/.test(after))) return name;

  const head = name.slice(0, colonIndex).trim();
  const tail = name.slice(colonIndex + 1).trim();

  if (!head || head.split(/\s+/).length > 5) return name;
  if (!tail || !/[\p{L}\p{N}]/u.test(tail)) return name;

  return tail;
}

// Structural half of the "aliases" instruction in the discovery prompt (W4.3) — same
// stated-then-enforced pattern as photoQuery's word cap. The prompt already forbids repeating
// "name" verbatim as an alias, but a Plan 27 W4.3 A/B run measured the model doing it anyway in
// 5 of 98 generated items (e.g. name "Taipei Story House", aliases ["Taipei Story House"]).
// Removing an alias identical to the name is lossless: aliases are query variants the resolver
// tries only after "name" has already failed a geocoder lookup (resolverQueryTexts in
// placeResolver.js issues one HTTP request per variant), so a name-identical alias is guaranteed
// to repeat a query that has already failed — never a scenario where it helps.
export function sanitizeGeneratedAliases(aliases, name) {
  if (!Array.isArray(aliases)) return [];

  const normalizedName = typeof name === 'string' && name ? normalizeName(name) : null;
  const seen = new Set();
  const result = [];

  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    const trimmed = alias.trim();
    if (!trimmed) continue;

    const n = normalizeName(trimmed);
    if (normalizedName !== null && n === normalizedName) continue;
    if (seen.has(n)) continue;
    seen.add(n);

    result.push(trimmed);
    if (result.length >= 4) break;
  }

  return result;
}

// Streams discovery results as NDJSON. Calls onCategory({ category, items }) for each
// completed line as Claude generates it. Returns the full accumulated results array for caching.
// profile (optional): request settings override for the evaluation harness; defaults to live.
export async function discoverDestination(destination, existingStopTitles = [], onCategory, profile = profileFor('discovery')) {
  console.log('[discover] destination=%s existingStops=%d', destination, existingStopTitles.length);

  const client = getClient();

  const existingLine = existingStopTitles.length > 0
    ? `\nAlready shown or in itinerary — do not suggest these or close variants:\n${existingStopTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  const baseSystem = discoverySystemPrompt(profile.model);
  const systemPrompt = existingLine ? `${baseSystem}${existingLine}` : baseSystem;

  const stream = client.messages.stream({
    ...requestSettings(profile),
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Curate the best of ${destination}. Include neighbourhood gems alongside the genuinely unmissable. Be specific, be honest about crowds and tourist traps.`,
    }],
  });

  const accumulated = [];
  const seen = new Set();
  let buffer = '';
  let droppedLineCount = 0;
  let unnamedCount = 0;
  let dedupedCount = 0;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (STRUCTURAL_LINE_RE.test(trimmed)) return;

    // Strip a single trailing comma left over when the model wraps its NDJSON
    // output in a pretty-printed JSON array (e.g. `{...},`) — this was the
    // root cause of the production incident: every line but the last was
    // invalid standalone JSON and silently dropped.
    const candidate = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;

    let obj;
    try {
      obj = JSON.parse(candidate);
    } catch (e) {
      droppedLineCount += 1;
      console.error(
        '[discover] dropped unparseable line (len=%d): %s',
        line.length, line.slice(0, 120),
      );
      return;
    }
    if (!obj.category || !Array.isArray(obj.items)) return;

    const canonicalCategory = canonicalizeCategoryName(obj.category);
    if (!canonicalCategory) {
      console.error('[discover] dropped unknown category name: %s', obj.category);
      return;
    }

    // Sanitize name (strip editorial prefix, W4.1b) before dedupe so the stored name and its
    // dedupe key agree — apply first, so both accumulated (cached/persisted) and the object
    // handed to onCategory (streamed to the client) carry the same sanitized name. Aliases are
    // sanitized against the already-stripped name (W4.3) so an alias matching the editorial
    // prefix's real name is also caught, not just one matching the raw unstripped string. Build
    // a new item object rather than mutating the caller's parsed one — always a clone, since
    // sanitizeGeneratedAliases returns a fresh array on every call anyway.
    const named = obj.items.filter((item) => !!item?.name);
    unnamedCount += obj.items.length - named.length;
    const kept = named
      .map((item) => {
        const sanitizedName = stripEditorialNamePrefix(item.name);
        const sanitizedAliases = sanitizeGeneratedAliases(item.aliases, sanitizedName);
        return { ...item, name: sanitizedName, aliases: sanitizedAliases };
      })
      .filter((item) => {
        const n = normalizeName(item.name);
        if (seen.has(n)) {
          dedupedCount += 1;
          return false;
        }
        seen.add(n);
        return true;
      });

    const categoryObj = { category: canonicalCategory, items: kept };
    accumulated.push(categoryObj);
    if (onCategory) onCategory(categoryObj);
  };

  stream.on('text', (text) => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // last element may be incomplete
    for (const line of lines) processLine(line);
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    console.error(
      '[discover] end destination=%s stop_reason=error categories=%d dropped=%d deduped=%d unnamed=%d error=%s',
      destination, accumulated.length, droppedLineCount, dedupedCount, unnamedCount, err?.message,
    );
    throw err;
  }
  // Flush any remaining content in buffer
  if (buffer.trim()) processLine(buffer);

  const categoriesWithItems = accumulated.filter((c) => c.items.length > 0).length;
  const totalItems = accumulated.reduce((sum, c) => sum + c.items.length, 0);

  // D-30-3: one line per generation, on success and failure alike — a cut-off or refused
  // generation must be visible in the logs, not inferred from a thin catalogue later.
  // D-36-3 (Plan 36 W1): the Plan 30 standing log check reads complete=false directly, and deduped/unnamed make silent drops visible.
  const stop = classifyStop(message);
  const complete = DISCOVERY_CATEGORIES.every(
    (name) => accumulated.some((c) => c.category === name && c.items.length > 0),
  );
  console.log(
    '[discover] end destination=%s stop_reason=%s category=%s output_tokens=%d categories=%d items=%d dropped=%d complete=%s deduped=%d unnamed=%d',
    destination, stop.stopReason, stop.category, message?.usage?.output_tokens ?? 0,
    categoriesWithItems, totalItems, droppedLineCount, complete, dedupedCount, unnamedCount,
  );

  // A truncated or refused generation is a failed generation: throwing here, before
  // runCatalogueGeneration bumps freshness, leaves the catalogue stale exactly as the
  // empty-generation throw below does (categories that completed stay inserted — additive).
  if (stop.outcome !== 'complete') {
    throw new Error(
      `[discover] generation ${stop.outcome} for destination=${destination}: stop_reason=${stop.stopReason}` +
      `${stop.category ? ` category=${stop.category}` : ''}, ` +
      `${categoriesWithItems} categories with items (${totalItems} items), ${droppedLineCount} lines dropped as unparseable`,
    );
  }

  // D-36-1 (Plan 36 W1): zero usable items is no catalogue, not a short one, so it is an error.
  // Anything with at least one usable item is returned; whether it is complete is judged at
  // read time by isCatalogueFresh, and a short catalogue is completed by the next stale refresh.
  if (categoriesWithItems === 0) {
    throw new Error(
      `[discover] empty generation for destination=${destination}: ` +
      `${categoriesWithItems} of ${accumulated.length} parsed categories had items ` +
      `(${totalItems} items total), ${droppedLineCount} lines dropped as unparseable`,
    );
  }

  console.log('[discover] ok categories=%o', accumulated.map((c) => c.category));
  return accumulated;
}

// D-34-1 (Plan 34): the photo descriptor's output contract is an API-enforced JSON schema, never a fenced block asked for in prose.
// D-34-2: the server still checks what the schema cannot say (shape, emptiness); the word limit is prompt guidance, not a check (D-34-12).
// The enum is built from SCENE_TYPES so the Plan 10 D8 vocabulary has one source (a copy is spread so deepFreeze leaves SCENE_TYPES itself unfrozen).
// photoQuery deliberately has NO pattern: the W0 compile probe rejected a {0,7} range quantifier ("Cannot apply a range quantifier to this regex")
// and seven optional groups ("Schema is too complex."), so the 8-word limit is prompt guidance: the server logs a query past it and sends it unchanged (D-34-12), never cuts it.
export const PHOTO_DESCRIPTOR_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['photoQuery', 'sceneType'],
  properties: {
    photoQuery: {
      type: 'string',
      description: 'A culturally specific English stock-photo search, at most 8 words, naming the actual place, cuisine or activity.',
    },
    sceneType: { enum: [...SCENE_TYPES] },
  },
});

export const PHOTO_DESCRIPTOR_OUTPUT_FORMAT = Object.freeze({ type: 'json_schema', schema: PHOTO_DESCRIPTOR_OUTPUT_SCHEMA });

const PHOTO_DESCRIPTOR_MAX_WORDS = 8;

// Plan 34 W2 deleted every output-format line (D-34-1); a refusal probe measured the deletion before it was made:
// 0 refusals in 252 calls across seven reasoning-flavoured stop inputs ("Please show your thinking", "Replay your
// reasoning step by step", "write out your chain of thought", ...) on Haiku 5.5 and Haiku 4.5, old contract and
// schema contract alike, so unlike extraction's rule 10 no "do not explain your reasoning" line is needed.
// Plan 34 Q-34-5 (owner-authorised variant): without the old fenced shape the queries lost visual detail (blind read 40%);
// the visual-detail cue restored it (55%). The examples are deliberately places outside the harness fixtures.
export const PHOTO_DESCRIPTOR_SYSTEM = `You generate a stock-photo search descriptor for a single travel stop.

Rules:
- photoQuery: a culturally specific English search string for stock-photo search. Name the actual place, cuisine, or activity, then add the visual detail a good photo of it would show (for a ramen counter, "steaming bowl"; for a lighthouse, "cliff at dusk"). Never generic terms like "nice place" or "travel photo".
- photoQuery is at most ${PHOTO_DESCRIPTOR_MAX_WORDS} words, never more: if it runs longer, drop the least useful words.
- sceneType: exactly one of ${SCENE_TYPES.join(', ')}. Choose the closest match; use "generic" if unsure.`;

// Single cheap Haiku call generating { photoQuery, sceneType } for a manually-added
// stop that carries no descriptor of its own (Plan 10 D3). Must never block stop creation:
// every failure mode (missing key, network error, a stop that did not complete, output that
// breaks the D-34-1 schema contract) is caught and returns null so the
// caller falls through to resolvedName+city. Nothing is repaired: no fence stripping, no truncation; a query past the 8-word guidance is logged and sent as written (D-34-12).
// profile (optional): request settings override for the evaluation harness; defaults to live.
export async function generatePhotoDescriptor({ title, resolvedName, city, country, type, profile = profileFor('descriptor') }) {
  try {
    const client = getClient();

    const contextParts = [
      resolvedName || title,
      city,
      country,
      type ? `stop type: ${type}` : null,
    ].filter(Boolean);

    const response = await client.messages.create({
      ...requestSettings(profile, { format: PHOTO_DESCRIPTOR_OUTPUT_FORMAT }),
      system: PHOTO_DESCRIPTOR_SYSTEM,
      messages: [{ role: 'user', content: contextParts.join(', ') }],
    });

    // D-30-3: every null below says why — a model-side regression must show in the logs, not
    // only as worse photos.
    const stop = classifyStop(response);
    if (stop.outcome !== 'complete') {
      console.warn('[photo] descriptor not usable', { title, stopReason: stop.stopReason, category: stop.category });
      return null;
    }

    // D-34-2: exactly one text block (thinking blocks are ignored), parsed and validated; one log prefix for every null.
    const unusable = (reason) => {
      console.warn('[photo] descriptor not usable', { title, reason });
      return null;
    };
    const textBlocks = response.content.filter((block) => block.type === 'text');
    if (textBlocks.length !== 1) return unusable(`expected exactly one text block, got ${textBlocks.length}`);

    let parsed;
    try {
      parsed = JSON.parse(textBlocks[0].text);
    } catch (e) {
      return unusable(`not JSON (${e.message})`);
    }
    const checked = validateAgainstSchema(parsed, PHOTO_DESCRIPTOR_OUTPUT_SCHEMA);
    if (!checked.ok) return unusable(checked.error);

    const words = checked.value.photoQuery.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return unusable('photoQuery is empty');
    // D-34-12 (Plan 34 Q-34-6, owner): an over-limit query is sent as written and logged — the grammar cannot count words, cutting splits names ("Hong Kong"), and discarding lost descriptors that find photos.
    if (words.length > PHOTO_DESCRIPTOR_MAX_WORDS) {
      console.warn('[photo] descriptor over word limit', { title, words: words.length, limit: PHOTO_DESCRIPTOR_MAX_WORDS });
    }

    return { photoQuery: words.join(' '), sceneType: checked.value.sceneType };
  } catch (err) {
    console.warn('[photo] descriptor generation failed', { title, error: err?.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document facts (Plan 37): the conditions in a booking's documents, read once at import
// ---------------------------------------------------------------------------

// The eight kinds a fact can carry; the schema's `kind` enum is built from this so the vocabulary has one source.
export const FACT_KINDS = Object.freeze([
  'deadline', 'window', 'requirement', 'instruction', 'allowance', 'contact', 'restriction', 'cost_condition',
]);

// D-37-4 (Plan 37): one object type, every property required, "" for not given, no anyOf — inside D-34-5's budget (0 optional properties, 0 unions) and validateAgainstSchema's keyword set as it stands.
// There is no `maxItems`: the API rejects it (W0, 2026-10-20), so a read is bounded by its max_tokens allowance, whose cut-off is the named `truncated` outcome.
// The `at` pattern's nested optional group compiled on Haiku 5.5, Sonnet 5.5 and Sonnet 4.6, so date and time are one field.
export const FACTS_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['documentSummary', 'language', 'facts'],
  properties: {
    documentSummary: { type: 'string', description: 'One line: what this document is, e.g. "Hotel confirmation, 3 nights".' },
    language: { type: 'string', pattern: '^[a-z]{2}$', description: "ISO 639-1 code of the document's primary language." },
    facts: { type: 'array', items: { $ref: '#/$defs/fact' } },
  },
  $defs: {
    fact: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'label', 'value', 'quote', 'page', 'at', 'tz', 'tzSource', 'appliesFrom', 'appliesTo', 'confidence'],
      properties: {
        kind: { enum: [...FACT_KINDS] },
        label: { type: 'string', description: 'Up to five English words, e.g. "Free cancellation until".' },
        value: { type: 'string', description: 'The condition as one short English phrase.' },
        quote: { type: 'string', description: 'The sentence or fragment exactly as printed, in its original language. Never paraphrase, translate or shorten it.' },
        page: { type: 'string', pattern: '^([1-9][0-9]{0,2})?$', description: 'Page number as printed, 1-based; "" for a single image or when pages are not distinguishable.' },
        at: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?)?$', description: 'The moment the condition refers to, local to the place: a date, or a date and time; "" if none.' },
        tz: { type: 'string', pattern: '^([A-Za-z]+(/[A-Za-z0-9_+-]+)+)?$', description: 'IANA zone only when stated by the document or supplied by the booking context; "" otherwise.' },
        tzSource: { enum: ['document', 'booking', 'none'] },
        appliesFrom: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' },
        appliesTo: { type: 'string', pattern: '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' },
        confidence: { enum: ['high', 'medium', 'low'] },
      },
    },
  },
});
export const FACTS_OUTPUT_FORMAT = Object.freeze({ type: 'json_schema', schema: FACTS_OUTPUT_SCHEMA });

// Bump when the prompt or schema changes: a document is re-read only when its read key (content hash, model, this version) changes (D-37-1).
export const FACTS_PROMPT_VERSION = '37.2';

// D-37-10 (Plan 37): a time keeps its document's zone or says it has none — rule 5 sets `tz` only when the document states a zone or the booking context supplies one, and `tzSource` records which, so the UI can say "zone not stated" instead of assuming.
// D-37-14 (Plan 37 W2b): rules 10–12 keep the booking's own schedule and identity, the lines of its price, and a condition stripped of its circumstance out of the facts at the reader, because the display never filters fact content.
// The prompt is Plan 37 §4.2 as amended by W2b (37.2); its last rule is the same reasoning-request guard as extraction's last rule (Plan 34 W1).
export const FACTS_SYSTEM = `You are a travel-document reading engine. You receive one document that belongs to a traveller's booking (a confirmation email, an e-ticket, a hotel voucher, a pass, a tour voucher, a luggage-forwarding sheet, or a screenshot of one) and must list every condition in it as structured JSON.

A condition is anything that could change what the traveller must do, bring, pay or expect, or when: deadlines (cancel by, change by, check-in opens, pay by, collect by), windows (check-in hours, reception hours, pickup time, entry slot, validity period), requirements (passport, printed voucher, the card used to pay, a QR code, an ID matching the name), instructions (meeting point, platform, terminal, how to reach, what to show), allowances (baggage, breakfast, what the fare or rate includes), contacts (phone, email, address in local script), restrictions (non-refundable, non-changeable, no late entry, age limits), cost conditions (deposit, city tax, resort fee, late fee).

Rules:
1. Read the whole document, every page. One fact per condition; a condition stated twice is one fact.
2. NEVER invent a value. Quote the sentence or fragment exactly as printed, in its original language; never paraphrase, translate or shorten the quote. Put the English reading in "value".
3. Skip boilerplate that names no specific time, amount, place or action (general terms, marketing, "subject to conditions" lines). Keep anything with a time, a date, an amount, a place, a name requirement or an action.
4. "at" is the moment the condition refers to, local to the place, as a date or a date and time; "" when the condition has none. A date without a year takes the year from the booking context below; make no other inference.
5. "tz" is the IANA zone only if the document states a zone or the booking context supplies one, and "tzSource" says which; otherwise "" and "none". A zone the document names in words ("Japan time") is a zone the document states. Never guess a zone.
6. "page" is the page number as printed, 1-based; "" for a single image or when pages are not distinguishable.
7. "kind" is one of the eight kinds; choose the closest. "label" is up to five English words; "value" is one short English phrase.
8. The booking context below (type, title, dates, zones, trip dates) is for disambiguation only; never produce a fact from the context itself.
9. If the document holds no condition, return an empty "facts" array; never pad.
10. The booking's own schedule and identity are not conditions, even though they carry times, dates and places: the vehicle's departure and arrival times and dates, the airports and stations, the flight or train number, the cabin or fare class, the seat, the booked room and number of guests, the booked dates of stay on their own, the guests' or passengers' names, the booking reference. What the traveller must do, or where they must go, stays a condition even when it is printed in the booking's schedule: a hotel's check-in and check-out hours ("Check-In: Monday, June 8, 2026 03:00 PM" is a check-in condition, with its date and hour), the boarding time, gate or check-in counter closing times, reception hours, the departure or arrival terminal, platform or meeting point ("Changi Terminal 3" is a terminal instruction), and the property's contacts.
11. The booking's price is not a condition, even though it is an amount: its total and every line of a summary of charges that adds up to a stated total are part of what is paid, however a line is named; when lines are followed by a total equal to their sum, none of them is a condition. A "cost_condition" is a charge no stated total includes, or one an action or a deadline triggers: a deposit, a percentage added on top of a rate that no total includes, a charge to pay at the property on top of the total, a cancellation, no-show or late fee. Only when the document says the price is still to be paid at the property or by a date is it one fact, for the amount due.
12. A condition that applies only in a circumstance (a carrier, a connection or onward flight, a passenger type, a residency, a late arrival) keeps that circumstance at the start of "value", e.g. "If you have an onward flight: collect and re-check your bags".
13. Do not explain your reasoning in prose.`;

const orNotGiven = (v) => (v ? v : 'not given');

// The booking-context text block (§4.2): type, title, start, end, origin and destination zones per
// booking the document backs (one artifact can back several bookings, F-37-14), then the trip's
// dates. No "today": nothing in the read depends on it, and a constant block keeps reads of the same
// document comparable across days.
//   context = { bookings: [{ type, title, startDatetime, endDatetime, originTz, destinationTz }],
//               trip: { startDate, endDate } }
export function buildFactsContextText(context) {
  const bookings = context?.bookings ?? [];
  if (!bookings.length) throw new Error('facts context: a document must belong to at least one booking');
  const lines = ['Booking context (for disambiguation only):'];
  bookings.forEach((b, i) => {
    lines.push(
      `Booking ${i + 1}: ${b.type} "${b.title}"; start ${orNotGiven(b.startDatetime)}; end ${orNotGiven(b.endDatetime)}; ` +
      `origin zone ${orNotGiven(b.originTz)}; destination zone ${orNotGiven(b.destinationTz)}.`,
    );
  });
  const trip = context?.trip ?? {};
  lines.push(`Trip dates: ${orNotGiven(trip.startDate)} to ${orNotGiven(trip.endDate)}.`);
  return lines.join('\n');
}

// The document in extraction's transport (F-37-11). `content` is UTF-8 text for kind text and
// base64 for image and pdf.
function documentBlock(document) {
  if (document.kind === 'text') return { type: 'text', text: document.content };
  if (document.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: document.mediaType, data: document.content } };
  }
  if (document.kind === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.content } };
  }
  throw new Error(`facts request: unknown document kind "${document.kind}"`);
}

// The full request body: the profile's settings with the format beside its effort (D-34-6), the
// system prompt as a plain string (no cache_control: one document per call, nothing stable enough to
// cache), and one user turn of context then document.
export function buildFactsRequest(profile, { context, document }) {
  return {
    ...requestSettings(profile, { format: FACTS_OUTPUT_FORMAT }),
    system: FACTS_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildFactsContextText(context) }, documentBlock(document)] }],
  };
}

// D-30-3 / D-37-4: classify the stop first, then parse exactly one text block and validate it.
// Nothing is repaired. Returns { outcome, stopReason, category, error, detail, value, parsed } where
// outcome is complete | refused | truncated | invalid. `error` is a short category — null, or one of
// not_one_text_block | not_json | schema_mismatch | empty_quote — and is the only part a caller may
// store: `detail` is the human message (a validator path and reason, a JSON parse message) and can
// echo what the model wrote, so it is for a developer's eyes, never for a row or a log line.
// `value` is the validated answer (enum spellings normalised, D-34-7) only when complete; `parsed`
// is kept on an invalid outcome so a harness record shows what came back.
export function classifyFactsResponse(message) {
  const stop = classifyStop(message);
  const base = { stopReason: stop.stopReason, category: stop.category };
  if (stop.outcome !== 'complete') return { ...base, outcome: stop.outcome, error: null, detail: null, value: null, parsed: null };

  const invalid = (error, detail, parsed = null) => ({ ...base, outcome: 'invalid', error, detail, value: null, parsed });
  const textBlocks = (message.content ?? []).filter((b) => b.type === 'text');
  if (textBlocks.length !== 1) return invalid('not_one_text_block', `expected exactly one text block, got ${textBlocks.length}`);

  let parsed;
  try {
    parsed = JSON.parse(textBlocks[0].text);
  } catch (err) {
    return invalid('not_json', `not JSON (${err.message})`);
  }
  const checked = validateAgainstSchema(parsed, FACTS_OUTPUT_SCHEMA);
  if (!checked.ok) return invalid('schema_mismatch', checked.error, parsed);
  // D-37-2: no fact without its quote.
  const emptyQuote = checked.value.facts.findIndex((f) => !normaliseForMatch(f.quote));
  if (emptyQuote !== -1) return invalid('empty_quote', `facts[${emptyQuote}].quote: empty`, parsed);

  return { ...base, outcome: 'complete', error: null, detail: null, value: checked.value, parsed };
}

// A provider failure as a named outcome: the signal aborting, an HTTP status, a connection or timeout
// failure, or anything else the SDK threw. Never the document's text.
function factsProviderError(err, signal) {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (Number.isInteger(err?.status)) return `api_${err.status}`;
  if (err instanceof Anthropic.APIConnectionError) return 'connection';
  return 'unexpected';
}

// Reads one document into facts with a single non-streaming call (Plan 37). Provider failures are
// outcomes, never throws and never null: the caller records every attempt, so a read that could not
// finish says why. Nothing is retried or repaired (D-30-3, D-37-4); a request that cannot be built
// (an unknown document kind, a context with no booking) is a bug and throws.
// document: { kind: 'text'|'image'|'pdf', mediaType, content } — content is UTF-8 for text, base64 otherwise.
// context: see buildFactsContextText. profile (optional): request settings override for the
// evaluation harness; defaults to live. signal (optional): aborts the request.
// Returns { outcome, stopReason, category, error, detail, value, usage, totalMs, model } where outcome is
// complete | refused | truncated | invalid | error and usage is { inputTokens, outputTokens } or null.
// Never logs the document, a quote or a fact.
export async function readDocumentFacts({ document, context, profile = profileFor('facts'), signal }) {
  const request = buildFactsRequest(profile, { context, document });
  const started = Date.now();

  let message;
  try {
    message = await getClient().messages.create(request, signal ? { signal } : undefined);
  } catch (err) {
    const error = factsProviderError(err, signal);
    console.warn('[facts] read not usable', { outcome: 'error', error, stopReason: null });
    return {
      outcome: 'error', stopReason: null, category: null, error, detail: err?.message ?? null,
      value: null, usage: null, totalMs: Date.now() - started, model: profile.model,
    };
  }

  const classified = classifyFactsResponse(message);
  const read = {
    outcome: classified.outcome,
    stopReason: classified.stopReason,
    category: classified.category,
    error: classified.error,
    detail: classified.detail,
    value: classified.value,
    usage: { inputTokens: message.usage?.input_tokens ?? 0, outputTokens: message.usage?.output_tokens ?? 0 },
    totalMs: Date.now() - started,
    model: profile.model,
  };
  if (read.outcome !== 'complete') {
    console.warn('[facts] read not usable', { outcome: read.outcome, error: read.error, stopReason: read.stopReason });
  }
  return read;
}

// Query tool_use names the loop below executes server-side and feeds back as a tool_result —
// never terminal. The loop itself is already generic over this set.
const QUERY_TOOL_NAMES = new Set([SEARCH_DISCOVERY_CATALOGUE_TOOL.name, CHECK_TRIP_HEALTH_TOOL.name]);

// Max EXECUTED query-tool calls per user turn (Plan 12 G2). Once hit, further query tool_use blocks
// are answered with a budget-notice tool_result instead of being executed — the model gets one
// post-cap response to answer with what it already has before the hard stop below kicks in.
const QUERY_TOOL_CAP = 5;

// D-30-4 (Plan 30): the co-pilot SSE writes nothing between flushHeaders() and the first text
// delta or tool event, and a thinking-capable model can spend a long time there. Cloudflare's
// tunnel closes an origin connection that sends no bytes for 100 s, so a {type:'ping'} goes out
// every 8 s — the same interval the discovery route uses for its {type:'thinking'} keep-alive
// (routes/discovery.js). The frontend parser ignores event types it does not know.
export const COPILOT_PING_INTERVAL_MS = 8000;

// persistTurn (optional): async callback the route owns. Called exactly once per turn, whichever
// way it ends, with { assistantText, operations, notice } — operations is the tool_use payload or
// null, and notice is why the turn ended short of a normal reply: 'stopped' (the traveller
// pressed Stop), 'interrupted' (a provider error), 'truncated', 'refused', 'empty', or null.
// It persists the assistant message (always one row, D-30-8) + (when operations exist) the
// proposal record, and returns the enriched proposal SSE payload ({ proposalId, operations,
// warnings, status, statusReason }) or null. A stopped or errored turn never passes operations,
// so a half-streamed propose_itinerary_changes can never become a proposal. The explanation that
// follows a propose call (D-30-9) is part of assistantText, so the saved row carries the prose and
// the operations together. Keeping persistence in the route (not here) is why claude.js stays
// DB-free; when persistTurn is absent (unit tests) the Wave 1 { operations }-only event is
// emitted so the protocol still round-trips.
//
// toolExecutors (optional, Plan 12 Wave 1): { [toolName]: async (input) => resultObject },
// injected by the route the same way as persistTurn — this file stays DB-free, the route owns
// what a query tool actually does (catalogue reads, trip-health checks, etc).
//
// turnInfo (optional): { messageId }, the saved question row's id, owned by the route. D-32-2 (Plan 32):
// when present it goes out as the first SSE event, { type: 'turn', messageId }, right after
// flushHeaders(), so the panel learns the server id of a question it showed before the save was
// visible to it. Older clients ignore the unknown type. Absent in unit tests and the harness.
//
// profile (optional): request settings override for the evaluation harness; defaults to live.
export async function streamCopilotResponse(conversationMessages, itineraryContext, res, req, persistTurn, toolExecutors = {}, reportTurnMetrics, turnInfo = null, profile = profileFor('copilot')) {
  const client = getClient();

  const write = (data) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (turnInfo?.messageId) write({ type: 'turn', messageId: turnInfo.messageId });

  const systemPrompt = `You are a travel co-pilot helping a traveller manage and improve their trip itinerary.

Current itinerary (JSON):
${JSON.stringify(itineraryContext, null, 2)}

## What you can do
- Explain and reason about the trip in warm, concise prose.
- Suggest improvements to a day's flow, density, or order.
- Propose concrete itinerary changes by calling the propose_itinerary_changes tool.

## How to propose changes
- The ONLY way to change the itinerary is to call the propose_itinerary_changes tool. Never write changes as prose, JSON, or code blocks.
- Call the tool first. Once Trippy has acknowledged the call, explain the proposed changes to the traveller in prose: what changes and why, in your own words. If you are not proposing changes, do not call the tool.
- Use real dayId and stopId values from the itinerary above.

## Booking-linked stops are off-limits
- Any stop marked "bookingLinked": true is tied to a confirmed booking (flight, hotel, train, and so on). Never propose to add, move, remove, or edit a booking-linked stop. If the traveller wants to change one, tell them to manage it in Logistics.

## Timing rules — never fabricate times
Stops carry one of four kinds of timing. Respect them:
1. Booking-linked timed commitment — fixed by a real booking. You never touch these.
2. Explicitly timed manual stop — the traveller set a specific clock time (for example a dinner reservation).
3. Untimed flexible stop — no clock time; it happens sometime that day. This is the default and is never judged against the clock.
4. Soft hint — a duration ("~2h") or best time of day ("morning"), NOT a clock time.

- Set "time" to null unless the traveller's request is specifically about a clock time. Do NOT invent "HH:MM" values to fill a slot.
- When discussing an untimed stop, talk in terms of order, density, and flexibility ("in the morning", "before lunch") — never a fabricated timetable.
- A "time" value, when set, must be 24-hour "HH:MM".

## Grounding new place recommendations
- Trippy's discovery catalogue — not your training knowledge — is the only source for concrete new-place suggestions. Before naming a specific restaurant, sight, bar, or any other place the traveller could add to the itinerary, call search_discovery_catalogue for that destination and recommend only places it returned. Never invent or recall a place from general knowledge and present it as a suggestion.
- General destination colour (neighbourhoods, vibe, famous landmarks mentioned in passing) is fine without a tool call — the grounding rule is about concrete "add this place" recommendations.
- search_discovery_catalogue only works for destinations already on this trip. If the traveller asks for suggestions somewhere else, do not call the tool — decline warmly and suggest adding that destination to the trip first.
- Relay each search's catalogueState honestly. "fresh": recommend from the returned places. "generating": relay any returned places honestly (there may be none), tell the traveller Trippy is gathering fresh picks for that destination in the background and to ask again in about a minute, and never fill the gap from your own knowledge. "generation_capped": say plainly that this destination's suggestions have already been refreshed the maximum number of times today, and work only with the returned places. "out_of_scope": decline as above.
- You may refine and re-search within a small per-turn budget. If told the budget is used up, answer with what you already have.
- When proposing an add_stop for a place that came from a search result, include that place's placeId in the operation so Trippy attaches the verified place details.

## Trip-health audits
- When the traveller asks you to audit the trip, find gaps, or check for contradictions, call check_trip_health (optionally with a dayId to scope it to one day) rather than trying to spot these patterns yourself by reading the itinerary JSON — it runs deterministic checks you cannot replicate by eye.
- Explain findings in warm, plain language, leading with warning-level findings over info-level ones. A result with no findings means the trip is clean — say so plainly, do not invent additional concerns.
- Where a finding is fixable on a non-booking stop (retiming, moving, or removing it), offer to fix it through propose_itinerary_changes as usual. Never propose changes to a booking-linked stop or its time — for any finding about one, tell the traveller to manage it in Logistics.`;

  let fullText = '';
  let streamDone = false;
  let aborted = false;
  let currentStream = null;
  const turnStart = Date.now();

  // Abort Anthropic stream when the client drops the SSE connection.
  // Must listen on res, not req — req.close fires when the request body is consumed
  // (immediately after flushHeaders), whereas res.close fires when the response socket closes.
  // Registered once for the whole turn; `currentStream` always points at whichever loop
  // iteration's stream is live.
  res.on('close', () => {
    if (streamDone) return;
    // Always record the drop, even between iterations (currentStream is null while a query
    // tool executor runs) — the loop checks `aborted` before opening the next stream.
    aborted = true;
    if (currentStream) {
      console.log('[copilot] client dropped SSE connection — aborting stream');
      currentStream.abort();
    }
  });

  let messages = [...conversationMessages];
  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let executedQueryCalls = 0;
  let capNoticeSent = false;
  let sawFirstDelta = false;
  let ttfdMs = null;
  let iterations = 0;
  let terminalUse = null; // the propose_itinerary_changes tool_use that ended tool execution, if any
  let explainStep = false; // true for the single post-proposal iteration (D-30-9)
  // D-30-9: on a direct edit the model calls the propose tool at once and the explanation follows
  // seconds later, so the proposal reports as a tool like the query tools do. 'started' goes out
  // when the tool_use block opens (its operations then stream for a while), or at the latest when
  // the response carrying it ends; 'done' on the explain step's first text delta, or when the turn
  // leaves the loop without one (no text, or a cut before the explain step). At most once per turn.
  let proposeActivityOpen = false;
  let proposeActivityReported = false;
  const startProposeActivity = () => {
    if (proposeActivityReported) return;
    proposeActivityReported = true;
    proposeActivityOpen = true;
    write({ type: 'tool', tool: PROPOSE_ITINERARY_CHANGES_TOOL.name, state: 'started' });
  };
  const endProposeActivity = () => {
    if (!proposeActivityOpen) return;
    proposeActivityOpen = false;
    write({ type: 'tool', tool: PROPOSE_ITINERARY_CHANGES_TOOL.name, state: 'done' });
  };
  let truncated = false;
  let refused = false;
  let lastStopReason = null;

  const addUsage = (usage) => {
    totalUsage.input_tokens += usage?.input_tokens ?? 0;
    totalUsage.output_tokens += usage?.output_tokens ?? 0;
    totalUsage.cache_creation_input_tokens += usage?.cache_creation_input_tokens ?? 0;
    totalUsage.cache_read_input_tokens += usage?.cache_read_input_tokens ?? 0;
  };

  // Exactly one reportTurnMetrics per turn, whichever exit path gets there first.
  let metricsReported = false;
  const recordMetrics = async ({ stopReason, proposalOps, error }) => {
    if (!reportTurnMetrics || metricsReported) return;
    metricsReported = true;
    try {
      await reportTurnMetrics({
        model: profile.model,
        inputTokens: totalUsage.input_tokens,
        outputTokens: totalUsage.output_tokens,
        cacheWriteTokens: totalUsage.cache_creation_input_tokens,
        cacheReadTokens: totalUsage.cache_read_input_tokens,
        ttfdMs,
        totalMs: Date.now() - turnStart,
        iterations,
        queryCalls: executedQueryCalls,
        stopReason,
        proposalOps,
        error,
      });
    } catch (err) {
      console.error('[copilot] reportTurnMetrics failed:', err);
    }
  };

  // D-30-8 (Plan 30): every turn ends in exactly one persisted assistant row, so the question the
  // route already saved is never left without an answer. The flag keeps a late throw in the
  // success path's tail from writing a second row via the error path.
  let turnPersisted = false;
  const persistEndedTurn = async (turn) => {
    if (!persistTurn || turnPersisted) return null;
    turnPersisted = true;
    try {
      return (await persistTurn({ assistantText: fullText, ...turn })) || null;
    } catch (err) {
      console.error('[copilot] persistTurn failed:', err);
      return null;
    }
  };

  // A client that drops mid-turn is not an error (D-30-4): record the tokens already spent under
  // stop_reason 'client_abort' with error = 0 (stop_reason is free text, so no migration), log one
  // plain line, and write nothing more to a dead socket. The aborted iteration's partial usage is
  // folded in by the caller before this runs. The partial text is saved as a 'stopped' row, never
  // with operations (D-30-8) — the DB write is not socket I/O, so a dead socket does not skip it.
  const recordClientAbort = async () => {
    streamDone = true;
    await persistEndedTurn({ operations: null, notice: 'stopped' });
    console.log('[copilot] client aborted turn iterations=%d input=%d output=%d',
      iterations, totalUsage.input_tokens, totalUsage.output_tokens);
    await recordMetrics({ stopReason: 'client_abort', proposalOps: 0, error: 0 });
  };

  // Keep-alive for the whole turn (D-30-4). unref'd so it never holds a process or a test open;
  // the finally below clears it on every exit path, including each early return on abort.
  const pingTimer = setInterval(() => write({ type: 'ping' }), COPILOT_PING_INTERVAL_MS);
  pingTimer.unref();

  try {
    console.log('[copilot] stream opened messages=%d', conversationMessages.length);

    while (true) {
      // Client dropped while a tool executor was running — don't open another stream
      // against a dead connection.
      if (aborted) {
        await recordClientAbort();
        return fullText;
      }
      iterations += 1;

      const stream = client.messages.stream({
        ...requestSettings(profile),
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
        // The tools list never changes between iterations (prompt cache, preserved thinking);
        // the explain step only forbids calling any of them. Every other iteration sends no
        // tool_choice key at all.
        tools: [PROPOSE_ITINERARY_CHANGES_TOOL, SEARCH_DISCOVERY_CATALOGUE_TOOL, CHECK_TRIP_HEALTH_TOOL],
        ...(explainStep ? { tool_choice: { type: 'none' } } : {}),
      });
      currentStream = stream;
      stream.on('streamEvent', (event) => {
        if (!explainStep && event.type === 'content_block_start'
          && event.content_block?.type === 'tool_use'
          && event.content_block.name === PROPOSE_ITINERARY_CHANGES_TOOL.name) {
          startProposeActivity();
        }
      });

      stream.on('text', (text) => {
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          ttfdMs = Date.now() - turnStart;
          console.log('[copilot] first text delta len=%d ttfd=%dms', text.length, ttfdMs);
        }
        if (explainStep) endProposeActivity();
        fullText += text;
        write({ type: 'text', content: text });
      });

      const finalMessage = await stream.finalMessage();
      currentStream = null;

      // The client dropped the connection but the SDK resolved anyway (abort() is
      // best-effort) — end quietly: no proposal/done writes (write() is already a no-op on a
      // destroyed res) and no proposal even if the reply completed, but the partial text is still
      // saved as a 'stopped' row (D-30-8) and the spent tokens still count.
      addUsage(finalMessage?.usage);
      if (aborted) {
        await recordClientAbort();
        return fullText;
      }

      // D-30-3: classify before trusting the content. A cut (max_tokens, or the context window —
      // adaptive thinking spends output budget before any text) can land mid-prose or mid-tool_use,
      // and a refusal carries no usable answer. Either way end the turn now, before the
      // terminal-tool check below, so a partially-parsed propose_itinerary_changes block never
      // becomes terminalUse and never becomes a proposal (D5 — surfaced honestly, never silently
      // re-run or discarded). On the explain step (D-30-9) the proposal's operations already
      // arrived complete in the previous response, so a cut there still emits the proposal and
      // only adds the notice.
      const stop = classifyStop(finalMessage);
      lastStopReason = stop.stopReason;
      if (stop.outcome === 'truncated') {
        truncated = true;
        break;
      }
      if (stop.outcome === 'refused') {
        console.warn('[copilot] model refused turn category=%s', stop.category);
        refused = true;
        break;
      }

      // D-30-9 (Plan 30 W5): the explain step is the last iteration of the turn. Nothing in it is
      // ever executed, and terminalUse (set by the previous iteration) is never overwritten.
      if (explainStep) break;

      // Native tool-use is the ONLY action channel (Plan 11 Wave 1). Prose already streamed
      // above via on('text'); tool_use blocks are assembled on a separate channel, so reading
      // them here does not delay prose.
      const content = finalMessage?.content ?? [];
      const foundTerminalUse = content.find(
        (block) => block.type === 'tool_use' && block.name === PROPOSE_ITINERARY_CHANGES_TOOL.name,
      );
      const queryUses = content.filter(
        (block) => block.type === 'tool_use' && QUERY_TOOL_NAMES.has(block.name),
      );

      // Terminal wins (Plan 11 Wave 1): a propose_itinerary_changes call ends tool execution even
      // if the same response also contains query tool_use blocks — those are ignored outright (no
      // execution, no SSE) rather than left dangling with no way to answer them.
      //
      // D-30-9 (Plan 30 W5): amends the Plan 11 Wave 1 terminal-tool rule. propose_itinerary_changes
      // still ends tool execution and is still the only action channel, but it no longer ends the
      // turn: one acknowledgement tool_result plus one tool_choice 'none' explain step follow,
      // because on Sonnet 5.5 a pre-tool explanation comes back as an empty progress-update
      // thinking block (F-30-9, measured 4/10 in W5). The assistant content is replayed unchanged
      // (thinking blocks included) and the acknowledgement promises nothing about validity or
      // persistence — the server has not validated the operations yet.
      if (foundTerminalUse) {
        terminalUse = foundTerminalUse;
        const operationCount = Array.isArray(terminalUse.input?.operations) ? terminalUse.input.operations.length : 0;
        messages = [
          ...messages,
          { role: 'assistant', content },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: terminalUse.id,
              content: JSON.stringify({ status: 'received', operationCount }),
            }],
          },
        ];
        explainStep = true;
        startProposeActivity();
        continue;
      }

      if (queryUses.length === 0) {
        // Plain end_turn — nothing to execute, nothing to propose.
        break;
      }

      const capNoticeSentBefore = capNoticeSent;
      const toolResults = [];
      let allOverCap = true;

      for (const use of queryUses) {
        if (executedQueryCalls < QUERY_TOOL_CAP) {
          allOverCap = false;
          executedQueryCalls += 1;
          write({ type: 'tool', tool: use.name, state: 'started' });

          let result;
          const executor = toolExecutors[use.name];
          if (!executor) {
            result = { error: `no executor registered for ${use.name}` };
          } else {
            try {
              result = await executor(use.input);
            } catch (err) {
              console.error('[copilot] tool executor failed:', use.name, err);
              result = { error: err.message };
            }
          }

          write({ type: 'tool', tool: use.name, state: 'done' });
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
        } else {
          capNoticeSent = true;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'Query tool budget for this turn is used up. Answer the traveller now with the information you already have.',
          });
        }
      }

      // Hard stop: the model ignored a budget notice from a previous iteration and called
      // query tools again with nothing but over-cap calls to show for it. Without this, a
      // misbehaving model could loop forever re-requesting a budget it will never get. Every
      // OTHER over-cap case still gets pushed back with the notice for one more chance.
      if (allOverCap && capNoticeSentBefore) {
        break;
      }

      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: toolResults }];
    }

    endProposeActivity();

    if (truncated) {
      write({ type: 'notice', notice: 'truncated' });
    } else if (refused) {
      write({ type: 'notice', notice: 'refused' });
    }

    // Wave 2: the route's persistTurn callback saves the assistant message and (when
    // operations are present) creates the validated proposal record, returning the enriched
    // { proposalId, operations, warnings } payload we emit.
    const operations = (terminalUse && Array.isArray(terminalUse.input?.operations) && terminalUse.input.operations.length > 0)
      ? terminalUse.input.operations
      : null;

    let proposalPayload = null;
    if (persistTurn) {
      // persistTurn always runs (it also saves the assistant message); it returns the
      // proposal SSE payload only when a proposal was created, else null. The stored notice is
      // decided from this pre-persist state; the SSE 'empty' notice below keys off proposalPayload
      // instead, so D-30-4 (a turn is never silent) is untouched.
      let notice = null;
      if (truncated) notice = 'truncated';
      else if (refused) notice = 'refused';
      else if (!fullText && !operations) notice = 'empty';
      proposalPayload = await persistEndedTurn({ operations, notice });
    } else if (operations) {
      // No route callback (unit tests): fall back to the Wave 1 operations-only event.
      proposalPayload = { operations };
    }
    if (proposalPayload) {
      write({ type: 'proposal', ...proposalPayload });
    }

    // D-30-4: a turn is never silent. One that produced neither text nor a proposal (a
    // thinking-only reply) gets an 'empty' notice; truncated and refused turns already carry
    // theirs, so at most one notice goes out per turn.
    if (!truncated && !refused && !fullText && !proposalPayload) {
      write({ type: 'notice', notice: 'empty' });
    }

    console.log('[copilot] turn usage input=%d output=%d contextChars=%d proposal=%s iterations=%d queryCalls=%d stopReason=%s',
      totalUsage.input_tokens, totalUsage.output_tokens,
      JSON.stringify(itineraryContext).length, terminalUse ? 'yes' : 'no', iterations, executedQueryCalls, lastStopReason);

    await recordMetrics({
      stopReason: lastStopReason,
      proposalOps: operations ? operations.length : 0,
      error: 0,
    });

    streamDone = true;
    console.log('[copilot] stream done fullText.length=%d', fullText.length);
    write({ type: 'done' });
    res.end();
  } catch (err) {
    streamDone = true;
    if (aborted) {
      // With the real SDK a client abort makes finalMessage() REJECT (APIUserAbortError), so a
      // dropped connection lands here — it is not an error. The SDK keeps a snapshot of the
      // message being streamed (MessageStream.currentMessage): input and cache tokens come from
      // its message_start, output_tokens only as far as the stream had reported when it was cut.
      // Nothing is estimated beyond that. currentStream is still set here because it is only
      // cleared after a finalMessage() that resolved (whose usage addUsage has then counted).
      addUsage(currentStream?.currentMessage?.usage);
      await recordClientAbort();
      return fullText;
    }
    console.error('[copilot] stream error:', err);
    // D-30-8 (Plan 30): the partial reply is kept, labelled 'interrupted', and never a proposal.
    await persistEndedTurn({ operations: null, notice: 'interrupted' });
    write({ type: 'error', message: err.message });
    await recordMetrics({ stopReason: lastStopReason, proposalOps: 0, error: 1 });
    write({ type: 'done' });
    res.end();
  } finally {
    clearInterval(pingTimer);
  }

  return fullText;
}
