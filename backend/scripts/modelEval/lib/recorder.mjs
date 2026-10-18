// Records every Anthropic Messages API call a service makes, without touching the service.
//
// installRecorder() wraps the SDK's Messages.prototype.create / .stream once per process. Calls
// made inside recordFixture(fn) are attached to that fixture through AsyncLocalStorage; calls made
// outside any fixture pass through unrecorded. Production code never loads this module.
//
// What is captured per call: the request body (base64 payloads always replaced by length + hash;
// text content too when the fixture is private), the response's id/model/stop_reason/usage/content,
// and for streams the raw message_delta (SDK 0.91.1's finalMessage() drops stop_details — F-30-5 —
// but the wire event still carries it), time to first stream event, time to first text delta, and
// the order and timing of content blocks (thinking / text / tool_use) as they started.

import Anthropic from '@anthropic-ai/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const als = new AsyncLocalStorage();
let installed = false;

const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function redactedString(s) {
  return { redacted: true, length: s.length, sha256: sha256(s) };
}

function snapshotContentBlock(block, redactText) {
  if (!block || typeof block !== 'object') return block;
  if ((block.type === 'image' || block.type === 'document') && block.source?.type === 'base64') {
    return {
      ...block,
      source: { ...block.source, data: { redacted: 'base64', length: block.source.data.length, sha256: sha256(block.source.data) } },
    };
  }
  if (redactText && block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: redactedString(block.text) };
  }
  return block;
}

function snapshotBody(body, redactText) {
  const clone = structuredClone(body);
  clone.messages = (clone.messages || []).map((m) => ({
    ...m,
    content: Array.isArray(m.content)
      ? m.content.map((b) => snapshotContentBlock(b, redactText))
      : (redactText && typeof m.content === 'string' ? redactedString(m.content) : m.content),
  }));
  return clone;
}

function snapshotResponseContent(content, redactText) {
  return (content || []).map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: redactText ? redactedString(block.text) : block.text };
    }
    if (block.type === 'thinking') {
      return { type: 'thinking', thinking: block.thinking ?? '', signatureLength: block.signature?.length ?? 0 };
    }
    if (block.type === 'redacted_thinking') {
      return { type: 'redacted_thinking', dataLength: block.data?.length ?? 0 };
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    }
    return { type: block.type };
  });
}

function snapshotMessage(msg, redactText) {
  return {
    id: msg?.id ?? null,
    model: msg?.model ?? null,
    stop_reason: msg?.stop_reason ?? null,
    stop_details: msg?.stop_details ?? null,
    usage: msg?.usage ?? null,
    content: snapshotResponseContent(msg?.content, redactText),
  };
}

function snapshotError(err) {
  return { message: err?.message ?? String(err), status: err?.status ?? null, name: err?.name ?? null };
}

export function installRecorder() {
  if (installed) return;
  installed = true;

  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'recorder-probe' }).messages);
  const originalCreate = proto.create;
  const originalStream = proto.stream;

  proto.create = function recordedCreate(body, options) {
    const store = als.getStore();
    const promise = originalCreate.call(this, body, options);
    if (!store || body?.stream) return promise;

    const startedAt = Date.now();
    const call = { kind: 'create', request: snapshotBody(body, store.redactText), startedAtMs: startedAt - store.startedAt };
    store.calls.push(call);
    promise.then(
      (msg) => { call.wallMs = Date.now() - startedAt; call.response = snapshotMessage(msg, store.redactText); },
      (err) => { call.wallMs = Date.now() - startedAt; call.error = snapshotError(err); },
    );
    return promise;
  };

  proto.stream = function recordedStream(body, options) {
    const store = als.getStore();
    const stream = originalStream.call(this, body, options);
    if (!store) return stream;

    const startedAt = Date.now();
    const call = {
      kind: 'stream',
      request: snapshotBody(body, store.redactText),
      startedAtMs: startedAt - store.startedAt,
      firstEventMs: null,
      firstTextMs: null,
      blockTimeline: [],
      messageDelta: null,
    };
    store.calls.push(call);

    stream.on('streamEvent', (event) => {
      const t = Date.now() - startedAt;
      if (call.firstEventMs === null) call.firstEventMs = t;
      if (event.type === 'content_block_start') {
        call.blockTimeline.push({ index: event.index, type: event.content_block?.type, name: event.content_block?.name, t });
      } else if (event.type === 'message_delta') {
        call.messageDelta = event.delta ?? null;
      }
    });
    stream.on('text', () => {
      if (call.firstTextMs === null) call.firstTextMs = Date.now() - startedAt;
    });

    call.done = stream.finalMessage().then(
      (msg) => {
        call.wallMs = Date.now() - startedAt;
        call.response = snapshotMessage(msg, store.redactText);
        if (!call.response.stop_details && call.messageDelta?.stop_details) {
          call.response.stop_details = call.messageDelta.stop_details;
        }
      },
      (err) => { call.wallMs = Date.now() - startedAt; call.error = snapshotError(err); },
    );
    return stream;
  };
}

// Runs fn inside a recording scope. Returns { result, error, calls, wallMs } — never throws for a
// service failure (that is data); rethrows only if the recorder itself was never installed.
export async function recordFixture(fn, { redactText = false } = {}) {
  if (!installed) throw new Error('installRecorder() must run before recordFixture()');
  const store = { calls: [], redactText, startedAt: Date.now() };
  let result = null;
  let error = null;
  try {
    result = await als.run(store, fn);
  } catch (err) {
    error = { ...snapshotError(err), raw: typeof err?.raw === 'string' ? (redactText ? redactedString(err.raw) : err.raw) : undefined };
  }
  // A stream's finalMessage bookkeeping may settle a tick after the service returned.
  await Promise.all(store.calls.map((c) => c.done).filter(Boolean));
  const calls = store.calls.map(({ done, ...rest }) => rest);
  return { result, error, calls, wallMs: Date.now() - store.startedAt };
}
