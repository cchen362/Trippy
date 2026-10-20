// Plan 37 W0 — the whole-trip readiness check, a GRADING PROTOTYPE.
//
// This is NOT the Phase 2 design. It exists so the owner can grade what a cross-document check would
// say about a real trip (G-37-2 payoff, G-37-3 ledger trust) before Phase 2 is written. Nothing here
// is imported by src/, the output contract is harness-only, and none of it is adopted unless the
// gates pass and a later plan says so. The trip context is the co-pilot's own serialisation
// (copilotTools.js, imported, never copied); the findings are runTripHealthChecks' own.
//
// The model sees short evidence ids it can cite — B1.. bookings, D1.. days, F1.. document facts,
// H1.. health findings — and the harness keeps the id map (`evidence`) so a grading sheet can show
// the owner what each cited id stands for. An id the model cites that does not exist is recorded as
// `unknownEvidence`, never repaired (D-37-4's rule, applied to the prototype).

import { classifyStop, requestSettings, validateAgainstSchema } from '../../../src/services/claude.js';
import { copilotTripContext } from '../../../src/services/copilotTools.js';
import { runTripHealthChecks } from '../../../src/services/tripHealth.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Every property required, no optional properties and no unions (D-34-5), inside
// validateAgainstSchema's keyword set.
export const READINESS_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: { $ref: '#/$defs/item' } },
  },
  $defs: {
    item: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'text', 'evidence', 'severity'],
      properties: {
        kind: { enum: ['holds', 'conflict', 'question'] },
        text: { type: 'string', description: 'One plain English sentence for the traveller.' },
        evidence: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[BDFH][0-9]+$' } },
        severity: { enum: ['high', 'medium', 'low'] },
      },
    },
  },
});
export const READINESS_OUTPUT_FORMAT = Object.freeze({ type: 'json_schema', schema: READINESS_OUTPUT_SCHEMA });

export const READINESS_SYSTEM = `You check a traveller's whole trip across all of its booking documents, and you tell them only what they would want to hear before they go.

The input has labelled sections: "Trip (as the co-pilot sees it)", an "Id map", "Bookings" (ids B1, B2 ...), "Days" (ids D1, D2 ... by date), "Document facts" (ids F1, F2 ... : conditions read from the booking documents, each with the exact quote from its document, the bookings it belongs to, its zone and whether the quote was found in the document's text) and "Health findings" (ids H1, H2 ... : automated checks of the itinerary).

Return a ledger of items. Each item is one of:
- conflict: two sources disagree, or a condition in a document clashes with the itinerary (a date, a time, a name, a count, a place).
- question: the documents leave something open that the traveller must settle before or during the trip.
- holds: a cross-document check that was made and passes, and is worth knowing (for example, the hotel's check-in window covers the time the flight lands).

Rules:
1. Every item cites at least one evidence id in "evidence", and only ids that exist in the input. An item that compares two sources cites both.
2. Cross-source findings only. Never restate a single fact on its own: the traveller's Conditions page already shows each fact.
3. No generic travel advice (visas, insurance, "arrive early", packing).
4. Never estimate how long it takes to get between places, or how far apart they are. Use only times, dates, places and conditions the input states.
5. Never assume a time zone the input does not give. When a comparison depends on a zone that is not stated, say that the zone is not stated.
6. Severity: high means it could cost money or lose a booking; medium means an inconvenience; low means good to know.
7. If nothing qualifies, return an empty "items" array. Never pad.
8. One plain English sentence per item, written to the traveller, naming bookings and documents by what they are (the Kyoto hotel, the train to Osaka), never by id.
9. Do not explain your reasoning in prose.`;

// ---------------------------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------------------------

const present = (v) => v !== undefined && v !== null && v !== '';

// An object without its empty fields: a shorter input that says the same.
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => present(v)));
}

// One object per line inside an array, so a long list stays readable and cheap.
function jsonLines(items) {
  if (!items.length) return '[]';
  return `[\n${items.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n]`;
}

// details_json without its bookkeeping: importedFrom points at the import artifact, and
// providerPayload is the raw flight-lookup response (airport coordinates, great-circle distance)
// the traveller never sees; it adds noise and invites the distance estimates rule 4 forbids.
function stripBookkeeping(detailsJson) {
  if (!detailsJson || typeof detailsJson !== 'object') return {};
  const { importedFrom, providerPayload, ...rest } = detailsJson;
  return rest;
}

function verifiedPageOf(record, index) {
  const row = (record.extra.verification ?? []).find((v) => v.index === index);
  return row ?? null;
}

