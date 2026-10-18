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

import { rate } from './common.mjs';

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
    critical: [],
    highButWrong: [],
  };
  if (!out || !expected) return base;

  base.isTravelCorrect = out.isTravelRelated === expected.isTravelRelated;
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
      base.fieldsChecked += 1;
      if (ok) {
        base.fieldsCorrect += 1;
        continue;
      }
      if (claimedHigh(act, path)) base.highButWrong.push(`${label}.${path}`);

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

export function score(records) {
  const rows = records.map((r) => ({ record: r, ...scoreRecord(r) }));
  const n = rows.length;
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
    'booking count correct': rate(scored.filter((r) => r.countCorrect).length, scored.length),
    'critical-field accuracy': fieldsChecked ? `${fieldsCorrect}/${fieldsChecked} (${((100 * fieldsCorrect) / fieldsChecked).toFixed(1)}%)` : 'n/a',
    'critical errors': `${criticalTotal} across ${rows.filter((r) => r.critical.length).length}/${n} fixtures`,
    'high confidence but wrong': hbw,
    'fixtures with a critical error': rows.filter((r) => r.critical.length).map((r) => r.id).join(', ') || 'none',
  };

  const perItem = rows.map((r) => ({
    id: r.id,
    ok: r.ok,
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
    notes.push(`high-confidence-but-wrong fields: ${rows.flatMap((r) => r.highButWrong.map((f) => `${r.id}:${f}`)).join(', ')}`);
  }
  for (const f of failures) notes.push(`no output for ${f.fixtureId}: ${f.error?.message ?? 'unknown'}`);
  return { summary, perItem, notes };
}
