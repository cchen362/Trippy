import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { PROPOSE_ITINERARY_CHANGES_TOOL, SEARCH_DISCOVERY_CATALOGUE_TOOL, CHECK_TRIP_HEALTH_TOOL } from './copilotTools.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

export const DISCOVERY_CATEGORIES = ['essentials', 'culture', 'food', 'nature', 'nightlife', 'hidden_gems', 'architecture', 'wellness'];

export const EXTRACTION_MODEL = 'claude-sonnet-4-6';

export const PHOTO_DESCRIPTOR_MODEL = 'claude-haiku-4-5-20251001';

export const COPILOT_MODEL = 'claude-sonnet-4-6';

export const DISCOVERY_MODEL = 'claude-haiku-4-5-20251001';

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
export function coerceSceneType(value) {
  return SCENE_TYPES.includes(value) ? value : null;
}

const EXTRACTION_SYSTEM = `You are a travel-booking extraction engine. You receive raw content (pasted text, email text, screenshots, or PDFs of travel confirmations) and must extract every distinct booking as structured JSON.

Output ONLY a single fenced JSON code block (\`\`\`json fence). No prose before or after it.

Output shape:
{
  "isTravelRelated": boolean,
  "summary": "one-line human summary of what was found",
  "language": "ISO 639-1 code of the input's primary language, e.g. \\"en\\", \\"zh\\"",
  "bookings": [
    {
      "type": "flight" | "train" | "bus" | "ferry" | "hotel" | "other",
      "title": "short human title, e.g. flight/train number or hotel name",
      "confirmationRef": string | null,
      "bookingSource": string | null,
      "startDatetime": "YYYY-MM-DDTHH:MM" | null,
      "endDatetime": "YYYY-MM-DDTHH:MM" | null,
      "origin": string | null,
      "destination": string | null,
      "terminalOrStation": string | null,
      "originTz": "IANA timezone" | null,
      "destinationTz": "IANA timezone" | null,
      "details": {
        "originCity": string | null, "destinationCity": string | null,
        "originCountryCode": "ISO 3166-1 alpha-2" | null, "destinationCountryCode": string | null,
        "city": string | null, "countryCode": "ISO 3166-1 alpha-2" | null,
        "carrierCode": string | null, "flightNumber": string | null, "airlineName": string | null,
        "trainNumber": string | null, "originStation": string | null, "destinationStation": string | null,
        "seatClass": string | null, "address": string | null, "localName": string | null, "note": string | null
      },
      "confidence": { "overall": "high"|"medium"|"low", "fields": { "fieldName": "high"|"medium"|"low" } },
      "assumptions": ["short strings describing any inference you made"]
    }
  ]
}

Rules:
1. Extract every distinct booking present in the input — a single email or screenshot may contain more than one (e.g. outbound + return flight, or multiple train legs).
2. NEVER invent a value. If you cannot read or infer a field with reasonable confidence, set it to null and lower that field's confidence entry instead of guessing.
3. Date inference: today's date and (if provided) the trip's destination and date range are injected below as context. Use them to resolve ambiguous or partial dates:
   - If a booking's year is missing, infer it from the trip's date range if the trip context is given; otherwise infer the nearest future occurrence of that month/day relative to today, and record the inference in "assumptions".
   - If a date is ambiguous between DD/MM and MM/DD, prefer the interpretation that falls inside the trip's date range if a trip is given; otherwise pick the more common international DD/MM interpretation and set that field's confidence to "low".
4. Hotel bookings that only specify check-in/check-out dates without times: default startDatetime to T15:00 and endDatetime to T11:00, and add an assumption noting the default check-in/check-out time was applied.
5. Multilingual input: put the English/exonym city name in details.originCity / details.destinationCity / details.city; preserve the original local-script name in details.localName; set the top-level "language" field to the input's primary language code.
5a. Hotel and "other" bookings: set details.countryCode to the ISO 3166-1 alpha-2 code of the country details.city is in, using the same confidence discipline as originCountryCode/destinationCountryCode — null if you cannot infer it with reasonable confidence, never a guess.
6. If the input is not travel-related (or contains no extractable booking), return isTravelRelated:false, bookings:[], and a one-line summary explaining why. Do not fabricate a booking to fill the array.
7. Timezones: emit your best-guess IANA timezone (e.g. "Asia/Shanghai") for originTz/destinationTz. If you are not reasonably confident, use null — do not guess a generic value like "UTC".
8. Ground transfers, car rentals, tour tickets, event tickets, and anything that does not fit flight/train/bus/ferry/hotel should use type "other" with a descriptive title (e.g. "Airport transfer — Chengdu Shuangliu to hotel").
9. Output nothing outside the single fenced JSON block. Do not explain your reasoning in prose.`;

