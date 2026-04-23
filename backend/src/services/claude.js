import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

const DISCOVERY_SCHEMA = `{
  "culture": [...],
  "food": [...],
  "nature": [...],
  "nightlife": [...],
  "hidden_gems": [...]
}
Each item: { "name": string, "description": string, "whyItMatches": string, "estimatedDuration": string, "openingHours": string, "lat": number|null, "lng": number|null }`;

export async function discoverDestination(destination, interestTags, pace, travellers) {
  const client = getClient();
  const systemPrompt = `You are a travel discovery assistant. Return ONLY valid JSON (no markdown, no explanation outside JSON) in this exact structure:
${DISCOVERY_SCHEMA}
Focus on: ${destination}. Traveller profile: ${travellers} people, pace: ${pace}, interests: ${interestTags.join(', ')}.`;

  const userMessage = `Discover top attractions and experiences in ${destination}.`;

  // Attempt with web_search tool first
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock ? textBlock.text : '';

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Discovery response was not valid JSON'), { status: 502 });
    }

    return { results: parsed, source: 'web' };
  } catch (err) {
    // If the error is our own 502, propagate it — don't retry
    if (err.status === 502) throw err;

    // Tool not available or not enabled — retry without tools
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock ? textBlock.text : '';

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Discovery response was not valid JSON'), { status: 502 });
    }

    return { results: parsed, source: 'ai' };
  }
}

export async function streamCopilotResponse(conversationMessages, itineraryContext, res) {
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

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: conversationMessages,
    });

    stream.on('text', (text) => {
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

    write({ type: 'done' });
    res.end();
  } catch (err) {
    write({ type: 'error', message: err.message });
    res.end();
  }

  return fullText;
}
