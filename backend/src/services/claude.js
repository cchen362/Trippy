import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

const DISCOVERY_KEYS = ['culture', 'food', 'nature', 'nightlife', 'hidden_gems'];

const DISCOVERY_SCHEMA = `{
  "culture": [...],
  "food": [...],
  "nature": [...],
  "nightlife": [...],
  "hidden_gems": [...]
}
Each item: { "name": string, "description": string, "whyItMatches": string, "estimatedDuration": string, "openingHours": string, "lat": number|null, "lng": number|null }`;

export async function discoverDestination(destination, interestTags, pace, travellers) {
  console.log('[discover] destination=%s tags=%o', destination, interestTags);

  const client = getClient();
  const systemPrompt = `You are a travel discovery assistant. Return ONLY a JSON object. No prose, no markdown fences, no commentary. The response must start with { and end with }.

The JSON must have exactly this structure:
${DISCOVERY_SCHEMA}

Focus on: ${destination}. Traveller profile: ${travellers} people, pace: ${pace}, interests: ${interestTags.join(', ')}.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Discover top attractions and experiences in ${destination}.` }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw Object.assign(new Error('Discovery returned no text block'), { status: 502 });
  }

  console.log('[discover] raw response (first 500 chars):', textBlock.text.slice(0, 500));

  // Extract JSON: prefer a fenced ```json block, fall back to first { ... } span
  let raw = textBlock.text.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  } else {
    const braceStart = raw.indexOf('{');
    const braceEnd = raw.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      raw = raw.slice(braceStart, braceEnd + 1);
    }
  }

  console.log('[discover] extracted JSON (first 200 chars):', raw.slice(0, 200));

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Discovery response was not valid JSON'), { status: 502 });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('Discovery response shape invalid'), { status: 502 });
  }
  for (const key of DISCOVERY_KEYS) {
    if (!Array.isArray(parsed[key])) {
      throw Object.assign(new Error(`Discovery response missing required key: ${key}`), { status: 502 });
    }
  }

  console.log('[discover] ok keys=%o', Object.keys(parsed));
  return { results: parsed, source: 'ai' };
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