// Extracts structured bookings from pasted text / uploaded images / PDFs via a single
// non-streaming Claude call. files: [{ kind: 'text'|'image'|'pdf', mediaType, content }]
// where content is a UTF-8 string for 'text' and base64 (no data-URI prefix) otherwise.
export async function extractBookings({ files, contextText, tripContext }) {
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

  for (const file of files) {
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
    model: EXTRACTION_MODEL,
    max_tokens: 8192,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content }],
  });

  const inTok = response.usage?.input_tokens ?? 0;
  const outTok = response.usage?.output_tokens ?? 0;
  console.log('[import] extract files=%d in=%d out=%d', files.length, inTok, outTok);

  const fullText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const matches = [...fullText.matchAll(/```json\r?\n([\s\S]*?)\r?\n?```/g)];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    throw Object.assign(new Error('Claude extraction returned no JSON block'), {
      status: 502,
      raw: fullText.slice(0, 2000),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(lastMatch[1]);
  } catch (e) {
    throw Object.assign(new Error(`Claude extraction returned malformed JSON: ${e.message}`), {
      status: 502,
      raw: lastMatch[1].slice(0, 2000),
    });
  }

  if (typeof parsed.isTravelRelated !== 'boolean' || !Array.isArray(parsed.bookings)) {
    throw Object.assign(new Error('Claude extraction JSON missing required fields'), {
      status: 502,
      raw: JSON.stringify(parsed).slice(0, 2000),
    });
  }

  return { extraction: parsed, model: EXTRACTION_MODEL, usage: { input_tokens: inTok, output_tokens: outTok } };
}

