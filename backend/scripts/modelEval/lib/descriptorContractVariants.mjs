// Plan 34 W3 (§4.2 last bullet, §5.1 "Photo query pair") — descriptor contract variants, measured in the
// harness only.
//
// 'broad-query' asks the photo descriptor for a third field, `broadQuery`: a broader 2 to 4 word search that
// would still show this kind of place if the specific one finds nothing. It is adopted into claude.js only if
// photoQueryReplay.mjs measures that it beats D-31-1's prefix retry (selectPhoto), so until then it exists only
// on the wire of a harness run.
//
// installDescriptorContractVariant() wraps the SDK's Messages.prototype.create AFTER installRecorder(), so:
//   - the recorder sees, and the run file stores, the patched request (system line + schema carrying
//     broadQuery) and the RAW response, broadQuery included;
//   - the real generatePhotoDescriptor() then validates a response with `broadQuery` removed, because the live
//     schema is additionalProperties:false and the live service must stay unchanged. The harness reads
//     broadQuery back from the recorded raw response (rawBroadQuery).
// A request whose system prompt or schema is not exactly the live PHOTO_DESCRIPTOR_SYSTEM /
// PHOTO_DESCRIPTOR_OUTPUT_SCHEMA fails loudly: a silent no-op patch would measure the live contract under a
// variant's name.

import Anthropic from '@anthropic-ai/sdk';
import { PHOTO_DESCRIPTOR_SYSTEM, PHOTO_DESCRIPTOR_OUTPUT_SCHEMA } from '../../../src/services/claude.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const SCENE_TYPE_LINE_PREFIX = '- sceneType:';

const BROAD_QUERY_LINE =
  '- broadQuery: a broader 2 to 4 word English search that would still show this kind of place if the specific search finds nothing ' +
  '(for a ramen counter, "Tokyo ramen bowl"; for a lighthouse, "rocky coast lighthouse").';

// Built from the live constant so the sceneType enum has one source and a change to the live schema shows up here.
function buildBroadQuerySchema() {
  const base = structuredClone(PHOTO_DESCRIPTOR_OUTPUT_SCHEMA);
  if (JSON.stringify(base.required) !== JSON.stringify(['photoQuery', 'sceneType'])) {
    throw new Error(`the live descriptor schema's required list changed (${JSON.stringify(base.required)}); update descriptorContractVariants.mjs before measuring`);
  }
  return deepFreeze({
    ...base,
    required: [...base.required, 'broadQuery'],
    properties: {
      ...base.properties,
      broadQuery: {
        type: 'string',
        description: 'A broader 2 to 4 word English search that would still show this kind of place if the specific search finds nothing.',
      },
    },
  });
}

export const BROAD_QUERY_SCHEMA = buildBroadQuerySchema();

export const DESCRIPTOR_CONTRACT_VARIANTS = Object.freeze(['broad-query']);

export function applyBroadQuerySystem(system) {
  if (system !== PHOTO_DESCRIPTOR_SYSTEM) {
    throw new Error("descriptor contract variant \"broad-query\": the request's system prompt is not the live PHOTO_DESCRIPTOR_SYSTEM, so the variant would not measure what it names");
  }
  const lines = system.split('\n');
  const anchors = lines.flatMap((line, i) => (line.startsWith(SCENE_TYPE_LINE_PREFIX) ? [i] : []));
  if (anchors.length !== 1) {
    throw new Error(`descriptor contract variant "broad-query": expected exactly one line starting with "${SCENE_TYPE_LINE_PREFIX}" in PHOTO_DESCRIPTOR_SYSTEM, found ${anchors.length}`);
  }
  lines.splice(anchors[0], 0, BROAD_QUERY_LINE);
  return lines.join('\n');
}

export function applyBroadQueryOutputConfig(body) {
  if (body.output_config?.format?.schema !== PHOTO_DESCRIPTOR_OUTPUT_SCHEMA) {
    throw new Error("descriptor contract variant \"broad-query\": the request's output_config.format.schema is not the live PHOTO_DESCRIPTOR_OUTPUT_SCHEMA, so the variant would not measure what it names");
  }
  return { ...body.output_config, format: { type: 'json_schema', schema: BROAD_QUERY_SCHEMA } };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A new message whose single text block no longer carries broadQuery, so the live validator accepts it.
// Anything that is not a clean end_turn answer with one JSON text block holding a broadQuery key is returned
// untouched: the service then rejects it and logs why, and that rejection is data.
export function withoutBroadQuery(message) {
  if (message?.stop_reason !== 'end_turn' || !Array.isArray(message.content)) return message;
  const textIndexes = message.content.flatMap((block, i) => (block?.type === 'text' ? [i] : []));
  if (textIndexes.length !== 1) return message;
  const index = textIndexes[0];
  let parsed;
  try {
    parsed = JSON.parse(message.content[index].text);
  } catch {
    return message;
  }
  if (!isPlainObject(parsed) || !('broadQuery' in parsed)) return message;
  const { broadQuery, ...rest } = parsed;
  return {
    ...message,
    content: message.content.map((block, i) => (i === index ? { ...block, text: JSON.stringify(rest) } : block)),
  };
}

let installedVariant = null;

// Process-wide: descriptor.mjs makes only descriptor calls, and runs one profile per process. Must run after
// installRecorder().
export function installDescriptorContractVariant(variantName) {
  if (!DESCRIPTOR_CONTRACT_VARIANTS.includes(variantName)) {
    throw new Error(`unknown descriptor contract variant "${variantName}" (expected one of ${DESCRIPTOR_CONTRACT_VARIANTS.join(', ')})`);
  }
  if (installedVariant) throw new Error(`a descriptor contract variant ("${installedVariant}") is already installed in this process`);
  installedVariant = variantName;

  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'variant-probe' }).messages);
  const recordedCreate = proto.create;
  // The recorder's wrapper returns the SDK's APIPromise; this returns a plain Promise, which is enough because
  // generatePhotoDescriptor() only awaits the result.
  proto.create = async function variantCreate(body, options) {
    const patched = {
      ...body,
      system: applyBroadQuerySystem(body.system),
      output_config: applyBroadQueryOutputConfig(body),
    };
    const message = await recordedCreate.call(this, patched, options);
    return withoutBroadQuery(message);
  };
}

// broadQuery from the LAST recorded call's raw response (one text block of JSON), or null.
export function rawBroadQuery(record) {
  const blocks = record.calls?.at(-1)?.response?.content ?? [];
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string');
  if (texts.length !== 1) return null;
  let parsed;
  try {
    parsed = JSON.parse(texts[0].text);
  } catch {
    return null;
  }
  return isPlainObject(parsed) && typeof parsed.broadQuery === 'string' ? parsed.broadQuery : null;
}