// tripDetail is the getTripDetail() shape; factRecords are complete facts-run records of this trip
// (extra.bookingIds are hex booking ids of this trip). Returns { text, evidence, counts } where
// `text` is the one user text block, `evidence` maps every cited id to { type, label, detail }, and
// `counts` is the number of ids by type.
export function buildReadinessInput({ tripDetail, factRecords }) {
  const context = copilotTripContext(tripDetail);

  const bookingRefs = new Map();
  const dayRefs = new Map();
  const evidence = {};

  const bookings = tripDetail.bookings.map((b, i) => {
    const ref = `B${i + 1}`;
    bookingRefs.set(b.id, ref);
    evidence[ref] = {
      type: 'booking',
      label: b.title,
      detail: { type: b.type, title: b.title, start: b.startDatetime ?? null, end: b.endDatetime ?? null },
    };
    return compact({
      ref,
      type: b.type,
      title: b.title,
      start: b.startDatetime,
      end: b.endDatetime,
      originTz: b.originTz,
      destinationTz: b.destinationTz,
      origin: b.origin,
      destination: b.destination,
      confirmationRef: b.confirmationRef,
      details: Object.keys(stripBookkeeping(b.detailsJson)).length ? stripBookkeeping(b.detailsJson) : null,
    });
  });

  const days = tripDetail.days.map((d, i) => {
    const ref = `D${i + 1}`;
    dayRefs.set(d.id, ref);
    const city = d.resolvedCity ?? d.city ?? null;
    evidence[ref] = { type: 'day', label: d.date, detail: { date: d.date, city } };
    return compact({ ref, date: d.date, city, country: d.resolvedCountry ?? d.cityCountry ?? null });
  });

  // Facts: records ordered by document key, then the model's own order inside each document.
  const sorted = [...factRecords].sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0));
  const facts = [];
  for (const record of sorted) {
    const bookingIds = record.extra.bookingIds ?? [];
    const factBookings = bookingIds.map((id) => {
      const ref = bookingRefs.get(id);
      if (!ref) throw new Error(`facts record ${record.fixtureId} names booking ${id}, which is not a booking of this trip`);
      return ref;
    });
    record.output.facts.forEach((fact, index) => {
      const ref = `F${facts.length + 1}`;
      const check = verifiedPageOf(record, index);
      const page = present(check?.page) ? String(check.page) : fact.page;
      const quoteVerified = check ? Boolean(check.found) : null;
      const document = compact({ kind: record.extra.kind, filename: record.extra.filename, summary: record.output.documentSummary });
      facts.push(compact({
        ref,
        bookings: factBookings,
        kind: fact.kind,
        label: fact.label,
        value: fact.value,
        quote: fact.quote,
        page,
        at: fact.at,
        tz: fact.tz,
        tzSource: fact.tzSource,
        appliesFrom: fact.appliesFrom,
        appliesTo: fact.appliesTo,
        confidence: fact.confidence,
        quoteVerified,
        document: document.summary ?? document.filename ?? document.kind,
      }));
      evidence[ref] = {
        type: 'fact',
        label: `${fact.kind} "${fact.label}"`,
        detail: {
          kind: fact.kind, label: fact.label, value: fact.value, quote: fact.quote, page: present(page) ? page : null,
          document: document.summary ?? document.filename ?? document.kind ?? null,
          quoteVerified, bookings: factBookings,
        },
      };
    });
  }

  const findings = runTripHealthChecks(tripDetail).map((f, i) => {
    const ref = `H${i + 1}`;
    evidence[ref] = { type: 'finding', label: f.check, detail: { check: f.check, severity: f.severity, message: f.message, date: f.date ?? null } };
    return compact({
      ref,
      check: f.check,
      severity: f.severity,
      message: f.message,
      date: f.date,
      day: f.dayId ? dayRefs.get(f.dayId) : null,
      booking: f.bookingId ? bookingRefs.get(f.bookingId) : null,
      stopId: f.stopId,
    });
  });

  const idMap = {
    bookings: Object.fromEntries([...bookingRefs].map(([hex, ref]) => [ref, hex])),
    days: Object.fromEntries([...dayRefs].map(([hex, ref]) => [ref, hex])),
  };

  const text = [
    'Trip (as the co-pilot sees it):',
    JSON.stringify(context, null, 1),
    '',
    'Id map (the long ids used inside the trip above -> the short ids used everywhere else):',
    JSON.stringify(idMap),
    '',
    'Bookings:',
    jsonLines(bookings),
    '',
    'Days:',
    jsonLines(days),
    '',
    'Document facts:',
    jsonLines(facts),
    '',
    'Health findings:',
    jsonLines(findings),
  ].join('\n');

  return {
    text,
    evidence,
    counts: { B: bookings.length, D: days.length, F: facts.length, H: findings.length },
  };
}

export function buildReadinessRequest(profile, input) {
  return {
    ...requestSettings(profile, { format: READINESS_OUTPUT_FORMAT }),
    system: READINESS_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.text }] }],
  };
}

// ---------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------

// D-30-3 / D-37-4 rules: classify the stop first, then exactly one text block, parsed and validated.
// Nothing is repaired. Returns { outcome, stopReason, category, error, value, parsed, unknownEvidence }
// where `unknownEvidence` lists [{ item, id }] for cited ids that are not in `evidence`; those items
// stay in `value`.
export function classifyReadinessResponse(message, evidence) {
  const stop = classifyStop(message);
  const base = { stopReason: stop.stopReason, category: stop.category, unknownEvidence: [] };
  if (stop.outcome !== 'complete') return { ...base, outcome: stop.outcome, error: null, value: null, parsed: null };

  const invalid = (error, parsed = null) => ({ ...base, outcome: 'invalid', error, value: null, parsed });
  const textBlocks = (message.content ?? []).filter((b) => b.type === 'text');
  if (textBlocks.length !== 1) return invalid(`expected exactly one text block, got ${textBlocks.length}`);

  let parsed;
  try {
    parsed = JSON.parse(textBlocks[0].text);
  } catch (err) {
    return invalid(`not JSON (${err.message})`);
  }
  const checked = validateAgainstSchema(parsed, READINESS_OUTPUT_SCHEMA);
  if (!checked.ok) return invalid(checked.error, parsed);

  const unknownEvidence = [];
  checked.value.items.forEach((item, index) => {
    for (const id of item.evidence) {
      if (!Object.hasOwn(evidence, id)) unknownEvidence.push({ item: index + 1, id });
    }
  });
  return { ...base, outcome: 'complete', error: null, value: checked.value, parsed, unknownEvidence };
}
