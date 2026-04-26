import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

export const DISCOVERY_CATEGORIES = ['essentials', 'culture', 'food', 'nature', 'nightlife', 'hidden_gems', 'architecture', 'wellness'];

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
