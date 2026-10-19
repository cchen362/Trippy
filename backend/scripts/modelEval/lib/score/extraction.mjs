// Extraction scoring (Plan 30 §5.3, W4 gate): compares each recorded extraction with the labels
// carried in the record (extra.expected). Only fields present in a label are scored, so a label
// states exactly what a correct extraction per the system prompt must return and nothing more.
//
// Label conventions:
//   - an expected string value is compared trimmed and case-insensitively (confirmation refs,
//     flight/train numbers: punctuation and spaces ignored too); datetimes exactly ("YYYY-MM-DDTHH:MM")
//   - an expected ARRAY is any-of (origin / destination: ["SFO", "San Francisco"])
//   - origin / destination match against origin, details.originCity and details.originStation
//     (destination likewise) by containment either way, because the prompt fixes no format for them
//   - details.localName matches by containment either way
//   - "@NEXT:MM-DDTHH:MM" is the nearest occurrence of that month/day on or after the record's
//     run date (prompt rule 3, no trip context)
//   - details.flightNumber is labelled as the FULL designator as printed, spaces removed ("KE012",
//     "U28123", "BA2490A"). The "as labelled" match accepts both the designator in flightNumber and
//     the number-only form paired with details.carrierCode (Plan 34 D-34-4). A flight sold under two
//     numbers (a codeshare) is labelled with an ARRAY, any of which is acceptable. details.carrierCode
//     may be labelled too ("KE", "U2") where the carrier split is itself under test.
//   - expected.kind is the three-way result kind: "bookings", "travel_no_booking" or "not_travel"
//     (Plan 34 D-34-3 / Q-34-1). Today's output has no kind field, so it is derived from
//     isTravelRelated + bookings; the W1 contract answers it directly and W0 records a baseline.

import { rate, median, max, sum } from './common.mjs';
import { normalizeFlightQuery } from '../../../../src/services/lookups.js';
import { normalizeFlightDetails } from '../../../../src/services/importer.js';

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const alnum = (v) => (typeof v === 'string' ? v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : v);

const DETAIL_KEYS_BY_LENIENCY = {
  ref: new Set(['confirmationRef', 'flightNumber', 'trainNumber']),
  contains: new Set(['localName']),
};

