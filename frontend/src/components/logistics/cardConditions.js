import { compareDeadlines, deviceZone, isDeadlineAhead } from './deadlineTime.js';
import { compareAtAsWritten, formatAtAsWritten } from './factFormat.js';

export function cardConditionLines(facts, now = new Date(), deviceTz = deviceZone()) {
  // D-37-5 (Plan 37): a card shows at most the next deadline (the same ahead-test and order as Due) and the first window, listed in time order, no gold; the full list lives in the detail sheet.
  if (!Array.isArray(facts) || facts.length === 0) return [];

  const deadlines = facts
    .filter((f) => f.kind === 'deadline' && f.at && isDeadlineAhead(f, now, deviceTz))
    .sort((a, b) => compareDeadlines(a, b, deviceTz));

  const windows = facts
    .filter((f) => f.kind === 'window')
    .sort((a, b) => compareAtAsWritten(a.at, b.at));

  // A deadline's label already says what it is ("Free cancellation until"), so the card gives
  // its moment as written; the model's full sentence, with any qualifier, is in the sheet.
  const picked = [];
  if (deadlines[0]) {
    const when = formatAtAsWritten(deadlines[0].at);
    const value = when ? [when.date, when.time].filter(Boolean).join(' ') : deadlines[0].value;
    picked.push({ at: deadlines[0].at, line: { key: deadlines[0].id, label: deadlines[0].label, value } });
  }
  if (windows[0]) {
    picked.push({ at: windows[0].at, line: { key: windows[0].id, label: windows[0].label, value: windows[0].value } });
  }
  // Time order by `at` as written; an undated fact goes last; on a tie the deadline (pushed first) stays first.
  picked.sort((a, b) => compareAtAsWritten(a.at, b.at));
  return picked.map((p) => p.line);
}

// Screen-reader suffix: the card's aria-label hides its inner text, so the lines are spoken here.
export function conditionsAriaSuffix(lines) {
  return lines.map((l) => ` ${l.label}: ${l.value.replace(/[.\s]+$/, '')}.`).join('');
}

// Spoken while a document is being read, so the card's aria-label matches what it shows.
export function readingAriaSuffix(reading) {
  return reading === 'reading' ? ' Reading its document.' : '';
}
