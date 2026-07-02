import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

export const DISCOVERY_CATEGORIES = ['essentials', 'culture', 'food', 'nature', 'nightlife', 'hidden_gems', 'architecture', 'wellness'];

export const EXTRACTION_MODEL = 'claude-sonnet-4-6';

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
        "city": string | null,
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
      contextBlock += ` Trip destinations: ${tripContext.destinations.join(', ')}.`;
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
function normalizeName(str) {
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

Each item: { "name": string, "description": string (1-2 sentences, specific and factual), "whyItFits": string (one concrete sentence — name atmosphere, crowd level, or specific draw; never generic phrases like "great for couples" or "popular with tourists"), "estimatedDuration": string, "openingHours": string, "lat": number|null, "lng": number|null }

Additional item fields:
- Include "localName": string|null and "aliases": string[] on every item.
- For places whose common indexed/local name is not English, put the traveler-friendly English or romanized name in "name", the local-script/common local name in "localName", and useful alternate spellings/official names in "aliases". Use null/[] when no meaningful local variant exists.

Curation rules:
- Avoid the generic tourist front page. Only include a famous landmark if it is genuinely unmissable AND you can explain a specific, compelling reason to visit beyond its name.
- Prioritise places with authentic local character: neighbourhood favourites, spots that reward insider knowledge, experiences with real depth.
- Each suggestion must earn its place. If you cannot write a specific, non-generic "whyItFits", do not include it.
- Aim for 30 items per category. Fewer sharp picks beats padding with mediocre ones — do not force 30 if the city cannot support it.
- Use the most specific, locally-used name for each place. Do not append generic suffixes unless part of the official name.
- Do not repeat the same place across categories.`;

// Streams discovery results as NDJSON. Calls onCategory({ category, items }) for each
// completed line as Claude generates it. Returns the full accumulated results array for caching.
export async function discoverDestination(destination, existingStopTitles = [], onCategory) {
  console.log('[discover] destination=%s existingStops=%d', destination, existingStopTitles.length);

  const client = getClient();

  const existingLine = existingStopTitles.length > 0
    ? `\nAlready in itinerary — do not suggest these or close variants:\n${existingStopTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  const systemPrompt = existingLine ? `${DISCOVER_SYSTEM}${existingLine}` : DISCOVER_SYSTEM;

  const stream = client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Curate the best of ${destination}. Include neighbourhood gems alongside the genuinely unmissable. Be specific, be honest about crowds and tourist traps.`,
    }],
  });

  const accumulated = [];
  const seen = new Set();
  let buffer = '';

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!obj.category || !Array.isArray(obj.items)) return;

    // Deduplicate items by normalized name across all categories
    const deduped = obj.items.filter((item) => {
      if (!item?.name) return false;
      const n = normalizeName(item.name);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });

    const categoryObj = { category: obj.category, items: deduped };
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

  console.log('[discover] ok categories=%o', accumulated.map((c) => c.category));
  return accumulated;
}

export async function streamCopilotResponse(conversationMessages, itineraryContext, res, req) {
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

  const systemPrompt = `You are a travel co-pilot helping manage a trip itinerary.

Current itinerary:
${JSON.stringify(itineraryContext, null, 2)}

Guidelines:
- Respond conversationally and helpfully
- If the user asks you to change the itinerary, first explain your reasoning, then propose changes
- If proposing itinerary changes, end your response with a JSON block in this exact format (use triple backticks with json):
  \`\`\`json
  {
    "operations": [
      { "action": "add_stop", "dayId": "...", "stop": { "title": "...", "type": "experience|transit|hotel|booked", "time": "HH:MM", "note": "...", "lat": null, "lng": null } },
      { "action": "remove_stop", "stopId": "..." },
      { "action": "move_stop", "stopId": "...", "toDayId": "...", "sortOrder": 0 },
      { "action": "update_stop", "stopId": "...", "fields": { ... } }
    ]
  }
  \`\`\`
- Only include operations array items that are actually needed
- Use real dayId and stopId values from the itinerary above
- If not proposing changes, do NOT include the JSON block`;

  let fullText = '';
  let streamDone = false;

  try {
    console.log('[copilot] stream opened messages=%d', conversationMessages.length);

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: conversationMessages,
    });

    // Abort Anthropic stream when the client drops the SSE connection.
    // Must listen on res, not req — req.close fires when the request body is consumed
    // (immediately after flushHeaders), whereas res.close fires when the response socket closes.
    res.on('close', () => {
      if (!streamDone) {
        console.log('[copilot] client dropped SSE connection — aborting stream');
        stream.abort();
      }
    });

    let sawFirstDelta = false;
    stream.on('text', (text) => {
      if (!sawFirstDelta) {
        sawFirstDelta = true;
        console.log('[copilot] first text delta len=%d', text.length);
      }
      fullText += text;
      write({ type: 'text', content: text });
    });

    await stream.finalMessage();

    // Extract mutation JSON block — take the LAST fenced JSON block in case Claude
    // includes illustrative examples earlier in the response
    const mutationMatches = [...fullText.matchAll(/```json\r?\n([\s\S]*?)\r?\n?```/g)];
    const lastMatch = mutationMatches.at(-1);
    if (lastMatch) {
      try {
        const parsedMutation = JSON.parse(lastMatch[1]);
        write({ type: 'mutation', mutation: parsedMutation });
      } catch (e) {
        console.error('[copilot] malformed mutation JSON block — skipping:', e.message);
      }
    }

    streamDone = true;
    console.log('[copilot] stream done fullText.length=%d', fullText.length);
    write({ type: 'done' });
    res.end();
  } catch (err) {
    streamDone = true;
    console.error('[copilot] stream error:', err);
    write({ type: 'error', message: err.message });
    res.end();
  }

  return fullText;
}