export function resolveNext(token, startedAt) {
  const m = /^@NEXT:(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(token);
  if (!m) return token;
  const run = new Date(startedAt);
  const runYear = run.getUTCFullYear();
  const runMonthDay = `${String(run.getUTCMonth() + 1).padStart(2, '0')}-${String(run.getUTCDate()).padStart(2, '0')}`;
  const year = `${m[1]}-${m[2]}` >= runMonthDay ? runYear : runYear + 1;
  return `${year}-${m[1]}-${m[2]}T${m[3]}`;
}

function datetime(v) {
  return typeof v === 'string' ? v.slice(0, 16) : v;
}

// Plan 34 D-34-3 / Q-34-1: the model will answer a three-way kind under the W1 contract; today's
// output maps onto it, so W0 records a baseline. "Not travel yet bookings" is an invalid state.
function derivedKind(out) {
  if (out.isTravelRelated === false) return 'not_travel';
  return out.bookings?.length ? 'bookings' : 'travel_no_booking';
}

function containsEitherWay(a, b) {
  const x = alnum(a);
  const y = alnum(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

function placeValues(actual, side) {
  const d = actual?.details ?? {};
  return side === 'origin'
    ? [actual?.origin, d.originCity, d.originStation]
    : [actual?.destination, d.destinationCity, d.destinationStation];
}

function placeMatches(actual, side, expected) {
  const options = Array.isArray(expected) ? expected : [expected];
  const values = placeValues(actual, side).filter((v) => typeof v === 'string' && v.trim());
  return options.some((opt) => values.some((v) => containsEitherWay(v, opt)));
}

// Whether `actual` carries the labelled value for one field path ('type', 'details.originCity', ...).
function fieldMatches(actual, path, expectedValue, startedAt) {
  if (path === 'origin' || path === 'destination') {
    if (expectedValue === null) return !placeValues(actual, path).some((v) => typeof v === 'string' && v.trim());
    return placeMatches(actual, path, expectedValue);
  }

  const key = path.startsWith('details.') ? path.slice('details.'.length) : path;
  const got = path.startsWith('details.') ? actual?.details?.[key] : actual?.[key];

  if (path === 'startDatetime' || path === 'endDatetime') {
    return datetime(got ?? null) === datetime(expectedValue === null ? null : resolveNext(expectedValue, startedAt));
  }
  if (expectedValue === null) return got === null || got === undefined;
  if (got === null || got === undefined) return false;
  if (path === 'details.flightNumber') {
    // The label states the designator; D-34-4 makes number-only (with carrierCode) the contract
    // form, so the "as labelled" figure must not penalise it. An array label is any-of.
    const forms = [alnum(String(got)), alnum(`${actual?.details?.carrierCode ?? ''}${got}`)];
    return [].concat(expectedValue).some((want) => forms.includes(alnum(String(want))));
  }
  if (DETAIL_KEYS_BY_LENIENCY.ref.has(key)) return alnum(String(got)) === alnum(String(expectedValue));
  if (DETAIL_KEYS_BY_LENIENCY.contains.has(key)) return containsEitherWay(String(got), String(expectedValue));
  return norm(String(got)) === norm(String(expectedValue));
}

function expectedFieldPaths(expected) {
  const paths = [];
  for (const [k, v] of Object.entries(expected)) {
    if (k === 'details') for (const dk of Object.keys(v ?? {})) paths.push(`details.${dk}`);
    else paths.push(k);
  }
  return paths;
}

function expectedValueAt(expected, path) {
  return path.startsWith('details.') ? expected.details[path.slice('details.'.length)] : expected[path];
}

// "high" confidence is the model claiming certainty: the field's own entry, or the booking's
// overall level when the field has no entry. The model is free to key detail fields either way.
function claimedHigh(actual, path) {
  const fields = actual?.confidence?.fields ?? {};
  const bare = path.startsWith('details.') ? path.slice('details.'.length) : path;
  const entry = fields[path] ?? fields[bare];
  return (entry ?? actual?.confidence?.overall) === 'high';
}

function startMs(booking, startedAt) {
  const raw = typeof booking?.startDatetime === 'string' ? booking.startDatetime : null;
  const resolved = raw && raw.startsWith('@NEXT:') ? resolveNext(raw, startedAt) : raw;
  const t = resolved ? Date.parse(`${resolved.slice(0, 16)}:00Z`) : NaN;
  return Number.isNaN(t) ? null : t;
}

// Greedy pairing, best pair first: same type outranks different type, then nearest start time.
function pairBookings(expectedList, actualList, startedAt) {
  const pairs = [];
  for (let i = 0; i < expectedList.length; i += 1) {
    for (let j = 0; j < actualList.length; j += 1) {
      const e = expectedList[i];
      const a = actualList[j];
      const es = startMs(e, startedAt);
      const as = startMs(a, startedAt);
      const gap = es !== null && as !== null ? Math.abs(es - as) : 1e14;
      const cost = (e.type === a?.type ? 0 : 1e15) + gap;
      pairs.push({ i, j, cost });
    }
  }
  pairs.sort((x, y) => x.cost - y.cost);
  const usedE = new Set();
  const usedA = new Set();
  const matched = [];
  for (const p of pairs) {
    if (usedE.has(p.i) || usedA.has(p.j)) continue;
    usedE.add(p.i);
    usedA.add(p.j);
    matched.push([p.i, p.j]);
  }
  return {
    matched,
    missed: expectedList.map((_, i) => i).filter((i) => !usedE.has(i)),
    invented: actualList.map((_, j) => j).filter((j) => !usedA.has(j)),
  };
}

// §5.3's critical fields: dates, times, confirmation refs, type, origin/destination, city and
// countryCode. Every other labelled field (flight/train number, localName) is scored separately, so
// a format convention the prompt does not fix cannot move the gate's accuracy figure (W4).
const CRITICAL_FIELDS = new Set([
  'type', 'startDatetime', 'endDatetime', 'confirmationRef', 'origin', 'destination',
  'details.originCity', 'details.destinationCity', 'details.city',
  'details.originCountryCode', 'details.destinationCountryCode', 'details.countryCode',
]);

// W4: what Trippy itself does with an extracted flight. The booking card renders
// `${carrierCode} ${flightNumber}` and the status lookup sends the pair to normalizeFlightQuery,
// which accepts a number only (every stored flight is { carrierCode: 'SQ', flightNumber: '842' }).
// A pair is usable when that real function accepts it and yields the labelled designator (with an
// array label, ANY of its designators: a codeshare is usable under either flight number).
function resolvesToDesignator(actual, wantDesignator) {
  try {
    const { flightDesignator } = normalizeFlightQuery({
      carrierCode: actual?.details?.carrierCode ?? '',
      flightNumber: actual?.details?.flightNumber ?? '',
    });
    return [].concat(wantDesignator).some((want) => flightDesignator === alnum(String(want)).toUpperCase());
  } catch (err) {
    if (err.status === 400) return false; // the app would refuse to look this flight up
    throw err;
  }
}

function scoreRecord(record) {
  const expected = record.extra?.expected;
  const out = record.output;
  const base = {
    id: record.fixtureId,
    private: Boolean(record.extra?.private),
    ok: Boolean(out),
    isTravelCorrect: null,
    countCorrect: null,
    expectedBookings: expected?.bookings?.length ?? null,
    gotBookings: Array.isArray(out?.bookings) ? out.bookings.length : null,
    fieldsChecked: 0,
    fieldsCorrect: 0,
    otherChecked: 0,
    otherCorrect: 0,
    flightNumbers: 0,
    flightNumbersUsable: 0,
    flightNumbersRewritten: 0,
    expectedKind: expected?.kind ?? null,
    gotKind: out ? derivedKind(out) : null,
    kindCorrect: null,
    invalidState: false,
    critical: [],
    highButWrong: [],
    otherHighButWrong: [],
  };
  if (!out || !expected) return base;

  base.isTravelCorrect = out.isTravelRelated === expected.isTravelRelated;
  base.kindCorrect = expected.kind ? base.gotKind === expected.kind : null;
  base.invalidState = out.isTravelRelated === false && out.bookings?.length > 0;
  const actualList = out.bookings ?? [];
  base.countCorrect = actualList.length === expected.bookings.length;

  const { matched, missed, invented } = pairBookings(expected.bookings, actualList, record.startedAt);

  for (const j of invented) {
    base.critical.push(`invented booking (${actualList[j]?.type ?? '?'} ${actualList[j]?.title ?? ''})`.trim());
  }
  for (const i of missed) {
    base.critical.push(`missed booking (${expected.bookings[i].type} ${expected.bookings[i].startDatetime ?? ''})`.trim());
  }

  for (const [i, j] of matched) {
    const exp = expected.bookings[i];
    const act = actualList[j];
    const label = `${exp.type}#${i + 1}`;

    for (const path of expectedFieldPaths(exp)) {
      const want = expectedValueAt(exp, path);
      const ok = fieldMatches(act, path, want, record.startedAt);
      const isCritical = CRITICAL_FIELDS.has(path);
      if (isCritical) base.fieldsChecked += 1;
      else base.otherChecked += 1;
      if (path === 'details.flightNumber') {
        base.flightNumbers += 1;
        if (resolvesToDesignator(act, want)) base.flightNumbersUsable += 1;
        // Plan 34 D-34-4: under the contract the importer's normaliser must become a no-op.
        const details = act.details ?? {};
        const normalized = normalizeFlightDetails(details);
        if (normalized.carrierCode !== details.carrierCode || normalized.flightNumber !== details.flightNumber) {
          base.flightNumbersRewritten += 1;
        }
      }
      if (ok) {
        if (isCritical) base.fieldsCorrect += 1;
        else base.otherCorrect += 1;
        continue;
      }
      if (claimedHigh(act, path)) (isCritical ? base.highButWrong : base.otherHighButWrong).push(`${label}.${path}`);

      if (path === 'startDatetime' || path === 'endDatetime') {
        const wantResolved = datetime(resolveNext(String(want), record.startedAt));
        const got = datetime(act[path]);
        const dateWrong = !got || got.slice(0, 10) !== wantResolved.slice(0, 10);
        base.critical.push(`wrong ${dateWrong ? 'date' : 'time'} ${label}.${path}: got ${got ?? 'null'}, want ${wantResolved}`);
      } else if (path === 'confirmationRef') {
        base.critical.push(want === null || want === undefined
          ? `invented confirmationRef ${label}: got ${act.confirmationRef}`
          : `wrong confirmationRef ${label}: got ${act.confirmationRef ?? 'null'}, want ${want}`);
      }
    }

    if (exp.origin && exp.destination
      && !placeMatches(act, 'origin', exp.origin) && !placeMatches(act, 'destination', exp.destination)
      && placeMatches(act, 'origin', exp.destination) && placeMatches(act, 'destination', exp.origin)) {
      base.critical.push(`swapped origin/destination ${label}`);
    }
  }
  return base;
}

// W4: the input kind a fixture exercises — rendered fixtures carry an "image" or "pdf" tag.
function inputKind(record) {
  const tags = record.extra?.tags ?? [];
  if (tags.includes('image')) return 'image';
  if (tags.includes('pdf')) return 'pdf';
  return 'text';
}

function responseBlocks(record) {
  return record.calls?.at(-1)?.response?.content ?? [];
}

function thinkingBlockCount(record) {
  return responseBlocks(record).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
}

function textChars(record) {
  return responseBlocks(record)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .reduce((s, b) => s + b.text.length, 0);
}

// W4 (the W3 method): thinking text is empty under the default display "omitted", so thinking
// tokens are estimated as output minus the text's tokens. The text's tokens-per-character ratio
// is taken from the same run's responses that carried no thinking block (all output is text
// there). With fewer than 3 such responses it falls back to the model's ratio below, measured
// 2026-10-19 by counting the W0 control's 15 extraction responses (31,825 characters) with the
// free count_tokens endpoint: it reproduced Sonnet 4.6's billed output to 0.4% (10,311 counted vs
// 10,356 billed), and gave 12,638 on Sonnet 5.5's tokenizer.
const COUNTED_TEXT_TOKENS_PER_CHAR = {
  'claude-sonnet-4-6': 0.3240,
  'claude-sonnet-5-5': 0.3971,
};

function thinkingEstimator(records) {
  const plain = records.filter((r) => r.output && !thinkingBlockCount(r) && textChars(r) > 0);
  const measured = plain.length >= 3
    ? plain.reduce((s, r) => s + r.usage.output_tokens, 0) / plain.reduce((s, r) => s + textChars(r), 0)
    : null;
  const ratio = measured ?? COUNTED_TEXT_TOKENS_PER_CHAR[records[0]?.model] ?? null;
  if (ratio === null) return { ratio: null, sample: plain.length, estimate: () => null };
  return {
    ratio,
    sample: measured === null ? 'count_tokens' : plain.length,
    estimate: (r) => (thinkingBlockCount(r) ? Math.max(0, Math.round(r.usage.output_tokens - textChars(r) * ratio)) : 0),
  };
}

function accuracy(rows) {
  const checked = rows.reduce((s, r) => s + r.fieldsChecked, 0);
  const correct = rows.reduce((s, r) => s + r.fieldsCorrect, 0);
  return checked ? `${correct}/${checked}` : 'n/a';
}

export function score(records) {
  const rows = records.map((r) => ({ record: r, ...scoreRecord(r) }));
  const n = rows.length;
  const thinking = thinkingEstimator(records);
  const thinkingTokens = records.map((r) => thinking.estimate(r));
  const scored = rows.filter((r) => r.ok);
  const fieldsChecked = scored.reduce((s, r) => s + r.fieldsChecked, 0);
  const fieldsCorrect = scored.reduce((s, r) => s + r.fieldsCorrect, 0);
  const criticalTotal = rows.reduce((s, r) => s + r.critical.length, 0);
  const hbw = rows.reduce((s, r) => s + r.highButWrong.length, 0);

  const failures = records.filter((r) => !r.output);
  const maxTokens = records.filter((r) => r.stopReason === 'max_tokens').length;
  const refusals = records.filter((r) => r.stopReason === 'refusal').length;
  const privateCount = rows.filter((r) => r.private).length;

  const summary = {
    'parse / service failures': rate(failures.length, n),
    'max_tokens stops': rate(maxTokens, n),
    'refusals': rate(refusals, n),
    'isTravelRelated correct': rate(scored.filter((r) => r.isTravelCorrect).length, scored.length),
    'result kind correct (derived from isTravelRelated + bookings)': rate(
      scored.filter((r) => r.kindCorrect).length,
      scored.filter((r) => r.kindCorrect !== null).length,
    ),
    'invalid state: not travel yet bookings': scored.filter((r) => r.invalidState).length,
    'booking count correct': rate(scored.filter((r) => r.countCorrect).length, scored.length),
    'critical-field accuracy': fieldsChecked ? `${fieldsCorrect}/${fieldsChecked} (${((100 * fieldsCorrect) / fieldsChecked).toFixed(1)}%)` : 'n/a',
    'critical errors': `${criticalTotal} across ${rows.filter((r) => r.critical.length).length}/${n} fixtures`,
    'high confidence but wrong (critical fields)': hbw,
    'other labelled fields (flight/train no., localName) as labelled': `${scored.reduce((s, r) => s + r.otherCorrect, 0)}/${scored.reduce((s, r) => s + r.otherChecked, 0)}`,
    'other fields: high confidence but differs from label': scored.reduce((s, r) => s + r.otherHighButWrong.length, 0),
    'flight numbers usable by Trippy (normalizeFlightQuery)': `${scored.reduce((s, r) => s + r.flightNumbersUsable, 0)}/${scored.reduce((s, r) => s + r.flightNumbers, 0)}`,
    'flight numbers the importer rewrites (normalizeFlightDetails)': `${scored.reduce((s, r) => s + r.flightNumbersRewritten, 0)}/${scored.reduce((s, r) => s + r.flightNumbers, 0)}`,
    'fixtures with a critical error': rows.filter((r) => r.critical.length).map((r) => r.id).join(', ') || 'none',
    'responses with a thinking block': rate(records.filter((r) => thinkingBlockCount(r)).length, n),
    'est. thinking tokens median / max': thinking.ratio === null
      ? `n/a (${thinking.sample} thinking-free responses)`
      : `${median(thinkingTokens)} / ${max(thinkingTokens)} (text ${thinking.ratio.toFixed(3)} tok/char, n=${thinking.sample})`,
    'cost per successful extraction ($)': scored.length ? (sum(records.map((r) => r.costUsd)) / scored.length).toFixed(5) : 'n/a',
  };

  for (const kind of ['text', 'image', 'pdf']) {
    const kindRows = rows.filter((r) => inputKind(r.record) === kind);
    if (!kindRows.length) continue;
    const kindRecords = kindRows.map((r) => r.record);
    summary[`${kind}: n / critical-field acc / critical errors`] =
      `${kindRows.length} / ${accuracy(kindRows.filter((r) => r.ok))} / ${kindRows.reduce((s, r) => s + r.critical.length, 0)}`;
    summary[`${kind}: wall ms median / max`] = `${median(kindRecords.map((r) => r.wallMs))} / ${max(kindRecords.map((r) => r.wallMs))}`;
    summary[`${kind}: input tok median / output tok median`] =
      `${median(kindRecords.map((r) => r.usage.input_tokens))} / ${median(kindRecords.map((r) => r.usage.output_tokens))}`;
    summary[`${kind}: cost median ($)`] = median(kindRecords.map((r) => r.costUsd))?.toFixed(5);
  }

  const perItem = rows.map((r, i) => ({
    id: r.id,
    ok: r.ok,
    stop: r.record.stopReason,
    think: thinkingBlockCount(r.record),
    'est think tok': thinkingTokens[i],
    'in tok': r.record.usage.input_tokens,
    'kind exp/got': `${r.expectedKind ?? '-'}/${r.gotKind ?? '-'}`,
    'bookings exp/got': `${r.expectedBookings ?? '-'}/${r.gotBookings ?? '-'}`,
    'field acc': r.fieldsChecked ? `${r.fieldsCorrect}/${r.fieldsChecked}` : '-',
    'critical errors': r.critical.join('; ') || '',
    'wall ms': r.record.wallMs,
    'out tok': r.record.usage.output_tokens,
    'cost $': r.record.costUsd.toFixed(5),
  }));

  const notes = [
    `${privateCount} of ${n} fixtures were private (owner-supplied); the rest are committed synthetic cases.`,
  ];
  if (hbw) {
    notes.push(`high-confidence-but-wrong critical fields: ${rows.flatMap((r) => r.highButWrong.map((f) => `${r.id}:${f}`)).join(', ')}`);
  }
  const otherHbw = rows.flatMap((r) => r.otherHighButWrong.map((f) => `${r.id}:${f}`));
  if (otherHbw.length) notes.push(`other fields high-confidence but differing from the label: ${otherHbw.join(', ')}`);
  for (const f of failures) notes.push(`no output for ${f.fixtureId}: ${f.error?.message ?? 'unknown'}`);
  return { summary, perItem, notes };
}