// Strips punctuation and common geographic suffixes so "Dujiangyan & Scenic Area"
// and "Dujiangyan Scenic Area" collapse to the same canonical key.
export function normalizeName(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(scenic area|& area|& park|national park|historic district|old town|city centre|city center)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DISCOVER_SYSTEM = `You are a discerning travel curator. Return ONLY newline-delimited JSON — one object per line, one line per category, nothing else. No prose, no markdown fences, no wrapper object.

Each line must match exactly:
{"category":"<name>","items":[...]}

Output all 8 categories in this order:
essentials, culture, food, nature, nightlife, hidden_gems, architecture, wellness

Each item: { "name": string, "description": string (1-2 sentences, specific and factual), "whyItFits": string (one concrete sentence — name atmosphere, crowd level, or specific draw; never generic phrases like "great for couples" or "popular with tourists"; describe the PLACE itself, never the traveller — never write "the traveller", "your group", "your trip", "your preferences", or any other personalization framing, since this text is shown for every trip regardless of who's asking), "estimatedDuration": string, "openingHours": string, "lat": number|null, "lng": number|null }

Additional item fields:
- Include "localName": string|null and "aliases": string[] on every item.
- For places whose common indexed/local name is not English, put the traveler-friendly English or romanized name in "name", the local-script/common local name in "localName", and useful alternate spellings/official names in "aliases". Use null/[] when no meaningful local variant exists.
- Include "photoQuery": a culturally specific English search string for stock-photo search (at most 8 words, referencing the actual place/cuisine/activity — never generic terms like "nice place" or "travel photo").
- Include "sceneType": exactly one of temple_shrine, market, street_neighborhood, nature_outdoors, museum_gallery, landmark_architecture, food_drink, nightlife, beach_water, viewpoint, wellness, hotel_stay, entertainment, generic. Choose the closest match; use "generic" if unsure.

Curation rules:
- Avoid the generic tourist front page. Only include a famous landmark if it is genuinely unmissable AND you can explain a specific, compelling reason to visit beyond its name.
- Prioritise places with authentic local character: neighbourhood favourites, spots that reward insider knowledge, experiences with real depth.
- Each suggestion must earn its place. If you cannot write a specific, non-generic "whyItFits", do not include it.
- Aim for 30 items per category. Fewer sharp picks beats padding with mediocre ones — do not force 30 if the city cannot support it.
- Use the most specific, locally-used name for each place. Do not append generic suffixes unless part of the official name.
- Do not repeat the same place across categories.`;

// Minimum distinct categories (each with at least one item) a generation must
// yield to be considered usable. Below this, the catalogue committed would be
// too thin/skewed to trust (see production incident: a truncated/malformed
// generation stored 10 items in a single category as a fresh 7-day catalogue).
const MIN_CATEGORIES_WITH_ITEMS = 4;

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

// Streams discovery results as NDJSON. Calls onCategory({ category, items }) for each
// completed line as Claude generates it. Returns the full accumulated results array for caching.
export async function discoverDestination(destination, existingStopTitles = [], onCategory) {
  console.log('[discover] destination=%s existingStops=%d', destination, existingStopTitles.length);

  const client = getClient();

  const existingLine = existingStopTitles.length > 0
    ? `\nAlready shown or in itinerary — do not suggest these or close variants:\n${existingStopTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  const systemPrompt = existingLine ? `${DISCOVER_SYSTEM}${existingLine}` : DISCOVER_SYSTEM;

  const stream = client.messages.stream({
    model: DISCOVERY_MODEL,
    // Haiku 4.5's streaming output ceiling. The prompt asks for ~30 items
    // across 8 categories (~40-50k output tokens) — a smaller budget silently
    // truncates the tail of the response, which is why production generations
    // were systematically missing the last 1-2 categories in the prompt's
    // ordering (architecture, wellness).
    max_tokens: 64000,
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

    // Deduplicate items by normalized name across all categories
    const deduped = obj.items.filter((item) => {
      if (!item?.name) return false;
      const n = normalizeName(item.name);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });

    const categoryObj = { category: canonicalCategory, items: deduped };
    accumulated.push(categoryObj);
    if (onCategory) onCategory(categoryObj);
  };

  stream.on('text', (text) => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // last element may be incomplete
    for (const line of lines) processLine(line);
  });

  await stream.finalMessage();
  // Flush any remaining content in buffer
  if (buffer.trim()) processLine(buffer);

  const categoriesWithItems = accumulated.filter((c) => c.items.length > 0).length;
  const totalItems = accumulated.reduce((sum, c) => sum + c.items.length, 0);

  if (categoriesWithItems < MIN_CATEGORIES_WITH_ITEMS) {
    throw new Error(
      `[discover] insufficient yield for destination=${destination}: ` +
      `${categoriesWithItems} of ${accumulated.length} parsed categories had items ` +
      `(${totalItems} items total), ${droppedLineCount} lines dropped as unparseable`,
    );
  }

  console.log('[discover] ok categories=%o', accumulated.map((c) => c.category));
  return accumulated;
}

const PHOTO_DESCRIPTOR_SYSTEM = `You generate a stock-photo search descriptor for a single travel stop. Output ONLY a single fenced JSON code block (\`\`\`json fence), nothing else.

Output shape:
{"photoQuery": string, "sceneType": string}

Rules:
- photoQuery: a culturally specific English search string for stock-photo search, at most 8 words. Reference the actual place, cuisine, or activity — never generic terms like "nice place" or "travel photo".
- sceneType: exactly one of temple_shrine, market, street_neighborhood, nature_outdoors, museum_gallery, landmark_architecture, food_drink, nightlife, beach_water, viewpoint, wellness, hotel_stay, entertainment, generic. Choose the closest match; use "generic" if unsure.
- Output nothing outside the single fenced JSON block.`;

// Single cheap Haiku call generating { photoQuery, sceneType } for a manually-added
// stop that carries no descriptor of its own (D3). Must never block stop creation:
// every failure mode (missing key, network error, malformed output, invalid schema)
// is caught and returns null so the caller falls through to resolvedName+city.
export async function generatePhotoDescriptor({ title, resolvedName, city, country, type }) {
  try {
    const client = getClient();

    const contextParts = [
      resolvedName || title,
      city,
      country,
      type ? `stop type: ${type}` : null,
    ].filter(Boolean);

    const response = await client.messages.create({
      model: PHOTO_DESCRIPTOR_MODEL,
      max_tokens: 256,
      system: PHOTO_DESCRIPTOR_SYSTEM,
      messages: [{ role: 'user', content: contextParts.join(', ') }],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const match = text.match(/```json\r?\n([\s\S]*?)\r?\n?```/);
    if (!match) return null;

    const parsed = JSON.parse(match[1]);
    if (typeof parsed.photoQuery !== 'string' || !parsed.photoQuery.trim()) return null;

    const photoQuery = parsed.photoQuery.trim().split(/\s+/).slice(0, 8).join(' ');
    return { photoQuery, sceneType: coerceSceneType(parsed.sceneType) };
  } catch (err) {
    console.warn('[photo] descriptor generation failed', { title, error: err?.message });
    return null;
  }
}

// Query tool_use names the loop below executes server-side and feeds back as a tool_result —
// never terminal. The loop itself is already generic over this set.
const QUERY_TOOL_NAMES = new Set([SEARCH_DISCOVERY_CATALOGUE_TOOL.name, CHECK_TRIP_HEALTH_TOOL.name]);

// Max EXECUTED query-tool calls per user turn (G2). Once hit, further query tool_use blocks
// are answered with a budget-notice tool_result instead of being executed — the model gets one
// post-cap response to answer with what it already has before the hard stop below kicks in.
const QUERY_TOOL_CAP = 5;

// persistTurn (optional): async callback the route owns. Called once after the model turn
// completes with { assistantText, operations } — where operations is the tool_use payload or
// null. It persists the assistant message + (when operations exist) the proposal record, and
// returns the enriched proposal SSE payload ({ proposalId, operations, warnings, status,
// statusReason }) or null. Keeping persistence in the route (not here) is why claude.js stays
// DB-free; when persistTurn is absent (unit tests) the Wave 1 { operations }-only event is
// emitted so the protocol still round-trips.
//
// toolExecutors (optional, Plan 12 Wave 1): { [toolName]: async (input) => resultObject },
// injected by the route the same way as persistTurn — this file stays DB-free, the route owns
// what a query tool actually does (catalogue reads, trip-health checks, etc).
export async function streamCopilotResponse(conversationMessages, itineraryContext, res, req, persistTurn, toolExecutors = {}) {
  const client = getClient();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const write = (data) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const systemPrompt = `You are a travel co-pilot helping a traveller manage and improve their trip itinerary.

Current itinerary (JSON):
${JSON.stringify(itineraryContext, null, 2)}

## What you can do
- Explain and reason about the trip in warm, concise prose.
- Suggest improvements to a day's flow, density, or order.
- Propose concrete itinerary changes by calling the propose_itinerary_changes tool.

## How to propose changes
- The ONLY way to change the itinerary is to call the propose_itinerary_changes tool. Never write changes as prose, JSON, or code blocks.
- First explain your reasoning in prose, then call the tool with the operations. If you are not proposing changes, do not call the tool.
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
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  let executedQueryCalls = 0;
  let capNoticeSent = false;
  let sawFirstDelta = false;
  let iterations = 0;
  let terminalUse = null; // the propose_itinerary_changes tool_use that ended the turn, if any
  let truncated = false;
  let lastStopReason = null;

  try {
    console.log('[copilot] stream opened messages=%d', conversationMessages.length);

    while (true) {
      // Client dropped while a tool executor was running — don't open another stream
      // against a dead connection.
      if (aborted) {
        streamDone = true;
        return fullText;
      }
      iterations += 1;

      const stream = client.messages.stream({
        model: COPILOT_MODEL,
        max_tokens: 8192,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
        tools: [PROPOSE_ITINERARY_CHANGES_TOOL, SEARCH_DISCOVERY_CATALOGUE_TOOL, CHECK_TRIP_HEALTH_TOOL],
      });
      currentStream = stream;

      stream.on('text', (text) => {
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          console.log('[copilot] first text delta len=%d ttfd=%dms', text.length, Date.now() - turnStart);
        }
        fullText += text;
        write({ type: 'text', content: text });
      });

      const finalMessage = await stream.finalMessage();
      currentStream = null;

      // The client dropped the connection but the SDK resolved anyway (abort() is
      // best-effort) — end quietly, no persistTurn/proposal/done writes (write() is already a
      // no-op on a destroyed res, but skip the DB work too).
      if (aborted) {
        streamDone = true;
        return fullText;
      }

      totalUsage.input_tokens += finalMessage?.usage?.input_tokens ?? 0;
      totalUsage.output_tokens += finalMessage?.usage?.output_tokens ?? 0;
      lastStopReason = finalMessage?.stop_reason ?? null;

      // A max_tokens cut can land mid-prose or mid-tool_use. Either way the response is
      // incomplete: end the turn now, before the terminal-tool check below, so a
      // partially-parsed propose_itinerary_changes block never becomes terminalUse and
      // never becomes a proposal (D5 — surfaced honestly, never silently re-run or discarded).
      if (lastStopReason === 'max_tokens') {
        truncated = true;
        break;
      }

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

      // Terminal wins: a propose_itinerary_changes call ends the turn even if the same
      // response also contains query tool_use blocks — those are ignored outright (no
      // execution, no SSE) rather than left dangling with no way to answer them.
      if (foundTerminalUse) {
        terminalUse = foundTerminalUse;
        break;
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

    if (truncated) {
      write({ type: 'notice', notice: 'truncated' });
    }

    // Wave 2: the route's persistTurn callback saves the assistant message and (when
    // operations are present) creates the validated proposal record, returning the enriched
    // { proposalId, operations, warnings } payload we emit.
    const operations = (terminalUse && Array.isArray(terminalUse.input?.operations) && terminalUse.input.operations.length > 0)
      ? terminalUse.input.operations
      : null;

    let proposalPayload = null;
    if (persistTurn) {
      try {
        // persistTurn always runs (it also saves the assistant message); it returns the
        // proposal SSE payload only when a proposal was created, else null.
        proposalPayload = (await persistTurn({ assistantText: fullText, operations })) || null;
      } catch (err) {
        console.error('[copilot] persistTurn failed:', err);
      }
    } else if (operations) {
      // No route callback (unit tests): fall back to the Wave 1 operations-only event.
      proposalPayload = { operations };
    }
    if (proposalPayload) {
      write({ type: 'proposal', ...proposalPayload });
    }

    console.log('[copilot] turn usage input=%d output=%d contextChars=%d proposal=%s iterations=%d queryCalls=%d stopReason=%s',
      totalUsage.input_tokens, totalUsage.output_tokens,
      JSON.stringify(itineraryContext).length, terminalUse ? 'yes' : 'no', iterations, executedQueryCalls, lastStopReason);

    streamDone = true;
    console.log('[copilot] stream done fullText.length=%d', fullText.length);
    write({ type: 'done' });
    res.end();
  } catch (err) {
    streamDone = true;
    console.error('[copilot] stream error:', err);
    write({ type: 'error', message: err.message });
    write({ type: 'done' });
    res.end();
  }

  return fullText;
}
